/* ===========================================
   milp.v6.js — 数理最適化(MILP)生成のメインスレッド窓口（ベータ）
   milp.worker.js を起動して解かせ、結果を AppState に反映する。
   Worker が使えない/失敗した場合は reject（呼び出し側で焼きなましにフォールバック）。
   =========================================== */
// settingsPatch: 試し計算のときだけ設定を変えて解く（AppState.settings は書き換えない）。
// 書き換えてから戻す方式だと、計算中に自動保存が走ると変えた値が保存されてしまう。
function _milpPayload(settingsPatch) {
  let settings = AppState.settings;
  if (settingsPatch) {
    settings = Object.assign({}, AppState.settings, settingsPatch);
    if (settingsPatch.penalties) settings.penalties = Object.assign({}, AppState.settings.penalties || {}, settingsPatch.penalties);
  }
  return {
    settings:              settings,
    shiftTypes:            AppState.shiftTypes,
    roleRequirements:      AppState.roleRequirements,
    roleRequirementsCast:  AppState.roleRequirementsCast,
    dailyRequirements:     AppState.dailyRequirements,
    dailyRequirementsCast: AppState.dailyRequirementsCast,
    skills:                AppState.skills,
    dailySkills:           AppState.dailySkills,
    shifts:                AppState.shifts,   // 微調整のとき、いまの表を出発点にする
    staff:                 AppState.staff,
    requests:              AppState.requests,
    fixedShifts:           AppState.fixedShifts,
    specialDays:           AppState.specialDays,
    events:                AppState.events,
  };
}

// 動いている計算（Worker）の一覧。「⏹ 中止」で全部止めるために覚えておく。
// これまで中止ボタンは古い計算（焼きなまし）の Worker しか止めておらず、
// 数理最適化は止まらずに最後まで走り、終わった結果で表が置き換わっていた。
const _milpRunning = new Set();
function _milpTrack(worker, onAbort) {
  const h = { abort: () => { try { worker.terminate(); } catch (_) {} onAbort(); } };
  _milpRunning.add(h);
  return () => _milpRunning.delete(h);
}
// 中止した回数。計算を始めたときの値と、終わったときの値が違えば中止されたとみなし、
// 先に終わっていた答えがあっても使わない（4本のうち1本だけ終わっていた場合など）。
let _milpCancelSeq = 0;
/** 動いている数理最適化をすべて止める。止めたものがあれば true */
function cancelMILP() {
  _milpCancelSeq++;
  const any = _milpRunning.size > 0;
  Array.from(_milpRunning).forEach(h => { _milpRunning.delete(h); h.abort(); });
  return any;
}
function milpRunning() { return _milpRunning.size > 0; }
const MILP_CANCEL_MSG = 'cancel: 中止しました';

// 計算は一度に1つだけ。生成中に「エラーを自動修正」などを押すと計算が同時に走り、
// 後から終わった古いほうの結果で表が上書きされることがあった。
// 計算を始める所（生成・自動修正・途中から作り直す・余の使い道・余の解消）は
// calcBegin で始め、終わったら必ず calcEnd を呼ぶ。計算中は下のボタンを押せなくする。
let _calcOwner = null;
const CALC_BUTTONS = ['btnGenerate', 'btnGenerateFast', 'btnWizard', 'btnRepair', 'btnPartialRegen',
                      'btnSurplusPlan', 'btnRelax', 'btnResolveSurplus'];
function calcBusy() { return !!_calcOwner; }
// ⏹ 中止ボタンがあるのは、生成と自動修正だけ。ほかの計算では中止を案内しない
// （ボタンが無いのに「⏹ 中止を押して」と案内していた）。確認待ちは、答えるよう案内する。
const CALC_HAS_STOP = new Set(['生成', 'エラーの自動修正']);
function calcBusyToast() {
  if (typeof toast !== 'function') return;
  const what = _calcOwner || '計算';
  const how = /確認待ち/.test(what) ? '余の解消パネルの「実行しますか？」に答えてからにしてください'
            : CALC_HAS_STOP.has(what) ? '終わるのを待つか、⏹ 中止を押してからにしてください'
            : '終わるまでお待ちください';
  toast(`いまは「${what}」の${/確認待ち/.test(what) ? '途中' : '計算中'}です。${how}`, 'warning', 6000);
}
/** 計算を始めてよければ true。ほかの計算中なら知らせて false */
function calcBegin(label) {
  if (_calcOwner) { calcBusyToast(); return false; }
  _calcOwner = label || '計算';
  _calcButtons(true);
  return true;
}
function calcEnd() { _calcOwner = null; _calcButtons(false); }
function _calcButtons(on) {
  if (typeof document === 'undefined') return;
  CALC_BUTTONS.forEach(id => {
    const b = document.getElementById(id); if (!b) return;
    if (on) { if (!b.disabled) { b.disabled = true; b.dataset.calcLocked = '1'; } }
    else if (b.dataset.calcLocked) { b.disabled = false; delete b.dataset.calcLocked; }
  });
}

