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
let _optStaff = null, _optReqs = null, _optDailyReqs = null, _optWeekdayReqs = null;
function optStaff()      { return _optStaff      || AppState.staff; }
function optReqs()       { return _optReqs       || AppState.roleRequirements; }
function optDailyReqs()  { return _optDailyReqs  || AppState.dailyRequirements || {}; }
function optWeekdayReqs(){ return _optWeekdayReqs || AppState.weekdayRequirements || {}; }
// 必要人数（日付上書き → 曜日別 → デフォルト req の順で参照）
function optDayReq(sh, d) { return getDayReq(optReqs(), optDailyReqs(), sh, d, optWeekdayReqs()); }

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
      _optWeekdayReqs = g.weekdayReqs;
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
    _optWeekdayReqs = null;
  }

  AppState.shifts     = mergedShifts;
  markSurplusRest(AppState.shifts); // 公休を目標数ちょうどにし、余った休みを「余」に振り分ける
  // 最終保証: 部門ごとに人員不足を全体盤面で潰す（実ロックのみ尊重）
  groups.forEach(g => forceFillUnderstaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
  // 強制フィルが生んだ単発出勤・切替を掃除（違反件数が減る手だけ採用＝人員不足は増えない）
  violationPolish(AppState.shifts, 4);
  groups.forEach(g => forceFillUnderstaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
  // なお残る不足は二部マッチングで確実に埋める（多段の玉突きも解く）
  groups.forEach(g => guaranteeDayStaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
  // 単発出勤（🔴）を人数を変えずに解消
  groups.forEach(g => eliminateSingleWork(AppState.shifts, g.staff, g.reqs, g.dailyReqs));
  // 最後に、人数を変えない同日役割入替でリズム違反だけを掃除（人員不足は増えない）
  fixLockedBoundaryLates(AppState.shifts);
  mustFirstSwapPolish(AppState.shifts, 10);
  AppState.violations = sameDaySwapPolish(AppState.shifts, 12);
  AppState.generated  = true;

  // restPairBonus でスコアが負になり得るため、成功判定は違反件数で行う
  return { score: totalScore, violations: AppState.violations, success: AppState.violations.length === 0 };
}

/**
 * 公休を目標数（maxOff）ちょうどに整え、超過分の休みを「余」（余剰）に振り替える。
 * - 希望休・固定で入れた公休は必ず公休のまま残す（意図した休みのため）
 * - 有給（有）はそのまま（別枠）
 * これにより「公休は設定数を全部消化」「余った人員は余で可視化」を実現する。
 */
function markSurplusRest(shifts) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  staff.forEach(s => {
    if (!shifts[s.id]) return;
    const quota = s.maxOff || 0;
    let lockedPublic = 0;
    const freePublicDays = [];
    for (let d = 1; d <= days; d++) {
      const sh = shifts[s.id][d] || '';
      if (!isPublicOff(sh)) continue; // 公休系のみ対象（有給・余は対象外）
      const locked = isPublicOff((AppState.requests[s.id]    || {})[d]) ||
                     isPublicOff((AppState.fixedShifts[s.id] || {})[d]);
      if (locked) lockedPublic++;
      else freePublicDays.push(d);
    }
    // 目標公休数のうち、固定分を除いた残りだけを公休として残し、超過分は「余」にする。
    // 「余」は月末に固まらないよう、対象日を月内に均等に散らす。
    const N       = freePublicDays.length;
    const keep    = Math.max(0, quota - lockedPublic);
    const convert = Math.max(0, N - keep); // 余にする日数
    if (convert > 0) {
      const surplusIdx = new Set();
      for (let i = 0; i < convert; i++) {
        surplusIdx.add(Math.min(N - 1, Math.floor((i + 0.5) * N / convert)));
      }
      // 端数で重複したら前から補充してちょうど convert 個にする
      let j = 0;
      while (surplusIdx.size < convert && j < N) { surplusIdx.add(j); j++; }
      freePublicDays.forEach((d, idx) => {
        if (surplusIdx.has(idx)) shifts[s.id][d] = '余';
      });
    }
  });
}

/**
 * エラー箇所だけを再最適化する「修復」エントリ
 * - 現在の AppState.shifts を種（seed）にする
 * - 違反に関係するセル（＋前後日）だけロックを外し、それ以外は固定して動かさない
 * - 違反件数が減った時だけ採用し、悪化した場合は元に戻す（絶対に悪くしない）
 */
async function repairSchedule(progressCallback) {
  const origShifts     = deepCopyShifts(AppState.shifts || {});
  const origViolations = checkViolations(origShifts);
  if (origViolations.length === 0) {
    AppState.violations = origViolations;
    return { score: 0, violations: [], success: true, improved: false, before: 0, after: 0 };
  }

  const days     = getDaysInMonth(AppState.settings.targetMonth);
  const groups   = getDepartmentGroups(AppState.staff);
  const MAX_PASS = 8;          // 改善が止まるまで最大8回
  const RADIUS   = [1, 2, 3];  // 段階レベルごとの前後日ウィンドウ
  const FULL_LEVEL = 3;        // レベル3以上は部門全体を解放して全面再最適化

  // 現在の最良（seed）から1パス修復する内部関数。level が上がるほど動かす範囲を広げる。
  const onePass = async (seedShifts, seedViolations, level, passLabel) => {
    const merged = deepCopyShifts(seedShifts);
    const radius = RADIUS[Math.min(level, RADIUS.length - 1)];
    const full   = level >= FULL_LEVEL;
    try {
      for (let gi = 0; gi < groups.length; gi++) {
        const g        = groups[gi];
        const groupIds = new Set(g.staff.map(s => s.id));
        const cells    = new Set();
        const staffAll = new Set();
        const addCell  = (sid, d) => {
          for (let dd = d - radius; dd <= d + radius; dd++) {
            if (dd >= 1 && dd <= days) cells.add(sid + ':' + dd);
          }
        };
        if (full) {
          // 全面再最適化: 部門の全スタッフを解放（希望休・固定は optimizeGroupSchedule 側で保持）
          g.staff.forEach(s => staffAll.add(s.id));
        } else {
          seedViolations.forEach(v => {
            if (v.staffId && groupIds.has(v.staffId)) {
              if (v.day === 0) staffAll.add(v.staffId);
              else addCell(v.staffId, v.day);
            } else if (!v.staffId && v.day >= 1) {
              g.staff.forEach(s => addCell(s.id, v.day));
            }
          });
        }
        if (cells.size === 0 && staffAll.size === 0) continue;

        _optStaff = g.staff; _optReqs = g.reqs; _optDailyReqs = g.dailyReqs; _optWeekdayReqs = g.weekdayReqs;
        const groupProgress = (pct, msg) => {
          const mapped = Math.floor((gi * 100 + pct) / groups.length);
          progressCallback && progressCallback(mapped, `${passLabel} ` + msg);
        };
        const res = await optimizeGroupSchedule(groupProgress, { seedShifts, cells, staffAll });
        Object.assign(merged, res.shifts);
      }
    } finally {
      _optStaff = null; _optReqs = null; _optDailyReqs = null; _optWeekdayReqs = null;
    }
    markSurplusRest(merged); // 修復後も公休ちょうど＋余に整える
    // 最終保証: 修復後も人員不足を全体盤面で潰す（実ロックのみ尊重）
    groups.forEach(g => forceFillUnderstaffingReal(merged, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
    groups.forEach(g => guaranteeDayStaffingReal(merged, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
    return { shifts: merged, violations: checkViolations(merged) };
  };

  // 「焼きなまし修復 ⇄ 違反狙い撃ち仕上げ」を最大2周まで往復して粘る
  let bestShifts     = origShifts;
  let bestViolations = origViolations;
  const scope = ['狭い範囲', 'やや広い範囲', '広い範囲', '全面見直し'];
  for (let cycle = 0; cycle < 2 && bestViolations.length > 0; cycle++) {
    // フェーズ1: 焼きなまし修復（停滞したら範囲を段階的に拡大）
    let level = 0;
    for (let pass = 0; pass < MAX_PASS && bestViolations.length > 0; pass++) {
      const label = `修復中 ${pass + 1}回目（${scope[Math.min(level, 3)]}）｜ 残りエラー ${bestViolations.length}件 →`;
      const r = await onePass(bestShifts, bestViolations, level, label);
      if (r.violations.length < bestViolations.length) {
        bestShifts = r.shifts; bestViolations = r.violations;
        level = 0; // 改善したら再び狭い範囲（安く速い）に戻す
      } else {
        level++;                    // 停滞 → 範囲を広げて再挑戦
        if (level > FULL_LEVEL) break; // 全面再最適化でも減らなければ終了
      }
      progressCallback && progressCallback(
        Math.min(99, Math.floor(((pass + 1) / MAX_PASS) * 100)),
        `修復中… 残りエラー ${bestViolations.length}件（${pass + 1}回目まで完了）`);
    }

    // フェーズ2: 違反狙い撃ち仕上げ（1マス置換・2日交換・同日2人交換）
    if (bestViolations.length > 0) {
      progressCallback && progressCallback(99, `最終仕上げ（違反狙い撃ち）… 残り ${bestViolations.length}件`);
      await sleep(0);
      const beforePolish = bestViolations.length;
      bestViolations = violationPolish(bestShifts, 4);
      // 仕上げで公休が目標超過になった分を「余」に整える（悪化したら戻す）
      const preSurplus = deepCopyShifts(bestShifts);
      markSurplusRest(bestShifts);
      const nv = checkViolations(bestShifts);
      if (nv.length <= bestViolations.length) bestViolations = nv;
      else { for (const sid in preSurplus) bestShifts[sid] = preSurplus[sid]; }
      // 仕上げで改善がなければ、もう1周しても同じなので終了
      if (bestViolations.length >= beforePolish) break;
    }
  }
  progressCallback && progressCallback(100, `修復完了 — 残りエラー ${bestViolations.length}件`);

  AppState.generated = true;
  const improved   = bestViolations.length < origViolations.length;
  const finalShifts = improved ? bestShifts : origShifts;
  // 最後の一手（無条件）: 採用する盤面の人員不足を必ず潰す。修復の採否が
  // 「違反総数」基準のため、総数が少ない代わりに不足の残る案を選びうるのを補償する。
  groups.forEach(g => guaranteeDayStaffingReal(finalShifts, g.staff, g.reqs, g.dailyReqs, g.weekdayReqs));
  groups.forEach(g => eliminateSingleWork(finalShifts, g.staff, g.reqs, g.dailyReqs));
  // 人数を変えない同日役割入替でリズム違反を掃除（人員不足は増えない）
  fixLockedBoundaryLates(finalShifts);
  mustFirstSwapPolish(finalShifts, 10);
  const finalViolations = sameDaySwapPolish(finalShifts, 12);
  AppState.shifts     = finalShifts;
  AppState.violations = finalViolations;
  return { score: finalViolations.length, violations: finalViolations,
           success: finalViolations.length === 0, improved: finalViolations.length < origViolations.length,
           before: origViolations.length, after: finalViolations.length };
}

/**
 * 各違反について「1手で直る具体的な修正案」を探して返す（適用はしない）。
 * 修正ガイド（誰でも直せるモード）用。
 * @returns {Array<{v, desc, move, after} | {v, reason}>}
 */
function suggestViolationFixes(maxItems) {
  const staff  = AppState.staff || [];
  const days   = getDaysInMonth(AppState.settings.targetMonth);
  const shifts = AppState.shifts || {};
  const nameOf = id => (staff.find(s => s.id === id) || {}).name || '全体';

  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    candsOf[s.id] = base.concat(['休']);
  });

  const baseVios = checkViolations(shifts);
  const VPRI = { 'understaff': 0, 'skill-late': 1, 'consecutive': 2, 'single-work': 3, 'hierarchy': 4, 'resp-duplicate': 4 };
  const ordered = baseVios.slice()
    .sort((a, b) => ((VPRI[a.type] ?? 9) - (VPRI[b.type] ?? 9)))
    .slice(0, maxItems || 10);

  const out = [];
  for (const v of ordered) {
    if (v.day < 1) {
      out.push({ v, reason: '公休数の過不足は1手では直せません。「🛠 エラーを自動修正」をお試しください。' });
      continue;
    }
    let found = null;
    const tryEval = (apply, undo, desc, move) => {
      if (found) return;
      apply();
      const nv = checkViolations(shifts);
      if (nv.length < baseVios.length) found = { desc, move, after: nv.length };
      undo();
    };
    const targets = v.staffId ? staff.filter(s => s.id === v.staffId) : staff;

    // ① 1マス置換（違反日±2）
    for (const s of targets) {
      if (found) break;
      for (let d = Math.max(1, v.day - 2); d <= Math.min(days, v.day + 2) && !found; d++) {
        if (!_polishMovable(shifts, s.id, d)) continue;
        const cur = shifts[s.id][d] || '';
        for (const c of candsOf[s.id]) {
          if (found || c === cur) continue;
          tryEval(() => { shifts[s.id][d] = c; }, () => { shifts[s.id][d] = cur; },
            `${nameOf(s.id)}さんの ${d}日 を「${cur || '空'}」→「${c}」に変更`,
            { kind: 'set', sid: s.id, d, to: c });
        }
      }
    }
    // ② 同一人物の2日交換
    for (const s of targets) {
      if (found) break;
      for (let d1 = Math.max(1, v.day - 1); d1 <= Math.min(days, v.day + 1) && !found; d1++) {
        if (!_polishMovable(shifts, s.id, d1)) continue;
        for (let d2 = 1; d2 <= days && !found; d2++) {
          if (d2 === d1 || !_polishMovable(shifts, s.id, d2)) continue;
          const a = shifts[s.id][d1] || '', b = shifts[s.id][d2] || '';
          if (a === b) continue;
          tryEval(
            () => { shifts[s.id][d1] = b; shifts[s.id][d2] = a; },
            () => { shifts[s.id][d1] = a; shifts[s.id][d2] = b; },
            `${nameOf(s.id)}さんの ${d1}日「${a || '空'}」と ${d2}日「${b || '空'}」を入れ替え`,
            { kind: 'swapDays', sid: s.id, d1, d2 });
        }
      }
    }
    // ③ 同日2人交換（連勤は連勤ブロック全体）
    const swapFrom = v.type === 'consecutive' ? Math.max(1, v.day - 5) : Math.max(1, v.day - 1);
    for (let d = swapFrom; d <= Math.min(days, v.day + 1) && !found; d++) {
      for (let i = 0; i < staff.length && !found; i++) {
        const A = staff[i];
        if (!_polishMovable(shifts, A.id, d)) continue;
        for (let j = i + 1; j < staff.length && !found; j++) {
          const B = staff[j];
          if (!_polishMovable(shifts, B.id, d)) continue;
          const va = shifts[A.id][d] || '', vb = shifts[B.id][d] || '';
          if (va === vb) continue;
          const aOk = !isWork(vb) || candsOf[A.id].includes(vb);
          const bOk = !isWork(va) || candsOf[B.id].includes(va);
          if (!aOk || !bOk) continue;
          tryEval(
            () => { shifts[A.id][d] = vb; shifts[B.id][d] = va; },
            () => { shifts[A.id][d] = va; shifts[B.id][d] = vb; },
            `${d}日: ${nameOf(A.id)}さん「${va || '空'}」と ${nameOf(B.id)}さん「${vb || '空'}」を交代`,
            { kind: 'swapStaff', aId: A.id, bId: B.id, d });
        }
      }
    }

    // ④ 2日同時の2人交換（同じ違反が2日連続で絡み合っている場合用）
    for (const d0 of [v.day - 1, v.day]) {
      if (found || d0 < 1 || d0 + 1 > days) continue;
      for (let i = 0; i < staff.length && !found; i++) {
        const A = staff[i];
        if (!_polishMovable(shifts, A.id, d0) || !_polishMovable(shifts, A.id, d0 + 1)) continue;
        for (let j = i + 1; j < staff.length && !found; j++) {
          const B = staff[j];
          if (!_polishMovable(shifts, B.id, d0) || !_polishMovable(shifts, B.id, d0 + 1)) continue;
          const a1 = shifts[A.id][d0] || '',     b1 = shifts[B.id][d0] || '';
          const a2 = shifts[A.id][d0 + 1] || '', b2 = shifts[B.id][d0 + 1] || '';
          if (a1 === b1 && a2 === b2) continue;
          const ok = (!isWork(b1) || candsOf[A.id].includes(b1)) &&
                     (!isWork(a1) || candsOf[B.id].includes(a1)) &&
                     (!isWork(b2) || candsOf[A.id].includes(b2)) &&
                     (!isWork(a2) || candsOf[B.id].includes(a2));
          if (!ok) continue;
          tryEval(
            () => { shifts[A.id][d0] = b1; shifts[B.id][d0] = a1;
                    shifts[A.id][d0 + 1] = b2; shifts[B.id][d0 + 1] = a2; },
            () => { shifts[A.id][d0] = a1; shifts[B.id][d0] = b1;
                    shifts[A.id][d0 + 1] = a2; shifts[B.id][d0 + 1] = b2; },
            `${d0}日と${d0 + 1}日: ${nameOf(A.id)}さんと${nameOf(B.id)}さんのシフトを両日とも交代`,
            { kind: 'swapStaff2', aId: A.id, bId: B.id, d1: d0, d2: d0 + 1 });
        }
      }
    }

    if (found) out.push({ v, desc: found.desc, move: found.move, after: found.after });
    else out.push({ v, reason: '1手では直せません（周囲が🔒固定・希望休で動かせない可能性）。「🛠 エラーを自動修正」を試すか、この日周辺の固定・希望休を見直してください。' });
  }
  return out;
}

/** 修復仕上げ用: そのセルが動かせるか（希望休・固定・有給は不可） */
function _polishMovable(shifts, sid, d) {
  const req = (AppState.requests[sid] || {})[d];
  if (req && (isOff(req) || isWork(req))) return false;
  if ((AppState.fixedShifts[sid] || {})[d]) return false;
  if ((shifts[sid] || {})[d] === '有') return false; // 有給は消さない
  return true;
}

/**
 * 違反件数そのものを目的関数にした狙い撃ち探索。
 * 各違反の周辺で ①1マス置換 ②同一人物の2日交換 ③同日2人交換 を試し、
 * checkViolations の件数が減る手だけ採用する（悪化ゼロ保証）。
 * スコア関数では拾いきれない「2手で直る」違反を確実に削る。
 * @returns {Array} 仕上げ後の violations
 */
/**
 * 人数を一切変えずにリズム違反だけを削る仕上げ。
 * 「同じ日に働く2人の役割を入れ替える」手だけを使うため、各役職の人数は
 * 常に不変 ＝ 人員不足・スキル不足を絶対に増やさない。人員不足の最終保証の
 * 後に安全に走らせて、切替（連勤中の時間帯切替）・遅→休→早 などを掃除する。
 * @returns {Array} 掃除後の violations
 */
// 🔴絶対NG扱いの違反タイプ（表示側の分類と揃える）。単発出勤も含む。
const MUST_TYPES_OPT = new Set([
  'understaff', 'skill-late', 'consecutive', 'resp-duplicate', 'hierarchy',
  'vicemanager-absent', 'single-work', 'pref-mismatch', 'role-mismatch',
  'event-absent', 'night-after-work',
]);
function countMustVios(vios) { return vios.filter(v => MUST_TYPES_OPT.has(v.type)).length; }

/**
 * 🔴リズム違反（単発出勤・連勤超過）を、人数を変えずに解消する専用処理。
 * 違反者 X をある1日休ませ、その枠を「同じ日に休んでいて前後どちらかで働いている」
 * 同僚 Y に渡す。役職の人数は不変なので人員不足は増えない。
 *  - 単発出勤: 孤立した勤務日(その日)で X を休ませる
 *  - 連勤超過: 連勤ブロックの途中の日で X を休ませて連勤を断ち切る
 * 🔴違反が減る入替だけを採用する。
 * @returns {Array} 処理後の violations
 */
function eliminateSingleWork(shifts, staffList, reqs, dailyReqs) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const allowedOf = {};
  staffList.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    allowedOf[s.id] = base;
  });
  const idset = new Set(staffList.map(s => s.id));
  // その日に X を休ませ、枠を休んでいる同僚 Y に渡す（人数不変で🔴が減れば採用）
  const tryRestAndHandoff = (X, d, curMust) => {
    if (!_polishMovable(shifts, X, d) || !isWork(shifts[X][d])) return null;
    const role = shifts[X][d];
    // 前後どちらかで働いている人を優先（渡した先が新たな単発出勤にならない）
    const cands = staffList
      .filter(Y => Y.id !== X && _polishMovable(shifts, Y.id, d) &&
                   !isWork(shifts[Y.id][d]) && (allowedOf[Y.id] || []).includes(role))
      .sort((a, b) => {
        const adj = s => ((d > 1 && isWork(shifts[s.id][d - 1])) ||
                          (d < days && isWork(shifts[s.id][d + 1]))) ? 0 : 1;
        return adj(a) - adj(b);
      });
    for (const Y of cands) {
      const bx = shifts[X][d], by = shifts[Y.id][d];
      shifts[X][d] = '休'; shifts[Y.id][d] = role;
      const nv = checkViolations(shifts), nm = countMustVios(nv);
      if (nm < curMust.must) return { nv, nm }; // 🔴が確実に減る手だけ採用
      shifts[X][d] = bx; shifts[Y.id][d] = by;                     // 改善しなければ戻す
    }
    return null;
  };
  let vios = checkViolations(shifts);
  let must = countMustVios(vios);
  for (let guard = 0; guard < 16; guard++) {
    let changed = false;
    const targets = vios.filter(v =>
      (v.type === 'single-work' || v.type === 'consecutive') &&
      v.staffId && idset.has(v.staffId));
    for (const v of targets) {
      const X = v.staffId;
      // 休ませる候補日: 単発はその日、連勤はブロック途中、切替/遅→早は当日と前日
      let candDays;
      if (v.type === 'single-work') {
        candDays = [v.day];
      } else if (v.type === 'consecutive') {
        let a = v.day; while (a > 1 && isWork(shifts[X][a - 1])) a--;
        let b = v.day; while (b < days && isWork(shifts[X][b + 1])) b++;
        candDays = [];
        for (let d = a + 1; d <= b; d++) candDays.push(d); // 先頭は避け、途中で断つ
      } else {
        candDays = [v.day - 1, v.day].filter(d => d >= 1);
      }
      for (const d of candDays) {
        const r = tryRestAndHandoff(X, d, { must, total: vios.length });
        if (r) { vios = r.nv; must = r.nm; changed = true; break; }
      }
      // 単発出勤は逆方向も試す: 隣の日に X の出勤を伸ばして連勤化する
      // （X がその日働く代わりに、働いていた Y を休ませる。人数は不変）
      if (!changed && v.type === 'single-work') {
        for (const d of [v.day - 1, v.day + 1]) {
          if (d < 1 || d > days) continue;
          if (!_polishMovable(shifts, X, d) || isWork(shifts[X][d])) continue;
          for (const Y of staffList) {
            if (Y.id === X || !_polishMovable(shifts, Y.id, d)) continue;
            const role = shifts[Y.id][d];
            if (!isWork(role) || !(allowedOf[X] || []).includes(role)) continue;
            const bx = shifts[X][d], by = shifts[Y.id][d];
            shifts[X][d] = role; shifts[Y.id][d] = '休';
            const nv = checkViolations(shifts), nm = countMustVios(nv);
            if (nm < must) { vios = nv; must = nm; changed = true; break; }
            shifts[X][d] = bx; shifts[Y.id][d] = by;
          }
          if (changed) break;
        }
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  return vios;
}

/**
 * 固定セル境界の遅番を直す専用パス。
 * 「翌日が固定の研修/早番系」なのに当日が遅番だと、遅→研/遅→早のエラーが
 * 必ず出る。当日の遅番を、同じ日に早番系で働く人と役割交換して解消する。
 * 同日の勤務者同士の交換なので各役職の人数は不変（🔴に影響しない）。
 * 各境界は1回だけ処理するためループしない。
 * @returns {Array} 処理後の violations
 */
function fixLockedBoundaryLates(shifts) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    candsOf[s.id] = base;
  });
  const isLockedCell = (sid, d) =>
    !!(AppState.fixedShifts[sid] || {})[d] ||
    (() => { const rq = (AppState.requests[sid] || {})[d]; return rq && (isOff(rq) || isWork(rq)); })();

  let vios = checkViolations(shifts);
  for (const s of staff) {
    for (let d = 1; d < days; d++) {
      const nx = shifts[s.id][d + 1];
      // 翌日が「固定の早番系（研修含む）」で、当日が動かせる遅番のとき
      if (!isLockedCell(s.id, d + 1) || !isWork(nx) || !isEarlyCategory(nx)) continue;
      const cur = shifts[s.id][d];
      if (!isLate(cur) || !_polishMovable(shifts, s.id, d)) continue;
      // 同じ日に早番系で働く人と役割交換
      for (const p of staff) {
        if (p.id === s.id || !_polishMovable(shifts, p.id, d)) continue;
        const pv = shifts[p.id][d];
        if (!isWork(pv) || !isEarlyCategory(pv) || isTraining(pv)) continue;
        if (!candsOf[s.id].includes(pv) || !candsOf[p.id].includes(cur)) continue;
        shifts[s.id][d] = pv; shifts[p.id][d] = cur;
        const nv = checkViolations(shifts);
        if (nv.length < vios.length) { vios = nv; break; }
        shifts[s.id][d] = cur; shifts[p.id][d] = pv; // 減らなければ戻す
      }
    }
  }
  return vios;
}

