/* ===========================================
   optimizer.js - 焼きなまし法による最適化エンジン
   =========================================== */

/**
 * スタッフの責任者優先度を返す（数値が小さいほど優先）
 * viceManager=1, chief=2, leader=3, staff=4
 */
function getStaffPriority(s) {
  const p = { viceManager: 1, chief: 2, leader: 3, staff: 4 };
  return p[s.positionType] !== undefined ? p[s.positionType] : 4;
}

/**
 * countForStaff なシフトキー一覧（研修除く）を動的に取得
 * 最適化ループ中は shiftTypes が変わらないためメモ化して 250k 回のアロケーションを回避する。
 * optimizeSchedule の先頭で _shiftKeysCache = null してリセットすること。
 */
let _shiftKeysCache = null;
function getWorkShiftKeys() {
  if (!_shiftKeysCache) {
    _shiftKeysCache = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);
  }
  return _shiftKeysCache;
}

// 同じ時間帯に必要人数を超えて配置してはいけないシフト（責任者・総務）
const SOLO_SHIFT_KEYS = ['早責', '遅責', '早総務', '遅総務'];

// 部門別最適化中のスタッフ・必要人数（AppState を書き換えると実行中の保存で
// データが破損するため、optimizer 内部変数で切り替える）
let _optStaff = null, _optReqs = null, _optDailyReqs = null;
function optStaff()      { return _optStaff      || AppState.staff; }
function optReqs()       { return _optReqs       || AppState.roleRequirements; }
function optDailyReqs()  { return _optDailyReqs  || AppState.dailyRequirements || {}; }
// 日別必要人数（per-day override → デフォルト req の順で参照）
function optDayReq(sh, d) { return getDayReq(optReqs(), optDailyReqs(), sh, d); }

/**
 * シフト最適化のメインエントリ
 * 部門（社員/キャスト）ごとに独立して最適化し、結果をマージする
 */
async function optimizeSchedule(progressCallback) {
  const groups = getDepartmentGroups(AppState.staff);

  const mergedShifts = {};
  let totalScore = 0;
  const allViolations = [];

  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      // 部門のスタッフ・必要人数を optimizer 内部変数に設定して既存パイプラインを実行
      _optStaff     = g.staff;
      _optReqs      = g.reqs;
      _optDailyReqs = g.dailyReqs;
      const groupProgress = (pct, msg) => {
        const mapped = Math.floor((gi * 100 + pct) / groups.length);
        const label  = groups.length > 1 ? `【${g.label}】${msg}` : msg;
        progressCallback && progressCallback(mapped, label);
      };
      const res = await optimizeGroupSchedule(groupProgress);
      Object.assign(mergedShifts, res.shifts);
      totalScore += res.score;
    }
  } finally {
    _optStaff     = null;
    _optReqs      = null;
    _optDailyReqs = null;
  }

  AppState.shifts     = mergedShifts;
  AppState.violations = checkViolations(mergedShifts);
  AppState.generated  = true;

  // restPairBonus でスコアが負になり得るため、成功判定は違反件数で行う
  return { score: totalScore, violations: AppState.violations, success: AppState.violations.length === 0 };
}

/**
 * エラー箇所だけを再最適化する「修復」エントリ
 * - 現在の AppState.shifts を種（seed）にする
 * - 違反に関係するセル（＋前後日）だけロックを外し、それ以外は固定して動かさない
 * - 違反件数が減った時だけ採用し、悪化した場合は元に戻す（絶対に悪くしない）
 */
async function repairSchedule(progressCallback) {
  const baseShifts     = deepCopyShifts(AppState.shifts || {});
  const baseViolations = checkViolations(baseShifts);
  if (baseViolations.length === 0) {
    AppState.violations = baseViolations;
    return { score: 0, violations: [], success: true, improved: false, before: 0, after: 0 };
  }

  const days   = getDaysInMonth(AppState.settings.targetMonth);
  const groups = getDepartmentGroups(AppState.staff);
  const mergedShifts = deepCopyShifts(baseShifts);

  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const g       = groups[gi];
      const groupIds = new Set(g.staff.map(s => s.id));

      // この部門に関係するエラー箇所を集める（前後日も対象にして入れ替え余地を作る）
      const cells    = new Set();
      const staffAll = new Set();
      const addCell  = (sid, d) => {
        for (let dd = d - 1; dd <= d + 1; dd++) {
          if (dd >= 1 && dd <= days) cells.add(sid + ':' + dd);
        }
      };
      baseViolations.forEach(v => {
        if (v.staffId && groupIds.has(v.staffId)) {
          if (v.day === 0) staffAll.add(v.staffId); // 公休数不足 → その人の全日を対象
          else addCell(v.staffId, v.day);
        } else if (!v.staffId && v.day >= 1) {
          // 日単位エラー（人員不足・副店長不在など）→ その日の部門全員を対象
          g.staff.forEach(s => addCell(s.id, v.day));
        }
      });

      if (cells.size === 0 && staffAll.size === 0) continue; // この部門は問題なし

      _optStaff     = g.staff;
      _optReqs      = g.reqs;
      _optDailyReqs = g.dailyReqs;
      const groupProgress = (pct, msg) => {
        const mapped = Math.floor((gi * 100 + pct) / groups.length);
        progressCallback && progressCallback(mapped, '修復中... ' + msg);
      };
      const res = await optimizeGroupSchedule(groupProgress, { seedShifts: baseShifts, cells, staffAll });
      Object.assign(mergedShifts, res.shifts);
    }
  } finally {
    _optStaff = null; _optReqs = null; _optDailyReqs = null;
  }

  const newViolations = checkViolations(mergedShifts);
  // 悪化させない安全装置: 違反が減った時だけ採用、それ以外は元のまま
  if (newViolations.length < baseViolations.length) {
    AppState.shifts     = mergedShifts;
    AppState.violations = newViolations;
    AppState.generated  = true;
    return { score: newViolations.length, violations: newViolations,
             success: newViolations.length === 0, improved: true,
             before: baseViolations.length, after: newViolations.length };
  }
  AppState.shifts     = baseShifts;
  AppState.violations = baseViolations;
  AppState.generated  = true;
  return { score: baseViolations.length, violations: baseViolations,
           success: baseViolations.length === 0, improved: false,
           before: baseViolations.length, after: baseViolations.length };
}

/**
 * 1部門分の最適化（_optStaff / _optReqs に部門のスタッフ・必要人数が設定済みの前提）
 * @param {object} [repairCtx] 修復モード時のコンテキスト { seedShifts, cells, staffAll }
 */