/**
 * ③複数同時実行: 解き方の違う計算を同時に走らせ、一番エラーが少ないものを採る。
 * シフト作成は「たまたま良い枝に入れるか」で結果がぶれるため、
 * 何本か走らせて最良を選ぶだけで、同じ時間でも結果が安定して良くなる。
 * 設定 parallelSolve を false にすると、従来どおり1本だけで解く。
 */
function _parallelCount() {
  if (AppState.settings && AppState.settings.parallelSolve === false) return 1;
  const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  // CPUを1つは画面用に空ける。最大4本（Workerごとにソルバーを読むためメモリを食う）
  return Math.max(1, Math.min(4, hw - 1));
}

/**
 * 候補を比べるための1回ぶんの計算。AppState を一切書き換えず、
 * 渡された内容だけで解いて結果を返す。これにより複数の候補を同時に走らせられる。
 * 比べるだけなら解き方は1通りでよく、候補どうしを並列にした方が全体は速い。
 * @param {Object} payload  _milpPayload() と同じ形（fixedShifts などを差し替えたもの）
 * @returns {Promise<{shifts:Object, violations:Array}>}
 */
function milpTrial(payload, variant, timeOverride) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('このブラウザは数理最適化(Worker)に非対応です')); return; }
    let worker;
    try { worker = new Worker('js/milp.worker.js?v=225'); }
    catch (e) { reject(new Error('数理最適化Workerを起動できません: ' + e.message)); return; }
    const untrack = _milpTrack(worker, () => { clearTimeout(timeout); reject(new Error(MILP_CANCEL_MSG)); });
    const timeout = setTimeout(() => { untrack(); try { worker.terminate(); } catch (_) {} reject(new Error('タイムアウト')); }, 600000);
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') return;
      if (m.type === 'done')  { untrack(); clearTimeout(timeout); worker.terminate(); resolve({ shifts: m.shifts || {}, violations: m.violations || [] }); return; }
      if (m.type === 'error') { untrack(); clearTimeout(timeout); worker.terminate(); reject(new Error(m.message || '数理最適化エラー')); return; }
    };
    worker.onerror = (err) => { untrack(); clearTimeout(timeout); try { worker.terminate(); } catch (_) {} reject(new Error(err.message || 'Workerエラー')); };
    worker.postMessage({ type: 'milp', appState: payload, fastMode: true, timeOverride: parseInt(timeOverride) || 0, variant: parseInt(variant) || 0 });
  });
}

// 同時に走らせてよいWorkerの数（画面用に1つ空ける）
function milpParallelCount() { return _parallelCount(); }

// 選んだ答えを画面の表へ反映する。opts.noApply（試し計算）のときは反映しない。
// 試し計算の結果で本物の表を置き換えると、閉じても戻らず、次の自動保存で保存されてしまう。
function _milpApply(best, opts) {
  if (opts && opts.noApply) return;
  AppState.shifts = best._shifts || AppState.shifts;
  AppState.violations = best.violations;
  AppState.generated = true;
}

function optimizeScheduleMILP(onProgress, opts) {
  const n = _parallelCount();
  // 微調整モードは「いまの表を最小限だけ直す」ので、ぶれが小さく並列の意味がない
  const seq = _milpCancelSeq;
  if (n <= 1 || (opts && opts.adjustMode)) {
    return _milpOnce(onProgress, opts, 0).then(r => {
      if (seq !== _milpCancelSeq) throw new Error(MILP_CANCEL_MSG);
      _milpApply(r, opts); return r;
    });
  }

  return new Promise((resolve, reject) => {
    const results = [], errors = [];
    let done = 0;
    const NAMES = ['ふつう', '時間を寄せる', '順番ちがい', '順番ちがい・寄せる'];
    // 「余の使い道を決める」からの呼び出しでは、エラーの少なさではなく
    // 「余をいちばん使い切れた答え」を採る。エラーで選ぶと、余を残した
    // 答えの方が点数が良いため、使い道の候補がほとんど出てこない。
    const pickBySurplus = !!(opts && opts.pickBy === 'surplus');
    const countRest = (sh) => { let n2 = 0; for (const id in (sh || {})) { const row = sh[id]; for (const d in row) if (row[d] === '余') n2++; } return n2; };
    // 並べ方は scoreCompare（optimizer.js）: ① 6連勤以上（コンプラ違反）の回数
    // ② 人員不足 ③ 🚨の件数（連勤は回数）④ 連勤の超過日数 ⑤ 🟡の件数。
    // 合計件数だけで比べると、🚨4件・合計11件が 🚨3件・合計12件に勝ってしまう。
    const better = (a, b) => scoreCompare(a.sc, b.sc);
    const say = () => {
      const best = results.length ? results.slice().sort(better)[0] : null;
      onProgress && onProgress(null,
        `${n}通りの解き方を同時に計算中…（完了 ${done}/${n}` +
        (best ? ` ・ いまの最良 ${scoreSummary(best.sc)}` : '') + '）');
    };
    say();
    for (let i = 0; i < n; i++) {
      _milpOnce((pct, label) => { if (i === 0 && label && /経過/.test(label)) say(); }, opts, i)
        .then(r => { results.push(Object.assign({ _label: NAMES[i % 4] }, r)); })
        .catch(e => { errors.push(e); })
        .finally(() => {
          done++; say();
          if (done < n) return;
          // 途中で中止されたら、先に終わっていた答えも使わない
          if (seq !== _milpCancelSeq) { reject(new Error(MILP_CANCEL_MSG)); return; }
          if (!results.length) { reject(errors[0] || new Error('数理最適化に失敗しました')); return; }
          // 一番エラーが少ないものを採用。同点なら「証明できた」方を優先する。
          if (pickBySurplus) results.sort((a, b) => countRest(a._shifts) - countRest(b._shifts) || better(a, b));
          else results.sort((a, b) => better(a, b) ||
                                 (a.allOptimal === b.allOptimal ? 0 : (a.allOptimal ? -1 : 1)));
          // エラー自動修正など「いまより改善する答え」だけが欲しいときは、先に改善になる答えへ
          // 絞ってから選ぶ（1位だけを確かめると、2位以下に改善する答えがあっても見逃す）。
          const pool = (opts && opts.improveOver)
            ? results.filter(r => scoreBetter(r.sc, opts.improveOver)) : results;
          const best = pool.length ? pool[0] : results[0];
          // 採用した解の表を、あらためて画面へ反映する（試し計算では反映しない）
          _milpApply(best, opts);
          best.parallel = { n, tried: results.map(r => ({ label: r._label, score: r.score, must: r.must, comp: r.sc.comp })) };
          resolve(best);
        });
    }
  });
}