/**
 * 🔴絶対NGを最優先で消す同日役割交換パス。
 * 同じ日に働く2人の役割を交換する（人数不変）。🔴が1件でも減るなら、
 * 代わりに🟡（切替・リズム）が増えても採用する。
 * 例: 営業スキルが遅番に足りない日、早番にいる営業持ちと遅番の非保有者を交換。
 * @returns {Array} 処理後の violations
 */
function mustFirstSwapPolish(shifts, maxRounds) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    candsOf[s.id] = base;
  });
  let vios = checkViolations(shifts);
  let must = countMustVios(vios);
  for (let round = 0; round < (maxRounds || 10) && must > 0; round++) {
    let changed = false;
    const mustVios = vios.filter(v => MUST_TYPES_OPT.has(v.type) && v.day >= 1);
    for (const v of mustVios) {
      for (let d = Math.max(1, v.day - 1); d <= Math.min(days, v.day + 1) && !changed; d++) {
        for (let i = 0; i < staff.length && !changed; i++) {
          const A = staff[i];
          if (!_polishMovable(shifts, A.id, d)) continue;
          const va = shifts[A.id][d];
          if (!isWork(va)) continue;
          for (let j = i + 1; j < staff.length; j++) {
            const B = staff[j];
            if (!_polishMovable(shifts, B.id, d)) continue;
            const vb = shifts[B.id][d];
            if (!isWork(vb) || va === vb) continue;
            if (!candsOf[A.id].includes(vb) || !candsOf[B.id].includes(va)) continue;
            shifts[A.id][d] = vb; shifts[B.id][d] = va;
            const nv = checkViolations(shifts), nm = countMustVios(nv);
            if (nm < must) { vios = nv; must = nm; changed = true; break; }
            shifts[A.id][d] = va; shifts[B.id][d] = vb;
          }
        }
      }
      // スキル不足: 保有者が全員働いていても足りない日は、休んでいる保有者に
      // 非保有者の枠を引き継がせ、非保有者を休ませる（人数不変）
      if (!changed && v.type === 'skill-late') {
        const d = v.day;
        const sk = (AppState.skills || []).find(k => v.message && v.message.includes(k.name));
        const skName = sk ? sk.name : null;
        const target = (sk && sk.target) === 'early' ? 'early' : 'late';
        const inBand = sh => target === 'early' ? (isEarlyCategory(sh) && !isTraining(sh)) : isLate(sh);
        if (skName) {
          const holders = staff.filter(s => (s.skills || []).includes(skName) &&
            _polishMovable(shifts, s.id, d) && !isWork(shifts[s.id][d]));
          const nonHolders = staff.filter(s => !(s.skills || []).includes(skName) &&
            _polishMovable(shifts, s.id, d) && isWork(shifts[s.id][d]) && inBand(shifts[s.id][d]));
          for (const H of holders) {
            for (const N of nonHolders) {
              const role = shifts[N.id][d];
              if (!candsOf[H.id].includes(role)) continue;
              const bh = shifts[H.id][d], bn = shifts[N.id][d];
              shifts[H.id][d] = role; shifts[N.id][d] = '休';
              const nv = checkViolations(shifts), nm = countMustVios(nv);
              if (nm < must) { vios = nv; must = nm; changed = true; break; }
              shifts[H.id][d] = bh; shifts[N.id][d] = bn;
            }
            if (changed) break;
          }
        }
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  return vios;
}

function sameDaySwapPolish(shifts, maxRounds) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    candsOf[s.id] = base;
  });
  let vios = checkViolations(shifts);
  for (let round = 0; round < maxRounds && vios.length > 0; round++) {
    let improved = false;
    // 違反日の周辺で、働く2人の役割を交換して違反件数が減るなら採用
    const daysToScan = new Set();
    vios.forEach(v => { for (let dd = v.day - 1; dd <= v.day + 1; dd++) if (dd >= 1 && dd <= days) daysToScan.add(dd); });
    for (const d of daysToScan) {
      for (let i = 0; i < staff.length && !improved; i++) {
        const A = staff[i];
        if (!_polishMovable(shifts, A.id, d)) continue;
        const va = shifts[A.id][d];
        if (!isWork(va)) continue;
        for (let j = i + 1; j < staff.length; j++) {
          const B = staff[j];
          if (!_polishMovable(shifts, B.id, d)) continue;
          const vb = shifts[B.id][d];
          if (!isWork(vb) || va === vb) continue;
          if (!candsOf[A.id].includes(vb) || !candsOf[B.id].includes(va)) continue;
          shifts[A.id][d] = vb; shifts[B.id][d] = va;
          const nv = checkViolations(shifts);
          if (nv.length < vios.length) { vios = nv; improved = true; break; }
          shifts[A.id][d] = va; shifts[B.id][d] = vb; // 戻す
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return vios;
}

function violationPolish(shifts, maxRounds) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);

  // 各スタッフの置換候補（研修除外・prefs適合＋休）
  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    candsOf[s.id] = base.concat(['休']);
  });
  // スコア計算用の allowedShifts（休を除く）
  const allowedMap = {};
  staff.forEach(s => { allowedMap[s.id] = candsOf[s.id].filter(c => c !== '休'); });
  const P = AppState.settings.penalties || {};

  let vios     = checkViolations(shifts);
  let curScore = calculateScore(shifts, allowedMap, days, P);
  // 受理条件: 違反件数が減る手を最優先。同数でもスコアが良くなる手は受理して
  // 「同点の壁」を越える（(件数, スコア) の辞書式で単調減少するためループしない）
  const tryMove = (apply, undo) => {
    apply();
    const nv = checkViolations(shifts);
    if (nv.length < vios.length) {
      vios = nv;
      curScore = calculateScore(shifts, allowedMap, days, P);
      return true;
    }
    if (nv.length === vios.length) {
      const sc = calculateScore(shifts, allowedMap, days, P);
      if (sc < curScore - 1e-9) { vios = nv; curScore = sc; return true; }
    }
    undo();
    return false;
  };

  // 絶対に残したくない違反（人員不足・単発出勤・連勤超過）を最優先で処理する
  const VPRI = { 'understaff': 0, 'skill-late': 1, 'consecutive': 2, 'single-work': 3, 'hierarchy': 4, 'resp-duplicate': 4 };
  for (let round = 0; round < maxRounds && vios.length > 0; round++) {
    let improved = false;

    const ordered = vios.slice().sort((a, b) => ((VPRI[a.type] ?? 9) - (VPRI[b.type] ?? 9)));
    for (const v of ordered) {
      if (v.day < 1) continue; // 公休不足(day0)は全日対象で高コストのため対象外
      const targets = v.staffId
        ? staff.filter(s => s.id === v.staffId)
        : staff;

      for (const s of targets) {
        // ① 1マス置換（違反日と前後2日 — 切替・リズムは前後の日が原因のことが多い）
        for (let d = Math.max(1, v.day - 2); d <= Math.min(days, v.day + 2); d++) {
          if (!_polishMovable(shifts, s.id, d)) continue;
          const cur = shifts[s.id][d];
          for (const c of candsOf[s.id]) {
            if (c === cur) continue;
            if (tryMove(() => { shifts[s.id][d] = c; },
                        () => { shifts[s.id][d] = cur; })) { improved = true; break; }
          }
        }

        // ② 同一人物の2日交換（違反日±1 ↔ 月内の別日）
        for (let d1 = Math.max(1, v.day - 1); d1 <= Math.min(days, v.day + 1); d1++) {
          if (!_polishMovable(shifts, s.id, d1)) continue;
          for (let d2 = 1; d2 <= days; d2++) {
            if (d2 === d1 || !_polishMovable(shifts, s.id, d2)) continue;
            const a = shifts[s.id][d1], b = shifts[s.id][d2];
            if (a === b) continue;
            if (tryMove(() => { shifts[s.id][d1] = b; shifts[s.id][d2] = a; },
                        () => { shifts[s.id][d1] = a; shifts[s.id][d2] = b; })) { improved = true; break; }
          }
        }
      }

      // ③ 同日2人交換（担当可能な組のみ）。連勤違反は「連勤の途中の日」を
      //    誰かに肩代わりさせないと直らないため、走査範囲を連勤ブロック全体に広げる
      const swapFrom = v.type === 'consecutive' ? Math.max(1, v.day - 5) : Math.max(1, v.day - 1);
      for (let d = swapFrom; d <= Math.min(days, v.day + 1); d++) {
        for (let i = 0; i < staff.length; i++) {
          const A = staff[i];
          if (!_polishMovable(shifts, A.id, d)) continue;
          for (let j = i + 1; j < staff.length; j++) {
            const B = staff[j];
            if (!_polishMovable(shifts, B.id, d)) continue;
            const va = shifts[A.id][d], vb = shifts[B.id][d];
            if (va === vb) continue;
            const aOk = !isWork(vb) || candsOf[A.id].includes(vb);
            const bOk = !isWork(va) || candsOf[B.id].includes(va);
            if (!aOk || !bOk) continue;
            if (tryMove(() => { shifts[A.id][d] = vb; shifts[B.id][d] = va; },
                        () => { shifts[A.id][d] = va; shifts[B.id][d] = vb; })) { improved = true; break; }
          }
        }
      }

      // ④ 2日同時の2人交換: 同じ違反が2日連続で絡み合っていると（例: ヒエラルキー違反が
      //    25日と26日）、1日だけ直しても件数が減らず①〜③では採用されない。
      //    2日まとめて入れ替えれば両方同時に消えるケースを拾う。
      for (const d0 of [v.day - 1, v.day]) {
        if (d0 < 1 || d0 + 1 > days) continue;
        for (let i = 0; i < staff.length; i++) {
          const A = staff[i];
          if (!_polishMovable(shifts, A.id, d0) || !_polishMovable(shifts, A.id, d0 + 1)) continue;
          for (let j = i + 1; j < staff.length; j++) {
            const B = staff[j];
            if (!_polishMovable(shifts, B.id, d0) || !_polishMovable(shifts, B.id, d0 + 1)) continue;
            const a1 = shifts[A.id][d0],     b1 = shifts[B.id][d0];
            const a2 = shifts[A.id][d0 + 1], b2 = shifts[B.id][d0 + 1];
            if (a1 === b1 && a2 === b2) continue;
            const ok = (!isWork(b1) || candsOf[A.id].includes(b1)) &&
                       (!isWork(a1) || candsOf[B.id].includes(a1)) &&
                       (!isWork(b2) || candsOf[A.id].includes(b2)) &&
                       (!isWork(a2) || candsOf[B.id].includes(a2));
            if (!ok) continue;
            if (tryMove(
              () => { shifts[A.id][d0] = b1; shifts[B.id][d0] = a1;
                      shifts[A.id][d0 + 1] = b2; shifts[B.id][d0 + 1] = a2; },
              () => { shifts[A.id][d0] = a1; shifts[B.id][d0] = b1;
                      shifts[A.id][d0 + 1] = a2; shifts[B.id][d0 + 1] = b2; })) { improved = true; break; }
          }
        }
      }
    }

    if (!improved) break;
  }
  return vios;
}

