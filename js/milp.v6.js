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
    staff:                 AppState.staff,
    requests:              AppState.requests,
    fixedShifts:           AppState.fixedShifts,
    specialDays:           AppState.specialDays,
    events:                AppState.events,
  };
}

function optimizeScheduleMILP(onProgress) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('このブラウザは数理最適化(Worker)に非対応です')); return; }
    let worker;
    try { worker = new Worker('js/milp.worker.js?v=93'); }
    catch (e) { reject(new Error('数理最適化Workerを起動できません: ' + e.message)); return; }
    const timeout = setTimeout(() => { try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化がタイムアウトしました（10分）')); }, 600000);
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { onProgress && onProgress(m.pct, m.label); return; }
      if (m.type === 'done') {
        clearTimeout(timeout); worker.terminate();
        AppState.shifts = m.shifts || {}; AppState.violations = m.violations || []; AppState.generated = true;
        resolve({ violations: AppState.violations, score: (m.violations || []).length, success: (m.violations || []).length === 0 });
        return;
      }
      if (m.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(m.message || '数理最適化エラー')); return; }
    };
    worker.onerror = (err) => { clearTimeout(timeout); try { worker.terminate(); } catch (_) {} reject(new Error('数理最適化Workerエラー: ' + (err.message || 'ソルバーの読込みに失敗しました'))); };
    worker.postMessage({ type: 'milp', appState: _milpPayload() });
  });
}
