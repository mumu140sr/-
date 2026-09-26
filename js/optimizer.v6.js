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
  markSurplusRest(AppState.shifts); // 公休を目標数ちょうどにし、余った休みを「余」に振り分ける
  // 最終保証: 部門ごとに人員不足を全体盤面で潰す（実ロックのみ尊重）
  groups.forEach(g => forceFillUnderstaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs));
  // 強制フィルが生んだ単発出勤・切替を掃除（違反件数が減る手だけ採用＝人員不足は増えない）
  violationPolish(AppState.shifts, 4);
  groups.forEach(g => forceFillUnderstaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs));
  // なお残る不足は二部マッチングで確実に埋める（多段の玉突きも解く）
  groups.forEach(g => guaranteeDayStaffingReal(AppState.shifts, g.staff, g.reqs, g.dailyReqs));
  // 総合仕上げ: 🔴も🟡も含めて総数を減らす（人員不足は毎回再保証・悪化なし）
  AppState.violations = finalPolishLoop(AppState.shifts, groups, 6);
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

        _optStaff = g.staff; _optReqs = g.reqs; _optDailyReqs = g.dailyReqs;
        const groupProgress = (pct, msg) => {
          const mapped = Math.floor((gi * 100 + pct) / groups.length);
          progressCallback && progressCallback(mapped, `${passLabel} ` + msg);
        };
        const res = await optimizeGroupSchedule(groupProgress, { seedShifts, cells, staffAll });
        Object.assign(merged, res.shifts);
      }
    } finally {
      _optStaff = null; _optReqs = null; _optDailyReqs = null;
    }
    markSurplusRest(merged); // 修復後も公休ちょうど＋余に整える
    // 最終保証: 修復後も人員不足を全体盤面で潰す（実ロックのみ尊重）
    groups.forEach(g => forceFillUnderstaffingReal(merged, g.staff, g.reqs, g.dailyReqs));
    groups.forEach(g => guaranteeDayStaffingReal(merged, g.staff, g.reqs, g.dailyReqs));
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
      if (better3(key3Of(r.violations), key3Of(bestViolations))) {
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
      if (!better3(key3Of(bestViolations), key3Of(nv))) bestViolations = nv; // 悪化しなければ採用
      else { for (const sid in preSurplus) bestShifts[sid] = preSurplus[sid]; }
      // 仕上げで改善がなければ、もう1周しても同じなので終了
      if (bestViolations.length >= beforePolish) break;
    }
  }
  progressCallback && progressCallback(100, `修復完了 — 残りエラー ${bestViolations.length}件`);

  AppState.generated = true;
  const improved   = better3(key3Of(bestViolations), key3Of(origViolations));
  const finalShifts = improved ? bestShifts : origShifts;
  // 最後の一手（無条件）: 採用する盤面の人員不足を必ず潰す。修復の採否が
  // 「違反総数」基準のため、総数が少ない代わりに不足の残る案を選びうるのを補償する。
  groups.forEach(g => guaranteeDayStaffingReal(finalShifts, g.staff, g.reqs, g.dailyReqs));
  // 総合仕上げ: 🔴も🟡も含めて総数を減らす（人員不足は毎回再保証・悪化なし）
  const finalViolations = finalPolishLoop(finalShifts, groups, 6);
  AppState.shifts     = finalShifts;
  AppState.violations = finalViolations;
  return { score: finalViolations.length, violations: finalViolations,
           success: finalViolations.length === 0, improved: finalViolations.length < origViolations.length,
           before: origViolations.length, after: finalViolations.length };
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
// 6連勤以上はコンプライアンス違反（5連勤までは可）。連勤上限の設定とは関係なく、
// 6日以上続いたら必ず違反として扱う。前月末からの連勤と、半休の日も出勤に数える。
const COMPLIANCE_CONS_DAYS = 6;

const MUST_TYPES_OPT = new Set([
  'understaff', 'skill-late', 'consecutive', 'resp-duplicate', 'hierarchy',
  'vicemanager-absent', 'single-work', 'pref-mismatch', 'role-mismatch',
  'event-absent', 'night-after-work',
  'off-count', 'late-early', // ユーザー要望: 公休不足・遅→早(休みなし) も絶対NG
]);
// 設定不可（安全のため常に既定）のルール: 人員不足・公休不足・連勤超過・担当外シフト。
const RULE_LOCKED = new Set(['understaff', 'off-count', 'consecutive', 'role-mismatch']);
// ルールの強弱レベルを取得: 'off' | 'should' | 'must'。
// 固定ルールと未設定は既定分類（MUST_TYPES_OPT にあれば must、無ければ should）。
function getRuleLevel(type) {
  if (!RULE_LOCKED.has(type)) {
    const cfg = (AppState.settings && AppState.settings.ruleLevels) || {};
    const v = cfg[type];
    if (v === 'off' || v === 'should' || v === 'must') return v;
  }
  return MUST_TYPES_OPT.has(type) ? 'must' : 'should';
}
// エラーの種類 → 画面に出す日本語名。内部名（balance-diff など）を
// そのまま表示してしまうことがあったので、一か所にまとめて引けるようにする。
const VIOLATION_LABEL = {
  'understaff':        '人員不足',
  'overstaff':         '定数オーバー',
  'off-count':         '公休数不足',
  'offShort':          '公休の不足日数',
  'paid':              '有給が消化できない',
  'consecutive':       '連勤超過',
  'band-switch':       '早遅の切り替え回数',
  'late-early':        '遅→早（インターバル不足）',
  'category-switch':   '連勤中の時間帯切替',
  'bad-rest':          '遅→休→早（リズム）',
  'long-rest':         '連休が長すぎる',
  'pair-rest':         '切替時は2連休（個人ルール）',
  'pair-rest-count':   '連休の回数不足',
  'single-work':       '単発出勤',
  'single-off':        '単発休み',
  'balance-diff':      '早遅バランスのずれ',
  'hierarchy':         '責任者の順位',
  'skill-late':        'スキル不足',
  'skill-short':       'スキル目標に不足',
  'role-mismatch':     '担当外シフト',
  'pref-mismatch':     '早遅希望と不一致',
  'resp-duplicate':    '責任者・総務の重複',
  'vicemanager-absent': '副店長不在',
  'special-day':       '特別日の配置',
  'event-absent':      '行事日の欠勤',
  'night-after-work':  '夜勤明けの出勤',
  'rest-style':        '休み方の希望',
  'weekend-pref':      '土日休み希望',
};
function getViolationLabel(type) { return VIOLATION_LABEL[type] || 'その他のルール'; }

// そのルールが有効か（off でない）。スコアのペナルティ抑制に使う。
function ruleOn(type) { return getRuleLevel(type) !== 'off'; }
// 🔴（must）扱いの違反数。設定でmustにした/した分を動的に数える。
function countMustVios(vios) { return vios.filter(v => getRuleLevel(v.type) === 'must').length; }

