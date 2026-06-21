/* ===========================================
   optimizer.worker.js - Web Worker エントリ
   メインスレッドをブロックせずに最適化を実行する
   =========================================== */

self.importScripts('data.js', 'optimizer.js');

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'optimize') return;

  try {
    const incoming = msg.appState || {};
    Object.assign(AppState.settings, incoming.settings || {});
    AppState.roleRequirements = incoming.roleRequirements || AppState.roleRequirements;
    AppState.dailyRequirements = incoming.dailyRequirements || {};
    AppState.roleColors = incoming.roleColors || AppState.roleColors;
    AppState.staff = incoming.staff || [];
    AppState.requests = incoming.requests || {};
    AppState.fixedShifts = incoming.fixedShifts || {};
    AppState.specialDays = incoming.specialDays || {};
    AppState.shifts = {};
    AppState.violations = [];
    AppState.generated = false;

    const onProgress = (pct, label) => {
      self.postMessage({ type: 'progress', pct, label });
    };

    const result = await optimizeSchedule(onProgress);

    self.postMessage({
      type: 'done',
      result,
      shifts: AppState.shifts,
      violations: AppState.violations,
      generated: AppState.generated,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: (err && err.message) || String(err),
      stack: (err && err.stack) || null,
    });
  }
});
