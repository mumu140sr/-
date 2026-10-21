/* ===========================================
   app.js - アプリのエントリーポイントとイベント結合
   =========================================== */

// テーマ（明暗）とモバイルナビの制御
function setupUIChrome() {
  const root = document.documentElement;
  const btnTheme = document.getElementById('btnTheme');
  const KEY = 'shiftapp-theme';
  const apply = (t) => {
    root.setAttribute('data-theme', t);
    if (btnTheme) btnTheme.textContent = (t === 'dark') ? 'ライト表示に切り替え' : 'ダーク表示に切り替え';
  };
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  if (!saved) {
    saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  apply(saved);
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const next = (root.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (_) {}
    });
  }

  // モバイル: サイドバーの開閉
  const nav = document.getElementById('sideNav');
  const scrim = document.getElementById('navScrim');
  const btnNav = document.getElementById('btnNavToggle');
  const closeNav = () => { if (nav) nav.classList.remove('open'); if (scrim) scrim.classList.remove('show'); };
  if (btnNav && nav) {
    btnNav.addEventListener('click', () => {
      nav.classList.toggle('open');
      if (scrim) scrim.classList.toggle('show', nav.classList.contains('open'));
    });
  }
  if (scrim) scrim.addEventListener('click', closeNav);
  if (nav) nav.addEventListener('click', (e) => { if (e.target.closest('.tab')) closeNav(); });
}

document.addEventListener('DOMContentLoaded', () => {
  // テーマは最初に適用（ちらつき防止）
  setupUIChrome();

  // データ読込
  const loaded = loadFromStorage();
  if (!loaded || AppState.staff.length === 0) {
    addSampleStaff();
  }

  // ①「ルールごとの強弱」の既定が、検査・生成の既定と食い違っていないか（食い違えば console.warn。v268）
  if (typeof checkRuleLevelMeta === 'function') checkRuleLevelMeta();

  // UI初期化
  setupTabs();
  setupSettingsPanel();
  setupReqRules();
  setupEventsPanel();
  setupRolePanel();
  setupStaffPanel();
  setupCalendarPanel();
  setupGeneratePanel();
  setupResultPanel();
  setupHeaderActions();

  // 初期描画（設定パネルの入力値復元含む）
  refreshAllUI();

  if (loaded) {
    if (_loadProblems.length) toast(loadProblemsText('前回のデータを読込みました'), 'warning', 15000);
    else toast('前回のデータを読込みました', 'success');
  } else if (typeof _loadUnreadable !== 'undefined' && _loadUnreadable) {
    // 保存データが壊れていて読めなかった（元のデータは別のキーに残してある。サンプルで上書きしたことにしない）
    // C10: 控えを書けなかったときは「残してあります」と言わず、元のデータを守るため保存を止めたことを言う
    toast(_loadBackupKept
      ? '前回のデータを読めませんでした。元のデータは消さずに残してあります（ブラウザの保存データ「' + UNREADABLE_KEY + '」）。'
        + '書き出したファイルがあれば「取り込み」から戻してください。いまはサンプルを表示しています。'
      : '前回のデータを読めませんでした。元のデータの控えを残せなかったので（ブラウザの保存の容量が足りません）、元のデータを守るため保存を止めています。'
        + '書き出したファイルがあれば「取り込み」から戻してください。いまはサンプルを表示しています。', 'error', 20000);
  } else {
    toast('シフト自動生成アプリへようこそ！', 'success');
  }
});

// 読めたが正しくない値があったときの知らせ（C10。以前の取り込みで保存された値。断らずに知らせるだけ）
function loadProblemsText(head) {
  const p = (typeof _loadProblems !== 'undefined' && _loadProblems) || [];
  return `${head}。ただし、保存データに正しくない値があります（${p.slice(0, 2).join('、')}${p.length > 2 ? ` ほか${p.length - 2}件` : ''}）。`
       + '画面には文字のまま出しています。その欄を入れ直すか、正しいファイルを取り込んでください';
}

/** 書き出すファイルの中身（exportAppData・exportAppDataSure で同じもの） */
function exportPayload() {
  return {
      _app: 'shift-app', _version: 1, _savedAt: new Date().toISOString(),
      settings: AppState.settings, shiftTypes: AppState.shiftTypes,
      roleRequirements: AppState.roleRequirements, roleRequirementsCast: AppState.roleRequirementsCast,
      dailyRequirements: AppState.dailyRequirements, dailyRequirementsCast: AppState.dailyRequirementsCast,
      skills: AppState.skills, dailySkills: AppState.dailySkills,
      dailyShiftSkills: AppState.dailyShiftSkills || {},   // 日ごとに要るスキル（v264）
      staff: AppState.staff, requests: AppState.requests, fixedShifts: AppState.fixedShifts,
      specialDays: AppState.specialDays, events: AppState.events, shifts: AppState.shifts,
      genBase: AppState.genBase || null, editLog: AppState.editLog || [],   // 生成直後の表と、変えたマスの記録
      // スタッフIDの通し番号（C10。入れていなかったので、取り込んだあと、消した人のIDを次の人に付けていた）
      _staffIdCounter,
  };
}

