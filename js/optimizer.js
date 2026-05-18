/* ===========================================
   optimizer.js - 焼きなまし法による最適化エンジン
   =========================================== */

/**
 * シフト最適化のメインエントリ
 * 進捗を progressCallback で報告しながら非同期に実行
 */
async function optimizeSchedule(progressCallback) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const staff = AppState.staff;
  const settings = AppState.settings;

  // 1. 各スタッフが入れるシフト種別を確定
  const allowedShifts = {};
  staff.forEach(s => {
    let baseShifts = (ROLE_TYPES[s.roleType] || ROLE_TYPES.normal).shifts.slice();
    
    // === 代替責任者ロジック ===
    // 責任者をやれるのは副店長・チーフのみ（リーダー以下は不可）
    if (s.positionType === 'viceManager' || s.positionType === 'chief') {
      if (!baseShifts.includes('早責')) baseShifts.push('早責');
      if (!baseShifts.includes('遅責')) baseShifts.push('遅責');
    }
    
    // === 代替総務ロジック ===
    // リーダー＋一般役割の人は総務を代替できる
    if (s.positionType === 'leader' && (s.roleType === 'normal' || s.roleType === 'normalSales')) {
      if (!baseShifts.includes('早総務')) baseShifts.push('早総務');
      if (!baseShifts.includes('遅総務')) baseShifts.push('遅総務');
    }
    // チーフは元々総務に入れるが、念のため
    if (s.positionType === 'chief' && !baseShifts.includes('早総務')) {
      baseShifts.push('早総務');
      baseShifts.push('遅総務');
    }
    
    // 早遅希望でフィルタ
    let filtered = baseShifts;
    if (s.prefs && s.prefs.length > 0) {
      filtered = baseShifts.filter(sh => {
        const isE = isEarly(sh);
        const isL = isLate(sh);
        if (isE && !s.prefs.includes('早可')) return false;
        if (isL && !s.prefs.includes('遅可')) return false;
        return true;
      });
    }
    // 何も入れなくなった場合は基本に戻す
    if (filtered.length === 0) filtered = baseShifts;
    allowedShifts[s.id] = filtered;
  });

  // 2. 希望休と固定シフトをロックして初期化
  let shifts = {};
  const locked = {};
  staff.forEach(s => {
    shifts[s.id] = {};
    locked[s.id] = {};
    for (let d = 1; d <= days; d++) {
      // 固定シフトが最優先
      const fixed = (AppState.fixedShifts[s.id] || {})[d];
      if (fixed) {
        shifts[s.id][d] = fixed;
        locked[s.id][d] = true;
        continue;
      }
      // 次に希望休
      const req = (AppState.requests[s.id] || {})[d];
      if (req && OFF_TYPES[req]) {
        shifts[s.id][d] = req;
        locked[s.id][d] = true;
      } else {
        shifts[s.id][d] = '';
        locked[s.id][d] = false;
      }
    }
  });

  // 2.5. 特別日の副店長固定処理
  applySpecialDaysLogic(shifts, locked, staff, days);

  // 3. 初期解：必要人数と休日数を満たすように貪欲法で配置
  generateInitialSolution(shifts, locked, allowedShifts, days);

  // 4. 焼きなまし法
  let currentScore = calculateScore(shifts, allowedShifts, days);
  let bestShifts = deepCopyShifts(shifts);
  let bestScore = currentScore;

  const maxAttempts = settings.maxAttempts;
  let T = 500.0;
  const coolingRate = Math.pow(0.01 / T, 1.0 / maxAttempts);
  const reportInterval = Math.max(500, Math.floor(maxAttempts / 200));
  let stagnantCount = 0;
  const lastBestUpdate = { attempt: 0 };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    T *= coolingRate;
    if (T < 0.01) T = 0.01;

    // 局所最適に長く留まったらリヒート
    if (attempt - lastBestUpdate.attempt > maxAttempts / 10) {
      T = Math.min(100, T * 5);
      lastBestUpdate.attempt = attempt;
    }

    // 近傍生成: 複数種類の操作からランダムに選ぶ
    const op = Math.random();
    let undoFn = null;

    if (op < 0.4) {
      undoFn = trySwapInOneStaff(shifts, locked, staff, days);
    } else if (op < 0.7) {
      undoFn = trySwapBetweenStaff(shifts, locked, staff, days);
    } else if (op < 0.9) {
      undoFn = tryChangeShift(shifts, locked, staff, days, allowedShifts);
    } else {
      undoFn = trySwapDayBetweenStaff(shifts, locked, staff, days);
    }

    if (!undoFn) continue;

    const newScore = calculateScore(shifts, allowedShifts, days);
    const delta = newScore - currentScore;

    if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
      currentScore = newScore;
      if (newScore < bestScore) {
        bestScore = newScore;
        bestShifts = deepCopyShifts(shifts);
        lastBestUpdate.attempt = attempt;
      }
    } else {
      undoFn();
    }

    if (attempt % reportInterval === 0) {
      const pct = Math.floor((attempt / maxAttempts) * 100);
      progressCallback && progressCallback(pct, `最適化中... 現在スコア: ${currentScore.toFixed(0)} / 最良: ${bestScore.toFixed(0)} (試行 ${attempt}/${maxAttempts})`);
      await sleep(0); // UI更新を許可
    }

    if (bestScore === 0) {
      progressCallback && progressCallback(100, 'スコア0達成！');
      break;
    }
  }

  // ベストの解を採用
  AppState.shifts = bestShifts;
  AppState.violations = checkViolations(bestShifts);
  AppState.generated = true;

  return {
    score: bestScore,
    violations: AppState.violations,
    success: bestScore === 0,
  };
}

