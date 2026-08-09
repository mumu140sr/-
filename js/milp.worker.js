/* ===========================================
   milp.worker.js — 数理最適化(MILP)生成 Web Worker（ベータ）
   既存の焼きなまし(optimizer.worker.js)とは独立。HiGHS(WASM)は
   選択時に初めて CDN から読み込む（遅延ロード）。
   =========================================== */
self.importScripts('data.js?v=122', 'optimizer.js?v=122', 'milp-core.js?v=122');

// HiGHS(WASM) はリポジトリ内に同梱（オフライン可・CDN不要）。パスは worker(js/) から相対。
const HIGHS_BASE = 'vendor/';
let _solverPromise = null;
function getSolver() {
  if (!_solverPromise) {
    self.importScripts(HIGHS_BASE + 'highs.js?v=122'); // → self.Module（Emscripten factory）
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
    for (const g of groups) {
      post(20 + Math.floor((gi / groups.length) * 60),
           `【${g.label || g.key}】を数理最適化で計算中...` + (deep ? '（じっくりモード）' : ''));
      const m = MILP.buildGroupModel(g.staff, g.reqs, g.dailyReqs);
      // 人数に応じて解き方を自動で切り替える（スケール対応）。
      const n = (g.staff || []).length;
      // 厳密解(gap=0)は人数が増えると急に重くなる（実測: 約20人で5分級）。
      // そこで gap=0 を狙いつつ時間上限120秒でキャップし、間に合わなければ
      // その時点のほぼ最良解を返す（＝待ち時間を必ず2分以内に抑える）。
      // 20人超は最初から「ほぼ最良で早期停止」に切り替えて高速化。
      let opts;
      if (deep) {
        opts = { time_limit: 540, mip_rel_gap: 0, mip_abs_gap: 0, presolve: 'on' };
      } else if (n <= 20) {
        opts = { time_limit: 120, mip_rel_gap: 0, mip_abs_gap: 0, presolve: 'on' };
      } else {
        opts = { time_limit: Math.min(240, 60 + n * 2), mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
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
    self.postMessage({ type: 'done', shifts, violations, allOptimal, deep });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
});