async function optimizeGroupSchedule(progressCallback, repairCtx) {
  _shiftKeysCache = null; // 最適化開始時にリセット
  const days     = getDaysInMonth(AppState.settings.targetMonth);
  const staff    = optStaff();
  const settings = AppState.settings;
  const P        = settings.penalties;

  // 1. 各スタッフが入れるシフト種別を確定（allowedShifts から直接、prefs でフィルタ）
  const allowedShifts = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      // 研修は希望休カレンダーからのみ入る（optimizerは自動配置しない）
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });

    // prefs（早可/遅可）によるフィルタ
    if (s.prefs && s.prefs.length > 0) {
      const filtered = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (filtered.length > 0) base = filtered;
    }
    allowedShifts[s.id] = base;
  });

  // 2. 希望休と固定シフトをロックして初期化
  let shifts = {};
  const locked = {};
  staff.forEach(s => {
    shifts[s.id] = {};
    locked[s.id] = {};
    for (let d = 1; d <= days; d++) {
      const fixed = (AppState.fixedShifts[s.id] || {})[d];
      if (fixed) {
        shifts[s.id][d] = fixed;
        locked[s.id][d] = true;
        continue;
      }
      const req = (AppState.requests[s.id] || {})[d];
      if (req && (isOff(req) || isWork(req))) {
        shifts[s.id][d] = req;
        locked[s.id][d] = true;
      } else {
        shifts[s.id][d] = '';
        locked[s.id][d] = false;
      }
    }
  });

  if (repairCtx) {
    // 修復モード: 現在のシフトを種にして、エラー箇所だけロックを外す
    staff.forEach(s => {
      for (let d = 1; d <= days; d++) {
        shifts[s.id][d] = (repairCtx.seedShifts[s.id] || {})[d] || '';
        if (locked[s.id][d]) continue; // 固定シフト・希望休はそのまま動かさない
        const inError = repairCtx.cells.has(s.id + ':' + d) || repairCtx.staffAll.has(s.id);
        locked[s.id][d] = !inError;
      }
    });
  } else {
    // 2.5. 特別日の副店長固定
    applySpecialDaysLogic(shifts, locked, staff, days);

    // 3. 初期解生成
    generateInitialSolution(shifts, locked, allowedShifts, days);
  }

  // 4. 焼きなまし法
  let currentScore = calculateScore(shifts, allowedShifts, days, P);
  let bestShifts   = deepCopyShifts(shifts);
  let bestScore    = currentScore;

  const maxAttempts  = settings.maxAttempts;
  let T              = 500.0;
  const coolingRate  = Math.pow(0.01 / T, 1.0 / maxAttempts);
  const reportInterval = Math.max(500, Math.floor(maxAttempts / 200));
  const lastBestUpdate = { attempt: 0 };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    T *= coolingRate;
    if (T < 0.01) T = 0.01;

    // 局所最適に長く留まったらリヒート
    if (attempt - lastBestUpdate.attempt > maxAttempts / 10) {
      T = Math.min(100, T * 5);
      lastBestUpdate.attempt = attempt;
    }

    // 近傍操作の選択
    const op = Math.random();
    let undoFn = null;

    if (op < 0.07) {
      undoFn = tryFixUnderstaffing(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.14) {
      undoFn = tryFixLateEarlyViolation(shifts, locked, staff, days);
    } else if (op < 0.21) {
      undoFn = tryFixHierarchyViolation(shifts, locked, staff, days);
    } else if (op < 0.28) {
      undoFn = tryFixOffShortage(shifts, locked, staff, days);
    } else if (op < 0.35) {
      undoFn = tryFixBadRest(shifts, locked, staff, days);
    } else if (op < 0.42) {
      undoFn = trySwapRestForWork(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.49) {
      undoFn = tryConvertSurplusRest(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.56) {
      undoFn = tryCompoundFixBadRest(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.61) {
      undoFn = tryCascadeSwapForRest(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.66) {
      undoFn = tryFixCategorySwitch(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.71) {
      undoFn = tryFixSingleWork(shifts, locked, staff, days, allowedShifts);
    } else if (op < 0.80) {
      undoFn = trySwapInOneStaff(shifts, locked, staff, days);
    } else if (op < 0.89) {
      undoFn = trySwapBetweenStaff(shifts, locked, staff, days);
    } else if (op < 0.95) {
      undoFn = tryChangeShift(shifts, locked, staff, days, allowedShifts);
    } else {
      undoFn = trySwapDayBetweenStaff(shifts, locked, staff, days);
    }

    if (!undoFn) continue;

    const newScore = calculateScore(shifts, allowedShifts, days, P);
    const delta    = newScore - currentScore;

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
      progressCallback && progressCallback(pct,
        `最適化中... 現在スコア: ${currentScore.toFixed(0)} / 最良: ${bestScore.toFixed(0)} (試行 ${attempt}/${maxAttempts})`);
      await sleep(0);
    }

  }

  return { shifts: bestShifts, score: bestScore };
}

function deepCopyShifts(shifts) {
  const copy = {};
  for (const sid in shifts) copy[sid] = Object.assign({}, shifts[sid]);
  return copy;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 初期解生成 =====

function generateInitialSolution(shifts, locked, allowedShifts, days) {
  const staff     = optStaff();
  const reqs      = optReqs();
  const shiftKeys = getWorkShiftKeys();

  // 行事の対象スタッフ → 出勤必須日のマップ
  const eventDays = {};
  (AppState.events || []).forEach(ev => {
    if (!ev || !ev.day) return;
    (ev.staffIds || []).forEach(sid => {
      if (!eventDays[sid]) eventDays[sid] = new Set();
      eventDays[sid].add(ev.day);
    });
  });

  // 副店長の「出勤しない日」(公休・有給を含む) は「毎日1人は出勤」制約を守るため
  // 全員同日に重ならないよう配置する
  const vmList = staff.filter(s => s.positionType === 'viceManager');
  const vmOffByDay = {};
  vmList.forEach(s => {
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d] && isOff(shifts[s.id][d])) vmOffByDay[d] = (vmOffByDay[d] || 0) + 1;
    }
  });
  // 副店長2人以上: 1日に休めるのは（人数-1）まで（毎日1人は出勤）
  // 副店長1人: ルール自体がオフなので制限なし（maxOff通り休める）
  const maxVmOffPerDay = vmList.length >= 2 ? vmList.length - 1 : vmList.length;

  // Step0: 有給を目標日数まで自動配置（日付未指定分をアプリが割り当てロックする）
  // カレンダーで個別指定済みの有給はロック済みなので差し引く
  staff.forEach(s => {
    const target = s.paidLeave || 0;
    if (target <= 0) return;
    const isVm = s.positionType === 'viceManager';
    let alreadyPaid = 0;
    const cands = [];
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d]) { if (shifts[s.id][d] === '有') alreadyPaid++; continue; }
      if (eventDays[s.id] && eventDays[s.id].has(d)) continue;
      if (isVm && (vmOffByDay[d] || 0) >= maxVmOffPerDay) continue;
      cands.push(d);
    }
    const need = Math.max(0, target - alreadyPaid);
    shuffleArray(cands);
    cands.slice(0, need).forEach(d => {
      shifts[s.id][d] = '有';
      locked[s.id][d] = true;
      if (isVm) vmOffByDay[d] = (vmOffByDay[d] || 0) + 1;
    });
  });

  // Step1: 各スタッフに公休を配置（ロック済みの公休のみ目標から差し引く。有給は別枠）
  staff.forEach(s => {
    const isVm = s.positionType === 'viceManager';
    let alreadyOff = 0;
    const unlockedDays = [];
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d] && isPublicOff(shifts[s.id][d])) alreadyOff++;
      // 行事の対象日・ロック済み日は初期解では休みを置かない
      if (locked[s.id][d] || (eventDays[s.id] && eventDays[s.id].has(d))) continue;
      // 副店長は、既に上限人数が休む予定の日は候補から除外（全員休みを防ぐ）
      if (isVm && (vmOffByDay[d] || 0) >= maxVmOffPerDay) continue;
      unlockedDays.push(d);
    }
    const needMoreOff = Math.max(0, (s.maxOff || 0) - alreadyOff);
    shuffleArray(unlockedDays);
    unlockedDays.slice(0, needMoreOff).forEach(d => {
      shifts[s.id][d] = '休';
      if (isVm) vmOffByDay[d] = (vmOffByDay[d] || 0) + 1;
    });
  });

  // Step2: 各日にシフトを割り当て
  for (let d = 1; d <= days; d++) {
    const avail = staff.filter(s => !locked[s.id][d] && shifts[s.id][d] === '');
    shuffleArray(avail);

    shiftKeys.forEach(sh => {
      const req = optDayReq(sh, d);
      let placed = 0;
      // 早責・遅責は役職優先度順（上位者を優先的に責任者に据える）
      const isRespShift = sh === '早責' || sh === '遅責';
      const candidates = avail.filter(s => shifts[s.id][d] === '' && allowedShifts[s.id].includes(sh));
      if (isRespShift) candidates.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));
      for (const s of candidates) {
        if (placed >= req) break;
        if (shifts[s.id][d] !== '') continue;
        shifts[s.id][d] = sh;
        placed++;
        // 夜勤翌日は必ず休み（未ロックの場合のみ）
        if (isNight(sh) && d < days && !locked[s.id][d + 1]) {
          shifts[s.id][d + 1] = '休';
        }
      }
    });

    staff.forEach(s => {
      if (!locked[s.id][d] && shifts[s.id][d] === '') shifts[s.id][d] = '休';
    });
  }

  // Step3: 人員不足を修復
  for (let d = 1; d <= days; d++) {
    shiftKeys.forEach(sh => {
      const req = optDayReq(sh, d);
      if (!req) return;
      let count = staff.filter(s => shifts[s.id][d] === sh).length;
      if (count >= req) return;
      const candidates = staff.filter(s =>
        !locked[s.id][d] && shifts[s.id][d] === '休' && allowedShifts[s.id].includes(sh));
      shuffleArray(candidates);
      for (const s of candidates) {
        if (count >= req) break;
        shifts[s.id][d] = sh;
        count++;
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
 * スタッフ s の公休日数をカウント
 */
// 公休数（maxOff 目標と比較する数）。有給・季節休暇などはカウントしない
function countOff(shifts, s, days) {
  let c = 0;
  for (let d = 1; d <= days; d++) { if (isPublicOff(shifts[s.id][d])) c++; }
  return c;
}

/**
 * A が shiftKey（早責/遅責）を day d で担当したとき階層違反が起きるか確認
 * excludeIds: その日に「いないこととして扱う」スタッフ ID の配列（休む人など）
 * @returns true = 違反が発生する（この A は使えない）
 */
function wouldCauseHierarchyViolation(shifts, staff, allowedShifts, A, d, shiftKey, excludeIds) {
  if (shiftKey !== '早責' && shiftKey !== '遅責') return false;
  const isEarlyResp = shiftKey === '早責';
  return staff.some(other => {
    if (other.id === A.id) return false;
    if (excludeIds && excludeIds.includes(other.id)) return false;
    const sh = shifts[other.id][d] || '';
    if (!isWork(sh)) return false;
    const sameCat = isEarlyResp
      ? (isEarlyCategory(sh) && !isTraining(sh))
      : isLate(sh);
    if (!sameCat) return false;
    if (!(allowedShifts[other.id] || other.allowedShifts || []).includes(shiftKey)) return false;
    return getStaffPriority(other) < getStaffPriority(A);
  });
}

function wouldExceedConsWork(shifts, s, d, days) {
  const maxCons = AppState.settings.maxConsecutive || 5;
  let count = 1; // 当該日自体
  let dd = d - 1;
  while (dd >= 1  && isWork(shifts[s.id][dd])) { count++; dd--; }
  dd = d + 1;
  while (dd <= days && isWork(shifts[s.id][dd])) { count++; dd++; }
  return count > maxCons;
}

// ===== 近傍操作 =====

function trySwapInOneStaff(shifts, locked, staff, days) {
  const s = staff[Math.floor(Math.random() * staff.length)];
  if (!s) return null;
  const d1 = Math.floor(Math.random() * days) + 1;
  const d2 = Math.floor(Math.random() * days) + 1;
  if (d1 === d2 || locked[s.id][d1] || locked[s.id][d2]) return null;
  const v1 = shifts[s.id][d1], v2 = shifts[s.id][d2];
  if (v1 === v2) return null;
  shifts[s.id][d1] = v2; shifts[s.id][d2] = v1;
  return () => { shifts[s.id][d1] = v1; shifts[s.id][d2] = v2; };
}

function trySwapBetweenStaff(shifts, locked, staff, days) {
  if (staff.length < 2) return null;
  const i1 = Math.floor(Math.random() * staff.length);
  let i2   = Math.floor(Math.random() * staff.length);
  if (i1 === i2) i2 = (i2 + 1) % staff.length;
  const s1 = staff[i1], s2 = staff[i2];
  const d  = Math.floor(Math.random() * days) + 1;
  if (locked[s1.id][d] || locked[s2.id][d]) return null;
  const v1 = shifts[s1.id][d], v2 = shifts[s2.id][d];
  if (v1 === v2) return null;
  shifts[s1.id][d] = v2; shifts[s2.id][d] = v1;
  return () => { shifts[s1.id][d] = v1; shifts[s2.id][d] = v2; };
}

function tryChangeShift(shifts, locked, staff, days, allowedShifts) {
  const s = staff[Math.floor(Math.random() * staff.length)];
  if (!s) return null;
  const d = Math.floor(Math.random() * days) + 1;
  if (locked[s.id][d]) return null;
  const cur        = shifts[s.id][d];
  const candidates = allowedShifts[s.id].concat(['休']);
  const next       = candidates[Math.floor(Math.random() * candidates.length)];
  if (cur === next) return null;
  shifts[s.id][d] = next;
  return () => { shifts[s.id][d] = cur; };
}

/** s1のd1日目 ↔ s2のd2日目 の対角交換 */
function trySwapDayBetweenStaff(shifts, locked, staff, days) {
  if (staff.length < 2) return null;
  const i1 = Math.floor(Math.random() * staff.length);
  let i2   = Math.floor(Math.random() * staff.length);
  if (i1 === i2) i2 = (i2 + 1) % staff.length;
  const s1 = staff[i1], s2 = staff[i2];
  const d1 = Math.floor(Math.random() * days) + 1;
  const d2 = Math.floor(Math.random() * days) + 1;
  if (d1 === d2 || locked[s1.id][d1] || locked[s2.id][d2]) return null;
  const v1 = shifts[s1.id][d1], v2 = shifts[s2.id][d2];
  if (v1 === v2) return null;
  shifts[s1.id][d1] = v2; shifts[s2.id][d2] = v1;
  return () => { shifts[s1.id][d1] = v1; shifts[s2.id][d2] = v2; };
}

/**
 * 責任者ヒエラルキー違反を狙い撃ちして修正
 * より上位者が早/遅で働いているのに下位者が早責/遅責に就いている場合、シフトを交換
 */
function tryFixHierarchyViolation(shifts, locked, staff, days) {
  for (let d = 1; d <= days; d++) {
    // 早責チェック
    const respEarly = staff.find(s => shifts[s.id][d] === '早責');
    if (respEarly && !locked[respEarly.id][d]) {
      const moreCapable = staff.filter(s => {
        const sh = shifts[s.id][d] || '';
        return s.id !== respEarly.id && !locked[s.id][d] &&
          isWork(sh) && isEarlyCategory(sh) && !isTraining(sh) &&
          (s.allowedShifts || []).includes('早責') &&
          getStaffPriority(s) < getStaffPriority(respEarly);
      });
      if (moreCapable.length > 0) {
        moreCapable.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));
        const better = moreCapable[0];
        const v1 = shifts[respEarly.id][d], v2 = shifts[better.id][d];
        shifts[respEarly.id][d] = v2; shifts[better.id][d] = v1;
        return () => { shifts[respEarly.id][d] = v1; shifts[better.id][d] = v2; };
      }
    }
    // 遅責チェック
    const respLate = staff.find(s => shifts[s.id][d] === '遅責');
    if (respLate && !locked[respLate.id][d]) {
      const moreCapable = staff.filter(s => {
        const sh = shifts[s.id][d] || '';
        return s.id !== respLate.id && !locked[s.id][d] &&
          isWork(sh) && isLate(sh) &&
          (s.allowedShifts || []).includes('遅責') &&
          getStaffPriority(s) < getStaffPriority(respLate);
      });
      if (moreCapable.length > 0) {
        moreCapable.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));
        const better = moreCapable[0];
        const v1 = shifts[respLate.id][d], v2 = shifts[better.id][d];
        shifts[respLate.id][d] = v2; shifts[better.id][d] = v1;
        return () => { shifts[respLate.id][d] = v1; shifts[better.id][d] = v2; };
      }
    }
  }
  return null;
}

