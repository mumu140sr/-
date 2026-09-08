/* ===========================================
   milp.v6.js — 数理最適化(MILP)生成のメインスレッド窓口（ベータ）
   milp.worker.js を起動して解かせ、結果を AppState に反映する。
   Worker が使えない/失敗した場合は reject（呼び出し側で焼きなましにフォールバック）。
   =========================================== */
function _milpPayload() {
  return {
    settings:              AppState.settings,
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

function optimizeScheduleMILP(onProgress, opts) {
  const n = _parallelCount();
  // 微調整モードは「いまの表を最小限だけ直す」ので、ぶれが小さく並列の意味がない
  if (n <= 1 || (opts && opts.adjustMode)) return _milpOnce(onProgress, opts, 0);

  return new Promise((resolve, reject) => {
    const results = [], errors = [];
    let done = 0;
    const NAMES = ['ふつう', 'やや広い', '広い', 'かなり広い'];
    const say = () => {
      const best = results.length ? Math.min.apply(null, results.map(r => r.score)) : null;
      onProgress && onProgress(null,
        `${n}通りの解き方を同時に計算中…（完了 ${done}/${n}` +
        (best !== null ? ` ・ いまの最良 ${best}件` : '') + '）');
    };
    say();
    for (let i = 0; i < n; i++) {
      _milpOnce((pct, label) => { if (i === 0 && label && /経過/.test(label)) say(); }, opts, i)
        .then(r => { results.push(Object.assign({ _label: NAMES[i % 4] }, r)); })
        .catch(e => { errors.push(e); })
        .finally(() => {
          done++; say();
          if (done < n) return;
          if (!results.length) { reject(errors[0] || new Error('数理最適化に失敗しました')); return; }
          // 一番エラーが少ないものを採用。同点なら「証明できた」方を優先する。
          results.sort((a, b) => a.score - b.score ||
                                 (a.allOptimal === b.allOptimal ? 0 : (a.allOptimal ? -1 : 1)));
          const best = results[0];
          // 採用した解の表を、あらためて画面へ反映する
          AppState.shifts = best._shifts || AppState.shifts;
          AppState.violations = best.violations;
          AppState.generated = true;
          best.parallel = { n, tried: results.map(r => ({ label: r._label, score: r.score })) };
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
    try { worker = new Worker('js/milp.worker.js?v=170'); }
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
    const cleanup = () => { clearTimeout(timeout); clearInterval(ticker); };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { if (/計算中/.test(m.label || '')) solving = true; onProgress && onProgress(m.pct, m.label); return; }
      if (m.type === 'done') {
        cleanup(); worker.terminate();
        AppState.shifts = m.shifts || {}; AppState.violations = m.violations || []; AppState.generated = true;
        resolve({ _shifts: m.shifts || {}, violations: AppState.violations, score: (m.violations || []).length,
                  success: (m.violations || []).length === 0,
                  allOptimal: m.allOptimal !== false, deep: !!m.deep, fast: !!m.fast, usedGap: !!m.usedGap,
                  tiered: !!m.tiered, tierLog: m.tierLog || [] });
        return;
      }
      if (m.type === 'error') { cleanup(); worker.terminate(); reject(new Error(m.message || '数理最適化エラー')); return; }
    };
    worker.onerror = (err) => { cleanup(); try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化Workerエラー: ' + (err.message || 'ソルバーの読込みに失敗しました'))); };
    worker.postMessage({ type: 'milp', appState: _milpPayload(), deepMode, fastMode, adjustMode, adjustK, variant: parseInt(variant) || 0 });
  });
}
