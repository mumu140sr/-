/* ===========================================
   worker-client.js
   メインスレッドから Web Worker 経由で最適化を呼び出すラッパー
   - Worker が使えない環境（file:// など）では自動でフォールバック
   - キャンセル機能つき
   =========================================== */

let _activeWorker = null;

/**
 * Worker 上で optimizer を実行する
 * @param {(pct:number, msg:string)=>void} progressCallback
 * @returns {Promise<{score, violations, success}>}
 */
function optimizeScheduleViaWorker(progressCallback) {
  return new Promise((resolve, reject) => {
    // 既存 Worker をクリーンアップ
    if (_activeWorker) {
      try { _activeWorker.terminate(); } catch (_) {}
      _activeWorker = null;
    }

    let worker;
    try {
      worker = new Worker('js/optimizer.worker.js');
    } catch (e) {
      console.warn('[worker-client] Worker creation failed, falling back to main thread:', e);
      // フォールバック: メインスレッドで実行
      return optimizeSchedule(progressCallback).then(resolve, reject);
    }

    _activeWorker = worker;

    worker.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'progress') {
        progressCallback && progressCallback(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        // 結果をメインの AppState に書き戻す
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
      // フォールバック: メインスレッドで実行
      console.warn('[worker-client] Falling back to main thread');
      optimizeSchedule(progressCallback).then(resolve, reject);
    });

    // データを Worker に送る（postMessage は構造化クローン）
    worker.postMessage({
      type: 'optimize',
      appState: {
        settings:             AppState.settings,
        shiftTypes:           AppState.shiftTypes,
        roleRequirements:     AppState.roleRequirements,
        roleRequirementsCast: AppState.roleRequirementsCast,
        staff:                AppState.staff,
        requests:             AppState.requests,
        fixedShifts:          AppState.fixedShifts,
        specialDays:          AppState.specialDays,
        events:               AppState.events,
      },
    });
  });
}

/** 実行中の Worker を中止 */
function cancelActiveOptimization() {
  if (_activeWorker) {
    try { _activeWorker.terminate(); } catch (_) {}
    _activeWorker = null;
    return true;
  }
  return false;
}

/** 実行中かどうか */
function isOptimizationRunning() {
  return !!_activeWorker;
}