// 最優先3項目（ユーザー要望で絶対0）: 人員不足・公休不足・連勤超過。
// 仕上げ・揺さぶりの採否はこの3項目を最優先し、次に🔴総数、最後に総違反数で比較する
// （🟡は残ってよいので、🟡を増やしてでも最優先3項目を消す判断ができるようにする）。
const P3_TYPES_OPT = new Set(['understaff', 'off-count', 'consecutive']);
function countP3Vios(vios) { return vios.filter(v => P3_TYPES_OPT.has(v.type)).length; }
// 辞書式キー [最優先3, 🔴総数, 総違反数]。小さいほど良い
function key3Of(vios) { return [countP3Vios(vios), countMustVios(vios), vios.length]; }
function better3(a, b) { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; }

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
    // 優先順: ①休みが余っている人（余セル or 公休が目標超過 → 渡しても公休不足にならない）
    //         ②前後どちらかで働いている人（渡した先が新たな単発出勤にならない）
    const cands = staffList
      .filter(Y => Y.id !== X && _polishMovable(shifts, Y.id, d) &&
                   !isWork(shifts[Y.id][d]) && (allowedOf[Y.id] || []).includes(role))
      .sort((a, b) => {
        const surplus = s => (shifts[s.id][d] === '余' ||
                              countOff(shifts, s, days) > (s.maxOff || 0)) ? 0 : 1;
        const adj = s => ((d > 1 && isWork(shifts[s.id][d - 1])) ||
                          (d < days && isWork(shifts[s.id][d + 1]))) ? 0 : 1;
        return (surplus(a) - surplus(b)) || (adj(a) - adj(b));
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
  // 玉突き再配置: 休ませる同僚が直接いなくても、X を休ませて空いた枠を
  // 二部マッチングで連鎖的に埋め直す（働いている人が役を移り、最終的に余の人が入る）。
  // guaranteeDayStaffingReal は不足日だけを対象にし、余から先に埋めるので、
  // 人員不足0を保ったまま連鎖の受け渡しで X を休ませられる。辞書式で改善時のみ採用。
  const tryRestViaCascade = (X, d, curMust) => {
    if (!_polishMovable(shifts, X, d) || !isWork(shifts[X][d])) return null;
    const snap = deepCopyShifts(shifts);
    shifts[X][d] = '休';
    guaranteeDayStaffingReal(shifts, staffList, reqs, dailyReqs); // 空いた枠を連鎖で再充足
    const nv = checkViolations(shifts), nm = countMustVios(nv);
    // 🔴総数が「確実に減る」ときだけ採用。連勤を1つ消す代わりに副店長不在などの
    // 別の🔴を作る（🔴総数が変わらない）トレードは禁止 ＝ 玉突きで悪化させない。
    if (nm < curMust) return { nv, nm };
    for (const sid in snap) shifts[sid] = snap[sid]; // 改善しなければ全面復帰
    return null;
  };
  let vios = checkViolations(shifts);
  let must = countMustVios(vios);
  for (let guard = 0; guard < 16; guard++) {
    let changed = false;
    const targets = vios.filter(v =>
      (v.type === 'single-work' || v.type === 'consecutive' || v.type === 'off-count') &&
      v.staffId && idset.has(v.staffId));
    // 最優先3項目（人員不足はguaranteeが担当）: 連勤超過・公休不足を単発より先に処理
    const TP = { 'consecutive': 0, 'off-count': 0, 'single-work': 1 };
    targets.sort((a, b) => (TP[a.type] ?? 2) - (TP[b.type] ?? 2));
    for (const v of targets) {
      const X = v.staffId;
      // 休ませる候補日: 単発はその日、連勤はブロック途中、公休不足は全出勤日
      let candDays;
      if (v.type === 'single-work') {
        candDays = [v.day];
      } else if (v.type === 'consecutive') {
        let a = v.day; while (a > 1 && isWork(shifts[X][a - 1])) a--;
        let b = v.day; while (b < days && isWork(shifts[X][b + 1])) b++;
        candDays = [];
        for (let d = a + 1; d <= b; d++) candDays.push(d); // 先頭は避け、途中で断つ
      } else if (v.type === 'off-count') {
        // 公休不足: 出勤している全日を候補に、余裕のある同僚へ枠を渡して X を休ませる
        candDays = [];
        for (let d = 1; d <= days; d++) if (isWork(shifts[X][d])) candDays.push(d);
      } else {
        candDays = [v.day - 1, v.day].filter(d => d >= 1);
      }
      for (const d of candDays) {
        const r = tryRestAndHandoff(X, d, { must, total: vios.length });
        if (r) { vios = r.nv; must = r.nm; changed = true; break; }
      }
      // 直接の受け渡しで無理な連勤超過・公休不足は、玉突き再配置（多段の受け渡し）で断つ。
      // X を休ませ、空いた枠を二部マッチングで連鎖的に埋め直す。余から充足するので
      // 新たな公休不足を作りにくく、人員不足0も保たれる。
      if (!changed && (v.type === 'consecutive' || v.type === 'off-count')) {
        let tries = 0;
        for (const d of candDays) {
          if (tries++ >= 8) break; // 1違反あたり最大8日まで（総当たりの暴走防止）
          const r = tryRestViaCascade(X, d, must); // 現在の🔴総数より確実に減る手だけ採用
          if (r) { vios = r.nv; must = r.nm; changed = true; break; }
        }
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

/**
 * 総合仕上げ: 🔴も🟡も含めて違反総数を減らすことを目指し、各種の掃除を
 * 収束するまで反復する。各パスは「違反が減る手だけ」採用し、人員不足は
 * 毎回 guaranteeDayStaffingReal で再保証するため増えない。最良盤面を保持し、
 * 改善が止まったら最良に戻して終了する（悪化しない）。
 * @returns {Array} 最終 violations
 */
function finalPolishLoop(shifts, groups, maxRounds) {
  const staff = AppState.staff || [];
  const days  = getDaysInMonth(AppState.settings.targetMonth);
  const guard = () => groups.forEach(g =>
    guaranteeDayStaffingReal(shifts, g.staff, g.reqs, g.dailyReqs));
  const single = () => groups.forEach(g =>
    eliminateSingleWork(shifts, g.staff, g.reqs, g.dailyReqs));

  // 各スタッフの担当可能シフト（研修除外・prefs適合）
  const candsOf = {};
  staff.forEach(s => {
    let base = (s.allowedShifts || []).filter(sh => {
      const t = AppState.shiftTypes.find(t => t.key === sh); return t && !t.isTraining;
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

  // 磨きひとまとめ（各パスは違反が減る手だけ採用。人員不足は毎回再保証）
  const polishOnce = () => {
    violationPolish(shifts, 4);
    guard();
    single();
    fixLockedBoundaryLates(shifts);
    mustFirstSwapPolish(shifts, 8);
    return sameDaySwapPolish(shifts, 12); // 掃除後の violations 配列を返す
  };

  // 揺さぶり: 同じ日に働く2人の役割をランダムに入れ替える（人数不変＝人員不足を作らない）。
  // 違反日周辺を優先的に狙って、局所最適から抜け出しやすくする。
  const perturb = (n, vios) => {
    const vdays = vios.filter(v => v.day >= 1).map(v => v.day);
    for (let k = 0; k < n; k++) {
      const d = (vdays.length && Math.random() < 0.7)
        ? vdays[Math.floor(Math.random() * vdays.length)]
        : Math.floor(Math.random() * days) + 1;
      const workers = staff.filter(s => _polishMovable(shifts, s.id, d) && isWork(shifts[s.id][d]));
      if (workers.length < 2) continue;
      const A = workers[Math.floor(Math.random() * workers.length)];
      const B = workers[Math.floor(Math.random() * workers.length)];
      if (A.id === B.id) continue;
      const va = shifts[A.id][d], vb = shifts[B.id][d];
      if (va === vb || !candsOf[A.id].includes(vb) || !candsOf[B.id].includes(va)) continue;
      shifts[A.id][d] = vb; shifts[B.id][d] = va;
    }
  };

  // まず磨いて基準を作る
  let bestVios  = polishOnce();
  let bestKey   = key3Of(bestVios);            // [最優先3, 🔴総数, 総違反数]
  let bestBoard = deepCopyShifts(shifts);

  // 軽い basin hopping: 揺さぶり→再磨き。辞書式キーで改善したら採用、しなければ最良へ
  // 戻す（絶対に悪化しない）。最優先3項目(不足/公休/連勤)を最優先で消し、そのためなら
  // 🟡が増えてもよい。連続で改善が無ければ打ち切る（時間対効果のバランス）。
  const rounds = (maxRounds || 8);
  let stale = 0;
  for (let round = 0; round < rounds && bestKey[2] > 0; round++) {
    const strength = 2 + Math.min(4, stale); // 停滞するほど少し大きく揺さぶる
    perturb(strength, bestVios);
    const nv = polishOnce();
    const nk = key3Of(nv);
    if (better3(nk, bestKey)) {
      bestKey = nk; bestBoard = deepCopyShifts(shifts); bestVios = nv; stale = 0;
    } else {
      for (const sid in bestBoard) shifts[sid] = Object.assign({}, bestBoard[sid]); // 最良へ復帰
      if (++stale >= 4) break; // 4回連続で改善なし → 打ち切り
    }
  }
  for (const sid in bestBoard) shifts[sid] = Object.assign({}, bestBoard[sid]);
  return checkViolations(shifts);
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
          // 最優先3(不足/公休/連勤)→🔴総数→総数の辞書式で改善する入替だけ採用。
          // 🔴を増やして🟡を減らす（総数だけ下げる）手は採らない。
          if (better3(key3Of(nv), key3Of(vios))) { vios = nv; improved = true; break; }
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
  let curMust  = countMustVios(vios);
  let curScore = calculateScore(shifts, allowedMap, days, P);
  // 受理条件（辞書式）: ①🔴(MUST)件数は絶対に増やさない → ②総違反件数が減る →
  // ③同数ならスコア改善。これにより「リズムを直す代わりに人員不足を作る」等の
  // 🔴を増やす手は決して採用しない（自動調整で定数不足が出る問題の根治）。
  const tryMove = (apply, undo) => {
    apply();
    const nv = checkViolations(shifts);
    const nm = countMustVios(nv);
    if (nm > curMust) { undo(); return false; }        // 🔴が増える手は却下
    if (nm < curMust) {                                // 🔴が減るなら即採用
      vios = nv; curMust = nm; curScore = calculateScore(shifts, allowedMap, days, P); return true;
    }
    if (nv.length < vios.length) {                     // 🔴同数で総数が減る
      vios = nv; curScore = calculateScore(shifts, allowedMap, days, P); return true;
    }
    if (nv.length === vios.length) {                   // 同点はスコアで前進
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
function forceFillUnderstaffingReal(shifts, staffList, reqs, dailyReqs) {
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
  const dayReq = (sh, d) => getDayReq(reqs || AppState.roleRequirements, dailyReqs || {}, sh, d);
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
      // ① 休み（余含む）から補充。
      //    まず「余（余剰休み）」を先に消費し、目標公休（公休）は極力崩さない
      //    ＝人員不足を埋めても公休不足を新たに作らない。同カテゴリ内では
      //    連勤になりにくい人（前後が休みの人）を優先する。
      const isSurplus = s => shifts[s.id][d] === '余';
      const resting = staff
        .filter(s => movable(s, d) && canDo(s) && !isWork(shifts[s.id][d]))
        .sort((a, b) => {
          const sa = isSurplus(a) ? 0 : 1, sb = isSurplus(b) ? 0 : 1;
          if (sa !== sb) return sa - sb;               // 余を先に使う
          return consLenIfWork(a) - consLenIfWork(b);  // 次に連勤になりにくい人
        });
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
function guaranteeDayStaffingReal(shifts, staffList, reqs, dailyReqs) {
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
  const dayReq = (sh, d) => getDayReq(reqs || AppState.roleRequirements, dailyReqs || {}, sh, d);
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
    // マッチングで休みの人を引き込む際の優先順位: 既に出勤中(0) → 余剰休み「余」(1)
    // → 目標公休など(2)。これで不足を埋めるとき「余」を先に消費し、目標公休を
    // 崩して公休不足を新たに作ることを避ける（最大マッチングの充足性は不変）。
    avail.sort((a, b) => {
      const rank = s => isWork(shifts[s.id][d]) ? 0 : (shifts[s.id][d] === '余' ? 1 : 2);
      return rank(a) - rank(b);
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
 *   A(早責)→休
 *   C(早)→早責
 *   E(早総務)→早
 *   F(余剰休)→早総務  ← これでFの余剰を活用できる！
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
 *         例: A(遅責)↔B(早責) → Aが前日と同カテゴリになる
 * 方法2: 切替日(d) ↔ 同人の「前日と同カテゴリの出勤日(d3)」を交換 → 時系列を整列
 * 方法3: 切替日(d) ↔ 同人の休み日(d3) を交換 → 連続ブロック分断
 */
function tryFixCategorySwitch(shifts, locked, staff, days, allowedShifts) {
  const shuffledStaff = [...staff];
  shuffleArray(shuffledStaff);

  for (const s of shuffledStaff) {
    // カテゴリ切替違反を収集
    const violations = [];
    const _pme    = getPrevMonthEnd(s);   // 前月末シフト単独でも有効にする
    let consWork  = _pme.cons;
    let prevShift = _pme.lastShift;
    const prevWorked = _pme.cons > 0;     // 前月末が出勤で終わっていたか（バンド不明でも真）
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
 *   → 日別カバレッジ不変。A の公休+1（公休不足の A/B に有効）
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
    if (hasVice && viceWorking === 0 && !chiefCovered && ruleOn('vicemanager-absent')) score += (P.viceManagerDailyAbsent || 9000);
    shiftKeys.forEach(k => {
      const req = optDayReq(k, d);
      if (!req) return;
      const diff = req - counts[k];
      if (diff > 0) score += diff * P.understaff;
      // 責任者・総務（早責/遅責/早総/遅総）は同じ時間帯に2人いてはいけないため重罰
      else if (diff < 0) score += (-diff) * ((SOLO_SHIFT_KEYS.includes(k) && ruleOn('resp-duplicate')) ? P.respDuplicate : P.overstaff);
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
          if (ruleOn('skill-late'))  score += (min - have) * (P.skillLateShortage || 9000); // 最低ライン割れ（強）
          if (ruleOn('skill-short')) score += (need - min) * (P.skillSoftShortage || 1500);
        } else if (have < need) {
          if (ruleOn('skill-short')) score += (need - have) * (P.skillSoftShortage || 1500); // 目標には届かない（弱）
        }
      });
    }

    // 責任者ヒエラルキー違反（pref フィルタ済み allowedShifts で判定）
    if (respEarlyPerson && staff.some(s =>
          s.id !== respEarlyPerson.id &&
          isWork(shifts[s.id][d]) && isEarlyCategory(shifts[s.id][d]) && !isTraining(shifts[s.id][d]) &&
          (allowedShifts[s.id] || s.allowedShifts || []).includes('早責') &&
          getStaffPriority(s) < getStaffPriority(respEarlyPerson))) {
      if (ruleOn('hierarchy')) score += P.hierarchyViolation;
    }
    if (respLatePerson && staff.some(s =>
          s.id !== respLatePerson.id &&
          isWork(shifts[s.id][d]) && isLate(shifts[s.id][d]) &&
          (allowedShifts[s.id] || s.allowedShifts || []).includes('遅責') &&
          getStaffPriority(s) < getStaffPriority(respLatePerson))) {
      if (ruleOn('hierarchy')) score += P.hierarchyViolation;
    }
  }

  // イベント日: 対象スタッフが休んでいたら重罰
  (AppState.events || []).forEach(ev => {
    if (!ev || !ev.day || ev.day < 1 || ev.day > days) return;
    (ev.staffIds || []).forEach(sid => {
      if (!shifts[sid]) return; // 他部門のスタッフは対象外
      if (!isWork(shifts[sid][ev.day]) && ruleOn('event-absent')) score += (P.eventAbsent || 20000);
    });
  });

  // 曜日を事前計算（個人希望: 土日休み判定用）
  const _wd = [0];
  for (let d = 1; d <= days; d++) _wd[d] = getWeekday(AppState.settings.targetMonth, d);

  // 横: 各スタッフのルール
  staff.forEach(s => {
    const _pme    = getPrevMonthEnd(s);   // 前月末シフト単独でも有効にする
    let consWork  = _pme.cons;
    let prevShift = _pme.lastShift;
    const prevWorked = _pme.cons > 0;     // 前月末が出勤で終わっていたか（バンド不明でも真）
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
        const myMaxCons = getMaxConsFor(s); // 個人の連勤上限（超えたら絶対NG）
        if (consWork > myMaxCons) {
          // 連勤上限超過は🔴（絶対NG）。個人設定で5勤OKにした人だけ5まで許容。
          const over = consWork - myMaxCons;
          score += P.consBase * over + P.consSq * over * over;
        }

        // 個人希望: 土日休み（土日に出勤したら減点）
        if (wkW && (_wd[d] === 0 || _wd[d] === 6) && ruleOn('weekend-pref')) score += wkW;
        // 個人希望: 分散派（勤務は3連勤前後まで。4日目以降に減点）
        if (styleSpread && consWork > 3 && ruleOn('rest-style')) score += styleW;

        // 遅→早禁止
        if (AppState.settings.forbidLateEarly && isLate(prevShift) && isEarlyCategory(cur) && ruleOn('late-early')) {
          score += P.lateEarly;
        }

        // prefs（早遅希望）違反: checkViolations と整合させてスコアに反映
        if (s.prefs && s.prefs.length > 0 && ruleOn('pref-mismatch')) {
          if (isEarlyCategory(cur) && !s.prefs.includes('早可')) score += (P.prefMismatch || 12000);
          if (isLate(cur)          && !s.prefs.includes('遅可')) score += (P.prefMismatch || 12000);
        }

        // 夜勤翌日は必ず休み
        if (isNight(prevShift) && ruleOn('night-after-work')) score += (P.nightAfterWork || 8000);

        // 連勤中の時間帯切替
        if (consWork >= 2 && isWork(prevShift)) {
          const pc = getShiftCategory(prevShift), cc = getShiftCategory(cur);
          if (pc && cc && pc !== cc && ruleOn('category-switch')) score += P.categorySwitch;
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
          // 連休は設定した上限日数まで（有給も連休に数える。「余」は人員余りの都合なので除外）
          if (cur !== '余') {
            pubRun++;
            if (pubRun > getMaxOffRunFor(s)) {
              const restLocked =
                isOff((AppState.requests[s.id]    || {})[d]) ||
                isOff((AppState.fixedShifts[s.id] || {})[d]);
              if (!restLocked && ruleOn('long-rest')) score += (P.longRest || 2000);
            }
          } else {
            pubRun = 0; // 「余」は連休を分断
          }
        }
        consWork = 0;

        // 個人希望: 連休派（ポツンと1日だけの休みに減点 → 連休にまとまる方向へ）
        if (stylePair && cur !== '余' && d > 1 && d < days) {
          const pvP = shifts[s.id][d - 1], nxP = shifts[s.id][d + 1];
          if (isWork(pvP) && isWork(nxP) && ruleOn('rest-style')) score += styleW;
        }

        // 個人ルール: 遅→早の切替時は2連休以上必須（遅→休1日→早 を強く禁止）
        if (s.needPairRest && d > 1 && d < days) {
          const pv2 = shifts[s.id][d - 1], nx2 = shifts[s.id][d + 1];
          if (isWork(pv2) && isWork(nx2) && isLate(pv2) && isEarlyCategory(nx2) && ruleOn('pair-rest')) {
            score += (P.lateEarly || 2500) * 2;
          }
        }

        // 単発休みペナルティ
        if (AppState.settings.penaltySingleOff && d > 1 && d < days) {
          const pv = shifts[s.id][d - 1], nx = shifts[s.id][d + 1];
          if (isWork(pv) && isWork(nx)) {
            if (isLate(pv) && isEarlyCategory(nx)) { if (ruleOn('bad-rest')) score += P.badRest; }
            else score += P.singleOff;
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
        if (!isWork(shifts[s.id][d - 1]) && !isWork(shifts[s.id][d + 1]) && ruleOn('single-work')) score += P.singleWork;
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

    // 公休不足のみペナルティ（余剰は余力として許容、targetedムーブで自然に削減）。
    // 二次項を足して「一人に不足が集中」を強く罰する＝負担を全員に分散させる
    // （例: 1人が-5 は、5人が-1 よりずっと高コストになる）。
    const offDiff = offCount - (s.maxOff || 0);
    if (offDiff < 0) {
      const short = -offDiff;
      score += short * P.offShortage + short * short * (P.offShortageSq || 1500);
    }

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
    const _pme    = getPrevMonthEnd(s);   // 前月末シフト単独でも有効にする
    let consWork  = _pme.cons;
    let prevShift = _pme.lastShift;
    const prevWorked = _pme.cons > 0;     // 前月末が出勤で終わっていたか（バンド不明でも真）
    let offCount  = 0;
    let offRun    = 0;
    let earlyBand = 0, lateBand = 0;   // 早遅バランス判定用（研修は早番帯として数える）
    let surplusN  = 0;                 // 「余」の日数（余剰休みの希望どおりか見るため）
    // キャスト（パート的な少日数勤務）は、単発出勤・長期連休・切替などの
    // リズム系ルールを適用しない（部分勤務では自然に起きるためノイズになる）。
    // 人員不足・スキル・担当外などの構造ルールは通常どおり適用される。
    const isCast = getStaffDepartment(s) === 'cast';
    const effectiveAllowed = (s.allowedShifts || []).concat(['研']); // 研は全員許容
    const reportedDays = new Set();
    // 連勤超過は、1回の連勤につき1件のまま、連勤が続くあいだ中身を更新する。
    // これまでは上限を超えた日に「5連勤」と出して終わりだったため、10連勤でも
    // 「5連勤・1件」と数えられ、5連勤2回を10連勤1回にまとめると🚨が減った
    // ように見えていた。表示は実際の日数にし、答えを比べるときの重み(weight)は
    // 上限を超えた日数にする（早遅バランスと同じ考え方）。
    let openCons = null;
    let consHalf = false;   // いまの連勤に半休が入っているか（注記を連勤の最後まで残すため）
    // 1回の連勤につき1件。len=実際の日数、over=上限を超えた日数、
    // compliance=6連勤以上（上限の設定に関係なくコンプラ違反）。
    const noteCons = (d, lim) => {
      const extra = consHalf ? '　※半休も出勤に数えます' : '';
      const over = Math.max(0, consWork - lim);
      const comp = consWork >= COMPLIANCE_CONS_DAYS;
      const pers = s.personalMaxCons > 0 ? '・個人設定' : '';
      const msg = comp
        ? `⛔ コンプラ違反：${consWork}連勤（6連勤以上は不可。上限${lim}日${over > 0 ? `を${over}日超過` : ''}${pers}）${extra}`
        : `🚨 ${consWork}連勤（上限${lim}日を${over}日超過${pers}）${extra}`;
      const o = openCons || { staffId: s.id, day: d, type: 'consecutive',
                              action: '他の日と入れ替えて休みを挟んでください' };
      // from が 1 より小さいときは前月から続いている
      Object.assign(o, { len: consWork, over, compliance: comp, weight: over, message: msg,
                         from: d - consWork + 1, to: d });
      if (!openCons) { openCons = o; violations.push(o); }
    };
    const wkHard     = s.weekendPref === 'hard';
    const wkSoft     = s.weekendPref === 'soft';
    const pairHard   = s.restStyle === 'pair-hard';
    const pairSoft   = s.restStyle === 'pair-soft';
    const spreadHard = s.restStyle === 'spread-hard';
    const spreadSoft = s.restStyle === 'spread-soft';
    let pairRestBlocks = 0;   // 2連休以上のかたまりの数（連休の目安回数の判定用）

    // 半休は「半分は働いている日」。連勤は切れず、休みとしても数えない。
    const workedOn = (v) => isWork(v) || isHalfWork(v);
    // 半休の時間帯は早番扱い（遅→半、遅→休→半 を通常の遅→早と同じく避ける）。
    // 早番・遅番の割合を数えるときは除くので、ここでは並びの判定にだけ使う。
    const earlySide = (v) => isEarlyCategory(v) || isHalfWork(v);
    for (let d = 1; d <= days; d++) {
      const cur = (shifts[s.id] || {})[d] || '';
      const halfW = isHalfWork(cur);

      if (halfW) {
        // 連勤を数え、時間帯は早番扱いで「遅→早」だけ見る（割合には数えない）
        consWork++;
        if (!isCast && settings.forbidLateEarly && isLate(prevShift)) {
          violations.push({
            staffId: s.id, day: d, type: 'late-early',
            message: `🚨 遅→半休（インターバル不足・半休は早番扱い）`,
            action:  '順序を入れ替えてください',
          });
        }
        const myMaxConsH = getMaxConsFor(s);
        consHalf = true;
        if (consWork > myMaxConsH || consWork >= COMPLIANCE_CONS_DAYS) noteCons(d, myMaxConsH);
        if (!workedOn((shifts[s.id] || {})[d + 1] || '')) { openCons = null; consHalf = false; }
        offRun = 0;          // 休みの連続を切る
        prevShift = '';      // 時間帯は引き継がない（遅→早の誤判定を防ぐ）
        continue;
      }

      if (isWork(cur)) {
        consWork++;
        if (isLate(cur)) lateBand++; else if (isEarlyCategory(cur)) earlyBand++;
        const myMaxCons = getMaxConsFor(s); // 連勤上限（4 or 個人設定。超えたら🔴絶対NG）
        if (consWork > myMaxCons || consWork >= COMPLIANCE_CONS_DAYS) noteCons(d, myMaxCons);
        if (!workedOn((shifts[s.id] || {})[d + 1] || '')) { openCons = null; consHalf = false; } // 連勤が切れたら次は別の1件

        // 個人希望: 土日休み（絶対＝🚨 / なるべく＝⚠️）
        if ((wkHard || wkSoft) && (_wdv[d] === 0 || _wdv[d] === 6) && ruleOn('weekend-pref')) {
          violations.push({
            staffId: s.id, day: d, type: 'weekend-pref',
            message: `${wkHard ? '🚨' : '⚠️'} ${_wdv[d] === 0 ? '日曜' : '土曜'}に出勤（個人希望: 土日休み・${wkHard ? '絶対' : 'なるべく'}）`,
            action:  'この日を休みにして平日の休みと入れ替えてください',
          });
        }
        // 個人希望: 分散派（勤務は3連勤まで）
        if ((spreadHard || spreadSoft) && consWork === 4 && !reportedDays.has('sp' + d) && ruleOn('rest-style')) {
          violations.push({
            staffId: s.id, day: d, type: 'rest-style',
            message: `${spreadHard ? '🚨' : '⚠️'} 4連勤以上（個人希望: こまめに分散・${spreadHard ? '絶対' : 'なるべく'}）`,
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
        // 1日目は前月末の状態で判定する（前月末が休みなら1日目の孤立出勤も単発）
        if (!isCast && settings.penaltySingleOff && d < days) {
          const nx = (shifts[s.id] || {})[d + 1] || '';
          const prevIsWork = (d === 1) ? prevWorked : workedOn((shifts[s.id] || {})[d - 1] || '');
          if (!prevIsWork && !workedOn(nx)) {
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
        if (cur === '余') surplusN++;
        if (isPublicOff(cur)) offCount++; // 公休のみカウント（有給・季節休暇は別枠）
        // 2連休以上のかたまりの数（前日が出勤で、当日と翌日が休みなら1回）
        if (cur !== '余' && !isWork((shifts[s.id] || {})[d + 1] || '') && d < days) {
          const _pv = (d > 1) ? ((shifts[s.id] || {})[d - 1] || '') : prevShift;
          const _nx = (shifts[s.id] || {})[d + 1] || '';
          if (_nx && _nx !== '余' && (d === 1 ? !prevWorked : isWork(_pv))) pairRestBlocks++;
        }
        consWork = 0;

        // 連休は設定した上限日数まで（有給も連休に数える。「余」は除外）
        if (isOff(cur) && cur !== '余') {
          offRun++;
          const restLocked =
            isOff((AppState.requests[s.id]    || {})[d]) ||
            isOff((AppState.fixedShifts[s.id] || {})[d]);
          const _maxRun = getMaxOffRunFor(s);
          if (!isCast && offRun === _maxRun + 1 && !restLocked && !reportedDays.has('rest' + d)) {
            violations.push({
              staffId: s.id, day: d, type: 'long-rest',
              message: `⚠️ ${offRun}連休以上（連休は最大${_maxRun}日まで${s.personalMaxOff > 0 ? '・個人設定' : ''}）`,
              action:  `${_maxRun + 1}日以上の連休は、必要なら希望休として手動で入れてください`,
            });
            reportedDays.add('rest' + d);
          }
        } else {
          offRun = 0;
        }

        // 個人希望: 連休派（ポツンと1日だけの休みはNG）
        if ((pairHard || pairSoft) && ruleOn('rest-style') && cur !== '余' && d > 1 && d < days) {
          const pvP = (shifts[s.id] || {})[d - 1] || '';
          const nxP = (shifts[s.id] || {})[d + 1] || '';
          if (isWork(pvP) && isWork(nxP)) {
            violations.push({
              staffId: s.id, day: d, type: 'rest-style',
              message: `${pairHard ? '🚨' : '⚠️'} 単独の1日休み（個人希望: 連休・${pairHard ? '絶対' : 'なるべく'}）`,
              action:  '前後どちらかの日も休みにして連休にしてください',
            });
          }
        }

        // 1日目は前月末シフトを「前日」として judge する（月をまたぐ孤立休みを検出するため）
        const prevOf = (dd) => (dd > 1) ? ((shifts[s.id] || {})[dd - 1] || '') : prevShift;
        // 個人ルール: 遅→早の切替時は2連休以上必須
        if (s.needPairRest && d >= 1 && d < days) {
          const pv = prevOf(d);
          const nx = (shifts[s.id] || {})[d + 1] || '';
          if (workedOn(pv) && workedOn(nx) && isLate(pv) && earlySide(nx)) {
            violations.push({
              staffId: s.id, day: d, type: 'pair-rest',
              message: `🚨 遅→休1日→早（個人ルール: 切替時は2連休以上）${d === 1 ? '・前月末から継続' : ''}`,
              action:  '休みを2連休以上にするか、時間帯を揃えてください',
            });
          }
        } else if (!isCast && settings.penaltySingleOff && d >= 1 && d < days) {
          const pv = prevOf(d);
          const nx = (shifts[s.id] || {})[d + 1] || '';
          if (isLate(pv) && earlySide(nx)) {
            violations.push({
              staffId: s.id, day: d, type: 'bad-rest',
              message: `⚠️ ${isHalfWork(nx) ? '遅→休→半休' : isTraining(nx) ? '遅→休→研' : '遅→休→早'}（リズムが悪い）${d === 1 ? '・前月末から継続' : ''}`,
              action:  '時間帯を揃えてください',
            });
          }
        }
        prevShift = cur;
      }
    }

    // 早番⇔遅番の切り替え回数（1人・月 maxBandSwitch 回まで）。生成の計算（'band-switch'）と
    // 同じ数え方にする: 休みの日は直前の時間帯を引き継ぐ、半休は早番扱い、研修もその時間帯で数える。
    // 対象も生成と同じく、早番・遅番の両方を担当でき、「早番のみ／遅番のみ」でない人だけ。
    // これまで生成の中だけで数えていて、検査・画面・4通りから選ぶ所では見ていなかった。
    if (ruleOn('band-switch')) {
      const keys = s.allowedShifts || [];
      const both = keys.some(k => isEarlyCategory(k)) && keys.some(k => isLate(k));
      const rOnly = (typeof getBalanceRatio === 'function') ? getBalanceRatio(s) : null;
      if (both && !(rOnly && rOnly.only)) {
        const cap = Math.max(0, parseInt(settings.maxBandSwitch != null ? settings.maxBandSwitch : 2, 10) || 0);
        let prevB = null, n = 0; const swDays = [];
        for (let d = 1; d <= days; d++) {
          const v = (shifts[s.id] || {})[d] || '';
          const b = isHalfWork(v) ? 'e' : (isWork(v) ? (isEarlyCategory(v) ? 'e' : (isLate(v) ? 'l' : null)) : null);
          if (!b) continue;
          if (prevB && b !== prevB) { n++; swDays.push(d); }
          prevB = b;
        }
        if (n > cap) {
          const must = getRuleLevel('band-switch') === 'must';
          violations.push({
            staffId: s.id, day: swDays[cap], to: swDays[swDays.length - 1], type: 'band-switch', over: n - cap, weight: n - cap, count: n,
            message: `${must ? '🚨' : '⚠️'} 早遅の切り替え ${n}回（月${cap}回まで・${n - cap}回超過）　切り替えた日: ${swDays.join('・')}日`,
            action: '早番・遅番の時間帯をまとめてください（切り替える日を減らす）',
          });
        }
      }
    }

    // 公休不足のみ報告（超過は余剰人員のため許容）。
    // キャストは勤務が固定契約ベースのため公休数は目安扱い（エラーにしない）。
    const diff = offCount - (s.maxOff || 0);
    if (!isCast && diff < 0) {
      violations.push({
        staffId: s.id, day: 0, type: 'off-count', short: -diff,   // 足りない日数（比べ方で使う）
        message: `🚨 公休数 ${offCount}日（目標${s.maxOff}日, 差${diff}）`,
        action:  '公休数を増やしてください',
      });
    }

    // 有給の日数。これまで検査していなかったため、手で直したり入れ替え案を
    // 使ったりして有給が別の人へ移っても、エラーにならなかった。
    // 少ないとき: 設定の日数に届いていない。
    // 多いとき:   設定の日数も、本人が希望で入れた日数も超えている
    //             （本人の希望で設定より多く取るのは正しいので数えない）。
    if (!isCast) {
      const want = parseInt(s.paidLeave) || 0;
      let got = 0, asked = 0;
      for (let d = 1; d <= days; d++) {
        if (((shifts[s.id] || {})[d]) === '有') got++;
        const lk = (AppState.requests[s.id] || {})[d] ||
                   (typeof getFixedShiftAt === 'function' ? getFixedShiftAt(s.id, d) : null);
        if (lk === '有') asked++;
      }
      if (got < want) {
        violations.push({
          staffId: s.id, day: 0, type: 'paid',
          message: `⚠️ 有給 ${got}日（設定${want}日, 差${got - want}）`,
          action:  '有給を設定の日数まで入れてください',
        });
      } else if (got > Math.max(want, asked)) {
        violations.push({
          staffId: s.id, day: 0, type: 'paid',
          message: `⚠️ 有給 ${got}日（設定${want}日より多い）`,
          action:  '有給を設定の日数に戻してください',
        });
      }
    }

    // 連休（2連休以上）の回数が目安に届いているか
    if (!isCast && ruleOn('pair-rest-count')) {
      const prTarget = (parseInt(s.pairRestTarget) > 0)
        ? parseInt(s.pairRestTarget)
        : (parseInt(settings.pairRestTarget) || 0);
      if (prTarget > 0 && pairRestBlocks < prTarget) {
        violations.push({
          staffId: s.id, day: 0, type: 'pair-rest-count',
          message: `⚠️ 連休（2連休以上）が ${pairRestBlocks}回（目安 ${prTarget}回）`,
          action:  '休みをまとめて2連休にすると回数が増えます',
        });
      }
    }

    // 早遅バランス（早番多め/遅番多め など）のずれ。
    // 早番帯・遅番帯の両方に入れる人だけが対象（片方しか入れない人は判定しない）。
    if (ruleOn('balance-diff')) {
      const ratio = getBalanceRatio(s);   // 「指定なし(OFF)」の人は null → 判定しない
      // 研は全員が入れるので判定から除く（担当シフトで早遅どちらも選べる人だけが対象）
      const myShifts = (s.allowedShifts || []);
      const canE  = myShifts.some(sh => isEarlyCategory(sh));
      const canL  = myShifts.some(sh => isLate(sh));
      const total = earlyBand + lateBand;
      if (ratio && canE && canL && total > 0) {
        const tol  = Math.max(0, parseInt(settings.balanceTolerance) || 0);
        const want = total * ratio.earlyRatio;
        const gap  = earlyBand - want;                 // ＋なら早番が多すぎ
        if (Math.abs(gap) > tol + 1e-9) {
          const over = gap > 0 ? '早番' : '遅番';
          // 許容幅を超えた「日数ぶん」を件数として数える。
          // 1件固定だと、2日のずれも13日のずれも同じ重さになり、
          // 複数の解を比べるときに大きく崩れた表が選ばれてしまう。
          const excess = Math.max(1, Math.round(Math.abs(gap) - tol));
          // 1人のずれは「1件」として出す。同じ文面を何度も並べると、
          // 直すところが1か所なのに大量のエラーが出たように見えてしまう。
          // ずれの大きさは weight に持たせ、複数の表を比べるときに使う。
          violations.push({
            staffId: s.id, day: 0, type: 'balance-diff', weight: excess,
            message: `⚠️ 早遅バランスのずれ（${ratio.label}: 早${earlyBand}/遅${lateBand}、目標 早${want.toFixed(1)}）`
                   + (excess > 1 ? `　※許容${tol}日を${excess}日ぶん超過` : ''),
            action:  `${over}を${Math.abs(gap).toFixed(1)}日ぶん減らすと目標比率に近づきます`,
          });
        }
      }
    }
  });

  // 特別日（入れ替え日＝副店長が遅責 / 新装日＝副店長が早責）に入っているか
  if (ruleOn('special-day')) {
    const vmsAll = staff.filter(s => s.positionType === 'viceManager');
    Object.keys(AppState.specialDays || {}).forEach(k => {
      const d = parseInt(k); if (!(d >= 1 && d <= days)) return;
      const kind = AppState.specialDays[k];
      if (kind !== 'replacement' && kind !== 'renewal') return;
      const role = (kind === 'replacement') ? '遅責' : '早責';
      const ok = vmsAll.some(vm => ((shifts[vm.id] || {})[d] || '') === role);
      if (!ok && vmsAll.length) {
        violations.push({
          staffId: (vmsAll[0] || {}).id || '', day: d, type: 'special-day',
          message: `⚠️ ${kind === 'replacement' ? '入れ替え日' : '新装日'}に副店長が「${role}」に入っていません`,
          action:  `副店長のいずれかをこの日の${role}にしてください`,
        });
      }
    });
  }

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
    const baseNeed = (sk.req != null ? sk.req : (sk.lateReq || 0));
    // 既定が0でも日別上書きがあれば判定する
    if (!baseNeed && !hasDailySkillOverride(sk.name)) return;
    const target = sk.target || 'late';
    const label  = target === 'early' ? '早番' : '遅番';
    const inTarget = (sh) => target === 'early' ? isEarlyCategory(sh) : isLate(sh);
    for (let d = 1; d <= days; d++) {
      // 目標人数・最低ラインは日別上書きを反映
      const { need, min } = getDaySkillReq(sk, d);
      if (!need && !min) continue;
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
        // 必要人数より多く配置されている（定数オーバー）。
        // 責任者・総務は上の resp-duplicate で扱うので、ここでは通常シフトのみ。
        // ※ 必要人数を0にした日も対象（req が 0 でも超過は超過）
        if (!SOLO_SHIFT_KEYS.includes(k) && counts[k] > req && ruleOn('overstaff')) {
          violations.push({
            staffId: null, day: d, type: 'overstaff',
            message: `⚠️ ${d}日 ${gLabel}${k} が${counts[k]}人（必要${req}人・${counts[k] - req}人多い）`,
            action:  req === 0
              ? 'この日は0人の設定です。余った人は休み・有給に回すか、必要人数を見直してください'
              : '余った人は他の日へ移すか、この日の必要人数を見直してください',
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

  // ルール設定が off の違反タイプは報告しない（既定では off は無いので従来どおり）
  // 「途中から作り直す」で確定済みにした前半は、もう直せないのでエラーに数えない。
  // ただし月単位の違反（公休数・早遅バランスなど・day=0）は後半で調整できるため残す。
  // 連勤は、終わった日（to）で前半か後半かを決める。上限を超えた日（day）で決めると、
  // 確定した前半から後半へ続いて6連勤以上になった連勤が数えられなかった。
  // 早遅の切り替えも同じく、最後に切り替えた日（to）で決める。上限を超えた日で決めると、
  // 前半だけで上限を超えた人は、後半の切り替えも検査から消えていた。
  const cut = parseInt(AppState.settings.ignoreVioBeforeDay) || 0;
  const dayOf = (v) => ((v.type === 'consecutive' || v.type === 'band-switch') && v.to) ? v.to : v.day;
  return violations.filter(v => getRuleLevel(v.type) !== 'off')
                   .filter(v => !(cut > 1 && dayOf(v) > 0 && dayOf(v) < cut));
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
/**
 * いまの表を「定数を崩さずに」直す具体案を探す。
 *
 * 使う操作は「同じ日の2人のシフトを入れ替える」だけ。この操作なら、その日に
 * 何人が何の役割に入っているかが変わらないので、必要人数は絶対に崩れない。
 * 希望・固定で決まっているマスは動かさない。担当できないシフトにも入れない。
 *
 * 「再実行するか手動で直してください」では誰の何日を直すのか分からない、
 * という声への対応。1手で減る案を全部出し、足りなければ2手の組合せも探す。
 *
 * @param {Object} [opt] {maxResults:件数, deep:2手も探すか, onProgress:fn}
 * @returns {Array<{steps:Array, before:number, after:number, gain:number}>}
 */
/**
 * 答えの良し悪しを比べる共通の物差し。どこで比べるときも必ずこれを使う
 * （4通りから選ぶ所・仕上げ・入れ替え案・エラー自動修正・余の解消・手で直したときの警告）。
 *
 * 考え方（利用者と決めたこと）:
 *  ・🚨は種類をまたいで交換しない。どの種類の🚨も増やさない。
 *  ・連勤は「回数」と「上限を超えた日数」の両方で見る。10連勤1回と5連勤2回は
 *    同じくらい悪いので、どちらかへ組み替えることを改善とみなさない。
 *  ・6連勤以上はコンプライアンス違反（上限の設定に関係なく）。
 *
 * 返す値:
 *   comp  … 6連勤以上の回数（コンプラ違反）
 *   under … 人員不足の件数
 *   must  … 🚨の件数（連勤は回数で数える。6連勤以上も含む）
 *   over  … 連勤の、上限を超えた日数の合計
 *   offShort … 公休の足りない日数の合計（件数 byMust['off-count'] は足りない人数。連勤の回数と超過日数と同じく、
 *              人数と日数の両方を見る）
 *   bsOver … 早遅の切り替えの超過回数（「絶対」のときだけ数える）
 *   soft  … 🟡の件数
 *   byMust… 🚨の種類ごとの件数
 *   count / total … 全部の件数（表示用） / mustCount … must と同じ（表示用）
 */
function scoreViolations(vs) {
  const r = { comp: 0, under: 0, must: 0, over: 0, bsOver: 0, offShort: 0, soft: 0, count: 0, byMust: {} };
  (vs || []).forEach(v => {
    if (!v) return;
    r.count++;
    if (getRuleLevel(v.type) === 'must' || MUST_TYPES_OPT.has(v.type)) {
      r.must++;
      r.byMust[v.type] = (r.byMust[v.type] || 0) + 1;
    } else {
      r.soft++;
    }
    if (v.type === 'consecutive') { r.over += (v.over || 0); if (v.compliance) r.comp++; }
    if (v.type === 'understaff') r.under++;
    // 公休の足りない日数の合計（offShort）。件数は「足りない人数」なので、連勤（回数と超過日数）と同じく日数も見る
    if (v.type === 'off-count' && (getRuleLevel(v.type) === 'must' || MUST_TYPES_OPT.has(v.type))) r.offShort += (v.short || 0);
    // 早遅の切り替えを「絶対」にしているときは、超えた回数も連勤の超過日数と同じように見る
    if (v.type === 'band-switch' && getRuleLevel('band-switch') === 'must') r.bsOver += (v.over || 0);
  });
  r.total = r.count;
  r.mustCount = r.must;
  return r;
}
// a は b より「改善」か（基本の判定）。
//   どの🚨の種類の件数も、連勤の超過日数も、6連勤以上の回数も増えず、
//   そのどれかが減ること。🚨がすべて同じときだけ、🟡の件数が減れば改善。
//   どこかが減ってどこかが増えた（交換した）ものは改善ではない。
function scoreBetter(a, b) {
  let less = false;
  const keys = new Set(Object.keys(a.byMust).concat(Object.keys(b.byMust)));
  for (const k of keys) {
    const x = a.byMust[k] || 0, y = b.byMust[k] || 0;
    if (x > y) return false;
    if (x < y) less = true;
  }
  // 公休の足りない日数の合計も、連勤の超過日数と同じく増やさない（利用者の判断 2026年9月26日）。
  // はじくのは「足りない日数の合計が増える案」。合計が同じまま足りない人数が減る案（1人に寄せる案を含む）は、
  // 連勤（回数が減り超過日数が同じ）と同じく改善のまま。
  if (a.over > b.over || a.comp > b.comp || (a.bsOver || 0) > (b.bsOver || 0) || (a.offShort || 0) > (b.offShort || 0)) return false;
  if (a.over < b.over || a.comp < b.comp || (a.bsOver || 0) < (b.bsOver || 0) || (a.offShort || 0) < (b.offShort || 0)) less = true;
  if (less) return true;
  return a.soft < b.soft;
}
// b から a への変化で、増えたもの（悪くなったもの）の一覧。表示と警告に使う。
function scoreWorsened(a, b) {
  const out = [];
  if (a.comp > b.comp) out.push({ key: 'comp', from: b.comp, to: a.comp });
  const keys = new Set(Object.keys(a.byMust).concat(Object.keys(b.byMust)));
  keys.forEach(k => { const x = a.byMust[k] || 0, y = b.byMust[k] || 0; if (x > y) out.push({ key: k, from: y, to: x }); });
  if (a.over > b.over) out.push({ key: 'over', from: b.over, to: a.over });
  if ((a.bsOver || 0) > (b.bsOver || 0)) out.push({ key: 'bsOver', from: b.bsOver || 0, to: a.bsOver });
  if ((a.offShort || 0) > (b.offShort || 0)) out.push({ key: 'offShort', from: b.offShort || 0, to: a.offShort });
  if (a.soft > b.soft) out.push({ key: 'soft', from: b.soft, to: a.soft });
  return out;
}
// 6連勤以上（コンプラ違反）が「新しくできた・伸びた・つながった」連勤の一覧。
// 回数だけ見ると、6連勤を7連勤に伸ばす変更や、2本をつなぐ変更（回数は減る）を
// 見逃すので、連勤ごとに比べる。手直し前の同じ人の6連勤以上と日が重なり、
// その長さ以下なら（縮めた・変わらない）悪化とはしない。
function compWorsened(beforeVs, afterVs) {
  const isC = v => v && v.type === 'consecutive' && v.compliance;
  const prev = (beforeVs || []).filter(isC);
  return (afterVs || []).filter(isC).filter(v => !prev.some(p => p.staffId === v.staffId
    && p.from <= v.to && v.from <= p.to && v.len <= p.len));
}

// 順番を付ける必要がある所（4通りから選ぶ、候補を並べる）の並べ方。小さいほど良い。
//   ① 6連勤以上の回数 ② 人員不足 ③ 🚨の件数（連勤は回数） ④ 連勤の超過日数
//   ⑤ 公休の足りない日数の合計（利用者の判断 2026年9月26日。連勤の超過日数のすぐあと）
//   ⑥ 早遅の切り替えの超過回数（「絶対」のときだけ。「なるべく」なら⑦の🟡に1人1件で入る） ⑦ 🟡の件数
function scoreCompare(a, b) {
  return (a.comp - b.comp) || (a.under - b.under) || (a.must - b.must) || (a.over - b.over)
      || ((a.offShort || 0) - (b.offShort || 0))
      || ((a.bsOver || 0) - (b.bsOver || 0)) || (a.soft - b.soft);
}
// 画面に出す要約（件数と超過日数を分けて出す）
// ⛔（6連勤以上）は🚨と別に数えて出す（結果の一覧と同じ数え方）。
function scoreSummary(r) {
  const parts = [];
  if (r.comp) parts.push(`⛔コンプラ違反 ${r.comp}件`);
  parts.push(`🚨${r.must - r.comp}件`);
  if (r.over) parts.push(`連勤の超過 ${r.over}日`);
  if (r.offShort) parts.push(`公休の不足 ${r.offShort}日`);
  if (r.bsOver) parts.push(`切り替えの超過 ${r.bsOver}回`);
  parts.push(`🟡${r.soft}件`);
  return parts.join('・');
}

function findConcreteFixes(opt) {
  const o = opt || {};
  const maxResults = o.maxResults || 12;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const staff = AppState.staff || [];
  if (!days || !staff.length || !AppState.shifts) return [];

  // 件数だけで比べると、🟡が2件減って🚨が1件増えても「1件減った」になってしまう。
  // 実際にそれで連勤超過を出してしまったため、🚨と🟡を分けて数える。
  const isMust = (t) => (typeof getRuleLevel === 'function')
    ? (getRuleLevel(t) === 'must' || MUST_TYPES_OPT.has(t))
    : MUST_TYPES_OPT.has(t);
  // 改善かどうかは scoreBetter（どの🚨も増えず、どれかが減る）、並べ方は scoreCompare。
  const score = (vs) => scoreViolations(vs);
  const baseScore = score(checkViolations(AppState.shifts));
  const base = baseScore.count;
  if (!base) return [];
  // 採用してよいか: scoreBetter（どの🚨の種類・連勤の超過日数・6連勤以上も増えず、どれかが減る）
  const better = (n) => scoreBetter(n, baseScore);

  const locked = (id, d) =>
    !!((AppState.requests[id] || {})[d] ||
       (typeof getFixedShiftAt === 'function' ? getFixedShiftAt(id, d) : null));
  const canDo = (s, v) => !v || !isWork(v) || isTraining(v) || (s.allowedShifts || []).includes(v);
  const swap = (aId, bId, d) => {
    const t = AppState.shifts[aId][d];
    AppState.shifts[aId][d] = AppState.shifts[bId][d];
    AppState.shifts[bId][d] = t;
  };
  // 入れ替えてよい組み合わせを列挙する
  const movesOn = (d) => {
    const out = [];
    for (let i = 0; i < staff.length; i++) {
      for (let j = i + 1; j < staff.length; j++) {
        const A = staff[i], B = staff[j];
        if (getStaffDepartment(A) !== getStaffDepartment(B)) continue;  // 部門をまたがない
        if (locked(A.id, d) || locked(B.id, d)) continue;
        const va = (AppState.shifts[A.id] || {})[d] || '';
        const vb = (AppState.shifts[B.id] || {})[d] || '';
        if (va === vb) continue;
        if (!canDo(A, vb) || !canDo(B, va)) continue;
        out.push({ day: d, aId: A.id, aName: A.name, aVal: va, bId: B.id, bName: B.name, bVal: vb });
      }
    }
    return out;
  };

  // エラーの近くの日を優先して調べる（全部調べると時間がかかるため）
  const vios = checkViolations(AppState.shifts);
  const hot = new Set();
  vios.forEach(v => { for (let k = (v.day || 1) - 2; k <= (v.day || 1) + 2; k++) if (k >= 1 && k <= days) hot.add(k); });
  const hotDays = Array.from(hot).sort((a, b) => a - b);

  const found = [];
  // ① 1手で減る案
  const first = [];
  hotDays.forEach(d => movesOn(d).forEach(m => first.push(m)));
  first.forEach(m => {
    swap(m.aId, m.bId, m.day);
    const n = score(checkViolations(AppState.shifts));
    swap(m.aId, m.bId, m.day);
    if (better(n)) {
      found.push({ steps: [m], before: base, after: n.count, gain: baseScore.total - n.total,
                   mustBefore: baseScore.mustCount, mustAfter: n.mustCount, _sc: n, _base: baseScore });
    } else {
      // 悪くならない手だけを2手目の土台に使う（🚨を増やす手は土台にもしない）
      m._same = (n.must === baseScore.must && n.total === baseScore.total);
    }
  });
  // 並べ方は scoreCompare（① 6連勤以上 ② 人員不足 ③ 🚨 ④ 連勤の超過日数 ⑤ 公休の足りない日数
  // ⑥ 切り替えの超過回数（絶対のとき）⑦ 🟡）
  found.sort((a, b) => scoreCompare(a._sc, b._sc));
  if (found.length >= maxResults || !o.deep) return _dedupeFixes(found, maxResults);

  // ② 2手の組合せ（1手目は「悪くならない手」だけを土台にする）
  const bases = first.filter(m => m._same);
  let seen = 0;
  for (const m1 of bases) {
    if (found.length >= maxResults) break;
    swap(m1.aId, m1.bId, m1.day);
    const near = new Set(hotDays);
    for (let k = m1.day - 2; k <= m1.day + 2; k++) if (k >= 1 && k <= days) near.add(k);
    for (const d of near) {
      for (const m2 of movesOn(d)) {
        if (m2.day === m1.day && m2.aId === m1.aId && m2.bId === m1.bId) continue;
        swap(m2.aId, m2.bId, m2.day);
        const n = score(checkViolations(AppState.shifts));
        swap(m2.aId, m2.bId, m2.day);
        seen++;
        if (better(n)) {
          found.push({ steps: [m1, JSON.parse(JSON.stringify(m2))], before: base, after: n.count,
                       gain: baseScore.total - n.total, mustBefore: baseScore.mustCount, mustAfter: n.mustCount,
                       _sc: n, _base: baseScore });
          if (found.length >= maxResults) break;
        }
      }
      if (found.length >= maxResults) break;
    }
    swap(m1.aId, m1.bId, m1.day);
    if (o.onProgress && seen % 2000 === 0) o.onProgress(seen);
  }
  found.sort((a, b) => scoreCompare(a._sc, b._sc) || a.steps.length - b.steps.length);
  return _dedupeFixes(found, maxResults);
}

/**
 * 生成した表を、実際の検査（checkViolations）で確かめながら磨く。
 *
 * ソルバーは段ごとに予算を固定しながら解くので、「あと1マス入れ替えれば
 * 減る」ところを取りこぼすことがある。ここでは次の2つの操作だけを使う。
 * どちらも、その日の人数・役割と、各人の出勤日数・公休・有給の数を変えない。
 *
 *  ・同日入れ替え: 同じ日の2人の「出勤シフトどうし」を入れ替える
 *                  （出勤と休みは入れ替えない。入れ替えると各人の日数が変わる）
 *  ・たすき掛け:   Aが d1=X・d2=Y、Bが d1=Y・d2=X のとき、両方を入れ替える
 *                  （連勤・単発出勤・遅→休→早など、並びのエラーに効く）
 *
 * 採用するのは scoreBetter で「改善」になる手だけ（どの🚨の種類も、連勤の超過日数も、
 * 6連勤以上の回数も増えず、どれかが減る。🚨が同じなら🟡が減る）。改善になる手のうち、
 * scoreCompare でいちばん良い手を選ぶ。6連勤以上を新しく作る手は使わない。
 * 希望・固定のマスは動かさない。
 *
 * @param {Object} shifts  直接書き換える
 * @param {Object} [opt]   {timeMs: 持ち時間(既定8000)}
 * @returns {{before:{must,total}, after:{must,total}, moves:number}}
 */
function polishShifts(shifts, opt) {
  const o = opt || {};
  const limit = Date.now() + (o.timeMs || 8000);
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const staff = AppState.staff || [];
  // 改善かどうかは scoreBetter で決める。件数だけで比べると、5連勤2回を10連勤1回に
  // まとめる手を「🚨が1件減った」と選んでしまっていた（連勤は回数と超過日数の両方で見る）。
  const evalS = () => {
    const vs = checkViolations(shifts);
    return Object.assign(scoreViolations(vs), { vs });
  };
  const better = (n, b) => scoreBetter(n, b);
  const locked = (id, d) =>
    !!((AppState.requests[id] || {})[d] || (typeof getFixedShiftAt === 'function' ? getFixedShiftAt(id, d) : null));
  const canDo = (s, v) => !v || !isWork(v) || isTraining(v) || (s.allowedShifts || []).includes(v);
  const cell = (id, d) => (shifts[id] || {})[d] || '';
  const put = (id, d, v) => { (shifts[id] || (shifts[id] = {}))[d] = v; };
  const dept = {}; staff.forEach(s => dept[s.id] = getStaffDepartment(s));

  let cur = evalS();
  const start = { must: cur.must, total: cur.total };
  let moves = 0;
  // 1手ずつ、いちばん良くなる手を探して採用し、良くならなくなるまで繰り返す
  while (cur.total > 0 && Date.now() < limit) {
    // エラーに関わる人と、その前後2日を調べる（全部調べると時間がかかる）
    // 人のつかないエラー（スキル不足など）の日は、誰と誰の入れ替えでも調べる
    const hotDays = new Set(), hotStaff = new Set(), openDays = new Set();
    cur.vs.forEach(v => {
      for (let k = (v.day || 1) - 2; k <= (v.day || 1) + 2; k++) if (k >= 1 && k <= days) hotDays.add(k);
      if (v.staffId) hotStaff.add(v.staffId); else if (v.day) openDays.add(v.day);
    });
    let best = null;
    // いまの答えより「改善」になる手（どの🚨も増えない・6連勤以上を作らない）の
    // うち、並べ方（scoreCompare）でいちばん良い手を選ぶ
    const tryMove = (apply, undo, desc) => {
      apply();
      const n = evalS();
      undo();
      if (better(n, cur) && (!best || scoreCompare(n, best.n) < 0)) best = { n, apply, desc };
    };
    // ① 同日入れ替え
    for (const d of hotDays) {
      if (Date.now() >= limit) break;
      for (let i = 0; i < staff.length; i++) {
        for (let j = i + 1; j < staff.length; j++) {
          const A = staff[i], B = staff[j];
          if (dept[A.id] !== dept[B.id]) continue;
          if (!openDays.has(d) && !hotStaff.has(A.id) && !hotStaff.has(B.id)) continue;
          if (locked(A.id, d) || locked(B.id, d)) continue;
          const va = cell(A.id, d), vb = cell(B.id, d);
          if (va === vb || !canDo(A, vb) || !canDo(B, va)) continue;
          // 出勤どうしの入れ替えだけにする。出勤と休み（有給・公休）を入れ替えると
          // 2人の出勤日数・有給の数が変わってしまう。実際に、有給を別の人へ
          // 移して「2件減った」ことにしてしまったため（検査が有給の数を見ていない）。
          if (!isWork(va) || !isWork(vb)) continue;
          tryMove(() => { put(A.id, d, vb); put(B.id, d, va); },
                  () => { put(A.id, d, va); put(B.id, d, vb); }, 'swap');
        }
      }
    }
    // ② たすき掛け（エラーに関わる人 × その前後の日 × 別の日）
    const hs = hotStaff.size ? staff.filter(s => hotStaff.has(s.id)) : staff;
    for (const A of hs) {
      if (Date.now() >= limit) break;
      for (const d1 of hotDays) {
        if (locked(A.id, d1)) continue;
        const x = cell(A.id, d1);
        for (let d2 = 1; d2 <= days; d2++) {
          if (d2 === d1 || locked(A.id, d2)) continue;
          const y = cell(A.id, d2);
          if (x === y) continue;
          for (const B of staff) {
            if (B.id === A.id || dept[B.id] !== dept[A.id]) continue;
            if (cell(B.id, d1) !== y || cell(B.id, d2) !== x) continue;
            if (locked(B.id, d1) || locked(B.id, d2)) continue;
            tryMove(() => { put(A.id, d1, y); put(A.id, d2, x); put(B.id, d1, x); put(B.id, d2, y); },
                    () => { put(A.id, d1, x); put(A.id, d2, y); put(B.id, d1, y); put(B.id, d2, x); }, 'cross');
          }
        }
      }
    }
    if (!best) break;
    best.apply();
    cur = evalS();
    moves++;
  }
  return { before: start, after: { must: cur.must, total: cur.total }, moves };
}

/**
 * 具体案の重複を取り除く。
 * 2手の案には「1手目が何もしていない（無駄な手）」ものが大量に混ざる。
 * 実測では10案中9案が、同じ1手案に無関係な手を足しただけだった。
 * ・すでに出した案をそのまま含む案は捨てる（余計な手が付いているだけ）
 * ・同じ人・同じ日をもう扱った案も捨てる（似た案が並ぶのを防ぐ）
 */
function _dedupeFixes(list, max) {
  const key = (m) => `${m.day}:${[m.aId, m.bId].sort().join('-')}`;
  const out = [], usedStep = new Set(), usedCell = new Set();
  list.forEach(x => {
    if (out.length >= max) return;
    const keys = x.steps.map(key);
    if (keys.some(k => usedStep.has(k))) return;              // 既出の手を含む
    const cells = x.steps.flatMap(m => [`${m.day}:${m.aId}`, `${m.day}:${m.bId}`]);
    if (cells.some(cc => usedCell.has(cc))) return;           // 同じマスを扱う案
    keys.forEach(k => usedStep.add(k));
    cells.forEach(cc => usedCell.add(cc));
    out.push(x);
  });
  return out;
}

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
    for (let d = 1; d <= days; d++) requiredWork += getDayReq(g.reqs, g.dailyReqs || {}, key, d);
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

  // ── 入力チェック: 希望休（公休系のロック）が公休目標を超えている人 ──
  // 希望休は必ず尊重（動かさない）ため、目標より多く入れると公休が目標を超える。
  // これは「公休不足」エラーにはならないが、入力しすぎの可能性が高いので注意を出す。
  const overReq = [];
  staff.forEach(s => {
    const quota = s.maxOff || 0;
    let lockedPub = 0;
    for (let d = 1; d <= days; d++) {
      const rq = (AppState.requests[s.id]    || {})[d];
      const fx = (AppState.fixedShifts[s.id] || {})[d];
      if (isPublicOff(rq) || isPublicOff(fx)) lockedPub++;
    }
    if (lockedPub > quota) overReq.push({ name: s.name, lockedPub, quota });
  });
  if (overReq.length) {
    results.push({
      level: 'warning',
      title: `⚠️ 希望休が公休目標より多い ${overReq.length}件（入力しすぎの可能性）`,
      detail:
        overReq.map(o => `${o.name}: 希望休(公休系) ${o.lockedPub}日 ＞ 公休目標 ${o.quota}日（+${o.lockedPub - o.quota}）`).join('\n') +
        `\n希望休は必ず尊重して動かさないため、公休が目標を超えます。「公休不足」エラーにはなりませんが、入力ミスの可能性があります。`,
      suggestion: `意図的でなければ、④希望休入力で対象スタッフの「休」を目標日数まで減らしてください（意図的に多く休ませる場合はそのままでOK）。`,
    });
  }

  // ── 1〜3. 部門ごとの実現可能性・カバレッジ・個別制約 ─────────
  const groups = getDepartmentGroups(staff);
  let surplus = Infinity; // 全部門の中で最も厳しい余裕（違反傾向の原因判定に使用）

  groups.forEach(g => {
    const pfx    = groups.length > 1 ? `【${g.label}】` : '';
    const gStaff = g.staff;

    // ── 1. 公休数の数学的実現可能性 ──
    // 必要人日は「日別必要人数の上書き」も含めて日ごとに合計する
    let totalRequired = 0;
    for (let d = 1; d <= days; d++) {
      shiftKeys.forEach(k => { totalRequired += getDayReq(g.reqs, g.dailyReqs || {}, k, d); });
    }
    const dailyRequired   = Math.round((totalRequired / days) * 10) / 10; // 1日平均
    const baseDaily       = shiftKeys.reduce((sum, k) => sum + (g.reqs[k] || 0), 0);
    const totalPersonDays = gStaff.length * days;
    const totalMaxOff     = gStaff.reduce((sum, s) => sum + (s.maxOff || 0), 0);
    // 出勤できない日は公休だけではない。有給（設定分は必ず消化）・研修・
    // 季節休暇などの公休以外の休みも差し引かないと余力を過大評価してしまう。
    let totalPaid = 0, totalTrain = 0, totalOtherOff = 0;
    gStaff.forEach(s => {
      let reqPaid = 0, trainN = 0, otherOff = 0;
      for (let d = 1; d <= days; d++) {
        const rq = (AppState.requests[s.id]    || {})[d];
        const fx = (AppState.fixedShifts[s.id] || {})[d];
        if (rq === '有' || fx === '有') { reqPaid++; continue; }
        if ((rq && isTraining(rq)) || (fx && isTraining(fx))) { trainN++; continue; }
        // 公休以外の休み（季/慶/引/半 など）は maxOff に含まれないので別途差し引く
        const off = (rq && isOff(rq)) ? rq : ((fx && isOff(fx)) ? fx : '');
        if (off && !isPublicOff(off)) otherOff++;
      }
      totalPaid     += Math.max(reqPaid, parseInt(s.paidLeave) || 0); // 設定分は必ず消化
      totalTrain    += trainN;
      totalOtherOff += otherOff;
    });
    const availWork = totalPersonDays - totalMaxOff - totalPaid - totalTrain - totalOtherOff;
    const gSurplus  = availWork - totalRequired;
    surplus = Math.min(surplus, gSurplus);
    // 内訳の説明文（過大評価を防ぐため必ず明示する）
    const capLines =
      `スタッフ数: ${gStaff.length}人 × ${days}日 = ${totalPersonDays}人日\n` +
      `− 公休目標 ${totalMaxOff}日` +
      (totalPaid ? ` − 有給 ${totalPaid}日` : '') +
      (totalTrain ? ` − 研修 ${totalTrain}日` : '') +
      (totalOtherOff ? ` − その他の休み ${totalOtherOff}日` : '') +
      `\n＝ 出勤できる合計: ${availWork}人日\n` +
      `必要出勤: ${totalRequired}人日（1日平均 ${dailyRequired}人` +
      (dailyRequired !== baseDaily ? `・日別上書きを反映済み` : '') + `）`;

    if (gSurplus < 0) {
      const shortage    = -gSurplus;
      const cutOffDays  = Math.ceil(shortage / gStaff.length);   // 1人あたり公休を何日減らせば足りるか
      const feasibleDaily = Math.floor(availWork / days);
      results.push({
        level: 'error',
        title: `${pfx}🚨 人手が ${shortage}人日 足りません（このままではエラーが必ず出ます）`,
        detail:
          capLines + `\n` +
          `不足: ${shortage}人日 → 全員に目標どおり休みを与えつつ必要人数を満たすことは数学的に不可能です。\n` +
          `※ 公休不足・連勤超過・リズム違反（遅→早など）は、この不足が原因で必ず発生します。`,
        suggestion:
          `次のいずれかで解消できます（数字は必要量の目安）：` +
          `　①有給日数を合計 ${shortage}日ぶん減らす（設定した有給は必ず消化されます）` +
          `　②「日別必要人数」の上書きを ${shortage}コマぶん減らす（土日の増員を戻す）` +
          `　③公休数を1人あたり ${cutOffDays}日 減らす` +
          `　④1日の必要人数を平均 ${feasibleDaily}人以下にする` +
          `　⑤スタッフを ${Math.ceil(shortage / Math.max(1, days - Math.round(totalMaxOff / gStaff.length)))}人以上増やす`,
      });
    } else if (dailyRequired > 0 && gSurplus < gStaff.length) {
      // 足りてはいるが余裕が薄い（1人日/人 未満）→ エラーが出やすい
      results.push({
        level: 'warning',
        title: `${pfx}⚠️ 人手の余裕がわずかです（余裕 +${gSurplus}人日）`,
        detail:
          capLines + `\n` +
          `余裕: +${gSurplus}人日 → 足りてはいますが、休みの並べ方の自由度がほとんどありません。\n` +
          `連勤超過・遅→早・単発出勤などのエラーが残りやすい状態です。`,
        suggestion: `エラーを0に近づけたい場合は、有給日数・日別必要人数の上書き・公休数のいずれかを少し緩めてください。`,
      });
    } else if (dailyRequired > 0) {
      results.push({
        level: 'ok',
        title: `${pfx}公休数は数学的に実現可能`,
        detail:
          capLines + `\n` +
          `余裕: +${gSurplus}人日/月 → スタッフ ${gStaff.length}人 で目標どおりの休みを全員に与えられます。`,
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

  // ── 3.6. スキル（営業など）の日別“物理的”実現可能性（避けられる/避けられない判定）──
  //   各日、そのスキルを持ち対象帯（早/遅）で働ける人が何人いるか（希望休・有給・固定・早遅可を考慮）。
  //   利用可能人数が最低ラインを割る日=🔴、目標を割る日=🟡は、どう配置しても避けられない（人員構成の限界）。
  (AppState.skills || []).forEach(sk => {
    const need = (sk.req != null ? sk.req : (sk.lateReq || 0));
    if (!need) return;
    const min   = (sk.min != null && sk.min >= 0 && sk.min <= need) ? sk.min : need;
    const early = (sk.target || 'late') === 'early';
    const bandLabel = early ? '早番' : '遅番';
    const holders = staff.filter(s => (s.skills || []).includes(sk.name));
    const inBand = k => early ? isEarlyCategory(k) : isLate(k);
    const belowMin = [], belowTarget = [];
    for (let d = 1; d <= days; d++) {
      let avail = 0;
      holders.forEach(s => {
        const rq = (AppState.requests[s.id] || {})[d];
        if (rq && isOff(rq)) return;                                   // 希望休・有給などで不在
        const fx = (AppState.fixedShifts[s.id] || {})[d];
        if (fx) { if (isWork(fx) && inBand(fx) && !isTraining(fx)) avail++; return; } // 固定シフト
        const canBand = (s.allowedShifts || []).some(k => inBand(k) && !isTraining(k));
        const prefOk  = early ? (!s.prefs || s.prefs.includes('早可')) : (!s.prefs || s.prefs.includes('遅可'));
        if (canBand && prefOk) avail++;
      });
      if (avail < min) belowMin.push(d);
      else if (avail < need) belowTarget.push(d);
    }
    const daysStr = arr => (arr.length > 12 ? arr.slice(0, 12).join('・') + `…（計${arr.length}日）` : arr.join('・')) + '日';
    if (belowMin.length) {
      results.push({
        level: 'error',
        title: `🔴【避けられない】${sk.name}が最低${min}人に届かない日 ${belowMin.length}日`,
        detail: `${bandLabel}に「${sk.name}」できる人が最低${min}人必要ですが、次の日は出られる保有者が${min}人未満です` +
          `（希望休・有給・固定を除いた実数／保有者は全${holders.length}人）:\n${daysStr(belowMin)}\n` +
          `→ これらの日はどう配置しても不足します（生成では消せません）。`,
        suggestion: `該当日の希望休・有給をずらす、または「${sk.name}」ができる人を増やすと解消します。`,
      });
    }
    if (belowTarget.length) {
      results.push({
        level: 'warning',
        title: `🟡【避けられない】${sk.name}が目標${need}人に届かない日 ${belowTarget.length}日`,
        detail: `${bandLabel}に「${sk.name}」を${need}人置きたい日のうち、出られる保有者が${need}人未満なのは:\n${daysStr(belowTarget)}\n` +
          `→ 最低ライン（${min}人）は満たせるので🟡。人員的な限界なので、この🟡は残っても問題ありません。`,
        suggestion: `完全に無くすには保有者を増やすか、該当日だけ「日別必要人数」で目標を${Math.max(min, need - 1)}人に下げてください。`,
      });
    }
    if (!belowMin.length && !belowTarget.length && holders.length) {
      results.push({
        level: 'ok',
        title: `✅ ${sk.name} は人員的には毎日 目標${need}人を出せます`,
        detail: `全${days}日で、${bandLabel}に出られる「${sk.name}」保有者は常に${need}人以上います（＝${sk.name}だけを見れば可能）。\n` +
          `→ それでもスキル不足が出る場合は、保有者が同じ日に他の役割（早責など）や公休と取り合いになるのが原因で、\n` +
          `　“避けられる”タイプです。案数を増やす・再生成・🛠自動修正で減らせる可能性が高いです。`,
        suggestion: null,
      });
    }
  });

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
      'overstaff':       '定数オーバー',
      'resp-duplicate':  '責任者・総務の重複',
      'hierarchy':       '責任者ヒエラルキー違反',
      'event-absent':    '行事日の休み',
      'vicemanager-absent': '副店長不在の日',
      'balance-diff':    '早遅バランスのずれ',
      'pair-rest-count': '連休回数が目安に不足',
      'special-day':     '特別日に副店長が責任者不在',
      'weekend-pref':    '土日休み希望',
      'rest-style':      '休み方の希望',
    };

    // どのエラーも「誰の何日か」を並べる。件数だけでは直しようがない。
    const whoWhen = (type) => violations.filter(v => v.type === type).map(v => {
      const s = staff.find(m => m.id === v.staffId);
      return s ? `${s.name} ${v.day}日` : '';
    }).filter(Boolean).join('、');

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
          `対象: ${whoWhen('bad-rest')}\n原因: ${cause}。`,
        suggestion: '上の「🔧 具体的な直し方を探す」で、入れ替えで消せるかを確かめられます。'
                  + '消せない場合は、その人の休みをもう1日隣に足すか、前後の時間帯を揃えてください。',
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
        detail: '上位役職者が出勤しているのに、下位者が責任者シフトに就いている日があります。\n'
              + `対象: ${whoWhen('hierarchy')}`,
        suggestion: '上の「🔧 具体的な直し方を探す」で、その日の2人を入れ替えれば直ることが多いです。',
      });
    }

    // 6連勤以上（コンプラ違反）は、連勤超過と分けて一番重いものとして出す
    const compV = violations.filter(v => v.type === 'consecutive' && v.compliance);
    if (compV.length) {
      const who = compV.map(v => {
        const s = staff.find(m => m.id === v.staffId);
        return s ? `${s.name} ${v.from >= 1 ? v.from + '日' : '前月'}〜${v.to}日（${v.len}連勤）` : '';
      }).filter(Boolean).join('、');
      results.push({
        level: 'error',
        title: `⛔ コンプラ違反（6連勤以上） ${compV.length} 件`,
        detail: `6連勤以上はコンプライアンス違反です（5連勤まで可・連勤上限の設定とは関係ありません）。\n対象: ${who}`,
        suggestion: '連勤の途中に休みを入れて、必ず直してください。連勤の上限を上げても消えません。',
      });
    }
    // 連勤超過（6連勤以上を除く）
    const consOnly = violations.filter(v => v.type === 'consecutive' && !v.compliance);
    if (consOnly.length) {
      const who = consOnly.map(v => {
        const s = staff.find(m => m.id === v.staffId);
        return s ? `${s.name} ${v.from >= 1 ? v.from + '日' : '前月'}〜${v.to}日（${v.len}連勤）` : '';
      }).filter(Boolean).join('、');
      results.push({
        level: 'warning',
        title: `連勤超過 ${consOnly.length} 件`,
        detail: `設定上限（${AppState.settings.maxConsecutive}日）を超える連続勤務が残存しています。\n`
              + `対象: ${who}`,
        suggestion: '上の「🔧 具体的な直し方を探す」を試してください。'
                  + '消せない場合は、希望休の置き方が原因のことが多いので、生成前チェックの指摘をご確認ください。',
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

/* ===========================================
   エラー解消プラン（緩和の提案）
   「どの設定をいくつ動かせば、どのエラーが消えるか」を人日で計算して
   実行可能な案を並べる。UI側は id と params を見て設定を書き換える。
   =========================================== */

// 痛み（現場への影響）の小さい順。同じ痛みなら効果の大きい順に並べる。
const RELAX_PAIN_ORDER = { small: 0, mid: 1, large: 2 };

/**
 * 1部門ぶんの人日収支を計算する。
 * @returns {{required:number, avail:number, surplus:number, days:number,
 *            totalMaxOff:number, totalPaid:number, excessDaily:number}}
 */
function calcCapacity(g, days) {
  const shiftKeys = getWorkShiftKeys();
  let required = 0, excessDaily = 0;
  for (let d = 1; d <= days; d++) {
    shiftKeys.forEach(k => {
      const need = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
      required += need;
      // 日別上書きが既定値より多い分＝「上乗せ」。戻せば取り返せる人日。
      const base = (g.reqs || {})[k] || 0;
      if (need > base) excessDaily += (need - base);
    });
  }
  let totalPaid = 0, totalTrain = 0, totalOtherOff = 0;
  g.staff.forEach(s => {
    for (let d = 1; d <= days; d++) {
      const rq = (AppState.requests[s.id]    || {})[d];
      const fx = (AppState.fixedShifts[s.id] || {})[d];
      if (rq === '有' || fx === '有') { totalPaid++; continue; }
      if ((rq && isTraining(rq)) || (fx && isTraining(fx))) { totalTrain++; continue; }
      const off = (rq && isOff(rq)) ? rq : ((fx && isOff(fx)) ? fx : '');
      if (off && !isPublicOff(off)) totalOtherOff++;
    }
    totalPaid += Math.max(0, (parseInt(s.paidLeave) || 0) - countPaidRequests(s, days));
  });
  const totalMaxOff = g.staff.reduce((sum, s) => sum + (s.maxOff || 0), 0);
  const avail = g.staff.length * days - totalMaxOff - totalPaid - totalTrain - totalOtherOff;
  return { required, avail, surplus: avail - required, days,
           totalMaxOff, totalPaid, excessDaily };
}

// その人がカレンダーで既に指定している'有'の日数（設定値との二重計上を防ぐ）
function countPaidRequests(s, days) {
  let n = 0;
  for (let d = 1; d <= days; d++) if ((AppState.requests[s.id] || {})[d] === '有') n++;
  return n;
}

/**
 * エラー解消プランを組み立てる。
 * @param {Array} violations 直近の生成結果の違反（無ければ人日の話だけになる）
 * @returns {Array} プラン配列（痛みの小さい順）
 */
/**
 * その設定変更が「いまの表」で何件のエラーを実際に消すかを数える。
 * 設定を一時的に変えて検証し直し、必ず元に戻す。ソルバーは使わないので即座に終わる。
 * 作り直すと他の並びも変わるため、あくまで「いまの表での効き目」。
 */
function measureRelaxEffect(mut) {
  const shifts = AppState.shifts || {};
  if (!Object.keys(shifts).length) return null;      // 表がまだ無いときは測れない
  const snapSettings = JSON.parse(JSON.stringify(AppState.settings || {}));
  const snapSkills   = JSON.parse(JSON.stringify(AppState.skills || []));
  let before = 0, after = 0, bSc = null, aSc = null;
  try {
    const bv = checkViolations(shifts); before = bv.length; bSc = scoreViolations(bv);
    mut(AppState);
    const av = checkViolations(shifts); after = av.length; aSc = scoreViolations(av);
  } catch (e) {
    return null;
  } finally {
    AppState.settings = snapSettings;
    AppState.skills = snapSkills;
  }
  // 件数が同じでも、連勤の上限を1日上げると超過日数は減る。件数だけ見ると
  // 「減りません」になってしまうので、scoreBetter で軽くなったかも返す。
  const lighter = after === before && scoreBetter(aSc, bSc);
  return { before, after, gain: before - after, lighter };
}
// 設定を緩めたときの効き目の言い方（件数が減る／件数は同じで軽くなる／減らない）
function relaxEffectText(e) {
  if (e.gain > 0) return `いまの表で ${e.gain}件 消えます`;
  if (e.lighter)  return 'いまの表で件数は同じですが、軽くなります（超えている日数が減ります）';
  return 'いまの表では減りません';
}

function buildRelaxPlans(violations) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const vios = violations || AppState.violations || [];
  const plans = [];
  if (!AppState.staff.length || !days) return plans;

  const cnt = {};
  vios.forEach(v => { cnt[v.type] = (cnt[v.type] || 0) + 1; });

  // ── A. 人日が足りない場合の案（人員不足・公休不足の根本原因） ──
  getDepartmentGroups(AppState.staff).forEach(g => {
    const cap = calcCapacity(g, days);
    if (cap.surplus >= 0) return;
    const shortage = -cap.surplus;
    const pfx = (getDepartmentGroups(AppState.staff).length > 1) ? `【${g.label}】` : '';

    // A-1 日別必要人数の上乗せを戻す（いちばん効きやすく、痛みも中程度）
    if (cap.excessDaily > 0) {
      const gain = Math.min(cap.excessDaily, shortage);
      plans.push({
        id: 'daily-req-reset', group: 'capacity', pain: 'mid', gain, shortage, dept: g.key,
        title: `${pfx}「日別必要人数」の上乗せを戻す`,
        effect: `＋${cap.excessDaily}人日`,
        detail: `土日などで既定より増やしている分が合計 ${cap.excessDaily}人日 あります。これを既定値に戻すと、不足 ${shortage}人日 のうち ${gain}人日 が解消します。`,
        after: cap.excessDaily >= shortage ? 'これだけで不足は解消します。' : `まだ ${shortage - cap.excessDaily}人日 足りません。他の案と組み合わせてください。`,
        params: { dept: g.key },
      });
    }

    // A-2 有給の当月消化を減らす（翌月に回すだけなので痛みは小さい）
    const paidTotal = g.staff.reduce((n, s) => n + (parseInt(s.paidLeave) || 0), 0);
    if (paidTotal > 0) {
      const cut = Math.min(paidTotal, shortage);
      plans.push({
        id: 'paid-reduce', group: 'capacity', pain: 'small', gain: cut, shortage, dept: g.key,
        title: `${pfx}有給の当月消化を ${cut}日 減らす（翌月へ回す）`,
        effect: `＋${cut}人日`,
        detail: `設定した有給は必ず消化されるため、その分だけ出勤できる人が減ります。当月の消化目標を合計 ${cut}日 減らすと ${cut}人日 取り返せます（有給日数の多い人から減らします）。`,
        after: cut >= shortage ? 'これだけで不足は解消します。' : `まだ ${shortage - cut}人日 足りません。`,
        params: { dept: g.key, reduce: cut },
      });
    }

    // A-3 公休目標を減らす（痛みが大きいので下に置く）
    const cutDays = Math.ceil(shortage / Math.max(1, g.staff.length));
    plans.push({
      id: 'maxoff-reduce', group: 'capacity', pain: 'large', gain: cutDays * g.staff.length, shortage, dept: g.key,
      title: `${pfx}公休目標を全員 ${cutDays}日 減らす`,
      effect: `＋${cutDays * g.staff.length}人日`,
      detail: `${g.staff.length}人 × ${cutDays}日 ＝ ${cutDays * g.staff.length}人日 ぶん出勤できるようになります。休みが減るため、実施前に必ず現場と確認してください。`,
      after: '不足は解消しますが、スタッフの休みが減ります。',
      params: { dept: g.key, days: cutDays },
    });

    // A-4 必要人数（定数）そのものを1人減らす（影響が最大なので最後）
    const keys = getWorkShiftKeys().filter(k => ((g.reqs || {})[k] || 0) > 0);
    const solo = (typeof SOLO_SHIFT_KEYS !== 'undefined') ? new Set(SOLO_SHIFT_KEYS) : new Set();
    const target = keys.filter(k => !solo.has(k)).sort((a, b) => (g.reqs[b] || 0) - (g.reqs[a] || 0))[0];
    if (target) {
      plans.push({
        id: 'req-reduce', group: 'capacity', pain: 'large', gain: days, shortage, dept: g.key,
        title: `${pfx}「${target}」の必要人数を1人減らす（${g.reqs[target]}人 → ${g.reqs[target] - 1}人）`,
        effect: `＋${days}人日`,
        detail: `毎日1人ずつ減るので ${days}人日 ぶん余裕ができます。営業に直結するため、他の案で足りないときの最後の手段です。`,
        after: '不足は解消しますが、日々の配置人数が減ります。',
        params: { dept: g.key, key: target },
      });
    }
  });

  // ── B. 人日は足りているのに残るエラーへの案 ──
  // リズム系・希望系は「ルールの強弱」を下げれば消える（人手は増減しない）。
  const softenable = [
    { type: 'category-switch', label: '連勤中の時間帯切替' },
    { type: 'bad-rest',        label: '遅→休→早' },
    { type: 'long-rest',       label: '連休が長すぎる' },
    { type: 'single-work',     label: '単発出勤' },
    { type: 'weekend-pref',    label: '土日休み希望' },
    { type: 'rest-style',      label: '休み方（連休/分散）' },
    { type: 'pair-rest',       label: '遅→早は2連休（個人）' },
    { type: 'skill-short',     label: 'スキル目標人数に不足' },
  ];
  softenable.forEach(r => {
    const n = cnt[r.type] || 0;
    if (!n) return;
    const lv = getRuleLevel(r.type);
    if (lv === 'off') return;
    const to = lv === 'must' ? 'should' : 'off';
    const eff = measureRelaxEffect(A => { A.settings.ruleLevels = A.settings.ruleLevels || {}; A.settings.ruleLevels[r.type] = to; });
    plans.push({
      id: 'rule-soften', group: 'rule', pain: 'small',
      gain: eff ? eff.gain : n, count: n, measured: eff,
      title: `「${r.label}」のルールを ${lv === 'must' ? '🟡できれば に下げる' : 'OFF にする'}`,
      effect: eff ? relaxEffectText(eff) : `${n}件が対象`,
      detail: lv === 'must'
        // 🟡に下げても、そのルールのエラーは画面から消えない。優先順位が下がるだけ。
        // 以前は「件数が減るか警告扱いになります」と書いていたが、実測では
        // 減らないことが多く、設定を変えたのに何も起きないように見えていた。
        ? `${n}件出ています。🔴絶対 → 🟡できれば に下げても、${r.label}のエラー表示は消えません。`
          + `変わるのは優先順位だけで、他のルールを優先して並べ直せるようになります。`
          + `実測では、この変更だけでは件数が変わらないことが多いです。`
          + `確実に消したい場合は OFF にしてください。人手は増減しません。`
        : `${n}件出ています。OFF にすると、このルールは一切チェックしなくなります。人手は増減しません。`,
      after: eff && eff.gain <= 0 && !eff.lighter
        ? '※ いまの表では減りません。作り直すと並びが変わるため、結果は変わることがあります。'
        : '生成し直すと結果に反映されます。',
      params: { type: r.type, to },
    });
  });

  // 早遅バランス: 許容幅を広げれば消える。
  // ただし広げ続けると「早番多め／遅番多め」の設定そのものが効かなくなる。
  // 月の勤務が17〜21日程度なので、4日以上ずれを許すと比率の指定が無意味になる。
  // そのため3日までしか提案せず、それ以上は広げずに理由を知らせる。
  const BAL_TOL_MAX = 3;
  if (cnt['balance-diff']) {
    const tol = parseInt(AppState.settings.balanceTolerance) || 0;
    if (tol < BAL_TOL_MAX) {
      const eb = measureRelaxEffect(A => { A.settings.balanceTolerance = tol + 1; });
      plans.push({
        id: 'balance-tol', group: 'rule', pain: 'small',
        gain: eb ? eb.gain : cnt['balance-diff'], count: cnt['balance-diff'], measured: eb,
        title: `早遅バランスの許容幅を ${tol}日 → ${tol + 1}日 に広げる`,
        effect: eb ? relaxEffectText(eb) : `${cnt['balance-diff']}件が対象`,
        detail: `目標比率からのずれを ${tol + 1}日 まで許すようにします。`
              + (eb && eb.gain <= 0 && !eb.lighter
                 ? `ただし、いまの表のずれは1日広げただけでは収まりません。広げても件数は変わらない見込みです。`
                 : `出勤日数によっては比率がぴったりにならないため、1日広げるだけで消えることがよくあります。`),
        after: eb && eb.gain <= 0 && !eb.lighter
          ? '※ いまの表では減りません。ルールが緩むぶん他の並びが変わり、かえって増えることもあります。'
          : '生成し直すと結果に反映されます。',
        params: { to: tol + 1 },
      });
    } else {
      plans.push({
        id: 'balance-tol-max', group: 'rule', pain: 'large', gain: 0, count: cnt['balance-diff'], manual: true,
        title: `早遅バランスの許容幅は ${tol}日 です。これ以上は広げられません`,
        effect: `${cnt['balance-diff']}件は別の方法で対応してください`,
        detail: `許容幅を ${BAL_TOL_MAX}日 より広げると、「早番多め」「遅番多め」の設定そのものが効かなくなります。`
              + `月の勤務が17〜21日程度なので、4日以上のずれを許すと比率の指定が意味を持たなくなるためです。`
              + `対象の方の担当シフトを見直すか、早遅バランスを「早番のみ／遅番のみ（絶対）」にするか、`
              + `その方の早遅バランスを「指定なし（OFF）」にすることをご検討ください。`,
        after: '設定は変更されません（お知らせのみ）。',
        params: {},
      });
    }
  }

  // 連休が長すぎる: 上限日数を1日延ばす
  if (cnt['long-rest']) {
    const cur = getMaxOffRun();
    const er = measureRelaxEffect(A => { A.settings.maxConsecutiveOff = cur + 1; });
    plans.push({
      id: 'maxoffrun', group: 'rule', pain: 'small',
      gain: er ? er.gain : cnt['long-rest'], count: cnt['long-rest'], measured: er,
      title: `連休の上限を ${cur}日 → ${cur + 1}日 に延ばす`,
      effect: er ? relaxEffectText(er) : `${cnt['long-rest']}件が対象`,
      detail: `${cur + 1}連休までは許すようにします。`
            + (er && er.gain <= 0 && !er.lighter
               ? `ただし、いまの表の連休は1日延ばしただけでは収まりません。`
               : `人手が足りない月は連休が伸びやすいため、1日延ばすと消えることがあります。`),
      after: er && er.gain <= 0 && !er.lighter ? '※ いまの表では減りません。' : '生成し直すと結果に反映されます。',
      params: { to: cur + 1 },
    });
  }

  // 連勤の上限を1日延ばす（連勤超過だけでなく、連休や時間帯切替にも効くことがある）
  if (cnt['consecutive'] || cnt['long-rest'] || cnt['category-switch']) {
    const curC = parseInt(AppState.settings.maxConsecutive) || 0;
    // 6連勤以上はコンプライアンス違反なので、上限を6日以上にする案は出さない（5日まで）
    if (curC >= 1 && curC + 1 < COMPLIANCE_CONS_DAYS) {
      const ec = measureRelaxEffect(A => { A.settings.maxConsecutive = curC + 1; });
      if (!ec || ec.gain > 0 || ec.lighter) {
        plans.push({
          id: 'maxcons', group: 'rule', pain: 'mid',
          gain: ec ? ec.gain : (cnt['consecutive'] || 0), count: cnt['consecutive'] || 0, measured: ec,
          title: `連勤の上限を ${curC}日 → ${curC + 1}日 に延ばす`,
          effect: ec ? relaxEffectText(ec) : `${cnt['consecutive'] || 0}件が対象`,
          detail: `連続して働ける日数を1日増やします。休みの置き場所が自由になるため、`
                + `連勤超過だけでなく、連休の長さや時間帯の切替にも効くことがあります。`
                + `働く人の負担が増えるので、現場と相談してから使ってください。`,
          after: '生成し直すと結果に反映されます。',
          params: { to: curC + 1 },
        });
      }
    }
  }

  // スキル最低人数割れ: 最低ラインを1人下げる
  if (cnt['skill-late']) {
    (AppState.skills || []).forEach((sk, i) => {
      const base = (sk.req != null ? sk.req : sk.lateReq) || 0;
      const min  = (sk.min != null && sk.min >= 0) ? sk.min : base;
      if (min <= 0) return;
      plans.push({
        id: 'skill-min', group: 'rule', pain: 'mid', gain: cnt['skill-late'], count: cnt['skill-late'],
        title: `スキル「${sk.name}」の最低人数を ${min}人 → ${min - 1}人 に下げる`,
        effect: `${cnt['skill-late']}件が対象`,
        detail: `そのスキルを持つ人が足りない日があります。最低ラインを1人下げるか、③スタッフ管理でこのスキルを持つ人を増やしてください。`,
        after: '生成し直すと結果に反映されます。',
        params: { index: i, to: min - 1 },
      });
    });
  }

  // 希望休が公休目標より多い人 → その分だけ人日が減っている
  const over = [];
  AppState.staff.forEach(s => {
    let lockedPub = 0;
    for (let d = 1; d <= days; d++) {
      const rq = (AppState.requests[s.id]    || {})[d];
      const fx = (AppState.fixedShifts[s.id] || {})[d];
      if (isPublicOff(rq) || isPublicOff(fx)) lockedPub++;
    }
    if (lockedPub > (s.maxOff || 0)) over.push({ name: s.name, over: lockedPub - (s.maxOff || 0) });
  });
  if (over.length) {
    const total = over.reduce((n, o) => n + o.over, 0);
    plans.push({
      id: 'info-overreq', group: 'capacity', pain: 'mid', gain: total, manual: true,
      title: `希望休を入れすぎている人が ${over.length}人（合計 ${total}日ぶん）`,
      effect: `＋${total}人日`,
      detail: over.map(o => `${o.name}: 目標より +${o.over}日`).join(' / ') +
              `\n希望休は必ず尊重されるため、目標より多い分だけ出勤できる人が減ります。`,
      after: '④希望休入力で、該当スタッフの「休」を減らしてください（自動では変更しません）。',
      params: {},
    });
  }

  // 人日（人手）の案を先に出す。効果の単位が「人日」と「件」で違うため、
  // グループをまたいで効果の数字を比べない。
  const gOrder = { capacity: 0, rule: 1 };
  plans.sort((a, b) =>
    (gOrder[a.group] - gOrder[b.group]) ||
    (RELAX_PAIN_ORDER[a.pain] - RELAX_PAIN_ORDER[b.pain]) ||
    (b.gain - a.gain));
  // 効き目が実測できたものを上に、効かないと分かったものを下に並べる。
  // 「押しても何も起きない案」が先頭に並ぶと、直し方が分からなくなるため。
  plans.sort((a, b) => {
    const ga = (a.measured ? a.measured.gain : null), gb = (b.measured ? b.measured.gain : null);
    const ra = (ga === null) ? 1 : (ga > 0 ? 0 : 2);   // 0=効く 1=未測定 2=効かない
    const rb = (gb === null) ? 1 : (gb > 0 ? 0 : 2);
    if (ra !== rb) return ra - rb;
    if (a.group !== b.group) return a.group === 'capacity' ? -1 : 1;
    return (gb || 0) - (ga || 0);
  });
  return plans;
}

/* ===========================================
   理論下限の判定（ステップ1）
   「エラー0件が数学的に可能か」を生成する前に判定する。
   人日の総量だけでなく、日ごと・役割ごと・スキルごとに
   「その日、担当できる人が足りているか」まで調べるため、
   「日曜に責任者ができる人が全員休み希望」のような穴も見つかる。
   ここで挙がるものは配置をどう変えても消せない＝避けられないエラー。
   =========================================== */

// その日、そのスタッフが取れる状態を返す
//   'off'      … 休みで確定（希望休・固定の休み）
//   'training' … 研修で確定（出勤だが定数には数えない）
//   'fixed:キー' … その役割で確定
//   'free'     … 自由（担当シフトの中から選べる）
function staffDayState(s, d) {
  const rq = (AppState.requests[s.id] || {})[d];
  if (rq && isOff(rq)) return 'off';
  const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
  if (fx && isOff(fx))      return 'off';
  if (fx && isTraining(fx)) return 'training';
  if (fx)                   return 'fixed:' + fx;
  return 'free';
}

/**
 * 避けられないエラーの下限を求める。
 * @returns {{ possible:boolean, minErrors:number, reasons:Array, capacity:Array }}
 */
/**
 * その日、指定した時間帯（早番帯/遅番帯）の枠に、スキル保有者を最大何人置けるかを数える。
 * 枠は役割ごとに必要人数ぶんあり、1人は1枠まで。出勤希望・固定で確定している人は
 * その枠を先に埋める。保有者でない人が枠を塞いでいる場合は、その人（blocker）と、
 * 代わりに入れる役割（alt）も返す。
 * 小さな二部マッチング（人 ≦ 数十、役割 ≦ 数個）なので素朴な増加路法で十分。
 */
function maxSkillInBand(g, sk, bandKeys, d) {
  const slots = {};                 // 役割 → 残り枠数
  const pinned = [];                // その日、役割が確定している人
  bandKeys.forEach(k => { slots[k] = getDayReq(g.reqs, g.dailyReqs || {}, k, d); });

  const pool = [];                  // まだ役割が決まっていない保有者
  let fixedHolders = 0;             // すでに枠が確定している保有者（この人数はそのまま数える）
  g.staff.forEach(s => {
    const st = staffDayState(s, d);
    if (st === 'off' || st === 'training') return;
    const has = (s.skills || []).includes(sk.name);
    if (st.indexOf('fixed:') === 0) {
      const k = st.slice(6);
      if (slots[k] == null) return;         // 別の時間帯に確定 → この帯には関係ない
      slots[k] = Math.max(0, slots[k] - 1);
      if (has) fixedHolders++;
      else pinned.push({ staff: s, key: k });
      return;
    }
    if (has) pool.push(s);
  });

  // 増加路法で「保有者を何人まで枠に入れられるか」を求める
  const count = (avail) => {
    const left = Object.assign({}, avail);
    const used = new Set();
    let n = 0;
    // 入れる役割が少ない人から決めると取りこぼしが少ない
    const order = pool.slice().sort((a, b) =>
      bandKeys.filter(k => (a.allowedShifts || []).includes(k)).length -
      bandKeys.filter(k => (b.allowedShifts || []).includes(k)).length);
    order.forEach(s => {
      if (used.has(s.id)) return;
      const k = bandKeys.find(k2 => left[k2] > 0 && (s.allowedShifts || []).includes(k2));
      if (k) { left[k]--; used.add(s.id); n++; }
    });
    return n;
  };
  const max = fixedHolders + count(slots);

  // 保有者でない人が枠を塞いでいるなら、その人が別の役割に移れば直るかを調べる
  let blocker = null;
  for (const p of pinned) {
    const others = bandKeys.filter(k => k !== p.key && (p.staff.allowedShifts || []).includes(k));
    for (const alt of others) {
      const trial = Object.assign({}, slots);
      trial[p.key]++; trial[alt] = Math.max(0, trial[alt] - 1);
      if (fixedHolders + count(trial) > max) { blocker = { id: p.staff.id, name: p.staff.name, key: p.key, alt }; break; }
    }
    if (blocker) break;
    // 移し先が無くても「塞いでいる本人」は伝える
    if (!blocker && bandKeys.some(k => k !== p.key)) blocker = { id: p.staff.id, name: p.staff.name, key: p.key, alt: null };
  }
  return { max, blocker };
}

/**
 * 日ごとの人数の余裕（生成前チェック 3-1①）。計算はせず、希望・固定・担当できるシフトだけで数える。
 *   全体・早番帯・遅番帯: 出られる人数 − 必要人数。0 なら、出られる人は全員その日（その時間帯）に出勤になる。
 *   スキル: その時間帯に入れる保有者の人数 − 目標人数（最低ラインを下回ると必ずエラー）。
 * 休み・有給・半休の希望、休みの🔒固定、研修の日は「出られない」に数える。
 * @returns {Array<{label, days: Array<{day, total, early, late, skills}>}>}
 *   total/early/late: { avail, need, margin, ids }（ids は出られる人。余裕0の日に「必ず出勤」の人として出す）
 *   skills: [{ name, band, avail, need, min, margin, ids }]
 */
function analyzeDayMargins() {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const out = [];
  if (!AppState.staff.length || !days) return out;
  const shiftKeys = getWorkShiftKeys().filter(k => {
    const t = AppState.shiftTypes.find(x => x.key === k);
    return t && !t.isTraining;
  });
  const inBand = (k, band) => band === 'early' ? isEarlyCategory(k) : isLate(k);
  getDepartmentGroups(AppState.staff).forEach(g => {
    const rows = [];
    for (let d = 1; d <= days; d++) {
      // その人がその日に入れるシフト（出られなければ空）
      const keysOf = (s) => {
        const st = staffDayState(s, d);
        if (st === 'off' || st === 'training') return [];
        if (st.indexOf('fixed:') === 0) { const k = st.slice(6); return shiftKeys.includes(k) ? [k] : []; }
        return (s.allowedShifts || []).filter(k => shiftKeys.includes(k));
      };
      const ks = {}; g.staff.forEach(s => { ks[s.id] = keysOf(s); });
      const count = (pred) => {
        const need = shiftKeys.filter(pred).reduce((a, k) => a + getDayReq(g.reqs, g.dailyReqs || {}, k, d), 0);
        const ids = g.staff.filter(s => ks[s.id].some(pred)).map(s => s.id);
        return { avail: ids.length, need, margin: ids.length - need, ids };
      };
      const row = { day: d, total: count(() => true),
                    early: count(k => inBand(k, 'early')), late: count(k => inBand(k, 'late')), skills: [] };
      (AppState.skills || []).forEach(sk => {
        const { need, min } = getDaySkillReq(sk, d);
        if (!(need > 0) && !(min > 0)) return;
        const band = (sk.target || 'late') === 'early' ? 'early' : 'late';
        const ids = g.staff.filter(s => (s.skills || []).includes(sk.name) && ks[s.id].some(k => inBand(k, band))).map(s => s.id);
        row.skills.push({ name: sk.name, band, avail: ids.length, need, min, margin: ids.length - need, ids });
      });
      rows.push(row);
    }
    out.push({ label: g.label, days: rows });
  });
  return out;
}

function analyzeLowerBound() {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const res = { possible: true, minErrors: 0, reasons: [], capacity: [] };
  if (!AppState.staff.length || !days) return res;

  const shiftKeys = getWorkShiftKeys().filter(k => {
    const t = AppState.shiftTypes.find(x => x.key === k);
    return t && !t.isTraining;
  });
  const groups = getDepartmentGroups(AppState.staff);
  const multi  = groups.length > 1;

  groups.forEach(g => {
    const pfx = multi ? `【${g.label}】` : '';
    let dayShort = 0;    // 日別に確定する不足の合計（＝避けられない人員不足の下限）
    let consShort = 0;   // 連勤上限と休み日数の矛盾（連勤超過か公休不足が必ず起きる）
    // 連勤超過は画面では「1回の連勤につき1件」と数える（何日超えても1件）。
    // 最低件数も同じ単位にするため、日数ではなく人ごとに数え、最後に足す。
    //   固定・出勤希望で確定した長い連勤 … その区間の数（区間は必ず別々）
    //   休みが足りない・置き方の矛盾     … 1人につき最低1件
    // 同じ人に両方あるときは、同じ連勤かもしれないので多いほうだけを数える。
    const consFixed = {}, consNeed = {};
    let slotShort = 0;   // スキルの枠不足（人はいるのに入れる枠が無い＝必ず1件出る）

    for (let d = 1; d <= days; d++) {
      // その日、各役割に入れる人を数える
      const cap = {};    // 役割 → 入れる人数（固定で入っている人も含む）
      const fixedIn = {};
      let freeCount = 0;
      shiftKeys.forEach(k => { cap[k] = 0; fixedIn[k] = 0; });
      g.staff.forEach(s => {
        const st = staffDayState(s, d);
        if (st === 'off' || st === 'training') return;
        if (st.indexOf('fixed:') === 0) {
          const k = st.slice(6);
          if (cap[k] != null) { cap[k]++; fixedIn[k]++; }
          return;
        }
        let any = false;
        (s.allowedShifts || []).forEach(k => { if (cap[k] != null) { cap[k]++; any = true; } });
        if (any) freeCount++;
      });

      // ① 役割ごとの不足（その役割を担当できる人がその日足りない）
      let roleShort = 0;
      shiftKeys.forEach(k => {
        const need = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
        if (need > 0 && cap[k] < need) {
          roleShort += (need - cap[k]);
          res.reasons.push({
            kind: 'role', day: d, role: k, need, have: cap[k],
            text: `${pfx}${d}日: 「${k}」が ${need}人 必要ですが、その日入れる人は ${cap[k]}人 しかいません（不足 ${need - cap[k]}人）`,
          });
        }
      });

      // ② その日の総人数（役割ごとには足りていても、合計で足りないことがある）
      let needAll = 0, fixedAll = 0;
      shiftKeys.forEach(k => { needAll += getDayReq(g.reqs, g.dailyReqs || {}, k, d); fixedAll += fixedIn[k]; });
      const availAll = freeCount + fixedAll;
      let totalShort = 0;
      if (needAll > availAll) {
        totalShort = needAll - availAll;
        res.reasons.push({
          kind: 'day', day: d, need: needAll, have: availAll,
          text: `${pfx}${d}日: 合計 ${needAll}人 必要ですが、その日出勤できる人は ${availAll}人 しかいません（不足 ${totalShort}人）`,
        });
      }
      dayShort += Math.max(roleShort, totalShort);

      // ③ スキルの最低ライン
      (AppState.skills || []).forEach(sk => {
        const { min } = getDaySkillReq(sk, d);
        if (!(min > 0)) return;
        const early = (sk.target || 'late') === 'early';
        let have = 0;
        g.staff.forEach(s => {
          if (!(s.skills || []).includes(sk.name)) return;
          const st = staffDayState(s, d);
          if (st === 'off' || st === 'training') return;
          const ks = (st.indexOf('fixed:') === 0) ? [st.slice(6)] : (s.allowedShifts || []);
          if (ks.some(k => shiftKeys.includes(k) && (early ? isEarlyCategory(k) : isLate(k)))) have++;
        });
        if (have < min) {
          res.reasons.push({
            kind: 'skill', day: d, skill: sk.name, need: min, have,
            text: `${pfx}${d}日: スキル「${sk.name}」は最低 ${min}人 必要ですが、その日入れる保有者は ${have}人 です`,
          });
        }
      });

      // ③' スキルの「枠」不足（人はいるのに、入れる枠が無いケース）
      //    ③は「その日出勤できる保有者が何人いるか」しか見ていない。
      //    保有者がたくさんいても、その時間帯の枠が保有者の入れない役割
      //    （例: 早番総務＝保有者ゼロ）や、保有者でない人の出勤希望で
      //    埋まっていると、枠が足りずに必ずエラーになる。
      //    そこで「その時間帯の枠に、保有者を最大何人まで置けるか」を数える。
      (AppState.skills || []).forEach(sk => {
        const { min } = getDaySkillReq(sk, d);
        if (!(min > 0)) return;
        const early = (sk.target || 'late') === 'early';
        const bandKeys = shiftKeys.filter(k => (early ? isEarlyCategory(k) : isLate(k)));
        if (!bandKeys.length) return;
        const r = maxSkillInBand(g, sk, bandKeys, d);
        if (r.max >= min) return;
        let fix = '';
        if (r.blocker) {
          const alt = r.blocker.alt;
          fix = alt
            ? `${r.blocker.name}さんの${d}日の希望を「${r.blocker.key}」から「${alt}」に変えると収まります`
            : `${r.blocker.name}さんは「${sk.name}」を持っていないため、${d}日の希望「${r.blocker.key}」がこの枠を塞いでいます`;
        } else {
          fix = `「${sk.name}」を持つ人を増やすか、${early ? '早番' : '遅番'}帯の必要人数を見直してください`;
        }
        slotShort += (min - r.max);
        res.reasons.push({
          kind: 'skill-slot', day: d, skill: sk.name, need: min, have: r.max, fix,
          // ボタン1つで直せる操作。null なら手で直してもらう
          act: (r.blocker && r.blocker.alt)
            ? { type: 'request', staffId: r.blocker.id, day: d, to: r.blocker.alt,
                label: `${r.blocker.name}さんの${d}日を「${r.blocker.alt}」に変える` } : null,
          text: `${pfx}${d}日: スキル「${sk.name}」は最低 ${min}人 必要ですが、`
              + `${early ? '早番' : '遅番'}の枠に置けるのは最大 ${r.max}人 です。${fix}`,
        });
      });

      // ④ 副店長カバレッジ（2人以上いる場合のみのルール）
      const vms = g.staff.filter(s => s.positionType === 'viceManager');
      if (vms.length >= 2) {
        const can = vms.filter(s => { const st = staffDayState(s, d); return st !== 'off' && st !== 'training'; }).length;
        if (can === 0) {
          res.reasons.push({
            kind: 'vice', day: d,
            text: `${pfx}${d}日: 副店長が全員休み（希望休・固定）のため、副店長不在が避けられません`,
          });
        }
      }
    }

    // ④' 必要人数のルールと、手入力の食い違い
    //     ルールで「この日は2人」と決めているのに、日別必要人数に別の数が
    //     直接入っていると、手入力が優先されてルールが効かない。
    //     日付の入れ違い（12日と18日など）がここで見つかる。
    if (!multi || g === groups[0]) {
      const rules = (AppState.settings.reqRules || []).filter(r => r && r.enabled !== false);
      if (rules.length) {
        const store = AppState.dailyRequirements || {};
        for (let d = 1; d <= days; d++) {
          rules.forEach(r => {
            if (!dayMatchesRule(r, d)) return;
            const manual = (store[r.key] || {})[d];
            if (manual == null || manual === parseInt(r.to)) return;
            res.reasons.push({
              kind: 'rule-conflict', day: d, fix: `日別必要人数の ${d}日「${r.key}」を ${manual}人 → ${r.to}人 に戻すか、ルールの方を直してください`,
              act: { type: 'dailyReq', key: r.key, day: d, to: parseInt(r.to),
                     label: `${d}日「${r.key}」を ${r.to}人 に直す` },
              text: `${d}日: ルール「${r.name || r.key + ' ' + r.to + '人'}」では「${r.key}」が ${r.to}人 のはずですが、`
                  + `日別必要人数に ${manual}人 と直接入っていて、そちらが優先されています`,
            });
          });
        }
        // ルールに当てはまらない日に、手入力だけで増やしている場合も知らせる
        // （入れ違いの片割れ。12日に入れて18日に入れ忘れた、など）
        // 毎月同じお知らせが何行も並ぶと煩わしいので、1行にまとめる。
        const extra = [], extraAct = [];
        Object.keys(store).forEach(k => {
          Object.keys(store[k] || {}).forEach(ds => {
            const d = parseInt(ds); if (!(d >= 1 && d <= days)) return;
            const base = (g.reqs || {})[k] || 0;
            const val = store[k][d];
            if (val <= base) return;                       // 減らす方は意図的なことが多いので触れない
            const sameKeyRules = rules.filter(r => r.key === k);
            if (!sameKeyRules.length) return;              // その役割にルールが無ければ対象外
            if (sameKeyRules.some(r => dayMatchesRule(r, d))) return;  // ルール通りの日ならOK
            extra.push(`${d}日「${k}」${val}人`);
            extraAct.push({ key: k, day: d });
          });
        });
        if (extra.length) {
          res.reasons.push({
            kind: 'rule-extra', soft: true, extras: extraAct,
            fix: 'トレーニング用などで意図して増やしているならこのままで問題ありません。日付の入れ違いであれば、ルールに合う日に入れ直してください',
            text: `ルールに当てはまらない増員が ${extra.length}か所 あります： ${extra.join('・')}`,
          });
        }
      }
    }

    // ④a 生成しなくても分かるエラーを、まとめて先に出す
    //     出勤希望と固定シフトは「必ずそうなる」ので、それだけで矛盾が
    //     見つかるものは、生成する前に全部知らせる。
    {
      const confirmOf = (s, d) => {            // その日「確実にこうなる」と決まっている中身
        const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
        return fx || (AppState.requests[s.id] || {})[d] || '';
      };
      const solo = (typeof SOLO_SHIFT_KEYS !== 'undefined') ? new Set(SOLO_SHIFT_KEYS) : new Set();

      // (1) 担当できないシフトの希望（必ず「担当外シフト」エラーになる）
      g.staff.forEach(s => {
        for (let d = 1; d <= days; d++) {
          const v = confirmOf(s, d);
          if (!v || !isWork(v) || isTraining(v)) continue;
          if ((s.allowedShifts || []).includes(v)) continue;
          res.reasons.push({
            kind: 'req-role', day: d, staffId: s.id,
            fix: `${s.name}さんの担当シフトに「${v}」を足すか、${d}日の希望を別のシフトに変えてください`,
            text: `${pfx}${d}日: ${s.name}さんに「${v}」の希望が入っていますが、この方の担当シフトに「${v}」がありません`,
          });
        }
      });

      // (2) その日の人数より多く出勤希望が入っている（必ず定数オーバーになる）
      const workKeys = shiftKeys.slice();
      for (let d = 1; d <= days; d++) {
        workKeys.forEach(k => {
          if (solo.has(k)) return;            // 1人だけの役割は下の (3) で扱う
          const need = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
          const who = g.staff.filter(s => confirmOf(s, d) === k);
          if (who.length <= need) return;
          const over = who.length - need;
          res.reasons.push({
            kind: 'req-over', day: d,
            fix: need === 0
              ? `${d}日の「${k}」は0人の設定です。希望を別のシフトに変えるか、必要人数を ${who.length}人 にしてください`
              : `${d}日の「${k}」の必要人数を ${who.length}人 にするか、${over}人ぶんの希望を別のシフトに変えてください`,
            text: `${pfx}${d}日: 「${k}」は ${need}人 の設定ですが、${who.map(x => x.name).join('・')} の ${who.length}人 に希望が入っています（${over}人 多い）`,
          });
        });
      }

      // (3) 責任者など「1人だけ」の役割が重なっている
      for (let d = 1; d <= days; d++) {
        workKeys.filter(k => solo.has(k)).forEach(k => {
          const who = g.staff.filter(s => confirmOf(s, d) === k);
          const need = Math.max(1, getDayReq(g.reqs, g.dailyReqs || {}, k, d));
          if (who.length <= need) return;
          res.reasons.push({
            kind: 'req-solo', day: d,
            fix: `${who.slice(1).map(x => x.name).join('・')} さんの ${d}日 を別のシフトに変えてください`,
            text: `${pfx}${d}日: 「${k}」は1人だけの役割ですが、${who.map(x => x.name).join('・')} の ${who.length}人 に希望が入っています`,
          });
        });
      }

      // (4) 遅番の翌日が早番（休みなしの遅→早）
      // 半休は検査と同じく出勤・早番として数える（「遅責 → 半休」も遅→早になる。数えていなかった）。
      // 前月末が遅番で、1日が早番（半休）の希望なら、それも遅→早になる。
      if (AppState.settings.forbidLateEarly !== false) {
        const wk = (x) => !!x && (isWork(x) || isHalfWork(x));
        const earlyish = (x) => isEarlyCategory(x) || isHalfWork(x);
        g.staff.forEach(s => {
          const pe = (typeof getPrevMonthEnd === 'function') ? getPrevMonthEnd(s) : {};
          const b1 = confirmOf(s, 1);
          if ((pe.cons || 0) >= 1 && pe.lastShift && isLate(pe.lastShift) && wk(b1) && earlyish(b1)) {
            res.reasons.push({
              kind: 'req-le', day: 0, staffId: s.id, cells: [1],
              fix: `1日を休みにするか、遅番に変えてください`,
              text: `${pfx}${s.name}さん: 前月末が遅番で、1日「${b1}」なので、休みを挟まずに遅番→早番になります`,
            });
          }
          for (let d = 1; d < days; d++) {
            const a = confirmOf(s, d), b = confirmOf(s, d + 1);
            if (!wk(a) || !wk(b)) continue;
            if (isLate(a) && earlyish(b)) {
              res.reasons.push({
                kind: 'req-le', day: d, staffId: s.id, cells: [d, d + 1],
                fix: `${d}日か${d + 1}日のどちらかを休みにするか、時間帯を揃えてください`,
                text: `${pfx}${s.name}さん: ${d}日「${a}」の翌日 ${d + 1}日「${b}」で、休みを挟まずに遅番→${isTraining(b) ? '研修' : '早番'}になります`,
              });
            }
          }
        });
      }

      // (4b) 行事日に、対象の人が希望休を出している（🚨行事日の欠勤が確定）
      (AppState.events || []).forEach(ev => {
        if (!ev || !ev.day || ev.day < 1 || ev.day > days) return;
        (ev.staffIds || []).forEach(sid => {
          const s = g.staff.find(m => m.id === sid);
          if (!s) return;
          const v = confirmOf(s, ev.day);
          if (v && isOff(v)) {
            res.reasons.push({
              kind: 'event-req', day: ev.day, staffId: s.id,
              fix: `${s.name}さんの${ev.day}日の希望休を外すか、行事の対象から外してください`,
              text: `${pfx}${s.name}さん: ${ev.day}日は行事${ev.name ? `「${ev.name}」` : ''}の対象ですが、希望休（${v}）が入っています`,
            });
          }
        });
      });

      // (4c) 夜勤の翌日に出勤の希望が入っている（🚨夜勤明けの出勤が確定）
      g.staff.forEach(s => {
        for (let d = 1; d < days; d++) {
          const a = confirmOf(s, d), b = confirmOf(s, d + 1);
          if (!a || !b || !isWork(a) || !isWork(b)) continue;
          if (typeof isNight === 'function' && isNight(a)) {
            res.reasons.push({
              kind: 'req-night', day: d, staffId: s.id,
              fix: `${d + 1}日の希望を休みに変えてください（夜勤明けは休みが必須です）`,
              text: `${pfx}${s.name}さん: ${d}日「${a}」は夜勤で、翌日 ${d + 1}日 に出勤の希望「${b}」が入っています`,
            });
          }
        }
      });

      // (4d) 「遅→早は2連休必須」の人が、希望だけで 遅→休1日→早 になっている
      g.staff.forEach(s => {
        if (!s.needPairRest) return;
        for (let d = 2; d < days; d++) {
          const a = confirmOf(s, d - 1), m = confirmOf(s, d), b = confirmOf(s, d + 1);
          if (!a || !m || !b) continue;
          if (isWork(a) && isLate(a) && isOff(m) && isWork(b) && isEarlyCategory(b)) {
            res.reasons.push({
              kind: 'req-pair', day: d, staffId: s.id,
              fix: `${d - 1}日か${d + 1}日の希望を変えるか、${d}日の前後どちらかも休みにしてください`,
              text: `${pfx}${s.name}さん: ${d - 1}日「${a}」→${d}日 休み→${d + 1}日「${b}」が希望で確定しています。`
                  + `この方は「遅→早の切替時は2連休以上」の設定です`,
            });
          }
        }
      });

      // (4e) 「土日休み（絶対）」の人が、土日に出勤の希望を出している
      g.staff.forEach(s => {
        if (s.weekendPref !== 'hard') return;
        if (getRuleLevel('weekend-pref') === 'off') return;
        for (let d = 1; d <= days; d++) {
          const w = getWeekday(AppState.settings.targetMonth, d);
          if (w !== 0 && w !== 6) continue;
          const v = confirmOf(s, d);
          if (v && isWork(v)) {
            res.reasons.push({
              kind: 'req-weekend', day: d, staffId: s.id,
              fix: `${d}日の希望を休みに変えるか、この方の「土日休み」を『なるべく』に下げてください`,
              text: `${pfx}${s.name}さん: ${d}日（${w === 0 ? '日' : '土'}曜）に出勤の希望「${v}」がありますが、土日休みが『絶対』の設定です`,
            });
          }
        }
      });

      // (4h) 希望出勤が多すぎて、公休数を満たせない（🚨公休数不足が確定）
      g.staff.forEach(s => {
        if (getStaffDepartment(s) === 'cast') return;
        let wantWork = 0, wantOff = 0;
        for (let d = 1; d <= days; d++) {
          const v = confirmOf(s, d);
          if (!v) continue;
          if (isOff(v)) wantOff++; else if (isWork(v)) wantWork++;
        }
        const canWork = days - (s.maxOff || 0) - (parseInt(s.paidLeave) || 0);
        if (wantWork > canWork) {
          const over = wantWork - canWork;
          res.reasons.push({
            kind: 'req-offcount', staffId: s.id,
            fix: `出勤の希望を ${over}日ぶん減らすか、公休数・有給数の設定を見直してください`,
            text: `${pfx}${s.name}さん: 出勤の希望が ${wantWork}日 ありますが、`
                + `公休${s.maxOff || 0}日・有給${parseInt(s.paidLeave) || 0}日を引くと働けるのは ${canWork}日 までです（${over}日ぶん超過）`,
          });
        }
      });

      // (4f) 「休み方＝こまめに分散（絶対）」の人が、希望だけで4連勤以上になっている
      g.staff.forEach(s => {
        if (s.restStyle !== 'spread-hard') return;
        if (getRuleLevel('rest-style') === 'off') return;
        let run = 0, from = 0;
        for (let d = 1; d <= days + 1; d++) {
          const v = d <= days ? confirmOf(s, d) : '';
          if (v && isWork(v)) { if (!run) from = d; run++; continue; }
          if (run >= 4) {
            res.reasons.push({
              kind: 'req-spread', day: from, staffId: s.id,
              fix: `${from}日〜${from + run - 1}日 の希望出勤のうち1日を休みに変えてください`,
              text: `${pfx}${s.name}さん: ${from}日〜${from + run - 1}日 が希望で ${run}連勤に決まっています。`
                  + `この方は「こまめに分散（絶対）」の設定で、3連勤までです`,
            });
          }
          run = 0;
        }
      });

      // (4g) ルールを『絶対』『できれば』にしている場合、希望だけで確定してしまう並び。
      //      ルールを なるべく→絶対 に切り替えたときに、直しようのない違反が
      //      いきなり🚨として出てくるのを、生成前に知らせる。
      {
        const csOn = getRuleLevel('category-switch') !== 'off';
        const brOn = AppState.settings.penaltySingleOff !== false;
        g.staff.forEach(s => {
          for (let d = 1; d <= days; d++) {
            // 連勤中の時間帯切替（前日も翌日も出勤で、時間帯が変わる）
            if (csOn && d < days) {
              const a = confirmOf(s, d), b = confirmOf(s, d + 1);
              if (a && b && isWork(a) && isWork(b)) {
                const ca = getShiftCategory(a), cb = getShiftCategory(b);
                if (ca && cb && ca !== cb) {
                  res.reasons.push({
                    kind: 'req-switch', day: d, staffId: s.id, soft: getRuleLevel('category-switch') !== 'must',
                    fix: `${d}日か${d + 1}日の希望の時間帯を揃えるか、間に休みを入れてください`,
                    text: `${pfx}${s.name}さん: ${d}日「${a}」→${d + 1}日「${b}」が希望で確定しており、`
                        + `連勤の途中で時間帯が変わります（ルール「連勤中の時間帯切替」が有効）`,
                  });
                }
              }
            }
            // 遅→休1日→早
            if (brOn && d >= 2 && d < days) {
              const a = confirmOf(s, d - 1), m = confirmOf(s, d), b = confirmOf(s, d + 1);
              if (a && m && b && isWork(a) && isLate(a) && isOff(m) && isWork(b) && isEarlyCategory(b)) {
                res.reasons.push({
                  kind: 'req-badrest', day: d, staffId: s.id, soft: true,
                  fix: `${d}日の前後どちらかも休みにするか、${d - 1}日か${d + 1}日の時間帯を揃えてください`,
                  text: `${pfx}${s.name}さん: ${d - 1}日「${a}」→${d}日 休み→${d + 1}日「${b}」が希望で確定しており、`
                      + `遅→休→早になります`,
                });
              }
            }
          }
        });
      }

      // (5) 有給が消化しきれない
      g.staff.forEach(s => {
        if (getStaffDepartment(s) === 'cast') return;
        const want = parseInt(s.paidLeave) || 0;
        if (want <= 0) return;
        let already = 0, freeDays = 0;
        for (let d = 1; d <= days; d++) {
          const v = confirmOf(s, d);
          if (v === '有') { already++; continue; }
          if (!v) freeDays++;
        }
        // 公休目標＋有給が月の日数を超えていたら、どうやっても両方は取れない
        const off = parseInt(s.maxOff) || 0;
        if (off + want > days) {
          res.reasons.push({
            kind: 'paid-short', staffId: s.id,
            fix: `${s.name}さんの公休 ${off}日 か有給 ${want}日 を減らしてください（合わせて ${days}日 までです）`,
            text: `${pfx}${s.name}さん: 公休 ${off}日 ＋ 有給 ${want}日 ＝ ${off + want}日 で、月の日数 ${days}日 を超えています`,
          });
          return;
        }
        const need = want - already;
        if (need > freeDays) {
          res.reasons.push({
            kind: 'paid-short', staffId: s.id,
            fix: `${s.name}さんの有給日数を ${want - (need - freeDays)}日 に減らすか、希望休・固定を減らしてください`,
            text: `${pfx}${s.name}さん: 有給 ${want}日 の設定ですが、空いている日が ${freeDays}日 しかなく、${need - freeDays}日 ぶん消化できません`,
          });
        }
      });

      // (6) 特別日に副店長が別の予定になっている
      Object.keys(AppState.specialDays || {}).forEach(ds => {
        const d = parseInt(ds); if (!(d >= 1 && d <= days)) return;
        const kind = AppState.specialDays[ds];
        const want = kind === 'replacement' ? '遅責' : kind === 'renewal' ? '早責' : null;
        if (!want) return;
        const vms = g.staff.filter(s => s.positionType === 'viceManager');
        if (!vms.length) return;
        const ok = vms.some(s => { const v = confirmOf(s, d); return !v || v === want; });
        if (ok) return;
        res.reasons.push({
          kind: 'special-req', day: d,
          fix: `副店長のどなたかの ${d}日 を「${want}」にするか、空けてください`,
          text: `${pfx}${d}日(${kind === 'replacement' ? '入れ替え日' : '新装日'}): 副店長が全員、別の予定になっています`
              + `（${vms.map(s => s.name + 'さん=' + (confirmOf(s, d) || '未定')).join('・')}）。この日は副店長が「${want}」に入る決まりです`,
        });
      });
    }

    // ④'' 固定シフト・出勤希望だけで、すでに連勤上限を超えている人
    //     余の割り当てなどで出勤日を固定すると、続けすぎているのに
    //     生成するまで気づけなかった。確定している出勤だけを並べて数える。
    g.staff.forEach(s => {
      if (getStaffDepartment(s) === 'cast') return;
      const mc = Math.min(getMaxConsFor(s), COMPLIANCE_CONS_DAYS - 1);   // 6連勤以上はコンプラ違反
      if (!(mc >= 1)) return;
      const prev = (typeof getPrevMonthEnd === 'function') ? (getPrevMonthEnd(s).cons || 0) : 0;
      let run = 0, runStart = 0;
      const hit = [];
      for (let d = 1; d <= days + 1; d++) {
        // 「確実に出勤」と決まっている日だけを数える（休み希望・未定の日は連勤を切る）
        let working = false;
        if (d <= days) {
          const rq = (AppState.requests[s.id] || {})[d];
          const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
          const v = fx || rq || '';
          // 半休も出勤として数える（検査の連勤と同じ。数えないと半休で連勤が切れていた）
          working = !!(v && (isWork(v) || isHalfWork(v)) && !isTraining(v));
        }
        if (working) { if (!run) runStart = d; run++; continue; }
        if (run) {
          const total = (runStart === 1) ? run + prev : run;   // 1日から続くなら前月末ぶんも足す
          if (total > mc) hit.push({ from: runStart, to: d - 1, total });
          run = 0;
        }
      }
      hit.forEach(h => {
        const extra = h.total - mc;
        consFixed[s.id] = (consFixed[s.id] || 0) + 1;
        res.reasons.push({
          kind: 'fixed-cons', staffId: s.id,
          fix: `${h.from}日〜${h.to}日 の固定・出勤希望のうち、${extra}日ぶんを外すか休みに変えてください`,
          text: `${pfx}${s.name}: ${h.from}日〜${h.to}日 が続けて出勤で確定しています`
              + (h.from === 1 && prev > 0 ? `（前月末の${prev}連勤と合わせて${h.total}連勤）` : `（${h.total}連勤）`)
              + `。連勤の上限は ${mc}日 なので、${extra}日ぶん超えます`,
        });
      });
    });

    // 人手に余りがある月は、誰かが「余」で休める。⑤・⑤b は休みの数を
    // 公休＋有給だけで数えていたため、余で休めば避けられる連勤まで
    // 「避けられません」と言っていた（実データ: Dさんが 余1日 で解消）。
    // 下限なので控えめに、余りの全部を1人ずつに使えるものとして数える。
    const cap = calcCapacity(g, days);
    const spare = Math.max(0, cap.surplus || 0);

    // ⑤ 連勤上限との矛盾（休みが少なすぎて、連勤上限を守れない人）
    //    連勤上限 c のとき、1人が働ける最大日数は days - floor(days / (c+1))。
    //    これを超える出勤日数が必要な人は、連勤超過か公休不足が必ず起きる。
    g.staff.forEach(s => {
      if (getStaffDepartment(s) === 'cast') return;
      const c = Math.min(getMaxConsFor(s), COMPLIANCE_CONS_DAYS - 1);
      if (!(c >= 1)) return;
      const maxWork = days - Math.floor(days / (c + 1));
      let paidN = 0, otherOffN = 0;
      for (let d = 1; d <= days; d++) {
        const st = staffDayState(s, d);
        if (st !== 'off') continue;
        const rq = (AppState.requests[s.id] || {})[d];
        const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
        const off = (rq && isOff(rq)) ? rq : (fx || '');
        if (off === '有') paidN++; else if (off && !isPublicOff(off)) otherOffN++;
      }
      const needPaid  = Math.max(paidN, parseInt(s.paidLeave) || 0);
      const workNeed  = days - (s.maxOff || 0) - needPaid - otherOffN - spare;
      if (workNeed > maxWork) {
        res.reasons.push({
          kind: 'cons', staffId: s.id, need: workNeed, have: maxWork,
          text: `${pfx}${s.name}: 出勤 ${workNeed}日 が必要ですが、連勤上限${c}日を守ると最大 ${maxWork}日 までしか働けません（${workNeed - maxWork}日ぶん矛盾）`,
        });
        consNeed[s.id] = 1;
      }
    });

    // ⑤b 希望休の「置き方」と連勤上限の矛盾。
    //    ⑤は休みの総数だけを見るため、希望休が2日ずつ固まって出されると見逃す。
    //    実データで、Dさんが希望休9日を2日ずつ4組で出したケースがあり、
    //    総数では足りているのに、空き期間が 5/4/6/5日 となって休みが3日必要、
    //    残り2日しか置けず、必ず5連勤が出る状態だった。生成前チェックは
    //    「問題なし」と言い、実際には10分かけても消えなかった。
    //    確定している休みで区切った空き期間ごとに、必要な休みの数を数える。
    g.staff.forEach(s => {
      if (getStaffDepartment(s) === 'cast') return;
      const c = Math.min(getMaxConsFor(s), COMPLIANCE_CONS_DAYS - 1);
      if (!(c >= 1)) return;
      const offAt = (d) => {
        const rq = (AppState.requests[s.id] || {})[d];
        if (rq && isOff(rq)) return true;
        const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
        return !!(fx && isOff(fx));
      };
      let fixedOff = 0;
      for (let d = 1; d <= days; d++) if (offAt(d)) fixedOff++;
      const left = (s.maxOff || 0) + (parseInt(s.paidLeave) || 0) - fixedOff + spare;  // これから置ける休み（余を含む）
      if (left < 0) return;   // 休みの出しすぎは別の検査に任せる
      const segs = [];
      let run = Math.min(c, (getPrevMonthEnd(s).cons || 0));   // 前月末からの連勤を1つ目に足す
      for (let d = 1; d <= days; d++) {
        if (offAt(d)) { if (run > 0) segs.push(run); run = 0; }
        else run++;
      }
      if (run > 0) segs.push(run);
      let need = 0;
      segs.forEach(L => { if (L > c) need += Math.ceil((L - c) / (c + 1)); });
      if (need > left) {
        const gap = need - left;
        consNeed[s.id] = 1;
        res.reasons.push({
          kind: 'cons-place', staffId: s.id,
          fix: `2日続きの希望休のどれかを1日ずらして間隔を空けるか、希望休を ${gap}日 減らしてください`,
          text: `${pfx}${s.name}: 希望休の置き方から、連勤上限${c}日を守るには あと ${need}日 の休みが必要ですが、`
              + `置ける休みは ${left}日 しかありません。${gap}箇所で連勤超過が避けられません`,
        });
      }
    });

    // ⑥ 月全体の人日収支（従来のチェック。日別で見つからない不足を拾う）
    res.capacity.push({ label: g.label, required: cap.required, avail: cap.avail, surplus: cap.surplus });
    let monthShort = 0;
    if (cap.surplus < 0) {
      monthShort = -cap.surplus;
      res.reasons.push({
        kind: 'month', need: cap.required, have: cap.avail,
        text: `${pfx}月全体: 必要 ${cap.required}人日 に対し、出せるのは ${cap.avail}人日 です（不足 ${monthShort}人日）`,
      });
    }
    // 日別の不足と月全体の不足は重なりうるので、大きいほうを下限として採用する
    new Set([...Object.keys(consFixed), ...Object.keys(consNeed)])
      .forEach(id => { consShort += Math.max(consFixed[id] || 0, consNeed[id] || 0); });
    res.minErrors += Math.max(dayShort, monthShort) + consShort + slotShort;
  });

  // 上で件数に入れていない「必ずエラーになる」理由を、1つにつき1件として足す。
  // 画面には理由として出しているのに、最低エラー数には数えていなかったため、
  // 「最低1件」と出ているのに実際は3件避けられない、ということが起きていた。
  // skill は skill-slot が同じ日の不足を必ず数えているので足さない（二重になる）。
  // rule-conflict は設定の食い違いのお知らせで、エラーそのものではないので足さない。
  // 右側は、その理由が引き起こすエラーの種類。そのルールを「なし」にしている
  // 利用者もいる（副店長不在など）ので、なしのルールは数えない。
  const COUNT_ONE = {
    'vice': 'vicemanager-absent', 'req-role': 'role-mismatch', 'req-over': 'overstaff',
    'req-solo': 'resp-duplicate', 'req-le': 'late-early', 'event-req': 'event-absent',
    'req-night': 'night-after-work', 'req-pair': 'pair-rest', 'req-weekend': 'weekend-pref',
    'req-offcount': 'off-count', 'req-spread': 'rest-style', 'req-switch': 'category-switch',
    'paid-short': 'paid', 'special-req': 'special-day',
  };
  res.reasons = res.reasons.filter(r => !(COUNT_ONE[r.kind] && getRuleLevel(COUNT_ONE[r.kind]) === 'off'));
  res.reasons.forEach(r => { if (!r.soft && COUNT_ONE[r.kind]) res.minErrors += 1; });

  // soft は「お知らせ」なので、これだけなら『必ずエラーが出る』とは言わない
  res.possible = res.reasons.filter(r => !r.soft).length === 0;
  res.notes = res.reasons.filter(r => r.soft);
  res.reasons = res.reasons.filter(r => !r.soft);
  return res;
}
