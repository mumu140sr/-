/* ===========================================
   worker-client.js
   メインスレッドから Web Worker 経由で最適化を呼び出すラッパー
   - Worker が使えない環境（file:// など）では自動でフォールバック
   - 複数案の並列生成（マルチコア活用）対応
   - キャンセル機能つき
   =========================================== */

const WORKER_URL = 'js/optimizer.worker.js?v=63';

let _activeWorker  = null;
let _activeWorkers = [];

/** Worker に送る AppState スナップショットを作る */
function _buildWorkerPayload() {
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
    shifts:                AppState.shifts, // repair モードで使う現在のシフト
  };
}

/**
 * Worker 上で optimizer / repair を実行する共通処理
 * @param {'optimize'|'repair'} mode
 * @param {(pct:number, msg:string)=>void} progressCallback
 * @returns {Promise<object>}
 */
function _runViaWorker(mode, progressCallback) {
  return new Promise((resolve, reject) => {
    // 既存 Worker をクリーンアップ
    cancelActiveOptimization();

    // メインスレッドのフォールバック関数
    const fallback = () => (mode === 'repair'
      ? repairSchedule(progressCallback)
      : optimizeSchedule(progressCallback)).then(resolve, reject);

    let worker;
    try {
      worker = new Worker(WORKER_URL);
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

    worker.postMessage({ type: mode, appState: _buildWorkerPayload() });
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

/**
 * 複数案を並列の Worker で同時生成する（マルチコア活用）。
 * 順番に作るより大幅に速く、品質は同じ（同じ処理を同時に走らせるだけ）。
 * @param {number} numCand 案の数
 * @param {(pct:number,msg:string)=>void} progressCallback
 * @returns {Promise<Array<{result,shifts,violations}>>} 完了した案の一覧
 */
function optimizeCandidatesParallel(numCand, progressCallback) {
  return new Promise((resolve, reject) => {
    cancelActiveOptimization();

    const results  = new Array(numCand).fill(null);
    const progress = new Array(numCand).fill(0);
    let doneCount  = 0;
    const payload  = _buildWorkerPayload();

    const finish = () => {
      _activeWorkers = [];
      const ok = results.filter(Boolean);
      if (ok.length) resolve(ok);
      else reject(new Error('全ての案の生成に失敗しました'));
    };

    for (let i = 0; i < numCand; i++) {
      let w;
      try {
        w = new Worker(WORKER_URL);
      } catch (e) {
        // Worker 不可 → 呼び出し側で逐次フォールバック
        _activeWorkers.forEach(x => { try { x.terminate(); } catch (_) {} });
        _activeWorkers = [];
        reject(e);
        return;
      }
      _activeWorkers.push(w);

      ((idx, worker) => {
        worker.addEventListener('message', (e) => {
          const msg = e.data || {};
          if (msg.type === 'progress') {
            progress[idx] = msg.pct || 0;
            const avg = Math.floor(progress.reduce((a, b) => a + b, 0) / numCand);
            progressCallback && progressCallback(avg, `${numCand}案を同時生成中… ${msg.label || ''}`);
          } else if (msg.type === 'done') {
            results[idx] = { result: msg.result, shifts: msg.shifts, violations: msg.violations || [] };
            progress[idx] = 100;
            try { worker.terminate(); } catch (_) {}
            if (++doneCount === numCand) finish();
          } else if (msg.type === 'error') {
            console.warn('[worker-client] 案' + (idx + 1) + ' failed:', msg.message);
            try { worker.terminate(); } catch (_) {}
            if (++doneCount === numCand) finish();
          }
        });
        worker.addEventListener('error', (e) => {
          console.warn('[worker-client] 案' + (idx + 1) + ' worker error', e);
          try { worker.terminate(); } catch (_) {}
          if (++doneCount === numCand) finish();
        });
      })(i, w);

      w.postMessage({ type: 'optimize', appState: payload });
    }
  });
}

/** 実行中の Worker を全て中止 */
function cancelActiveOptimization() {
  let any = false;
  if (_activeWorker) {
    try { _activeWorker.terminate(); } catch (_) {}
    _activeWorker = null;
    any = true;
  }
  if (_activeWorkers.length) {
    _activeWorkers.forEach(w => { try { w.terminate(); } catch (_) {} });
    _activeWorkers = [];
    any = true;
  }
  return any;
}

/** 実行中かどうか */
function isOptimizationRunning() {
  return !!_activeWorker || _activeWorkers.length > 0;
}