/** 公休不足のスタッフを狙い撃ちして休みを挿入（遅→休→早パターンを避けて挿入） */
function tryFixOffShortage(shifts, locked, staff, days) {
  const shuffled = [...staff];
  shuffleArray(shuffled);
  for (const s of shuffled) {
    const deficit = (s.maxOff || 0) - countOff(shifts, s, days);
    if (deficit <= 0) continue;

    // 挿入候補を「安全日」と「危険日」に分類
    // 危険: 遅→[d]→早 になるパターン（badRest を新たに作る）
    const goodDays = [], badDays = [];
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d] || !isWork(shifts[s.id][d])) continue;
      const prev = d > 1    ? shifts[s.id][d - 1] : '';
      const next = d < days ? shifts[s.id][d + 1] : '';
      if (isLate(prev) && isEarlyCategory(next)) badDays.push(d);
      else goodDays.push(d);
    }
    // 安全な日を優先。なければ仕方なく危険日から
    const candidates = goodDays.length > 0 ? goodDays : badDays;
    if (!candidates.length) continue;
    const d   = candidates[Math.floor(Math.random() * candidates.length)];
    const old = shifts[s.id][d];
    shifts[s.id][d] = '休';
    return () => { shifts[s.id][d] = old; };
  }
  return null;
}

/**
 * 遅→休→早 パターンを狙い撃ちして修正（ランダム選択・優先度付き）
 * 方法1: 休み日(d) ↔ 遠い出勤日 を交換
 * 方法2: 翌日の早系(d+1) ↔ 休み日（優先）or 遅系の日 と交換 → 遅→休→休 になる
 * 方法3: 前日の遅番(d-1) ↔ 早系 or 休み日 と交換
 */
function tryFixBadRest(shifts, locked, staff, days) {
  // スタッフ順をシャッフルして偏りを防ぐ
  const shuffledStaff = [...staff];
  shuffleArray(shuffledStaff);

  for (const s of shuffledStaff) {
    // 違反パターンを収集してランダムに選択
    const violations = [];
    for (let d = 2; d < days; d++) {
      const prev = shifts[s.id][d - 1];
      const cur  = shifts[s.id][d];
      const next = shifts[s.id][d + 1];
      if (isLate(prev) && isOff(cur) && isEarlyCategory(next)) violations.push(d);
    }
    if (!violations.length) continue;
    shuffleArray(violations);

    for (const d of violations) {
      // 方法1: 休み日(d) ↔ 遠い出勤日 を交換（休みを別の安全な位置へ）
      if (!locked[s.id][d]) {
        const cands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (d3 >= d - 1 && d3 <= d + 1) continue;
          if (locked[s.id][d3]) continue;
          if (isWork(shifts[s.id][d3])) cands.push(d3);
        }
        shuffleArray(cands);
        if (cands.length) {
          const d3 = cands[0];
          const v1 = shifts[s.id][d], v3 = shifts[s.id][d3];
          shifts[s.id][d] = v3; shifts[s.id][d3] = v1;
          return () => { shifts[s.id][d] = v1; shifts[s.id][d3] = v3; };
        }
      }

      // 方法2: 翌日の早系(d+1) ↔ 休み日(優先) or 遅系の日 と交換 → 遅→休→休 になる
      if (!locked[s.id][d + 1]) {
        const restCands = [], lateCands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (d3 >= d - 1 && d3 <= d + 1) continue;
          if (locked[s.id][d3]) continue;
          if (isOff(shifts[s.id][d3])) restCands.push(d3);
          else if (isLate(shifts[s.id][d3])) lateCands.push(d3);
        }
        shuffleArray(restCands);
        shuffleArray(lateCands);
        // 休み日との交換を優先（遅→休→休 は安全）、なければ遅系と交換
        const d3m2 = restCands.length > 0 ? restCands[0] : lateCands[0];
        if (d3m2 !== undefined) {
          const d3 = d3m2;
          const v1 = shifts[s.id][d + 1], v3 = shifts[s.id][d3];
          shifts[s.id][d + 1] = v3; shifts[s.id][d3] = v1;
          return () => { shifts[s.id][d + 1] = v1; shifts[s.id][d3] = v3; };
        }
      }

      // 方法3: 前日の遅番(d-1) ↔ 早系 or 休み日 と交換
      if (!locked[s.id][d - 1]) {
        const restCands = [], earlyCands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (d3 >= d - 1 && d3 <= d + 1) continue;
          if (locked[s.id][d3]) continue;
          if (isOff(shifts[s.id][d3])) restCands.push(d3);
          else if (isEarlyCategory(shifts[s.id][d3])) earlyCands.push(d3);
        }
        shuffleArray(restCands);
        shuffleArray(earlyCands);
        // 休み日との交換を優先（休→休→早 は安全）、なければ早系と交換
        const d3m3 = restCands.length > 0 ? restCands[0] : earlyCands[0];
        if (d3m3 !== undefined) {
          const d3 = d3m3;
          const v1 = shifts[s.id][d - 1], v3 = shifts[s.id][d3];
          shifts[s.id][d - 1] = v3; shifts[s.id][d3] = v1;
          return () => { shifts[s.id][d - 1] = v1; shifts[s.id][d3] = v3; };
        }
      }
    }
  }
  return null;
}

/**
 * 公休余剰スタッフ ↔ 公休不足スタッフ のシフトを交換
 * 公休不足者の出勤日に、公休余剰者が同じシフトをこなせる場合にスワップ
 * allowedShifts: prefs 適用済みの担当可能シフトマップ
 */
function trySwapRestForWork(shifts, locked, staff, days, allowedShifts) {
  // 全スタッフの公休数を一度だけ集計（filter/sort 内での再計算を排除）
  const offCache = {};
  staff.forEach(s => { offCache[s.id] = countOff(shifts, s, days); });

  const shuffled = [...staff];
  shuffleArray(shuffled);

  for (const defStaff of shuffled) {
    if (offCache[defStaff.id] >= (defStaff.maxOff || 0)) continue;

    const workDays = [];
    for (let d = 1; d <= days; d++) {
      if (!locked[defStaff.id][d] && isWork(shifts[defStaff.id][d])) workDays.push(d);
    }
    shuffleArray(workDays);

    for (const d of workDays) {
      const defShift = shifts[defStaff.id][d];

      const reps = staff.filter(rep => {
        if (rep.id === defStaff.id) return false;
        if (locked[rep.id][d]) return false;
        if (!isOff(shifts[rep.id][d])) return false;
        if (offCache[rep.id] <= (rep.maxOff || 0)) return false;
        if (wouldExceedConsWork(shifts, rep, d, days)) return false;
        return (allowedShifts[rep.id] || []).includes(defShift);
      });
      if (!reps.length) continue;

      // 余剰が最大の人を優先（キャッシュ済みカウントを使用）
      reps.sort((a, b) =>
        (offCache[b.id] - (b.maxOff || 0)) - (offCache[a.id] - (a.maxOff || 0)));
      const rep = reps[0];

      const v1 = shifts[defStaff.id][d];
      const v2 = shifts[rep.id][d];
      shifts[defStaff.id][d] = v2;
      shifts[rep.id][d] = v1;
      return () => { shifts[defStaff.id][d] = v1; shifts[rep.id][d] = v2; };
    }
  }
  return null;
}

/**
 * 公休余剰のスタッフの休み日を早番/遅番に変換（余ったら早か遅に入れる）
 * 人員不足の日を優先して埋める
 * allowedShifts: prefs 適用済みの担当可能シフトマップ
 */
function tryConvertSurplusRest(shifts, locked, staff, days, allowedShifts) {
  const shuffled = [...staff];
  shuffleArray(shuffled);

  for (const s of shuffled) {
    const surplus = countOff(shifts, s, days) - (s.maxOff || 0);
    if (surplus <= 0) continue;

    // prefs 適用済みリストから早/遅シフトのみ抽出
    const earlyLateShifts = (allowedShifts[s.id] || []).filter(sh => {
      return (isEarlyCategory(sh) || isLate(sh)) && !isTraining(sh);
    });
    if (!earlyLateShifts.length) continue;

    // 休み日をランダム順で探索
    const restDays = [];
    for (let d = 1; d <= days; d++) {
      if (!locked[s.id][d] && isOff(shifts[s.id][d])) restDays.push(d);
    }
    shuffleArray(restDays);

    for (const d of restDays) {
      // 連勤超過チェック: この休みを出勤に変えると上限を超えるなら除外
      if (wouldExceedConsWork(shifts, s, d, days)) continue;

      // 人員不足のシフトを優先、なければ担当可能な早/遅から選ぶ
      const needyShifts = earlyLateShifts.filter(sh => {
        const req = optDayReq(sh, d);
        if (!req) return false;
        const count = staff.filter(st => shifts[st.id][d] === sh).length;
        return count < req;
      });
      const targetList = needyShifts.length > 0 ? needyShifts : earlyLateShifts;
      shuffleArray(targetList);

      const old = shifts[s.id][d];
      shifts[s.id][d] = targetList[0];
      return () => { shifts[s.id][d] = old; };
    }
  }
  return null;
}

/**
 * 連鎖スワップ（3段 or 4段）: 公休不足者を休ませるための連鎖代替
 *
 * 3段:  defStaff(X)→休 / A(Y→X) / B(余剰休→Y)
 * 4段:  defStaff(X)→休 / A(Y→X) / C(Z→Y) / B(余剰休→Z)
 *
 * 例（4段）:
 *   石川(早責)→休
 *   渡邊(早)→早責
 *   掛上(早総務)→早
 *   平峰(余剰休)→早総務  ← これで平峰の余剰を活用できる！
 */