/** 設定一式をファイルに書き出す。うまくいけば true（月を変えるときの「先に書き出す」でも使う） */
function exportAppData() {
  try {
    const data = exportPayload();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `シフト設定_${AppState.settings.targetMonth || '未設定'}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('設定を書き出しました', 'success');
    return true;
  } catch (e) { toast('書き出しに失敗しました: ' + e.message, 'error', 7000); return false; }
}

/**
 * 片付ける前の書き出し。保存できたと分かったときだけ true。
 * ふつうのダウンロードでは、保存の画面で取り消されても分からない（成功と見なしていた）。
 * 保存先を選ぶ画面が使えるブラウザではそれを使い、取り消されたら false。
 * 使えないブラウザでは、ダウンロードのあとで「保存できましたか？」と聞く。
 */
async function exportAppDataSure() {
  const month = AppState.settings.targetMonth || '未設定';
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const data = exportPayload();
      const h = await window.showSaveFilePicker({ suggestedName: `シフト設定_${month}.json`,
        types: [{ description: 'シフト設定', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable();
      await w.write(JSON.stringify(data, null, 2));
      await w.close();
      toast('設定を書き出しました', 'success');
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') toast('書き出しを取り消しました', 'info', 5000);
      else toast('書き出しに失敗しました: ' + ((e && e.message) || e), 'error', 7000);
      return false;
    }
  }
  if (!exportAppData()) return false;
  return confirm(`${month} のファイルを保存できましたか？\n\n保存できていれば「OK」を押してください（片付けます）。\n保存の画面で取り消した・保存できなかった場合は「キャンセル」を押してください（片付けません）。`);
}

// ヘッダーアクション
function setupHeaderActions() {
  document.getElementById('btnSave').addEventListener('click', () => {
    // C10: 読めなかった元のデータを守るため保存を止めているときは、上書きして消えることを確かめてから書く
    if (typeof storageHeld === 'function' && storageHeld()) {
      if (!confirm('前に読めなかった元のデータを守るため、保存を止めています。\nいま保存すると、元のデータは上書きされて消えます。保存しますか？')) return;
      releaseStorageHold();
    }
    if (saveToStorage()) toast('設定を保存しました', 'success');
    else toast('保存できませんでした（ブラウザの保存の容量が足りない可能性があります）。「データ」→「書き出し」で控えを残してください', 'error', 9000);
  });

  document.getElementById('btnLoad').addEventListener('click', () => {
    // 計算中は読み込まない（終わった答えが、読み込んだデータの表に入ってしまう）
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    if (loadFromStorage()) {
      // 読み込む前の表へ「元に戻す」で戻れてしまうと、読み込んだデータが古い表で上書きされる
      if (typeof resetShiftHistory === 'function') resetShiftHistory();
      AppState._needsRegen = false;   // 読み込む前のデータの「作り直してください」を残さない（A6）
      if (typeof discardGenerateResult === 'function') discardGenerateResult();   // C1: 前のデータの文・箱・レポートを捨てる
      refreshAllUI();
      if (_loadProblems.length) toast(loadProblemsText('設定を読込みました'), 'warning', 15000);
      else toast('設定を読込みました', 'success');
    } else if (typeof _loadUnreadable !== 'undefined' && _loadUnreadable) {
      toast(_loadBackupKept
        ? '保存データを読めませんでした（いまのデータはそのままです。元のデータは「' + UNREADABLE_KEY + '」に残してあります）'
        : '保存データを読めませんでした（いまのデータはそのままです）。元のデータの控えを残せなかったので、元のデータを守るため保存を止めています', 'error', 12000);
    } else {
      toast('保存されたデータがありません', 'error');
    }
  });

  // 設定一式をファイルに書き出す（バックアップ・別PCへの移行・相談用）
  const btnExp = document.getElementById('btnExportData');
  if (btnExp) btnExp.addEventListener('click', () => { exportAppData(); });

  // 書き出したファイルを取り込む
  const btnImp = document.getElementById('btnImportData');
  const fileImp = document.getElementById('fileImportData');
  if (btnImp && fileImp) {
    btnImp.addEventListener('click', () => { if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; } fileImp.click(); });
    fileImp.addEventListener('change', () => {
      const f = fileImp.files && fileImp.files[0];
      if (!f) return;
      if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); fileImp.value = ''; return; }
      const rd = new FileReader();
      rd.onload = () => {
        // 確かめてから入れる（v248、A4）。以前は `_app` しか確かめず、項目を1つずつ AppState へ入れていたため、
        // 途中で失敗すると「失敗しました」と出るのにデータが半分入れ替わって保存されていた。ファイルに無い設定は
        // 既定値で補う（補わないと、早遅バランスの許容幅が画面では空、計算では2日になっていた）。
        let saved = null;
        try {
          const d = JSON.parse(rd.result);
          if (!d || typeof d !== 'object' || d._app !== 'shift-app') throw new Error('このアプリの書き出しファイルではありません');
          if (!Array.isArray(d.staff)) throw new Error('スタッフの一覧が入っていません');
          if (!d.staff.length) throw new Error('スタッフが1人も入っていません');   // C10
          if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) throw new Error('設定が入っていません');
          if (typeof validateImportIdsAndNumbers === 'function') validateImportIdsAndNumbers(d);   // A5・C10
          const n = normalizeAppData(d, defaultAppDataBase());
          if (!confirm('いまのデータを、読み込むファイルの内容で置き換えます。よろしいですか？')) return;
          // いまの状態を控える（失敗したら戻す）
          saved = { data: JSON.parse(JSON.stringify(APP_DATA_KEYS.reduce((o, k) => { o[k] = AppState[k]; return o; }, {}))),
                    counter: _staffIdCounter, needsRegen: AppState._needsRegen };
          applyAppData(n);
          // C10: 通し番号は、ファイルのもの（無い・正しくなければ人数+1）と取り込む前のもののうち大きいほう
          _staffIdCounter = Math.max(safeStaffIdCounter(saved.counter), n._staffIdCounter);
          AppState._needsRegen = false;   // 取り込んだ表に、前のデータの「作り直してください」を残さない（A6）
          // C1: 前のデータの文・箱・レポートを捨てる（保存の成否にかかわらず。中身は入れ替わっている）
          if (typeof discardGenerateResult === 'function') discardGenerateResult();
          try { AppState.violations = AppState.generated ? checkViolations(AppState.shifts) : []; }
          catch (e2) { AppState.violations = []; }
          refreshAllUI();
          if (typeof resetShiftHistory === 'function') resetShiftHistory();   // 取り込む前の表には戻さない
          if (typeof releaseStorageHold === 'function') releaseStorageHold();   // 取り込んだので、読めなかった元のデータを守る停止は解除（C10）
          const okSave = saveToStorage();
          saved = null;
          // C10: 保存が容量不足などで失敗しても、取り込んだ中身のまま使えるようにして知らせる
          if (okSave) toast('設定を取り込みました', 'success');
          else toast('設定を取り込みましたが、保存できませんでした（ブラウザの保存の容量が足りない可能性があります）。このまま使えますが、'
                   + 'ページを閉じると取り込んだ内容は消えます。「データ」→「書き出し」で控えを残してください', 'warning', 15000);
        } catch (e) {
          if (saved) {
            // 途中で失敗したら、取り込む前の状態に戻す（保存データは取り込みの最後でしか書かないので、そのまま）
            try {
              applyAppData(Object.assign(saved.data, { _staffIdCounter: saved.counter }));
              AppState._needsRegen = saved.needsRegen;
              refreshAllUI();
            } catch (_) {}
          }
          toast('取り込みに失敗しました（いまのデータはそのままです）: ' + e.message, 'error', 7000);
        }
        finally { fileImp.value = ''; }
      };
      rd.readAsText(f);
    });
  }

  document.getElementById('btnReset').addEventListener('click', () => {
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    if (confirm('全てのデータをリセットしますか？（保存データも削除されます）')) {
      resetAll();
      addSampleStaff();
      if (typeof resetShiftHistory === 'function') resetShiftHistory();   // リセット前の表には戻さない
      AppState._needsRegen = false;   // A6
      if (typeof discardGenerateResult === 'function') discardGenerateResult();   // C1
      refreshAllUI();
      toast('リセットしました', 'info');
    }
  });
}

// ===== 3-1② 希望の変え方を、計算で確かめて出す =====
// 試しに作った表に残る🚨のうち、希望から来ているもの（連勤超過・6連勤以上・遅→早）について、
// 希望を変える案を作り、1つずつ試しに作り直して、その🚨が消え、ほかの🚨が増えない案だけを出す。
// 変えるのはシフトの種類の希望と休みの希望だけ（半休・有給・🔒固定は動かさない）。
// 試し計算なので、本物の表・希望・保存データは書き換えない（requestsPatch）。
const WISH_MUST_TYPES = ['consecutive', 'late-early'];
function wishFixCandidates(vs, margins) {
  const req = (id, d) => (AppState.requests[id] || {})[d] || '';
  const fixed = (id, d) => !!(AppState.fixedShifts[id] || {})[d];
  const movableWork = (v) => v && isWork(v) && v !== '半' && v !== '有';
  const nameOf = (id) => ((AppState.staff || []).find(x => x.id === id) || {}).name || '';
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const mDay = {};
  (margins || []).forEach(g => g.days.forEach(r => { mDay[r.day] = Math.min(mDay[r.day] == null ? 99 : mDay[r.day], r.total.margin); }));
  const out = [];
  vs.forEach(v => {
    if (!v || WISH_MUST_TYPES.indexOf(v.type) < 0) return;
    if (!(getRuleLevel(v.type) === 'must' || MUST_TYPES_OPT.has(v.type))) return;
    const P = v.staffId;
    const range = v.type === 'consecutive' ? [Math.max(1, v.from), v.to] : [Math.max(1, v.day - 1), v.day];
    const cands = [];
    // ㋐ 本人の出勤の希望を休みにする（真ん中に近い日から）
    const mid = (range[0] + range[1]) / 2;
    const own = [];
    for (let d = range[0]; d <= range[1]; d++) if (movableWork(req(P, d)) && !fixed(P, d)) own.push(d);
    own.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).forEach(d =>
      cands.push({ changes: [{ id: P, day: d, from: req(P, d), to: '休' }],
                   text: `${nameOf(P)}さん ${d}日「${req(P, d)}」→「休」` }));
    // ㋑ 余裕0の日に休みの希望を出している人の休みを、前後の余裕のある日へ1日ずらす
    //    （その日に出られる人が1人増え、本人が休めるようになる）
    for (let d = range[0]; d <= range[1]; d++) {
      if (mDay[d] == null || mDay[d] > 0) continue;
      (AppState.staff || []).forEach(q => {
        if (q.id === P || req(q.id, d) !== '休' || fixed(q.id, d)) return;
        for (const dd of [d - 1, d + 1, d - 2, d + 2]) {
          if (dd < 1 || dd > days || req(q.id, dd) || fixed(q.id, dd) || (mDay[dd] != null && mDay[dd] < 1)) continue;
          if (dd >= range[0] && dd <= range[1]) continue;
          cands.push({ changes: [{ id: q.id, day: d, from: '休', to: '' }, { id: q.id, day: dd, from: '', to: '休' }],
                       text: `${nameOf(q.id)}さんの休みの希望を ${d}日 → ${dd}日 にずらす` });
          break;
        }
      });
    }
    if (cands.length) out.push({ v, staffId: P, range, label: `${nameOf(P)}さん ${range[0]}〜${range[1]}日の${
      v.type === 'late-early' ? '遅→早' : v.compliance ? v.len + '連勤（6連勤以上）' : v.len + '連勤'}`, cands: cands.slice(0, 3) });
  });
  return out;
}
// 試しに作った表で、その🚨（同じ人・同じ種類・日が重なる）がまだあるか
function _wishTargetStill(vs, t) {
  return vs.some(v => v.type === t.v.type && v.staffId === t.staffId &&
    (v.type === 'consecutive' ? (v.from <= t.range[1] && t.range[0] <= v.to) : (v.day >= t.range[0] && v.day <= t.range[1])));
}
function renderWishFixBox(modal) {
  const box = modal.querySelector('#wishFixBox');
  if (!box) return;
  box.innerHTML = `<div style="padding:12px 14px;border-radius:10px;margin:0 0 14px;border:1px solid var(--border)">
      <b style="font-size:14px">希望の変え方を、計算で確かめる</b>
      <div class="hint" style="margin:2px 0 8px">いまの希望で試しに作り、残る「絶対」の違反（連勤超過・6連勤以上・遅→早）ごとに、希望を変える案を
        1つずつ試しに作り直します。その違反が消え、ほかの「絶対」の違反が増えない案だけを出します。変えるのはシフトの種類の希望と休みの希望だけ
        （半休・有給・固定は動かしません）。表・希望は、「この案にする」を押すまで変わりません。1つの案に約1分かかります。</div>
      <button class="btn" id="wfGo">計算で確かめる</button> <button class="btn" id="wfStop" style="display:none;background:var(--surface);color:var(--lv-crit);border-color:var(--lv-crit)">${uiIcon('stop')}中止</button>
      <div id="wfNote" style="display:none;margin:8px 0 0;padding:6px 10px;border-radius:8px;background:var(--lv-soft-bg);color:var(--text);border:1px dashed var(--lv-soft);font-size:13px"></div>
      <div id="wfOut" style="margin-top:8px;font-size:13px;line-height:1.7"></div></div>`;
  const $out = box.querySelector('#wfOut'), $go = box.querySelector('#wfGo'), $stop = box.querySelector('#wfStop');
  // 画面の中の帯に出す知らせ（トーストは暗幕の後ろに出て見えなかった）
  const $note = box.querySelector('#wfNote');
  const wfNote = (msg) => { $note.textContent = msg; $note.style.display = msg ? 'block' : 'none'; };
  let stopped = false;
  const stopNow = () => { stopped = true; if (typeof cancelMILP === 'function') cancelMILP(); };
  $stop.addEventListener('click', stopNow);
  let running = false;
  modal._stopCalc = () => { if (running) stopNow(); };   // 画面を閉じたら計算も止める
  $go.addEventListener('click', async () => {
    if (typeof calcBusy === 'function' && calcBusy()) {
      const own = (typeof calcOwner === 'function' && calcOwner()) || '';
      wfNote(/確認待ち/.test(own) ? '余の解消パネルの質問に答えてからにしてください'
                                  : `いまは「${own || '計算'}」の計算中です。終わってからにしてください`);
      return;
    }
    if (!calcBegin('希望の変え方を確かめる')) return;
    wfNote('');
    stopped = false; running = true; $go.disabled = true; $stop.style.display = 'inline-block';
    const fp0 = (typeof contentFingerprint === 'function') ? contentFingerprint() : '';
    const lines = [];
    // 計算の途中は「この案にする」を押せなくし、帯で知らせる（途中で押しても何も起きなかった）
    const show = (extra) => {
      let html = lines.join('');
      if (running && /data-wf="/.test(html)) {
        html = html.replace(/data-wf="/g, 'disabled title="全部の計算が終わってから選べます" data-wf="');
        wfNote('全部の計算が終わってから選べます');
      }
      $out.innerHTML = html + (extra || '');
    };
    // 同じ変更（同じ希望の組み合わせ）の計算は使い回す（別の🚨の案として同じ変更が出ることがある）
    const cache = {};
    let done = 0, total = 1, secSum = 0;
    let totalKnown = false;
    const progress = () => {
      if (!totalKnown) return '（全部で何回かは、いまの希望で作ったあとに出ます）';
      const avg = done ? secSum / done : 65;
      return `（全部で${total}回・いま${Math.min(done + 1, total)}回目・あと約${Math.max(1, Math.round((total - done) * avg / 60))}分）`;
    };
    const trial = async (patch) => {
      const key = JSON.stringify((patch || []).slice().sort((a, b) => (a.id + a.day).localeCompare(b.id + b.day)));
      if (cache[key]) return Object.assign({}, cache[key], { cached: true });
      const t0 = Date.now();
      const r = await optimizeScheduleMILP(null, { fastMode: true, noApply: true, requestsPatch: patch || null });
      const sec = Math.round((Date.now() - t0) / 1000);
      done++; secSum += sec;
      return (cache[key] = { r, sc: scoreViolations(r.violations || []), sec });
    };
    try {
      show(`<span class="hint">いまの希望で試しに作っています…${progress()}</span>`);
      const base = await trial(null);
      const targets = wishFixCandidates(base.r.violations || [], (typeof analyzeDayMargins === 'function') ? analyzeDayMargins() : []);
      // 全部で何回計算するか（同じ変更は1回と数える）
      { const keys = new Set(); targets.forEach(t => t.cands.forEach(c => keys.add(JSON.stringify(c.changes.map(x => ({ id: x.id, day: x.day, to: x.to }))
          .sort((a, b) => (a.id + a.day).localeCompare(b.id + b.day)))))); total = 1 + keys.size; totalKnown = true; }
      lines.push(`<div>いまの希望で作ると: <b>${escapeHtml(scoreSummaryText(base.sc))}</b>（${base.sec}秒）</div>`);
      if (!targets.length) {
        const n = (base.r.violations || []).filter(v => WISH_MUST_TYPES.indexOf(v.type) >= 0 &&
          (getRuleLevel(v.type) === 'must' || MUST_TYPES_OPT.has(v.type))).length;
        lines.push(`<div class="hint">${n ? `連勤超過・遅→早が ${n}件ありますが、本人の出勤の希望や、余裕0人の日の休みの希望から来ていないため、
          希望を変える案はありません（作るたびに少し違う表になるので、生成すると消えることもあります）。`
          : '希望から来ている「絶対」の違反（連勤超過・6連勤以上・遅→早）は見つかりませんでした。'}</div>`);
        show(); return;
      }
      for (const t of targets) {
        if (stopped) break;
        lines.push(`<div style="margin-top:6px"><b>${uiIcon('must')} ${escapeHtml(t.label)}</b></div>`);
        let any = false, anyFail = false;
        for (const c of t.cands) {
          if (stopped) break;
          show(`<div class="hint" style="margin-left:1em">「${escapeHtml(c.text)}」を試しています…${progress()}</div>`);
          let res;
          try { res = await trial(c.changes.map(x => ({ id: x.id, day: x.day, to: x.to }))); }
          catch (e) {
            if (stopped || /^cancel/.test(e.message || '')) break;
            anyFail = true;
            lines.push(`<div class="hint" style="margin-left:1em">${uiIcon('close')} ${escapeHtml(c.text)} → 計算に失敗しました（${escapeHtml(e.message || '')}）</div>`);
            continue;
          }
          const gone = !_wishTargetStill(res.r.violations || [], t);
          // その🚨が消え、決まり（scoreBetter: どれも増えず、どれかが減る）でも改善のときだけ ✅。
          // 🚨が別の人・日に移っただけの案（件数は同じ）には付けない。
          const better = gone && scoreBetter(res.sc, base.sc) && !compWorsened(base.r.violations || [], res.r.violations || []).length;
          // 🚨を消したくて見ているので、🚨の合計（⛔を含む）が減らない案には ✅ を付けない（5連勤が別の所に移り、🟡だけが減る案など）。
          // ⛔が減る案（6連勤が5連勤に移る など）は、🚨の合計が同じでも ✅
          const ok = better && (res.sc.must < base.sc.must || res.sc.comp < base.sc.comp);
          const idx = lines.length;
          if (better && !ok) {
            lines.push(`<div class="hint" style="margin-left:1em">${uiIcon('info')} ${escapeHtml(c.text)} → ${escapeHtml(scoreSummaryText(res.sc))}（「絶対」の違反は減りません（別の日・人に移ります）・${res.cached ? '前の計算を使いました' : res.sec + '秒'}）</div>`);
            continue;
          }
          lines.push(ok
            ? `<div style="margin-left:1em">${uiIcon('ok')} ${escapeHtml(c.text)} → <b>${escapeHtml(scoreSummaryText(res.sc))}</b>（${res.cached ? '前の計算を使いました' : res.sec + '秒'}）
                 <button class="btn" data-wf="${idx}" style="padding:1px 10px">この案にする</button></div>`
            : `<div class="hint" style="margin-left:1em">${uiIcon('close')} ${escapeHtml(c.text)} → ${escapeHtml(scoreSummaryText(res.sc))}（${gone ? 'ほかが増える、またはほかの「絶対」の違反に移っただけのため出しません' : 'この違反が消えないため出しません'}・${res.cached ? '前の計算を使いました' : res.sec + '秒'}）</div>`);
          if (ok) { any = true; wfApply[idx] = c; }
        }
        if (!any && !stopped) lines.push(`<div class="hint" style="margin-left:1em">${anyFail
          ? '計算に失敗した案があります。もう一度試してください。' : '変えてよい希望だけでは、この違反を消せませんでした。'}</div>`);
      }
      if (stopped) lines.push(`<div class="hint">${lines.some(l => l.includes('data-wf=')) ? '中止しました。出ている案から選べます。' : '中止しました。'}</div>`);
      show();
    } catch (e) {
      lines.push(`<div class="hint">${/^cancel/.test(e.message || '') ? '中止しました。' : '計算に失敗しました: ' + escapeHtml(e.message || '')}</div>`); show();
    } finally {
      running = false; calcEnd(); $go.disabled = false; $stop.style.display = 'none';
      // 終わったら「この案にする」を押せるように描き直し、途中の知らせを消す
      if ($note.textContent === '全部の計算が終わってから選べます') wfNote('');
      if (lines.length) show();
      // 画面の中に知らせを出し、すぐ横に「計算で確かめる」を置く（トーストは暗幕の後ろに出て見えなかった）
      const stale = (msg) => {
        $out.querySelectorAll('[data-wf]').forEach(x => { if (x.textContent !== '変えました') x.disabled = true; });
        let $n = $out.querySelector('#wfStale');
        if (!$n) { $n = document.createElement('div'); $n.id = 'wfStale';
          $n.style.cssText = 'margin:8px 0;padding:6px 10px;border-radius:8px;background:var(--lv-soft-bg);color:var(--text);border:1px dashed var(--lv-soft)';
          $out.appendChild($n); }
        $n.innerHTML = `${escapeHtml(msg)} <button class="btn" style="padding:1px 10px">計算で確かめる</button>`;
        $n.querySelector('button').addEventListener('click', () => $go.click());
      };
      $out.querySelectorAll('[data-wf]').forEach(b => b.addEventListener('click', () => {
        const c = wfApply[+b.dataset.wf]; if (!c || b.disabled) return;
        if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
        if (fp0 && typeof contentFingerprint === 'function' && contentFingerprint() !== fp0) {
          stale('希望や表が変わったので、この案は使えません。ほかの案を使うには、もう一度「計算で確かめる」を押してください。'); return;
        }
        // 希望の変更も「元に戻す」で戻せるように、変えた所だけを履歴に積む
        const hb = (typeof captureChangeBase === 'function') ? captureChangeBase() : null;
        c.changes.forEach(x => { AppState.requests[x.id] = AppState.requests[x.id] || {};
          if (x.to) AppState.requests[x.id][x.day] = x.to; else delete AppState.requests[x.id][x.day]; });
        if (hb && typeof recordDeltaHistory === 'function') recordDeltaHistory(changesSince(hb));
        autoSave(); if (typeof renderCalendar === 'function') renderCalendar();
        b.disabled = true; b.textContent = '変えました';
        // 1つ反映したら希望が変わるので、ほかの案は押せなくする
        stale(`希望を変えました（${c.text}）。希望が変わったので、ほかの案を使うには、もう一度「計算で確かめる」を押してください。`);
      }));
    }
  });
  const wfApply = {};
}

// 日ごとの人数の余裕（出られる人数 − 必要人数）。余裕0の日は、出られる人が全員出勤になる。
// 余裕が少ない日を先に文で出し、全部の日は表（開いて見る）で出す。
function renderDayMarginsHtml() {
  const groups = (typeof analyzeDayMargins === 'function') ? analyzeDayMargins() : [];
  if (!groups.length) return '';
  const nm = (id) => ((AppState.staff || []).find(x => x.id === id) || {}).name || '';
  const bandL = { early: '早番', late: '遅番' };
  const multi = groups.length > 1;
  const cell = (c) => {
    const bg = c.margin < 0 ? 'color-mix(in srgb, var(--danger) 22%, var(--surface))'
             : c.margin === 0 ? 'var(--lv-soft-bg)' : '';
    return `<td style="text-align:center;padding:2px 10px;border:1px solid var(--border);${bg ? 'background:' + bg : ''}" title="出られる ${c.avail}人 ／ 必要 ${escapeHtml(c.need)}人">${c.margin > 0 ? '+' : ''}${escapeHtml(c.margin)}</td>`;
  };
  const html = groups.map(g => {
    const skNames = [];
    g.days.forEach(r => r.skills.forEach(k => { const key = k.name + '|' + k.band; if (!skNames.includes(key)) skNames.push(key); }));
    const lines = [];
    g.days.forEach(r => {
      const parts = [['全体', r.total], ['早番帯', r.early], ['遅番帯', r.late]]
        .concat(r.skills.map(k => [`${bandL[k.band]}で「${k.name}」ができる人`, k]));
      parts.forEach(([lab, c]) => {
        if (c.margin > 0 || !(c.need > 0)) return;
        const who = c.ids.map(nm).filter(Boolean).join('・');
        const extra = c.min != null && c.avail < c.min ? `（最低 ${c.min}人 に届かないため、必ずエラー）` : '';
        lines.push(c.margin < 0
          ? `不足：${r.day}日 ${lab}: 出られる ${c.avail}人 ／ 必要 ${c.need}人（${-c.margin}人 足りません）${extra}`
          : `余裕0：${r.day}日 ${lab}: 出られる ${c.avail}人 ／ 必要 ${c.need}人（余裕0人）→ ${who} は必ず出勤になります`);
      });
    });
    const th = (t) => `<th style="padding:2px 8px;border:1px solid var(--border);position:sticky;top:0;background:var(--surface)">${t}</th>`;
    const head = `<tr>${th('日')}${th('全体')}${th('早番帯')}${th('遅番帯')}${skNames.map(k => { const [n, b] = k.split('|'); return th(`${escapeHtml(n)}（${bandL[b]}）`); }).join('')}</tr>`;
    const body = g.days.map(r => `<tr><td style="padding:2px 8px;border:1px solid var(--border)">${r.day}日</td>${cell(r.total)}${cell(r.early)}${cell(r.late)}${skNames.map(k => {
      const c = r.skills.find(x => x.name + '|' + x.band === k); return c ? cell(c) : '<td></td>'; }).join('')}</tr>`).join('');
    return `${multi ? `<div style="font-weight:600;margin-top:6px">【${escapeHtml(g.label)}】</div>` : ''}
      <div style="font-size:13px;line-height:1.8">${lines.length ? lines.map(escapeHtml).join('<br>') : '余裕が0人以下の日はありません。'}</div>
      <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">すべての日の余裕を表で見る</summary>
        <div style="overflow-x:auto;max-height:40vh;overflow-y:auto;margin-top:6px"><table class="day-margin-table" style="border-collapse:collapse;font-size:12px;width:auto"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      </details>`;
  }).join('');
  return `<div style="padding:12px 14px;border-radius:10px;margin:0 0 14px;border:1px solid var(--border);background:var(--surface-2, var(--surface))">
      <b style="font-size:14px">日ごとの人数の余裕（出られる人数 − 必要人数）</b>
      <div class="hint" style="margin:2px 0 6px">休み・有給・半休の希望、休みの固定の日は「出られない」に数えています。余裕0人の日は、出られる人が全員出勤になり、その前後の連勤などが決まってしまいます。早番帯・遅番帯は、その時間帯に入れる人の数です（両方できる人は両方に数えます）。スキルは、その時間帯に入れる保有者の人数 − 目標人数です。希望・固定でその時間帯に入っている保有者は、研修や人数に数えないシフトでも数えます（シフト表のエラーと同じ数え方）。${multi && groups[0].skillsAll ? `スキルは${escapeHtml(groups.map(g => g.label).join('と'))}を合わせて数え、【${escapeHtml(groups[0].label)}】のところに出します。` : ''}</div>
      ${html}
    </div>`;
}

// 実現性チェック（生成前）: 各エラーが「避けられる/避けられない」かを判定して表示
// ===== ④ 設定を変えたときの見込み =====
// 「この人の担当に〇〇を足すと、切り替えの超過が◯回減る」を、試し計算で見せる。
// いまの設定で試しに作ったもの（基準）と、担当を足して試しに作ったものを比べる。
// どれも試し計算（noApply・staffPatch）で、本物の表・スタッフ・保存データは「この設定にする」を押すまで変えない。
// 生成は1回ごとにぶれるので、同じ条件で数回作り、最小〜最大の範囲で出す。
function forecastBandOver(vs) {   // 切り替えの超過回数（「なるべく」でも数える）
  return (vs || []).reduce((n, v) => n + (v && v.type === 'band-switch' ? (v.over || 0) : 0), 0);
}
// 1回ぶんの、種類ごとの数（🚨の種類・⛔・連勤の超過日数・公休の足りない日数・切り替えの超過回数）
// raw=true は⛔込みの数（増えたかの判定に使う）。false は文に出す数（⛔の連勤は⛔の欄で数えるので除く）
function forecastKeys(r, raw) {
  const m = Object.assign({}, r.sc.byMust || {});
  if (raw) { m.comp = r.sc.comp; m.over = r.sc.over; m.offShort = r.sc.offShort || 0; m.bsOver = r.sc.bsOver || 0; return m; }
  if (m.consecutive != null) m.consecutive -= r.sc.comp;
  // 連勤の超過日数も、⛔の連勤の分は除く（⛔は⛔の欄だけで出す）
  const compOver = (r.violations || []).reduce((n, v) => n + (v && v.type === 'consecutive' && v.compliance ? (v.over || 0) : 0), 0);
  m.comp = r.sc.comp; m.over = r.sc.over - compOver; m.offShort = r.sc.offShort || 0; m.bsOver = r.sc.bsOver || 0;
  return m;
}
function forecastRanges(runs, raw) {
  const per = runs.map(r => forecastKeys(r, raw)), keys = new Set();
  per.forEach(m => Object.keys(m).forEach(k => keys.add(k)));
  const o = {};
  keys.forEach(k => { const xs = per.map(m => m[k] || 0); o[k] = { min: Math.min(...xs), max: Math.max(...xs) }; });
  return o;
}
function forecastStats(runs) {
  const pick = (f) => { const xs = runs.map(f); return { min: Math.min(...xs), max: Math.max(...xs) }; };
  const byCmp = runs.slice().sort((a, b) => scoreCompare(a.sc, b.sc));
  return {
    // 🚨は⛔（6連勤以上）を除いた数。⛔は別の欄に出す（scoreViolations の must は⛔も数えている）
    must: pick(r => r.sc.must - r.sc.comp), comp: pick(r => r.sc.comp), soft: pick(r => r.sc.soft),
    bs: pick(r => forecastBandOver(r.violations)),
    best: byCmp[0], worst: byCmp[byCmp.length - 1],
    // 種類ごとの、全部の回の最小〜最大（まん中の回だけで増えた種類も見落とさない）。
    // 連勤超過は⛔（6連勤以上）の分を除いて数える（⛔は別の欄。同じ⛔が2つの文で出ていた）
    byK: forecastRanges(runs, false),    // 文に出す数（⛔を除く）
    byKi: forecastRanges(runs, true),    // 増えたかの判定に使う数（⛔込み）
    // 全部の回の違反（⛔が新しくできた・伸びたかを、基準の全部の回と比べるため）
    allVs: [].concat(...runs.map(r => r.violations || [])),
  };
}
// そのシフトを、その人に足してよいか（同じ部門・「早番のみ／遅番のみ」と逆の時間帯でない）
function forecastCanAdd(s, k, dept) {
  if ((s.allowedShifts || []).includes(k)) return false;
  if (dept && getStaffDepartment(s) !== dept) return false;
  const only = (typeof getBalanceRatio === 'function') ? (getBalanceRatio(s) || {}).only : null;
  if (only === 'e' && isLate(k)) return false;
  if (only === 'l' && isEarlyCategory(k)) return false;
  // 早可・遅可（空なら両方可。生成と同じ見方）
  if (s.prefs && s.prefs.length) {
    if (isLate(k) && !s.prefs.includes('遅可')) return false;
    if (isEarlyCategory(k) && !s.prefs.includes('早可')) return false;
  }
  return true;
}
// 候補: いまの表（無ければ基準の試し計算）で切り替えを超えた人が、切り替えた日に入ったシフトを、
// まだ担当できない上位の人（副店長・チーフ・リーダー）に足す。1人ずつの案と、まとめて足す案。
function forecastCandidates(shifts, vs) {
  const staff = AppState.staff || [];
  const pri = s => (POSITION_TYPES[s.positionType] || {}).priority || 9;
  const typeOf = k => (AppState.shiftTypes || []).find(t => t.key === k);
  const keysUsed = {};   // シフト → 切り替えの日に入った回数（研修・半休は数えない）
  (vs || []).filter(v => v.type === 'band-switch').forEach(v => {
    const row = (shifts || {})[v.staffId] || {};
    const m = /切り替えた日: ([\d・]+)日/.exec(v.message || '');
    const days = m ? m[1].split('・').map(Number) : [];
    days.forEach(d => {
      const k = row[d], t = typeOf(k);
      if (k && t && !t.isTraining && isWork(k) && !isHalfWork(k)) keysUsed[k] = (keysUsed[k] || 0) + 1;
    });
  });
  // 切り替えの日に2回以上入ったシフトだけ、多い順に3つまで（候補が多すぎると1つ約1分で終わらない）
  const keys = Object.keys(keysUsed).filter(k => keysUsed[k] >= 2).sort((a, b) => keysUsed[b] - keysUsed[a]).slice(0, 3);
  const out = [], all = [];
  keys.forEach(k => {
    const h = staff.find(s => (s.allowedShifts || []).includes(k));
    const dept = h ? getStaffDepartment(h) : null;
    const who = staff.filter(s => pri(s) <= 3 && forecastCanAdd(s, k, dept)).sort((a, b) => pri(a) - pri(b));
    if (!who.length) return;
    // 足せる人が1人だけでも、既定でチェックを付ける（まとめて足す案と同じ扱い）
    if (who.length > 1) out.push({ label: `${who.map(s => s.name + 'さん').join('・')}の担当に「${shiftSym(k)}」を足す（まとめて）`,
                                    patch: who.map(s => ({ id: s.id, add: [k] })), top: true });
    who.slice(0, 2).forEach(s => out.push({ label: `${s.name}さんの担当に「${shiftSym(k)}」を足す`, patch: [{ id: s.id, add: [k] }],
                                            top: who.length === 1 }));
    who.forEach(s => all.push({ id: s.id, add: [k] }));
  });
  const usedKeys = keys.filter(k => all.some(c => c.add[0] === k));
  if (usedKeys.length > 1) out.push({ label: `上位の人（副店長・チーフ・リーダー）の担当に「${usedKeys.join('」「')}」をまとめて足す`, patch: all });
  return out;
}
// 案の中身の鍵: 人ごとに足すシフトをまとめて並べたもの（同じ中身の案を重ねて加えない）
function forecastPatchKey(patch) {
  const m = {};
  (patch || []).forEach(c => { m[c.id] = m[c.id] || new Set(); (c.add || []).forEach(k => m[c.id].add(k)); });
  return JSON.stringify(Object.keys(m).sort().map(id => [id, [...m[id]].sort()]));
}
// 担当を変えたあと、いまの表のエラーの一覧を数え直す（担当外シフトなどの判定が変わるため）。変わった件数を返す
// beforeSc: 担当を変える直前に、いまの表を数えたもの（担当以外の変更の差を混ぜないため）
function recheckAfterStaffChange(beforeSc) {
  if (!AppState.generated || !AppState.shifts) return null;
  const b = beforeSc || scoreViolations(AppState.violations || []);
  AppState.violations = checkViolations(AppState.shifts);
  const a = scoreViolations(AppState.violations);
  if (typeof renderReport === 'function') renderReport({ success: AppState.violations.length === 0, score: AppState.violations.length, violations: AppState.violations });
  if (typeof renderResultTable === 'function') renderResultTable();
  return { b, a };
}
// 見込みが古くなったかの指紋（表・希望などに加え、担当・スキル・設定・必要人数も見る）
function forecastFp() {
  return contentFingerprint() + JSON.stringify([AppState.settings, AppState.staff, AppState.skills, AppState.dailySkills, AppState.dailyShiftSkills,
    AppState.roleRequirements, AppState.roleRequirementsCast, AppState.shiftTypes, AppState.specialDays, AppState.events]);
}
function showForecastModal() {
  if (!AppState.staff.length) { toast('スタッフを登録してください', 'error'); return; }
  const old = document.getElementById('forecastModal');
  if (old) { if (old._stopCalc) old._stopCalc(); old.remove(); }
  const modal = document.createElement('div');
  modal.id = 'forecastModal';
  modal.className = 'modal-overlay show';
  modal.style.zIndex = 10050;
  const hasTable = !!(AppState.generated && AppState.shifts);
  const staffChecks = AppState.staff.map(s => `<label style="margin-right:10px;white-space:nowrap"><input type="checkbox" data-fcwho="${escapeHtml(s.id)}"> ${escapeHtml(s.name)}</label>`).join('');
  const keyChecks = (AppState.shiftTypes || []).filter(t => !t.isTraining && isWork(t.key))
    .map(t => `<label style="margin-right:10px;white-space:nowrap"><input type="checkbox" data-fckey="${escapeHtml(t.key)}"> ${escapeHtml(shiftSymOf(t))}</label>`).join('');
  modal.innerHTML = `<div class="modal-content" style="max-width:980px;width:calc(100vw - 32px)">
      <div class="modal-header"><h3 style="margin:0">設定を変えたときの見込み</h3><button class="modal-close" id="fcClose">✕</button></div>
      <div class="modal-body">
        <div class="hint" style="margin-bottom:8px">担当シフトを足したら、表がどう変わりそうかを試しに作って比べます。
          いまの設定で試しに作ったもの（基準）と比べます。表・スタッフは「この設定にする」を押すまで変わりません。
          生成は1回ごとにぶれるので、同じ条件で数回作り、最小〜最大の範囲で出します。1回に約1分かかります。</div>
        <div id="fcCands" style="font-size:13px;line-height:1.9"></div>
        <details style="margin:6px 0;font-size:13px"><summary>自分で足す（何人か・何種類かをまとめて1つの案にできます）</summary>
          <div style="margin:4px 0">人: ${staffChecks}</div>
          <div style="margin:4px 0">足すシフト: ${keyChecks}</div>
          <button class="btn" id="fcAdd" style="padding:1px 10px">この組み合わせを候補に加える</button></details>
        <div style="margin:8px 0;font-size:13px">1つの条件で作る回数: <select id="fcRuns"><option>1</option><option selected>2</option><option>3</option></select>
          <button class="btn btn-primary" id="fcGo">見込みを計算する</button>
          <button class="btn" id="fcStop" style="display:none;background:var(--surface);color:var(--lv-crit);border-color:var(--lv-crit)">${uiIcon('stop')}中止</button>
          <span id="fcEst" class="hint"></span></div>
        <div id="fcNote" style="display:none;margin:6px 0;padding:6px 10px;border-radius:8px;background:var(--lv-soft-bg);color:var(--text);border:1px dashed var(--lv-soft);font-size:13px"></div>
        <div id="fcStatus" class="hint"></div>
        <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>
          <th style="text-align:left;padding:4px">変える内容</th><th style="padding:4px">${uiIcon('crit')} 6連勤以上</th><th style="padding:4px">${uiIcon('must')} 絶対（6連勤以上を除く）</th>
          <th style="padding:4px">切り替えの超過</th><th style="padding:4px">${uiIcon('soft')} できれば</th><th style="padding:4px"></th></tr></thead>
          <tbody id="fcRows"></tbody></table></div>
      </div></div>`;
  document.body.appendChild(modal);
  const $ = (id) => modal.querySelector('#' + id);
  const cands = [];
  // 画面の中に出す知らせ（toast は暗幕の下に出て読みにくかった）
  let noteTimer = null;
  const note = (msg) => {
    const $n = $('fcNote'); $n.textContent = msg; $n.style.display = 'block';
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { $n.style.display = 'none'; }, 6000);
  };
  let running = false, stopped = false, fp0 = null, base = null, statusHtml = '';
  let autoMade = hasTable;   // 候補を表から作ったか（表が無いときは基準のあとで作る）
  const results = [];
  const setStatus = (h) => { statusHtml = h; $('fcStatus').innerHTML = h; };
  // 押す前に、全部で何回・約何分かを出す
  const estimate = () => {
    if (running) return;
    const R = +$('fcRuns').value || 2, n = cands.filter(c => c.on).length;
    $('fcEst').textContent = !autoMade
      ? `（全部で${R * (1 + n)}回・約${R * (1 + n)}分より多くなります。表がまだ無いので、基準を作ったあとに候補を決め、候補1つにつき${R}回・約${R}分ずつ増えます）`
      : n ? `（全部で${R * (1 + n)}回・約${R * (1 + n)}分）` : `（試す候補がありません。基準だけ${R}回・約${R}分）`;
  };
  const renderCands = () => {
    $('fcCands').innerHTML = cands.length
      ? '<b>試す候補</b>（チェックしたものを計算します）<br>' + cands.map((c, i) =>
          `<label style="display:block"><input type="checkbox" data-fci="${i}" ${c.on ? 'checked' : ''}> ${escapeHtml(c.label)}</label>`).join('')
      : hasTable
        ? '<span class="hint">いまの表の切り替えの超過から出せる候補はありません（下の「自分で足す」で候補を加えられます）。</span>'
        : '<span class="hint">表がまだ無いので、候補は、いまの設定で試しに作った表の切り替えの超過から出します（「自分で足す」で先に加えることもできます）。</span>';
    modal.querySelectorAll('[data-fci]').forEach(b => b.addEventListener('change', () => { cands[+b.dataset.fci].on = b.checked; estimate(); }));
    estimate();
  };
  // 自動の候補を加える（同じ中身の案がもうあれば加えず、既定のチェックだけ付ける）。加えた案を返す
  const addAuto = (list) => {
    const added = [];
    list.forEach(c => {
      const same = cands.find(o => forecastPatchKey(o.patch) === forecastPatchKey(c.patch));
      if (same) { if (c.top) same.on = true; return; }
      c.on = !!c.top; cands.push(c); added.push(c);
    });
    return added;
  };
  if (hasTable) addAuto(forecastCandidates(AppState.shifts, checkViolations(AppState.shifts)));
  renderCands();
  $('fcRuns').addEventListener('change', estimate);
  $('fcAdd').addEventListener('click', () => {
    const ids = [...modal.querySelectorAll('[data-fcwho]:checked')].map(b => b.dataset.fcwho);
    const keys = [...modal.querySelectorAll('[data-fckey]:checked')].map(b => b.dataset.fckey);
    if (!ids.length || !keys.length) { note('人と足すシフトを、それぞれ1つ以上選んでください'); return; }
    const patch = [], parts = [];
    ids.forEach(id => {
      const s = AppState.staff.find(x => x.id === id); if (!s) return;
      const add = keys.filter(k => !(s.allowedShifts || []).includes(k));
      if (add.length) { patch.push({ id, add }); parts.push(`${s.name}さんに「${add.join('」「')}」`); }
    });
    if (!patch.length) { note('選んだ人は、選んだシフトをもう担当できます'); return; }
    // 同じ組み合わせ（人ごとに足すシフトが同じ）の案がもうあれば、重ねて加えない
    const same = cands.find(c => forecastPatchKey(c.patch) === forecastPatchKey(patch));
    if (same) { same.on = true; renderCands(); note('同じ組み合わせの案がもうあります（チェックを付けました）'); return; }
    cands.push({ label: `担当を足す: ${parts.join('・')}`, patch, on: true }); renderCands();
    modal.querySelectorAll('[data-fcwho],[data-fckey]').forEach(b => { b.checked = false; });
  });

  const stopNow = () => { stopped = true; if (typeof cancelMILP === 'function') cancelMILP(); };
  modal._stopCalc = () => { if (running) stopNow(); };   // 画面を閉じたら計算も止める
  $('fcStop').addEventListener('click', stopNow);
  const close = () => { modal._stopCalc(); clearInterval(watch); modal.remove(); };
  $('fcClose').addEventListener('click', close);
  const rng = (x, unit) => x.min === x.max ? `${x.min}${unit}` : `${x.min}〜${x.max}${unit}`;
  const cmp = (b, a, unit) => `${rng(b, unit)}→<b>${rng(a, unit)}</b>`;
  const labOf = (k) => k === 'comp' ? '6連勤以上' : k === 'over' ? '連勤の超過日数' : k === 'offShort' ? '公休の不足日数'
    : k === 'bsOver' ? '切り替えの超過回数' : ((typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[k]) || k);
  const redraw = () => {
    const stale = !!(fp0 && forecastFp() !== fp0);
    $('fcRows').innerHTML = results.map((x, i) => {
      if (!base) return '';
      // ① いちばん良い回どうしで、🚨のどの種類・⛔・連勤の超過日数・公休の足りない日数・切り替えの超過回数（「絶対」のとき）が
      //   増える、または⛔が新しくできた・伸びたなら「増えます」（選べない）。
      // ② そうでなくても、種類ごとの全部の回の最大が増える、または案のどれかの回に、基準のどの回にも無い⛔
      //   （新しくできた・伸びた・つながった）があれば「回によっては増えます」。
      // 文の数は欄と同じく、全部の回の最小〜最大で出す（連勤超過は⛔の分を除く）
      const counted = (k) => k !== 'soft' && (k !== 'bsOver' || getRuleLevel('band-switch') === 'must');
      const up = scoreWorsened(x.st.best.sc, base.best.sc).map(w => w.key).filter(counted);
      const upComp = compWorsened(base.best.violations || [], x.st.best.violations || []).length > 0;
      const bad = up.length > 0 || upComp;
      // 「増えたか」は⛔込みの数（byKi）で決める。⛔を除いた数（byK）は文に出すときだけ使う
      const bk = base.byK, ck = x.st.byK, bki = base.byKi, cki = x.st.byKi;
      const upMax = bad ? [] : Object.keys(Object.assign({}, cki, bki)).filter(k => counted(k) && ((cki[k] || {}).max || 0) > ((bki[k] || {}).max || 0));
      const compAny = !bad && compWorsened(base.allVs, x.st.allVs).length > 0;
      if (compAny && upMax.indexOf('comp') < 0) upMax.push('comp');
      const upWorst = upMax.length > 0;
      const z = { min: 0, max: 0 };
      const unitOf = (k) => (k === 'over' || k === 'offShort') ? '日' : k === 'bsOver' ? '回' : '件';
      const words = (keys) => keys.map(k => `${k === 'comp' ? '6連勤以上' : labOf(k)} ${rng(bk[k] || z, '')}→${rng(ck[k] || z, unitOf(k))}`).join('・');
      const upKeys = bad ? up.filter(k => k !== 'comp').concat((upComp || up.indexOf('comp') >= 0) ? ['comp'] : []) : [];
      const compMark = (bad && upKeys.indexOf('comp') >= 0) ? '<div style="color:var(--lv-must)">増えます</div>'
        : upMax.indexOf('comp') >= 0 ? '<div style="color:var(--lv-soft)">回によっては増えます</div>' : '';
      // 文に出すのは、⛔を除いた数でも増えている項目だけ（⛔だけが増えたときに「0→0件」などと出ていた）
      const mustKeys = (keys) => keys.filter(k => k !== 'comp' &&
        (((ck[k] || z).max > (bk[k] || z).max) || ((ck[k] || z).min > (bk[k] || z).min)));
      const mustTxt = cmp(base.must, x.st.must, '件') + (bad
        ? (mustKeys(upKeys).length ? `<div style="color:var(--lv-must)">増えます（${words(mustKeys(upKeys))}）</div>`
          : upKeys.indexOf('comp') >= 0 ? '<div style="color:var(--lv-must)">6連勤以上が増えるため選べません</div>'
          // 範囲では増えて見えないが、いちばん良い回どうしでは増えるとき: いちばん良い回どうしの数（⛔込み）をそのまま出す
          : `<div style="color:var(--lv-must)">増えます（いちばん良い回どうしで ${scoreWorsened(x.st.best.sc, base.best.sc).filter(w => counted(w.key) && w.key !== 'comp')
              .map(w => `${labOf(w.key)} ${w.from}→${w.to}${unitOf(w.key)}`).join('・')}）</div>`)
        : upWorst ? (mustKeys(upMax).length ? `<div style="color:var(--lv-soft)">回によっては増えます（${words(mustKeys(upMax))}）</div>`
          // ⛔が本当に新しくできた・伸びたときだけ「6連勤以上」。そうでなければ（基準の別々の回の⛔と5連勤が1つの回に
          // まとまった、7連勤が6連勤に縮んだ など）⛔込みの数で出す
          : compAny ? '<div style="color:var(--lv-soft)">回によっては増えます（6連勤以上）</div>'
          : `<div style="color:var(--lv-soft)">回によっては増えます（${(upMax.filter(k => k !== 'comp').length ? upMax.filter(k => k !== 'comp') : ['comp'])
              .map(k => `${k === 'comp' ? '6連勤以上の件数' : labOf(k)} ${rng(bki[k] || z, '')}→${rng(cki[k] || z, unitOf(k))}`).join('・')}）</div>`)
        : '<div class="hint">増えません</div>');
      // 切り替えの超過・🟡が増える案には ⚠️（最小か最大のどちらかが増えたとき）
      const warn = (a, b) => (a.min > b.min || a.max > b.max) ? uiIcon('soft') + ' ' : '';
      const btn = bad ? '<span class="hint">「絶対」の違反が増えるため選べません</span>'
        : `<button class="btn btn-primary" data-fcgo="${i}" ${running || stale ? 'disabled' : ''}>この設定にする</button>`;
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:4px">${escapeHtml(x.label)}<div class="hint">${x.runs}回・${x.sec}秒</div></td>
        <td style="padding:4px;text-align:center">${cmp(base.comp, x.st.comp, '件')}${compMark}</td><td style="padding:4px;text-align:center">${mustTxt}</td>
        <td style="padding:4px;text-align:center">${warn(x.st.bs, base.bs)}${cmp(base.bs, x.st.bs, '回')}</td>
        <td style="padding:4px;text-align:center">${warn(x.st.soft, base.soft)}${cmp(base.soft, x.st.soft, '件')}</td>
        <td style="padding:4px">${btn}</td></tr>`;
    }).join('');
    // 古くなったら知らせ、元に戻して古くなくなったら、もとの文に戻す
    $('fcStatus').innerHTML = (stale && !running)
      ? uiIcon('soft') + ' 見込みが古くなっています（表・希望・設定・担当などが変わりました）。計算し直してください。' : statusHtml;
    modal.querySelectorAll('[data-fcgo]').forEach(b => b.addEventListener('click', () => applyCand(results[+b.dataset.fcgo])));
  };
  let lastStale = false;
  const watch = setInterval(() => {
    if (!modal.isConnected) { clearInterval(watch); return; }
    const stale = !!(fp0 && forecastFp() !== fp0);
    if (stale !== lastStale) { lastStale = stale; redraw(); }
  }, 1000);
  const applyCand = (x) => {
    if (!x || running) return;
    if (typeof calcBusy === 'function' && calcBusy()) { note(/確認待ち/.test(calcOwner() || '') ? '余の解消パネルの質問に答えてからにしてください' : `いまは「${calcOwner()}」の計算中です。終わってからにしてください`); return; }
    if (fp0 && forecastFp() !== fp0) { note('表などが変わったため、この見込みは使えません。計算し直してください'); return; }
    const names = [];
    // 足す直前のいまの表を数えておく（保存されていたエラーの一覧は古いことがあり、担当以外の差が混ざっていた）
    const bSc = (AppState.generated && AppState.shifts) ? scoreViolations(checkViolations(AppState.shifts)) : null;
    x.patch.forEach(c => {
      const s = AppState.staff.find(y => y.id === c.id); if (!s) return;
      s.allowedShifts = s.allowedShifts || [];
      c.add.forEach(k => { if (!s.allowedShifts.includes(k)) { s.allowedShifts.push(k); names.push(`${s.name}さんに「${shiftSym(k)}」`); } });
    });
    saveToStorage();
    if (typeof refreshAllUI === 'function') refreshAllUI();
    const re = recheckAfterStaffChange(bSc);
    toast(`担当を足しました（${names.join('・') || '変更なし'}）。表は変えていません。` +
          (re ? `いまの表のエラーを数え直しました（担当を足す前 ${scoreSummaryText(re.b)} → 足したあと ${scoreSummaryText(re.a)}）。` : '') +
          'この設定で作るには、生成してください。見込みの数は試しに作ったものなので、1〜2件の差はたまたま変わることがあります', 'success', 10000);
    close();
  };
  $('fcGo').addEventListener('click', async () => {
    if (typeof calcBusy === 'function' && calcBusy()) { note(/確認待ち/.test(calcOwner() || '') ? '余の解消パネルの質問に答えてからにしてください' : `いまは「${calcOwner()}」の計算中です。終わってからにしてください`); return; }
    const todo = cands.filter(c => c.on);
    if (!calcBegin('設定を変えたときの見込み')) return;
    running = true; stopped = false; $('fcGo').disabled = true; $('fcStop').style.display = 'inline-block'; $('fcEst').textContent = '';
    const R = +$('fcRuns').value || 2;
    fp0 = forecastFp(); results.length = 0; base = null; statusHtml = ''; redraw();
    let total = R * (1 + todo.length), done = 0, secSum = 0;
    const say = (what) => {
      const avg = done ? secSum / done : 65;
      setStatus(`${escapeHtml(what)}（全部で${total}回・いま${Math.min(done + 1, total)}回目・あと約${Math.max(1, Math.round((total - done) * avg / 60))}分）`);
    };
    const runN = async (what, patch) => {
      const runs = []; const t0 = Date.now();
      for (let i = 0; i < R; i++) {
        if (stopped) throw new Error(MILP_CANCEL_MSG);
        say(what);
        const t1 = Date.now();
        const r = await optimizeScheduleMILP(null, { fastMode: true, noApply: true, staffPatch: patch });
        done++; secSum += (Date.now() - t1) / 1000;
        runs.push({ sc: scoreViolations(r.violations || []), violations: r.violations || [], shifts: r._shifts || r.shifts });
      }
      return { runs, sec: Math.round((Date.now() - t0) / 1000) };
    };
    const baseLine = () => `基準（いまの設定）: 6連勤以上 ${rng(base.comp, '件')}・絶対（6連勤以上を除く） ${rng(base.must, '件')}・切り替えの超過 ${rng(base.bs, '回')}・できれば ${rng(base.soft, '件')}`;
    const failed = [];
    try {
      const b = await runN('いまの設定で試しに作っています', null);
      base = forecastStats(b.runs);
      // いまの表が無いときは、基準の試し計算の切り替えから候補を作る（一度だけ）
      if (!autoMade) {
        autoMade = true;
        addAuto(forecastCandidates(base.best.shifts, base.best.violations));
        cands.filter(c => c.on && todo.indexOf(c) < 0).forEach(c => todo.push(c));   // 先に自分で足した案と同じものは1回だけ
        renderCands(); total = R * (1 + todo.length);
      }
      setStatus(baseLine());
      for (const c of todo) {
        try {
          const x = await runN(`「${c.label}」で試しに作っています`, c.patch);
          results.push({ label: c.label, patch: c.patch, st: forecastStats(x.runs), runs: R, sec: x.sec });
        } catch (e) {
          if (/^cancel/.test(e.message || '') || stopped) throw e;
          failed.push(c.label);   // この案だけ失敗。ほかの案は続ける
        }
        redraw();
      }
      setStatus(todo.length
        ? `計算が終わりました。${baseLine()}` + (failed.length ? `<div>${uiIcon('close')} 計算に失敗した案: ${failed.map(escapeHtml).join('／')}（もう一度試してください）</div>` : '')
        : `${baseLine()}<div>試す候補がありません。候補にチェックを入れるか、「自分で足す」で加えてから、もう一度押してください。</div>`);
    } catch (e) {
      setStatus(/^cancel/.test(e.message || '') || stopped
        ? (results.length ? '中止しました。出ている見込みから選べます。' : '中止しました。')
        : '計算に失敗しました。もう一度試してください。（' + escapeHtml(e.message || '') + '）');
    } finally {
      running = false; calcEnd();
      if (modal.isConnected) { $('fcGo').disabled = false; $('fcStop').style.display = 'none'; redraw(); estimate(); }
    }
  });
}