function _milpOnce(onProgress, opts, variant) {
  const deepMode = !!(opts && opts.deepMode);
  const fastMode = !!(opts && opts.fastMode);
  // 微調整モード: いまの表から最小限だけ変えて、つじつまを合わせる
  const adjustMode = !!(opts && opts.adjustMode);
  const adjustK = (opts && opts.adjustK) || 24;
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('このブラウザは数理最適化(Worker)に非対応です')); return; }
    let worker;
    try { worker = new Worker('js/milp.worker.js?v=225'); }
    catch (e) { reject(new Error('数理最適化Workerを起動できません: ' + e.message)); return; }
    // 1部門あたり最大10分。部門数ぶん待てるよう十分な余裕を持たせる（誤タイムアウト防止）
    const timeout = setTimeout(() => { cleanup(); try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化がタイムアウトしました（30分）')); }, 1800000);
    // 計算中は1回の大きな処理でバーが止まって見えるため、経過秒数を出して「動いている」ことを示す
    const started = Date.now();
    let solving = false;
    const ticker = setInterval(() => {
      if (!solving) return;
      const sec = Math.floor((Date.now() - started) / 1000);
      const pct = Math.min(95, 30 + sec); // 見た目の進み（実際の内部進捗ではない）
      onProgress && onProgress(pct, `計算中… 経過${sec}秒（最良解を探索中。画面が止まって見えても動いています）`);
    }, 1000);
    let untrack = () => {};
    const cleanup = () => { untrack(); clearTimeout(timeout); clearInterval(ticker); };
    untrack = _milpTrack(worker, () => { cleanup(); reject(new Error(MILP_CANCEL_MSG)); });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { if (/計算中/.test(m.label || '')) solving = true; onProgress && onProgress(m.pct, m.label); return; }
      if (m.type === 'done') {
        cleanup(); worker.terminate();
        // ここでは画面の表に反映しない（4通りのうち1つが終わっただけ・試し計算のこともある）。
        // 反映は、選び終わったあとに _milpApply でまとめて行う。
        // 比べるための数（optimizer.js の scoreViolations）
        const _sc = scoreViolations(m.violations || []);
        resolve({ _shifts: m.shifts || {}, shifts: m.shifts || {}, violations: m.violations || [], score: _sc.total, must: _sc.must,
                  mustCount: _sc.mustCount, sc: _sc,
                  success: (m.violations || []).length === 0,
                  allOptimal: m.allOptimal !== false, deep: !!m.deep, fast: !!m.fast, usedGap: !!m.usedGap,
                  tiered: !!m.tiered, tierLog: m.tierLog || [] });
        return;
      }
      if (m.type === 'error') { cleanup(); worker.terminate(); reject(new Error(m.message || '数理最適化エラー')); return; }
    };
    worker.onerror = (err) => { cleanup(); try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化Workerエラー: ' + (err.message || 'ソルバーの読込みに失敗しました'))); };
    // timeOverride: 候補をいくつも組み直して比べるときに、1回あたりの時間を短くする
    worker.postMessage({ type: 'milp', appState: _milpPayload(opts && opts.settingsPatch), deepMode, fastMode, adjustMode, adjustK,
                         timeOverride: (opts && parseInt(opts.timeOverride)) || 0,
                         variant: parseInt(variant) || 0 });
  });
}