function tryCascadeSwapForRest(shifts, locked, staff, days, allowedShifts) {
  const shuffled = [...staff];
  shuffleArray(shuffled);

  // 余剰休日カウントをキャッシュ（パフォーマンス改善）
  const offCountCache = {};
  staff.forEach(s => {
    let c = 0;
    for (let d = 1; d <= days; d++) { if (isPublicOff(shifts[s.id][d])) c++; }
    offCountCache[s.id] = c;
  });

  for (const defStaff of shuffled) {
    if (offCountCache[defStaff.id] >= (defStaff.maxOff || 0)) continue;

    const workDays = [];
    for (let d = 1; d <= days; d++) {
      if (!locked[defStaff.id][d] && isWork(shifts[defStaff.id][d])) workDays.push(d);
    }
    shuffleArray(workDays);

    for (const d of workDays) {
      const shiftX = shifts[defStaff.id][d]; // defStaff のシフト

      // A: shiftX をこなせる、別シフトで出勤中の人
      // ※ defStaff が休むため A が shiftX を担う。階層違反にならない A のみ選ぶ
      const candidatesA = staff.filter(A => {
        if (A.id === defStaff.id) return false;
        if (locked[A.id][d] || !isWork(shifts[A.id][d])) return false;
        if (shifts[A.id][d] === shiftX) return false;
        if (!(allowedShifts[A.id] || []).includes(shiftX)) return false;
        // A が shiftX に就いたとき、defStaff（休む）を除いて階層違反が起きないか
        if (wouldCauseHierarchyViolation(shifts, staff, allowedShifts, A, d, shiftX, [defStaff.id])) return false;
        return true;
      });
      shuffleArray(candidatesA);

      for (const A of candidatesA) {
        const shiftY = shifts[A.id][d]; // A のシフト

        // ───── 3段連鎖を先に試す ─────
        const surplus3 = staff.filter(B => {
          if (B.id === defStaff.id || B.id === A.id) return false;
          if (locked[B.id][d] || !isOff(shifts[B.id][d])) return false;
          if (offCountCache[B.id] <= (B.maxOff || 0)) return false;
          if (wouldExceedConsWork(shifts, B, d, days)) return false;
          return (allowedShifts[B.id] || []).includes(shiftY);
        });
        if (surplus3.length) {
          shuffleArray(surplus3);
          const B = surplus3[0];
          const oD = shifts[defStaff.id][d], oA = shifts[A.id][d], oB = shifts[B.id][d];
          shifts[defStaff.id][d] = oB; shifts[A.id][d] = oD; shifts[B.id][d] = oA;
          return () => { shifts[defStaff.id][d] = oD; shifts[A.id][d] = oA; shifts[B.id][d] = oB; };
        }

        // ───── 4段連鎖にフォールバック ─────
        // C: shiftY をこなせる、別シフトで出勤中の人
        const candidatesC = staff.filter(C => {
          if (C.id === defStaff.id || C.id === A.id) return false;
          if (locked[C.id][d] || !isWork(shifts[C.id][d])) return false;
          const cShift = shifts[C.id][d];
          if (cShift === shiftX || cShift === shiftY) return false;
          return (allowedShifts[C.id] || []).includes(shiftY);
        });
        shuffleArray(candidatesC);

        for (const C of candidatesC) {
          const shiftZ = shifts[C.id][d]; // C のシフト

          // B: 余剰休日を持ち shiftZ をこなせる人
          const surplus4 = staff.filter(B => {
            if ([defStaff.id, A.id, C.id].includes(B.id)) return false;
            if (locked[B.id][d] || !isOff(shifts[B.id][d])) return false;
            if (offCountCache[B.id] <= (B.maxOff || 0)) return false;
            if (wouldExceedConsWork(shifts, B, d, days)) return false;
            return (allowedShifts[B.id] || []).includes(shiftZ);
          });
          if (!surplus4.length) continue;

          shuffleArray(surplus4);
          const B = surplus4[0];
          // 4段実行: defStaff→休, A→X, C→Y, B→Z
          const oD = shifts[defStaff.id][d], oA = shifts[A.id][d];
          const oC = shifts[C.id][d],        oB = shifts[B.id][d];
          shifts[defStaff.id][d] = oB;  // 休
          shifts[A.id][d]        = oD;  // shiftX（昇格）
          shifts[C.id][d]        = oA;  // shiftY
          shifts[B.id][d]        = oC;  // shiftZ（余剰人材が担う）
          return () => {
            shifts[defStaff.id][d] = oD; shifts[A.id][d] = oA;
            shifts[C.id][d]        = oC; shifts[B.id][d] = oB;
          };
        }
      }
    }
  }
  return null;
}

/** 人員不足の日・シフトを狙い撃ちして修正 */
function tryFixUnderstaffing(shifts, locked, staff, days, allowedShifts) {
  const shiftKeys = getWorkShiftKeys();
  for (let d = 1; d <= days; d++) {
    for (const sh of shiftKeys) {
      const req   = optDayReq(sh, d);
      if (!req) continue;
      const count = staff.filter(s => shifts[s.id][d] === sh).length;
      if (count >= req) continue;
      const cands = staff.filter(s =>
        !locked[s.id][d] && shifts[s.id][d] === '休' && allowedShifts[s.id].includes(sh));
      if (!cands.length) continue;
      const s = cands[Math.floor(Math.random() * cands.length)];
      const old = shifts[s.id][d];
      shifts[s.id][d] = sh;
      return () => { shifts[s.id][d] = old; };
    }
  }
  return null;
}

/**
 * 遅→休→早 を2人連携で修正（複合ムーブ）
 * バッドレストのスタッフが「早系」に入っている日を、余剰休日を持つ別スタッフと交換
 * → badRest解消 + 公休不足解消 + 余剰休日削減 を同時に行う
 */
function tryCompoundFixBadRest(shifts, locked, staff, days, allowedShifts) {
  const shuffledStaff = [...staff];
  shuffleArray(shuffledStaff);

  for (const s of shuffledStaff) {
    // badRest パターンを収集
    const violations = [];
    for (let d = 2; d < days; d++) {
      if (isLate(shifts[s.id][d - 1]) && isOff(shifts[s.id][d]) && isEarlyCategory(shifts[s.id][d + 1])) {
        violations.push(d);
      }
    }
    if (!violations.length) continue;
    shuffleArray(violations);

    for (const d of violations) {
      const earlyDay = d + 1;
      if (locked[s.id][earlyDay]) continue;
      const earlyShift = shifts[s.id][earlyDay];

      // 早系シフトを代わりに担当できる、かつ休日余剰があるスタッフを探す
      // ※ s が休む（earlyDay に休みを取る）ため、rep が earlyShift を担う
      const reps = staff.filter(rep => {
        if (rep.id === s.id) return false;
        if (locked[rep.id][earlyDay]) return false;
        if (!isOff(shifts[rep.id][earlyDay])) return false;
        if (countOff(shifts, rep, days) <= (rep.maxOff || 0)) return false;
        if (wouldExceedConsWork(shifts, rep, earlyDay, days)) return false;
        if (!(allowedShifts[rep.id] || []).includes(earlyShift)) return false;
        if (wouldCauseHierarchyViolation(shifts, staff, allowedShifts, rep, earlyDay, earlyShift, [s.id])) return false;
        return true;
      });
      if (!reps.length) continue;

      shuffleArray(reps);
      const rep = reps[0];

      // 交換: s は休み、rep が早系シフトを担当
      const sv = shifts[s.id][earlyDay];   // 早系シフト
      const rv = shifts[rep.id][earlyDay]; // 休み
      shifts[s.id][earlyDay]   = rv;  // s → 休み
      shifts[rep.id][earlyDay] = sv;  // rep → 早系シフト
      return () => {
        shifts[s.id][earlyDay]   = sv;
        shifts[rep.id][earlyDay] = rv;
      };
    }
  }
  return null;
}

/**
 * 連勤中の時間帯切替（早↔遅）を狙い撃ちして修正
 * 方法1: 切替日(d) ↔ 同日の別スタッフ(prevCatシフト) を交換 → その場でカテゴリ入れ替え
 *         例: 石川(遅責)↔三村(早責) → 石川が前日と同カテゴリになる
 * 方法2: 切替日(d) ↔ 同人の「前日と同カテゴリの出勤日(d3)」を交換 → 時系列を整列
 * 方法3: 切替日(d) ↔ 同人の休み日(d3) を交換 → 連続ブロック分断
 */
function tryFixCategorySwitch(shifts, locked, staff, days, allowedShifts) {
  const shuffledStaff = [...staff];
  shuffleArray(shuffledStaff);

  for (const s of shuffledStaff) {
    // カテゴリ切替違反を収集
    const violations = [];
    let consWork  = s.prevConsecutive || 0;
    let prevShift = (consWork > 0 && s.prevLastShift) ? s.prevLastShift : '';
    for (let d = 1; d <= days; d++) {
      const cur = shifts[s.id][d];
      if (isWork(cur)) {
        if (consWork >= 1 && isWork(prevShift)) {
          const pc = getShiftCategory(prevShift), cc = getShiftCategory(cur);
          if (pc && cc && pc !== cc) violations.push(d);
        }
        consWork++;
        prevShift = cur;
      } else {
        consWork = 0;
        prevShift = cur;
      }
    }
    if (!violations.length) continue;
    shuffleArray(violations);

    for (const d of violations) {
      if (locked[s.id][d]) continue;
      const curShift = shifts[s.id][d];
      const curCat   = getShiftCategory(curShift);
      const prevCat  = d > 1 ? getShiftCategory(shifts[s.id][d - 1]) : null;
      if (!prevCat || !curCat) continue;

      // 方法1: 同日の別スタッフ(prevCatシフト) と交換 → その場でカテゴリ入れ替え
      // 副店長どうしの 早責↔遅責 スワップなど
      {
        const interCands = staff.filter(rep => {
          if (rep.id === s.id) return false;
          if (locked[rep.id][d]) return false;
          const rsh = shifts[rep.id][d];
          if (!isWork(rsh)) return false;
          if (getShiftCategory(rsh) !== prevCat) return false; // repは prevCat 系
          // 互いに相手のシフトに入れるか
          if (!(allowedShifts[s.id]   || []).includes(rsh))     return false;
          if (!(allowedShifts[rep.id] || []).includes(curShift)) return false;
          return true;
        });
        if (interCands.length) {
          shuffleArray(interCands);
          const rep = interCands[0];
          const v1 = shifts[s.id][d], v2 = shifts[rep.id][d];
          shifts[s.id][d] = v2; shifts[rep.id][d] = v1;
          return () => { shifts[s.id][d] = v1; shifts[rep.id][d] = v2; };
        }
      }

      // 方法2: 切替日(d) ↔ 同人の「prevCatと同じカテゴリの出勤日(d3)」を交換
      // → day d が prevCat になり前日との切替が解消される
      {
        const matchCands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (Math.abs(d3 - d) <= 1) continue; // 隣接日は交換しても意味がない
          if (locked[s.id][d3]) continue;
          if (!isWork(shifts[s.id][d3])) continue;
          if (getShiftCategory(shifts[s.id][d3]) === prevCat) matchCands.push(d3);
        }
        if (matchCands.length) {
          shuffleArray(matchCands);
          const d3 = matchCands[0];
          const v1 = shifts[s.id][d], v3 = shifts[s.id][d3];
          shifts[s.id][d] = v3; shifts[s.id][d3] = v1;
          return () => { shifts[s.id][d] = v1; shifts[s.id][d3] = v3; };
        }
      }

      // 方法3: 切替日(d) ↔ 休み日(d3) を交換 → 連続ブロックを分断して切替を解消
      {
        const restCands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (Math.abs(d3 - d) <= 1) continue;
          if (locked[s.id][d3]) continue;
          if (isOff(shifts[s.id][d3])) restCands.push(d3);
        }
        if (restCands.length) {
          shuffleArray(restCands);
          const d3 = restCands[0];
          const v1 = shifts[s.id][d], v3 = shifts[s.id][d3];
          shifts[s.id][d] = v3; shifts[s.id][d3] = v1;
          return () => { shifts[s.id][d] = v1; shifts[s.id][d3] = v3; };
        }
      }
    }
  }
  return null;
}