function showFeasibilityModal() {
  if (!AppState.staff.length || !AppState.settings.targetMonth) {
    toast('スタッフと対象年月を設定してください', 'error');
    return;
  }
  const items = (typeof runAIDiagnosis === 'function') ? runAIDiagnosis() : [];
  // 「エラー0件が数学的に可能か」の判定を最上部に出す（配置では消せない原因の特定）
  const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
  const colors = {
    error:   { bg: 'var(--lv-must-bg)', border: 'var(--lv-must)', title: 'var(--lv-must)', body: 'var(--text)' },
    warning: { bg: 'var(--lv-soft-bg)', border: 'var(--lv-soft)', title: 'var(--lv-soft)', body: 'var(--text)' },
    info:    { bg: 'var(--accent-soft)', border: 'var(--link)', title: 'var(--link)', body: 'var(--text)' },
    ok:      { bg: 'var(--ok-bg)', border: 'var(--ok)', title: 'var(--ok)', body: 'var(--text)' },
  };
  const body = items.map(d => {
    const c = colors[d.level] || colors.info;
    const detail = escapeHtml(d.detail || '').replace(/\n/g, '<br>');
    return `<div style="background:${c.bg};border-left:4px solid ${c.border};padding:10px 12px;margin:8px 0;border-radius:6px">
      <div style="font-weight:600;color:${c.title};margin-bottom:4px">${uiIcon(/⛔/.test(d.title || '') ? 'crit' : ({ error: 'must', warning: 'soft', ok: 'ok' })[d.level] || 'info')} ${escapeHtml(stripMarks(d.title))}</div>
      <div style="color:${c.body};font-size:13px;line-height:1.6">${detail}</div>
      ${d.suggestion ? `<div style="margin-top:6px;color:var(--link);font-size:13px">${uiIcon('info')} ${escapeHtml(stripMarks(d.suggestion))}</div>` : ''}
    </div>`;
  }).join('') || '<p>データが不足しています。</p>';

  // 判定の見出し（可能／不可能）と、不可能な場合の具体的な原因
  let verdict = '';
  if (lb) {
    if (lb.possible) {
      verdict = `<div style="padding:14px 16px;border-radius:10px;margin:0 0 14px;
          background:color-mix(in srgb, var(--success) 14%, var(--surface));
          border:1px solid color-mix(in srgb, var(--success) 38%, transparent);line-height:1.8">
        <b style="font-size:15px">${uiIcon('ok')} 人員の面では足りています</b><br>
        <span style="font-size:13px">日ごとの人数・役割・スキル・副店長・連勤上限・月全体の人日、いずれにも
        「配置では消せない不足」はありません。<br>
        <b>ただし、これは人員の話だけです。</b>並び方のルール（単発出勤・遅→早・時間帯の切替・連休の長さ・
        早遅バランスなど）はここでは判定していないため、<b>これらのエラーは出ることがあります</b>。<br>
        並び方のエラーは配置で消せるものが多いので、<b>じっくり生成</b>で時間をかけると減ります。
        それでも残る場合は <b>エラー解消プラン</b> で該当ルールを緩めてください。</span>
      </div>`;
    } else {
      // 直し方が分かっているもの（希望の付け替えなど）は先頭に出す
      const sorted = lb.reasons.slice().sort((a, b) => (b.fix ? 1 : 0) - (a.fix ? 1 : 0));
      const lines = sorted.map(r => `・${escapeHtml(r.text)}`
        + (r.fix ? `<br><span class="hint" style="margin-left:1em">→ ${escapeHtml(r.fix)}</span>` : '')).join('<br>');
      const more = '';
      verdict = `<div style="padding:14px 16px;border-radius:10px;margin:0 0 14px;
          background:color-mix(in srgb, var(--danger) 12%, var(--surface));
          border:1px solid color-mix(in srgb, var(--danger) 38%, transparent);line-height:1.8">
        <b style="font-size:15px">${uiIcon('must')} このままだと必ずエラーが出ます（配置では消せません）</b><br>
        <span style="font-size:13px">配置をどう変えても、最低 <b>${lb.minErrors}件</b> のエラーが残ります。原因は次のとおりです。
        （これに加えて、並び方のルールによるエラーが出ることもあります）</span>
        <div style="font-size:13px;margin-top:8px;max-height:46vh;overflow:auto">${lines}${more}</div>
        <div style="font-size:13px;margin-top:8px">${uiIcon('info')} <b>エラー解消プラン</b>で、どの設定をいくつ動かせば解消するか確認できます。</div>
      </div>`;
    }
  }

  // お知らせ（ルールに当てはまらない増員など。エラーになるとは限らない）
  let notes = '';
  if (lb && lb.notes && lb.notes.length) {
    const ln = lb.notes.slice(0, 10).map(r => `・${escapeHtml(r.text)}<br><span class="hint" style="margin-left:1em">${escapeHtml(r.fix || '')}</span>`).join('<br>');
    notes = `<div style="padding:12px 14px;border-radius:10px;margin:0 0 14px;
        background:color-mix(in srgb, var(--accent) 10%, var(--surface));
        border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);line-height:1.8">
      <b style="font-size:14px">${uiIcon('info')} 確認していただきたいこと</b>
      <div style="font-size:13px;margin-top:6px">${ln}</div>
    </div>`;
  }

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
  modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;max-width:720px;width:100%;max-height:85vh;overflow:auto;padding:20px">
    <h3 style="margin:0 0 4px">実現性チェック（生成する前の判定）</h3>
    <p class="hint" style="margin:0 0 12px">
      まず「<b>人員が足りているか</b>」を判定します。足りない場合は、どの日の何が原因かまで特定します。<br>
      <b>並び方のルール（単発出勤・遅→早・連休など）はここでは判定していません。</b>人員が足りていても、
      これらのエラーは出ることがあります。その下は参考情報です。
    </p>
    ${verdict}
    ${renderDayMarginsHtml()}
    ${(typeof renderRoleCapacityHtml === 'function') ? renderRoleCapacityHtml() : ''}
    <div id="wishFixBox"></div>
    ${notes}
    <div id="fixPlanBox"></div>
    ${body}
    <div style="text-align:right;margin-top:12px"><button id="feasClose" class="btn btn-primary">閉じる</button></div>
  </div>`;
  document.body.appendChild(modal);
  renderFixPlans(modal);   // 「誰の何日をどう入れ替えるか」をこの画面にも出す
  renderWishFixBox(modal); // 希望の変え方を計算で確かめる（3-1②）
  // 閉じたら、🧪 の計算も止める（止めずに閉じると、十数分〜30分、ほかの計算も手直しもできなくなっていた）
  const close = () => { if (typeof modal._stopCalc === 'function') modal._stopCalc(); modal.remove(); };
  modal.querySelector('#feasClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

/**
 * 生成結果が「大事な順に、これ以上減らせないと確かめられた」のか「時間切れで打ち切った」のかを表示する。
 * 打ち切りだった場合は、時間を延ばして再計算するボタンを出す（＝まだ減る可能性がある）。
 */
// info: 🎯 じっくり生成（newTiering）の結果の内訳（optimalityInfo）。時間切れ・案Bで戻した・案Dで1分生成の答えを採った、を分けて出す
function showOptimalityNotice(cutOff, vioCount, elapsed, wasDeep, usedGap, wasFast, tierLog, info) {
  const $report = document.getElementById('reportCard');
  if (!$report) return;
  const old = document.getElementById('optimalityNotice');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'optimalityNotice';
  if (typeof genTextKey === 'function') box.dataset.genKey = genTextKey();   // A6・C1（表と違反の種類ごとの件数）
  box.style.cssText = 'padding:12px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;line-height:1.7';
  // 時間切れでエラーが残ったときにすすめること。⑤の「シフトを作る」の下の注意（ほかのアプリや重いページを閉じる）と同じ言い方にする。
  // 妥協なしで再計算（wasDeep）のあとは、じっくり生成をすすめない（じっくり生成のほうが早く止めるので、作り直しても良くならない）
  const CHECK = 'まず⑤自動生成の「詳しい機能」→「実現性チェック（生成前）」で、人手が足りているかを確かめてください。'
    + (wasDeep
      ? '足りているのに残るときは、⑥シフト表の「エラーを自動修正」で減らせないか試すか、「シフト表」で手直ししてください。'
      : '足りているのに残るときは、ほかのアプリや重いページを閉じてから、もう一度じっくり生成すると良くなることがあります。');

  if (wasFast) {
    // 速い生成: いちばん良い表かどうかは確かめていないので「最良とは限らない」と正直に出し、じっくり生成への導線を置く
    box.style.background = 'color-mix(in srgb, var(--accent) 12%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--accent) 32%, transparent)';
    box.innerHTML = `${uiIcon('gen-fast')} <b>1分生成で完了しました（${elapsed}秒）</b>：` +
      (vioCount === 0
        ? 'エラー0件です。<b>0件なのでこれ以上良くなりようがありません</b>。このまま使えます。'
        : `エラー ${vioCount}件。<b>これが最良とは限りません</b>（最大60秒で探した答えで、いちばん良い表かどうかは確かめていません）。<br>
           じっくり生成にすると<b>さらに減ることがあります</b>。人手がぎりぎりの月ほど差が大きくなる傾向があります。
           最終確定の前に、一度は下のボタンで解き直すことをおすすめします。`) +
      (vioCount > 0
        ? '<br><button id="btnProofOptimize" class="btn btn-primary" style="margin-top:8px">' + uiIcon('gen-deep') + 'じっくり生成で解き直す（最大約11分）</button>'
        : '');
  } else if (cutOff && info && (info.pickedFast || (!info.timedOut && info.screenRejected > 0))) {
    // 時間切れではない理由で「確かめ済み」にならなかったとき。設定を緩めるすすめは出さない
    // （以前は時間切れと同じ「解ききれませんでした・緩めてください」を出していた）
    box.style.background = 'color-mix(in srgb, var(--accent) 12%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--accent) 32%, transparent)';
    const head = info.pickedFast
      ? `${uiIcon('gen-deep')} <b>じっくり生成で完了しました（${elapsed}秒）</b>：じっくり生成の答えと1分生成の答えを、画面と同じ並べ方で比べました。
         <b>1分生成の答えのほうが良かったので、そちらを採りました</b>。`
      : `${uiIcon('gen-deep')} <b>じっくり生成で完了しました（${elapsed}秒・時間切れはありません）</b>：画面と同じ検査で悪くなる答えを外して、
         良いほうを採りました。`;
    // 21人以上の部門は最初から「差2%で止める」ので、時間切れでなくても solverProven が false になる。
    // そのときは時間切れとして扱わず、v239 と同じ説明と「⏳ 妥協なしで再計算」を出す
    const gapRetry = info.timedOut && usedGap && !wasDeep;
    // エラー0件なら、時間切れ・差2%の説明も、計算し直すすすめも出さない（直すものが無い。v268）
    box.innerHTML = head + (vioCount === 0
      ? '<br>エラーは0件なので、このまま使えます。'
      : gapRetry
      ? `<br>21人以上の部門は、時間を短くするため「ほぼ最良（差2%以内）」のところで計算を止めているため、
         これが最良だとは確認できていません。<br>
         <button id="btnDeepOptimize" class="btn btn-primary" style="margin-top:8px">${uiIcon('recalc')}妥協なしで再計算（早期停止を無効・最大約11分）</button>`
      : info.timedOut
      ? `<br>じっくり生成の側には、時間内に最後まで計算しきれない段がありました。残り ${vioCount}件は<b>「避けられない」とは限りません</b>。${CHECK}`
      : (info.pickedFast ? `時間切れではありません。` : '') + (info.screenRejected > 0
          ? `<br>答えを外した段があるため、「これ以上良い組み合わせは無い」とまでは確認していません。`
          : `<br>計算の上の最良と、画面の検査での良し悪しが少し違うため、画面で良いほうを採りました。`) +
        `残り ${vioCount}件を減らすには、設定（必要人数・公休数・担当シフト・希望休など）を見直してください。`);
  } else if (!cutOff) {
    box.style.background = 'color-mix(in srgb, var(--success) 14%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--success) 35%, transparent)';
    box.innerHTML = vioCount === 0
      ? `${uiIcon('ok')} <b>計算完了（${elapsed}秒）</b>：エラー0件です。0件なので、これ以上良くなりようがありません。`
      // 「確かめた」のは大事な順に1つずつ（6連勤以上 → 人員不足 → …）。件数の合計がいちばん少ないことまでは確かめていない（v268）
      : `${uiIcon('ok')} <b>計算完了（${elapsed}秒）</b>：残り ${vioCount}件。大事な順に（6連勤以上 → 人員不足 → …）1つずつ、
         <b>今の設定ではこれ以上減らせない</b>ことを計算の上で確かめました（大事な順に確かめたので、件数の合計がいちばん少ないとは限りません）。<br>
         減らすには、必要人数・公休数・担当シフト・希望休などの設定を見直してください。`;
  } else if (vioCount === 0) {
    // 時間切れの段があっても、エラーが0件なら直すものは無い（「残り 0件は…とは限りません」と出ていた）
    box.style.background = 'color-mix(in srgb, var(--success) 14%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--success) 35%, transparent)';
    box.innerHTML = `${uiIcon('ok')} <b>計算完了（${elapsed}秒）</b>：エラー0件です。0件なので、これ以上良くなりようがありません。`;
  } else {
    box.style.background = 'color-mix(in srgb, var(--warning) 16%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--warning) 40%, transparent)';
    // じっくりモードで改善余地があるのは「早期停止(gap許容)を使った＝21人以上の部門」のときだけ。
    // 20人以下は既に上限10分・gap=0で解いているため、再計算しても結果は変わらない。
    const canRetry = !wasDeep && usedGap;
    // 「確認済み」は、すべての段を一から解いて最後まで計算できたときだけ出す。
    // それ以外（時間切れの段・近くだけを探し直した段・「ほぼ最良」で止めた段がある）は
    // 「時間内でいちばん良い答え」。
    box.innerHTML = `${uiIcon('info')} <b>時間内でいちばん良い答えです（${elapsed}秒）</b>：残り ${vioCount}件は
      <b>「避けられない」とは限りません</b>。${canRetry
        ? '21人以上の部門は、時間を短くするため「ほぼ最良（差2%以内）」のところで計算を止めているため、'
        : '最後まで計算しきれなかった段があるため、'}
      これが最良だとは確認できていません。<br>
      ${canRetry
        ? '<button id="btnDeepOptimize" class="btn btn-primary" style="margin-top:8px">' + uiIcon('recalc') + '妥協なしで再計算（早期停止を無効・最大約11分）</button>'
        : '上限いっぱいまで計算しても解ききれませんでした。' + CHECK}`;
  }
  // 段階最適化の結果（どのルールを何件まで抑えられたか）を表示する
  if (tierLog && tierLog.length) {
    const d = document.createElement('div');
    d.style.cssText = 'margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:12.5px;line-height:1.8';
    d.innerHTML = '<b>段階ごとの結果（大事な順に確定）</b><br>' +
      tierLog.map(t => {
        const zero = /: 0件$/.test(t);
        return `${uiIcon(zero ? 'ok' : 'soft')} ${escapeHtml(t)}`;
      }).join('<br>');
    box.appendChild(d);
  }

  // エラーが残ったときは、その場から「どう緩めれば消えるか」へ行けるようにする
  if (vioCount > 0) {
    const go = document.createElement('button');
    go.className = 'btn';
    go.style.cssText = 'margin-top:8px;margin-left:8px';
    go.textContent = 'エラー解消プランを見る';
    go.addEventListener('click', () => { if (typeof showRelaxModal === 'function') showRelaxModal(); });
    box.appendChild(document.createElement('br'));
    box.appendChild(go);
  }
  $report.insertBefore(box, $report.firstChild);
  const bp = document.getElementById('btnProofOptimize');
  if (bp) bp.addEventListener('click', () => {
    if (typeof window._runGenerate === 'function') {
      toast('じっくり生成で解き直します（1部門あたり最大約11分）', 'info', 4000);
      window._runGenerate({ newTiering: true, keepIfWorse: true });
    }
  });
  const bd = document.getElementById('btnDeepOptimize');
  if (bd) bd.addEventListener('click', () => {
    if (typeof window._runGenerate === 'function') {
      toast('妥協なしモードで再計算します（1部門あたり最大約11分）', 'info', 4000);
      window._runGenerate({ deepMode: true, newTiering: true, keepIfWorse: true });
    }
  });
}

// 並べ方（scoreCompare）の順で、最初に違った項目を返す（C7。表を変えなかった「決め手」を言うため）。同じなら null
function scoreDecider(a, b) {
  const items = [
    ['comp', '6連勤以上', '件'], ['under', '人員不足', '件'], ['must', '「絶対」の違反', '件'], ['over', '連勤の超過日数', '日'],
    ['offShort', '公休の不足日数', '日'], ['bsOver', '切り替えの超過回数', '回'], ['soft', '「できれば」の違反', '件'],
  ];
  for (const [k, label, unit] of items) {
    let x = a[k] || 0, y = b[k] || 0;
    if (k === 'must') { x -= (a.comp || 0); y -= (b.comp || 0); }   // 画面の「絶対」の件数は6連勤以上を除いて出す
    if (x !== y) return { key: k, label, unit, a: x, b: y };
  }
  return null;
}
// 妥協なしで再計算・じっくり生成で解き直す で、いまの表より良くなかったので表を変えなかったときの文（C7）。
// 時間切れかどうかは、ふつうの完了の文（showOptimalityNotice）と同じ分け方で言う（以前は solverProven だけで
// 「時間切れ」と言い、21人以上の差2%で止めた回・1分生成の答えを採った回にも出ていた）。決め手の項目もいつも出す。
function keepWorseMessage(what, sNew, sCur, res, info, opts) {
  let msg = `${what}の答え（${scoreSummaryText(sNew)}）は、いまの表（${scoreSummaryText(sCur)}）より良くなかったので、表は変えていません。`;
  const dec = scoreDecider(sNew, sCur);
  if (dec) msg += `決め手は${dec.label}です（答え ${dec.a}${dec.unit}・いまの表 ${dec.b}${dec.unit}）。`;
  if (info) {
    if (info.timedOut && res.usedGap === true && !opts.deepMode) {
      msg += '21人以上の部門は、時間を短くするため「ほぼ最良（差2%以内）」のところで計算を止めています（時間切れではありません）。';
    } else if (info.timedOut) {
      msg += info.pickedFast ? '1分生成の答えのほうが良かったのでそちらを採りましたが、じっくり生成の側は時間内に最後まで計算しきれませんでした。'
                             : '時間内に最後まで計算しきれない段がありました。';
    } else if (info.pickedFast) {
      msg += 'じっくり生成の答えより1分生成の答えのほうが良かったので、そちらを採っています（時間切れではありません）。';
    }
  } else if (res.allOptimal === false) {
    msg += '時間内に最後まで計算しきれない段がありました。';
  }
  return msg;
}

// ⑤ 自動生成パネル
function setupGeneratePanel() {
  const btn = document.getElementById('btnGenerate');          // 🎯 じっくり生成
  const btnFast = document.getElementById('btnGenerateFast');  // ⚡ 1分生成
  // じっくり生成は中で1分生成も作って比べるので、最大で約11分
  const BTN_LABEL = { proof: 'じっくり生成（最大約11分）', fast: '1分生成（最大60秒）' };   // index.html のボタンの文字と同じ
  const setBusy = (busy) => {
    [btn, btnFast].forEach(b => { if (b) b.disabled = busy; });
    if (busy) { if (btn) btn.textContent = '計算中...'; if (btnFast) btnFast.textContent = '計算中...'; }
    else { if (btn) btn.textContent = BTN_LABEL.proof; if (btnFast) btnFast.textContent = BTN_LABEL.fast; }
  };
  const btnCancel = document.getElementById('btnCancelGenerate');
  const btnFeas = document.getElementById('btnFeasibility');
  if (btnFeas) btnFeas.addEventListener('click', showFeasibilityModal);
  const btnFc = document.getElementById('btnForecast');
  if (btnFc) btnFc.addEventListener('click', showForecastModal);
  const btnRelax = document.getElementById('btnRelax');
  if (btnRelax) btnRelax.addEventListener('click', showRelaxModal);
  const btnSurPlan = document.getElementById('btnSurplusPlan');
  if (btnSurPlan) btnSurPlan.addEventListener('click', showSurplusPlanModal);
  const btnWiz = document.getElementById('btnWizard');
  if (btnWiz) btnWiz.addEventListener('click', showGenerateWizard);

  // opts.deepMode = true でじっくり最適化（時間上限を大幅に延長）
  const runGenerate = async (opts) => {
    opts = opts || {};
    // 途中から作り直すなど、生成の前に🔒などを変えてから呼ぶ所は、始めずに戻るときも onAbort で元に戻す
    if (AppState.staff.length === 0) {
      toast('スタッフを登録してください', 'error');
      if (typeof opts.onAbort === 'function') opts.onAbort();
      return;
    }
    if (!AppState.settings.targetMonth) {
      toast('対象年月を設定してください', 'error');
      if (typeof opts.onAbort === 'function') opts.onAbort();
      return;
    }

    const $area = document.getElementById('progressArea');
    const $bar = document.getElementById('progressBar');
    const $text = document.getElementById('progressText');
    const $report = document.getElementById('reportCard');

    // C11: ここより前に await を入れない。途中から作り直すは、鍵を返してすぐこの関数を呼び、
    // ここで鍵を取り直す（間に await があると、その間にほかの計算が鍵を取れてしまう）。
    if (!calcBegin('生成')) { if (typeof opts.onAbort === 'function') opts.onAbort(); return; }
    setBusy(true);
    if (btnCancel) btnCancel.style.display = 'inline-block';
    // C1: 中止・失敗したときは、始める前に出ていたレポートと案内（レポートの中の箱）を出し直す
    const repShownBefore = $report.style.display !== 'none';
    $area.style.display = 'block';
    $report.style.display = 'none';
    $bar.style.width = '0%';
    $text.textContent = '数理最適化の準備中...';

    const startedAt = Date.now();
    try {
      // 生成は数理最適化(MILP)のみ。焼きなまし法による生成は廃止。
      if (typeof optimizeScheduleMILP !== 'function') {
        throw new Error('数理最適化モジュールが未読込です。ページを再読み込み（Ctrl+Shift+R）してください。');
      }
      const prog = (pct, msg) => { $bar.style.width = pct + '%'; $text.textContent = '数理最適化: ' + levelWords(msg); };
      // 生成する前の表を控える。生成のあと元に戻すの履歴に積み、↩ で戻れるようにする（v243）
      // 途中から作り直すときは、🔒をかける前に撮った控えを使う（↩ 1回で作り直す前に戻る。A1）
      const preGen = opts.preGen !== undefined ? opts.preGen
                   : (typeof genHistorySnapshot === 'function') ? genHistorySnapshot() : null;
      // B3: ⏳ 妥協なしで再計算・🎯 じっくり生成で解き直す は、いまの表より良くなければ表を変えない。
      // 答えはいったん反映せずに受け取り（noApply。Worker へ渡す中身は同じ）、画面と同じ検査で
      // いまの表と scoreCompare で比べる（同点なら新しい答えを採る。4通りから選ぶ所・案D と同じ）
      const keepIfWorse = !!opts.keepIfWorse && typeof genTableState === 'function' && genTableState() === 'ok';
      const res = await optimizeScheduleMILP(prog, { deepMode: !!opts.deepMode, fastMode: !!opts.fastMode, newTiering: !!opts.newTiering,
                                                     noApply: keepIfWorse });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      // 🎯 じっくり生成（newTiering）の内訳: 1分生成の答えを採ったか・本当に時間切れか・案Bで答えを外したか
      // （C7: 表を変えなかったときの文でも同じ分け方を使うので、keepIfWorse より前で求める）
      const info = opts.newTiering ? {
        pickedFast: res.safetyPick === 'fast',
        timedOut: res.safetyPick === 'fast' ? res.deepSolverProven === false : res.solverProven === false,
        screenRejected: res.safetyPick === 'fast' ? (res.deepScreenRejected || 0) : (res.screenRejected || 0),
      } : null;
      if (keepIfWorse) {
        const vCur = checkViolations(AppState.shifts);
        const vNew = checkViolations(res._shifts || {});
        const sCur = scoreViolations(vCur), sNew = scoreViolations(vNew);
        if (scoreCompare(sNew, sCur) > 0) {
          // 表・違反・genBase・editLog・履歴・保存には触らない
          $bar.style.width = '100%';
          const what = opts.deepMode ? '妥協なしで再計算' : 'じっくり生成で解き直す';
          const msg = keepWorseMessage(what, sNew, sCur, res, info, opts);
          $text.textContent = msg + `（${elapsed}秒）`;
          if (typeof stampGenerateText === 'function') stampGenerateText();   // C1: この文は、いまの表のもの
          $report.style.display = 'block';
          if (typeof syncGenerateResult === 'function') syncGenerateResult();
          toast(msg, 'info', 9000);
          return;
        }
        _milpApply(res, {});
      }
      // v269: 表を作ったあとに、総務の順番に入れ替える（①の設定。エラーが1件でも増える入れ替えはしない）。
      // 入れ替えたあとの表を「生成した直後の表」（genBase）にする（このあとの genBaseTake）
      const somuN = (typeof applySomuReorderAfterGenerate === 'function') ? applySomuReorderAfterGenerate() : 0;
      if (somuN) res.violations = AppState.violations;
      $bar.style.width = '100%';
      const cutOff = (res.allOptimal === false);   // 時間切れで打ち切られた＝最良解とは限らない
      const notTimeout = info && cutOff && !info.timedOut;
      $text.textContent = `完了！ 違反 ${res.violations.length}件（${elapsed}秒）` +
                          (opts.fastMode ? '｜1分生成（最大60秒で探した答え。いちばん良いかは確かめていません）'
                                         : (info && info.pickedFast) ? '｜1分生成の答えのほうが良かったので、そちらを採りました'
                                         : notTimeout ? '｜画面の検査で悪くなる答えを外して、良いほうを採りました（時間切れではありません）'
                                         : cutOff ? '｜時間内でいちばん良い答え（最良とは確認できていません）'
                                                  : '｜大事な順に、これ以上減らせないことを確かめました')
                          + (somuN ? `｜総務の順番で ${somuN}か所 入れ替えました` : '');
      // 生成する前の表を元に戻すの履歴に積む（何回か作り直して、良い表へ ↩ で戻れるように）。
      // 前の表が無い（初めて作った・別の月）ときは、今までどおり履歴を空にする。
      if (typeof pushGenHistory === 'function') pushGenHistory(preGen);
      else if (typeof resetShiftHistory === 'function') resetShiftHistory();
      // 生成した直後の表を控える（途中から作り直したときも撮り直す）。
      // このあと手などで変えたマスを「生成から変えたマス」として数える。
      if (typeof genBaseTake === 'function') genBaseTake();
      // A6・C1: この文は、いまの表のもの（表か違反の種類ごとの件数が変わったら syncGenerateResult が隠す）
      if (typeof stampGenerateText === 'function') stampGenerateText();
      $report.style.display = 'block';
      try {
        renderReport({ success: res.success, score: res.score, violations: res.violations,
          candidateSummary: `数理最適化で生成 — 違反${res.violations.length}件（${elapsed}秒）` });
      } catch (rErr) { console.error('[generate] レポート表示でエラー（表は表示します）:', rErr); }
      showOptimalityNotice(cutOff, res.violations.length, elapsed, !!opts.deepMode, res.usedGap === true, !!opts.fastMode, res.tierLog, info);
      renderResultTable();
      setTimeout(() => {
        const rt = document.querySelector('.tab[data-tab="result"]'); if (rt) rt.click();
        if (typeof showSurplusPopup === 'function') showSurplusPopup();
      }, 800);
      if (res.success) toast('シフト生成完了！全ルールクリア！', 'success', 5000);
      else toast(`シフト生成完了（違反${res.violations.length}件）`, 'info', 5000);
      AppState._needsRegen = false;   // 作り直したので解消
      if (typeof renderNextStep === 'function') renderNextStep();
      saveToStorage();
      return;
    } catch (e) {
      console.error(e);
      if (e && /terminated|cancel/i.test(e.message || '')) {
        toast('生成を中止しました', 'info'); $text.textContent = '中止しました';
      } else {
        toast('数理最適化に失敗しました: ' + e.message, 'error', 7000);
        $text.textContent = 'エラー: ' + e.message;
      }
      // 途中から作り直すなど、生成の前に変えたものを元に戻す
      if (typeof opts.onAbort === 'function') { try { opts.onAbort(); } catch (_) {} }
      // C1: 中止・失敗の文も、いまの表のものとして控える。始める前に出ていたレポートと案内は出し直す
      if (typeof stampGenerateText === 'function') stampGenerateText();
      if (repShownBefore) $report.style.display = 'block';
      return;
    } finally {
      setBusy(false);
      calcEnd();
      if (btnCancel) btnCancel.style.display = 'none';
      try { if (typeof syncGenerateResult === 'function') syncGenerateResult(); } catch (_) {}
    }
  };
  window._runGenerate = runGenerate;   // 「じっくり生成で解き直す」等から呼ぶ
  // 🎯 じっくり生成: 新しいしくみ（newTiering）を使う。ほかの呼び出しは本番 v239 と同じ計算
  btn.addEventListener('click', () => runGenerate({ newTiering: true }));
  if (btnFast) btnFast.addEventListener('click', () => runGenerate({ fastMode: true }));

  // キャンセルボタン
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      // 数理最適化（いまの生成）と、古い計算の両方を止める。これまでは古い計算しか
      // 止めておらず、押しても数理最適化は最後まで走って表を置き換えていた。
      const stopped = (typeof cancelMILP === 'function' && cancelMILP()) |
                      (typeof cancelActiveOptimization === 'function' && cancelActiveOptimization());
      if (stopped) {
        toast('中止リクエストを送りました', 'info');
        btnCancel.style.display = 'none';
        setBusy(false);
        const $text = document.getElementById('progressText');
        if ($text) $text.textContent = '中止しました';
      }
    });
  }

  // AI解説ボタン
  const btnAI = document.getElementById('btnAIExplain');
  if (btnAI) {
    btnAI.addEventListener('click', () => {
      if (!AppState.generated) {
        toast('シフトを生成してから実行してください', 'error');
        return;
      }
      if (typeof showAIExplanationModal === 'function') {
        showAIExplanationModal();
      }
    });
  }
}

/**
 * 生成後の案内ポップアップ。
 *  - コマ不足（月の合計で必要コマ > 出せるコマ（calcCapacity）、または人員不足の違反あり）→ 不足の案内
 *  - 人員余り（「余」がある）→ 余りの案内
 * を1つのポップアップで表示する。
 */
function showSurplusPopup() {
  if (!AppState.generated) return;
  const days   = getDaysInMonth(AppState.settings.targetMonth);

  // 月の合計で見た 必要コマ と 出られるコマ。⑤の表の「全体」の行・AI診断レポートと同じ数え方（calcCapacity。v267 の直し:
  // 各人の 月日数 − 公休 − 有給 で数えていて、同じ画面に違う数が出ていた）。部門ごとの不足を足し、本文も部門ごとに出す
  const cap = capacityByDept(days);
  const shortageComa = cap.short;

  // 余りコマ（公休が目標より多い分 ＋ 手動「余」）
  const surplusItems = [];
  let surplusTotal = 0;
  AppState.staff.forEach(s => {
    let publicOff = 0, yo = 0;
    for (let d = 1; d <= days; d++) {
      const sh = (AppState.shifts[s.id] || {})[d] || '';
      if (isPublicOff(sh)) publicOff++;
      else if (sh === '余') yo++;
    }
    const excess = Math.max(0, publicOff - (s.maxOff || 0)) + yo;
    if (excess > 0) { surplusItems.push({ name: s.name, yo: excess }); surplusTotal += excess; }
  });

  // 人員不足の違反（定数を満たせない・公休が足りない）
  const understaffVios = (AppState.violations || []).filter(v =>
    ['understaff', 'skill-late', 'vicemanager-absent', 'off-count'].includes(v.type));

  window._surplusTotal = surplusTotal;   // ポップアップから解消画面へ渡す
  const allVios     = AppState.violations || [];
  const hasShortage = shortageComa > 0 || understaffVios.length > 0;
  const hasSurplus  = surplusTotal > 0;
  const hasErrors   = allVios.length > 0;
  if (!hasShortage && !hasSurplus && !hasErrors) return; // 何もなければ出さない

  // ── 今回のエラーの原因まとめ（種類ごとに件数と原因・対処を表示）──
  // 種類 → [原因, 対処]。名前は getViolationLabel から引く（①の「ルールごとの強弱」・エラーの一覧と同じ名前。v268。
  // 前はここにも別の名前があり、「個人ルール: 切替時2連休」「4連休以上」「副店長・責任者の不在」などと出ていた）
  // v269: 同じ時間帯の「責任者として数える」シフト（②の印）があれば「遅責（または深）」と書く（無ければ前の版と同じ文）
  const spAlt = (role) => { const alts = respLikeKeysFor(role); return shiftSym(role) + (alts.length ? `（または${alts.map(shiftSym).join('・')}）` : ''); };
  const CAUSE = {
    'understaff':         ['その日その担当に人が足りない',           '定数を下げる／人を増やす'],
    'off-count':          ['その人が働きすぎで公休が取りきれない',   '担当できる人を増やして負担を分散'],
    'consecutive':        ['休みの配置が偏って連勤が長い',           '連勤の間に休みを挟む'],
    'category-switch':    ['連勤の中で早番⇔遅番が混ざっている',     '連勤は同じ時間帯で揃える'],
    'band-switch':        ['早番⇔遅番の切り替えが1人・月の上限を超えている', '時間帯をまとめて、切り替える日を減らす'],
    'bad-rest':           ['休みの前後で時間帯がちぐはぐ',           '休みの前後の時間帯を揃える'],
    'pair-rest':          ['遅→早の間の休みが1日しかない',         '休みを2連休以上にする'],
    'weekend-pref':       ['土日休み（絶対）の人が土日に出勤',       'その日を休みにして平日と入れ替える'],
    'rest-style':         ['連休/分散の希望（絶対）に反する配置',     '休みの位置を調整する'],
    'single-work':        ['前後が休みで1日だけ出勤',               '出勤日を連続させる'],
    'late-early':         ['退勤から翌出勤までが短い',               '順序を入れ替える'],
    'long-rest':          ['連休が長すぎる（余は除く）',             '休みを分散する'],
    'hierarchy':          ['同じ時間帯に上の役職の人がいるのに、下の人が責任者', '責任者を入れ替える'],
    'skill-late':         ['必要スキルの人がその時間帯に足りない',   'スキル保有者を配置／スキル設定を見直す'],
    'vicemanager-absent': [`副店長がだれも出勤せず、${shiftSym('早責')}・${shiftSym('遅責')}もチーフ以上でそろっていない`, `副店長を出勤させるか、${shiftSym('早責')}・${shiftSym('遅責')}の両方をチーフ以上にする`],
    'resp-duplicate':     ['同じ時間帯に責任者が過剰',               'どちらかを通常シフトに'],
    'role-mismatch':      ['入れないシフトに配置されている',         '担当を見直す／担当を広げる'],
    'day-skill':          ['その日そのシフトに要るスキルを持たない人が入っている', 'スキルを持つ人と入れ替える／その日の要るスキルを見直す'],
    'pref-mismatch':      ['早可/遅可の希望に反している',             '希望に合うよう入れ替える'],
    'event-absent':       ['行事の対象者が休みになっている',         'その日を出勤に'],
    'balance-diff':       ['早番多め／遅番多めの目標比率から外れている', '担当シフトを見直す／許容幅を広げる'],
    'overstaff':          ['その日その担当に必要より多く入っている',   '余った人を休み・有給に回す／必要人数を見直す'],
    'single-off':         ['前後が出勤で1日だけの休み',               '休みを2連休にまとめる'],
    'pair-rest-count':    ['2連休のかたまりが目安より少ない',         '休みをまとめて連休にする'],
    'night-after-work':   ['夜勤の翌日に出勤している',                 '夜勤翌日を休みにする'],
    'special-day':        [`入れ替え日に副店長が${spAlt('遅責')}に、新装日に${spAlt('早責')}に入っていない`, `副店長を、入れ替え日は${spAlt('遅責')}に、新装日は${spAlt('早責')}にする`],
    'skill-short':        ['必要スキルの人が目標人数に届かない',       'スキル保有者を増やす／目標を見直す'],
    'paid':               ['表の「有」の日数が、設定した有給日数と違う', '有給日数か、希望休・表の「有」を見直す'],
  };
  const typeCount = {};
  allVios.forEach(v => { typeCount[v.type] = (typeCount[v.type] || 0) + 1; });
  const causeRows = Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1])
    .map(([type, cnt]) => {
      // 一覧に無い種類でも、内部名（balance-diff など）を画面に出さない
      const jp = (typeof getViolationLabel === 'function') ? getViolationLabel(type) : '';
      const c = [jp || 'その他のルール'].concat(CAUSE[type] || ['', '']);
      return `<tr>
        <td style="padding:3px 8px;font-weight:700;white-space:nowrap">${escapeHtml(c[0])}</td>
        <td style="padding:3px 8px;text-align:center;color:var(--lv-must);font-weight:700">${cnt}件</td>
        <td style="padding:3px 8px;color:var(--text-soft)">${escapeHtml(c[1])}${c[2] ? `<br><span style="color:var(--link)">→ ${escapeHtml(c[2])}</span>` : ''}</td>
      </tr>`;
    }).join('');
  // 根本原因（症状の裏にある本当の原因）を最優先で表示
  let rootHtml = '';
  // 「◯コマ不足」は赤い太字で目立たせる（v267 の直し: 部門ごとの文にしたとき、ただの文字になっていた）
  const redShort = (h) => h.replace(/(\d+(?:\.\d+)?コマ不足)/g, '<b style="color:var(--lv-must)">$1</b>');
  let rootHasCap = false;   // 根本原因に「そもそも人手が足りない」（月の合計の数）を出したか。出したら下の段落では同じ文をくり返さない
  if (hasErrors && typeof analyzeRootCauses === 'function') {
    const roots = analyzeRootCauses().slice(0, 3);
    rootHasCap = roots.some(r => r.cap);
    if (roots.length) {
      rootHtml = `
        <div class="note-must" style="padding:10px 12px;border-radius:6px;margin-bottom:12px">
          <b>根本原因</b>
          ${roots.map((r, i) => `
            <div style="margin-top:${i ? 8 : 6}px">
              <div style="font-weight:700;color:var(--lv-must)">${i + 1}. ${escapeHtml(r.title)}</div>
              <div style="color:var(--text-soft);font-size:13px;margin:2px 0">${redShort(escapeHtml(r.detail))}</div>
              <div style="color:var(--link);font-size:13px">→ ${escapeHtml(r.fix)}</div>
            </div>`).join('')}
        </div>`;
    }
  }

  const causeHtml = hasErrors ? `${rootHtml}
    <div class="note-soft" style="padding:10px 12px;border-radius:6px;margin-bottom:12px">
      <b>今回のエラーの原因（症状の内訳・${allVios.length}件）</b>
      <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:13px;margin-top:6px;width:100%">
        <tr style="color:var(--text-muted)"><td style="padding:3px 8px">種類</td><td style="padding:3px 8px;text-align:center">件数</td><td style="padding:3px 8px">原因 → 対処</td></tr>
        ${causeRows}
      </table></div>
    </div>` : '';

  // 担当できる人の偏り（公休不足↔余の根本原因）を検出してポップアップに添える
  let bottleneckHtml = '';
  if (typeof findCapabilityBottlenecks === 'function') {
    const bn = findCapabilityBottlenecks();
    if (bn.length > 0) {
      const items = bn.map(b => {
        const cand = b.surplusCandidates.length
          ? `<br><span style="color:var(--link)">→ 余っている <b>${escapeHtml(b.surplusCandidates.slice(0, 4).join('・'))}</b> に任せられると分散できます</span>`
          : '';
        return `<li>「<b>${escapeHtml(shiftSym(b.key))}</b>」ができるのは <b>${b.capable.length}人</b>だけ（${escapeHtml(b.capable.slice(0, 5).join('・'))}）${cand}</li>`;
      }).join('');
      bottleneckHtml = `
        <div class="note-info" style="padding:10px 12px;border-radius:6px;margin-top:12px">
          <b>根本原因：担当できる人の偏り</b>
          <p style="margin:4px 0">下記は「できる人」が少なく、その人に負担が集中します（＝公休不足）。逆にこの担当ができない人は「余」になります。</p>
          <ul style="margin:4px 0;padding-left:20px;line-height:1.7">${items}</ul>
          <p style="margin:4px 0 0">③スタッフ管理で、余っている人に担当を追加すると両方改善します。</p>
        </div>`;
    }
  }

  const old = document.getElementById('surplusPopup');
  if (old) old.remove();

  let title, body;
  if (hasShortage) {
    // 不足している日・シフトの上位を列挙
    const shortDays = understaffVios
      .filter(v => v.type === 'understaff' || v.type === 'skill-late')
      .slice(0, 12)
      .map(v => `<li>${escapeHtml(stripLeadMark(v.message))}</li>`).join('');
    const offShort = understaffVios.filter(v => v.type === 'off-count')
      .map(v => { const s = AppState.staff.find(m => m.id === v.staffId); return s ? s.name : ''; })
      .filter(Boolean);

    title = shortageComa > 0
      ? (cap.multi
        ? `月の合計で、${cap.parts.filter(x => x.surplus < 0).map(x => `${x.label}のコマ数が ${capNum(-x.surplus)}コマ`).join('、')} 足りません`
        : `月の合計で、コマ数が ${capNum(shortageComa)}コマ 足りません`)
      : `人手が足りない日があります`;
    body = `${causeHtml}
      <p>${rootHasCap ? '月の合計の数は、上の「根本原因」に出ています。'
        : `${redShort(escapeHtml(cap.detailText))}
      ${shortageComa > 0 ? '' : '月の合計は足りていますが、特定の日・シフトで埋められていません。'}
      数え方は、⑤「実現性チェック（生成前）」の表の「全体」の行と同じです。`}シフト表の帯の「不足」は、いまの表で実際に足りないコマの数なので、この数とは違うことがあります。</p>
      ${shortDays ? `<div style="margin:8px 0"><b>埋まっていない主な箇所：</b><ul style="margin:4px 0;padding-left:20px;line-height:1.7">${shortDays}</ul></div>` : ''}
      ${offShort.length ? `<p>公休が足りていない人：<b>${escapeHtml(offShort.join('・'))}</b></p>` : ''}
      <div class="note-must" style="padding:10px 12px;border-radius:6px">
        <b>不足の解消方法：</b>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
          <li><b>必要人数（定数）を減らす</b>（②シフト種別 or シフト表の集計行で日別に）</li>
          <li><b>公休数・有給数を減らす</b>（③スタッフ管理）</li>
          <li><b>スタッフを増やす</b>（③スタッフ管理）</li>
          <li>調整後 <b>「エラーを自動修正」</b>または再生成</li>
        </ol>
      </div>${bottleneckHtml}`;
  } else if (hasSurplus) {
    const list = surplusItems.sort((a, b) => b.yo - a.yo)
      .map(r => `<li><b>${escapeHtml(r.name)}</b>：余 ${r.yo}コマ</li>`).join('');
    title = `人員が ${surplusTotal}コマ 余っています`;
    body = `${causeHtml}
      <p>必要人数（定数）を守った結果、下記の人が「<span style="color:var(--sur-fg);font-weight:700">余</span>（人員余り）」になっています。</p>
      <ul style="margin:8px 0 12px;padding-left:20px;line-height:1.8">${list}</ul>
      <div class="note-soft" style="padding:10px 12px;border-radius:6px">
        <b>コマ数をぴったりにするには：</b>
        <p style="margin:6px 0 0;line-height:1.8">下のボタンから、余のコマを1つずつ
        <b>「有給にする」</b>か<b>「その日の必要人数を1人増やして出勤にする」</b>かを選べます。
        どちらを使うかはご判断ください。<b>エラーが増える操作は自動で取り消します。</b></p>
        <button id="surplusResolveBtn" class="btn btn-primary" style="margin-top:10px">${uiIcon('sur-fix')}余の解消を開く</button>
      </div>${bottleneckHtml}`;
  } else {
    // 不足も余りもないが、エラー（時間帯切替・リズムなど）がある場合
    title = `${allVios.length}件のエラーがあります`;
    body = `${causeHtml}
      <div class="note-soft" style="padding:10px 12px;border-radius:6px">
        <b>減らし方：</b>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
          <li><b>「エラーを自動修正」</b>を押す（数回押すとさらに減ります）</li>
          <li>⑤自動生成で「生成する案の数」を増やして再生成</li>
        </ol>
      </div>${bottleneckHtml}`;
  }

  const modal = document.createElement('div');
  modal.id = 'surplusPopup';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:560px">
      <div class="modal-header">
        <h3 style="margin:0">${title}</h3>
        <button class="modal-close" id="surplusClose">✕</button>
      </div>
      <div class="modal-body" style="padding:16px">${body}</div>
      <div style="padding:0 16px 16px;text-align:right">
        <button class="btn btn-primary" id="surplusOk">わかった</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#surplusClose').addEventListener('click', close);
  modal.querySelector('#surplusOk').addEventListener('click', close);
  const rb = modal.querySelector('#surplusResolveBtn');
  if (rb) rb.addEventListener('click', () => {
    close();
    if (typeof showSurplusResolveModal === 'function') showSurplusResolveModal();
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

// 表示用の記号を変えたあと（v258）: いま出ている⑤のレポートを、新しい記号の文で出し直す。
// C1: 表・違反が変わったときの描き直し（ui.v6.js の syncReport）と同じ1つの仕組みにした。
// レポートは「何で描いたか」（表・設定・違反の全文・記号・名前）が変われば描き直すので、記号を変えたあとも新しい記号で出る。
let _lastReportResult = null;
function rerenderReportIfCurrent() {
  if (typeof syncReport === 'function') syncReport();
}

function renderReport(result) {
  // 「複数案の比較」の文は、その生成の表のときだけ出す（C1。表が変わって描き直すときは外す）
  if (result && result.candidateSummary && !result.candidateKey && typeof genResultKey === 'function') {
    result = Object.assign({}, result, { candidateKey: genResultKey() });
  }
  _lastReportResult = result;
  const $c = document.getElementById('reportContent');
  // C1: 何で描いたかを控える（syncReport が、変わったときだけ描き直す）
  if (typeof _reportKey === 'function') _reportDrawnKey = _reportKey();

  // ── AI 診断セクション ──────────────────────────────────────
  const diagItems = (typeof runAIDiagnosis === 'function') ? runAIDiagnosis() : [];
  const diagColors = {
    error:   { bg: 'var(--lv-must-bg)', border: 'var(--lv-must)', title: 'var(--lv-must)', body: 'var(--text)' },
    warning: { bg: 'var(--lv-soft-bg)', border: 'var(--lv-soft)', title: 'var(--lv-soft)', body: 'var(--text)' },
    info:    { bg: 'var(--accent-soft)', border: 'var(--link)', title: 'var(--link)', body: 'var(--text)' },
    ok:      { bg: 'var(--ok-bg)', border: 'var(--ok)', title: 'var(--ok)', body: 'var(--text)' },
  };
  const diagIcons = { error: uiIcon('must'), warning: uiIcon('soft'), info: uiIcon('info'), ok: uiIcon('ok') };

  let diagHtml = '';
  if (result.candidateSummary) {
    diagHtml += `<div class="diag-item" style="background:var(--accent-soft);border-left:4px solid var(--link);margin-bottom:8px">
      <div class="diag-title" style="color:var(--link)">複数案の比較</div>
      <div class="diag-detail" style="color:var(--text)">${escapeHtml(result.candidateSummary)}</div>
    </div>`;
  }
  // 具体的な直し方（誰の何日をどう入れ替えるか）。
  // 「再実行するか手動で変更してください」では誰を直すのか分からないため、
  // 定数を崩さない入れ替えを実際に試して、エラーが減る組み合わせだけを出す。
  diagHtml += '<div id="fixPlanBox"></div>';

  diagHtml += '<div class="diag-section">';
  diagItems.forEach(d => {
    const c = diagColors[d.level] || diagColors.info;
    const detailLines = escapeHtml(d.detail).replace(/\n/g, '<br>');
    diagHtml += `
      <div class="diag-item" style="background:${c.bg};border-left:4px solid ${c.border}">
        <div class="diag-title" style="color:${c.title}">${/⛔/.test(d.title || '') ? uiIcon('crit') + ' ' : diagIcons[d.level] + ' '}${escapeHtml(stripMarks(d.title))}</div>
        <div class="diag-detail" style="color:${c.body}">${detailLines}</div>
        ${d.suggestion ? `<div class="diag-suggestion">${uiIcon('info')} ${escapeHtml(stripMarks(d.suggestion))}</div>` : ''}
      </div>`;
  });
  diagHtml += '</div>';

  // ── 違反なし ────────────────────────────────────────────────
  if (result.success) {
    $c.innerHTML = diagHtml + `
      <div class="report-success">${uiIcon('ok')} 全てのMUSTルールがクリアされました！ スコア: 0 / 違反: 0件</div>`;
    return;
  }

  // ── 違反を2段階（🔴絶対NG / 🟡注意）に分類 ───────────────────
  // 6連勤以上（コンプラ違反）は、通常の🚨とは別に一番上に出す。
  // 件数としては🚨にも含む（比べるときの ③ と同じ）。
  const comp  = result.violations.filter(v => v.type === 'consecutive' && v.compliance);
  const must  = result.violations.filter(v => isMustViolation(v.type) && !(v.type === 'consecutive' && v.compliance));
  const should = result.violations.filter(v => !isMustViolation(v.type));

  // クリックでシフト表の該当コマへジャンプできるようにする
  const renderItems = (list) => list.map(v => {
    const s          = AppState.staff.find(m => m.id === v.staffId);
    const targetName = s ? s.name : '全体';
    const dayStr     = v.day > 0 ? ` (${v.day}日)` : '';
    const jump = ` data-jump-sid="${escapeHtml(v.staffId || '')}" data-jump-day="${v.day || 0}"`;
    return `
      <div class="violation-item is-jumpable"${jump} title="クリックでシフト表の該当箇所を表示">
        <span class="v-target">${escapeHtml(targetName)}${dayStr}</span>
        ${uiIcon(vioLevelOf([v]))} ${escapeHtml(stripLeadMark(v.message))}
        <span class="v-action">${uiIcon('info')} ${escapeHtml(v.action)}</span>
      </div>`;
  }).join('');

  // サマリー: 絶対NGが0なら実質クリア扱いのメッセージ
  let html = diagHtml;
  if (comp.length) {
    html += `<div class="report-warning" style="border:2px solid var(--lv-crit);background:var(--lv-crit-bg);font-weight:700">${uiIcon('crit')} 6連勤以上（コンプラ違反）: ${comp.length}件 ／ ${uiIcon('must')} 絶対: ${must.length}件 ／ ${uiIcon('soft')} できれば: ${should.length}件</div>
      <div class="violation-group-title" style="color:var(--lv-crit);font-weight:700;margin:12px 0 6px">${uiIcon('crit')} 6連勤以上（コンプラ違反・必ず直す）— ${comp.length}件</div>
      <div class="violation-list must crit">${renderItems(comp)}</div>`;
  } else if (must.length === 0) {
    html += `<div class="report-success">${uiIcon('ok')} 「絶対」の違反（人員不足・スキル・連勤超過・単発出勤など）は 0件！ 残り ${should.length}件 は「できれば避けたい」調整項目です。</div>`;
  } else {
    html += `<div class="report-warning">${uiIcon('must')} 絶対: ${must.length}件 ／ ${uiIcon('soft')} できれば: ${should.length}件</div>`;
  }

  if (must.length) {
    html += `
      <div class="violation-group-title" style="color:var(--lv-must);font-weight:700;margin:12px 0 6px">${uiIcon('must')} 絶対（必ず直す）— ${must.length}件</div>
      <div class="violation-list must">${renderItems(must)}</div>`;
  }
  if (should.length) {
    html += `
      <div class="violation-group-title" style="color:var(--lv-soft);font-weight:700;margin:14px 0 6px">${uiIcon('soft')} できれば（避けたい）— ${should.length}件</div>
      <div class="violation-list should">${renderItems(should)}</div>`;
  }
  $c.innerHTML = html;
  renderFixPlans();
}

/**
 * 「誰の何日をどう直すか」を計算して出す。
 * 定数を崩さない入れ替えだけを実際に試し、エラーが減る組み合わせを並べる。
 * 押すまで表は変わらない（最後に決めるのは人）。
 */
// 「この通りに直す」の手を、表（または写し）に1手ずつ入れる（C2）。各手の前に、2つのマスが案のままかを確かめ、
// 違えば入れずに false を返す。空のマスは '' にそろえて比べ、入れ替えたあとも空のマスはマスを消して持つ。
function _fixStepsApply(table, steps) {
  const norm = (v) => v || '';
  for (const m of steps) {
    const ra = table[m.aId], rb = table[m.bId];
    if (!ra || !rb || norm(ra[m.day]) !== norm(m.aVal) || norm(rb[m.day]) !== norm(m.bVal)) return false;
    const t = ra[m.day], u = rb[m.day];
    if (u === undefined) delete ra[m.day]; else ra[m.day] = u;
    if (t === undefined) delete rb[m.day]; else rb[m.day] = t;
  }
  return true;
}
// 「この通りに直す」で反映した直後の知らせ（C2）。その表のままなら、箱を描き直しても先頭に出す
let _fixPlanNote = null;

function renderFixPlans(root) {
  const scope = root || document;
  const box = scope.querySelector('#fixPlanBox');
  if (!box || typeof findConcreteFixes !== 'function') return;
  if (!AppState.generated || !AppState.shifts) return;
  const note = (_fixPlanNote && typeof contentFingerprint === 'function' && _fixPlanNote.fp === contentFingerprint())
    ? `<div class="diag-item" style="background:var(--ok-bg);border-left:4px solid var(--ok);margin-bottom:8px">
        <div class="diag-title" style="color:var(--ok)">${uiIcon('ok')} 直しました（エラー ${_fixPlanNote.n}件）</div>
        <div class="diag-detail" style="color:var(--text)">「元に戻す」で取り消せます。続けて探すこともできます。</div></div>` : '';
  if (!note) _fixPlanNote = null;
  const now = (typeof checkViolations === 'function') ? checkViolations(AppState.shifts).length : 0;
  if (!now) { box.innerHTML = note; return; }

  box.innerHTML = note + `<div class="diag-item" style="background:var(--accent-soft);border-left:4px solid var(--link);margin-bottom:8px">
      <div class="diag-title" style="color:var(--link)">具体的な直し方を探す</div>
      <div class="diag-detail" style="color:var(--text)">
        いまの表のまま、<b>同じ日の2人を入れ替える</b>だけでエラーが減る組み合わせを探します。
        その日の人数は変わらないので、必要人数は崩れません。希望・固定のマスは動かしません。<br>
        <b>「絶対」の違反（連勤超過など、必ず直すエラー）が増える案は出しません。</b>
      </div>
      <div style="margin-top:8px"><button id="fixPlanGo" class="btn btn-primary">探す（数秒）</button></div>
    </div>`;

  const $go = box.querySelector('#fixPlanGo');
  if (!$go) return;
  $go.addEventListener('click', () => {
    $go.disabled = true; $go.textContent = '探しています…';
    // 画面を描き替えてから計算する（ボタンの表示が変わらないのを防ぐ）
    setTimeout(() => {
      let plans = [];
      try { plans = findConcreteFixes({ deep: true, maxResults: 6 }) || []; }
      catch (e) { plans = []; }
      // A9: 案を作ったときの表。押したときに今の表と同じかを確かめる
      const fp0 = (typeof contentFingerprint === 'function') ? contentFingerprint() : null;
      if (!plans.length) {
        box.innerHTML = `<div class="diag-item" style="background:var(--lv-soft-bg);border-left:4px dashed var(--lv-soft);margin-bottom:8px">
          <div class="diag-title" style="color:var(--lv-soft)">入れ替えでは減らせません</div>
          <div class="diag-detail" style="color:var(--text)">
            2人の入れ替えを全部試しましたが、エラーが減る組み合わせはありませんでした。
            残っているエラーは、希望や必要人数を変えないと減らせません。
            <b>生成前チェック</b>に「避けられない」と出ていないかご確認ください。
          </div></div>`;
        return;
      }
      // 「A ⇄ B」では、どのマスが何に変わるのか分からないという声があったため、
      // 1人1行で「いまの中身 → 変えたあとの中身」を書く。クリックで表の該当マスへ飛ぶ。
      const cell = (name, sid, day, from, to) =>
        `<div class="violation-item is-jumpable" data-jump-sid="${escapeHtml(sid)}" data-jump-day="${day}"
              title="クリックするとシフト表のこのマスを表示します"
              style="display:flex;gap:8px;align-items:center;padding:3px 6px;border-radius:6px;cursor:pointer">
           <span style="min-width:4.5em">${day}日</span>
           <b style="min-width:6em">${escapeHtml(name)}</b>
           <span style="opacity:.7">${escapeHtml(from ? shiftSym(from) : '—')}</span>
           <span>→</span>
           <b style="color:var(--link)">${escapeHtml(to ? shiftSym(to) : '—')}</b>
         </div>`;
      const line = (m) => cell(m.aName, m.aId, m.day, m.aVal, m.bVal)
                        + cell(m.bName, m.bId, m.day, m.bVal, m.aVal);
      box.innerHTML = `<div class="diag-item" style="background:var(--ok-bg);border-left:4px solid var(--ok);margin-bottom:8px">
          <div class="diag-title" style="color:var(--ok)">この通りに直すとエラーが減ります（${plans.length}案）</div>
          <div class="diag-detail" style="color:var(--text)">
            押すまで表は変わりません。押したあとは「元に戻す」で取り消せます。
          </div>
          ${plans.map((p, i) => `<div style="margin-top:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">
            <div style="font-weight:700">${i === 0 ? '<span class="tag-reco">おすすめ</span> ' : ''}${escapeHtml(_diffWords(_scoreDiff(p._base, p._sc)))}</div>
            <div class="hint">${escapeHtml(scoreSummaryText(p._base))} → ${escapeHtml(scoreSummaryText(p._sc))}（どの「絶対」の違反も増えません）</div>
            <div style="margin:4px 0 6px">${p.steps.map((m, j) =>
              (p.steps.length > 1 ? `<div class="hint" style="margin-top:4px">${j + 1}つ目</div>` : '') + line(m)).join('')}</div>
            <div class="hint" style="margin-bottom:6px">${p.steps.length > 1 ? '上の2組を順に入れ替えます' : 'この2つを入れ替えるだけです'}。その日の人数は変わりません。</div>
            <button class="btn ${i === 0 ? 'btn-primary' : ''}" data-fixplan="${i}">この通りに直す</button>
          </div>`).join('')}
        </div>`;
      box.querySelectorAll('[data-fixplan]').forEach(btn => btn.addEventListener('click', () => {
        const p = plans[parseInt(btn.dataset.fixplan)];
        if (!p) return;
        if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
        // A9: 1つ反映したあとの残りの案・取り込みや月の切り替えのあとの古い案で、表を壊していた。
        // 表が案を作ったときと同じで、マスがまだ案のままで、入れ替えると改善するときだけ入れる。
        // C2: 写しに1手ずつ入れながら確かめる（2手目は1手目を入れたあとの表と比べる）。空のマスは '' にそろえて比べる
        const cur = AppState.shifts || {};
        const sameFp = fp0 === null || (typeof contentFingerprint === 'function' && contentFingerprint() === fp0);
        const trial = JSON.parse(JSON.stringify(cur));
        const cellsOk = _fixStepsApply(trial, p.steps);
        let better = false;
        if (sameFp && cellsOk) {
          try {
            const bv = checkViolations(cur), av = checkViolations(trial);
            better = scoreBetter(scoreViolations(av), scoreViolations(bv)) && !compWorsened(bv, av).length;
          } catch (e) { better = false; }
        }
        if (!sameFp || !cellsOk || !better) {
          box.innerHTML = '';
          renderFixPlans(root);
          // 断る文を理由で分ける（表が同じなのに改善しないときは、表が変わったのではない）
          const changed = !sameFp || !cellsOk;
          box.insertAdjacentHTML('afterbegin', `<div class="diag-item" style="background:var(--lv-must-bg);border-left:4px solid var(--lv-must);margin-bottom:8px">
              <div class="diag-title" style="color:var(--lv-must)">${changed ? '表が変わったので、この案は使えません' : 'いまの表・設定では、この案でエラーが減りません'}</div>
              <div class="diag-detail" style="color:var(--text)">表は変えていません。もう一度探してください。</div></div>`);
          return;
        }
        if (typeof recordShiftHistory === 'function') recordShiftHistory();
        const beforeFix = JSON.parse(JSON.stringify(AppState.shifts));
        _fixStepsApply(AppState.shifts, p.steps);
        if (typeof noteEdits === 'function') noteEdits('修正案', beforeFix);
        AppState.violations = checkViolations(AppState.shifts);
        // 反映したことを、描き直した箱の先頭に出す（表が変わるまで、レポートを描き直しても残す）
        _fixPlanNote = { fp: (typeof contentFingerprint === 'function') ? contentFingerprint() : '', n: AppState.violations.length };
        if (typeof autoSave === 'function') autoSave();
        if (typeof refreshAllUI === 'function') refreshAllUI();
        if (typeof toast === 'function') toast(`直しました（エラー ${AppState.violations.length}件）`, 'success');
        renderFixPlans(root);   // 残りの案は古いので消して「探す」に戻す
      }));
    }, 30);
  });
}

// 違反の重要度分類。🔴絶対NG（MUST）= 現場で致命的なもの。それ以外は🟡注意。
// 単発出勤(single-work)はユーザー要望により絶対NGに含める。
const MUST_VIOLATION_TYPES = new Set([
  'understaff', 'skill-late', 'consecutive', 'resp-duplicate', 'hierarchy',
  'vicemanager-absent', 'single-work', 'pref-mismatch', 'role-mismatch',
  'event-absent', 'night-after-work',
  'off-count', 'late-early', // 公休不足・遅→早(休みなし) も絶対NG
  'day-skill',               // 日ごとに要るスキル（v264）
]);
// ルール強弱設定があればそれに従う（optimizer.js の getRuleLevel）。無ければ既定分類。
function isMustViolation(type) {
  if (typeof getRuleLevel === 'function') return getRuleLevel(type) === 'must';
  return MUST_VIOLATION_TYPES.has(type);
}

// ⑥ 結果パネル
function setupResultPanel() {
  document.getElementById('btnExportExcel').addEventListener('click', exportToExcel);
  document.getElementById('btnExportCSV').addEventListener('click', exportToCSV);
  document.getElementById('btnRecheck').addEventListener('click', () => {
    if (!AppState.generated) {
      toast('シフトを生成してから実行してください', 'error');
      return;
    }
    AppState.violations = checkViolations(AppState.shifts);
    renderResultTable();
    const result = { success: AppState.violations.length === 0, score: AppState.violations.length, violations: AppState.violations };
    document.getElementById('reportCard').style.display = 'block';
    renderReport(result);
    toast(`ルールチェック完了: ${AppState.violations.length}件の違反`, 'info');
  });

  // 📅 途中から作り直す: 指定日より前を固定して、その日以降だけ再生成
  const btnPartial = document.getElementById('btnPartialRegen');
  if (btnPartial) btnPartial.addEventListener('click', () => {
    if (typeof showPartialRegenModal === 'function') showPartialRegenModal();
  });

  // 🔒 まとめて固定: ドラッグで範囲を選び、固定／解除をまとめて行う
  const btnRange = document.getElementById('btnRangeLock');
  if (btnRange) btnRange.addEventListener('click', () => {
    if (!AppState.generated) { toast('シフトを生成してから実行してください', 'error'); return; }
    RangeLock.toggle();
  });

  // v269: いまの表に、総務の順番の入れ替えをかける（元に戻す・やり直すで戻せる。変えたマスの記録に「総務の順番」で残す）
  const btnSomu = document.getElementById('btnSomuReorder');
  if (btnSomu) btnSomu.addEventListener('click', () => {
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    if (!AppState.generated || !Object.keys(AppState.shifts || {}).length) { toast('シフトを生成してから実行してください', 'error'); return; }
    const r = somuReorder(AppState.shifts);
    if (!r.swaps.length) {
      toast('総務の順番で入れ替えられる所はありませんでした（すでに順番どおりか、入れ替えるとエラーが増えるか、希望・固定で決まっています）', 'info', 7000);
      return;
    }
    const before = JSON.parse(JSON.stringify(AppState.shifts));
    if (typeof recordShiftHistory === 'function') recordShiftHistory();
    AppState.shifts = r.shifts;
    AppState.violations = r.violations;
    if (typeof noteEdits === 'function') noteEdits('総務の順番', before);
    renderResultTable();
    saveToStorage();
    toast(`総務の順番で ${r.swaps.length}か所 入れ替えました（エラーは増えていません。「元に戻す」で戻せます）`, 'success', 7000);
  });

  document.getElementById('btnClearFixed').addEventListener('click', () => {
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    let count = 0;
    for (const sid in AppState.fixedShifts) {
      count += Object.keys(AppState.fixedShifts[sid] || {}).length;
    }
    if (count === 0) {
      toast('固定されているシフトはありません', 'info');
      return;
    }
    if (!confirm(`固定されている ${count}件 のシフトをすべて解除しますか？\n※シフトの内容はそのまま残り、再生成で動かせるようになります。`)) return;
    AppState.fixedShifts = {};
    // 「途中から作り直す」の確定済み扱いも一緒に解除する（固定が無いのに隠れ続けるのを防ぐ）
    AppState.settings.ignoreVioBeforeDay = 0;
    AppState.violations = checkViolations(AppState.shifts);
    renderResultTable();
    saveToStorage();
    toast(`${count}件 の固定を解除しました`, 'success');
  });

  // 🛠 エラー自動修正（悪化させない安全装置つき）
  const btnRepair = document.getElementById('btnRepair');
  if (btnRepair) {
    btnRepair.addEventListener('click', async () => {
      if (!AppState.generated) {
        toast('シフトを生成してから実行してください', 'error');
        return;
      }
      AppState.violations = checkViolations(AppState.shifts);
      if (AppState.violations.length === 0) {
        toast('エラーはありません', 'success');
        return;
      }

      if (!calcBegin('エラーの自動修正')) return;
      // 答えの案を、早く出せるもの（変えるマスが少ないもの）から順に計算して並べ、利用者が選んで反映する。
      // 計算はすべて試し計算（noApply）で、選ぶまで本物の表と保存データは書き換えない。
      // 以前は、ひと月を一から解き直した答えをそのまま反映していたため、🚨3件を直すのに
      // 131マスが変わり、早番と遅番の行き来が 9→16 に増えることがあった。
      const baseShifts = JSON.parse(JSON.stringify(AppState.shifts));
      const fp0 = (typeof contentFingerprint === 'function') ? contentFingerprint() : '';
      const beforeV = AppState.violations.slice();
      const beforeSc = scoreViolations(beforeV);
      const SPECS = [
        { label: '少しだけ直す（10マスまで）', k: 10 },
        { label: 'ほどほどに直す（25マスまで）', k: 25 },
        { label: 'しっかり直す（50マスまで）', k: 50 },
        { label: '全部直す（表を作り直す・行き来が減ることが多い・最大10分）', k: 0 },
      ];
      const cands = [], skipped = [];
      let skippedUp = false;   // 外した案が全部「何かが増える」ためか（🔒の解除をすすめない）
      let skippedUpN = 0, skippedOtherN = 0;
      let stopped = false, running = true, failed = 0, tried = 0;   // failed: 計算に失敗した段の数、tried: 計算した段の数
      const modal = document.createElement('div');
      modal.className = 'modal-overlay show';
      modal.style.zIndex = 10050;
      modal.innerHTML = `<div class="modal-content" style="max-width:980px;width:calc(100vw - 32px)">
          <div class="modal-header"><h3 style="margin:0">自動修正の案（${escapeHtml(scoreSummaryText(beforeSc))}）</h3><button class="modal-close" id="rcClose">✕</button></div>
          <div class="modal-body">
            <div class="hint" style="margin-bottom:8px">変えるマスが少ない案から順に計算して並べます。どれも、選ぶまで表は変わりません。
              「絶対」の違反がどの種類も増えない案だけを出します。変えるマスは、休み↔余の書き替えを除いた数です。</div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><thead>${candHead()}</thead><tbody id="rcRows"></tbody></table></div>
            <div id="rcStatus" style="margin-top:8px"></div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" id="rcStop" style="background:var(--surface);color:var(--lv-crit);border-color:var(--lv-crit)">${uiIcon('stop')}中止（出ている案は選べます）</button>
              <button class="btn" id="rcCancel">反映しないで閉じる</button>
            </div>
          </div></div>`;
      document.body.appendChild(modal);
      const $rows = modal.querySelector('#rcRows'), $st = modal.querySelector('#rcStatus');
      const stop = () => { if (!running) return; stopped = true; if (typeof cancelMILP === 'function') cancelMILP(); };
      const close = () => { stop(); modal.remove(); };
      modal.querySelector('#rcStop').addEventListener('click', stop);
      modal.querySelector('#rcCancel').addEventListener('click', close);
      modal.querySelector('#rcClose').addEventListener('click', close);
      const redraw = () => {
        $rows.innerHTML = cands.map((c, i) => candRowHtml(c.label, c.st, c.sec,
          `<button class="btn btn-primary" data-rcgo="${i}" ${running ? 'disabled title="計算中です。中止するか、終わるのを待ってから選んでください"' : ''}>反映</button>`)).join('')
          || (running ? '' : `<tr><td colspan="${CAND_COLS()}" class="hint" style="padding:8px">${stopped ? '中止しました。' : (failed && !cands.length && failed === tried) ? '計算に失敗しました。もう一度試してください。' : `良くなる案は見つかりませんでした。${failed ? '計算に失敗した段があります（下のとおり）。' : ''}${
                (skippedUp && !failed) ? '下の理由のとおり、どの案も何かが増えるため出していません。' : failed ? '' : '関係する固定を解除すると直せる場合があります。'}`}</td></tr>`);
        $rows.innerHTML += skipped.map(t => `<tr><td colspan="${CAND_COLS()}" class="hint" style="padding:4px 8px;border-top:1px dashed var(--border)">${escapeHtml(t)}</td></tr>`).join('');
        $rows.querySelectorAll('[data-rcgo]').forEach(b => b.addEventListener('click', () => applyCand(cands[+b.dataset.rcgo])));
      };
      const applyCand = (c) => {
        if (!c || running) return;
        if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
        // 案を作ったあとに表などが変わっていたら、古い案のまま反映しない
        if (fp0 && typeof contentFingerprint === 'function' && contentFingerprint() !== fp0) {
          toast('表が変わったため、この案は使えません。もう一度「エラーを自動修正」を押してください', 'error', 6000); return;
        }
        if (typeof recordShiftHistory === 'function') recordShiftHistory();   // 気に入らなければ ↩ で戻せる
        AppState.shifts = JSON.parse(JSON.stringify(c.shifts));
        AppState.violations = checkViolations(AppState.shifts);
        if (typeof noteEdits === 'function') noteEdits('自動修正', baseShifts);   // 手直しとは分けて数える
        renderResultTable();
        document.getElementById('reportCard').style.display = 'block';
        renderReport({ success: AppState.violations.length === 0, score: AppState.violations.length, violations: AppState.violations });
        saveToStorage();
        toast(`「${c.label}」を反映しました（${scoreSummaryText(beforeSc)} → ${scoreSummaryText(c.st.a)}・${c.st.cells.length}マス）`, 'success', 6000);
        modal.remove();
      };
      const $stop2 = document.getElementById('btnCancelRepair');
      if ($stop2) { $stop2.style.display = 'inline-block'; $stop2.onclick = stop; }
      btnRepair.disabled = true;
      try {
        let reached0 = false; failed = 0; tried = 0;
        // 最初から🚨も⛔も0件なら、マスの上限の案（🚨を直すための案）は計算せず「全部直す」だけにする
        const noMust0 = beforeSc.must === 0 && beforeSc.comp === 0;
        for (const sp of SPECS) {
          if (stopped || !modal.isConnected) break;
          if ((reached0 || noMust0) && sp.k) continue;
          const t0 = Date.now(); tried++;
          $st.innerHTML = `<span class="hint">「${escapeHtml(sp.label)}」を計算しています…</span>`;
          let r;
          try {
            r = await optimizeScheduleMILP((pct, msg) => {
              const sec = Math.round((Date.now() - t0) / 1000);
              $st.innerHTML = `<span class="hint">「${escapeHtml(sp.label)}」を計算しています…（${sec}秒）</span>`;
            }, sp.k ? { adjustMode: true, adjustK: sp.k, fastMode: true, noApply: true }
                    : { improveOver: beforeSc, noApply: true });
          } catch (e) {
            if (/^cancel/.test(e.message || '') || stopped) break;
            failed++;
            skipped.push(`${sp.label}: 計算に失敗しました（${escapeHtml(e.message || '')}）`); redraw();
            continue;
          }
          const sec = Math.round((Date.now() - t0) / 1000);
          // v269: 「全部直す」は表を作り直すので、生成と同じく総務の順番に入れ替えてから比べる（①の設定が「入」のとき）
          if (!sp.k && AppState.settings.somuAutoSwap !== false && typeof somuReorder === 'function') {
            const sw = somuReorder(r._shifts || r.shifts);
            if (sw.swaps.length) { r._shifts = sw.shifts; r.violations = sw.violations; }
          }
          const st = candStats(baseShifts, r._shifts || r.shifts, beforeV, r.violations);
          // 🚨がどの種類も増えず、⛔ も悪くならず、🚨・⛔・連勤の超過日数・公休の足りない日数・切り替えの超過回数
          // （「絶対」のときだけ数える）のどれかが減った案だけを出す
          // 連勤の超過日数・公休の足りない日数だけが減る案も出す（件数が同じでも日数が減れば改善）
          // 「全部直す」は決まり（scoreBetter）で改善なら出す（🟡だけが減る月も。以前の本番も、作り直した表が
          // 良ければ反映していた）。マスの上限の案は、🚨・⛔・日数・回数のどれかが減るときだけ出す。
          const ok = !st.compUp && scoreBetter(st.a, beforeSc) && (!sp.k || st.a.must < beforeSc.must || st.a.comp < beforeSc.comp ||
                     st.a.over < beforeSc.over || (st.a.offShort || 0) < (beforeSc.offShort || 0) ||
                     (st.a.bsOver || 0) < (beforeSc.bsOver || 0));
          // 前の案より🚨が減っていない案は出さない（同じ直り方で、変えるマスが多いだけ）。
          // ただし「全部直す」は並べたままにする（表を作り直すので行き来が減ることが多く、
          // 行き来を減らしたい月はこれを選べるようにする。利用者の希望）。
          const dup = sp.k && cands.some(c => scoreCompare(st.a, c.st.a) >= 0);
          if (ok && !dup) { cands.push({ label: sp.label, st, sec, shifts: r._shifts || r.shifts }); redraw(); }
          else {
            // 外した理由は、増えたもの（公休の不足 1→2日 など）を書く
            const upL = scoreWorsened(st.a, beforeSc).filter(x => x.key !== 'soft');
            const lab = (k) => k === 'comp' ? '6連勤以上' : k === 'over' ? '連勤の超過日数' : k === 'bsOver' ? '切り替えの超過回数'
              : ((typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[k]) || k);
            const unit = (k) => (k === 'over' || k === 'offShort') ? '日' : k === 'bsOver' ? '回' : '件';
            const why = ok ? '前の案より「絶対」の違反が減らないため出しません（変えるマスが増えるだけ）'
              : st.compUp ? '6連勤以上ができる・伸びる・つながるため出しません'
              : upL.length ? upL.map(x => `${lab(x.key)}が ${x.from}→${x.to}${unit(x.key)} に増える`).join('・') + 'ため出しません'
              : sp.k ? '「絶対」の違反・連勤の超過・公休の不足のどれも減らないため出しません'
              : '作り直した表が、いまの表より良くならないため出しません';
            if (!ok && (st.compUp || upL.length)) skippedUpN++; else skippedOtherN++;
            skippedUp = skippedUpN > 0 && skippedOtherN === 0;
            skipped.push(`${sp.label}（${sec}秒）: ${why}`); redraw();
          }
          // 🚨が0件になったら、残りのマスの上限の案は計算しない（「全部直す」だけは計算する）
          if (st.a.must === 0 && st.a.comp === 0 && ok) reached0 = true;
        }
      } finally {
        running = false;
        calcEnd();
        if ($stop2) $stop2.style.display = 'none';
        btnRepair.disabled = false;
        if (modal.isConnected) {
          modal.querySelector('#rcStop').style.display = 'none';
          // 案が無いときは「選べます」「選んでください」を出さない（中止・失敗・見つからないは表の中に書く）
          $st.innerHTML = !cands.length ? ''
            : stopped ? '<span class="hint">中止しました。出ている案から選べます。</span>'
            : '<span class="hint">計算が終わりました。反映する案を選んでください。</span>';
          redraw();
        }
      }
    });
  }

  // ⚖️ 余の解消
  const btnResolve = document.getElementById('btnResolveSurplus');
  if (btnResolve) btnResolve.addEventListener('click', () => {
    if (!AppState.generated) { toast('シフトを生成してから実行してください', 'error'); return; }
    showSurplusResolveModal();
  });



  // ↩ 元に戻す / ↪ やり直す
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  if (btnUndo) btnUndo.addEventListener('click', () => { if (typeof undoShiftEdit === 'function') undoShiftEdit(); });
  if (btnRedo) btnRedo.addEventListener('click', () => { if (typeof redoShiftEdit === 'function') redoShiftEdit(); });

  // キーボードショートカット（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return; // 入力欄では既定動作を尊重
    const resultPanel = document.getElementById('panel-result');
    if (!resultPanel || !resultPanel.classList.contains('active')) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (typeof undoShiftEdit === 'function') undoShiftEdit();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' ||
               (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      if (typeof redoShiftEdit === 'function') redoShiftEdit();
    }
  });
}

// Excel エクスポート
function exportToExcel() {
  if (!AppState.generated) {
    toast('シフトを生成してから実行してください', 'error');
    return;
  }
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const data = [];
  const keyAt = {};   // 「行,列」→ そのマスの key（色を key で決める。v258: マスには表示用の記号を書くため）
  const groups = getDepartmentGroups();
  const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);

  // ヘッダー
  const header = ['名前'];
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    header.push(`${d}(${getWeekdayLabel(w)})`);
  }
  header.push('公休', '有給他', '余剰', '出勤日数', '差', '総労働時間');
  data.push(header);

  groups.forEach(g => {
    if (groups.length > 1) data.push([`【${g.label}】`]);

    // 各スタッフ
    g.staff.forEach(s => {
      const row = [s.name];
      let work = 0, publicOff = 0, otherOff = 0, surplus = 0, hours = 0;
      for (let d = 1; d <= days; d++) {
        const sh = (AppState.shifts[s.id] || {})[d] || '';
        row.push(shiftSym(sh));
        keyAt[data.length + ',' + d] = sh;
        if (isWork(sh)) { work++; hours += getShiftHours(sh); }
        else if (isPublicOff(sh)) publicOff++;
        else if (sh === '余') surplus++;
        else if (isOff(sh)) otherOff++;
      }
      const diff = publicOff - (s.maxOff || 0);
      row.push(publicOff, otherOff, surplus, work, diff, Math.round(hours * 10) / 10);
      data.push(row);
    });

    // 集計行（部門の必要人数 > 0 のシフト種別）
    workKeys.forEach(key => {
      const req = g.reqs[key] || 0;
      if (req === 0) return;
      const row = [`${shiftSym(key)}(${req})`];
      for (let d = 1; d <= days; d++) {
        let count = 0;
        g.staff.forEach(s => {
          if ((AppState.shifts[s.id] || {})[d] === key) count++;
        });
        row.push(count);
      }
      data.push(row);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(data);

  // 列幅設定
  const colWidths = [{ wch: 16 }];
  // 日の列は6文字分。表示用の記号（v258）が長いときは、いちばん長い記号に合わせて広げる（全角は2文字分）。
  // 記号を変えていなければ、いちばん長い「遅総務」でも6なので、前の版と同じ幅
  const symW = Math.max(0, ...AppState.shiftTypes.map(t => Array.from(shiftSymOf(t)).reduce((a, ch) => a + (/[\u0000-\u00ff\uff61-\uff9f]/.test(ch) ? 1 : 2), 0)));
  const dayW = Math.max(6, symW);
  for (let d = 1; d <= days; d++) colWidths.push({ wch: dayW });
  colWidths.push({ wch: 6 }, { wch: 7 }, { wch: 6 }, { wch: 9 }, { wch: 5 }, { wch: 11 });
  ws['!cols'] = colWidths;

  // セル色を設定（動的 shiftTypes + 固定 off 系）
  const colorMap = {};
  AppState.shiftTypes.forEach(t => {
    // Excelの色形式: RRGGBB (# を除く6桁)
    colorMap[t.key] = safeColor(t.color, '#e2e8f0').replace('#', '').toUpperCase().padStart(6, '0');
  });
  // 固定の休み系
  Object.assign(colorMap, {
    '休': 'EEEEEE', '公': 'F5F5F5', '有': 'FFF9C4', '半': 'E8F5E9', '余': 'FFE0B2',
    '☆': 'EEEEEE', '季': 'EEEEEE', '引': 'EEEEEE', '慶': 'EEEEEE',
  });

  for (let r = 1; r < data.length; r++) {
    for (let c = 1; c <= days; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellAddr];
      const k = keyAt[r + ',' + c];
      if (cell && k != null && colorMap[k]) {
        cell.s = { fill: { patternType: 'solid', fgColor: { rgb: colorMap[k] } } };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'シフト表');

  // 集計シート（動的・部門順）
  const summaryHeader = ['部門', 'スタッフ', ...AppState.shiftTypes.map(t => shiftSymOf(t)), '公休', '有給他', '余剰', '出勤日数', '差', '総労働時間'];
  const summary = [summaryHeader];
  groups.forEach(g => {
    g.staff.forEach(s => {
      const counts = {};
      AppState.shiftTypes.forEach(t => { counts[t.key] = 0; });
      let publicOff = 0, otherOff = 0, surplus = 0, workCount = 0, hours = 0;
      for (let d = 1; d <= days; d++) {
        const sh = (AppState.shifts[s.id] || {})[d] || '';
        if (counts[sh] !== undefined) { counts[sh]++; workCount++; hours += getShiftHours(sh); }
        else if (isPublicOff(sh)) publicOff++;
        else if (sh === '余') surplus++;
        else if (isOff(sh)) otherOff++;
      }
      summary.push([g.label, s.name, ...AppState.shiftTypes.map(t => counts[t.key]),
        publicOff, otherOff, surplus, workCount, publicOff - (s.maxOff || 0), Math.round(hours * 10) / 10]);
    });
  });
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  XLSX.utils.book_append_sheet(wb, ws2, '集計');

  const filename = `シフト表_${AppState.settings.targetMonth}.xlsx`;
  XLSX.writeFile(wb, filename);
  toast(`${filename} をダウンロードしました`, 'success');
}

// CSV エクスポート
function exportToCSV() {
  if (!AppState.generated) {
    toast('シフトを生成してから実行してください', 'error');
    return;
  }
  const days = getDaysInMonth(AppState.settings.targetMonth);
  let csv = '';

  const header = ['部門', '名前'];
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    header.push(`${d}(${getWeekdayLabel(w)})`);
  }
  header.push('公休', '有給他', '余剰', '出勤日数', '差', '総労働時間');
  csv += header.map(escapeCSV).join(',') + '\n';

  getDepartmentGroups().forEach(g => {
    g.staff.forEach(s => {
      const row = [g.label, s.name];
      let work = 0, publicOff = 0, otherOff = 0, surplus = 0, hours = 0;
      for (let d = 1; d <= days; d++) {
        const sh = (AppState.shifts[s.id] || {})[d] || '';
        row.push(shiftSym(sh));   // 表示用の記号（v258）
        if (isWork(sh)) { work++; hours += getShiftHours(sh); }
        else if (isPublicOff(sh)) publicOff++;
        else if (sh === '余') surplus++;
        else if (isOff(sh)) otherOff++;
      }
      row.push(publicOff, otherOff, surplus, work, publicOff - (s.maxOff || 0), Math.round(hours * 10) / 10);
      csv += row.map(escapeCSV).join(',') + '\n';
    });
  });

  // BOM付き（Excel で文字化け回避）
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `シフト表_${AppState.settings.targetMonth}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('CSVをダウンロードしました', 'success');
}

function escapeCSV(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
