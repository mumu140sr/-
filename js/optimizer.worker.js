/* ===========================================
   optimizer.worker.js - Web Worker エントリ
   メインスレッドをブロックせずに最適化を実行する
   =========================================== */

// data.js と optimizer.js を Worker スコープに取り込む
// importScripts は Worker 専用 API
self.importScripts('data.js?v=58', 'optimizer.js?v=58');

/**
 * メインスレッドからのリクエスト受信
 *  payload: { type: 'optimize', appState: { settings, roleRequirements, staff, requests, fixedShifts, specialDays } }
 */
self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'optimize' && msg.type !== 'repair') return;

  try {
    // Worker 内の AppState を上書き
    const incoming = msg.appState || {};
    Object.assign(AppState.settings, incoming.settings || {});
    if (incoming.shiftTypes) AppState.shiftTypes = incoming.shiftTypes;
    AppState.roleRequirements     = incoming.roleRequirements     || AppState.roleRequirements;
    AppState.roleRequirementsCast = incoming.roleRequirementsCast || {};
    AppState.dailyRequirements     = incoming.dailyRequirements     || {};
    AppState.dailyRequirementsCast = incoming.dailyRequirementsCast || {};
    AppState.skills                = incoming.skills                || [];
    AppState.staff       = incoming.staff       || [];
    AppState.requests    = incoming.requests    || {};
    AppState.fixedShifts = incoming.fixedShifts || {};
    AppState.specialDays = incoming.specialDays || {};
    AppState.events      = incoming.events      || [];
    // repair は現在のシフトを種にするので保持、optimize は初期化
    AppState.shifts = (msg.type === 'repair') ? (incoming.shifts || {}) : {};
    AppState.violations = [];
    AppState.generated = false;

    // 進捗コールバックは postMessage で代用
    const onProgress = (pct, label) => {
      self.postMessage({ type: 'progress', pct, label });
    };

    const result = (msg.type === 'repair')
      ? await repairSchedule(onProgress)
      : await optimizeSchedule(onProgress);

    // 完了通知（AppState.shifts と violations を返す）
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
