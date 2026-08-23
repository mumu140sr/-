/* ===========================================
   milp.worker.js — 数理最適化(MILP)生成 Web Worker（ベータ）
   既存の焼きなまし(optimizer.worker.js)とは独立。HiGHS(WASM)は
   選択時に初めて CDN から読み込む（遅延ロード）。
   =========================================== */
self.importScripts('data.js?v=129', 'optimizer.js?v=129', 'milp-core.js?v=129');

// HiGHS(WASM) はリポジトリ内に同梱（オフライン可・CDN不要）。パスは worker(js/) から相対。
const HIGHS_BASE = 'vendor/';
let _solverPromise = null;
function getSolver() {
  if (!_solverPromise) {
    self.importScripts(HIGHS_BASE + 'highs.js?v=129'); // → self.Module（Emscripten factory）
    _solverPromise = self.Module({ locateFile: (f) => HIGHS_BASE + f });
  }
  return _solverPromise;
}

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'milp') return;
  const post = (pct, label) => self.postMessage({ type: 'progress', pct, label });
  try {
    const incoming = msg.appState || {};
    Object.assign(AppState.settings, incoming.settings || {});
    if (incoming.shiftTypes) AppState.shiftTypes = incoming.shiftTypes;
    AppState.roleRequirements     = incoming.roleRequirements     || AppState.roleRequirements;
    AppState.roleRequirementsCast = incoming.roleRequirementsCast || {};
    AppState.dailyRequirements     = incoming.dailyRequirements     || {};
    AppState.dailyRequirementsCast = incoming.dailyRequirementsCast || {};
    AppState.skills                = incoming.skills                || [];
    AppState.dailySkills           = incoming.dailySkills           || {};
    AppState.staff       = incoming.staff       || [];
    AppState.requests    = incoming.requests    || {};
    AppState.fixedShifts = incoming.fixedShifts || {};
    AppState.specialDays = incoming.specialDays || {};
    AppState.events      = incoming.events      || [];
    AppState.shifts = {};
    AppState.violations = [];

    post(5, '数理最適化ソルバーを読込み中（初回のみ）...');
    const solver = await getSolver();

    const groups = getDepartmentGroups(AppState.staff);
    const shifts = {};
    let gi = 0;
    // 「じっくり最適化」モードでは時間上限を大幅に延ばし、必ず gap=0（最適の証明）を狙う
    const deep = !!msg.deepMode;
    let allOptimal = true;   // 全グループで最適が証明できたか（false=時間切れで打ち切り）
    let usedGap = false;     // 早期停止(gap許容)を使ったか＝じっくりモードで改善余地あり
    for (const g of groups) {
      post(20 + Math.floor((gi / groups.length) * 60),
           `【${g.label || g.key}】を数理最適化で計算中...` + (deep ? '（じっくりモード）' : ''));
      const m = MILP.buildGroupModel(g.staff, g.reqs, g.dailyReqs);
      // 1部門あたりの計算時間の上限（最大10分）。
      // 20人以下は gap=0（最適の証明）を狙い、20人超は「ほぼ最良で早期停止」に
      // 切り替えて高速化する（じっくりモードでは早期停止を無効にする）。
      const n = (g.staff || []).length;
      const TIME_LIMIT = 600;   // 秒 = 10分
      let opts;
      if (deep || n <= 20) {
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0, mip_abs_gap: 0, presolve: 'on' };
      } else {
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
        usedGap = true;   // 早期停止あり＝じっくりモードで更に良くなる可能性がある
      }
      const sol = solver.solve(m.lp, opts);
      // Status が Optimal 以外＝時間切れなどで打ち切り（＝もっと良い解がある可能性）
      if (String(sol && sol.Status) !== 'Optimal') allOptimal = false;
      MILP.applyGroupSolution(m, sol, shifts);
      gi++;
    }
    post(85, '仕上げ中：公休を整理中...');
    AppState.shifts = shifts;
    try { if (typeof markSurplusRest === 'function') markSurplusRest(shifts); }
    catch (e1) { self.postMessage({ type: 'progress', pct: 88, label: '公休整理をスキップ（' + e1.message + '）' }); }
    post(92, '仕上げ中：違反を検証中...');
    let violations = [];
    try { violations = checkViolations(shifts); }
    catch (e2) { violations = []; self.postMessage({ type: 'progress', pct: 95, label: '検証をスキップ（' + e2.message + '）' }); }
    AppState.violations = violations;
    self.postMessage({ type: 'done', shifts, violations, allOptimal, deep, usedGap });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
});
