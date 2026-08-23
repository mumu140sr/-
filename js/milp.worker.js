/* ===========================================
   milp.worker.js — 数理最適化(MILP)生成 Web Worker（ベータ）
   既存の焼きなまし(optimizer.worker.js)とは独立。HiGHS(WASM)は
   選択時に初めて CDN から読み込む（遅延ロード）。
   =========================================== */
self.importScripts('data.js?v=140', 'optimizer.js?v=140', 'milp-core.js?v=140');

// HiGHS(WASM) はリポジトリ内に同梱（オフライン可・CDN不要）。パスは worker(js/) から相対。
const HIGHS_BASE = 'vendor/';
let _solverPromise = null;
function getSolver() {
  if (!_solverPromise) {
    self.importScripts(HIGHS_BASE + 'highs.js?v=140'); // → self.Module（Emscripten factory）
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
    // 証明なし（速い）モード: 1部門あたり60秒で打ち切り、最良の証明はしない
    const fast = !!msg.fastMode;
    const TIME_LIMIT = 600;   // 秒 = 10分（証明ありモードの上限）
    const FAST_LIMIT = 60;    // 秒 = 1分（証明なしモードの上限）
    let allOptimal = true;   // 全グループで最適が証明できたか（false=時間切れで打ち切り）
    let usedGap = false;     // 早期停止(gap許容)を使ったか＝じっくりモードで改善余地あり
    // 段階最適化を使うか（既定ON。設定でOFFにすると従来どおり一括で解く）
    const tiered = (incoming.settings || {}).tieredOptimize !== false;
    const tierLog = [];      // 各段で達成した件数（画面に出す）
    for (const g of groups) {
      post(20 + Math.floor((gi / groups.length) * 60),
           `【${g.label || g.key}】を数理最適化で計算中...` +
           (fast ? '（速い・最大60秒）' : deep ? '（じっくりモード）' : ''));
      const m = MILP.buildGroupModel(g.staff, g.reqs, g.dailyReqs);
      // 1部門あたりの計算時間の上限（最大10分）。
      // 20人以下は gap=0（最適の証明）を狙い、20人超は「ほぼ最良で早期停止」に
      // 切り替えて高速化する（じっくりモードでは早期停止を無効にする）。
      const n = (g.staff || []).length;
      let opts;
      if (fast) {
        // 証明なし（速い）: 1部門60秒で打ち切り、ほぼ最良のところで止める
        opts = { time_limit: FAST_LIMIT, mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
        usedGap = true;
      } else if (deep || n <= 20) {
        // 証明あり: 「これ以上良い解は無い」と証明できるまで解く（1部門最大10分）
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0, mip_abs_gap: 0, presolve: 'on' };
      } else {
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
        usedGap = true;   // 早期停止あり＝じっくりモードで更に良くなる可能性がある
      }
      // ── 段階最適化（tiered）──────────────────────────────
      // 全ルールを一度に解くのをやめ、大事な順に「そのルールだけ」を0に近づける。
      // 達成した件数は次の段で上限として固定するので、重要なルールが後から崩れない。
      let sol = null;
      if (tiered) {
        const tiers = MILP.TIERS.filter(t => (t.types || []).some(ty => (m.parts.slackByType[ty] || []).length));
        const budgets = [];
        // 時間配分: 早い段は数秒で終わるので、余った時間を後の段に回す。
        // ただし1つの段が全部使い切って後の段を飢えさせないよう、必ず後続分を残す。
        const MIN_PER = 5;                       // 1段あたりの最低秒数
        let remain = opts.time_limit;
        for (let ti = 0; ti < tiers.length; ti++) {
          const t = tiers[ti];
          const left = tiers.length - ti - 1;     // この段より後に残っている段数
          const cap = Math.max(MIN_PER, remain - MIN_PER * left);
          post(20 + Math.floor(((gi + (ti + 1) / (tiers.length + 1)) / groups.length) * 60),
               `【${g.label || g.key}】第${ti + 1}段「${t.label}」を0に近づけています…`);
          const lp = MILP.composeLP(m.parts, { types: t.types, budgets });
          const t0 = Date.now();
          const s2 = solver.solve(lp, Object.assign({}, opts, { time_limit: cap }));
          remain = Math.max(0, remain - Math.round((Date.now() - t0) / 1000));
          if (String(s2 && s2.Status) !== 'Optimal') allOptimal = false;
          if (!s2 || !s2.Columns) break;         // 解が返らなければ直前の解を使う
          sol = s2;
          // この段で達成した件数を上限として固定（以後の段で悪化させない）
          const got = MILP.slackTotal(sol, m.parts, t.types);
          budgets.push({ names: MILP.slackNames(m.parts, t.types), max: got });
        }
      }
      if (!sol) sol = solver.solve(m.lp, opts);
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
    // 段ごとの結果は、実際の違反件数から作る（内部の罰点変数の合計は
    // 1件の違反に複数の変数が対応することがあり、件数として正しくない）
    if (tiered) {
      const byType = {};
      violations.forEach(v => { byType[v.type] = (byType[v.type] || 0) + 1; });
      MILP.TIERS.forEach(t => {
        const n = (t.types || []).reduce((a, ty) => a + (byType[ty] || 0), 0);
        tierLog.push(`${t.label}: ${n}件`);
      });
    }
    self.postMessage({ type: 'done', shifts, violations, allOptimal, deep, fast, usedGap, tiered, tierLog });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
});