/**
 * 単発出勤（前後が両方休み）を解消
 * 方法1(スタッフ間): A の単発シフトを、隣日が出勤のスタッフ B に譲渡（A は休み）
 *   → 日別カバレッジ不変。A の公休+1（公休不足の 石川/三村 に有効）
 * 方法2(スタッフ間): A が隣日(d±1) の B のシフトを引き取り、B は休み
 *   → 日別カバレッジ不変。A の単発がクラスタ化（公休余剰スタッフに有効）
 * 方法3(個人内): 単発出勤日 ↔ クラスタ隣接の休み日 を交換
 * ※ 全方法で 遅→早 / 遅→休→早 / 連勤超過 / ヒエラルキー違反 をチェック
 */
function tryFixSingleWork(shifts, locked, staff, days, allowedShifts) {
  const shuffledStaff = [...staff];
  shuffleArray(shuffledStaff);
  const checkLE = AppState.settings.forbidLateEarly;

  for (const A of shuffledStaff) {
    const singles = [];
    for (let d = 2; d < days; d++) {
      if (!isWork(shifts[A.id][d])) continue;
      if (!isWork(shifts[A.id][d - 1]) && !isWork(shifts[A.id][d + 1])) singles.push(d);
    }
    if (!singles.length) continue;
    shuffleArray(singles);

    for (const d of singles) {
      const w = shifts[A.id][d];

      // 方法1: A の単発シフト w を B が引き取り、A は休む
      // 条件: B はその日休み（unlocked）、w を担当可、d±1 のどちらかが出勤（クラスタ拡張）
      if (!locked[A.id][d]) {
        const cands = staff.filter(B => {
          if (B.id === A.id) return false;
          if (locked[B.id][d]) return false;
          if (!isOff(shifts[B.id][d])) return false;
          if (!(allowedShifts[B.id] || B.allowedShifts || []).includes(w)) return false;
          const pv = d > 1    ? shifts[B.id][d - 1] : '';
          const nx = d < days ? shifts[B.id][d + 1] : '';
          if (!isWork(pv) && !isWork(nx)) return false; // B も単発になるなら不可
          if (checkLE) {
            if (isLate(pv) && isEarlyCategory(w)) return false;
            if (isLate(w) && isEarlyCategory(nx)) return false;
          }
          // B の連勤超過チェック（d を出勤とした場合）
          const saved = shifts[B.id][d];
          shifts[B.id][d] = w;
          const exceed = wouldExceedConsWork(shifts, B, d, days);
          shifts[B.id][d] = saved;
          if (exceed) return false;
          // 責任者シフトならヒエラルキーチェック（A はその日休む前提）
          if (wouldCauseHierarchyViolation(shifts, staff, allowedShifts, B, d, w, [A.id])) return false;
          return true;
        });
        shuffleArray(cands);
        if (cands.length) {
          const B = cands[0];
          const vB = shifts[B.id][d];
          shifts[A.id][d] = '休'; shifts[B.id][d] = w;
          return () => { shifts[A.id][d] = w; shifts[B.id][d] = vB; };
        }
      }

      // 方法2: 隣日 e(d±1) で働いている B のシフトを A が引き取り、B は休む
      for (const e of [d - 1, d + 1]) {
        if (e < 1 || e > days) continue;
        if (locked[A.id][e]) continue;
        const candsB = staff.filter(B => {
          if (B.id === A.id) return false;
          if (locked[B.id][e]) return false;
          const wB = shifts[B.id][e];
          if (!isWork(wB)) return false;
          if (!(allowedShifts[A.id] || A.allowedShifts || []).includes(wB)) return false;
          if (checkLE) {
            // A: d と e が連続出勤になる
            if (e === d + 1 && isLate(w) && isEarlyCategory(wB)) return false;
            if (e === d - 1 && isLate(wB) && isEarlyCategory(w)) return false;
            // A の e のさらに外側
            const outer = e === d + 1 ? (e < days ? shifts[A.id][e + 1] : '') : (e > 1 ? shifts[A.id][e - 1] : '');
            if (e === d + 1 && isLate(wB) && isEarlyCategory(outer)) return false;
            if (e === d - 1 && isLate(outer) && isEarlyCategory(wB)) return false;
          }
          // B が e で休んだとき bad-rest にならないか
          const pB = e > 1    ? shifts[B.id][e - 1] : '';
          const nB = e < days ? shifts[B.id][e + 1] : '';
          if (isLate(pB) && isEarlyCategory(nB)) return false;
          // B が単発出勤にならないか（e の両隣が非出勤になる場合）
          // → e-1 と e+1 のどちらかで B が働いていれば B のクラスタは保たれる
          // A の連勤超過チェック
          const saved = shifts[A.id][e];
          shifts[A.id][e] = wB;
          const exceed = wouldExceedConsWork(shifts, A, e, days);
          shifts[A.id][e] = saved;
          if (exceed) return false;
          // 責任者シフトならヒエラルキーチェック（B はその日休む前提）
          if (wouldCauseHierarchyViolation(shifts, staff, allowedShifts, A, e, wB, [B.id])) return false;
          return true;
        });
        shuffleArray(candsB);
        if (candsB.length) {
          const B  = candsB[0];
          const wB = shifts[B.id][e];
          const vA = shifts[A.id][e];
          shifts[A.id][e] = wB; shifts[B.id][e] = '休';
          return () => { shifts[A.id][e] = vA; shifts[B.id][e] = wB; };
        }
      }

      // 方法3(個人内): d(単発出勤) ↔ d3(クラスタ隣接の休み) を交換
      if (!locked[A.id][d]) {
        const cands = [];
        for (let d3 = 1; d3 <= days; d3++) {
          if (Math.abs(d3 - d) <= 1) continue;
          if (locked[A.id][d3]) continue;
          if (!isOff(shifts[A.id][d3])) continue;
          const prevD3 = d3 > 1    ? shifts[A.id][d3 - 1] : '';
          const nextD3 = d3 < days ? shifts[A.id][d3 + 1] : '';
          if (!isWork(prevD3) && !isWork(nextD3)) continue; // クラスタ隣接でない
          if (checkLE) {
            if (isLate(prevD3) && isEarlyCategory(w)) continue;
            if (isLate(w) && isEarlyCategory(nextD3)) continue;
          }
          cands.push(d3);
        }
        shuffleArray(cands);
        if (cands.length) {
          const d3 = cands[0];
          const v3 = shifts[A.id][d3];
          shifts[A.id][d] = v3; shifts[A.id][d3] = w;
          return () => { shifts[A.id][d] = w; shifts[A.id][d3] = v3; };
        }
      }
    }
  }
  return null;
}

/** 遅→早違反を狙い撃ちして修正（前後の休みと入れ替え） */
function tryFixLateEarlyViolation(shifts, locked, staff, days) {
  for (const s of staff) {
    for (let d = 2; d <= days; d++) {
      if (!AppState.settings.forbidLateEarly) break;
      const prev = shifts[s.id][d - 1];
      const cur  = shifts[s.id][d];
      if (!isLate(prev) || !isEarlyCategory(cur)) continue;
      // d-1 を別の休みと交換
      if (!locked[s.id][d - 1]) {
        for (let d3 = 1; d3 <= days; d3++) {
          if (d3 === d - 1 || d3 === d || locked[s.id][d3]) continue;
          if (shifts[s.id][d3] === '休') {
            const v1 = shifts[s.id][d - 1], v3 = shifts[s.id][d3];
            shifts[s.id][d - 1] = v3; shifts[s.id][d3] = v1;
            return () => { shifts[s.id][d - 1] = v1; shifts[s.id][d3] = v3; };
          }
        }
      }
      // d を別の休みと交換
      if (!locked[s.id][d]) {
        for (let d3 = 1; d3 <= days; d3++) {
          if (d3 === d - 1 || d3 === d || locked[s.id][d3]) continue;
          if (shifts[s.id][d3] === '休') {
            const v2 = shifts[s.id][d], v3 = shifts[s.id][d3];
            shifts[s.id][d] = v3; shifts[s.id][d3] = v2;
            return () => { shifts[s.id][d] = v2; shifts[s.id][d3] = v3; };
          }
        }
      }
    }
  }
  return null;
}

// ===== スコア計算 =====

