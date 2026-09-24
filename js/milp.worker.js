/* ===========================================
   milp.worker.js — 数理最適化(MILP)生成 Web Worker（ベータ）
   既存の焼きなまし(optimizer.worker.js)とは独立。HiGHS(WASM)は
   選択時に初めて CDN から読み込む（遅延ロード）。
   =========================================== */
self.importScripts('data.js?v=228', 'optimizer.js?v=228', 'milp-core.js?v=228');

// HiGHS(WASM) はリポジトリ内に同梱（オフライン可・CDN不要）。パスは worker(js/) から相対。
const HIGHS_BASE = 'vendor/';
let _solverPromise = null;
function getSolver() {
  if (!_solverPromise) {
    self.importScripts(HIGHS_BASE + 'highs.js?v=228'); // → self.Module（Emscripten factory）
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
    const seedShifts     = incoming.shifts      || {};
    AppState.requests    = incoming.requests    || {};
    AppState.fixedShifts = incoming.fixedShifts || {};
    AppState.specialDays = incoming.specialDays || {};
    AppState.events      = incoming.events      || [];
    AppState.shifts = {};
    AppState.violations = [];

    const VARLABEL = ['ふつう', '時間を寄せる', '順番ちがい', '順番ちがい・寄せる'][(parseInt(msg.variant) || 0) % 4];
    // 段の並び（リズムの2段の順番）はバリエーション2・3で入れ替える
    const TIER_RAW = (typeof MILP.tiersForVariant === 'function')
      ? MILP.tiersForVariant(msg.variant) : MILP.TIERS;
    // 利用者が「絶対」にしたルールを、🟡のルールより先に解く
    const TIER_BASE = (!msg.noPromote && typeof MILP.promoteMustTiers === 'function')
      ? MILP.promoteMustTiers(TIER_RAW) : TIER_RAW;
    // 時間配分のクセ。実測で、時間切れになる段（リズム）に時間を寄せ、
    // 優先度の低い後ろ3段を軽くすると大きく減るデータと、逆に悪くなるデータが
    // あった。どちらが当たりかは月によって変わるので、4通りのうち2通りを
    // 従来配分、2通りを「寄せる配分」にして、良かった方を採る。
    //   実測（実データ4件・1分生成）従来のみ57件 / 寄せる配分のみ42件 /
    //   両方を並べて良い方を採ると38件
    const PROF = [
      { rhythmW: 0, tailW: 0, minPer: 5, polish: 0.25 },     // 0 従来どおり
      { rhythmW: 4, tailW: 0.4, minPer: 3, polish: 0.15 },   // 1 詰まる段に寄せる
      { rhythmW: 0, tailW: 0, minPer: 5, polish: 0.25 },     // 2 従来どおり（順番ちがい）
      { rhythmW: 4, tailW: 0.4, minPer: 3, polish: 0.15 },   // 3 寄せる（順番ちがい）
    ][(parseInt(msg.variant) || 0) % 4];
    const TAIL_LABELS = ['早遅バランス', '単発休み', '上下関係'];
    const TIER_LIST = (!PROF.rhythmW && !PROF.tailW) ? TIER_BASE : TIER_BASE.map(t => {
      if (PROF.rhythmW && /^リズム/.test(t.label)) return Object.assign({}, t, { w: PROF.rhythmW });
      if (PROF.tailW && TAIL_LABELS.indexOf(t.label) >= 0) return Object.assign({}, t, { w: PROF.tailW });
      return t;
    });
    post(5, '数理最適化ソルバーを読込み中（初回のみ）...');
    const solver = await getSolver();

    const groups = getDepartmentGroups(AppState.staff);
    const shifts = {};
    let gi = 0;
    // 「じっくり最適化」モードでは時間上限を大幅に延ばし、必ず gap=0（最適の証明）を狙う
    const deep = !!msg.deepMode;
    // 証明なし（速い）モード: 1部門あたり60秒で打ち切り、最良の証明はしない
    const fast = !!msg.fastMode;
    const adjust = !!msg.adjustMode;      // 微調整モード
    const adjustK = parseInt(msg.adjustK) || 24;
    // ── 解き方のバリエーション（③複数同時実行）────────────────
    // 同じ問題でも、段の順番や探索の広さを変えると結果が変わる。
    // 別々のWorkerに違う番号を渡し、一番良かったものを採用する。
    const variant = parseInt(msg.variant) || 0;
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
      // 実験・検証用に持ち時間を指定できるようにする（画面からは使わない）
      const OVERRIDE = parseInt(msg.timeOverride) || 0;
      if (fast) {
        // 証明なし（速い）: 1部門60秒で打ち切り、ほぼ最良のところで止める
        opts = { time_limit: OVERRIDE || FAST_LIMIT, mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
        usedGap = true;
      } else if (deep || n <= 20) {
        // 証明あり: 「これ以上良い解は無い」と証明できるまで解く（1部門最大10分）
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0, mip_abs_gap: 0, presolve: 'on' };
      } else {
        opts = { time_limit: TIME_LIMIT, mip_rel_gap: 0.02, mip_abs_gap: 2000, presolve: 'on' };
        usedGap = true;   // 早期停止あり＝じっくりモードで更に良くなる可能性がある
      }
      // 「最良と証明できた」と言えるか。gap を許す設定（21人以上・速い生成）では、HiGHS は
      // 「2%・2000点以内」に入った時点で Optimal を返すので、Optimal でも証明にならない。
      // 返ってくる答えに gap は入っていないため、設定で判断する。件数が0なら、それ以上
      // 減らしようがないので、gap を許していても証明済みとしてよい。
      const exact = !(opts.mip_rel_gap > 0) && !(opts.mip_abs_gap > 0);
      const provenOf = (s, types) => String(s && s.Status) === 'Optimal' &&
        (exact || MILP.slackTotal(s, m.parts, types) === 0);
      // ── 微調整モード ────────────────────────────────────
      // いまの表を出発点に、決まった数のコマまでしか変えずにつじつまを合わせる。
      // 表全体が作り直されないので、確認済みの並びが崩れない。
      if (adjust) {
        const ones = {};
        g.staff.forEach(s => {
          const si = m.sidOf[s.id];
          for (let d = 1; d <= m.days; d++) {
            const v = (seedShifts[s.id] || {})[d];
            if (!v) continue;
            if (v === '有') ones[`y_${si}_${d}`] = 1;
            else if (m.roleIdx[v] != null) ones[`x_${si}_${d}_${m.roleIdx[v]}`] = 1;
          }
        });
        post(20 + Math.floor((gi / groups.length) * 60),
             `【${g.label || g.key}】いまの表を最小限だけ直しています…`);
        const s2 = solver.solve(MILP.composeLP(m.parts, { neighbor: { ones, k: adjustK } }),
                                Object.assign({}, opts, { time_limit: Math.min(20, opts.time_limit) }));   // 微調整は20秒上限
        if (MILP.solutionIsValid(s2, m.parts, [])) {
          // 近くだけ（K マスまで）を探したので、Optimal でも全体の最良の証明ではない
          allOptimal = false;
          MILP.applyGroupSolution(m, s2, shifts);
          gi++;
          continue;
        }
        // 直せなければ、いまの表をそのまま使う
        g.staff.forEach(s => { shifts[s.id] = Object.assign({}, seedShifts[s.id] || {}); });
        gi++;
        continue;
      }

      // ── 段階最適化（tiered）──────────────────────────────
      // 全ルールを一度に解くのをやめ、大事な順に「そのルールだけ」を0に近づける。
      // 達成した件数は次の段で上限として固定するので、重要なルールが後から崩れない。
      let sol = null;
      // 解き方の違い（バリエーション）。0番は従来どおり。
      // 変えるのは「近傍の広さ（1回の探し直しで何マスまで動かしてよいか）」と
      // ソルバーの乱数だけ。どれも標準に近い解き方なので、外れが出にくい。
      // 実測（実データ60秒）では 13/25/11/8件 とばらつき、最良の8件を採れた。
      // 0・1番は「休みの間隔 → 早遅の切替」の順、2・3番は逆の順で解く。
      // どちらが良いかはデータ次第なので、並列で両方試して良い方を採る。
      const VAR = [
        { label: 'ふつう',   k: 60,  seed: 0  },
        { label: '時間を寄せる', k: 92,  seed: 11 },
        { label: '順番ちがい', k: 60, seed: 22 },
        { label: '順番ちがい・寄せる', k: 110, seed: 33 },
      ][variant % 4];
      const NBK = VAR.k;
      if (VAR.seed) opts = Object.assign({}, opts, { random_seed: VAR.seed });
      // 段階最適化では「各段が最適だと証明できたか」で判定する。
      // 仕上げ処理は数秒上限で回すので必ず Time limit reached を返し、
      // その状態を見てしまうと、全段が証明済みでも「時間切れ」と表示されてしまう。
      let tierProven = true;
      if (tiered) {
        // 段の並びはバリエーションによって変える（リズムの2段の順番だけが違う）。
        const tiers = TIER_LIST.filter(t => (t.types || []).some(ty => (m.parts.slackByType[ty] || []).length));
        const budgets = [];        // 検算用（採用可否のチェックに使う）
        const protect = [];        // 前の段までのルール（重みで守る）
        // 時間配分: 早い段は数秒で終わるので、余った時間を後の段に回す。
        // ただし1つの段が全部使い切って後の段を飢えさせないよう、必ず後続分を残す。
        const MIN_PER = PROF.minPer;             // 1段あたりの最低秒数（配分のクセで変わる）
        let wLeft = tiers.reduce((a, t) => a + (t.w || 1), 0);   // 残りの重みの合計
        // 仕上げ用に25%を取り置く。段が持ち時間を全部使い切ると仕上げが動かない。
        // じっくりモードは「一巡目」を短めに切り上げ、残ったルールを何度でも
        // 詰め直すラウンドに時間を厚く回す（0件を狙うのに効く）。
        const polishBudget = Math.max(8, Math.floor(opts.time_limit * (deep ? 0.55 : PROF.polish)));
        let remain = opts.time_limit - polishBudget;
        const bIdx = [];           // 段ごとの上限（budgets の何番目か）
        // 段ごとの止めどころ（「2000点・2%以内なら止める」を段ごとに細かくする案）は、
        // 実データ3件＋固定なし・人手不足のデータ1件を各5回測って、差がぶれの中だったので
        // 入れていない（v214 以前と同じ止めどころのまま）。
        const tierOpts = () => opts;
        for (let ti = 0; ti < tiers.length; ti++) {
          const t = tiers[ti];
          const left = tiers.length - ti - 1;     // この段より後に残っている段数
          // 残り時間を、段ごとの重みで配分する。等分にすると、数秒で終わる段にも
          // 時間を取られ、5〜10秒必要な段が時間切れになってしまう。
          const cap = Math.max(MIN_PER, Math.floor(remain * (t.w || 1) / Math.max(1, wLeft)));
          wLeft -= (t.w || 1);
          post(20 + Math.floor(((gi + (ti + 1) / (tiers.length + 1)) / groups.length) * 60),
               `【${g.label || g.key}】第${ti + 1}段「${t.label}」を0に近づけています…`);
          const t0 = Date.now();
          const topts = tierOpts(t);
          // コンプラ（6連勤以上）の段: 目的が6連勤の罰だけなので「誰も出勤しない」答えが最適に
          // なる。これを「解けなかった」として捨てていたため、固定の出勤マスが無い部門では
          // 上限が記録されず、6連勤以上が防げていなかった。出勤0件の答えも受け入れて、
          // 件数だけを次の段からの上限として残す。答えそのものは出発点にしない（空の表から
          // 近くを探しても意味がないため）。
          if (t.types.length === 1 && t.types[0] === 'comp-cons') {
            const sC = solver.solve(MILP.composeLP(m.parts, { types: t.types, budgets }),
                                    Object.assign({}, topts, { time_limit: Math.max(3, cap) }));
            const okC = MILP.solutionIsValid(sC, m.parts, budgets, true);
            if (okC) {
              bIdx[ti] = budgets.length;
              budgets.push({ names: MILP.slackNames(m.parts, t.types), max: MILP.slackTotal(sC, m.parts, t.types) });
              (t.types || []).forEach(ty => protect.push(ty));
            }
            if (!okC || !provenOf(sC, t.types)) tierProven = false;
            if (msg.trace) self.postMessage({ type: 'trace', ti, label: t.label, cap,
              sec: Math.round((Date.now() - t0) / 1000), status: String(sC && sC.Status), okStrict: okC,
              prev: null, got: okC ? MILP.slackTotal(sC, m.parts, t.types) : null });
            remain = Math.max(0, remain - Math.round((Date.now() - t0) / 1000));
            continue;
          }
          // ① まず「前の段は上限を超えない」という条件付きで解く。速くて確実だが、
          //    条件が積み上がると、成立する組合せを一から見つけられないことがある。
          // 前の答えが無い段（コンプラの次の人員の段など）は、時間切れでも近傍探索に逃げられない。
          // 持ち時間の6割（速い生成では3秒）だけで打ち切ると、途中の答え（人員不足44件など）が
          // そのまま上限として固定されていた。前の答えが無いときは持ち時間を全部使う。
          let s2 = solver.solve(MILP.composeLP(m.parts, { types: t.types, budgets }),
                                Object.assign({}, topts, { time_limit: sol ? Math.max(3, Math.floor(cap * 0.6)) : Math.max(3, cap) }));
          let okStrict = MILP.solutionIsValid(s2, m.parts, budgets);
          // 「最後まで計算できた」と言えるのは、この段を条件付きで一から解いて Optimal に
          // なったときだけ。近くだけを探し直した答え（近傍探索）の Optimal は「近くの中で
          // 一番良い」という意味で全体の最良ではない。前の答えを使い回したときも同じ。
          let provenHere = okStrict && provenOf(s2, t.types);
          // 前の答えが無く、持ち時間を使い切っても途中の答えのままなら、その答えを出発点に
          // 続けて解く（全体の残り時間から、この段の持ち時間ぶんまで）。
          if (!sol && okStrict && !provenHere && MILP.slackTotal(s2, m.parts, t.types) > 0) {
            const more = Math.min(cap, Math.max(0, remain - cap));
            if (more >= 3) {
              // 使った時間は、この段の最後にまとめて remain から引かれる
              const s3 = solver.solve(
                MILP.composeLP(m.parts, { types: t.types, budgets, neighbor: { ones: MILP.onesOf(s2), k: NBK * 2 } }),
                Object.assign({}, topts, { time_limit: more }));
              if (MILP.solutionIsValid(s3, m.parts, budgets) &&
                  MILP.slackTotal(s3, m.parts, t.types) < MILP.slackTotal(s2, m.parts, t.types)) s2 = s3;
            }
          }
          if (!okStrict && sol) {
            // ② 見つからなければ「近傍探索」に切り替える。いまの答えから
            //    決まった数のマスまでしか変えない、という条件を足して解く。
            //    いまの答え自体が条件を満たすので、必ず解が見つかる。
            const s3 = solver.solve(
              MILP.composeLP(m.parts, { types: t.types, budgets, neighbor: { ones: MILP.onesOf(sol), k: NBK } }),
              Object.assign({}, topts, { time_limit: Math.max(3, cap - Math.round((Date.now() - t0) / 1000)) }));
            // 近傍探索でも「前の段を悪化させていないか」は必ず確認する
            if (MILP.solutionIsValid(s3, m.parts, budgets)) { s2 = s3; okStrict = true; provenHere = false; }
          } else if (okStrict && String(s2.Status) !== 'Optimal' && sol) {
            // ②' 時間切れで中途半端な答えしか出なかった場合、残り時間を捨てずに
            //     近傍探索でもう一度探し、件数が少ない方を採用する。
            const rest = cap - Math.round((Date.now() - t0) / 1000);
            if (rest >= 3) {
              const s3 = solver.solve(
                MILP.composeLP(m.parts, { types: t.types, budgets, neighbor: { ones: MILP.onesOf(sol), k: NBK } }),
                Object.assign({}, topts, { time_limit: rest }));
              if (MILP.solutionIsValid(s3, m.parts, budgets) &&
                  MILP.slackTotal(s3, m.parts, t.types) < MILP.slackTotal(s2, m.parts, t.types)) { s2 = s3; provenHere = false; }
            }
          }
          // 段の結果が、いま持っている答えより悪ければ、いまの答えを使う。
          // 実測で、早遅バランスの段が、前の答えでは0なのに 25・81 を返していた。
          //     いまの答えは前の段までの上限をすべて守っているので、必ず使える。
          if (!msg.noGuard && okStrict && sol &&
              MILP.slackTotal(s2, m.parts, t.types) > MILP.slackTotal(sol, m.parts, t.types)) { s2 = sol; provenHere = false; }
          // 検証用の記録（画面からは使わない）
          if (msg.trace) self.postMessage({ type: 'trace', ti, label: t.label, cap,
            sec: Math.round((Date.now() - t0) / 1000), status: String(s2 && s2.Status), okStrict,
            prev: sol ? MILP.slackTotal(sol, m.parts, t.types) : null,
            got: okStrict ? MILP.slackTotal(s2, m.parts, t.types) : null });
          remain = Math.max(0, remain - Math.round((Date.now() - t0) / 1000));
          if (!provenHere) tierProven = false;
          // どちらの方式でも前の段を守れなかった場合は、この段の結果は採用しない。
          // ただし後ろの段は打ち切らない（別の段なら解けることがあるため）。
          if (!okStrict) {
            tierProven = false;
            if (sol) {
              // 今の解での件数を上限として引き継ぎ、後の段で悪化させないようにする
              bIdx[ti] = budgets.length;
              budgets.push({ names: MILP.slackNames(m.parts, t.types), max: MILP.slackTotal(sol, m.parts, t.types) });
              (t.types || []).forEach(ty => protect.push(ty));
            }
            continue;
          }
          sol = s2;
          // この段で達成した件数を上限として固定（以後の段で悪化させない）
          const got = MILP.slackTotal(sol, m.parts, t.types);
          bIdx[ti] = budgets.length;
          budgets.push({ names: MILP.slackNames(m.parts, t.types), max: got });
          (t.types || []).forEach(ty => protect.push(ty));
        }

        // ── じっくりモード: 0にならなかった段を、何度でも詰め直す ──────
        // 一巡しただけでは詰め切れない段がある。残っている段だけを対象に、
        // 探索の広さを少しずつ広げながら、全部0になるか時間切れになるまで繰り返す。
        let polishLeft = polishBudget + remain;
        if (deep && sol) {
          const KS = [80, 160, 320, 0];   // 探索の広さ（0＝制限なし＝一から探し直す）
          let ki = 0;
          const reserve = Math.max(8, Math.floor(polishLeft * 0.15));  // 仕上げ用に残す
          let budget = polishLeft - reserve;
          while (budget >= 10) {
            // まだ0になっていない段を、件数の多い順に詰め直す
            const pend = [];
            tiers.forEach((t, i) => {
              const cur = MILP.slackTotal(sol, m.parts, t.types);
              if (cur > 0) pend.push({ t, i, cur });
            });
            if (!pend.length) break;                    // 全段0＝完成なので即終了
            pend.sort((a, b) => b.cur - a.cur);
            let improved = false;
            for (const p of pend) {
              if (budget < 10) break;
              const slice = Math.max(10, Math.min(90, Math.floor(budget / pend.length)));
              post(20 + Math.floor(((gi + 0.9) / groups.length) * 60),
                   `【${g.label || g.key}】「${p.t.label}」の残り${p.cur}件を詰め直しています…`);
              const q0 = Date.now();
              const nb = KS[ki] ? { ones: MILP.onesOf(sol), k: KS[ki] } : null;
              const s5 = solver.solve(
                MILP.composeLP(m.parts, { types: p.t.types, budgets, neighbor: nb }),
                Object.assign({}, opts, { time_limit: slice }));
              const used = Math.max(1, Math.round((Date.now() - q0) / 1000));
              budget -= used; polishLeft = Math.max(0, polishLeft - used);
              if (!MILP.solutionIsValid(s5, m.parts, budgets)) continue;
              const got2 = MILP.slackTotal(s5, m.parts, p.t.types);
              if (got2 < p.cur) {
                sol = s5;
                improved = true;
                // 良くなった分だけ上限も締め直す（後の詰め直しで戻らないように）
                const bi = bIdx[p.i];
                if (bi != null) budgets[bi].max = got2;
              }
            }
            // どの段も良くならなければ、探索の広さを一段広げて再挑戦
            if (!improved) { ki++; if (ki >= KS.length) break; }
          }
        }
        // ── 仕上げ ────────────────────────────────────────
        // 段が一通り終わったら、余った時間で「いまの解の近く」を何度も探し直し、
        // 全ルールの合計罰点を下げる。良くならなければ即やめるので無駄がない。
        let polish = polishLeft, best = null;      // 取り置き分＋段で余った分
        while (polish >= 4 && sol) {
          const p0 = Date.now();
          // budgets を付けるのが重要。付けないと、細かいルールを良くするために
          // 人員不足や公休不足を悪化させた解が「総罰点が下がった」と誤判定される。
          // （段ごとの解では、その段に関係しない罰点変数の値が抑えられていないため）
          const s4 = solver.solve(MILP.composeLP(m.parts, { budgets, neighbor: { ones: MILP.onesOf(sol), k: NBK } }),
                                  Object.assign({}, opts, { time_limit: Math.min(8, polish) }));
          polish -= Math.max(1, Math.round((Date.now() - p0) / 1000));
          if (!MILP.solutionIsValid(s4, m.parts, budgets)) break;
          const prev = best === null ? Infinity : best;
          const now  = MILP.objTotal(s4, m.parts);
          if (now < prev - 1e-6) { sol = s4; best = now; }
          else break;      // これ以上良くならない
        }
      }
      if (!sol) { sol = solver.solve(m.lp, opts); tierProven = exact && String(sol && sol.Status) === 'Optimal'; }
      // 時間切れかどうかは「各段を証明できたか」で決める。仕上げ処理の Status は見ない。
      if (!tierProven) allOptimal = false;
      MILP.applyGroupSolution(m, sol, shifts);
      gi++;
    }
    post(85, '仕上げ中：公休を整理中...');
    AppState.shifts = shifts;
    try { if (typeof markSurplusRest === 'function') markSurplusRest(shifts); }
    catch (e1) { self.postMessage({ type: 'progress', pct: 88, label: '公休整理をスキップ（' + e1.message + '）' }); }
    // 検査で確かめながら、入れ替えで減らせるところを減らす（🚨は絶対に増やさない）
    if (!adjust && !msg.noPolish && typeof polishShifts === 'function') {
      post(90, '仕上げ中：入れ替えで減らせるところを探しています…');
      try { polishShifts(shifts, { timeMs: 6000 }); }
      catch (e3) { self.postMessage({ type: 'progress', pct: 90, label: '入れ替えをスキップ（' + e3.message + '）' }); }
    }
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
      // コンプラの段の中身（comp-cons）は、検査では「6連勤以上の印が付いた連勤超過」として出る
      byType['comp-cons'] = violations.filter(v => v.type === 'consecutive' && v.compliance).length;
      TIER_LIST.forEach(t => {
        const n = (t.types || []).reduce((a, ty) => a + (byType[ty] || 0), 0);
        tierLog.push(`${t.label}: ${n}件`);
      });
    }
    self.postMessage({ type: 'done', shifts, violations, allOptimal, deep, fast, usedGap, tiered, tierLog, variant, variantLabel: VARLABEL });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
});