// ===== 自動チーム分け（早の軸 / 遅の軸） =====
// 早遅バランスが「均等」の人が多いと、「片寄せしたい」と「半々にしたい」が綱引きになり
// 切替エラーが残りやすい。そこで生成前に必要コマ数と各自の出勤余力から
// 「誰を早番の軸に、誰を遅番の軸にするか」をアプリ側で自動決定する。
// ユーザーが明示的に早寄り/遅寄りを設定している人はその設定を尊重して対象外。
let _autoBandMap = {};
let _noLateDayMap = {}; // { staffId: Set<day> } その日は遅番禁止（翌日が固定早番系のため）

function _bandOfShift(sh) {
  if (isLate(sh)) return 'late';
  if (isEarlyCategory(sh) && !isTraining(sh)) return 'early';
  return null;
}

function computeAutoBands(staff, allowedShifts, days) {
  const map  = {};
  const keys = getWorkShiftKeys();

  // 月間の必要コマ数（時間帯別）
  const demand = { early: 0, late: 0 };
  for (let d = 1; d <= days; d++) {
    keys.forEach(sh => {
      const b = _bandOfShift(sh);
      if (b) demand[b] += optDayReq(sh, d) || 0;
    });
  }

  const cap = s => Math.max(0, days - (s.maxOff || 0) - (s.paidLeave || 0));
  const assigned = { early: 0, late: 0 };
  const flexible = [];

  staff.forEach(s => {
    const shs  = allowedShifts[s.id] || s.allowedShifts || [];
    const canE = shs.some(sh => _bandOfShift(sh) === 'early');
    const canL = shs.some(sh => _bandOfShift(sh) === 'late');
    const bal  = s.balance || 'balanced';
    if (!canE || !canL) {
      // 片方の時間帯しか入れない人は、その時間帯の供給として先にカウント
      const b = canE ? 'early' : (canL ? 'late' : null);
      if (b) assigned[b] += cap(s);
      return;
    }
    if (bal !== 'balanced' && SHIFT_BALANCE[bal]) {
      // 明示設定済みの人は設定比率で供給をカウント（軸の自動決定はしない）
      assigned.early += cap(s) * SHIFT_BALANCE[bal].earlyRatio;
      assigned.late  += cap(s) * SHIFT_BALANCE[bal].lateRatio;
      return;
    }
    flexible.push(s);
  });

  // 上位役職から順に、不足が大きい時間帯へ軸を割り当てる
  // （責任者になれる人が早番・遅番の両方に行き渡るようにする狙い）
  flexible.sort((a, b) => getStaffPriority(a) - getStaffPriority(b));

  // スキル要件を先に満たす: 「営業は遅番に2人」のようなスキルは、その時間帯に
  // 保有者が毎日いないと必ずエラーになる。軸割り当てを役職順の前に行い、
  // 必要なスキル保有者を該当時間帯の軸へ優先的に寄せる（スキルブラインドを解消）。
  const skillReqs = [];
  (AppState.skills || []).forEach(sk => {
    const need = (sk.req != null ? sk.req : (sk.lateReq || 0));
    if (!need) return;
    const band = (sk.target || 'late') === 'early' ? 'early' : 'late';
    skillReqs.push({ name: sk.name, need, band });
  });
  const taken = new Set();
  const assignBand = (s, band) => {
    map[s.id] = band;
    taken.add(s.id);
    const c = cap(s);
    assigned[band] += c * 0.7;
    assigned[band === 'early' ? 'late' : 'early'] += c * 0.3;
  };
  skillReqs.forEach(req => {
    // その時間帯に「毎日 need 人」を確保するのに必要な軸保有者数を見積もる。
    // 1人あたりの供給 ≒ (出勤率) × 0.7（軸でも3割は反対帯に入るため）
    let coverage = 0;
    const holders = flexible
      .filter(s => !taken.has(s.id) && (s.skills || []).includes(req.name))
      .sort((a, b) => cap(b) - cap(a)); // 出勤日数が多い（＝頼れる）人から
    for (const s of holders) {
      if (coverage >= req.need) break;
      assignBand(s, req.band);
      coverage += (cap(s) / days) * 0.7;
    }
  });

  flexible.forEach(s => {
    if (taken.has(s.id)) return;
    const needE = demand.early - assigned.early;
    const needL = demand.late  - assigned.late;
    const band  = needE >= needL ? 'early' : 'late';
    assignBand(s, band);
  });
  return map;
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

  // 自動チーム分け: 「均等」設定で両時間帯に入れる人に、早の軸/遅の軸を自動割り当て
  _autoBandMap = computeAutoBands(staff, allowedShifts, days);

  // 固定セル境界の遅番禁止マップ: 翌日が「固定の早番系（研修含む）出勤」なら
  // 当日に遅番を置くと必ず 遅→研/遅→早 エラーになるため、生成段階から禁止する
  _noLateDayMap = {};
  staff.forEach(s => {
    _noLateDayMap[s.id] = new Set();
    for (let d = 1; d < days; d++) {
      const fx = (AppState.fixedShifts[s.id] || {})[d + 1];
      const rq = (AppState.requests[s.id]    || {})[d + 1];
      const nxFixed = fx || (rq && isWork(rq) ? rq : null);
      if (nxFixed && isWork(nxFixed) && isEarlyCategory(nxFixed)) _noLateDayMap[s.id].add(d);
    }
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
        const seedVal = (repairCtx.seedShifts[s.id] || {})[d] || '';
        shifts[s.id][d] = seedVal;
        if (locked[s.id][d]) continue; // 固定シフト・希望休はそのまま動かさない
        if (seedVal === '有') { locked[s.id][d] = true; continue; } // 有給は消さない（動かさない）
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

  // 修復モードでは動かせるマス数に応じて反復回数を自動縮小（探索空間が小さいため
  // フル回数は不要 — 品質を保ったまま大幅に高速化）
  let maxAttempts = settings.maxAttempts;
  if (repairCtx) {
    let unlockedCells = 0;
    staff.forEach(s => {
      for (let d = 1; d <= days; d++) if (!locked[s.id][d]) unlockedCells++;
    });
    maxAttempts = Math.min(settings.maxAttempts, Math.max(20000, unlockedCells * 2500));
  }
  let T              = 500.0;
  const coolingRate  = Math.pow(0.01 / T, 1.0 / maxAttempts);
  const reportInterval = Math.max(500, Math.floor(maxAttempts / 200));
  const lastBestUpdate = { attempt: 0 };
  let genuineLastImprove = 0; // リヒートに影響されない「本当の最良更新」時刻（早期終了用）

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
        genuineLastImprove = attempt;
      }
    } else {
      undoFn();
    }

    // 早期終了: 予算の4割を過ぎ、かつ2割の区間ずっと最良が更新されなければ
    // 収束とみなして打ち切る（品質はほぼ変えずに無駄な反復を削る）。
    // 修復モードは範囲が狭く収束が速いので対象外にしない。
    if (attempt > maxAttempts * 0.4 && attempt - genuineLastImprove > maxAttempts * 0.2) break;

    if (attempt % reportInterval === 0) {
      const pct = Math.floor((attempt / maxAttempts) * 100);
      progressCallback && progressCallback(pct,
        `最適化中... 現在スコア: ${currentScore.toFixed(0)} / 最良: ${bestScore.toFixed(0)} (試行 ${attempt}/${maxAttempts})`);
      await sleep(0);
    }

  }

  // 仕上げ: 総当たり微調整（山登り）＋難所の同日入れ替え（A・D）。
  // 修復モードでは毎パス重くなるためスキップ（修復自体が局所探索のため）。
  if (!repairCtx) {
    progressCallback && progressCallback(99, '仕上げ中（総当たり微調整）...');
    await sleep(0);
    bestScore = hillClimbPolish(bestShifts, locked, staff, allowedShifts, days, P, 2);
  }

  // 最終保証: 人員不足は絶対に残さない。埋められる日は必ず埋める（強制フィル）。
  // 希望休・固定・有給で動かせず物理的に人が足りない日だけが残る。
  forceFillUnderstaffing(bestShifts, locked, staff, allowedShifts, days);

  return { shifts: bestShifts, score: bestScore };
}