function calculateScore(shifts, allowedShifts, days, P) {
  let score    = 0;
  const staff  = optStaff();
  const reqs   = optReqs();
  const maxCons = AppState.settings.maxConsecutive;
  const shiftKeys = getWorkShiftKeys();

  // 毎日1人出勤ルール: 副店長が2人以上いる場合のみ有効
  // 1人の場合は公休目標と数学的に矛盾するため自動オフ
  const vmCount = staff.filter(s => s.positionType === 'viceManager').length;
  const hasVice = vmCount >= 2;

  // 縦: 各日の必要人数 + 責任者ヒエラルキー
  // staff を1回だけ走査してカウント・責任者特定・ヒエラルキー確認をまとめて行う
  for (let d = 1; d <= days; d++) {
    const counts = {};
    shiftKeys.forEach(k => counts[k] = 0);
    let respEarlyPerson = null, respLatePerson = null;
    let viceWorking = 0;
    staff.forEach(s => {
      const sh = shifts[s.id][d];
      if (counts[sh] !== undefined) counts[sh]++;
      if (sh === '早責') respEarlyPerson = s;
      if (sh === '遅責') respLatePerson  = s;
      if (s.positionType === 'viceManager' && isWork(sh)) viceWorking++;
    });

    // 毎日、副店長が1人以上出勤していること（早番か遅番にいる）
    if (hasVice && viceWorking === 0) score += (P.viceManagerDailyAbsent || 9000);
    shiftKeys.forEach(k => {
      const req = optDayReq(k, d);
      if (!req) return;
      const diff = req - counts[k];
      if (diff > 0) score += diff * P.understaff;
      // 責任者・総務（早責/遅責/早総/遅総）は同じ時間帯に2人いてはいけないため重罰
      else if (diff < 0) score += (-diff) * (SOLO_SHIFT_KEYS.includes(k) ? P.respDuplicate : P.overstaff);
    });

    // スキル別: 遅番に必要なスキル保有者数を満たすか
    const skills = AppState.skills || [];
    if (skills.length) {
      skills.forEach(sk => {
        const need = sk.lateReq || 0;
        if (!need) return;
        let have = 0;
        staff.forEach(s => {
          const sh = shifts[s.id][d];
          if (isWork(sh) && isLate(sh) && (s.skills || []).includes(sk.name)) have++;
        });
        if (have < need) score += (need - have) * (P.skillLateShortage || 9000);
      });
    }

    // 責任者ヒエラルキー違反（pref フィルタ済み allowedShifts で判定）
    if (respEarlyPerson && staff.some(s =>
          s.id !== respEarlyPerson.id &&
          isWork(shifts[s.id][d]) && isEarlyCategory(shifts[s.id][d]) && !isTraining(shifts[s.id][d]) &&
          (allowedShifts[s.id] || s.allowedShifts || []).includes('早責') &&
          getStaffPriority(s) < getStaffPriority(respEarlyPerson))) {
      score += P.hierarchyViolation;
    }
    if (respLatePerson && staff.some(s =>
          s.id !== respLatePerson.id &&
          isWork(shifts[s.id][d]) && isLate(shifts[s.id][d]) &&
          (allowedShifts[s.id] || s.allowedShifts || []).includes('遅責') &&
          getStaffPriority(s) < getStaffPriority(respLatePerson))) {
      score += P.hierarchyViolation;
    }
  }

  // イベント日: 対象スタッフが休んでいたら重罰
  (AppState.events || []).forEach(ev => {
    if (!ev || !ev.day || ev.day < 1 || ev.day > days) return;
    (ev.staffIds || []).forEach(sid => {
      if (!shifts[sid]) return; // 他部門のスタッフは対象外
      if (!isWork(shifts[sid][ev.day])) score += (P.eventAbsent || 20000);
    });
  });

  // 横: 各スタッフのルール
  staff.forEach(s => {
    let consWork  = s.prevConsecutive || 0;
    let prevShift = (consWork > 0 && s.prevLastShift) ? s.prevLastShift : '';
    let offCount  = 0, earlyCount = 0, lateCount = 0;
    let lockedOff = 0, unlockedOff = 0; // viceManager 用（既存ループ内で同時集計）
    let offRun    = 0, pairRestRuns = 0; // 連休（2連休以上）の検出用

    for (let d = 1; d <= days; d++) {
      const cur = shifts[s.id][d];

      if (isWork(cur)) {
        if (offRun >= 2) pairRestRuns++;
        offRun = 0;

        if (!isTraining(cur)) {
          // 担当外シフト
          if (!allowedShifts[s.id].includes(cur)) score += P.disallowedShift;
        }

        consWork++;
        if (consWork > maxCons) {
          const over = consWork - maxCons;
          score += P.consBase * over + P.consSq * over * over;
        }

        // 遅→早禁止
        if (AppState.settings.forbidLateEarly && isLate(prevShift) && isEarlyCategory(cur)) {
          score += P.lateEarly;
        }

        // prefs（早遅希望）違反: checkViolations と整合させてスコアに反映
        if (s.prefs && s.prefs.length > 0) {
          if (isEarlyCategory(cur) && !s.prefs.includes('早可')) score += (P.prefMismatch || 12000);
          if (isLate(cur)          && !s.prefs.includes('遅可')) score += (P.prefMismatch || 12000);
        }

        // 夜勤翌日は必ず休み
        if (isNight(prevShift)) score += (P.nightAfterWork || 8000);

        // 連勤中の時間帯切替
        if (consWork >= 2 && isWork(prevShift)) {
          const pc = getShiftCategory(prevShift), cc = getShiftCategory(cur);
          if (pc && cc && pc !== cc) score += P.categorySwitch;
        }

        if (isEarly(cur)) earlyCount++;
        else if (isLate(cur)) lateCount++;
        prevShift = cur;

      } else {
        if (isOff(cur)) {
          // 公休のみ maxOff 目標にカウント（有給・季節休暇などは別枠）
          if (isPublicOff(cur)) {
            offCount++;
            if (s.positionType === 'viceManager') {
              const isLockedOff =
                isPublicOff((AppState.requests[s.id]    || {})[d]) ||
                isPublicOff((AppState.fixedShifts[s.id] || {})[d]);
              if (isLockedOff) lockedOff++;
              else unlockedOff++;
            }
          }
          offRun++;
        }
        consWork = 0;

        // 単発休みペナルティ
        if (AppState.settings.penaltySingleOff && d > 1 && d < days) {
          const pv = shifts[s.id][d - 1], nx = shifts[s.id][d + 1];
          if (isWork(pv) && isWork(nx)) {
            score += (isLate(pv) && isEarlyCategory(nx)) ? P.badRest : P.singleOff;
          }
        }
        prevShift = cur;
      }
    }

    // 早遅バランス
    const balance   = SHIFT_BALANCE[s.balance || 'balanced'];
    const totalWork = earlyCount + lateCount;
    if (balance && totalWork > 0) {
      score += (Math.abs(earlyCount - totalWork * balance.earlyRatio) +
                Math.abs(lateCount  - totalWork * balance.lateRatio)) * P.balanceDiff;
    }

    // 単発出勤
    if (AppState.settings.penaltySingleOff) {
      for (let d = 2; d < days; d++) {
        if (!isWork(shifts[s.id][d])) continue;
        if (!isWork(shifts[s.id][d - 1]) && !isWork(shifts[s.id][d + 1])) score += P.singleWork;
      }
    }

    // 連休（2連休以上のまとまり）ボーナス: 細切れの休みより連休を優先
    if (offRun >= 2) pairRestRuns++;
    score -= pairRestRuns * (P.restPairBonus || 0);

    // 公休不足のみペナルティ（余剰は余力として許容、targetedムーブで自然に削減）
    const offDiff = offCount - (s.maxOff || 0);
    if (offDiff < 0) score += (-offDiff) * P.offShortage;

    // 副店長: 目標を超えた unlocked 休日にのみペナルティ（offShortage との矛盾を排除）
    // lockedOff / unlockedOff は上のループ内で既に集計済み
    if (s.positionType === 'viceManager') {
      const targetUnlocked = Math.max(0, (s.maxOff || 0) - lockedOff);
      const excess = unlockedOff - targetUnlocked;
      if (excess > 0) score += excess * P.viceManagerRest;
    }
  });

  return score;
}

// ===== 違反チェック =====

function checkViolations(shifts) {
  _shiftKeysCache = null; // キャッシュを毎回リセットして最新の shiftTypes を使う
  const violations = [];
  const staff      = AppState.staff;
  const settings   = AppState.settings;
  const days       = getDaysInMonth(settings.targetMonth);
  const maxCons    = settings.maxConsecutive;
  const shiftKeys  = getWorkShiftKeys();

  staff.forEach(s => {
    let consWork  = s.prevConsecutive || 0;
    let prevShift = (consWork > 0 && s.prevLastShift) ? s.prevLastShift : '';
    let offCount  = 0;
    const effectiveAllowed = (s.allowedShifts || []).concat(['研']); // 研は全員許容
    const reportedDays = new Set();

    for (let d = 1; d <= days; d++) {
      const cur = (shifts[s.id] || {})[d] || '';

      if (isWork(cur)) {
        consWork++;
        if (consWork > maxCons && !reportedDays.has(d)) {
          violations.push({
            staffId: s.id, day: d, type: 'consecutive',
            message: `🚨 ${consWork}連勤（上限${maxCons}）`,
            action:  '他の日と入れ替えて休みを挟んでください',
          });
          reportedDays.add(d);
        }

        if (settings.forbidLateEarly && isLate(prevShift) && isEarlyCategory(cur)) {
          violations.push({
            staffId: s.id, day: d, type: 'late-early',
            message: `🚨 ${isTraining(cur) ? '遅→研' : '遅→早'}（インターバル不足）`,
            action:  '順序を入れ替えてください',
          });
        }

        // 夜勤翌日は必ず休み
        if (isNight(prevShift)) {
          violations.push({
            staffId: s.id, day: d, type: 'night-after-work',
            message: `🚨 夜勤翌日に出勤（夜勤明けは休み必須）`,
            action:  '夜勤翌日を休みに変更してください',
          });
        }

        if (consWork >= 2 && isWork(prevShift)) {
          const pc = getShiftCategory(prevShift), cc = getShiftCategory(cur);
          if (pc && cc && pc !== cc) {
            violations.push({
              staffId: s.id, day: d, type: 'category-switch',
              message: `⚠️ 連勤中の時間帯切替（${prevShift}→${cur}）`,
              action:  '連続勤務は同じ時間帯で揃えてください',
            });
          }
        }

        if (!effectiveAllowed.includes(cur)) {
          violations.push({
            staffId: s.id, day: d, type: 'role-mismatch',
            message: `🚨 担当外のシフト（${cur}）`,
            action:  '担当シフトに変更するかスタッフを変えてください',
          });
        }

        // prefs チェック
        if (s.prefs && s.prefs.length > 0) {
          if (isEarly(cur) && !s.prefs.includes('早可')) {
            violations.push({ staffId: s.id, day: d, type: 'pref-mismatch',
              message: `⚠️ 早番不可なのに早番（${cur}）`, action: '希望に合うシフトに変更してください' });
          }
          if (isLate(cur) && !s.prefs.includes('遅可')) {
            violations.push({ staffId: s.id, day: d, type: 'pref-mismatch',
              message: `⚠️ 遅番不可なのに遅番（${cur}）`, action: '希望に合うシフトに変更してください' });
          }
        }

        // 単発出勤チェック（前後が両方とも非出勤）
        if (settings.penaltySingleOff && d > 1 && d < days) {
          const nx = (shifts[s.id] || {})[d + 1] || '';
          if (!isWork(prevShift) && !isWork(nx)) {
            violations.push({
              staffId: s.id, day: d, type: 'single-work',
              message: `⚠️ 単発出勤（${cur}）`,
              action:  '前後の休みをずらして出勤日を連続させてください',
            });
          }
        }

        prevShift = cur;
      } else {
        if (isPublicOff(cur)) offCount++; // 公休のみカウント（有給・季節休暇は別枠）
        consWork = 0;

        if (settings.penaltySingleOff && d > 1 && d < days) {
          const pv = (shifts[s.id] || {})[d - 1] || '';
          const nx = (shifts[s.id] || {})[d + 1] || '';
          if (isLate(pv) && isEarlyCategory(nx)) {
            violations.push({
              staffId: s.id, day: d, type: 'bad-rest',
              message: `⚠️ ${isTraining(nx) ? '遅→休→研' : '遅→休→早'}（リズムが悪い）`,
              action:  '時間帯を揃えてください',
            });
          }
        }
        prevShift = cur;
      }
    }

    // 公休不足のみ報告（超過は余剰人員のため許容）
    const diff = offCount - (s.maxOff || 0);
    if (diff < 0) {
      violations.push({
        staffId: s.id, day: 0, type: 'off-count',
        message: `🚨 公休数 ${offCount}日（目標${s.maxOff}日, 差${diff}）`,
        action:  '公休数を増やしてください',
      });
    }
  });

  // 毎日、副店長が1人以上出勤していること（副店長2人以上のときのみ有効）
  // 1人の場合は公休目標と数学的に矛盾するためチェックしない
  const viceManagers = staff.filter(s => s.positionType === 'viceManager');
  if (viceManagers.length >= 2) {
    for (let d = 1; d <= days; d++) {
      const working = viceManagers.some(vm => isWork((shifts[vm.id] || {})[d] || ''));
      if (!working) {
        violations.push({
          staffId: null, day: d, type: 'vicemanager-absent',
          message: `🚨 ${d}日 副店長が誰も出勤していない`,
          action:  '副店長のいずれかをこの日に出勤させてください',
        });
      }
    }
  }

  // スキル別: 遅番に必要なスキル保有者が足りているか
  (AppState.skills || []).forEach(sk => {
    const need = sk.lateReq || 0;
    if (!need) return;
    for (let d = 1; d <= days; d++) {
      let have = 0;
      staff.forEach(s => {
        const sh = (shifts[s.id] || {})[d] || '';
        if (isWork(sh) && isLate(sh) && (s.skills || []).includes(sk.name)) have++;
      });
      if (have < need) {
        violations.push({
          staffId: null, day: d, type: 'skill-late',
          message: `🚨 ${d}日 遅番に「${sk.name}」できる人が${have}人（${need}人必要）`,
          action:  `「${sk.name}」スキルのある人を遅番に配置してください`,
        });
      }
    }
  });

  // イベント日: 対象スタッフが休んでいないか
  (AppState.events || []).forEach(ev => {
    if (!ev || !ev.day || ev.day < 1 || ev.day > days) return;
    (ev.staffIds || []).forEach(sid => {
      const s = staff.find(m => m.id === sid);
      if (!s) return;
      const sh = (shifts[sid] || {})[ev.day] || '';
      if (!isWork(sh)) {
        violations.push({
          staffId: sid, day: ev.day, type: 'event-absent',
          message: `🚨 行事「${ev.name || '行事'}」の日に休み`,
          action:  'この日は出勤に変更してください',
        });
      }
    });
  });

  // 各日の人員不足・重複・ヒエラルキー（部門ごとに判定）
  getDepartmentGroups(staff).forEach(g => {
    const gLabel = g.key === 'cast' ? 'キャスト ' : '';
    for (let d = 1; d <= days; d++) {
      const counts = {};
      shiftKeys.forEach(k => counts[k] = 0);
      g.staff.forEach(s => {
        const sh = (shifts[s.id] || {})[d] || '';
        if (counts[sh] !== undefined) counts[sh]++;
      });
      shiftKeys.forEach(k => {
        const req = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
        if (req && counts[k] < req) {
          violations.push({
            staffId: null, day: d, type: 'understaff',
            message: `🚨 ${d}日 ${gLabel}${k} が${counts[k]}人（必要${req}人）`,
            action:  '他の日のシフトを移動してください',
          });
        }
        // 責任者・総務は同じ時間帯に必要人数を超えて配置してはいけない
        if (SOLO_SHIFT_KEYS.includes(k) && req && counts[k] > req) {
          violations.push({
            staffId: null, day: d, type: 'resp-duplicate',
            message: `🚨 ${d}日 ${gLabel}${k} が${counts[k]}人（同じ時間帯に${k}は${req}人まで）`,
            action:  'どちらかを通常シフト（早/遅など）に変更してください',
          });
        }
      });

      // 責任者ヒエラルキー違反
      const respEarlyPerson = g.staff.find(s => (shifts[s.id] || {})[d] === '早責');
      if (respEarlyPerson) {
        const moreCapable = g.staff.filter(s => {
          const sh = (shifts[s.id] || {})[d] || '';
          return s.id !== respEarlyPerson.id &&
            isWork(sh) && isEarlyCategory(sh) && !isTraining(sh) &&
            (s.allowedShifts || []).includes('早責') &&
            getStaffPriority(s) < getStaffPriority(respEarlyPerson);
        });
        if (moreCapable.length > 0) {
          moreCapable.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));
          const shouldBe = moreCapable[0];
          violations.push({
            staffId: respEarlyPerson.id, day: d, type: 'hierarchy',
            message: `👑 ${d}日 早責ヒエラルキー違反: ${shouldBe.name}が早責であるべき`,
            action:  `${shouldBe.name}（${POSITION_TYPES[shouldBe.positionType]?.label || shouldBe.positionType}）と${respEarlyPerson.name}のシフトを入れ替えてください`,
          });
        }
      }
      const respLatePerson = g.staff.find(s => (shifts[s.id] || {})[d] === '遅責');
      if (respLatePerson) {
        const moreCapable = g.staff.filter(s => {
          const sh = (shifts[s.id] || {})[d] || '';
          return s.id !== respLatePerson.id &&
            isWork(sh) && isLate(sh) &&
            (s.allowedShifts || []).includes('遅責') &&
            getStaffPriority(s) < getStaffPriority(respLatePerson);
        });
        if (moreCapable.length > 0) {
          moreCapable.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));
          const shouldBe = moreCapable[0];
          violations.push({
            staffId: respLatePerson.id, day: d, type: 'hierarchy',
            message: `👑 ${d}日 遅責ヒエラルキー違反: ${shouldBe.name}が遅責であるべき`,
            action:  `${shouldBe.name}（${POSITION_TYPES[shouldBe.positionType]?.label || shouldBe.positionType}）と${respLatePerson.name}のシフトを入れ替えてください`,
          });
        }
      }
    }
  });

  return violations;
}

