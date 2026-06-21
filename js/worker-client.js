/* ===========================================
   worker-client.js
   メインスレッドから Web Worker 経由で最適化を呼び出すラッパー
   =========================================== */

let _activeWorker = null;

function optimizeScheduleViaWorker(progressCallback) {
  return new Promise((resolve, reject) => {
    if (_activeWorker) {
      try { _activeWorker.terminate(); } catch (_) {}
      _activeWorker = null;
    }

    let worker;
    try {
      worker = new Worker('js/optimizer.worker.js');
    } catch (e) {
      console.warn('[worker-client] Worker creation failed, falling back to main thread:', e);
      return optimizeSchedule(progressCallback).then(resolve, reject);
    }

    _activeWorker = worker;

    worker.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'progress') {
        progressCallback && progressCallback(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        AppState.shifts = msg.shifts || {};
        AppState.violations = msg.violations || [];
        AppState.generated = !!msg.generated;
        worker.terminate();
        _activeWorker = null;
        resolve(msg.result);
      } else if (msg.type === 'error') {
        worker.terminate();
        _activeWorker = null;
        reject(new Error(msg.message || 'Worker error'));
      }
    });

    worker.addEventListener('error', (e) => {
      console.error('[worker-client] worker error', e);
      worker.terminate();
      _activeWorker = null;
      console.warn('[worker-client] Falling back to main thread');
      optimizeSchedule(progressCallback).then(resolve, reject);
    });

    worker.postMessage({
      type: 'optimize',
      appState: {
        settings: AppState.settings,
        roleRequirements: AppState.roleRequirements,
        dailyRequirements: AppState.dailyRequirements,
        roleColors: AppState.roleColors,
        staff: AppState.staff,
        requests: AppState.requests,
        fixedShifts: AppState.fixedShifts,
        specialDays: AppState.specialDays,
      },
    });
  });
}

function cancelActiveOptimization() {
  if (_activeWorker) {
    try { _activeWorker.terminate(); } catch (_) {}
    _activeWorker = null;
    return true;
  }
  return false;
}

function isOptimizationRunning() {
  return !!_activeWorker;
}