/**
 * 人員不足を絶対に残さないための最終強制フィル。
 * 不足しているシフトに、①休み ②「余」 ③同日の過剰シフトの人 の順で
 * 担当可能な人を移して埋める。ロック（希望休・固定・有給）は動かさない。
 * ソフト制約（連勤・リズム・公休数）より人員確保を優先する。
 * @returns {number} 埋めきれず残った不足コマ数（0 なら完全充足）
 */
/**
 * 最終保証（実ロック版）: 生成・修復の最終段で、部門ごとの必要人数に対し
 * 人員不足を全体盤面で潰す。ロック判定は「希望休・固定・有給」の実ロックのみ
 * （修復モードの一時ロックに縛られない）ため、埋められる限り必ず埋める。
 * @returns {number} 埋めきれなかった不足コマ数
 */
function forceFillUnderstaffingReal(shifts, staffList, reqs, dailyReqs, weekdayReqs) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const locked = {};
  const allowed = {};
  staffList.forEach(s => {
    locked[s.id] = {};
    for (let d = 1; d <= days; d++) {
      const fx = (AppState.fixedShifts[s.id] || {})[d];
      const rq = (AppState.requests[s.id]    || {})[d];
      locked[s.id][d] = !!fx || (rq && (isOff(rq) || isWork(rq)));
    }
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    allowed[s.id] = base;
  });
  const dayReq = (sh, d) => getDayReq(reqs || AppState.roleRequirements, dailyReqs || {}, sh, d, weekdayReqs || {});
  return forceFillUnderstaffing(shifts, locked, staffList, allowed, days, dayReq);
}

