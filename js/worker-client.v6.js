/* ===========================================
   worker-client.js
   メインスレッドから Web Worker 経由で最適化を呼び出すラッパー
   - Worker が使えない環境（file:// など）では自動でフォールバック
   - キャンセル機能つき
   =========================================== */

let _activeWorker = null;

/**
 * Worker 上で optimizer / repair を実行する共通処理
 * @param {'optimize'|'repair'} mode
 * @param {(pct:number, msg:string)=>void} progressCallback
 * @returns {Promise<object>}
 */
function _runViaWorker(mode, progressCallback) {
  return new Promise((resolve, reject) => {
    // 既存 Worker をクリーンアップ
    if (_activeWorker) {
      try { _activeWorker.terminate(); } catch (_) {}
      _activeWorker = null;
    }

    // メインスレッドのフォールバック関数
    const fallback = () => (mode === 'repair'
      ? repairSchedule(progressCallback)
      : optimizeSchedule(progressCallback)).then(resolve, reject);

    let worker;
    try {
      worker = new Worker('js/optimizer.worker.js?v=21');
    } catch (e) {
      console.warn('[worker-client] Worker creation failed, falling back to main thread:', e);
      return fallback();
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
      console.warn('[worker-client] Falling back to main thread');
      fallback();
    });

    // データを Worker に送る（postMessage は構造化クローン）
    worker.postMessage({
      type: mode,
      appState: {
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
        shifts:                AppState.shifts, // repair モードで使う現在のシフト
      },
    });
  });
}

/** Worker 上で最適化を実行 */
function optimizeScheduleViaWorker(progressCallback) {
  return _runViaWorker('optimize', progressCallback);
}

/** Worker 上でエラー箇所のみ修復 */
function repairScheduleViaWorker(progressCallback) {
  return _runViaWorker('repair', progressCallback);
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