function deepCopyShifts(shifts) {
  const copy = {};
  for (const sid in shifts) {
    copy[sid] = Object.assign({}, shifts[sid]);
  }
  return copy;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 初期解生成
 * 1. 各スタッフに目標休日数(maxOff)分の「休」を配置
 * 2. 残り日数を各日の必要シフトに割り当て
 */
function generateInitialSolution(shifts, locked, allowedShifts, days) {
  const staff = AppState.staff;

  // ステップ1: 各スタッフに休日を配置
  // ロック済みの休日数を考慮する
  staff.forEach(s => {
    let alreadyOff = 0;
    const unlockedDays = [];
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d] && isOff(shifts[s.id][d])) alreadyOff++;
      if (!locked[s.id][d]) unlockedDays.push(d);
    }
    const needMoreOff = Math.max(0, (s.maxOff || 0) - alreadyOff);
    
    // 等間隔気味に休みを配置（連勤を避ける）
    shuffleArray(unlockedDays);
    const offDays = unlockedDays.slice(0, needMoreOff);
    offDays.forEach(d => {
      shifts[s.id][d] = '休';
    });
  });

  // ステップ2: 各日のシフトに割り当て
  const shiftKeys = ['早責', '遅責', '早総務', '遅総務', '早', '遅'];
  
  for (let d = 1; d <= days; d++) {
    // この日に勤務可能な（空きの）スタッフ
    const availableStaff = staff
      .filter(s => !locked[s.id][d] && shifts[s.id][d] === '')
      .slice();
    shuffleArray(availableStaff);

    shiftKeys.forEach(sh => {
      const req = AppState.roleRequirements[sh] || 0;
      let placed = 0;
      for (let i = 0; i < availableStaff.length && placed < req; i++) {
        const s = availableStaff[i];
        if (shifts[s.id][d] !== '') continue;
        if (allowedShifts[s.id].includes(sh)) {
          shifts[s.id][d] = sh;
          placed++;
        }
      }
    });

    // 残りは「休」（必要人数を超えた分）
    staff.forEach(s => {
      if (shifts[s.id][d] === '' && !locked[s.id][d]) {
        shifts[s.id][d] = '休';
      }
    });
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * 同一スタッフの2日間でシフトを入替（休⇔勤も含む）
 */
function trySwapInOneStaff(shifts, locked, staff, days) {
  const s = staff[Math.floor(Math.random() * staff.length)];
  if (!s) return null;
  const d1 = Math.floor(Math.random() * days) + 1;
  const d2 = Math.floor(Math.random() * days) + 1;
  if (d1 === d2) return null;
  if (locked[s.id][d1] || locked[s.id][d2]) return null;
  const v1 = shifts[s.id][d1];
  const v2 = shifts[s.id][d2];
  if (v1 === v2) return null;
  shifts[s.id][d1] = v2;
  shifts[s.id][d2] = v1;
  return () => {
    shifts[s.id][d1] = v1;
    shifts[s.id][d2] = v2;
  };
}

/**
 * 2スタッフの同一日のシフトを入替
 */
function trySwapBetweenStaff(shifts, locked, staff, days) {
  if (staff.length < 2) return null;
  const i1 = Math.floor(Math.random() * staff.length);
  let i2 = Math.floor(Math.random() * staff.length);
  if (i1 === i2) i2 = (i2 + 1) % staff.length;
  const s1 = staff[i1];
  const s2 = staff[i2];
  const d = Math.floor(Math.random() * days) + 1;
  if (locked[s1.id][d] || locked[s2.id][d]) return null;
  const v1 = shifts[s1.id][d];
  const v2 = shifts[s2.id][d];
  if (v1 === v2) return null;
  shifts[s1.id][d] = v2;
  shifts[s2.id][d] = v1;
  return () => {
    shifts[s1.id][d] = v1;
    shifts[s2.id][d] = v2;
  };
}

/**
 * あるスタッフの1日のシフトを別の許容シフトに変更
 */
function tryChangeShift(shifts, locked, staff, days, allowedShifts) {
  const s = staff[Math.floor(Math.random() * staff.length)];
  if (!s) return null;
  const d = Math.floor(Math.random() * days) + 1;
  if (locked[s.id][d]) return null;
  const cur = shifts[s.id][d];
  // 候補: 許容シフト + 休
  const candidates = allowedShifts[s.id].concat(['休']);
  const next = candidates[Math.floor(Math.random() * candidates.length)];
  if (cur === next) return null;
  shifts[s.id][d] = next;
  return () => {
    shifts[s.id][d] = cur;
  };
}

/**
 * 2スタッフ間で異なる日のシフトを交換（より大きな摂動）
 */
function trySwapDayBetweenStaff(shifts, locked, staff, days) {
  if (staff.length < 2) return null;
  const i1 = Math.floor(Math.random() * staff.length);
  let i2 = Math.floor(Math.random() * staff.length);
  if (i1 === i2) i2 = (i2 + 1) % staff.length;
  const s1 = staff[i1];
  const s2 = staff[i2];
  const d1 = Math.floor(Math.random() * days) + 1;
  const d2 = Math.floor(Math.random() * days) + 1;
  if (d1 === d2) return null;
  if (locked[s1.id][d1] || locked[s1.id][d2] || locked[s2.id][d1] || locked[s2.id][d2]) return null;
  const v11 = shifts[s1.id][d1], v12 = shifts[s1.id][d2];
  const v21 = shifts[s2.id][d1], v22 = shifts[s2.id][d2];
  shifts[s1.id][d1] = v21;
  shifts[s2.id][d1] = v11;
  return () => {
    shifts[s1.id][d1] = v11;
    shifts[s2.id][d1] = v21;
  };
}

/**
 * スコア計算（小さいほど良い、0が完璧）
 */
function calculateScore(shifts, allowedShifts, days) {
  let score = 0;
  const staff = AppState.staff;
  const settings = AppState.settings;
  const maxCons = settings.maxConsecutive;

  // ===== 縦のルール: 各日に必要人数を確保 =====
  const shiftKeys = ['早責', '遅責', '早総務', '遅総務', '早', '遅'];
  for (let d = 1; d <= days; d++) {
    const counts = {};
    shiftKeys.forEach(k => counts[k] = 0);
    staff.forEach(s => {
      const sh = shifts[s.id][d];
      if (counts[sh] !== undefined) counts[sh]++;
    });
    shiftKeys.forEach(k => {
      const req = AppState.roleRequirements[k] || 0;
      if (req === 0) return;
      const diff = req - counts[k];
      if (diff > 0) score += diff * 10000; // 不足は重ペナルティ
      else if (diff < 0) score += Math.abs(diff) * 200; // 過剰
    });
  }

  // ===== 横のルール: 各スタッフごと =====
  staff.forEach(s => {
    let consecutiveWork = s.prevConsecutive || 0;
    let prevShift = '';
    let offCount = 0;
    let earlyCount = 0; // 早番カウント
    let lateCount = 0;  // 遅番カウント

    for (let d = 1; d <= days; d++) {
      const cur = shifts[s.id][d];

      if (isWork(cur)) {
        // 入れないシフトを割り当てている（許容外シフト：絶対NG）
        if (!allowedShifts[s.id].includes(cur)) {
          score += 50000;
        }
        
        // 本来の役割でないシフト（代替役割）への軽ペナルティ
        const baseRoleShifts = (ROLE_TYPES[s.roleType] || ROLE_TYPES.normal).shifts;
        if (!baseRoleShifts.includes(cur)) {
          // 代替役割を使っている場合、軽いペナルティ
          // ただし不足時はこの代替が必要なので軽くする
          score += 30;
        }

        consecutiveWork++;
        if (consecutiveWork > maxCons) {
          // 連勤超過は段階的に重く
          const over = consecutiveWork - maxCons;
          score += 800 * over + 200 * over * over;
        }

        // 遅→早禁止
        if (settings.forbidLateEarly && isLate(prevShift) && isEarly(cur)) {
          score += 1500;
        }

        // === 連勤中の早遅統一ペナルティ ===
        // 休を挟まない連続勤務中（consecutiveWork >= 2）に早→遅 / 遅→早 が混ざるとNG
        // (遅→早 は forbidLateEarly で別途処理されるためここでは早→遅のみ追加処理)
        if (consecutiveWork >= 2 && isWork(prevShift)) {
          const prevEarly = isEarly(prevShift);
          const prevLate = isLate(prevShift);
          const curEarly = isEarly(cur);
          const curLate = isLate(cur);
          // 早→遅 または 遅→早 の切り替えはNG
          if ((prevEarly && curLate) || (prevLate && curEarly)) {
            score += 600; // 連勤内での時間帯切り替えにペナルティ
          }
        }

        // 早遅カウント
        if (isEarly(cur)) earlyCount++;
        else if (isLate(cur)) lateCount++;

        prevShift = cur;
      } else {
        if (isOff(cur)) offCount++;
        consecutiveWork = 0;

        // 単発休みペナルティ (勤→休→勤)
        if (settings.penaltySingleOff && d > 1 && d < days) {
          const prev = shifts[s.id][d - 1];
          const next = shifts[s.id][d + 1];
          if (isWork(prev) && isWork(next)) {
            // 遅→休→早 は最悪
            if (isLate(prev) && isEarly(next)) {
              score += 200;
            } else {
              score += 50;
            }
          }
        }

        prevShift = cur;
      }
    }
    
    // ===== 早遅バランスのペナルティ =====
    const balance = SHIFT_BALANCE[s.balance || 'balanced'];
    const totalShifts = earlyCount + lateCount;
    if (balance && totalShifts > 0) {
      const targetEarly = totalShifts * balance.earlyRatio;
      const targetLate = totalShifts * balance.lateRatio;
      const earlyDiff = Math.abs(earlyCount - targetEarly);
      const lateDiff = Math.abs(lateCount - targetLate);
      score += (earlyDiff + lateDiff) * 80; // バランスのずれにペナルティ
    }

    // 単発出勤チェック (休→勤→休)
    if (settings.penaltySingleOff) {
      for (let d = 1; d <= days; d++) {
        const cur = shifts[s.id][d];
        if (!isWork(cur)) continue;
        const prev = d > 1 ? shifts[s.id][d - 1] : '';
        const next = d < days ? shifts[s.id][d + 1] : '';
        const prevOff = d === 1 ? ((s.prevConsecutive || 0) === 0) : (!isWork(prev));
        const nextOff = d === days ? false : (!isWork(next));
        if (prevOff && nextOff && d > 1 && d < days) {
          score += 80; // 単発出勤
        }
      }
    }

    // 公休数の上限/下限（maxOff）- ピッタリ目標に
    const maxOff = s.maxOff || 0;
    const offDiff = offCount - maxOff;
    if (offDiff !== 0) {
      score += Math.abs(offDiff) * 300;
    }
  });

  return score;
}

/**
 * ルール違反のリストアップ（人間が読める形）
 */
function checkViolations(shifts) {
  const violations = [];
  const staff = AppState.staff;
  const settings = AppState.settings;
  const days = getDaysInMonth(settings.targetMonth);
  const maxCons = settings.maxConsecutive;

  // 各スタッフの違反
  staff.forEach(s => {
    let consecutiveWork = s.prevConsecutive || 0;
    let prevShift = '';
    let offCount = 0;
    // === 実質的な許容シフト（代替ロジック含む） ===
    const baseRoleShifts = (ROLE_TYPES[s.roleType] || ROLE_TYPES.normal).shifts.slice();
    const effectiveAllowed = baseRoleShifts.slice();
    // 代替責任者: 副店長・チーフのみ責任者シフトに入れる（リーダー以下は不可）
    if (s.positionType === 'viceManager' || s.positionType === 'chief') {
      if (!effectiveAllowed.includes('早責')) effectiveAllowed.push('早責');
      if (!effectiveAllowed.includes('遅責')) effectiveAllowed.push('遅責');
    }
    // 代替総務: リーダー＋一般 / チーフは総務に入れる
    if (s.positionType === 'leader' && (s.roleType === 'normal' || s.roleType === 'normalSales')) {
      if (!effectiveAllowed.includes('早総務')) effectiveAllowed.push('早総務');
      if (!effectiveAllowed.includes('遅総務')) effectiveAllowed.push('遅総務');
    }
    if (s.positionType === 'chief') {
      if (!effectiveAllowed.includes('早総務')) effectiveAllowed.push('早総務');
      if (!effectiveAllowed.includes('遅総務')) effectiveAllowed.push('遅総務');
    }
    const consecutiveReportedDays = new Set(); // 重複報告を避ける

    for (let d = 1; d <= days; d++) {
      const cur = (shifts[s.id] || {})[d] || '';
      if (isWork(cur)) {
        consecutiveWork++;
        if (consecutiveWork > maxCons && !consecutiveReportedDays.has(d)) {
          violations.push({
            staffId: s.id, day: d, type: 'consecutive',
            message: `🚨 ${consecutiveWork}連勤（上限${maxCons}）`,
            action: '他の日と入れ替えて休みを挟んでください',
          });
          consecutiveReportedDays.add(d);
        }
        if (settings.forbidLateEarly && isLate(prevShift) && isEarly(cur)) {
          violations.push({
            staffId: s.id, day: d, type: 'late-early',
            message: `🚨 遅→早（インターバル不足）`,
            action: '順序を入れ替えてください',
          });
        }
        // 実質的に許容されていないシフト = 本当の違反
        if (!effectiveAllowed.includes(cur)) {
          violations.push({
            staffId: s.id, day: d, type: 'role-mismatch',
            message: `🚨 役割タイプに合わないシフト（${cur}）`,
            action: '別のスタッフと交換してください',
          });
        }
        // 本来の役割外だが代替として許容されている場合は情報のみ（違反としない）
        // 早遅希望チェック
        if (s.prefs && s.prefs.length > 0) {
          if (isEarly(cur) && !s.prefs.includes('早可')) {
            violations.push({
              staffId: s.id, day: d, type: 'pref-mismatch',
              message: `⚠️ 早番不可なのに早番（${cur}）`,
              action: '希望に合うシフトに変更してください',
            });
          }
          if (isLate(cur) && !s.prefs.includes('遅可')) {
            violations.push({
              staffId: s.id, day: d, type: 'pref-mismatch',
              message: `⚠️ 遅番不可なのに遅番（${cur}）`,
              action: '希望に合うシフトに変更してください',
            });
          }
        }
        prevShift = cur;
      } else {
        if (isOff(cur)) offCount++;
        consecutiveWork = 0;
        if (settings.penaltySingleOff && d > 1 && d < days) {
          const prev = (shifts[s.id] || {})[d - 1] || '';
          const next = (shifts[s.id] || {})[d + 1] || '';
          if (isLate(prev) && isEarly(next)) {
            violations.push({
              staffId: s.id, day: d, type: 'bad-rest',
              message: `⚠️ 遅→休→早（リズムが悪い）`,
              action: '時間帯を揃えてください',
            });
          }
        }
        prevShift = cur;
      }
    }

    // 公休数チェック（目標との差）
    // 不足は厳しく、超過は情報として軽く扱う（人手余剰のため休が増えるのは自然）
    const diff = offCount - (s.maxOff || 0);
    if (diff < 0) {
      violations.push({
        staffId: s.id, day: 0, type: 'off-count',
        message: `🚨 休日数 ${offCount}日（目標${s.maxOff}日, 差${diff}）`,
        action: '休日数を増やしてください',
      });
    } else if (diff > 0) {
      violations.push({
        staffId: s.id, day: 0, type: 'off-count-over',
        message: `ℹ️ 休日数 ${offCount}日（目標${s.maxOff}日, 差+${diff}）人員余剰`,
        action: '余剰人員のため休日が増えています',
      });
    }
  });

  // 各日の必要人数チェック
  const shiftKeys = ['早責', '遅責', '早総務', '遅総務', '早', '遅'];
  for (let d = 1; d <= days; d++) {
    const counts = {};
    shiftKeys.forEach(k => counts[k] = 0);
    staff.forEach(s => {
      const sh = (shifts[s.id] || {})[d] || '';
      if (counts[sh] !== undefined) counts[sh]++;
    });
    shiftKeys.forEach(k => {
      const req = AppState.roleRequirements[k] || 0;
      if (req === 0) return;
      if (counts[k] < req) {
        violations.push({
          staffId: null, day: d, type: 'understaff',
          message: `🚨 ${d}日 ${k} が${counts[k]}人（必要${req}人）`,
          action: '他の日のシフトを移動してください',
        });
      }
    });
  }

  return violations;
}

/**
 * 特別日の副店長固定処理
 * - 入れ替え日: 副店長を遅責に固定
 * - 新装日: 副店長を早責に固定
 */
function applySpecialDaysLogic(shifts, locked, staff, days) {
  const viceManagers = staff.filter(s => s.positionType === 'viceManager');
  
  for (let d = 1; d <= days; d++) {
    const specialType = AppState.specialDays[d];
    if (!specialType) continue;
    
    viceManagers.forEach(vm => {
      if (locked[vm.id][d]) return; // 既にロック済み（希望休など）
      
      if (specialType === 'replacement') {
        // 入れ替え日: 副店長を遅責に
        shifts[vm.id][d] = '遅責';
        locked[vm.id][d] = true;
      } else if (specialType === 'renewal') {
        // 新装日: 副店長を早責に
        shifts[vm.id][d] = '早責';
        locked[vm.id][d] = true;
      }
    });
  }
}

/**
 * 代替責任者ロジック
 * 副店長が休みで責任者に入れない場合、チーフ→リーダーの順に代替
 * 初期解生成時に適用
 */
function applySubstituteResponsible(shifts, staff, day, shiftType) {
  // shiftType は '早責' または '遅責'
  
  // まず副店長を探す
  const viceManagers = staff.filter(s => s.positionType === 'viceManager' && shifts[s.id][day] === shiftType);
  if (viceManagers.length > 0) return viceManagers[0]; // 副店長がいればOK
  
  // 副店長がいない→チーフを探す
  const chiefs = staff.filter(s => s.positionType === 'chief' && !isOff(shifts[s.id][day]) && shifts[s.id][day] !== shiftType);
  if (chiefs.length > 0) {
    // チーフを責任者に昇格
    chiefs[0].tempResponsible = true; // 一時的に責任者役割を付与
    return chiefs[0];
  }
  
  // 副店長・チーフがいない場合は代替不可（リーダー以下は責任者にできない）
  return null;
}