function forceFillUnderstaffing(shifts, locked, staff, allowedShifts, days, dayReqFn) {
  const shiftKeys = getWorkShiftKeys();
  const reqOf = dayReqFn || optDayReq;
  const movable = (s, d) => {
    if (locked[s.id][d]) return false;
    if (shifts[s.id][d] === '有') return false; // 有給は動かさない
    return true;
  };
  let remaining = 0;
  for (let d = 1; d <= days; d++) {
    const countOf = sh => staff.filter(s => shifts[s.id][d] === sh).length;
    shiftKeys.forEach(sh => {
      const req = reqOf(sh, d);
      if (!req) return;
      let count = countOf(sh);
      if (count >= req) return;

      const canDo = s => (allowedShifts[s.id] || []).includes(sh);
      // d 日に出勤させたときの連勤の長さ（前後の連続勤務）。小さいほど連勤になりにくい
      const consLenIfWork = s => {
        let n = 1, dd = d - 1;
        while (dd >= 1  && isWork(shifts[s.id][dd])) { n++; dd--; }
        dd = d + 1;
        while (dd <= days && isWork(shifts[s.id][dd])) { n++; dd++; }
        return n;
      };
      // ① 休み（余含む）から補充。連勤になりにくい人（前後が休みの人）を優先
      const resting = staff
        .filter(s => movable(s, d) && canDo(s) && !isWork(shifts[s.id][d]))
        .sort((a, b) => consLenIfWork(a) - consLenIfWork(b));
      for (const s of resting) {
        if (count >= req) break;
        shifts[s.id][d] = sh; count++;
      }
      // ② 同日の「過剰な」シフトから玉突きで移す（移動元が req 超過のときだけ）
      if (count < req) {
        for (const s of staff) {
          if (count >= req) break;
          const cur = shifts[s.id][d];
          if (!isWork(cur) || cur === sh) continue;
          if (!movable(s, d) || !canDo(s)) continue;
          if (countOf(cur) <= reqOf(cur, d)) continue; // 移すと今度は元が不足するので不可
          shifts[s.id][d] = sh; count++;
        }
      }
      if (count < req) remaining += (req - count); // 物理的に不可能な分
    });
  }
  return remaining;
}

/**
 * 人員不足の最終保証（二部マッチング版）。
 * まだ不足が残る日について、その日に出られる（＝希望休・有給でない）全員を
 * 対象に、担当可能な役職スロットへ二部マッチング（Kuhn法）で割り当て直す。
 * 多段の玉突きも自動で解けるため、その日に物理的に人がいる限り必ず埋まる。
 * 不足が残っている日だけを対象にするので、問題ない日のリズムは崩さない。
 * @returns {number} それでも埋まらなかった不足コマ数（＝物理的に不可能）
 */
function guaranteeDayStaffingReal(shifts, staffList, reqs, dailyReqs, weekdayReqs) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const shiftKeys = getWorkShiftKeys();
  const allowedOf = {};
  staffList.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh);
      return t && !t.isTraining;
    });
    if (s.prefs && s.prefs.length > 0) {
      const f = base.filter(sh => {
        if (isEarly(sh) && !s.prefs.includes('早可')) return false;
        if (isLate(sh)  && !s.prefs.includes('遅可')) return false;
        return true;
      });
      if (f.length) base = f;
    }
    allowedOf[s.id] = base;
  });
  const dayReq = (sh, d) => getDayReq(reqs || AppState.roleRequirements, dailyReqs || {}, sh, d, weekdayReqs || {});
  let stillShort = 0;

  for (let d = 1; d <= days; d++) {
    // この日が不足しているか（不足していなければ触らない）
    const isShort = shiftKeys.some(k => {
      const req = dayReq(k, d); if (!req) return false;
      return staffList.filter(s => shifts[s.id][d] === k).length < req;
    });
    if (!isShort) continue;

    // 必要スロットを展開（固定・希望出勤で既に埋まっている分は差し引く）
    const lockedRole = {};
    const avail = [];
    staffList.forEach(s => {
      const fx = (AppState.fixedShifts[s.id] || {})[d];
      const rq = (AppState.requests[s.id]    || {})[d];
      if ((rq && isOff(rq)) || shifts[s.id][d] === '有') return; // その日は出られない
      if (fx || (rq && isWork(rq))) { lockedRole[shifts[s.id][d]] = (lockedRole[shifts[s.id][d]] || 0) + 1; return; }
      avail.push(s);
    });
    const occ = Object.assign({}, lockedRole);
    const slots = []; // 割り当て対象の空きスロット（役職名の配列）
    shiftKeys.forEach(k => {
      let need = dayReq(k, d); if (!need) return;
      while (need-- > 0) { if (occ[k] > 0) occ[k]--; else slots.push(k); }
    });
    if (!slots.length) continue;

    // Kuhn法: 左=スロット, 右=avail の人。現在の割当を種にして無駄な入替を避ける
    const matchSlot   = new Array(slots.length).fill(null); // slotIdx -> personId
    const matchPerson = {};                                 // personId -> slotIdx
    avail.forEach(s => {
      const cur = shifts[s.id][d];
      if (!isWork(cur)) return;
      const si = slots.findIndex((r, i) => r === cur && matchSlot[i] === null);
      if (si >= 0 && allowedOf[s.id].includes(cur)) { matchSlot[si] = s.id; matchPerson[s.id] = si; }
    });
    const personById = {}; avail.forEach(s => personById[s.id] = s);
    const tryAug = (si, seen) => {
      for (const s of avail) {
        if (seen.has(s.id)) continue;
        if (!allowedOf[s.id].includes(slots[si])) continue;
        seen.add(s.id);
        if (matchPerson[s.id] == null || tryAug(matchPerson[s.id], seen)) {
          matchPerson[s.id] = si; matchSlot[si] = s.id; return true;
        }
      }
      return false;
    };
    for (let si = 0; si < slots.length; si++) {
      if (matchSlot[si] === null) tryAug(si, new Set());
    }

    // 全スロット埋まったら適用（埋まらないスロットがあれば物理的に不可能なので現状維持）
    const filled = matchSlot.every(m => m !== null);
    if (filled) {
      avail.forEach(s => {
        const si = matchPerson[s.id];
        const to = (si != null) ? slots[si] : '休'; // 割当なしの人は休み
        if (shifts[s.id][d] !== to) shifts[s.id][d] = to;
      });
    } else {
      stillShort += matchSlot.filter(m => m === null).length;
    }
  }
  return stillShort;
}

/**
 * 山登り法による仕上げ（A: 総当たり微調整 / D: 難所の同日入れ替え集中）。
 * ロックされていない各マスについて、より良いシフトへ置き換える／同じ日の2人を
 * 入れ替える、を改善がなくなるまで繰り返す。焼きなましの取りこぼしを削る。
 * @returns {number} 仕上げ後のスコア
 */
