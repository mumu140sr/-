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
    staff:                 AppState.staff,
    requests:              AppState.requests,
    fixedShifts:           AppState.fixedShifts,
    specialDays:           AppState.specialDays,
    events:                AppState.events,
  };
}

function optimizeScheduleMILP(onProgress, opts) {
  const deepMode = !!(opts && opts.deepMode);
  const fastMode = !!(opts && opts.fastMode);
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('このブラウザは数理最適化(Worker)に非対応です')); return; }
    let worker;
    try { worker = new Worker('js/milp.worker.js?v=151'); }
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
        resolve({ violations: AppState.violations, score: (m.violations || []).length,
                  success: (m.violations || []).length === 0,
                  allOptimal: m.allOptimal !== false, deep: !!m.deep, fast: !!m.fast, usedGap: !!m.usedGap,
                  tiered: !!m.tiered, tierLog: m.tierLog || [] });
        return;
      }
      if (m.type === 'error') { cleanup(); worker.terminate(); reject(new Error(m.message || '数理最適化エラー')); return; }
    };
    worker.onerror = (err) => { cleanup(); try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化Workerエラー: ' + (err.message || 'ソルバーの読込みに失敗しました'))); };
    worker.postMessage({ type: 'milp', appState: _milpPayload(), deepMode, fastMode });
  });
}