// ===== 特別日ロジック =====

function applySpecialDaysLogic(shifts, locked, staff, days) {
  const viceManagers = staff.filter(s => s.positionType === 'viceManager');
  for (let d = 1; d <= days; d++) {
    const specialType = AppState.specialDays[d];
    if (!specialType) continue;
    viceManagers.forEach(vm => {
      if (locked[vm.id][d]) return;
      shifts[vm.id][d] = specialType === 'replacement' ? '遅責' : '早責';
      locked[vm.id][d] = true;
    });
  }
}

// ===== AI 診断エンジン =====

/**
 * スタッフ構成・制約・違反を分析して診断レポートを返す
 * @returns {Array<{level:'error'|'warning'|'info'|'ok', title:string, detail:string, suggestion:string|null}>}
 */
function runAIDiagnosis() {
  const days      = getDaysInMonth(AppState.settings.targetMonth);
  const staff     = AppState.staff;
  const shiftKeys = getWorkShiftKeys();
  const results   = [];

  if (!staff.length || !days) {
    return [{ level: 'info', title: 'データ未入力', detail: 'スタッフまたは対象月が設定されていません。', suggestion: null }];
  }

  // ── 1〜3. 部門ごとの実現可能性・カバレッジ・個別制約 ─────────
  const groups = getDepartmentGroups(staff);
  let surplus = Infinity; // 全部門の中で最も厳しい余裕（違反傾向の原因判定に使用）

  groups.forEach(g => {
    const pfx    = groups.length > 1 ? `【${g.label}】` : '';
    const gStaff = g.staff;

    // ── 1. 公休数の数学的実現可能性 ──
    const dailyRequired   = shiftKeys.reduce((sum, k) => sum + (g.reqs[k] || 0), 0);
    const totalRequired   = dailyRequired * days;
    const totalPersonDays = gStaff.length * days;
    const totalMaxOff     = gStaff.reduce((sum, s) => sum + (s.maxOff || 0), 0);
    const availWork       = totalPersonDays - totalMaxOff;
    const gSurplus        = availWork - totalRequired;
    surplus = Math.min(surplus, gSurplus);

    if (gSurplus < 0) {
      const avgMaxOff      = (totalMaxOff / gStaff.length).toFixed(1);
      const feasibleMaxOff = Math.max(0, Math.floor((totalPersonDays - totalRequired) / gStaff.length));
      const neededStaff    = Math.ceil(totalRequired / Math.max(1, days - totalMaxOff / gStaff.length));
      const feasibleDaily  = Math.floor(availWork / days);
      results.push({
        level: 'error',
        title: `${pfx}公休数が数学的に実現不可能`,
        detail:
          `スタッフ数: ${gStaff.length}人 × ${days}日 = ${totalPersonDays}人日\n` +
          `公休目標合計: ${totalMaxOff}日（平均 ${avgMaxOff}日/人）\n` +
          `出勤余力: ${totalPersonDays} − ${totalMaxOff} = ${availWork}人日\n` +
          `必要出勤: ${dailyRequired}人/日 × ${days}日 = ${totalRequired}人日\n` +
          `不足: ${-gSurplus}人日 → 全員が目標公休を取ることは不可能です`,
        suggestion:
          `①スタッフを ${neededStaff} 人以上に増やす` +
          `　②1日の必要出勤人数を ${feasibleDaily} 人以下に下げる` +
          `　③各スタッフの最大公休を ${feasibleMaxOff} 日以下に設定する` +
          `　のいずれかが必要です。`,
      });
    } else if (dailyRequired > 0) {
      results.push({
        level: 'ok',
        title: `${pfx}公休数は数学的に実現可能`,
        detail:
          `出勤余力 ${availWork}人日 ≥ 必要 ${totalRequired}人日（余裕 +${gSurplus}人日/月）\n` +
          `スタッフ ${gStaff.length}人 で目標公休を全員に与えられます。`,
        suggestion: null,
      });
    } else if (g.key === 'cast') {
      results.push({
        level: 'warning',
        title: `${pfx}必要人数が未設定`,
        detail: `キャストの1日あたり必要人数が設定されていません。\n「② シフト種別」タブのキャスト列で設定してください。`,
        suggestion: 'キャスト必要人数を設定すると自動生成の対象になります。',
      });
    }

    // ── 1.5. 副店長の毎日カバレッジ実現可能性 ──
    const vms = gStaff.filter(s => s.positionType === 'viceManager');
    if (vms.length > 0) {
      // 副店長全員の公休合計が (副店長人数−1)×日数 を超えると、必ず全員休みの日が出る
      const vmTotalOff = vms.reduce((sum, s) => sum + (s.maxOff || 0), 0);
      const maxAllowableOff = (vms.length - 1) * days;
      if (vmTotalOff > maxAllowableOff) {
        results.push({
          level: 'error',
          title: `${pfx}副店長の毎日出勤が数学的に不可能`,
          detail:
            `副店長 ${vms.length}人 の公休合計 ${vmTotalOff}日 が上限 ${maxAllowableOff}日 を超えています。\n` +
            `（毎日1人出勤させるには、公休合計を (人数−1)×${days}日 = ${maxAllowableOff}日 以内にする必要があります）`,
          suggestion: vms.length === 1
            ? `副店長が1人だけだと公休0日でないと毎日出勤を満たせません。副店長をもう1人増やすことを推奨します。`
            : `副店長の公休日数を見直すか、副店長を増員してください。`,
        });
      } else {
        results.push({
          level: 'ok',
          title: `${pfx}副店長の毎日出勤は実現可能`,
          detail: `副店長 ${vms.length}人 で毎日1人以上の出勤を確保できます（公休合計 ${vmTotalOff}日 ≤ 上限 ${maxAllowableOff}日）。`,
          suggestion: null,
        });
      }
    }

    // ── 2. シフト種別カバレッジ ──
    shiftKeys.forEach(k => {
      const req     = g.reqs[k] || 0;
      if (!req) return;
      const capable = gStaff.filter(s => (s.allowedShifts || []).includes(k));
      if (capable.length < req) {
        results.push({
          level: 'error',
          title: `${pfx}「${k}」担当者が不足（${capable.length}人 / 必要${req}人）`,
          detail: `担当できるスタッフ: ${capable.map(s => s.name).join('、') || 'なし'}\n1日${req}人必要ですが担当者が足りません。`,
          suggestion: `「${k}」を担当できるスタッフを ${req - capable.length} 人以上増やしてください。`,
        });
      } else if (capable.length === req) {
        results.push({
          level: 'warning',
          title: `${pfx}「${k}」カバレッジが最小限（${capable.length}人 = 必要人数ちょうど）`,
          detail: `担当: ${capable.map(s => s.name).join('、')}\n誰か1人でも休むと必ず人員不足になります。`,
          suggestion: `「${k}」担当者をあと1人以上追加することを強く推奨します。`,
        });
      }
    });

    // ── 3. 個別スタッフの公休制限 ──
    gStaff.forEach(s => {
      // このスタッフがいないと必要人数を満たせないシフト
      const criticalShifts = shiftKeys.filter(k => {
        const req    = g.reqs[k] || 0;
        if (!req || !(s.allowedShifts || []).includes(k)) return false;
        const others = gStaff.filter(o => o.id !== s.id && (o.allowedShifts || []).includes(k)).length;
        return others < req;
      });
      if (!criticalShifts.length) return;

      const maxFeasibleOff = criticalShifts.reduce((min, k) => {
        const req    = g.reqs[k] || 0;
        const others = gStaff.filter(o => o.id !== s.id && (o.allowedShifts || []).includes(k)).length;
        return Math.min(min, others >= req ? days : 0);
      }, days);

      if (maxFeasibleOff < (s.maxOff || 0)) {
        const posLabel = POSITION_TYPES[s.positionType]?.label || s.positionType;
        results.push({
          level: 'warning',
          title: `${pfx}${s.name}（${posLabel}）の公休が理論上 0〜${maxFeasibleOff}日に制限`,
          detail:
            `シフト「${criticalShifts.join('・')}」の担当者が ${s.name} のみです。\n` +
            `代替者がいないため、これらのシフトが必要な日は必ず出勤が必要です。`,
          suggestion:
            `「${criticalShifts.join('・')}」を担当できるスタッフを追加するか、` +
            `${s.name} の最大公休を ${maxFeasibleOff} 日以下に変更してください。`,
        });
      }
    });
  });
  if (surplus === Infinity) surplus = 0;

  // ── 3.5. イベント整合性（希望休との衝突） ──────────────────
  (AppState.events || []).forEach(ev => {
    if (!ev || !ev.day) return;
    (ev.staffIds || []).forEach(sid => {
      const s = staff.find(m => m.id === sid);
      if (!s) return;
      const req = (AppState.requests[sid] || {})[ev.day];
      if (req && isOff(req)) {
        results.push({
          level: 'error',
          title: `行事「${ev.name || '行事'}」(${ev.day}日) と ${s.name} の希望休が衝突`,
          detail: `${s.name} は ${ev.day}日 に希望休（${req}）を入れていますが、行事の出勤対象です。`,
          suggestion: '希望休を別の日に移すか、行事の対象スタッフから外してください。',
        });
      }
    });
  });

  // ── 4. 現在の違反傾向分析 ─────────────────────────────────
  const violations = AppState.violations || [];
  if (violations.length === 0 && AppState.generated) {
    results.push({ level: 'ok', title: '違反ゼロ ✨', detail: 'すべての制約を満たすシフトが生成されました。', suggestion: null });
  } else if (violations.length > 0) {
    const cnt = {};
    violations.forEach(v => { cnt[v.type] = (cnt[v.type] || 0) + 1; });

    const typeLabels = {
      'consecutive':     '連勤超過',
      'late-early':      '遅→早インターバル不足',
      'category-switch': '連勤中の時間帯切替',
      'bad-rest':        '遅→休→早パターン',
      'single-work':     '単発出勤',
      'role-mismatch':   '担当外シフト',
      'pref-mismatch':   '早遅希望不一致',
      'off-count':       '公休数不足',
      'understaff':      '人員不足',
      'resp-duplicate':  '責任者・総務の重複',
      'hierarchy':       '責任者ヒエラルキー違反',
      'event-absent':    '行事日の休み',
      'vicemanager-absent': '副店長不在の日',
    };

    // 遅→休→早
    if (cnt['bad-rest']) {
      const cause = surplus < 0
        ? '公休数の数学的制約により、休みを最適な位置に配置できない日が発生'
        : 'シフトの並びの最適化が収束しきれていない';
      results.push({
        level: 'info',
        title: `遅→休→早 が ${cnt['bad-rest']} 件（${cause}）`,
        detail:
          `遅番の翌日に公休を挟んで早番が配置されると、生体リズム上好ましくありません。\n` +
          `原因: ${cause}。`,
        suggestion: '「シフト作成」を再実行するか、対象日を手動で遅番または公休に変更してください。',
      });
    }

    // 単発出勤
    if (cnt['single-work']) {
      const swVios  = violations.filter(v => v.type === 'single-work');
      const detail  = swVios.map(v => {
        const s = staff.find(m => m.id === v.staffId);
        return s ? `${s.name} ${v.day}日目` : '';
      }).filter(Boolean).join('、');
      results.push({
        level: 'warning',
        title: `単発出勤 ${cnt['single-work']} 件`,
        detail: `前後が両方休みの孤立した1日出勤があります。\n${detail}`,
        suggestion: '「シフト作成」を再実行するか、対象日の前後どちらかの休みを別の日に移動して出勤日を連続させてください。',
      });
    }

    // 公休数不足
    if (cnt['off-count']) {
      const offVios = violations.filter(v => v.type === 'off-count');
      const detail  = offVios.map(v => {
        const s = staff.find(m => m.id === v.staffId);
        return s ? `${s.name}: ${v.message.replace(/🚨\s*/, '')}` : '';
      }).filter(Boolean).join('\n');
      results.push({
        level: surplus < 0 ? 'error' : 'warning',
        title: `公休数不足 ${cnt['off-count']} 件`,
        detail: detail + (surplus < 0 ? '\n\n→ 数学的制約（上記参照）が主因です。' : ''),
        suggestion: surplus < 0
          ? 'スタッフ増員・必要人数削減・最大公休日数の見直しが根本的な解決策です。'
          : '再度「シフト作成」を実行するか、対象スタッフの出勤シフトを1〜2日休みに変更してください。',
      });
    }

    // 人員不足
    if (cnt['understaff']) {
      results.push({
        level: 'warning',
        title: `人員不足 ${cnt['understaff']} 件`,
        detail: '特定のシフト種別で必要人数を確保できない日があります。',
        suggestion: '担当者が少ないシフト種別（上記カバレッジ診断参照）に担当者を追加してください。',
      });
    }

    // 副店長不在の日
    if (cnt['vicemanager-absent']) {
      const vmVios = violations.filter(v => v.type === 'vicemanager-absent');
      const days   = vmVios.map(v => `${v.day}日`).join('、');
      results.push({
        level: 'error',
        title: `副店長が誰も出勤していない日 ${cnt['vicemanager-absent']} 件`,
        detail: `次の日は副店長が全員休みです: ${days}\n毎日少なくとも1人の副店長が出勤している必要があります。`,
        suggestion: '副店長の公休日が重ならないよう調整するか、「シフト作成」を再実行してください。副店長が1人しかいない場合は増員が必要です。',
      });
    }

    // 行事日の休み
    if (cnt['event-absent']) {
      const evVios = violations.filter(v => v.type === 'event-absent');
      const detail = evVios.map(v => {
        const s = staff.find(m => m.id === v.staffId);
        return s ? `${s.name} ${v.day}日: ${v.message.replace(/🚨\s*/, '')}` : '';
      }).filter(Boolean).join('\n');
      results.push({
        level: 'error',
        title: `行事日に対象スタッフが休み ${cnt['event-absent']} 件`,
        detail,
        suggestion: '「シフト作成」を再実行するか、該当日のシフトを手動で出勤に変更してください。',
      });
    }

    // 責任者・総務の重複
    if (cnt['resp-duplicate']) {
      const rdVios  = violations.filter(v => v.type === 'resp-duplicate');
      const detail  = rdVios.map(v => v.message.replace(/🚨\s*/, '')).join('\n');
      results.push({
        level: 'error',
        title: `責任者・総務の重複 ${cnt['resp-duplicate']} 件`,
        detail: `同じ時間帯に責任者・総務（早責/遅責/早総/遅総）が必要人数を超えて配置されています。\n${detail}`,
        suggestion: '「シフト作成」を再実行してください。どちらか一方を通常シフト（早/遅）に変更するのも有効です。',
      });
    }

    // 責任者ヒエラルキー
    if (cnt['hierarchy']) {
      results.push({
        level: 'warning',
        title: `責任者ヒエラルキー違反 ${cnt['hierarchy']} 件`,
        detail: '上位役職者が出勤しているのに、下位者が責任者シフトに就いている日があります。',
        suggestion: '再度「シフト作成」を実行してください。上位者が休みの日のみ下位者が責任者を担います。',
      });
    }

    // 連勤超過
    if (cnt['consecutive']) {
      results.push({
        level: 'warning',
        title: `連勤超過 ${cnt['consecutive']} 件`,
        detail: `設定上限（${AppState.settings.maxConsecutive}日）を超える連続勤務が残存しています。`,
        suggestion: '「シフト作成」を再実行するか、対象スタッフの連続出勤区間に休みを手動挿入してください。',
      });
    }
  }

  // ── 5. 公休余剰の可視化（生成済みシフトがある場合） ──────────
  if (AppState.generated && AppState.shifts) {
    const surplusItems = [];
    let totalSurplus = 0;
    staff.forEach(s => {
      const offCount = countOff(AppState.shifts, s, days);
      const target   = s.maxOff || 0;
      const excess   = offCount - target;
      if (excess > 0) {
        surplusItems.push({ name: s.name, offCount, target, excess });
        totalSurplus += excess;
      }
    });

    if (surplusItems.length > 0) {
      // 公休不足スタッフを suggestion 文に反映
      const shortNames = (AppState.violations || [])
        .filter(v => v.type === 'off-count')
        .map(v => { const m = staff.find(s => s.id === v.staffId); return m ? m.name : null; })
        .filter(Boolean);
      const shortHint = shortNames.length
        ? `（特に ${shortNames.join('・')} の公休不足と合わせて解消できます）`
        : '';
      results.push({
        level: 'warning',
        title: `公休余剰 合計 +${totalSurplus}コマ（${surplusItems.length}名、約${totalSurplus * 8}時間分の労働減）`,
        detail: surplusItems
          .sort((a, b) => b.excess - a.excess)
          .map(r => `${r.name}: 公休 ${r.offCount}日（目標 ${r.target}日、余剰 +${r.excess}日 ≒ ${r.excess * 8}時間）`)
          .join('\n'),
        suggestion:
          `余剰スタッフの休みを減らして公休不足スタッフの休みを増やすと全体バランスが改善します${shortHint}。` +
          `「シフト作成」を再実行すると自動的に再配分されます。`,
      });
    } else {
      results.push({
        level: 'ok',
        title: '公休余剰なし',
        detail: 'すべてのスタッフが目標公休日数ちょうど（または不足）に収まっています。',
        suggestion: null,
      });
    }
  }

  return results;
}