function hillClimbPolish(shifts, locked, staff, allowedShifts, days, P, maxSweeps) {
  let cur = calculateScore(shifts, allowedShifts, days, P);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;

    // (A) 1マスずつ、より良いシフト（担当シフト＋休）に置き換える
    for (const s of staff) {
      for (let d = 1; d <= days; d++) {
        if (locked[s.id][d]) continue;
        const orig  = shifts[s.id][d];
        const cands = allowedShifts[s.id].concat(['休']);
        let bestVal = orig, bestScore = cur;
        for (const c of cands) {
          if (c === orig) continue;
          shifts[s.id][d] = c;
          const sc = calculateScore(shifts, allowedShifts, days, P);
          if (sc < bestScore - 1e-9) { bestScore = sc; bestVal = c; }
        }
        shifts[s.id][d] = bestVal;
        if (bestVal !== orig) { cur = bestScore; improved = true; }
      }
    }

    // (D) 難所対策: 同じ日の2人のシフトを入れ替えて良くなるなら採用（重いので初回のみ）
    if (sweep === 0)
    for (let d = 1; d <= days; d++) {
      for (let i = 0; i < staff.length; i++) {
        const a = staff[i];
        if (locked[a.id][d]) continue;
        for (let j = i + 1; j < staff.length; j++) {
          const b = staff[j];
          if (locked[b.id][d]) continue;
          const va = shifts[a.id][d], vb = shifts[b.id][d];
          if (va === vb) continue;
          // 入れ替え後も担当可能なもの同士のみ（休は誰でも可）
          const aOk = vb === '休' || (allowedShifts[a.id] || []).includes(vb);
          const bOk = va === '休' || (allowedShifts[b.id] || []).includes(va);
          if (!aOk || !bOk) continue;
          shifts[a.id][d] = vb; shifts[b.id][d] = va;
          const sc = calculateScore(shifts, allowedShifts, days, P);
          if (sc < cur - 1e-9) { cur = sc; improved = true; }
          else { shifts[a.id][d] = va; shifts[b.id][d] = vb; } // 戻す
        }
      }
    }

    if (!improved) break;
  }
  return cur;
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

  // 一般の「1日あたり休み上限」: 自動配置の休みでその日の必要総コマ数を割り込ませない。
  // これにより、有給・公休が同じ日に偏って物理的に埋まらなくなるのを未然に防ぐ。
  const totalReqOf = d => shiftKeys.reduce((a, k) => a + (optDayReq(k, d) || 0), 0);
  const offByDay = {};
  staff.forEach(s => {
    for (let d = 1; d <= days; d++) {
      if (locked[s.id][d] && isOff(shifts[s.id][d])) offByDay[d] = (offByDay[d] || 0) + 1;
    }
  });
  const dayOffFull = d => (offByDay[d] || 0) >= Math.max(0, staff.length - totalReqOf(d));

  // スキル保有者の休み集中ガード:
  // 「営業は遅番に2人」等のスキルは、保有者が同じ日に休みすぎると物理的に
  // 満たせなくなる。自動配置の有給・公休では、その日の残り保有者が
  // 必要数を割り込むような日を避ける（buffer=1: 1人余裕を残す → 0: ちょうど → 無効）。
  // ガードは「最低ライン(min)」基準: 目標(need)ではなく絶対に割ってはいけない
  // 人数を守る。これで目標2・最低1なら、保有者の休みが1人残る日までは許容される。
  const skillList = (AppState.skills || [])
    .map(sk => {
      const need = (sk.req != null ? sk.req : (sk.lateReq || 0));
      const min  = (sk.min != null && sk.min >= 0 && sk.min <= need) ? sk.min : need;
      return { name: sk.name, need: min };
    })
    .filter(k => k.need > 0);
  const holderRest = {}, holderTotal = {};
  skillList.forEach(k => {
    holderRest[k.name] = {}; holderTotal[k.name] = 0;
    staff.forEach(s => {
      if (!(s.skills || []).includes(k.name)) return;
      holderTotal[k.name]++;
      for (let d = 1; d <= days; d++) {
        if (locked[s.id][d] && isOff(shifts[s.id][d])) {
          holderRest[k.name][d] = (holderRest[k.name][d] || 0) + 1;
        }
      }
    });
  });
  const skillBlocked = (s, d, buffer) => skillList.some(k => {
    if (!(s.skills || []).includes(k.name)) return false;
    return holderTotal[k.name] - ((holderRest[k.name][d] || 0) + 1) < k.need + buffer;
  });
  const noteSkillRest = (s, d) => skillList.forEach(k => {
    if ((s.skills || []).includes(k.name)) holderRest[k.name][d] = (holderRest[k.name][d] || 0) + 1;
  });

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
      if (dayOffFull(d)) continue; // その日はこれ以上休ませると人員不足になる
      cands.push(d);
    }
    const need = Math.max(0, target - alreadyPaid);
    shuffleArray(cands);
    let placed = 0;
    // buffer=1: 保有者に1人余裕を残す日を優先 → 0: ちょうどの日も許可 → -9: ガード無効
    for (const buffer of [1, 0, -9]) {
      for (const d of cands) {
        if (placed >= need) break;
        if (shifts[s.id][d] === '有') continue; // 前のパスで配置済み
        if (dayOffFull(d)) continue; // 混んでいる日には積まない（人員不足を防ぐ）
        if (buffer > -9 && skillBlocked(s, d, buffer)) continue;
        shifts[s.id][d] = '有';
        locked[s.id][d] = true;
        offByDay[d] = (offByDay[d] || 0) + 1;
        noteSkillRest(s, d);
        if (isVm) vmOffByDay[d] = (vmOffByDay[d] || 0) + 1;
        placed++;
      }
      if (placed >= need) break;
    }
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
      if (dayOffFull(d)) continue; // その日はこれ以上休ませると人員不足になる
      unlockedDays.push(d);
    }
    const needMoreOff = Math.max(0, (s.maxOff || 0) - alreadyOff);
    shuffleArray(unlockedDays);
    let placedOff = 0;
    // 有給と同様、スキル保有者の休みが同じ日に集中しないよう段階的に緩めながら配置
    for (const buffer of [1, 0, -9]) {
      for (const d of unlockedDays) {
        if (placedOff >= needMoreOff) break;
        if (shifts[s.id][d] === '休') continue; // 前のパスで配置済み
        if (dayOffFull(d)) continue; // 混んでいる日には積まない（人員不足を防ぐ）
        if (buffer > -9 && skillBlocked(s, d, buffer)) continue;
        shifts[s.id][d] = '休';
        offByDay[d] = (offByDay[d] || 0) + 1;
        noteSkillRest(s, d);
        if (isVm) vmOffByDay[d] = (vmOffByDay[d] || 0) + 1;
        placedOff++;
      }
      if (placedOff >= needMoreOff) break;
    }
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
      const candidates = avail.filter(s => shifts[s.id][d] === '' && allowedShifts[s.id].includes(sh) &&
        !(isLate(sh) && _noLateDayMap[s.id] && _noLateDayMap[s.id].has(d)));
      // 自動チーム分けの軸に合う人を優先（早番コマには早の軸の人から入れる）
      const shBand = _bandOfShift(sh);
      const bandRank = s => {
        if (!shBand || !_autoBandMap[s.id]) return 1;
        return _autoBandMap[s.id] === shBand ? 0 : 2;
      };
      if (shBand) candidates.sort((a, b) => bandRank(a) - bandRank(b));
      if (isRespShift) candidates.sort((a, b) =>
        (getStaffPriority(a) - getStaffPriority(b)) || (bandRank(a) - bandRank(b)));
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
  const maxCons = getMaxConsFor(s); // 個人の連勤上限（未設定なら全体設定）
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

    // 毎日、副店長が出勤 or 早責・遅責の両方がチーフ以上で埋まっていること
    const chiefCovered = respEarlyPerson && respLatePerson &&
      getStaffPriority(respEarlyPerson) <= 2 && getStaffPriority(respLatePerson) <= 2;
    if (hasVice && viceWorking === 0 && !chiefCovered) score += (P.viceManagerDailyAbsent || 9000);
    shiftKeys.forEach(k => {
      const req = optDayReq(k, d);
      if (!req) return;
      const diff = req - counts[k];
      if (diff > 0) score += diff * P.understaff;
      // 責任者・総務（早責/遅責/早総/遅総）は同じ時間帯に2人いてはいけないため重罰
      else if (diff < 0) score += (-diff) * (SOLO_SHIFT_KEYS.includes(k) ? P.respDuplicate : P.overstaff);
    });

    // スキル別: 指定時間帯（早番/遅番）に必要なスキル保有者数を満たすか
    const skills = AppState.skills || [];
    if (skills.length) {
      skills.forEach(sk => {
        const need = (sk.req != null ? sk.req : (sk.lateReq || 0));
        if (!need) return;
        // 最低ライン min: これを下回ると🔴（強）、min〜need未満は🟡（弱）。
        // 未設定なら min=need（従来どおり不足はすべて強ペナルティ）。
        const min = (sk.min != null && sk.min >= 0 && sk.min <= need) ? sk.min : need;
        const early = (sk.target || 'late') === 'early';
        let have = 0;
        staff.forEach(s => {
          const sh = shifts[s.id][d];
          const inTarget = early ? isEarlyCategory(sh) : isLate(sh);
          if (isWork(sh) && inTarget && (s.skills || []).includes(sk.name)) have++;
        });
        if (have < min) {
          score += (min - have) * (P.skillLateShortage || 9000);              // 最低ライン割れ（強）
          score += (need - min) * (P.skillSoftShortage || 1500);
        } else if (have < need) {
          score += (need - have) * (P.skillSoftShortage || 1500);              // 目標には届かない（弱）
        }
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

  // 曜日を事前計算（個人希望: 土日休み判定用）
  const _wd = [0];
  for (let d = 1; d <= days; d++) _wd[d] = getWeekday(AppState.settings.targetMonth, d);

  // 横: 各スタッフのルール
  staff.forEach(s => {
    let consWork  = s.prevConsecutive || 0;
    let prevShift = (consWork > 0 && s.prevLastShift) ? s.prevLastShift : '';
    let offCount  = 0, earlyCount = 0, lateCount = 0;
    let lockedOff = 0, unlockedOff = 0; // viceManager 用（既存ループ内で同時集計）
    let offRun    = 0, pairRestRuns = 0; // 連休（2連休以上）の検出用
    let pubRun    = 0; // 公休のみの連続数（連休最大3日ルール用。余・有給は数えない）
    // 個人希望（土日休み・休み方）の重み: 定数(6000)・公休(4000)より下に置き優先順位を守る
    const wkW = s.weekendPref === 'hard' ? 3500 : (s.weekendPref === 'soft' ? 600 : 0);
    const styleSpread = (s.restStyle || '').startsWith('spread');
    const stylePair   = (s.restStyle || '').startsWith('pair');
    const styleW = (s.restStyle || '').endsWith('hard') ? 3000 : 500;

    for (let d = 1; d <= days; d++) {
      const cur = shifts[s.id][d];

      if (isWork(cur)) {
        if (offRun >= 2) pairRestRuns++;
        offRun = 0;
        pubRun = 0;

        if (!isTraining(cur)) {
          // 担当外シフト
          if (!allowedShifts[s.id].includes(cur)) score += P.disallowedShift;
        }

        consWork++;
        const myMaxCons = getMaxConsFor(s); // 個人の連勤上限（基本ライン）
        if (consWork > myMaxCons) {
          // 基本ライン+1（例: 5連勤）までは「どうしても時のみ」の🟡（軽い）。
          // 絶対上限（基本ライン+1）を超える（例: 6連勤）と🔴（重い）。
          const softOver = 1;                                  // ちょうど+1日ぶん
          const hardOver = consWork - (myMaxCons + 1);         // +2日め以降
          score += (P.consSoft || 2000) * Math.min(softOver, consWork - myMaxCons);
          if (hardOver > 0) score += P.consBase * hardOver + P.consSq * hardOver * hardOver;
        }

        // 個人希望: 土日休み（土日に出勤したら減点）
        if (wkW && (_wd[d] === 0 || _wd[d] === 6)) score += wkW;
        // 個人希望: 分散派（勤務は3連勤前後まで。4日目以降に減点）
        if (styleSpread && consWork > 3) score += styleW;

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

        // 翌日が固定の早番系（研修含む）の日に遅番はほぼ禁止（遅→研/遅→早が確定するため）
        if (isLate(cur) && _noLateDayMap[s.id] && _noLateDayMap[s.id].has(d)) {
          score += (P.prefMismatch || 12000);
        }
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
          // 連休は最大3日まで（有給も連休に数える。「余」は人員余りの都合なので除外）
          if (cur !== '余') {
            pubRun++;
            if (pubRun > 3) {
              const restLocked =
                isOff((AppState.requests[s.id]    || {})[d]) ||
                isOff((AppState.fixedShifts[s.id] || {})[d]);
              if (!restLocked) score += (P.longRest || 2000);
            }
          } else {
            pubRun = 0; // 「余」は連休を分断
          }
        }
        consWork = 0;

        // 個人希望: 連休派（ポツンと1日だけの休みに減点 → 連休にまとまる方向へ）
        if (stylePair && cur !== '余' && d > 1 && d < days) {
          const pvP = shifts[s.id][d - 1], nxP = shifts[s.id][d + 1];
          if (isWork(pvP) && isWork(nxP)) score += styleW;
        }

        // 個人ルール: 遅→早の切替時は2連休以上必須（遅→休1日→早 を強く禁止）
        if (s.needPairRest && d > 1 && d < days) {
          const pv2 = shifts[s.id][d - 1], nx2 = shifts[s.id][d + 1];
          if (isWork(pv2) && isWork(nx2) && isLate(pv2) && isEarlyCategory(nx2)) {
            score += (P.lateEarly || 2500) * 2;
          }
        }

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

    // 早遅バランス（「均等」の人は自動チーム分けで決めた軸の比率に置き換える。
    // 均等目標のままだと「片寄せ」ペナルティと綱引きになり切替が残るため）
    const balKey  = s.balance || 'balanced';
    let balance   = SHIFT_BALANCE[balKey];
    if (balKey === 'balanced' && _autoBandMap[s.id]) {
      balance = _autoBandMap[s.id] === 'early' ? SHIFT_BALANCE.earlyHeavy : SHIFT_BALANCE.lateHeavy;
    }
    const totalWork = earlyCount + lateCount;
    if (balance && totalWork > 0) {
      score += (Math.abs(earlyCount - totalWork * balance.earlyRatio) +
                Math.abs(lateCount  - totalWork * balance.lateRatio)) * P.balanceDiff;
    }

    // 早番・遅番の片寄せ: 1人がどちらかの時間帯に集中するほど「連勤中の切替」「遅→休→早」が
    // 起きにくくなる。少ない方の時間帯の日数にペナルティを与え、自動的にチーム分けへ寄せる。
    if (earlyCount > 0 && lateCount > 0) {
      score += Math.min(earlyCount, lateCount) * (P.bandConcentration || 700);
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

    // 連休回数の目標: 個人設定 > 全体設定 の優先で、足りない回数分を回避（なるべく）
    const pairTarget = (s.pairRestTarget > 0)
      ? s.pairRestTarget
      : (AppState.settings.pairRestTarget || 0);
    if (pairTarget > 0 && pairRestRuns < pairTarget) {
      score += (pairTarget - pairRestRuns) * 800;
    }

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

  // 曜日を事前計算（個人希望: 土日休み判定用）
  const _wdv = [0];
  for (let d = 1; d <= days; d++) _wdv[d] = getWeekday(settings.targetMonth, d);

  staff.forEach(s => {
    let consWork  = s.prevConsecutive || 0;
    let prevShift = (consWork > 0 && s.prevLastShift) ? s.prevLastShift : '';
    let offCount  = 0;
    let offRun    = 0;
    // キャスト（パート的な少日数勤務）は、単発出勤・長期連休・切替などの
    // リズム系ルールを適用しない（部分勤務では自然に起きるためノイズになる）。
    // 人員不足・スキル・担当外などの構造ルールは通常どおり適用される。
    const isCast = getStaffDepartment(s) === 'cast';
    const effectiveAllowed = (s.allowedShifts || []).concat(['研']); // 研は全員許容
    const reportedDays = new Set();
    const wkHard     = s.weekendPref === 'hard';
    const pairHard   = s.restStyle === 'pair-hard';
    const spreadHard = s.restStyle === 'spread-hard';

    for (let d = 1; d <= days; d++) {
      const cur = (shifts[s.id] || {})[d] || '';

      if (isWork(cur)) {
        consWork++;
        const myMaxCons = getMaxConsFor(s); // 基本ライン（4 or 個人設定）
        // 基本ライン+1（例:5連勤）= 🟡（どうしても時のみ許容）、+2以上（例:6連勤）= 🔴
        if (consWork === myMaxCons + 1) {
          violations.push({
            staffId: s.id, day: d, type: 'consecutive-soft',
            message: `⚠️ ${consWork}連勤（基本${myMaxCons}日・どうしても時のみ許容${s.personalMaxCons > 0 ? '・個人設定' : ''}）`,
            action:  'できれば他の日と入れ替えて休みを挟んでください',
          });
        } else if (consWork === myMaxCons + 2) {
          violations.push({
            staffId: s.id, day: d, type: 'consecutive',
            message: `🚨 ${consWork}連勤（絶対上限${myMaxCons + 1}日を超過${s.personalMaxCons > 0 ? '・個人設定' : ''}）`,
            action:  '他の日と入れ替えて休みを挟んでください',
          });
        }

        // 個人希望（絶対）: 土日休み
        if (wkHard && (_wdv[d] === 0 || _wdv[d] === 6)) {
          violations.push({
            staffId: s.id, day: d, type: 'weekend-pref',
            message: `🚨 ${_wdv[d] === 0 ? '日曜' : '土曜'}に出勤（個人希望: 土日休み・絶対）`,
            action:  'この日を休みにして平日の休みと入れ替えてください',
          });
        }
        // 個人希望（絶対）: 分散派（勤務は3連勤まで）
        if (spreadHard && consWork === 4 && !reportedDays.has('sp' + d)) {
          violations.push({
            staffId: s.id, day: d, type: 'rest-style',
            message: `🚨 4連勤以上（個人希望: こまめに分散・絶対）`,
            action:  '3連勤以内になるよう休みを挟んでください',
          });
          reportedDays.add('sp' + d);
        }

        if (!isCast && settings.forbidLateEarly && isLate(prevShift) && isEarlyCategory(cur)) {
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

        if (!isCast && consWork >= 2 && isWork(prevShift)) {
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
        if (!isCast && settings.penaltySingleOff && d > 1 && d < days) {
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
        offRun = 0;
      } else {
        if (isPublicOff(cur)) offCount++; // 公休のみカウント（有給・季節休暇は別枠）
        consWork = 0;

        // 連休は最大3日まで（有給も連休に数える。「余」は除外）
        if (isOff(cur) && cur !== '余') {
          offRun++;
          const restLocked =
            isOff((AppState.requests[s.id]    || {})[d]) ||
            isOff((AppState.fixedShifts[s.id] || {})[d]);
          if (!isCast && offRun === 4 && !restLocked && !reportedDays.has('rest' + d)) {
            violations.push({
              staffId: s.id, day: d, type: 'long-rest',
              message: `⚠️ ${offRun}連休以上（連休は最大3日まで）`,
              action:  '4日以上の連休は、必要なら希望休として手動で入れてください',
            });
            reportedDays.add('rest' + d);
          }
        } else {
          offRun = 0;
        }

        // 個人希望（絶対）: 連休派（ポツンと1日だけの休みはNG）
        if (pairHard && cur !== '余' && d > 1 && d < days) {
          const pvP = (shifts[s.id] || {})[d - 1] || '';
          const nxP = (shifts[s.id] || {})[d + 1] || '';
          if (isWork(pvP) && isWork(nxP)) {
            violations.push({
              staffId: s.id, day: d, type: 'rest-style',
              message: `🚨 単独の1日休み（個人希望: 連休・絶対）`,
              action:  '前後どちらかの日も休みにして連休にしてください',
            });
          }
        }

        // 個人ルール: 遅→早の切替時は2連休以上必須
        if (s.needPairRest && d > 1 && d < days) {
          const pv = (shifts[s.id] || {})[d - 1] || '';
          const nx = (shifts[s.id] || {})[d + 1] || '';
          if (isWork(pv) && isWork(nx) && isLate(pv) && isEarlyCategory(nx)) {
            violations.push({
              staffId: s.id, day: d, type: 'pair-rest',
              message: `🚨 遅→休1日→早（個人ルール: 切替時は2連休以上）`,
              action:  '休みを2連休以上にするか、時間帯を揃えてください',
            });
          }
        } else if (!isCast && settings.penaltySingleOff && d > 1 && d < days) {
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

    // 公休不足のみ報告（超過は余剰人員のため許容）。
    // キャストは勤務が固定契約ベースのため公休数は目安扱い（エラーにしない）。
    const diff = offCount - (s.maxOff || 0);
    if (!isCast && diff < 0) {
      violations.push({
        staffId: s.id, day: 0, type: 'off-count',
        message: `🚨 公休数 ${offCount}日（目標${s.maxOff}日, 差${diff}）`,
        action:  '公休数を増やしてください',
      });
    }
  });

  // 毎日、次の①②のどちらかを満たすこと（副店長2人以上のときのみ有効）
  //  ① 副店長が早番か遅番に出勤している
  //  ② 早責と遅責の両方が「チーフ以上（チーフ or 副店長）」で埋まっている
  // 1人の場合は公休目標と数学的に矛盾するためチェックしない
  const viceManagers = staff.filter(s => s.positionType === 'viceManager');
  if (viceManagers.length >= 2) {
    for (let d = 1; d <= days; d++) {
      const working = viceManagers.some(vm => isWork((shifts[vm.id] || {})[d] || ''));
      const respEarly = staff.find(s => (shifts[s.id] || {})[d] === '早責');
      const respLate  = staff.find(s => (shifts[s.id] || {})[d] === '遅責');
      const chiefCovered = respEarly && respLate &&
        getStaffPriority(respEarly) <= 2 && getStaffPriority(respLate) <= 2;
      if (!working && !chiefCovered) {
        violations.push({
          staffId: null, day: d, type: 'vicemanager-absent',
          message: `🚨 ${d}日 副店長が不在で、早責・遅責もチーフ以上で揃っていない`,
          action:  '副店長を出勤させるか、早責・遅責の両方をチーフ以上にしてください',
        });
      }
    }
  }

  // スキル別: 指定の時間帯（早番/遅番）に必要なスキル保有者が足りているか。
  // 最低ライン min を下回る＝🔴(skill-late)、min〜目標未満＝🟡(skill-short)。
  (AppState.skills || []).forEach(sk => {
    const need = (sk.req != null ? sk.req : (sk.lateReq || 0));
    if (!need) return;
    const min = (sk.min != null && sk.min >= 0 && sk.min <= need) ? sk.min : need;
    const target = sk.target || 'late';
    const label  = target === 'early' ? '早番' : '遅番';
    const inTarget = (sh) => target === 'early' ? isEarlyCategory(sh) : isLate(sh);
    for (let d = 1; d <= days; d++) {
      let have = 0;
      staff.forEach(s => {
        const sh = (shifts[s.id] || {})[d] || '';
        if (isWork(sh) && inTarget(sh) && (s.skills || []).includes(sk.name)) have++;
      });
      if (have < min) {
        violations.push({
          staffId: null, day: d, type: 'skill-late',
          message: `🚨 ${d}日 ${label}に「${sk.name}」できる人が${have}人（最低${min}人必要）`,
          action:  `「${sk.name}」スキルのある人を${label}に配置してください`,
        });
      } else if (have < need) {
        violations.push({
          staffId: null, day: d, type: 'skill-short',
          message: `⚠️ ${d}日 ${label}に「${sk.name}」できる人が${have}人（目標${need}人・最低${min}人はOK）`,
          action:  `可能なら「${sk.name}」スキルのある人をもう1人${label}に配置してください`,
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
        const req = getDayReq(g.reqs, g.dailyReqs || {}, k, d, g.weekdayReqs || {});
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
/**
 * 「その担当ができる人が少なく、負担が偏っている」ボトルネックを検出する。
 * 例: 早責・遅責をできる人が2人しかいない → その人が休めず公休不足、他の人が余になる。
 * @returns {Array<{dept,key,capable:string[],needPerDay,surplusCandidates:string[]}>}
 */
function findCapabilityBottlenecks() {
  const staff  = AppState.staff || [];
  const days   = getDaysInMonth(AppState.settings.targetMonth);
  const groups = getDepartmentGroups(staff);
  const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);

  // 現在「余」がついている人（＝担当を広げれば戦力になる候補）
  const surplusNames = [];
  staff.forEach(s => {
    let yo = 0;
    for (let d = 1; d <= days; d++) if ((AppState.shifts[s.id] || {})[d] === '余') yo++;
    if (yo > 0) surplusNames.push({ name: s.name, id: s.id, yo });
  });

  const out = [];
  groups.forEach(g => {
    workKeys.forEach(key => {
      const baseReq = g.reqs[key] || 0;
      if (!baseReq) return;
      const capable = g.staff.filter(s => (s.allowedShifts || []).includes(key));
      // できる人が「必要人数+1」以下しかいない → 休みを回しにくいボトルネック
      if (capable.length > 0 && capable.length <= baseReq + 1) {
        // その担当を今できない余剰スタッフ＝広げる候補
        const cands = surplusNames
          .filter(sn => {
            const s = g.staff.find(m => m.id === sn.id);
            return s && !(s.allowedShifts || []).includes(key);
          })
          .map(sn => sn.name);
        out.push({
          dept: g.label, key, needPerDay: baseReq,
          capable: capable.map(s => s.name),
          surplusCandidates: cands,
        });
      }
    });
  });
  return out;
}

/**
 * 症状（個々の違反）の裏にある「根本原因」を推定してランキングで返す。
 * @returns {Array<{title,detail,fix}>}
 */
function analyzeRootCauses() {
  const vios  = AppState.violations || [];
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  const causes = [];

  // (1) 担当できる人が少ない（公休不足・時間帯切替・順位違反・余 の根本原因）
  const bn = findCapabilityBottlenecks();
  const relatedTypes = ['off-count', 'understaff', 'hierarchy', 'category-switch', 'skill-late', 'resp-duplicate'];
  const relatedCount = vios.filter(v => relatedTypes.includes(v.type)).length;
  if (bn.length > 0 && (relatedCount > 0 || bn.some(b => b.surplusCandidates.length))) {
    const keys  = [...new Set(bn.map(b => b.key))].join('・');
    const cands = [...new Set(bn.flatMap(b => b.surplusCandidates))].slice(0, 5);
    causes.push({
      weight: relatedCount + 10,
      title: `「${keys}」を担当できる人が少なすぎる`,
      detail: `${keys} をこなせる人が限られているため、その人に仕事が集中して「公休不足」「連勤中の時間帯切替」「責任者の順位」などが発生し、担当できない人は「余」になります。これが多くのエラーの共通原因です。`,
      fix: cands.length
        ? `③スタッフ管理で ${cands.join('・')} に「${keys}」の担当チェックを追加して再生成`
        : `「${keys}」を担当できる人を増やす（育成・役職追加）`,
    });
  }

  // (2) 早番と遅番を両方こなす人に、切替・リズム崩れが集中
  const switchVios = vios.filter(v => ['category-switch', 'bad-rest'].includes(v.type));
  if (switchVios.length > 0) {
    const both = [...new Set(switchVios.map(v => v.staffId))]
      .map(id => staff.find(s => s.id === id)).filter(Boolean)
      .filter(s => {
        const a = s.allowedShifts || [];
        return a.some(k => isEarlyCategory(k)) && a.some(k => isLate(k));
      }).map(s => s.name);
    if (both.length) {
      causes.push({
        weight: switchVios.length + 3,
        title: `早番と遅番を両方こなす人に切替が集中`,
        detail: `${both.slice(0, 5).join('・')} は早番・遅番の両方を担当できるため、日によって時間帯が変わり「連勤中の切替」「遅→休→早」が起きやすくなります。`,
        fix: `③スタッフ管理で対象者の「早遅バランス」を早寄り/遅寄りにする、または担当を片方の時間帯に絞ると切替が減ります。`,
      });
    }
  }

  // (3) 人手の過不足（必要コマ vs 出せるコマ）
  const groups   = getDepartmentGroups(staff);
  const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);
  let requiredWork = 0, availableWork = 0;
  staff.forEach(s => { availableWork += Math.max(0, days - (s.maxOff || 0) - (s.paidLeave || 0)); });
  groups.forEach(g => workKeys.forEach(key => {
    if (!(g.reqs[key] > 0)) return;
    for (let d = 1; d <= days; d++) requiredWork += getDayReq(g.reqs, g.dailyReqs || {}, key, d, g.weekdayReqs || {});
  }));
  if (requiredWork > availableWork) {
    causes.push({
      weight: (requiredWork - availableWork) + 8,
      title: `そもそも人手が足りない（${requiredWork - availableWork}コマ不足）`,
      detail: `必要コマ合計 ${requiredWork} に対して、出せるコマ合計は ${availableWork} です。物理的に足りないため、公休不足や人員不足が必ず発生します。`,
      fix: `必要人数（定数）を下げる／公休・有給を減らす／スタッフを増やす のいずれかが必要です。`,
    });
  }

  causes.sort((a, b) => b.weight - a.weight);
  return causes;
}

function runAIDiagnosis() {
  const days      = getDaysInMonth(AppState.settings.targetMonth);
  const staff     = AppState.staff;
  const shiftKeys = getWorkShiftKeys();
  const results   = [];

  if (!staff.length || !days) {
    return [{ level: 'info', title: 'データ未入力', detail: 'スタッフまたは対象月が設定されていません。', suggestion: null }];
  }

  // ── 0. 根本原因（症状の裏にある本当の原因）を最優先で表示 ─────────
  if (AppState.generated && (AppState.violations || []).length > 0) {
    const roots = analyzeRootCauses();
    roots.slice(0, 3).forEach((r, i) => {
      results.push({
        level: i === 0 ? 'error' : 'warning',
        title: `🔍 根本原因${roots.length > 1 ? ` ${i + 1}` : ''}：${r.title}`,
        detail: r.detail,
        suggestion: r.fix,
      });
    });
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
        title: `副店長不在で早責・遅責もチーフ以上で揃っていない日 ${cnt['vicemanager-absent']} 件`,
        detail: `次の日が該当します: ${days}\n毎日、副店長が出勤しているか、早責・遅責の両方がチーフ以上（チーフ or 副店長）で埋まっている必要があります。`,
        suggestion: '副店長を出勤させるか、早責・遅責の両方をチーフ以上に配置してください。「シフト作成」の再実行でも改善します。',
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

  // ── 5. 余剰コマ（余）の可視化（生成済みシフトがある場合） ──────────
  // 公休(maxOff)・有給は満額消化済み。それでも余った人員は「余」として表示。
  if (AppState.generated && AppState.shifts) {
    const surplusItems = [];
    let totalSurplus = 0;
    staff.forEach(s => {
      let publicOff = 0, yo = 0;
      for (let d = 1; d <= days; d++) {
        const sh = (AppState.shifts[s.id] || {})[d] || '';
        if (isPublicOff(sh)) publicOff++;
        else if (sh === '余') yo++;
      }
      const excess = Math.max(0, publicOff - (s.maxOff || 0)) + yo;
      if (excess > 0) {
        surplusItems.push({ name: s.name, yo: excess });
        totalSurplus += excess;
      }
    });

    if (surplusItems.length > 0) {
      results.push({
        level: 'warning',
        title: `余剰コマ 合計 ${totalSurplus}コマ（${surplusItems.length}名）— 誰がどれだけ余っているか`,
        detail:
          '公休・有給は満額消化済み。それでも人員が余っている分を「余」で表示しています。\n' +
          '忙しい日の必要人数を増やすか、有給を追加すると、この「余」を出勤・有給に回せます。\n\n' +
          surplusItems
            .sort((a, b) => b.yo - a.yo)
            .map(r => `${r.name}: 余 ${r.yo}コマ`)
            .join('\n'),
        suggestion:
          '「日別必要人数（上書き設定）」で忙しい日の人数を増やす、または有給を増やしてから' +
          '「シフト作成」を再実行すると、余（オレンジ）が減っていきます。',
      });
    } else {
      results.push({
        level: 'ok',
        title: '余剰コマなし',
        detail: 'すべてのスタッフが出勤・公休・有給でちょうど埋まっています（余りなし）。',
        suggestion: null,
      });
    }
  }

  // ── 6. 担当できる人が少ない偏り（公休不足↔余の根本原因）──────────
  const bottlenecks = findCapabilityBottlenecks();
  if (bottlenecks.length > 0) {
    const lines = bottlenecks.map(b => {
      const cand = b.surplusCandidates.length
        ? `　→ 余っている ${b.surplusCandidates.slice(0, 4).join('・')} に「${b.key}」を任せられると分散できます`
        : '';
      return `・「${b.key}」ができるのは ${b.capable.length}人だけ（${b.capable.slice(0, 5).join('・')}）${cand}`;
    }).join('\n');
    results.push({
      level: 'warning',
      title: `⚖️ 担当できる人の偏り（公休不足・余の原因）`,
      detail:
        '次の担当は「できる人」が少なく、その人に負担が集中して公休不足になりやすく、\n' +
        '一方でその担当ができない人は「余」になりがちです。\n\n' + lines,
      suggestion:
        '③スタッフ管理で、余っている人に上記シフト（早責・遅責など）の担当チェックを追加して再生成すると、' +
        '公休不足と余の両方が減ります。',
    });
  }

  return results;
}
