/* ===========================================
   ui.js - UI描画とイベント管理 (v3 - 動的シフト種別対応)
   =========================================== */

// ===== トースト表示 =====
// 連勤の上限を6日以上にしたときの警告。6連勤以上はコンプライアンス違反なので、
// 上限を上げても生成・検査では必ず違反として扱う（上限の設定とは関係ない）。
function warnComplianceLimit(v, who) {
  const lim = (typeof COMPLIANCE_CONS_DAYS !== 'undefined') ? COMPLIANCE_CONS_DAYS : 6;
  if (!(parseInt(v) >= lim)) return;
  toast(`⛔ ${who}の連勤上限が${v}日になっています。${lim}連勤以上はコンプライアンス違反です（5連勤まで）。`
      + `上限を${lim}日以上にしても、${lim}連勤以上は違反として表示・回避します。`, 'error', 9000);
}

// 前の知らせの消えるタイマーが、後から出した知らせを途中で消してしまっていた
// （手で直したときの警告が見えなかった原因の1つ）。タイマーは1つだけにする。
let _toastTimer = null;
function toast(message, type = 'info', duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast show ' + type;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = 'toast ' + type; _toastTimer = null; }, duration);
}

// ===== 自動保存（デバウンス付き） =====
let _autoSaveTimer = null;
function autoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    if (typeof saveToStorage === 'function') saveToStorage();
    _autoSaveTimer = null;
  }, 300);
}

// ===== HTML エスケープ =====
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ===== 全UI再構築（ロード後・リセット後など） =====
function refreshAllUI() {
  const $month     = document.getElementById('targetMonth');
  const $maxCons   = document.getElementById('maxConsecutive');
  const $forbidLE  = document.getElementById('forbidLateEarly');
  const $penaltySO = document.getElementById('penaltySingleOff');
  const $maxAtt    = document.getElementById('maxAttempts');
  const $replDays  = document.getElementById('replacementDays');
  const $renwDays  = document.getElementById('renewalDays');
  const $delvDays  = document.getElementById('deliveryDays');

  if ($month)     $month.value       = AppState.settings.targetMonth || '';
  if ($maxCons)   $maxCons.value     = AppState.settings.maxConsecutive;
  if ($forbidLE)  $forbidLE.checked  = AppState.settings.forbidLateEarly;
  if ($penaltySO) $penaltySO.checked = AppState.settings.penaltySingleOff;
  const $tiered0 = document.getElementById('tieredOptimize');
  if ($tiered0) $tiered0.checked = AppState.settings.tieredOptimize !== false;
  const $par0 = document.getElementById('parallelSolve');
  if ($par0) $par0.checked = AppState.settings.parallelSolve !== false;
  if ($maxAtt)    $maxAtt.value      = AppState.settings.maxAttempts;
  const $pairRestR = document.getElementById('pairRestTarget');
  if ($pairRestR) $pairRestR.value   = AppState.settings.pairRestTarget || 0;
  if ($replDays) {
    $replDays.value = Object.keys(AppState.specialDays)
      .filter(d => AppState.specialDays[d] === 'replacement').join(',');
  }
  if ($renwDays) {
    $renwDays.value = Object.keys(AppState.specialDays)
      .filter(d => AppState.specialDays[d] === 'renewal').join(',');
  }
  if ($delvDays) {
    $delvDays.value = Object.keys(AppState.specialDays)
      .filter(d => AppState.specialDays[d] === 'delivery').join(',');
  }
  if (typeof renderReqRules === 'function') renderReqRules();
  if (typeof renderNextStep === 'function') renderNextStep();

  const rp = document.getElementById('ruleLevelsPanel');
  if (rp && rp.style.display !== 'none') renderRuleLevels();

  renderRoleTable();
  renderStaffTable();
  renderShiftChips();
  renderCalendar();
  renderShiftLegend();
  renderResultTable();
  renderEventList();

  const $numCand = document.getElementById('numCandidates');
  if ($numCand) $numCand.value = AppState.settings.numCandidates || 3;
}

// ===== タブ切り替え =====
function setupTabs() {
  // .nav-link（マニュアルなど外部ページへのリンク）はタブ切替の対象外
  document.querySelectorAll('.tab:not(.nav-link)').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + target).classList.add('active');

      if (target === 'roles')    renderRoleTable();
      if (target === 'staff')    renderStaffTable();
      if (target === 'calendar') { renderShiftChips(); renderCalendar(); }
      if (target === 'result')   { renderShiftLegend(); renderResultTable(); }
    });
  });
}

// ===== ① 基本設定 =====
function setupSettingsPanel() {
  const $month     = document.getElementById('targetMonth');
  const $maxCons   = document.getElementById('maxConsecutive');
  const $forbidLE  = document.getElementById('forbidLateEarly');
  const $penaltySO = document.getElementById('penaltySingleOff');
  const $maxAtt    = document.getElementById('maxAttempts');
  const $replDays  = document.getElementById('replacementDays');
  const $renwDays  = document.getElementById('renewalDays');
  const $delvDays  = document.getElementById('deliveryDays');

  // 初期値
  if (!AppState.settings.targetMonth) {
    const now = new Date();
    AppState.settings.targetMonth =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  $month.value       = AppState.settings.targetMonth;
  $maxCons.value     = AppState.settings.maxConsecutive;
  $forbidLE.checked  = AppState.settings.forbidLateEarly;
  $penaltySO.checked = AppState.settings.penaltySingleOff;
  if ($maxAtt) $maxAtt.value = AppState.settings.maxAttempts; // 焼きなまし廃止でUIから削除済み（後方互換で保護）
  const $pairRest = document.getElementById('pairRestTarget');
  if ($pairRest) {
    $pairRest.value = AppState.settings.pairRestTarget || 0;
    $pairRest.addEventListener('change', () => {
      AppState.settings.pairRestTarget = parseInt($pairRest.value) || 0;
      autoSave();
    });
  }

  $replDays.value = Object.keys(AppState.specialDays)
    .filter(d => AppState.specialDays[d] === 'replacement').join(',');
  $renwDays.value = Object.keys(AppState.specialDays)
    .filter(d => AppState.specialDays[d] === 'renewal').join(',');

  // ── 対象年月を変える ─────────────────────────────
  // キーボードで打ち替えると、途中の値（「11」を打つ途中の「1月」など）でも change が来る。
  // その都度確認画面を出すと画面が重なり、下に残った画面の操作で、やめたつもりの片付けが
  // 実行されていた。確認画面は1枚だけにし（開いていれば中身を最新の値に差し替える）、
  // 打ち終わって少し待ったとき・入力欄から離れたときの最後の値だけで判断する。
  const validYM = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); if (!m) return false;
    const y = +m[1], mo = +m[2]; return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12; };
  const nextOf = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); if (!m) return '';
    const y = +m[1], mo = +m[2]; return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
  let monthModal = null, monthTarget = '', monthTimer = null;
  const closeMonthModal = () => { if (monthModal) monthModal.remove(); monthModal = null; monthTarget = ''; };
  const revertMonth = () => { $month.value = AppState.settings.targetMonth || ''; };
  // 月を変える（clean=片付ける, carry=前月末を引き継ぐ）
  const doMonthChange = (newMonth, clean, carry) => {
    const prevMonth = AppState.settings.targetMonth;
    if (calcBusy()) { revertMonth(); calcBusyToast(); return; }
    // 引き継ぎ → 片付け の順。片付けたあとでは前の月の表が読めない。
    const info = carry ? calcPrevMonthEndFromShifts(AppState.shifts, getDaysInMonth(prevMonth)) : null;
    AppState.settings.targetMonth = newMonth;
    // 月が変わったら「◯日以前は確定済み」の扱いは意味を失うので解除する
    AppState.settings.ignoreVioBeforeDay = 0;
    if (info) { applyPrevMonthEnd(info); renderStaffTable(); }
    if (clean) {
      // 片付けるのは、日付に結びついたものだけ。スタッフ・設定・ルールの強弱・
      // 必要人数のルールは、次の月もそのまま使うので残す。
      AppState.shifts = {}; AppState.requests = {}; AppState.fixedShifts = {};
      AppState.specialDays = {}; AppState.events = [];
      AppState.dailyRequirements = {}; AppState.dailyRequirementsCast = {};
      // 日ごとのスキル指定も日付つきなので片付ける。スキルの種類と目標人数（skills）は残す。
      const ds = {}; Object.keys(AppState.dailySkills || {}).forEach(k => { ds[k] = {}; }); AppState.dailySkills = ds;
      AppState.violations = []; AppState.generated = false;
      if (typeof resetShiftHistory === 'function') resetShiftHistory();   // 前の月の表へ戻せないように
    }
    refreshAllUI();
    autoSave();
    toast(`${newMonth} に切り替えました` + (clean ? '（前の月の表・希望・固定などを片付けました）' : '') +
          (info ? '。前月末の連勤日数・シフトを引き継ぎました' : ''), 'success', 5000);
  };
  const decideMonth = () => {
    clearTimeout(monthTimer); monthTimer = null;
    const prevMonth = AppState.settings.targetMonth;
    const newMonth = $month.value;
    if (newMonth === prevMonth) { closeMonthModal(); return; }
    // ありえない年月（打っている途中の 0002年 など）では聞かない。入力欄を離れたら元に戻す。
    if (!validYM(newMonth)) { closeMonthModal(); if (document.activeElement !== $month) revertMonth(); return; }
    // 計算中は月を変えない（終わった答えが新しい月の表に入って保存されてしまう）
    if (calcBusy()) { closeMonthModal(); revertMonth(); calcBusyToast(); return; }
    if (monthModal && monthTarget === newMonth) return;   // 同じ値で開いている（ボタンを押す途中など）
    const cnt = (o) => Object.values(o || {}).reduce((a, r) => a + Object.keys(r || {}).length, 0);
    const has = { 表: cnt(AppState.shifts), 希望休: cnt(AppState.requests), '🔒固定': cnt(AppState.fixedShifts),
                  特別日: Object.keys(AppState.specialDays || {}).length, 行事: (AppState.events || []).length,
                  日ごとの必要人数: cnt(AppState.dailyRequirements) + cnt(AppState.dailyRequirementsCast),
                  日ごとのスキル指定: cnt(AppState.dailySkills) };
    const list = Object.keys(has).filter(k => has[k] > 0);
    // 前の月の日付つきデータが無ければ、聞かずにそのまま変える
    if (!list.length) { closeMonthModal(); doMonthChange(newMonth, false, false); return; }
    // ちょうど翌月に進めたときだけ、前月末（連勤日数・最後のシフト）を引き継げる。
    const canCarry = !!prevMonth && newMonth === nextOf(prevMonth) && AppState.generated;
    if (!monthModal) {
      monthModal = document.createElement('div');
      monthModal.className = 'modal-overlay';
      monthModal.style.zIndex = 10050;
      document.body.appendChild(monthModal);
    }
    monthTarget = newMonth;
    monthModal.innerHTML = `
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header"><h3 style="margin:0">📅 ${escapeHtml(newMonth)} に切り替えます</h3></div>
        <div class="modal-body" style="line-height:1.8">
          <p>${escapeHtml(prevMonth || '前の月')} の次のデータが残っています。そのまま残すと、
             <b>同じ日付のまま ${escapeHtml(newMonth)} の生成に使われてしまいます</b>。</p>
          <p style="margin:6px 0 10px">${list.map(k => `・${k}（${has[k]}件）`).join('<br>')}</p>
          <p class="hint">片付けるのは上のものだけです。スタッフ・設定・ルールの強弱・必要人数のルール・スキルの種類と目標人数はそのまま残ります。</p>
          ${canCarry ? `<label style="display:block;margin-top:8px"><input type="checkbox" id="mcCarry" checked>
             ${escapeHtml(prevMonth)} の表から「前月末の連勤日数・最後のシフト」を引き継ぐ（片付ける前に読み取ります）</label>` : ''}
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn" id="mcCancel">やめる（月も変えない）</button>
          <button class="btn" id="mcExport">📤 先に書き出してから片付ける</button>
          <button class="btn btn-primary" id="mcClean">片付けて切り替える</button>
        </div>
      </div>`;
    const m = monthModal;
    const carry = () => { const c = m.querySelector('#mcCarry'); return !!(c && c.checked); };
    m.querySelector('#mcCancel').addEventListener('click', () => { closeMonthModal(); revertMonth(); });
    m.querySelector('#mcExport').addEventListener('click', async (ev) => {
      // 書き出しは、月を変える前（前の月の名前・中身のまま）に行う。
      // 保存できたと分からないとき（失敗・取り消し）は片付けない（画面は開いたまま）。
      const t = monthTarget, c = carry(), btn = ev.currentTarget;
      btn.disabled = true;
      const ok = (typeof exportAppDataSure === 'function') && await exportAppDataSure();
      if (!m.isConnected || monthTarget !== t) return;   // 待っている間に閉じられた・変えられた
      btn.disabled = false;
      if (!ok) { toast('書き出しができていないので、片付けずに止めました。「やめる」か、もう一度お試しください', 'error', 8000); return; }
      closeMonthModal(); doMonthChange(t, true, c);
    });
    m.querySelector('#mcClean').addEventListener('click', () => {
      const t = monthTarget, c = carry(); closeMonthModal(); doMonthChange(t, true, c);
    });
  };
  $month.addEventListener('change', () => {
    // 計算中は、打った時点で元に戻して知らせる
    if (calcBusy() && $month.value !== AppState.settings.targetMonth) { revertMonth(); calcBusyToast(); return; }
    clearTimeout(monthTimer);
    monthTimer = setTimeout(decideMonth, 800);   // 打ち終わるのを少し待つ
  });
  $month.addEventListener('blur', () => decideMonth());
  $maxCons.addEventListener('change', () => {
    AppState.settings.maxConsecutive = parseInt($maxCons.value) || 4;
    warnComplianceLimit(AppState.settings.maxConsecutive, '全体');
    autoSave();
  });
  $forbidLE.addEventListener('change', () => {
    AppState.settings.forbidLateEarly = $forbidLE.checked;
    autoSave();
  });
  $penaltySO.addEventListener('change', () => {
    AppState.settings.penaltySingleOff = $penaltySO.checked;
    autoSave();
  });
  const $par = document.getElementById('parallelSolve');
  if ($par) {
    $par.checked = AppState.settings.parallelSolve !== false;
    $par.addEventListener('change', () => {
      AppState.settings.parallelSolve = $par.checked;
      autoSave();
    });
  }
  const $tiered = document.getElementById('tieredOptimize');
  if ($tiered) {
    $tiered.checked = AppState.settings.tieredOptimize !== false;
    $tiered.addEventListener('change', () => {
      AppState.settings.tieredOptimize = $tiered.checked;
      autoSave();
    });
  }
  if ($maxAtt) $maxAtt.addEventListener('change', () => {
    AppState.settings.maxAttempts = parseInt($maxAtt.value) || 200000;
    autoSave();
  });
  $replDays.addEventListener('change', () => {
    for (const d in AppState.specialDays) {
      if (AppState.specialDays[d] === 'replacement') delete AppState.specialDays[d];
    }
    $replDays.value.split(',')
      .map(d => parseInt(d.trim())).filter(d => d > 0 && d <= 31)
      .forEach(d => { AppState.specialDays[d] = 'replacement'; });
    autoSave();
  });
  $renwDays.addEventListener('change', () => {
    for (const d in AppState.specialDays) {
      if (AppState.specialDays[d] === 'renewal') delete AppState.specialDays[d];
    }
    $renwDays.value.split(',')
      .map(d => parseInt(d.trim())).filter(d => d > 0 && d <= 31)
      .forEach(d => { AppState.specialDays[d] = 'renewal'; });
    autoSave();
  });
  if ($delvDays) $delvDays.addEventListener('change', () => {
    for (const d in AppState.specialDays) {
      if (AppState.specialDays[d] === 'delivery') delete AppState.specialDays[d];
    }
    $delvDays.value.split(',')
      .map(d => parseInt(d.trim())).filter(d => d > 0 && d <= 31)
      .forEach(d => { AppState.specialDays[d] = 'delivery'; });
    autoSave();
    if (typeof renderReqRules === 'function') renderReqRules();
  });
}

// ===== 行事・イベント設定 =====
function setupEventsPanel() {
  const btn = document.getElementById('btnAddEvent');
  if (!btn) return;
  btn.addEventListener('click', () => {
    AppState.events.push({ day: 1, name: '', staffIds: [] });
    renderEventList();
    autoSave();
  });
  renderEventList();
}

function renderEventList() {
  const container = document.getElementById('eventList');
  if (!container) return;
  container.innerHTML = '';

  if (!AppState.events.length) {
    container.innerHTML = '<p class="hint">行事は登録されていません。</p>';
    return;
  }

  AppState.events.forEach((ev, idx) => {
    const div = document.createElement('div');
    div.className = 'event-item';
    div.style.cssText = 'border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:8px';

    const staffChips = AppState.staff.map(s => {
      const checked = (ev.staffIds || []).includes(s.id);
      return `<label class="allowed-label" style="background:${checked ? '#bee3f8' : '#edf2f7'}">
        <input type="checkbox" data-ev-idx="${idx}" data-ev-staff="${s.id}"
               ${checked ? 'checked' : ''} style="margin:0 2px 0 0"/>${escapeHtml(s.name)}
      </label>`;
    }).join('');

    div.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <label>日付</label>
        <input type="number" min="1" max="31" value="${ev.day || 1}"
               data-ev-idx="${idx}" data-ev-field="day" style="width:60px"/>
        <label>行事名</label>
        <input type="text" value="${escapeHtml(ev.name || '')}" placeholder="例: 健康診断"
               data-ev-idx="${idx}" data-ev-field="name" style="width:180px"/>
        <button class="btn-icon" data-ev-del="${idx}" title="削除">🗑</button>
      </div>
      <div class="allowed-shifts-wrap">対象: ${staffChips}</div>
    `;
    container.appendChild(div);
  });

  // フィールド変更
  container.querySelectorAll('[data-ev-field]').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.evIdx);
      const field = e.target.dataset.evField;
      const ev    = AppState.events[idx];
      if (!ev) return;
      ev[field] = field === 'day' ? (parseInt(e.target.value) || 1) : e.target.value;
      autoSave();
    });
  });

  // 対象スタッフ
  container.querySelectorAll('input[data-ev-staff]').forEach(el => {
    el.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.evIdx);
      const sid = e.target.dataset.evStaff;
      const ev  = AppState.events[idx];
      if (!ev) return;
      if (!Array.isArray(ev.staffIds)) ev.staffIds = [];
      if (e.target.checked) {
        if (!ev.staffIds.includes(sid)) ev.staffIds.push(sid);
      } else {
        ev.staffIds = ev.staffIds.filter(x => x !== sid);
      }
      const label = e.target.closest('.allowed-label');
      if (label) label.style.background = e.target.checked ? '#bee3f8' : '#edf2f7';
      autoSave();
    });
  });

  // 削除
  container.querySelectorAll('[data-ev-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.closest('[data-ev-del]').dataset.evDel);
      AppState.events.splice(idx, 1);
      renderEventList();
      autoSave();
    });
  });
}

// ルールごとの強弱設定 UI ------------------------------------------------
// t=違反type, l=表示名, g=グループ, def=既定レベル, locked=変更不可
const RULE_LEVEL_META = [
  { g: '人員・役職', t: 'understaff',        l: '人員不足',              def: 'must', locked: true },
  { g: '人員・役職', t: 'off-count',         l: '公休数不足',            def: 'must', locked: true },
  { g: '人員・役職', t: 'consecutive',       l: '連勤超過',              def: 'must', locked: true },
  { g: '人員・役職', t: 'role-mismatch',     l: '担当外シフト',          def: 'must', locked: true },
  { g: '人員・役職', t: 'overstaff',         l: '定数オーバー（必要人数より多い）', def: 'should' },
  { g: '人員・役職', t: 'vicemanager-absent',l: '副店長不在の日',        def: 'must' },
  { g: '人員・役職', t: 'resp-duplicate',    l: '責任者・総務の重複',    def: 'must' },
  { g: '人員・役職', t: 'hierarchy',         l: '責任者ヒエラルキー',    def: 'must' },
  { g: 'スキル',     t: 'skill-late',        l: 'スキル最低人数割れ',    def: 'must' },
  { g: 'スキル',     t: 'skill-short',       l: 'スキル目標人数に不足',  def: 'should' },
  { g: 'リズム',     t: 'late-early',        l: '遅→早（休みなし）',     def: 'must' },
  { g: 'リズム',     t: 'night-after-work',  l: '夜勤明けの出勤',        def: 'must' },
  { g: 'リズム',     t: 'single-work',       l: '単発出勤',              def: 'must' },
  { g: 'リズム',     t: 'category-switch',   l: '連勤中の時間帯切替',    def: 'should' },
  { g: 'リズム',     t: 'band-switch',       l: '早遅の切り替え回数（1人・月の上限を超える）', def: 'should' },
  { g: 'リズム',     t: 'bad-rest',          l: '遅→休→早',             def: 'should' },
  { g: 'リズム',     t: 'long-rest',         l: '連休が長すぎる',        def: 'should',
    num: { key: 'maxConsecutiveOff', min: 1, max: 14, def: 3,
           before: '上限', after: '日まで（これを超えるとエラー）' } },
  { g: '個人希望',   t: 'pref-mismatch',     l: '早遅希望（早可/遅可）', def: 'must' },
  { g: '個人希望',   t: 'balance-diff',      l: '早遅バランス（早番多め等）', def: 'should',
    num: { key: 'balanceTolerance', min: 0, max: 15, def: 2,
           before: '許容', after: '日までのずれは許す' } },
  { g: '個人希望',   t: 'weekend-pref',      l: '土日休み希望',          def: 'should' },
  { g: '個人希望',   t: 'rest-style',        l: '休み方（連休/分散）',   def: 'should' },
  { g: '個人希望',   t: 'pair-rest',         l: '遅→早は2連休（個人）',  def: 'should' },
  { g: '個人希望',   t: 'pair-rest-count',   l: '連休回数が目安に不足',  def: 'should' },
  { g: '行事',       t: 'special-day',       l: '特別日の副店長（入れ替え日/新装日）', def: 'must' },
  { g: '行事',       t: 'event-absent',      l: '行事日に対象者が休み',  def: 'must' },
];

function toggleRuleLevelsPanel() {
  const panel  = document.getElementById('ruleLevelsPanel');
  const toggle = document.getElementById('ruleLevelsToggle');
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = isHidden ? 'block' : 'none';
  if (toggle) toggle.textContent = isHidden ? '▼ 閉じる' : '▶ 展開';
  if (isHidden) renderRuleLevels();
}

function renderRuleLevels() {
  const container = document.getElementById('ruleLevelsInputs');
  if (!container) return;
  const cfg = AppState.settings.ruleLevels || (AppState.settings.ruleLevels = {});
  let html = '';
  let lastG = null;
  RULE_LEVEL_META.forEach(r => {
    if (r.g !== lastG) { html += `<h4 style="margin:12px 0 4px">${r.g}</h4>`; lastG = r.g; }
    const cur = cfg[r.t] || r.def;
    if (r.locked) {
      html += `<div class="form-row"><label>${r.l}</label>
        <span class="hint">🔴 絶対（固定・変更不可）</span></div>`;
    } else {
      const opt = (v, lbl) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${lbl}</option>`;
      // 数値設定を持つルール（例: 連休の上限日数）はスピナーも一緒に出す
      let numHtml = '';
      if (r.num) {
        const nv = parseInt(AppState.settings[r.num.key]) || r.num.def;
        numHtml = `<span class="hint" style="display:inline-flex;align-items:center;gap:6px">
          ${r.num.before}
          <input type="number" data-rulenum="${r.num.key}" data-numdef="${r.num.def}"
                 min="${r.num.min}" max="${r.num.max}" value="${nv}" style="width:60px" />
          ${r.num.after}</span>`;
      }
      html += `<div class="form-row"><label>${r.l}</label>
        <select data-rule="${r.t}" data-def="${r.def}" style="min-width:130px">
          ${opt('must', '🔴 絶対')}${opt('should', '🟡 できれば')}${opt('off', '⚪ OFF（使わない）')}
        </select>${numHtml}</div>`;
    }
  });
  // 早遅バランスと切り替えを両方「絶対」にすると、ぶつかることがある（oct11 の実測:
  // 切り替えを先に解くとバランスのずれ最大10日、バランスを先にすると切り替え最大4回）。
  // 両方を絶対にしない使い方にしたので、そうなっているときは知らせる。
  html += '<div id="bsConflictNote" class="hint" style="display:none;margin-top:8px;padding:8px 10px;border-radius:8px;' +
    'background:color-mix(in srgb, var(--warning) 16%, var(--surface));border:1px solid color-mix(in srgb, var(--warning) 40%, transparent)">' +
    '⚠️ 「早遅バランス」と「早遅の切り替え」が両方とも「絶対」です。この2つはぶつかることがあります。' +
    'どちらか一方を「できれば」にしてください。</div>';
  container.innerHTML = html;
  const bsBoth = () => getRuleLevel('balance-diff') === 'must' && getRuleLevel('band-switch') === 'must';
  const showBsNote = () => { const n = document.getElementById('bsConflictNote'); if (n) n.style.display = bsBoth() ? '' : 'none'; };
  showBsNote();
  container.querySelectorAll('select[data-rule]').forEach(el => {
    el.addEventListener('change', e => {
      const t = e.target.dataset.rule, def = e.target.dataset.def, v = e.target.value;
      if (v === def) delete AppState.settings.ruleLevels[t]; // 既定と同じなら未設定に戻す（空=従来）
      else AppState.settings.ruleLevels[t] = v;
      autoSave();
      renderResultTable(); // 表示中の🔴/🟡分類を即反映
      showBsNote();
      if ((t === 'balance-diff' || t === 'band-switch') && v === 'must' && bsBoth())
        toast('「早遅バランス」と「早遅の切り替え」が両方「絶対」です。ぶつかることがあるので、どちらか一方を「できれば」にしてください。', 'warning', 8000);
    });
  });
  container.querySelectorAll('input[data-rulenum]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.rulenum;
      const min = parseInt(e.target.min), max = parseInt(e.target.max);
      const def = parseInt(e.target.dataset.numdef);
      let v = parseInt(e.target.value);
      if (!(v > 0)) v = def;
      v = Math.max(min, Math.min(max, v));
      e.target.value = v;
      AppState.settings[key] = v;
      autoSave();
      // 判定基準が変わるので違反を取り直して表示を更新
      if (AppState.generated && typeof checkViolations === 'function') {
        AppState.violations = checkViolations(AppState.shifts);
      }
      renderResultTable();
      toast(`連休の上限を ${v}日 に変更しました（${v + 1}日以上でエラー）`, 'info');
    });
  });
}

// ===== ② シフト種別マスター =====
function setupRolePanel() {
  document.getElementById('btnAddShiftType').addEventListener('click', () => {
    const newKey = 'SH' + (AppState.shiftTypes.length + 1);
    AppState.shiftTypes.push({
      key:          newKey,
      label:        '新シフト',
      color:        '#e2e8f0',
      category:     'A',
      countForStaff: true,
      isTraining:   false,
      isNight:      false,
      workHours:    8,
    });
    AppState.roleRequirements[newKey] = 1;
    renderRoleTable();
    autoSave();
    toast('シフト種別を追加しました', 'info');
  });
}

function renderRoleTable() {
  const tbody = document.getElementById('roleTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  AppState.shiftTypes.forEach((type, idx) => {
    const req = AppState.roleRequirements[type.key] != null
      ? AppState.roleRequirements[type.key] : 0;
    const reqCast = (AppState.roleRequirementsCast || {})[type.key] != null
      ? AppState.roleRequirementsCast[type.key] : 0;
    const hours = type.workHours != null ? type.workHours : 8;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input type="text" value="${escapeHtml(type.key)}"
               data-idx="${idx}" data-field="key"
               class="role-key-input" style="width:72px;font-weight:700"/>
      </td>
      <td>
        <input type="text" value="${escapeHtml(type.label)}"
               data-idx="${idx}" data-field="label" style="width:130px"/>
      </td>
      <td>
        <select data-idx="${idx}" data-field="category" style="width:90px">
          <option value="A" ${type.category === 'A' ? 'selected' : ''}>A（早番）</option>
          <option value="B" ${type.category === 'B' ? 'selected' : ''}>B（遅番）</option>
        </select>
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" data-idx="${idx}" data-field="countForStaff"
                 ${type.countForStaff ? 'checked' : ''}/>
          <span></span>
        </label>
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" data-idx="${idx}" data-field="isTraining"
                 ${type.isTraining ? 'checked' : ''}/>
          <span></span>
        </label>
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" data-idx="${idx}" data-field="isNight"
                 ${type.isNight ? 'checked' : ''}/>
          <span></span>
        </label>
      </td>
      <td style="white-space:nowrap">
        <input type="color" value="${type.color}" data-idx="${idx}" data-field="color"
               style="width:46px;height:28px;border:none;cursor:pointer;border-radius:4px;vertical-align:middle"/>
        <span class="shift-preview" style="background-color:${type.color}">
          ${escapeHtml(type.key)}
        </span>
      </td>
      <td>
        <input type="number" min="0" max="24" step="0.5" value="${hours}"
               data-idx="${idx}" class="role-hours-input" style="width:60px"/>
      </td>
      <td>
        <input type="number" min="0" max="99" value="${req}"
               data-idx="${idx}" class="role-req-input" style="width:60px"/>
      </td>
      <td>
        <input type="number" min="0" max="99" value="${reqCast}"
               data-idx="${idx}" class="role-req-cast-input" style="width:60px"
               ${isCombinedShift(type.key) ? 'disabled title="合算モードでは社員側の数を合計値として使います"' : ''}/>
      </td>
      <td style="text-align:center">
        <label class="switch" title="社員＋キャストを合算した合計人数で判定（社員側の数を合計値として使用）">
          <input type="checkbox" data-idx="${idx}" data-field="combined"
                 class="role-combined-input" ${isCombinedShift(type.key) ? 'checked' : ''}/>
          <span></span>
        </label>
      </td>
      <td>
        <button class="btn-icon" data-del-idx="${idx}" title="削除">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // フィールド変更
  tbody.querySelectorAll('input[data-field], select[data-field]').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const type  = AppState.shiftTypes[idx];
      if (!type) return;

      if (field === 'key') {
        const oldKey = type.key;
        const newKey = e.target.value.trim();
        if (newKey && newKey !== oldKey) {
          // 特別ルールが紐づくキー（責任者・総務）の改名はルールを無効化するため警告
          const SPECIAL_RULE_KEYS = ['早責', '遅責', '早総務', '遅総務'];
          if (SPECIAL_RULE_KEYS.includes(oldKey)) {
            const ok = confirm(
              `「${oldKey}」には責任者ヒエラルキー・重複禁止などの特別ルールが紐づいています。\n` +
              `キー名を変更するとこれらのルールが無効になります。本当に変更しますか？`);
            if (!ok) { e.target.value = oldKey; return; }
          }
          if (AppState.roleRequirements[oldKey] !== undefined) {
            AppState.roleRequirements[newKey] = AppState.roleRequirements[oldKey];
            delete AppState.roleRequirements[oldKey];
          }
          if (AppState.roleRequirementsCast && AppState.roleRequirementsCast[oldKey] !== undefined) {
            AppState.roleRequirementsCast[newKey] = AppState.roleRequirementsCast[oldKey];
            delete AppState.roleRequirementsCast[oldKey];
          }
          if (AppState.dailyRequirements && AppState.dailyRequirements[oldKey] !== undefined) {
            AppState.dailyRequirements[newKey] = AppState.dailyRequirements[oldKey];
            delete AppState.dailyRequirements[oldKey];
          }
          if (AppState.dailyRequirementsCast && AppState.dailyRequirementsCast[oldKey] !== undefined) {
            AppState.dailyRequirementsCast[newKey] = AppState.dailyRequirementsCast[oldKey];
            delete AppState.dailyRequirementsCast[oldKey];
          }
          type.key = newKey;
          // プレビューセルのテキスト更新
          const prev = e.target.closest('tr').querySelector('.shift-preview');
          if (prev) prev.textContent = newKey;
        }
      } else if (field === 'countForStaff' || field === 'isTraining' || field === 'isNight') {
        type[field] = e.target.checked;
      } else if (field === 'color') {
        type.color = e.target.value;
        const prev = e.target.closest('tr').querySelector('.shift-preview');
        if (prev) prev.style.backgroundColor = e.target.value;
      } else {
        type[field] = e.target.value;
      }
      autoSave();
    });
  });

  // 必要人数（社員）
  tbody.querySelectorAll('.role-req-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx  = parseInt(e.target.dataset.idx);
      const type = AppState.shiftTypes[idx];
      if (!type) return;
      AppState.roleRequirements[type.key] = parseInt(e.target.value) || 0;
      autoSave();
    });
  });

  // 必要人数（キャスト）
  tbody.querySelectorAll('.role-req-cast-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx  = parseInt(e.target.dataset.idx);
      const type = AppState.shiftTypes[idx];
      if (!type) return;
      if (!AppState.roleRequirementsCast) AppState.roleRequirementsCast = {};
      AppState.roleRequirementsCast[type.key] = parseInt(e.target.value) || 0;
      autoSave();
    });
  });

  // 合算（社員＋キャスト）切替
  tbody.querySelectorAll('.role-combined-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx  = parseInt(e.target.dataset.idx);
      const type = AppState.shiftTypes[idx];
      if (!type) return;
      if (!AppState.settings.combinedShifts) AppState.settings.combinedShifts = {};
      if (e.target.checked) AppState.settings.combinedShifts[type.key] = true;
      else delete AppState.settings.combinedShifts[type.key];
      renderRoleTable(); // キャスト欄の有効/無効表示を更新
      autoSave();
    });
  });

  // 労働時間（h/コマ）
  tbody.querySelectorAll('.role-hours-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx  = parseInt(e.target.dataset.idx);
      const type = AppState.shiftTypes[idx];
      if (!type) return;
      type.workHours = parseFloat(e.target.value) || 0;
      autoSave();
    });
  });

  // 削除
  tbody.querySelectorAll('[data-del-idx]').forEach(btn => {
    btn.addEventListener('click', e => {
      const b    = e.target.closest('[data-del-idx]');
      const idx  = parseInt(b.dataset.delIdx);
      const type = AppState.shiftTypes[idx];
      if (!type) return;
      if (confirm(`シフト「${type.key}」を削除しますか？`)) {
        delete AppState.roleRequirements[type.key];
        if (AppState.roleRequirementsCast) delete AppState.roleRequirementsCast[type.key];
        if (AppState.dailyRequirements) delete AppState.dailyRequirements[type.key];
        if (AppState.dailyRequirementsCast) delete AppState.dailyRequirementsCast[type.key];
        AppState.shiftTypes.splice(idx, 1);
        renderRoleTable();
        autoSave();
        toast(`「${type.key}」を削除しました`, 'info');
      }
    });
  });
}

// ===== 日別必要人数パネル =====

function toggleDailyReqPanel() {
  const panel  = document.getElementById('dailyReqPanel');
  const toggle = document.getElementById('dailyReqToggle');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  if (toggle) toggle.textContent = open ? '▼ 折りたたむ' : '▶ 展開';
  if (open) renderDailyReqPanel();
}

function renderDailyReqPanel() {
  const container = document.getElementById('dailyReqContent');
  if (!container) return;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  if (!days) { container.innerHTML = '<p class="hint">先に対象年月を設定してください。</p>'; return; }

  const countableTypes = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining);
  if (!countableTypes.length) { container.innerHTML = '<p class="hint">集計対象のシフト種別がありません。</p>'; return; }

  let html = '<div style="overflow-x:auto">';
  // クリアボタン
  html += `<div style="margin-bottom:8px">
    <button id="btnClearDailyReq" class="btn" style="font-size:13px">🗑 上書き設定を全てクリア</button>
    <span class="hint" style="margin-left:8px">上書きしたセルだけ削除し、デフォルト値に戻します</span>
  </div>`;
  html += '<table class="dailyreq-table" style="border-collapse:collapse;font-size:12px">';
  // ヘッダー1段目: 日付（曜日で色分け）
  html += '<thead><tr><th style="padding:4px 6px;border:1px solid #ccc;background:#f0f0f0;position:sticky;left:0;z-index:1">シフト / 部門</th>';
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    const bg = w === 0 ? '#ffe0e0' : (w === 6 ? '#e0ecff' : '#f0f0f0');
    html += `<th style="padding:2px 4px;border:1px solid #ccc;background:${bg};text-align:center">${d}</th>`;
  }
  html += '</tr>';
  // ヘッダー2段目: 曜日
  html += '<tr><th style="padding:2px 6px;border:1px solid #ccc;background:#f7f7f7;position:sticky;left:0;z-index:1"></th>';
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    const color = w === 0 ? '#c0392b' : (w === 6 ? '#2c5fb3' : '#555');
    const bg = w === 0 ? '#fff0f0' : (w === 6 ? '#f0f5ff' : '#f7f7f7');
    html += `<th style="padding:2px 4px;border:1px solid #ccc;background:${bg};text-align:center;color:${color};font-weight:700">${getWeekdayLabel(w)}</th>`;
  }
  html += '</tr></thead><tbody>';

  ['employee','cast'].forEach(dept => {
    const baseReqs = dept === 'employee' ? AppState.roleRequirements : (AppState.roleRequirementsCast || {});
    const dailyMap = dept === 'employee' ? (AppState.dailyRequirements || {}) : (AppState.dailyRequirementsCast || {});
    const deptLabel = dept === 'employee' ? '社員' : 'キャスト';
    countableTypes.forEach(type => {
      const defaultVal = baseReqs[type.key] || 0;
      if (!defaultVal && dept === 'cast') return;
      html += `<tr><td style="padding:4px 6px;border:1px solid #ccc;white-space:nowrap;position:sticky;left:0;background:#fff;z-index:1">${escapeHtml(type.key)}（${deptLabel}・通常: ${defaultVal}）</td>`;
      for (let d = 1; d <= days; d++) {
        const w = getWeekday(AppState.settings.targetMonth, d);
        const override = (dailyMap[type.key] || {})[d];
        const isOv = override != null;
        // 全セルに数字を表示（通常=グレー / 上書き=黒太字＋黄背景）
        const cellBg = isOv ? '#fff7d6' : (w === 0 ? '#fff5f5' : (w === 6 ? '#f5f9ff' : '#fff'));
        html += `<td style="padding:1px;border:1px solid #ccc;background:${cellBg}">
          <input type="number" min="0" max="99"
            value="${isOv ? override : defaultVal}"
            data-shift="${escapeHtml(type.key)}" data-day="${d}" data-dept="${dept}" data-default="${defaultVal}"
            class="daily-req-input" style="width:42px;text-align:center;border:none;background:transparent;font-size:13px;font-weight:${isOv ? '700' : '400'};color:${isOv ? '#000' : '#999'}"/>
        </td>`;
      }
      html += '</tr>';
    });
  });

  // ── スキル要件の日別上書き（目標人数 / 最低ライン）──
  (AppState.skills || []).forEach(sk => {
    const bandLabel = (sk.target || 'late') === 'early' ? '早番' : '遅番';
    [['req', '目標人数'], ['min', '最低ライン']].forEach(([field, fLabel]) => {
      const baseNeed = (sk.req != null ? sk.req : sk.lateReq) || 0;
      const baseVal  = field === 'req' ? baseNeed
                     : ((sk.min != null && sk.min >= 0) ? sk.min : baseNeed);
      html += `<tr><td style="padding:4px 6px;border:1px solid #ccc;white-space:nowrap;position:sticky;left:0;background:#eef6ff;z-index:1">`
            + `🎯 ${escapeHtml(sk.name)}（${bandLabel}・${fLabel}・通常: ${baseVal}）</td>`;
      for (let d = 1; d <= days; d++) {
        const w  = getWeekday(AppState.settings.targetMonth, d);
        const ov = ((AppState.dailySkills || {})[sk.name] || {})[d] || {};
        const override = ov[field];
        const isOv = override != null;
        const cellBg = isOv ? '#fff7d6' : (w === 0 ? '#fff5f5' : (w === 6 ? '#f5f9ff' : '#fff'));
        html += `<td style="padding:1px;border:1px solid #ccc;background:${cellBg}">
          <input type="number" min="0" max="99"
            value="${isOv ? override : baseVal}"
            data-skill="${escapeHtml(sk.name)}" data-sfield="${field}" data-day="${d}" data-default="${baseVal}"
            class="daily-skill-input" style="width:42px;text-align:center;border:none;background:transparent;font-size:13px;font-weight:${isOv ? '700' : '400'};color:${isOv ? '#000' : '#999'}"/>
        </td>`;
      }
      html += '</tr>';
    });
  });

  html += '</tbody></table></div>';
  if ((AppState.skills || []).length) {
    html += `<p class="hint" style="margin-top:6px">🎯 の行はスキル要件です。忙しい日だけ「目標人数」を増やす、閑散日は下げる、といった調整ができます（最低ラインは目標を超えません）。</p>`;
  }
  container.innerHTML = html;

  // スキル要件の日別上書き
  container.querySelectorAll('.daily-skill-input').forEach(el => {
    el.addEventListener('change', e => {
      const name  = e.target.dataset.skill;
      const field = e.target.dataset.sfield;
      const day   = parseInt(e.target.dataset.day);
      const def   = parseInt(e.target.dataset.default) || 0;
      const val   = e.target.value.trim();
      if (!AppState.dailySkills) AppState.dailySkills = {};
      if (!AppState.dailySkills[name]) AppState.dailySkills[name] = {};
      const map = AppState.dailySkills[name];
      const num = parseInt(val);
      const hasOverride = !(val === '' || val === '-' || isNaN(num) || num === def);
      if (!hasOverride) {
        if (map[day]) { delete map[day][field]; if (!Object.keys(map[day]).length) delete map[day]; }
        if (val === '' || val === '-') e.target.value = def;
      } else {
        if (!map[day]) map[day] = {};
        map[day][field] = num;
      }
      const w = getWeekday(AppState.settings.targetMonth, day);
      e.target.style.fontWeight = hasOverride ? '700' : '400';
      e.target.style.color      = hasOverride ? '#000' : '#999';
      const cell = e.target.closest('td');
      if (cell) cell.style.background = hasOverride ? '#fff7d6'
        : (w === 0 ? '#fff5f5' : (w === 6 ? '#f5f9ff' : '#fff'));
      autoSave();
    });
  });

  // 全クリアボタン
  const btnClear = container.querySelector('#btnClearDailyReq');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      const emp  = Object.keys(AppState.dailyRequirements || {}).some(k => Object.keys(AppState.dailyRequirements[k] || {}).length > 0);
      const cast = Object.keys(AppState.dailyRequirementsCast || {}).some(k => Object.keys(AppState.dailyRequirementsCast[k] || {}).length > 0);
      const skl  = Object.keys(AppState.dailySkills || {}).some(k => Object.keys(AppState.dailySkills[k] || {}).length > 0);
      if (!emp && !cast && !skl) { toast('上書き設定はありません', 'info'); return; }
      if (!confirm('日別の上書き設定を全てクリアしますか？（スキル要件の日別設定も含みます）\nデフォルト必要人数には影響しません。')) return;
      AppState.dailyRequirements     = {};
      AppState.dailyRequirementsCast = {};
      AppState.dailySkills           = {};
      autoSave();
      renderDailyReqPanel();
      toast('日別上書き設定をクリアしました', 'success');
    });
  }

  container.querySelectorAll('.daily-req-input').forEach(el => {
    el.addEventListener('change', e => {
      const sh   = e.target.dataset.shift;
      const day  = parseInt(e.target.dataset.day);
      const dept = e.target.dataset.dept;
      const def  = parseInt(e.target.dataset.default) || 0;
      const val  = e.target.value.trim();
      const map  = dept === 'employee' ? AppState.dailyRequirements : AppState.dailyRequirementsCast;
      if (!map[sh]) map[sh] = {};
      // 空欄・「-」・デフォルト値と同じ → 上書き解除。それ以外 → 上書き保存
      const num = parseInt(val);
      const hasOverride = !(val === '' || val === '-' || isNaN(num) || num === def);
      if (!hasOverride) {
        delete map[sh][day];
        if (val === '' || val === '-') e.target.value = def; // 空なら通常値を表示に戻す
      } else {
        map[sh][day] = num;
      }
      // 見た目を即反映（上書きあり=黒太字＋黄背景 / なし=薄字）
      const w = getWeekday(AppState.settings.targetMonth, day);
      e.target.style.fontWeight = hasOverride ? '700' : '400';
      e.target.style.color      = hasOverride ? '#000' : '#999';
      const cell = e.target.closest('td');
      if (cell) cell.style.background = hasOverride ? '#fff7d6'
        : (w === 0 ? '#fff5f5' : (w === 6 ? '#f5f9ff' : '#fff'));
      autoSave();
    });
  });
}


// ===== ③ スタッフ管理 =====
function setupStaffPanel() {
  // 前月末情報の取り込み（表示中のシフト表の末尾から算出）
  const $carry = document.getElementById('btnCarryOver');
  if ($carry) $carry.addEventListener('click', () => {
    if (!AppState.generated || !Object.keys(AppState.shifts || {}).length) {
      toast('先にシフト表を作成（または読込）してください', 'error');
      return;
    }
    const days = getDaysInMonth(AppState.settings.targetMonth);
    const info = calcPrevMonthEndFromShifts(AppState.shifts, days);
    const n = Object.keys(info).filter(id => info[id].cons > 0).length;
    if (!confirm(`表示中のシフト表の末尾から「前月末連勤日数／前月末シフト」を取り込みます。\n（${n}人が月末に連勤中）\n\n現在の入力値は上書きされます。よろしいですか？`)) return;
    applyPrevMonthEnd(info);
    renderStaffTable();
    toast(`前月末情報を取り込みました（${n}人が連勤中）`, 'success', 4000);
  });

  document.getElementById('btnAddStaff').addEventListener('click', () => {
    AppState.staff.push({
      id:              newStaffId(),
      name:            '新規スタッフ',
      department:      'employee',
      positionType:    'staff',
      allowedShifts:   ['早', '遅'],
      maxOff:          9,
      paidLeave:       0,
      prefs:           ['早可', '遅可'],
      balance:         'balanced',
      prevConsecutive: 0,
      prevLastShift:   '',
      note:            '',
      skills:          [],
      personalMaxCons: 0,
      personalMaxOff: 0,
      needPairRest:    false,
      weekendPref:     '',
      restStyle:       '',
      pairRestTarget:  0,
    });
    renderStaffTable();
    autoSave();
  });

  setupSkillsPanel();
}

// ===== スキル設定（営業など、遅番に必要なスキル保有人数を管理） =====
function setupSkillsPanel() {
  const btn = document.getElementById('btnAddSkill');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', () => {
      if (!Array.isArray(AppState.skills)) AppState.skills = [];
      AppState.skills.push({ name: '営業', target: 'late', req: 0 });
      renderSkillsPanel();
      renderStaffTable();
      autoSave();
    });
  }
  renderSkillsPanel();
}

function renderSkillsPanel() {
  const container = document.getElementById('skillsList');
  if (!container) return;
  const skills = AppState.skills || [];
  if (skills.length === 0) {
    container.innerHTML = '<p class="hint">スキル未登録です。「＋スキル追加」で登録すると、各スタッフにチェック欄が増えます。</p>';
    return;
  }
  container.innerHTML = skills.map((sk, i) => {
    const target = sk.target || 'late';
    const req    = (sk.req != null ? sk.req : (sk.lateReq || 0));
    const min    = (sk.min != null ? sk.min : req);
    return `
    <div class="skill-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
      <input type="text" value="${escapeHtml(sk.name)}" data-skill-idx="${i}" data-skill-field="name"
             style="width:140px" placeholder="スキル名（例: 営業）"/>
      <select data-skill-idx="${i}" data-skill-field="target" style="width:72px">
        <option value="late"  ${target === 'late'  ? 'selected' : ''}>遅番</option>
        <option value="early" ${target === 'early' ? 'selected' : ''}>早番</option>
      </select>
      <span class="hint">目標人数:</span>
      <input type="number" min="0" max="20" value="${req}" data-skill-idx="${i}" data-skill-field="req"
             style="width:56px"/>
      <span class="hint" title="この人数を下回ると🔴絶対NG。目標に届かなくても最低ライン以上なら🟡注意どまり。">最低ライン:</span>
      <input type="number" min="0" max="20" value="${min}" data-skill-idx="${i}" data-skill-field="min"
             style="width:56px"/>
      <button class="btn-icon" data-skill-del="${i}" title="削除">🗑</button>
    </div>`;
  }).join('');

  // 早番/遅番の切替は <select> なので、input だけでなく select も拾う。
  // （ここが input だけだったため、時間帯を変えても保存されていなかった）
  container.querySelectorAll('input[data-skill-field], select[data-skill-field]').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.skillIdx);
      const field = e.target.dataset.skillField;
      if (!AppState.skills[idx]) return;
      const oldName = AppState.skills[idx].name;
      if (field === 'req') {
        AppState.skills[idx].req = parseInt(e.target.value) || 0;
        delete AppState.skills[idx].lateReq; // 旧フィールドを掃除
        // 目標を下げたら最低ラインが目標を超えないよう丸める
        if (AppState.skills[idx].min != null && AppState.skills[idx].min > AppState.skills[idx].req) {
          AppState.skills[idx].min = AppState.skills[idx].req;
        }
        renderSkillsPanel();
        if (typeof renderDailyReqPanel === 'function') renderDailyReqPanel();
      } else if (field === 'min') {
        let m = parseInt(e.target.value);
        if (isNaN(m) || m < 0) m = 0;
        const req = (AppState.skills[idx].req != null ? AppState.skills[idx].req : 0);
        AppState.skills[idx].min = Math.min(m, req); // 最低ライン ≤ 目標
        if (typeof renderDailyReqPanel === 'function') renderDailyReqPanel();
      } else if (field === 'target') {
        AppState.skills[idx].target = e.target.value;
        // 日別必要人数の表にも「早番/遅番」を出しているので、そちらも描き直す
        if (typeof renderDailyReqPanel === 'function') renderDailyReqPanel();
      } else {
        const newName = e.target.value.trim() || '無名';
        AppState.skills[idx].name = newName;
        // スタッフが持つスキル名も追従させる
        AppState.staff.forEach(s => {
          if (Array.isArray(s.skills)) {
            const j = s.skills.indexOf(oldName);
            if (j >= 0) s.skills[j] = newName;
          }
        });
        // 日別の上書き設定はスキル名で記録しているので、一緒に引っ越す
        if (AppState.dailySkills && oldName !== newName && AppState.dailySkills[oldName]) {
          AppState.dailySkills[newName] = AppState.dailySkills[oldName];
          delete AppState.dailySkills[oldName];
        }
        renderStaffTable();
        if (typeof renderDailyReqPanel === 'function') renderDailyReqPanel();
      }
      autoSave();
    });
  });

  container.querySelectorAll('button[data-skill-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.closest('button[data-skill-del]').dataset.skillDel);
      const sk = AppState.skills[idx];
      if (!sk) return;
      if (!confirm(`スキル「${sk.name}」を削除しますか？`)) return;
      // スタッフからも除去
      AppState.staff.forEach(s => {
        if (Array.isArray(s.skills)) s.skills = s.skills.filter(n => n !== sk.name);
      });
      AppState.skills.splice(idx, 1);
      if (AppState.dailySkills) delete AppState.dailySkills[sk.name];   // 日別の上書きも消す
      renderSkillsPanel();
      renderStaffTable();
      if (typeof renderDailyReqPanel === 'function') renderDailyReqPanel();
      autoSave();
    });
  });
}

// 早遅バランスの選択肢ラベル。「早番多め（7：3）」のように割合を添えて分かりやすくする。
function balanceOptionLabel(v) {
  if (v.only) return v.label;   // 「早番のみ／遅番のみ」は比率ではないのでそのまま
  const e = Math.round(v.earlyRatio * 10), l = Math.round(v.lateRatio * 10);
  return `${v.label}（${e}：${l}）`;
}

function renderStaffTable() {
  const tbody = document.getElementById('staffTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  AppState.staff.forEach(s => {
    // allowedShifts チェックボックス群
    const checkboxes = AppState.shiftTypes.map(t => {
      const checked = (s.allowedShifts || []).includes(t.key);
      const bg = checked ? t.color : '#edf2f7';
      return `<label class="allowed-label" style="background:${bg}"
                     data-id="${s.id}" data-key="${escapeHtml(t.key)}">
        <input type="checkbox" data-allowed="${escapeHtml(t.key)}" data-id="${s.id}"
               ${checked ? 'checked' : ''} style="margin:0 2px 0 0"/>
        ${escapeHtml(t.key)}
      </label>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input type="text" value="${escapeHtml(s.name)}"
               data-field="name" data-id="${s.id}" style="width:100%;min-width:80px"/>
      </td>
      <td>
        <select data-field="department" data-id="${s.id}" style="width:100%;min-width:80px">
          ${Object.entries(DEPARTMENTS).map(([k, v]) =>
            `<option value="${k}" ${getStaffDepartment(s) === k ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </td>
      <td>
        <select data-field="positionType" data-id="${s.id}" style="width:100%;min-width:72px">
          ${Object.entries(POSITION_TYPES).map(([k, v]) =>
            `<option value="${k}" ${s.positionType === k ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </td>
      <td>
        <div class="allowed-shifts-wrap">${checkboxes}</div>
      </td>
      <td>
        <div class="skill-checks" style="display:flex;flex-direction:column;gap:2px;min-width:70px">
          ${(AppState.skills || []).length === 0
            ? '<span class="hint" style="white-space:nowrap">—</span>'
            : (AppState.skills || []).map(sk =>
                `<label style="white-space:nowrap"><input type="checkbox" data-skill="${escapeHtml(sk.name)}" data-id="${s.id}"
                   ${(s.skills || []).includes(sk.name) ? 'checked' : ''}/>${escapeHtml(sk.name)}</label>`
              ).join('')}
        </div>
      </td>
      <td>
        <input type="number" min="0" max="31" value="${s.maxOff}"
               data-field="maxOff" data-id="${s.id}" style="width:50px"/>
      </td>
      <td>
        <input type="number" min="0" max="31" value="${s.paidLeave || 0}"
               data-field="paidLeave" data-id="${s.id}" style="width:50px"/>
      </td>
      <td>
        <div class="shift-pref">
          ${SHIFT_PREFS.map(p =>
            `<label><input type="checkbox" data-pref="${p}" data-id="${s.id}"
             ${(s.prefs || []).includes(p) ? 'checked' : ''}/>${p}</label>`
          ).join('')}
        </div>
      </td>
      <td>
        <select data-field="balance" data-id="${s.id}" style="min-width:168px"
                title="出勤日のうち 早番:遅番 をどの割合にするか（指定なし＝この人はバランスを気にしない）">
          <option value="off" ${(s.balance || 'balanced') === 'off' ? 'selected' : ''}>指定なし（OFF）</option>
          ${Object.entries(SHIFT_BALANCE).map(([k, v]) =>
            `<option value="${k}" ${(s.balance || 'balanced') === k ? 'selected' : ''}>${balanceOptionLabel(v)}</option>`
          ).join('')}
        </select>
      </td>
      <td>
        <input type="number" min="0" max="10" value="${s.personalMaxCons > 0 ? s.personalMaxCons : ''}"
               placeholder="全体" title="この人だけの連勤上限。空欄なら全体設定を使用"
               data-field="personalMaxCons" data-id="${s.id}" style="width:54px"/>
      </td>
      <td>
        <input type="number" min="0" max="15" value="${s.personalMaxOff > 0 ? s.personalMaxOff : ''}"
               placeholder="全体" title="この人だけの連休上限。有給が多い人は長めにしておくと、毎月同じ警告が出なくなります。空欄なら全体設定を使用"
               data-field="personalMaxOff" data-id="${s.id}" style="width:54px"/>
      </td>
      <td style="text-align:center">
        <input type="checkbox" data-prule="needPairRest" data-id="${s.id}"
               title="遅番→早番へ移るときは休み1日ではなく2連休以上を挟む"
               ${s.needPairRest ? 'checked' : ''}/>
      </td>
      <td>
        <select data-field="weekendPref" data-id="${s.id}" style="min-width:78px"
                title="土日をなるべく休みにする">
          <option value=""     ${!s.weekendPref            ? 'selected' : ''}>なし</option>
          <option value="soft" ${s.weekendPref === 'soft'  ? 'selected' : ''}>なるべく</option>
          <option value="hard" ${s.weekendPref === 'hard'  ? 'selected' : ''}>絶対</option>
        </select>
      </td>
      <td>
        <select data-field="restStyle" data-id="${s.id}" style="min-width:110px"
                title="連休派=休みをまとめる／分散派=3連勤前後でこまめに休む">
          <option value=""            ${!s.restStyle                    ? 'selected' : ''}>おまかせ</option>
          <option value="pair-soft"   ${s.restStyle === 'pair-soft'    ? 'selected' : ''}>なるべく連休</option>
          <option value="pair-hard"   ${s.restStyle === 'pair-hard'    ? 'selected' : ''}>必ず連休</option>
          <option value="spread-soft" ${s.restStyle === 'spread-soft'  ? 'selected' : ''}>なるべく分散</option>
          <option value="spread-hard" ${s.restStyle === 'spread-hard'  ? 'selected' : ''}>必ず分散(3連勤まで)</option>
        </select>
      </td>
      <td>
        <input type="number" min="0" max="10" value="${s.pairRestTarget > 0 ? s.pairRestTarget : ''}"
               placeholder="全体" title="この人だけの月の連休（2連休以上）目安回数。空欄なら全体設定"
               data-field="pairRestTarget" data-id="${s.id}" style="width:54px"/>
      </td>
      <td>
        <input type="number" min="0" max="6" value="${s.prevConsecutive || 0}"
               data-field="prevConsecutive" data-id="${s.id}" style="width:50px"/>
      </td>
      <td>
        <select data-field="prevLastShift" data-id="${s.id}"
                ${(s.prevConsecutive || 0) < 1 ? 'disabled title="前月末連勤日数が0（＝前月末は休み）のため選択できません"' : ''}>
          <option value=""  ${(s.prevLastShift || '') === ''  ? 'selected' : ''}>―</option>
          <option value="早" ${(s.prevLastShift || '') === '早' ? 'selected' : ''}>早</option>
          <option value="遅" ${(s.prevLastShift || '') === '遅' ? 'selected' : ''}>遅</option>
        </select>
      </td>
      <td>
        <input type="text" value="${escapeHtml(s.note || '')}"
               data-field="note" data-id="${s.id}" style="width:100%;min-width:80px"/>
      </td>
      <td>
        <button class="btn-icon" data-del="${s.id}" title="削除">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 通常フィールド変更
  tbody.querySelectorAll('input[data-field], select[data-field]').forEach(el => {
    el.addEventListener('change', e => {
      const id    = e.target.dataset.id;
      const field = e.target.dataset.field;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      let val = e.target.value;
      if (['maxOff', 'prevConsecutive', 'paidLeave', 'personalMaxCons', 'personalMaxOff', 'pairRestTarget'].includes(field)) val = parseInt(val) || 0;
      staff[field] = val;
      if (field === 'personalMaxCons') warnComplianceLimit(val, `${staff.name}さん（個人）`);
      // 「前月末連勤日数」と「前月末シフト」は必ず整合させる。
      // 矛盾していると月初の判定を誤り、単発出勤などを見逃す原因になる。
      if (field === 'prevConsecutive') {
        if (val < 1) staff.prevLastShift = '';   // 0＝前月末は休み → シフト指定は無効
        renderStaffTable();                       // 選択欄の有効／無効を反映
      }
      autoSave();
    });
  });

  // 希望（早可/遅可）チェックボックス
  tbody.querySelectorAll('input[data-pref]').forEach(el => {
    el.addEventListener('change', e => {
      const id   = e.target.dataset.id;
      const pref = e.target.dataset.pref;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      if (!Array.isArray(staff.prefs)) staff.prefs = [];
      if (e.target.checked) {
        if (!staff.prefs.includes(pref)) staff.prefs.push(pref);
      } else {
        staff.prefs = staff.prefs.filter(p => p !== pref);
      }
      autoSave();
    });
  });

  // allowedShifts チェックボックス
  tbody.querySelectorAll('input[data-allowed]').forEach(el => {
    el.addEventListener('change', e => {
      const id       = e.target.dataset.id;
      const shiftKey = e.target.dataset.allowed;
      const staff    = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      if (!Array.isArray(staff.allowedShifts)) staff.allowedShifts = [];
      const label = e.target.closest('.allowed-label');
      if (e.target.checked) {
        if (!staff.allowedShifts.includes(shiftKey)) staff.allowedShifts.push(shiftKey);
        const t = AppState.shiftTypes.find(t => t.key === shiftKey);
        if (label) label.style.background = t ? t.color : '#edf2f7';
      } else {
        staff.allowedShifts = staff.allowedShifts.filter(k => k !== shiftKey);
        if (label) label.style.background = '#edf2f7';
      }
      autoSave();
    });
  });

  // 個人ルールのチェックボックス（遅→早は連休必須 など）
  tbody.querySelectorAll('input[data-prule]').forEach(el => {
    el.addEventListener('change', e => {
      const id    = e.target.dataset.id;
      const rule  = e.target.dataset.prule;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      staff[rule] = e.target.checked;
      autoSave();
    });
  });

  // スキルチェックボックス
  tbody.querySelectorAll('input[data-skill]').forEach(el => {
    el.addEventListener('change', e => {
      const id    = e.target.dataset.id;
      const skill = e.target.dataset.skill;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      if (!Array.isArray(staff.skills)) staff.skills = [];
      if (e.target.checked) {
        if (!staff.skills.includes(skill)) staff.skills.push(skill);
      } else {
        staff.skills = staff.skills.filter(n => n !== skill);
      }
      autoSave();
    });
  });

  // 削除
  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.closest('button[data-del]').dataset.del;
      if (confirm('このスタッフを削除しますか？')) {
        AppState.staff = AppState.staff.filter(s => s.id !== id);
        delete AppState.requests[id];
        delete AppState.shifts[id];
        renderStaffTable();
        autoSave();
      }
    });
  });
}

// ===== ④ カレンダー（希望休入力） =====
let selectedMark = '休';

/** 動的シフト種別チップを #shiftChipContainer に生成 */
function renderShiftChips() {
  const container = document.getElementById('shiftChipContainer');
  if (!container) return;
  container.innerHTML = '';
  AppState.shiftTypes.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.dataset.mark = t.key;
    btn.textContent  = t.key;
    btn.style.background = t.color;
    // 現在選択中なら outline でアクティブを表現（inline bg が CSS .active を上書きするため）
    if (t.key === selectedMark) {
      btn.classList.add('active');
      btn.style.outline = '3px solid #4a5568';
    }
    btn.addEventListener('click', () => selectChip(btn, t.key));
    container.appendChild(btn);
  });
}

/** チップ選択（固定・動的共通） */
function selectChip(btn, mark) {
  document.querySelectorAll('.chip-btn').forEach(b => {
    b.classList.remove('active');
    b.style.outline = '';
  });
  selectedMark = mark;
  if (!btn) return;
  btn.classList.add('active');
  // 出勤シフトチップはアウトラインで選択状態を示す
  if (isWork(mark)) btn.style.outline = '3px solid #4a5568';
}

function setupCalendarPanel() {
  // 固定チップ（休系・クリア）—— HTML に data-mark 属性付きで存在する
  document.querySelectorAll('.chip-btn[data-mark]').forEach(btn => {
    btn.addEventListener('click', () => selectChip(btn, btn.dataset.mark));
  });
  // 動的チップ（出勤シフト）を生成
  renderShiftChips();
  // 初期選択: 「休」
  const firstBtn = document.querySelector('.chip-btn[data-mark="休"]');
  if (firstBtn) { firstBtn.classList.add('active'); selectedMark = '休'; }
}

function renderCalendar() {
  const table = document.getElementById('calendarTable');
  if (!table) return;
  table.innerHTML = '';
  const days = getDaysInMonth(AppState.settings.targetMonth);

  // ヘッダー
  const thead = document.createElement('thead');
  let headRow = '<tr><th>名前</th>';
  for (let d = 1; d <= days; d++) {
    const w   = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    headRow += `<th class="${cls}">${d}<br><small>${getWeekdayLabel(w)}</small></th>`;
  }
  headRow += '</tr>';
  thead.innerHTML = headRow;
  table.appendChild(thead);

  // ボディ（部門ごとにグループ表示）
  const tbody = document.createElement('tbody');
  const calGroups = getDepartmentGroups();
  calGroups.forEach(g => {
    if (calGroups.length > 1) {
      const sep = document.createElement('tr');
      sep.className = 'dept-separator';
      sep.innerHTML = `<td colspan="${days + 1}" style="background:var(--surface-3);color:var(--text);font-weight:700;padding:4px 8px">${g.label}</td>`;
      tbody.appendChild(sep);
    }
    g.staff.forEach(s => {
      const tr = document.createElement('tr');
      let html = `<td>${escapeHtml(s.name)}</td>`;
      for (let d = 1; d <= days; d++) {
        const w     = getWeekday(AppState.settings.targetMonth, d);
        const cls   = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
        // ④で入力した内容のみを表示する（⑥シフト表の手動固定とは連動させない）
        const cur   = (AppState.requests[s.id] || {})[d] || '';
        const shCls = getShiftClass(cur);
        const shSty = getShiftStyle(cur);
        html += `<td class="${cls}" data-sid="${s.id}" data-day="${d}">
          <span class="shift-cell ${shCls}" style="${shSty}">${cur}</span>
        </td>`;
      }
      tr.innerHTML = html;
      tbody.appendChild(tr);
    });
  });
  table.appendChild(tbody);

  // クリック（記号入力）
  tbody.querySelectorAll('td[data-sid]').forEach(td => {
    td.addEventListener('click', () => {
      const sid = td.dataset.sid;
      const d   = parseInt(td.dataset.day);
      // ④の入力は requests に保存する（⑥の手動固定 fixedShifts とは別管理）。
      // 出勤系シフト（早責/遅責/研 など）も requests に入れるが、生成側は
      // getFixedShiftAt() 経由で「固定」として扱うので指定どおりに配置される。
      if (!AppState.requests[sid]) AppState.requests[sid] = {};
      if (selectedMark === '') {
        delete AppState.requests[sid][d];
      } else {
        AppState.requests[sid][d] = selectedMark;
      }
      const span = td.querySelector('.shift-cell');
      span.textContent   = selectedMark;
      span.className     = 'shift-cell ' + getShiftClass(selectedMark);
      span.style.cssText = getShiftStyle(selectedMark);
      autoSave();
    });
    // ダブルクリック（削除）
    td.addEventListener('dblclick', () => {
      const sid = td.dataset.sid;
      const d   = parseInt(td.dataset.day);
      if (AppState.requests[sid]) delete AppState.requests[sid][d];
      const span = td.querySelector('.shift-cell');
      span.textContent   = '';
      span.className     = 'shift-cell s-empty';
      span.style.cssText = '';
      autoSave();
    });
  });
}

// ===== ⑥ シフト表 =====

/** 凡例を動的生成 */
function renderShiftLegend() {
  const el = document.getElementById('shiftLegend');
  if (!el) return;
  let html = AppState.shiftTypes.map(t =>
    `<div class="legend-item">
      <span class="legend-color" style="background-color:${t.color}"></span>
      <span>${escapeHtml(t.key)}: ${escapeHtml(t.label)}</span>
    </div>`
  ).join('');
  html += `<div class="legend-item">
    <span class="legend-color" style="background:#eeeeee"></span>
    <span>休/公/☆: 公休系</span>
  </div>`;
  html += `<div class="legend-item">
    <span class="legend-color" style="background:#fff9c4"></span>
    <span>有: 有給</span>
  </div>`;
  html += `<div class="legend-item">
    <span class="legend-color" style="background:#ffe0b2"></span>
    <span>余: 余剰（人員余り）</span>
  </div>`;
  el.innerHTML = html;
}

function renderResultTable() {
  try { renderPartialIgnoreBanner(); } catch (_) {}
  const table = document.getElementById('resultTable');
  if (!table) return;
  table.innerHTML = '';
  const days = getDaysInMonth(AppState.settings.targetMonth);

  if (!AppState.generated || AppState.staff.length === 0) {
    table.innerHTML =
      '<tr><td style="padding:30px;text-align:center;color:#999">' +
      'まだシフトが生成されていません。「⑤ 自動生成」タブから実行してください。</td></tr>';
    const sa = document.getElementById('summaryArea');
    if (sa) sa.innerHTML = '';
    return;
  }

  // 違反マップ（すべての違反がシフト表のどこかで見えるように3種類に振り分ける）
  //  cellVio : スタッフ×日が特定できる違反 → そのコマを赤枠に
  //  dayVio  : その日全体の違反（人員不足・スキル不足・副店長不在など） → 日付の見出しに
  //  staffVio: 日付を持たない違反（公休不足 day=0） → 名前セルに
  const cellVio = {}, dayVio = {}, staffVio = {};
  (AppState.violations || []).forEach(v => {
    if (v.staffId && v.day >= 1) {
      (cellVio[v.staffId] = cellVio[v.staffId] || {});
      (cellVio[v.staffId][v.day] = cellVio[v.staffId][v.day] || []).push(v);
    } else if (v.day >= 1) {
      (dayVio[v.day] = dayVio[v.day] || []).push(v);
    } else if (v.staffId) {
      (staffVio[v.staffId] = staffVio[v.staffId] || []).push(v);
    }
  });
  const msgsOf = arr => (arr || []).map(x => x.message || x.type).join('\n');

  // ヘッダー
  const STAT_COLS = 7; // 名前列1 + 統計列6（公休/有給他/余/出勤/差/労働時間）
  const thead = document.createElement('thead');
  let headRow = '<tr><th>名前</th>';
  for (let d = 1; d <= days; d++) {
    const w   = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    const dv  = dayVio[d];
    const dCls = dv ? ' day-violation' : '';
    const dTtl = dv ? ` title="${escapeHtml(msgsOf(dv))}"` : '';
    const mark = dv ? `<span class="vio-badge">!</span>` : '';
    headRow += `<th class="${cls}${dCls}" data-dayhead="${d}"${dTtl}>${d}${mark}<br><small>${getWeekdayLabel(w)}</small></th>`;
  }
  headRow += '<th>公休</th><th>有給他</th><th>余<br><small>余剰</small></th><th>出勤</th><th>差</th><th>労働<br><small>時間</small></th></tr>';
  thead.innerHTML = headRow;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const resGroups = getDepartmentGroups();

  resGroups.forEach(g => {
    if (resGroups.length > 1) {
      const sep = document.createElement('tr');
      sep.className = 'dept-separator';
      sep.innerHTML = `<td colspan="${days + STAT_COLS}" style="background:var(--surface-3);color:var(--text);font-weight:700;padding:4px 8px">${g.label}</td>`;
      tbody.appendChild(sep);
    }

    // スタッフ行
    g.staff.forEach(s => {
      const tr = document.createElement('tr');
      let workCount = 0, publicOffCount = 0, otherOffCount = 0, surplusCount = 0, totalHours = 0;
      const sv = staffVio[s.id];
      let cells = `<td data-staffhead="${s.id}"${sv ? ` class="row-violation" title="${escapeHtml(msgsOf(sv))}"` : ''}>` +
                  `${escapeHtml(s.name)}${sv ? '<span class="vio-badge">!</span>' : ''}</td>`;
      for (let d = 1; d <= days; d++) {
        const w     = getWeekday(AppState.settings.targetMonth, d);
        const wcls  = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
        const shift = (AppState.shifts[s.id] || {})[d] || '';
        const cls   = getShiftClass(shift);
        const sty   = getShiftStyle(shift);
        const vList   = (cellVio[s.id] || {})[d];
        const vio     = vList ? ' violation' : '';
        const vMsg    = vio ? escapeHtml(msgsOf(vList)) : '';
        const isFixed = !!((AppState.fixedShifts[s.id] || {})[d]);
        const fixCls  = isFixed ? ' cell-fixed' : '';
        const titleAttr = isFixed
          ? `title="🔒 固定済み${vMsg ? ' / ' + vMsg : ''}"`
          : (vio ? `title="${vMsg}"` : '');
        if (isWork(shift)) { workCount++; totalHours += getShiftHours(shift); }
        else if (isPublicOff(shift)) publicOffCount++;
        else if (shift === '余') surplusCount++;
        else if (isOff(shift)) otherOffCount++;
        cells += `<td class="${wcls}${fixCls}" data-sid="${s.id}" data-day="${d}">
          <span class="shift-cell ${cls}${vio}" style="${sty}" draggable="true" ${titleAttr}>${shift}</span>
        </td>`;
      }
      // 差 = 公休 - 目標公休（+は余剰、-は不足）
      const offDiff = publicOffCount - (s.maxOff || 0);
      const diffStr = offDiff === 0 ? '0' : (offDiff > 0 ? `+${offDiff}` : `${offDiff}`);
      const diffSty = offDiff < 0 ? 'color:#c53030;font-weight:700'
                    : offDiff > 0 ? 'color:#b7791f;font-weight:700' : '';
      const surplusStr = surplusCount > 0 ? `<span style="color:#bf5b00;font-weight:700">${surplusCount}</span>` : '';
      cells += `<td>${publicOffCount}</td><td>${otherOffCount || ''}</td><td>${surplusStr}</td>` +
               `<td>${workCount}</td><td style="${diffSty}">${diffStr}</td>` +
               `<td>${totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}</td>`;
      tr.innerHTML = cells;
      tbody.appendChild(tr);
    });

    // 集計行（部門の必要人数 > 0 のシフト種別）— 定数は各日セルで直接編集可能
    const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);
    const deptKey = g.key === 'cast' ? 'cast' : 'employee';
    workKeys.forEach(key => {
      const defaultReq = g.reqs[key] || 0;
      if (defaultReq === 0) return;
      const tr = document.createElement('tr');
      tr.className = 'summary-row';
      let cells = `<td>${escapeHtml(key)} (必要${defaultReq})</td>`;
      for (let d = 1; d <= days; d++) {
        let count = 0;
        g.staff.forEach(s => {
          if ((AppState.shifts[s.id] || {})[d] === key) count++;
        });
        const dayReq = getDayReq(g.reqs, g.dailyReqs || {}, key, d);
        const cls = count < dayReq ? 'under' : (count > dayReq ? 'over' : '');
        // 配置人数(count)を上に小さく、その下に編集できる定数(必要人数)入力
        cells += `<td class="${cls}" style="padding:0">
          <div style="font-size:9px;color:#718096;line-height:1">${count}</div>
          <input type="number" min="0" max="99" value="${dayReq}"
            class="summary-req-input" data-key="${escapeHtml(key)}" data-day="${d}"
            data-dept="${deptKey}" data-default="${defaultReq}"
            title="配置 ${count}人 / 必要 ${dayReq}人（この数字が定数。変更できます）"
            style="width:100%;height:20px;border:none;background:transparent;text-align:center;font-size:11px;font-weight:700;color:#2d3748"/>
        </td>`;
      }
      cells += '<td></td><td></td><td></td><td></td><td></td><td></td>';
      tr.innerHTML = cells;
      tbody.appendChild(tr);
    });
  });

  table.appendChild(tbody);

  // 集計行の定数（必要人数）をシフト表から直接編集
  table.querySelectorAll('.summary-req-input').forEach(el => {
    // 入力欄クリックでセル編集モーダルが開かないように伝播を止める
    el.addEventListener('click', e => e.stopPropagation());
    el.addEventListener('change', e => {
      const key  = e.target.dataset.key;
      const day  = parseInt(e.target.dataset.day);
      const dept = e.target.dataset.dept;
      const def  = parseInt(e.target.dataset.default) || 0;
      const map  = dept === 'cast' ? AppState.dailyRequirementsCast : AppState.dailyRequirements;
      if (!map[key]) map[key] = {};
      const num = parseInt(e.target.value);
      if (isNaN(num) || num === def) delete map[key][day]; // デフォルトと同じなら上書き解除
      else map[key][day] = num;
      if (typeof saveToStorage === 'function') saveToStorage();
      AppState.violations = checkViolations(AppState.shifts);
      renderResultTable(); // 色（過不足）を更新
      toast(`${key} ${day}日 の必要人数を ${isNaN(num) ? def : num} に設定`, 'info', 1500);
    });
  });

  setupDragAndDrop();
  setupManualEdit();
  renderSummary();
}

function renderSummary() {
  const area = document.getElementById('summaryArea');
  if (!area) return;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const groups = getDepartmentGroups();

  let html = '';
  groups.forEach(g => {
    if (groups.length > 1) html += `<h4 style="margin:8px 0 4px">${g.label}</h4>`;
    html += '<table style="width:auto"><thead><tr><th>スタッフ</th>';
    AppState.shiftTypes.forEach(t => html += `<th>${escapeHtml(t.key)}</th>`);
    html += '<th>公休</th><th>有給他</th><th>出勤日数</th><th>差</th><th>総労働時間</th></tr></thead><tbody>';

    g.staff.forEach(s => {
      const counts = {};
      AppState.shiftTypes.forEach(t => { counts[t.key] = 0; });
      let publicOff = 0, otherOff = 0, workCount = 0, totalHours = 0;
      for (let d = 1; d <= days; d++) {
        const sh = (AppState.shifts[s.id] || {})[d] || '';
        if (counts[sh] !== undefined) {
          counts[sh]++;
          workCount++;
          totalHours += getShiftHours(sh);
        } else if (isPublicOff(sh)) {
          publicOff++;
        } else if (isOff(sh)) {
          otherOff++;
        }
      }
      const offDiff = publicOff - (s.maxOff || 0);
      const diffStr = offDiff === 0 ? '0' : (offDiff > 0 ? `+${offDiff}` : `${offDiff}`);
      html += `<tr><td>${escapeHtml(s.name)}</td>`;
      AppState.shiftTypes.forEach(t => html += `<td>${counts[t.key]}</td>`);
      html += `<td>${publicOff}</td><td>${otherOff || ''}</td><td>${workCount}</td>` +
              `<td>${diffStr}</td><td>${totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}</td></tr>`;
    });
    html += '</tbody></table>';
  });
  area.innerHTML = html;
}

// ===== ドラッグ＆ドロップ =====
let dragSource = null;

function setupDragAndDrop() {
  document.querySelectorAll('.result-table .shift-cell[draggable="true"]').forEach(cell => {
    cell.addEventListener('dragstart', e => {
      dragSource = e.target.closest('td');
      e.target.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragend', e => {
      e.target.classList.remove('dragging');
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      dragSource = null;
    });
  });
  document.querySelectorAll('.result-table td[data-sid]').forEach(td => {
    td.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const span = td.querySelector('.shift-cell');
      if (span) span.classList.add('drag-over');
    });
    td.addEventListener('dragleave', () => {
      const span = td.querySelector('.shift-cell');
      if (span) span.classList.remove('drag-over');
    });
    td.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSource || dragSource === td) return;
      // 計算中は手で変えない（終わった答えで上書きされる）
      if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
      recordShiftHistory();
      const sid1 = dragSource.dataset.sid, d1 = parseInt(dragSource.dataset.day);
      const sid2 = td.dataset.sid,         d2 = parseInt(td.dataset.day);
      const v1 = (AppState.shifts[sid1] || {})[d1] || '';
      const v2 = (AppState.shifts[sid2] || {})[d2] || '';
      const beforeEdit = { shifts: JSON.parse(JSON.stringify(AppState.shifts)),        // 警告の比べる元
                           fixed:  JSON.parse(JSON.stringify(AppState.fixedShifts || {})) };
      if (!AppState.shifts[sid1]) AppState.shifts[sid1] = {};
      if (!AppState.shifts[sid2]) AppState.shifts[sid2] = {};
      AppState.shifts[sid1][d1] = v2;
      AppState.shifts[sid2][d2] = v1;
      // 固定(🔒)も値と一緒に移動させる（取り残しによる誤固定を防ぐ）
      if (!AppState.fixedShifts[sid1]) AppState.fixedShifts[sid1] = {};
      if (!AppState.fixedShifts[sid2]) AppState.fixedShifts[sid2] = {};
      const f1 = AppState.fixedShifts[sid1][d1];
      const f2 = AppState.fixedShifts[sid2][d2];
      if (f2 != null) AppState.fixedShifts[sid1][d1] = f2; else delete AppState.fixedShifts[sid1][d1];
      if (f1 != null) AppState.fixedShifts[sid2][d2] = f1; else delete AppState.fixedShifts[sid2][d2];
      dragSource = null;
      refreshAfterManualEdit('シフトを交換しました', beforeEdit);
    });
  });
}

// ===== 手動シフト編集（モーダル） =====
let editingCell = null;
let modalListenersInstalled = false;

/** モーダル内のシフト選択肢を動的生成 */
function renderModalOptions() {
  const container = document.getElementById('shiftOptionContainer');
  if (!container) return;
  container.innerHTML = '';

  // 出勤シフト（動的）
  AppState.shiftTypes.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'shift-option';
    btn.dataset.shift = t.key;
    btn.textContent   = t.key;
    btn.title         = t.label;
    btn.style.cssText = `background:${t.color};border-color:${t.color};color:#333`;
    container.appendChild(btn);
  });

  // 休み系（固定）
  [
    { shift: '休', label: '公休',       bg: '#eeeeee', color: '#616161' },
    { shift: '公', label: '公休扱い',   bg: '#f5f5f5', color: '#424242' },
    { shift: '有', label: '有給',       bg: '#fff9c4', color: '#827717' },
    { shift: '半', label: '半休',       bg: '#e8f5e9', color: '#2e7d32' },
    { shift: '余', label: '余剰（人員余り）', bg: '#ffe0b2', color: '#bf5b00' },
    { shift: '☆', label: '希望休',     bg: '#eeeeee', color: '#616161' },
    { shift: '季', label: '季節休暇',   bg: '#eeeeee', color: '#616161' },
    { shift: '引', label: '引継',       bg: '#eeeeee', color: '#616161' },
    { shift: '慶', label: '慶弔休',     bg: '#eeeeee', color: '#616161' },
    { shift: '',   label: '空白（消去）', bg: '#ffffff', color: '#aaa'   },
  ].forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'shift-option';
    btn.dataset.shift = o.shift;
    btn.textContent   = o.shift || '―';
    btn.title         = o.label;
    btn.style.cssText = `background:${o.bg};color:${o.color}`;
    container.appendChild(btn);
  });
}

function setupManualEdit() {
  const modal       = document.getElementById('shiftEditModal');
  const modalTarget = document.getElementById('modalTarget');
  const modalCancel = document.getElementById('modalCancel');

  // セルクリック → モーダル表示（テーブル再描画ごとに登録）
  document.querySelectorAll('.result-table td[data-sid]').forEach(td => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', e => {
      if (dragSource) return;
      editingCell = td;
      const sid   = td.dataset.sid;
      const d     = parseInt(td.dataset.day);
      const staff = AppState.staff.find(s => s.id === sid);
      if (modalTarget) modalTarget.textContent = `${staff ? staff.name : ''} - ${d}日`;
      renderModalOptions();
      modal.classList.add('show');
      e.stopPropagation();
    });
  });

  // モーダル固定リスナーは1度だけ登録
  if (modalListenersInstalled) return;
  modalListenersInstalled = true;

  // シフト選択（イベント委譲）
  const optContainer = document.getElementById('shiftOptionContainer');
  optContainer.addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.target.closest('.shift-option');
    if (!btn || !editingCell) return;
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    recordShiftHistory();
    const sid      = editingCell.dataset.sid;
    const d        = parseInt(editingCell.dataset.day);
    const newShift = btn.dataset.shift;
    const beforeEdit = { shifts: JSON.parse(JSON.stringify(AppState.shifts)),          // 警告の比べる元
                         fixed:  JSON.parse(JSON.stringify(AppState.fixedShifts || {})) };
    if (!AppState.shifts[sid]) AppState.shifts[sid] = {};
    AppState.shifts[sid][d] = newShift;
    // 手動編集は fixedShifts にも保存 → 再最適化でも固定される
    if (!AppState.fixedShifts[sid]) AppState.fixedShifts[sid] = {};
    if (newShift) {
      AppState.fixedShifts[sid][d] = newShift;
    } else {
      delete AppState.fixedShifts[sid][d]; // 空白（消去）で固定解除
    }
    const staffName = (AppState.staff.find(s => s.id === sid) || {}).name || '';
    modal.classList.remove('show');
    editingCell = null;
    const fixedMark = newShift ? ' 🔒' : '';
    refreshAfterManualEdit(`${staffName} ${d}日 →「${newShift || '空'}」に変更${fixedMark}`, beforeEdit);
  });

  // キャンセル
  modalCancel.addEventListener('click', e => {
    e.stopPropagation();
    modal.classList.remove('show');
    editingCell = null;
  });

  // 背景クリックで閉じる
  modal.addEventListener('click', e => {
    if (e.target === modal) {
      modal.classList.remove('show');
      editingCell = null;
    }
  });
}

/* ===== 編集履歴（Excel ライクな 元に戻す／やり直し） ===== */
let _undoStack = [];
let _redoStack = [];

// 元に戻すで戻すもの。表と🔒固定のほかに、余の解消が変える希望（「有」）・日ごとの必要人数・
// 有給日数も含める（表だけ戻り、希望「有」と有給日数+1が残っていた）。
// 有給日数は人ごとに戻す（スタッフの追加・削除まで戻さないため）。
function _snapshotShiftState() {
  const paid = {};
  (AppState.staff || []).forEach(s => { paid[s.id] = s.paidLeave; });
  return {
    shifts: JSON.parse(JSON.stringify(AppState.shifts || {})),
    fixed:  JSON.parse(JSON.stringify(AppState.fixedShifts || {})),
    req:    JSON.parse(JSON.stringify(AppState.requests || {})),
    daily:  JSON.parse(JSON.stringify(AppState.dailyRequirements || {})),
    dailyC: JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {})),
    paid,
  };
}

/** 編集を加える「直前」の状態を履歴に積む（手動編集ハンドラの先頭で呼ぶ） */
function recordShiftHistory() {
  _undoStack.push(_snapshotShiftState());
  if (_undoStack.length > 100) _undoStack.shift();
  _redoStack = []; // 新しい編集をしたら やり直し履歴は破棄
  updateHistoryButtons();
}

/** 生成直後などに履歴をリセット（この状態が一番最初の戻り先になる） */
function resetShiftHistory() {
  _undoStack = [];
  _redoStack = [];
  updateHistoryButtons();
}

function _applyShiftState(st) {
  AppState.shifts      = JSON.parse(JSON.stringify(st.shifts));
  AppState.fixedShifts = JSON.parse(JSON.stringify(st.fixed));
  if (st.req)    AppState.requests              = JSON.parse(JSON.stringify(st.req));
  if (st.daily)  AppState.dailyRequirements     = JSON.parse(JSON.stringify(st.daily));
  if (st.dailyC) AppState.dailyRequirementsCast = JSON.parse(JSON.stringify(st.dailyC));
  if (st.paid) (AppState.staff || []).forEach(s => { if (s.id in st.paid) s.paidLeave = st.paid[s.id]; });
  AppState.violations  = checkViolations(AppState.shifts);
  renderResultTable();
  const reportCard = document.getElementById('reportCard');
  if (reportCard && reportCard.style.display !== 'none' && typeof renderReport === 'function') {
    renderReport({ success: AppState.violations.length === 0,
      score: AppState.violations.length, violations: AppState.violations });
  }
  if (typeof saveToStorage === 'function') saveToStorage();
  updateHistoryButtons();
}

function undoShiftEdit() {
  // 計算中は戻さない（終わった答えで上書きされ、戻した表が消える）
  if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
  if (_undoStack.length === 0) { toast('これ以上 戻せません', 'info', 1200); return; }
  _redoStack.push(_snapshotShiftState());
  _applyShiftState(_undoStack.pop());
  toast('元に戻しました', 'info', 1200);
}

function redoShiftEdit() {
  if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
  if (_redoStack.length === 0) { toast('やり直す操作がありません', 'info', 1200); return; }
  _undoStack.push(_snapshotShiftState());
  _applyShiftState(_redoStack.pop());
  toast('やり直しました', 'info', 1200);
}

/** 直前に積んだ履歴を取り消す（修復が改善しなかった場合などに使う） */
function discardLastShiftHistory() {
  if (_undoStack.length > 0) _undoStack.pop();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const u = document.getElementById('btnUndo');
  const r = document.getElementById('btnRedo');
  if (u) u.disabled = _undoStack.length === 0;
  if (r) r.disabled = _redoStack.length === 0;
}

/**
 * 手動編集後の一括更新
 * - 違反再チェック
 * - 結果テーブル全体を再描画
 * - 診断レポートを更新
 * - localStorage に保存
 */
// 手で直した後の数え直し。悪くなったときの警告は、呼び出し側の「交換しました」
// などの知らせと1つにまとめて出す（別々に出すと、後の知らせで警告が上書きされて
// 見えなかった）。doneMsg を渡すとまとめて表示し、渡さなければ警告だけを出す。
// before: 手直しの直前の {shifts, fixed}。これをいまの設定で数え直して比べる。
// 保存されていた一覧や、設定を変える前の一覧と比べると、誤って警告が出ていた。
// 固定マス（🔒）も手直し前のものを使う（入れ替えで🔒も動くため、手直し後の🔒で
// 数えると、良くなったのに「悪くなりました」と出ることがあった）。
function refreshAfterManualEdit(doneMsg, before) {
  let prevV = AppState.violations || [];
  if (before && before.shifts) {
    const nowFixed = AppState.fixedShifts;
    try { AppState.fixedShifts = before.fixed || nowFixed; prevV = checkViolations(before.shifts); }
    finally { AppState.fixedShifts = nowFixed; }
  }
  const prevSc = scoreViolations(prevV);
  AppState.violations = checkViolations(AppState.shifts);
  const nowSc = scoreViolations(AppState.violations);
  const warns = [];
  // 6連勤以上（コンプラ違反）が新しくできた、または伸びたときだけ、誰の何日かを出す。
  // 手直し前の同じ人の6連勤以上と日が重なり、その長さ以下なら（縮めた・変わらない）出さない。
  compWorsened(prevV, AppState.violations).forEach(v => {
    const nm = (AppState.staff.find(s => s.id === v.staffId) || {}).name || '';
    warns.push(`⛔ コンプラ違反：${nm}さん ${v.from >= 1 ? v.from + '日' : '前月'}〜${v.to}日が${v.len}連勤になりました`);
  });
  // そのほか悪くなったもの（件数と連勤の超過日数を分けて出す）
  const up = scoreWorsened(nowSc, prevSc).filter(x => x.key !== 'comp');
  if (up.length) {
    const lab = (k) => k === 'over' ? '連勤の超過' : k === 'bsOver' ? '切り替えの超過' : k === 'soft' ? '🟡'
      : ((typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[k]) || k);
    warns.push('⚠ 悪くなりました：' + up.map(x => `${lab(x.key)} ${x.from}→${x.to}${x.key === 'over' ? '日' : x.key === 'bsOver' ? '回' : '件'}`).join('・'));
  }
  if (warns.length) {
    toast((doneMsg ? doneMsg + '。' : '') + warns.join(' ／ '), warns.some(w => w.startsWith('⛔')) ? 'error' : 'warning', 8000);
  } else if (doneMsg) {
    toast(doneMsg, 'info', 1500);
  }
  renderResultTable();

  const reportCard = document.getElementById('reportCard');
  if (reportCard && reportCard.style.display !== 'none') {
    if (typeof renderReport === 'function') {
      renderReport({
        success:    AppState.violations.length === 0,
        score:      AppState.violations.length,
        violations: AppState.violations,
      });
    }
  }
  if (typeof saveToStorage === 'function') saveToStorage();
}

/* ===========================================
   違反 → シフト表のコマへジャンプ
   レポートの違反項目クリックで、⑥シフト表の該当セル（または該当日の見出し／
   該当スタッフの名前セル）までスクロールして点滅表示する。
   =========================================== */
function jumpToViolation(sid, day) {
  const tab = document.querySelector('.tab[data-tab="result"]');
  if (tab && !tab.classList.contains('active')) tab.click();
  setTimeout(() => {
    const table = document.getElementById('resultTable');
    if (!table) return;
    let el = null;
    if (sid && day >= 1)      el = table.querySelector(`td[data-sid="${CSS.escape(sid)}"][data-day="${day}"]`);
    else if (day >= 1)        el = table.querySelector(`th[data-dayhead="${day}"]`);
    else if (sid)             el = table.querySelector(`td[data-staffhead="${CSS.escape(sid)}"]`);
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.remove('vio-flash');
    void el.offsetWidth;       // アニメーションを再実行させる
    el.classList.add('vio-flash');
    setTimeout(() => el.classList.remove('vio-flash'), 2400);
  }, 60);
}

document.addEventListener('click', (e) => {
  const item = e.target.closest && e.target.closest('.violation-item.is-jumpable');
  if (!item) return;
  const sid = item.dataset.jumpSid || '';
  const day = parseInt(item.dataset.jumpDay) || 0;
  if (!sid && !day) return;
  jumpToViolation(sid, day);
});

/* ===========================================
   列幅のドラッグ調整（②シフト種別 / ③スタッフ管理 / ⑥シフト表）
   見出しの右端をドラッグすると列幅を変更でき、localStorage に保存される。
   =========================================== */
const COLW_KEY = 'shiftapp-colwidths';
function _loadColW() {
  try { return JSON.parse(localStorage.getItem(COLW_KEY) || '{}'); } catch (_) { return {}; }
}
function _saveColW(map) {
  try { localStorage.setItem(COLW_KEY, JSON.stringify(map)); } catch (_) {}
}
// 保存済みの幅を適用（テーブル種別＋列番号をキーにする）
function applyColumnWidths(table) {
  if (!table) return;
  const key = table.dataset.colwKey;
  if (!key) return;
  const saved = _loadColW()[key] || {};
  const ths = table.querySelectorAll('thead tr:first-child > th');
  ths.forEach((th, i) => {
    const w = saved[i];
    if (w) { th.style.width = w + 'px'; th.style.minWidth = w + 'px'; th.style.maxWidth = w + 'px'; }
  });
}
// 見出しにドラッグ用のつまみを付ける
function enableColumnResize(table, key) {
  if (!table) return;
  table.dataset.colwKey = key;
  table.classList.add('resizable-cols');
  // 見出しが再描画されるテーブルもあるため、つまみが無い見出しだけ毎回付け直す
  const ths = table.querySelectorAll('thead tr:first-child > th');
  ths.forEach((th, idx) => {
    if (th.querySelector('.col-resizer')) return;
    const grip = document.createElement('span');
    grip.className = 'col-resizer';
    grip.title = 'ドラッグで列幅を変更（ダブルクリックで既定に戻す）';
    th.appendChild(grip);

    let startX = 0, startW = 0;
    const onMove = (ev) => {
      const w = Math.max(28, startW + (ev.clientX - startX));
      th.style.width = w + 'px'; th.style.minWidth = w + 'px'; th.style.maxWidth = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
      const all = _loadColW();
      all[key] = all[key] || {};
      all[key][idx] = parseInt(th.style.width) || th.offsetWidth;
      _saveColW(all);
    };
    grip.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      startX = ev.clientX; startW = th.offsetWidth;
      document.body.classList.add('col-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // ダブルクリックで既定幅に戻す
    grip.addEventListener('dblclick', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      th.style.width = ''; th.style.minWidth = ''; th.style.maxWidth = '';
      const all = _loadColW();
      if (all[key]) { delete all[key][idx]; _saveColW(all); }
    });
  });
  applyColumnWidths(table);
}

// 各表に列幅調整を有効化（描画のたびに呼ばれても安全）
function setupAllColumnResizers() {
  enableColumnResize(document.querySelector('.role-table'),  'role');
  enableColumnResize(document.querySelector('.staff-table'), 'staff');
  enableColumnResize(document.getElementById('resultTable'), 'result');
}

// 各テーブルの描画後に列幅調整を有効化する（描画関数をラップして自動適用）
['renderRoleTable', 'renderStaffTable', 'renderResultTable'].forEach((fn) => {
  const orig = window[fn];
  if (typeof orig !== 'function') return;
  window[fn] = function (...args) {
    const r = orig.apply(this, args);
    try { setupAllColumnResizers(); } catch (_) {}
    return r;
  };
});

/* ===========================================
   前月末情報（連勤日数・シフト）の引き継ぎ
   月が替わったとき、前の月のシフト表の末尾から各スタッフの
   「月末時点で何連勤していたか」「最後は早番系か遅番系か」を求める。
   =========================================== */
function calcPrevMonthEndFromShifts(shifts, days) {
  const out = {};
  (AppState.staff || []).forEach(s => {
    const row = (shifts || {})[s.id] || {};
    let cons = 0, lastBand = '';
    for (let d = days; d >= 1; d--) {
      const v = row[d] || '';
      // 半休も出勤として数える（検査の連勤と同じ）。数えないと「早早早早半」が0連勤になっていた。
      const half = typeof isHalfWork === 'function' && isHalfWork(v);
      if (!isWork(v) && !half) break;        // 休みが出たら連勤は途切れる
      // 月末に一番近い勤務の時間帯。半休は「―」（どちらでもない）にする。検査では、半休の翌日は
      // 遅→早にも時間帯切替にもならないので、「早」として引き継ぐと翌月1日の遅番が切替に数えられていた。
      if (!lastBand) lastBand = half ? '半' : (isLate(v) ? '遅' : '早');
      cons++;
    }
    out[s.id] = { cons, lastShift: cons > 0 && lastBand !== '半' ? lastBand : '' };
  });
  return out;
}

function applyPrevMonthEnd(info) {
  (AppState.staff || []).forEach(s => {
    const v = info[s.id];
    if (!v) return;
    s.prevConsecutive = v.cons;
    s.prevLastShift   = v.lastShift;
  });
  autoSave();
}

/* ===========================================
   エラー解消プランの画面（提案の表示とワンクリック適用）
   =========================================== */
let _relaxUndo = null;   // 直前の適用を取り消すためのスナップショット

// 設定まわりだけを丸ごと控えておく（適用を1手だけ元に戻せるように）
function snapshotForRelax() {
  return JSON.stringify({
    settings:              AppState.settings,
    roleRequirements:      AppState.roleRequirements,
    roleRequirementsCast:  AppState.roleRequirementsCast,
    dailyRequirements:     AppState.dailyRequirements,
    dailyRequirementsCast: AppState.dailyRequirementsCast,
    skills:                AppState.skills,
    staff:                 AppState.staff,
  });
}
function restoreFromRelax(snap) {
  const d = JSON.parse(snap);
  AppState.settings              = d.settings;
  AppState.roleRequirements      = d.roleRequirements;
  AppState.roleRequirementsCast  = d.roleRequirementsCast;
  AppState.dailyRequirements     = d.dailyRequirements;
  AppState.dailyRequirementsCast = d.dailyRequirementsCast;
  AppState.skills                = d.skills;
  AppState.staff                 = d.staff;
}

// 部門キーから、書き換える対象の設定を選ぶ
function _reqStoreFor(dept) {
  return (dept === 'cast')
    ? { req: AppState.roleRequirementsCast || (AppState.roleRequirementsCast = {}),
        daily: AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}) }
    : { req: AppState.roleRequirements,
        daily: AppState.dailyRequirements || (AppState.dailyRequirements = {}) };
}
function _staffOf(dept) {
  if (dept === 'cast')     return AppState.staff.filter(s => getStaffDepartment(s) === 'cast');
  if (dept === 'employee') return AppState.staff.filter(s => getStaffDepartment(s) !== 'cast');
  return AppState.staff;   // 合算モード
}

/**
 * プランを実際の設定に反映する。戻り値は画面に出す変更内容の説明。
 */
function applyRelaxPlan(plan) {
  const p = plan.params || {};
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const changes = [];

  if (plan.id === 'daily-req-reset') {
    const st = _reqStoreFor(p.dept);
    // 合算モードでは社員・キャスト両方の上乗せを戻す
    const stores = (p.dept === 'all')
      ? [{ req: AppState.roleRequirements, daily: AppState.dailyRequirements || {} },
         { req: AppState.roleRequirementsCast || {}, daily: AppState.dailyRequirementsCast || {} }]
      : [st];
    stores.forEach(({ req, daily }) => {
      Object.keys(daily).forEach(k => {
        const base = req[k] || 0;
        Object.keys(daily[k]).forEach(d => {
          if (daily[k][d] > base) { changes.push(`${k} ${d}日: ${daily[k][d]}人 → ${base}人`); delete daily[k][d]; }
        });
      });
    });
  } else if (plan.id === 'paid-reduce') {
    // 有給日数の多い人から1日ずつ削る（偏らないように順番に回す）
    let rest = p.reduce || 0;
    const list = _staffOf(p.dept).filter(s => (parseInt(s.paidLeave) || 0) > 0);
    while (rest > 0 && list.some(s => (parseInt(s.paidLeave) || 0) > 0)) {
      list.sort((a, b) => (parseInt(b.paidLeave) || 0) - (parseInt(a.paidLeave) || 0));
      const s = list[0];
      const before = parseInt(s.paidLeave) || 0;
      if (before <= 0) break;
      s.paidLeave = before - 1; rest--;
      changes.push(`${s.name}: 有給 ${before}日 → ${s.paidLeave}日`);
    }
  } else if (plan.id === 'maxoff-reduce') {
    _staffOf(p.dept).forEach(s => {
      const before = s.maxOff || 0;
      s.maxOff = Math.max(0, before - (p.days || 1));
      if (s.maxOff !== before) changes.push(`${s.name}: 公休 ${before}日 → ${s.maxOff}日`);
    });
  } else if (plan.id === 'req-reduce') {
    const st = _reqStoreFor(p.dept);
    const before = st.req[p.key] || 0;
    st.req[p.key] = Math.max(0, before - 1);
    changes.push(`${p.key}: ${before}人 → ${st.req[p.key]}人`);
  } else if (plan.id === 'rule-soften') {
    if (!AppState.settings.ruleLevels) AppState.settings.ruleLevels = {};
    const before = getRuleLevel(p.type);
    AppState.settings.ruleLevels[p.type] = p.to;
    const LV = { must: '🔴絶対', should: '🟡できれば', off: 'OFF' };
    const nm = (typeof getViolationLabel === 'function') ? getViolationLabel(p.type) : p.type;
    changes.push(`ルール「${nm}」: ${LV[before] || before} → ${LV[p.to] || p.to}`);
  } else if (plan.id === 'balance-tol') {
    const before = parseInt(AppState.settings.balanceTolerance) || 0;
    AppState.settings.balanceTolerance = p.to;
    changes.push(`早遅バランスの許容幅: ${before}日 → ${p.to}日`);
  } else if (plan.id === 'maxoffrun') {
    const before = getMaxOffRun();
    AppState.settings.maxConsecutiveOff = p.to;
    changes.push(`連休の上限: ${before}日 → ${p.to}日`);
  } else if (plan.id === 'maxcons') {
    // 6連勤以上はコンプライアンス違反。上限を6日以上にする設定はしない（念のための守り）
    if (!(p.to < COMPLIANCE_CONS_DAYS)) {
      toast(`⛔ 連勤の上限を${p.to}日にはできません（${COMPLIANCE_CONS_DAYS}連勤以上はコンプラ違反）`, 'error', 7000);
      return changes;   // 何も変えない（呼び出し側は空の一覧を「変更なし」として扱う）
    }
    const before = parseInt(AppState.settings.maxConsecutive) || 0;
    AppState.settings.maxConsecutive = p.to;
    changes.push(`連勤の上限: ${before}日 → ${p.to}日`);
  } else if (plan.id === 'skill-min') {
    const sk = (AppState.skills || [])[p.index];
    if (sk) {
      const base = (sk.req != null ? sk.req : sk.lateReq) || 0;
      const before = (sk.min != null && sk.min >= 0) ? sk.min : base;
      sk.min = p.to;
      changes.push(`スキル「${sk.name}」の最低人数: ${before}人 → ${p.to}人`);
    }
  }
  void days;
  return changes;
}

// 痛みの表示
const _RELAX_PAIN = {
  small: { label: '影響 小', color: '#2f855a', bg: 'rgba(56,161,105,.14)' },
  mid:   { label: '影響 中', color: '#b7791f', bg: 'rgba(214,158,46,.16)' },
  large: { label: '影響 大', color: '#c53030', bg: 'rgba(229,62,62,.14)' },
};

function showRelaxModal() {
  if (!AppState.staff.length || !AppState.settings.targetMonth) {
    toast('スタッフと対象年月を設定してください', 'error');
    return;
  }
  const plans = buildRelaxPlans(AppState.violations);
  // 人日の収支を最初に見せる（何人日足りないのかが分かれば、あとは引き算）
  const _days = getDaysInMonth(AppState.settings.targetMonth);
  const capLines = getDepartmentGroups(AppState.staff).map(g => {
    const c = calcCapacity(g, _days);
    const label = (getDepartmentGroups(AppState.staff).length > 1) ? `【${g.label}】` : '';
    return c.surplus < 0
      ? `${label}必要 ${c.required}人日 ／ 出せる ${c.avail}人日 → <b style="color:var(--danger)">${-c.surplus}人日 足りません</b>`
      : `${label}必要 ${c.required}人日 ／ 出せる ${c.avail}人日 → <b style="color:var(--success)">余裕 ${c.surplus}人日</b>`;
  }).join('<br>');
  const vioN = (AppState.violations || []).length;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';

  let lastGroup = null;
  const body = plans.length ? plans.map((pl, i) => {
    const pain = _RELAX_PAIN[pl.pain] || _RELAX_PAIN.mid;
    let head = '';
    if (pl.group !== lastGroup) {
      lastGroup = pl.group;
      head = (pl.group === 'capacity')
        ? `<h4 style="margin:18px 0 2px">① 人手を増やす<span class="hint" style="font-weight:400"> — 人員不足・公休不足の根本原因はここです</span></h4>`
        : `<h4 style="margin:18px 0 2px">② ルールを緩める<span class="hint" style="font-weight:400"> — 人手は増減しません。並び方のエラーに効きます</span></h4>`;
    }
    // 実際に測って「減らない」と分かった案は、はっきりそう見せる。
    // 押しても何も起きない案が、効く案と同じ見た目で並んでいると混乱するため。
    // 件数は同じでも超過日数が減る（軽くなる）案は「効果なし」にしない
    const dud = !!(pl.measured && pl.measured.gain <= 0 && !pl.measured.lighter);
    const good = !!(pl.measured && pl.measured.gain > 0);
    const lighter = !!(pl.measured && pl.measured.gain <= 0 && pl.measured.lighter);
    return head + `<div class="relax-item" style="border:1px solid ${dud ? 'var(--border)' : good ? 'color-mix(in srgb, var(--success) 45%, transparent)' : 'var(--border)'};border-radius:10px;padding:14px 16px;margin:10px 0;background:var(--surface-2);${dud ? 'opacity:.62' : ''}">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
        <span style="font-weight:700;color:var(--accent)">案${i + 1}</span>
        <span style="font-weight:700;flex:1;min-width:200px">${escapeHtml(pl.title)}</span>
        ${dud ? `<span style="font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;color:var(--text-soft);background:var(--surface)">効果なし</span>` : ''}
        ${good ? `<span style="font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;color:#276749;background:color-mix(in srgb, var(--success) 20%, var(--surface))">−${pl.measured.gain}件</span>` : ''}
        ${lighter ? `<span style="font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;color:#276749;background:color-mix(in srgb, var(--success) 20%, var(--surface))">軽くなる</span>` : ''}
        <span style="font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;color:${pain.color};background:${pain.bg}">${pain.label}</span>
        <span style="font-size:13px;font-weight:700;color:var(--text)">${escapeHtml(pl.effect)}</span>
      </div>
      <div style="font-size:13px;line-height:1.75;color:var(--text-soft);white-space:pre-wrap">${escapeHtml(pl.detail)}</div>
      <div style="font-size:13px;line-height:1.7;color:var(--text-soft);margin-top:4px">→ ${escapeHtml(pl.after || '')}</div>
      ${pl.manual
        ? `<div class="hint" style="margin-top:8px">${pl.id === 'balance-tol-max'
            ? '※ これはお知らせです。設定は変更しません'
            : '※ この案は自動では変更しません（希望休は必ず尊重するため）'}</div>`
        : `<button class="btn ${dud ? '' : 'btn-primary'}" data-relax="${i}" style="margin-top:10px">${dud ? 'それでもこの設定にする' : 'この設定にする'}</button>`}
    </div>`;
  }).join('') : `<div class="hint" style="padding:12px 0">いま提案できる緩和はありません。まず <b>🚀 シフト自動生成</b> を実行するか、<b>🔍 実現性チェック</b> で人手の過不足を確認してください。</div>`;

  modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;max-width:780px;width:100%;max-height:85vh;overflow:auto;padding:20px">
    <h3 style="margin:0 0 4px">🩹 エラー解消プラン</h3>
    <p class="hint" style="margin:0 0 8px">
      いまのエラーを消すために「どの設定をいくつ動かせばよいか」を並べています。
      <b>上にあるものほど現場への影響が小さい案</b>です。上から順に1つずつ試し、そのつど生成し直すのがおすすめです。
    </p>
    <div style="margin:10px 0;padding:12px 14px;border-radius:10px;background:var(--surface-2);
         border:1px solid var(--border);font-size:13px;line-height:1.8">
      ${capLines}${vioN ? `<br>直近の生成で残っているエラー: <b>${vioN}件</b>` : '<br><span class="hint">まだ生成していないため、エラー件数は反映されていません</span>'}
    </div>
    <div id="relaxDone" style="display:none;margin:10px 0;padding:12px 14px;border-radius:10px;
         background:color-mix(in srgb, var(--success) 14%, var(--surface));
         border:1px solid color-mix(in srgb, var(--success) 35%, transparent);font-size:13px;line-height:1.7"></div>
    ${body}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button id="relaxUndo" class="btn" style="display:none">↩ 変更を元に戻す</button>
      <button id="relaxClose" class="btn btn-primary">閉じる</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#relaxClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  const $done = modal.querySelector('#relaxDone');
  const $undo = modal.querySelector('#relaxUndo');

  modal.querySelectorAll('[data-relax]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pl = plans[parseInt(btn.dataset.relax)];
      if (!pl) return;
      _relaxUndo = snapshotForRelax();
      const changes = applyRelaxPlan(pl);
      autoSave();
      refreshAllUI();
      $done.style.display = 'block';
      $done.innerHTML = `✅ <b>設定を変更しました：${escapeHtml(pl.title)}</b><br>` +
        (changes.length
          ? changes.slice(0, 12).map(escapeHtml).join('<br>') + (changes.length > 12 ? `<br>…ほか ${changes.length - 12}件` : '')
          : '（変更対象はありませんでした）') +
        `<br><br>このあと <b>🚀 シフト自動生成</b> を実行してください。`;
      $undo.style.display = 'inline-flex';
      modal.querySelectorAll('[data-relax]').forEach(b => { b.disabled = true; b.textContent = '（他の案を試すには一度閉じてください）'; });
      toast('設定を変更しました。生成し直してください', 'success', 4000);
      $done.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  $undo.addEventListener('click', () => {
    if (!_relaxUndo) return;
    restoreFromRelax(_relaxUndo);
    _relaxUndo = null;
    autoSave();
    refreshAllUI();
    $done.innerHTML = '↩ <b>変更を元に戻しました。</b>';
    $undo.style.display = 'none';
    toast('元に戻しました', 'info');
  });
}


/* ===========================================
   余の解消（余ったコマを 有給 or 出勤 に振り替える）
   最終的にコマ数をぴったりにするための画面。
   「誰を・どの日に・どのシフトへ」は人が指定する。
   アプリはエラーの増減を計算して知らせ、実行するかは人が決める。
   =========================================== */

// いま表に出ている「余」を一覧にする
function listSurplusCells() {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const out = [];
  (AppState.staff || []).forEach(s => {
    for (let d = 1; d <= days; d++) {
      if (((AppState.shifts[s.id] || {})[d] || '') === '余') out.push({ id: s.id, name: s.name, day: d });
    }
  });
  return out;
}

// その人がその日に入れるシフト（担当シフト・早可/遅可の範囲）
// 責任者・総務（1日1人だけの役割）は除く。定数を増やすと必ず「重複」エラーになるため。
function candidateShiftsFor(staff, day) {
  const solo = (typeof SOLO_SHIFT_KEYS !== 'undefined') ? SOLO_SHIFT_KEYS : [];
  const roles = getWorkShiftKeys().filter(k => {
    const t = AppState.shiftTypes.find(x => x.key === k);
    return t && !t.isTraining;
  });
  return (staff.allowedShifts || []).filter(k => {
    if (!roles.includes(k)) return false;
    if (solo.indexOf(k) >= 0) return false;   // 早責/遅責/早総務/遅総務 は増やせない
    const p = staff.prefs || [];
    if (p.length) {
      if (isEarlyCategory(k) && !p.includes('早可')) return false;
      if (isLate(k) && !p.includes('遅可')) return false;
    }
    return true;
  });
}

// 変更を試して、前後を比べる（scoreViolations / scoreBetter / scoreWorsened）。
// 6連勤以上になる変更は止める。どれかが増えるときは confirm で「それでも実行するか」を聞く。
// @returns {ok:boolean, before:number, after:number, sd, message:string}
// 作り直し（adjust）を伴うときは計算なので、ほかの計算と同時に走らないようにする
// 確認（実行しますか？）を待つあいだも鍵を掛ける。掛けないと、答えないまま生成・月の切り替え・
// 取り込みができ、あとで「やめる」になったときに質問の前の状態へ丸ごと戻って、その間の
// 生成や片付けまで消えていた。
async function trySurplusChange(apply, opts) {
  const o = opts || {};
  if (!o.adjust && typeof o.confirm !== 'function') return _trySurplusChange(apply, o);
  if (!calcBegin(o.adjust ? '余の解消' : '余の解消（確認待ち）')) return { ok: false, busy: true, before: 0, after: 0, sd: null,
                                       message: 'ほかの計算中のため、実行しませんでした' };
  try { return await _trySurplusChange(apply, o); } finally { calcEnd(); }
}
async function _trySurplusChange(apply, opts) {
  const o = opts || {};
  // 取り消すときは、この変更で変えた所だけを戻す（まるごと戻すと、確認を待つ間にした
  // 希望の入力・必要人数・スタッフの追加などまで消えていた）。
  // 変えた所 = 変更の前と、変更（と周りの調整）の後で値が違うマス。戻すのは、
  // いまもその「後」の値のままのマスだけ（あとから別の編集をしたマスは触らない）。
  const MAPS = ['shifts', 'requests', 'fixedShifts', 'dailyRequirements', 'dailyRequirementsCast'];
  const snap = () => {
    const o2 = {};
    MAPS.forEach(k => { o2[k] = JSON.parse(JSON.stringify(AppState[k] || {})); });
    o2.paid = {}; (AppState.staff || []).forEach(s => { o2.paid[s.id] = s.paidLeave; });
    return o2;
  };
  const backup = snap();
  let changes = null;                 // [種類, 行, 列, 前の値, 後の値]
  const collectChanges = () => {
    const now = snap(), out = [];
    MAPS.forEach(k => {
      const A = backup[k], B = now[k];
      new Set([...Object.keys(A), ...Object.keys(B)]).forEach(id => {
        const a = A[id] || {}, b = B[id] || {};
        new Set([...Object.keys(a), ...Object.keys(b)]).forEach(d => {
          if (a[d] !== b[d]) out.push([k, id, d, a[d], b[d]]);
        });
      });
    });
    Object.keys(now.paid).forEach(id => { if (backup.paid[id] !== now.paid[id]) out.push(['paid', id, null, backup.paid[id], now.paid[id]]); });
    return out;
  };
  const restore = () => {
    if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
    (changes || collectChanges()).forEach(([k, id, d, from, to]) => {
      if (k === 'paid') {
        const s = (AppState.staff || []).find(x => x.id === id);
        if (s && s.paidLeave === to) s.paidLeave = from;
        return;
      }
      const M = AppState[k] || (AppState[k] = {});
      const row = M[id]; if (!row || row[d] !== to) return;   // あとから変えられたマスは触らない
      if (from === undefined) delete row[d]; else row[d] = from;
    });
    AppState.violations = checkViolations(AppState.shifts);
  };
  const beforeV = checkViolations(AppState.shifts);
  const before = beforeV.length;
  const bSc = scoreViolations(beforeV);
  // 元に戻すで、この変更だけを戻せるように履歴に積む（取り消したときは履歴も捨てる）
  if (typeof recordShiftHistory === 'function') recordShiftHistory();
  apply();
  // 周りのつじつまを、最小限の変更で合わせる
  if (o.adjust && typeof optimizeScheduleMILP === 'function') {
    try { await optimizeScheduleMILP(() => {}, { adjustMode: true, adjustK: (o.k || 24), fastMode: true }); }
    catch (_) { /* 調整できなくてもそのまま検証する */ }
  }
  changes = collectChanges();         // 確認を待つ前に、この変更で変えた所を覚えておく
  AppState.violations = checkViolations(AppState.shifts);
  const after = AppState.violations.length;
  const aSc = scoreViolations(AppState.violations);
  const sd = _scoreDiff(bSc, aSc, compWorsened(beforeV, AppState.violations).length > 0);
  const words = _diffWords(sd);
  // 6連勤以上（コンプラ違反）ができる・伸びる・つながる変更は、確認せずに止める
  if (sd.compUp) {
    restore();
    return { ok: false, blocked: true, before, after, sd,
             message: `⛔ 6連勤以上（コンプラ違反）になるため取り消しました（${words}）` };
  }
  // どれかが増える（🚨の種類・連勤の超過日数・🟡）ときは、取り消さずに本人へ確認する。
  // 合計件数では判断しない（合計が減っても🚨が増えることがある）。
  const up = scoreWorsened(aSc, bSc);
  if (up.length) {
    const hadCritical = up.some(x => x.key !== 'soft');
    const go = (typeof o.confirm === 'function')
      ? await o.confirm(sd, up)
      : confirm(`この変更で ${words}。\nそれでも実行しますか？`);
    if (!go) { restore(); return { ok: false, before, after, sd, cancelled: true, message: `${words}ため取り消しました` }; }
    autoSave();
    return { ok: true, before, after, sd, worsened: true, hadCritical, message: words };
  }
  autoSave();
  return { ok: true, before, after, sd, message: words };
}

function showSurplusResolveModal() {
  // 暗幕を張らない「動かせるパネル」にする。裏のシフト表を見ながら、
  // どこをどう直すか考えられるようにするため。
  // 開き直すときは、古いパネルの答えていない確認を「やめる」にしてから閉じる。
  // そのまま消すと、確認が残ったまま計算の鍵が外れなくなっていた。
  // 確認を「やめる」にしたときは、元に戻す処理が終わってから開き直す。
  const old = document.getElementById('surplusPanel');
  if (old) {
    const hadPending = typeof old._closePanel === 'function' ? old._closePanel() : (old.remove(), false);
    if (hadPending) { setTimeout(showSurplusResolveModal, 0); return; }
  }
  const modal = document.createElement('div');
  modal.id = 'surplusPanel';
  modal.style.cssText = 'position:fixed;right:24px;top:80px;width:min(820px,calc(100vw - 48px));z-index:10050';

  const days = getDaysInMonth(AppState.settings.targetMonth);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const dayLabel = (d) => {
    const dt = new Date(AppState.settings.targetMonth + '-' + String(d).padStart(2, '0') + 'T00:00:00');
    return `${d}日(${WD[dt.getDay()] || ''})`;
  };
  // その人のその日の状態を一言で（余 / 公休 / 出勤中 など）
  const cellOf = (id, d) => (AppState.shifts[id] || {})[d] || '';

  let lastMsg = null;      // 直近の結果メッセージ（再描画で消えないように覚えておく）
  let selPaid = { id: '', day: '' };
  let selWork = { id: '', day: '', key: '' };
  let selPair = { tutors: null, b: '', band: 'e' };   // 教育：指導役は複数候補／band: e=早番帯 l=遅番帯
  let pairRows = null;       // 探した候補日（再描画でも残す）
  let pos = null;            // 動かした位置（再描画で戻らないように覚えておく）
  let minimized = false;     // 小さくした状態かどうか

  const say = (text, ok, keep) => {
    if (!keep) lastMsg = { text, ok };
    const $m = modal.querySelector('#resolveMsg');
    if (!$m) return;
    $m.style.display = 'block';
    $m.style.background = ok ? 'color-mix(in srgb, var(--success) 14%, var(--surface))' : 'color-mix(in srgb, var(--danger) 12%, var(--surface))';
    $m.style.border = '1px solid ' + (ok ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'color-mix(in srgb, var(--danger) 35%, transparent)');
    $m.innerHTML = text;
  };

  // 「エラーが増えますが実行しますか？」をモーダル内で聞く。
  // 公休不足・連勤超過などの重要ルールが増える場合は、個人の希望と分けて表示する。
  // 答えを待っている確認。パネルを ✕ で閉じたら「やめる」として答え、変更を元に戻す。
  // 答えないまま閉じると、計算の鍵が外れずアプリが固まり、答えていない変更も表に残っていた。
  let pendingAsk = null, panelClosed = false;
  // 開いている間に表が変わったら（手で直す・月を変える・元に戻すなど）、おすすめを数え直す。
  // 確認待ち・計算中は数え直さない（変更の途中の表で数えてしまうため）。
  // マウスがパネルの上にある間は入れ替えない（読んでいる最中に中身が変わらないように）。
  // 入れ替えたときは「おすすめが変わりました」と知らせ、2秒間ボタンを押せなくする。
  modal.addEventListener('mouseenter', () => { mouseOnPanel = true; });
  modal.addEventListener('mouseleave', () => { mouseOnPanel = false; });
  const RECO_HOLD_MS = 2000;
  const fpTimer = setInterval(() => {
    if (!modal.isConnected) { clearInterval(fpTimer); return; }
    if (pendingAsk || mouseOnPanel || (typeof calcBusy === 'function' && calcBusy())) return;
    if (recoCache !== null && stateFp() !== recoFp) {
      recoCache = null; recoHoldUntil = Date.now() + RECO_HOLD_MS; render();
      say('🔄 表が変わったので、おすすめが変わりました。新しい一覧を確かめてから押してください。', false);
      setTimeout(() => { if (modal.isConnected) modal.querySelectorAll('[data-reco]').forEach(b => { b.disabled = false; }); }, RECO_HOLD_MS);
    }
  }, 1500);
  // パネルを閉じる（✕・開き直し）。答えていない確認は「やめる」にする。確認があれば true
  modal._closePanel = () => {
    panelClosed = true;
    const had = !!pendingAsk;
    if (pendingAsk) pendingAsk(false);
    modal.remove();
    // 元に戻す処理（答えを受け取った側）が終わってから画面を描き直す
    setTimeout(() => refreshAllUI(), 0);
    return had;
  };
  const askWorsen = (sd, up) => new Promise(resolve0 => {
    if (panelClosed) return resolve0(false);     // 計算中に閉じられていたら、聞かずにやめる
    const resolve = (v) => { pendingAsk = null; resolve0(v); };
    pendingAsk = resolve;
    const $m = modal.querySelector('#resolveMsg');
    const words = _diffWords(sd);
    if (!$m) return resolve(confirm(`${words}。実行しますか？`));
    const lab = (k) => k === 'over' ? '連勤の超過（日）' : k === 'bsOver' ? '切り替えの超過（回）' : k === 'soft' ? '🟡 注意'
      : ((typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[k]) || k);
    const crit = up.filter(x => x.key !== 'soft'), soft = up.filter(x => x.key === 'soft');
    const danger = crit.length > 0;
    const chips = (rows, color) => rows.map(r =>
      `<span style="display:inline-block;margin:3px 6px 0 0;padding:2px 9px;border-radius:999px;font-size:12px;
        background:color-mix(in srgb, ${color} 20%, var(--surface));border:1px solid color-mix(in srgb, ${color} 45%, transparent)">
        ${escapeHtml(lab(r.key))} ${r.from}→${r.to}</span>`).join('');
    $m.style.display = 'block';
    $m.style.background = danger ? 'color-mix(in srgb, var(--danger) 14%, var(--surface))'
                                 : 'color-mix(in srgb, var(--warning, #e6a700) 16%, var(--surface))';
    $m.style.border = '1px solid ' + (danger ? 'color-mix(in srgb, var(--danger) 50%, transparent)'
                                             : 'color-mix(in srgb, var(--warning, #e6a700) 45%, transparent)');
    $m.innerHTML = `
      ${danger
        ? `<div style="font-size:14px"><b>🚨 増える🚨があります</b></div>
           <div style="margin:4px 0 8px">${chips(crit, 'var(--danger)')}</div>`
        : `<div style="font-size:14px"><b>⚠️ 🟡（注意）だけが増えます</b></div>
           <div class="hint" style="margin:2px 0 6px">🚨（公休・連勤・人員など）は増えません。</div>`}
      ${soft.length && danger ? `<div style="margin:2px 0 8px">${chips(soft, 'var(--warning, #e6a700)')}</div>` : ''}
      <div style="margin-top:6px">${escapeHtml(words)}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="worsenYes" class="btn ${danger ? '' : 'btn-primary'}">${danger ? '🚨が増えても実行する' : '実行する'}</button>
        <button id="worsenNo" class="btn ${danger ? 'btn-primary' : ''}">やめる</button>
      </div>`;
    $m.querySelector('#worsenYes').addEventListener('click', () => resolve(true));
    $m.querySelector('#worsenNo').addEventListener('click', () => resolve(false));
  });

  // 誰を選ぶかの判断材料として、今月の有給数と余の数を名前の横に出す
  const staffOptions = (selId) => {
    const sur = {};
    listSurplusCells().forEach(c => { sur[c.id] = (sur[c.id] || 0) + 1; });
    return (AppState.staff || []).map(s => {
      const tag = `有給${s.paidLeave || 0}日` + (sur[s.id] ? `・余${sur[s.id]}` : '');
      return `<option value="${s.id}" ${selId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}（${tag}）</option>`;
    }).join('');
  };

  // その日に何人出勤しているか（どの日に人を足すか決める材料）
  const workersOn = (d) => (AppState.staff || []).reduce((a, s) =>
    a + (isWork((AppState.shifts[s.id] || {})[d] || '') ? 1 : 0), 0);

  // 日付の選択肢。いまの状態（余・公休・出勤中）を併記して選びやすくする
  const dayOptions = (id, selDay) => {
    let out = '';
    for (let d = 1; d <= days; d++) {
      const cur = cellOf(id, d);
      const tag = cur === '余' ? '・余' : cur === '公' ? '・公休' : cur === '有' ? '・有給' : cur ? '・' + cur : '';
      out += `<option value="${d}" ${String(selDay) === String(d) ? 'selected' : ''}>${dayLabel(d)}${tag}｜出勤${workersOn(d)}人</option>`;
    }
    return out;
  };

  // 余のマスごとに「有給にする／定数+1で出勤にする」を全部試し、
  // エラーが何件増えるかを測って良い順に返す。3つの方法が並んでいるだけでは
  // どれを使えばよいか分からない、という声への対応。
  let recoCache = null, recoDirty = false, recoFp = '';
  // 一覧が自動で入れ替わった直後は、少しの間ボタンを押せなくする（読んだ案と違う案を押さないように）
  let recoHoldUntil = 0, mouseOnPanel = false;
  // 表などの中身の「指紋」。おすすめを作ったときと違えば、一覧は古い
  // （パネルを開いたまま手で直す・月を変える・元に戻す、など）。
  const stateFp = () => JSON.stringify([AppState.settings.targetMonth, AppState.shifts, AppState.requests,
    AppState.fixedShifts, AppState.dailyRequirements, AppState.dailyRequirementsCast,
    (AppState.staff || []).map(s => [s.id, s.paidLeave])]);
  const buildReco = () => {
    recoFp = stateFp();
    const cells = listSurplusCells();
    if (!cells.length) return [];
    // 見積もりは、押したときと同じ変更で数える（有給なら希望「有」と有給日数+1、研修なら🔒固定も）。
    // 表だけを変えて数えていたため、「悪くなります」と出たのに押すと「変わりません」になっていた。
    const bk = {
      shifts: JSON.parse(JSON.stringify(AppState.shifts)),
      daily:  JSON.parse(JSON.stringify(AppState.dailyRequirements || {})),
      dailyC: JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {})),
      req:    JSON.parse(JSON.stringify(AppState.requests || {})),
      fixed:  JSON.parse(JSON.stringify(AppState.fixedShifts || {})),
      paid:   (AppState.staff || []).map(s => s.paidLeave),
    };
    const before = checkViolations(AppState.shifts).length;
    const beforeV0 = checkViolations(AppState.shifts);
    const restore = () => {
      AppState.shifts = JSON.parse(JSON.stringify(bk.shifts));
      AppState.dailyRequirements = JSON.parse(JSON.stringify(bk.daily));
      AppState.dailyRequirementsCast = JSON.parse(JSON.stringify(bk.dailyC));
      AppState.requests = JSON.parse(JSON.stringify(bk.req));
      AppState.fixedShifts = JSON.parse(JSON.stringify(bk.fixed));
      (AppState.staff || []).forEach((s, i) => { s.paidLeave = bk.paid[i]; });
    };
    const out = [];
    // 件数(n)は表示用、sd は比べ方（scoreBetter / scoreCompare。並べ替え・良し悪しに使う）
    const measure = (fn) => { let n; try { fn(); n = checkViolations(AppState.shifts); } catch (e) { n = null; } restore(); return n; };
    const entry = (o, aV) => Object.assign(o, { delta: aV.length - before, before, after: aV.length, sd: _diffOfLists(beforeV0, aV) });
    cells.forEach(c => {
      const st = AppState.staff.find(x => x.id === c.id); if (!st) return;
      // ㋐ その人のその日を有給にする
      {
        const n = measure(() => {   // 「有給にする」を押したときと同じ変更
          AppState.requests[c.id] = AppState.requests[c.id] || {};
          AppState.requests[c.id][c.day] = '有';
          AppState.shifts[c.id][c.day] = '有';
          st.paidLeave = (parseInt(st.paidLeave) || 0) + 1;
        });
        if (n != null) out.push(entry({ kind: 'paid', id: c.id, name: c.name, day: c.day }, n));
      }
      // ㋐' 指導役のそばで研修に入れる（研修は人員にカウントしないので定数を動かさない）
      {
        const pri2 = s2 => (POSITION_TYPES[s2.positionType] || {}).priority || 9;
        const bandOf2 = (k) => isEarlyCategory(k) ? 'e' : (isLate(k) ? 'l' : null);
        (AppState.shiftTypes || []).filter(t => t.isTraining).forEach(t => {
          const bd = bandOf2(t.key); if (!bd) return;
          const T = (AppState.staff || []).find(x => {
            if (x.id === c.id || pri2(x) >= pri2(st)) return false;
            const v = (AppState.shifts[x.id] || {})[c.day] || '';
            return v && isWork(v) && bandOf2(v) === bd;
          });
          if (!T) return;
          const n = measure(() => {   // 「研修で入れる」を押したときと同じ変更（🔒固定も）
            AppState.fixedShifts[c.id] = AppState.fixedShifts[c.id] || {};
            AppState.fixedShifts[c.id][c.day] = t.key;
            AppState.shifts[c.id][c.day] = t.key;
          });
          if (n != null) out.push(entry({ kind: 'train', id: c.id, name: c.name, day: c.day, key: t.key,
                                          tutor: T.name }, n));
        });
      }
      // ㋑ その日の必要人数を1人増やして出勤にする（入れるシフトぶん全部）
      candidateShiftsFor(st, c.day).forEach(k => {
        const cast = getStaffDepartment(st) === 'cast';
        const n = measure(() => {
          const store = cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                             : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
          const base = (cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[k] || 0;
          store[k] = store[k] || {};
          store[k][c.day] = (store[k][c.day] != null ? store[k][c.day] : base) + 1;
          AppState.fixedShifts[c.id] = AppState.fixedShifts[c.id] || {};   // 押したときと同じく固定も
          AppState.fixedShifts[c.id][c.day] = k;
          AppState.shifts[c.id][c.day] = k;
        });
        if (n != null) out.push(entry({ kind: 'work', id: c.id, name: c.name, day: c.day, key: k }, n));
      });
    });
    // 有給は日数に限りがあるので、同じ結果なら「研修 → 出勤 → 有給」の順にすすめる
    const rank = { train: 0, work: 1, paid: 2 };
    out.sort((a, b) => _diffCmp(a.sd, b.sd) || (rank[a.kind] - rank[b.kind]));
    // 6連勤以上ができる・伸びる案は、実行しても必ず止められるので、おすすめに出さない
    return out.filter(x => !(x.sd && x.sd.compUp));
  };

  const recoHtml = () => {
    if (recoCache === null) recoCache = buildReco();
    const r = recoCache;
    if (!r.length) return '';
    const best = r[0];
    const tag = (x) => `<b style="color:var(${_diffSign(x.sd) > 0 ? '--danger' : '--success'})">${_diffWords(x.sd)}</b>`;
    const line = (x, i) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0${i ? ';border-top:1px solid var(--border)' : ''}">
        <span style="flex:1;min-width:230px">${i === 0 ? '👑 ' : ''}<b>${escapeHtml(x.name)}さん ${x.day}日</b> を
          ${x.kind === 'paid' ? '<b>有給</b>にする'
            : x.kind === 'train' ? `<b>${escapeHtml(x.key)}</b> で ${escapeHtml(x.tutor)}さんのそばに入れる（人数は増えません）`
            : `<b>${escapeHtml(x.key)}</b> で出勤にする（その日の必要人数+1）`}
          　→ ${tag(x)}<span class="hint">（${x.before}件 → ${x.after}件）</span></span>
        <button class="btn ${i === 0 ? 'btn-primary' : ''}" data-reco="${i}"
          data-rid="${escapeHtml(x.id)}" data-rday="${x.day}" data-rkind="${x.kind}" data-rkey="${escapeHtml(x.key || '')}"
          ${Date.now() < recoHoldUntil ? 'disabled' : ''}>この通りにする</button>
      </div>`;
    const rest = r.slice(1, 4);
    return `<div style="border:2px solid var(--accent);border-radius:10px;padding:12px 14px;margin:10px 0;background:color-mix(in srgb, var(--accent) 7%, var(--surface))">
      <div style="font-weight:700;margin-bottom:4px">👑 おすすめ（迷ったらこれを押すだけで終わります）</div>
      <p class="hint" style="margin:0 0 6px">余のマスごとに、有給にした場合と出勤にした場合を全部試し、エラーの増減を数えて良い順に並べました。</p>
      ${line(best, 0)}
      ${rest.length ? `<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">ほかの案も見る（${rest.length}件）</summary>${rest.map((x, i) => line(x, i + 1)).join('')}</details>` : ''}
      ${planHtml()}
    </div>`;
  };

  // 組み直して比べた結果
  const planHtml = () => {
    const allBad = recoCache && recoCache.length && recoCache.every(x => _diffSign(x.sd) > 0 || x.kind === 'paid');
    if (!planRows) {
      return `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">
        <div class="hint" style="margin-bottom:6px">
          ${allBad ? '<b>上の案がどれもエラーを増やす場合は、こちらをお試しください。</b><br>' : ''}
          上の案は<b>いまの表を動かさずに1マスだけ差し替えた場合</b>の数字です。
          前後が埋まっている人は必ず連勤超過になるため、良い案が出ないことがあります。<br>
          <b>入れる日を決めてから表全体を組み直す</b>と、余の位置ごと動かせます。
          定数を1人増やして早番・遅番に入れる案を中心に、研修の案もあわせて比べます。
        </div>
        <button id="planSearch" class="btn btn-primary">🔁 組み直して比べる（約90秒）</button>
        <span class="hint" style="margin-left:8px">3通りを同時に計算します</span>
        <div id="planProg" style="margin-top:8px"></div>
      </div>`;
    }
    const b = planRows.base;
    const rows = planRows.rows;
    const tag = (x) => {
      const d = (x.sc && b.sc) ? _scoreDiff(b.sc, x.sc, x.compUp) : null;
      const sg = _diffSign(d);
      return `<b style="color:var(${sg !== null && sg <= 0 ? '--success' : '--danger'})">${_diffWords(d)}</b>`;
    };
    return `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">
      <div style="font-weight:700;margin-bottom:4px">🔁 組み直して比べた結果</div>
      <p class="hint" style="margin:0 0 6px">入れる日を決めてから表全体を作り直し、実際の結果で比べました。
        何も足さずに組み直すと <b>${b.n}件・余${b.sur}コマ</b> です。</p>
      ${rows.map((x, i) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0${i ? ';border-top:1px solid var(--border)' : ''}">
        <span style="flex:1;min-width:230px">${i === 0 ? '👑 ' : ''}<b>${escapeHtml(x.name)}さん ${x.day}日</b> を
          <b>${escapeHtml(x.key)}</b> で ${escapeHtml(x.tutor)}さんのそばに
          <span class="hint">（${x.kind === 'work' ? 'その日の必要人数+1' : '人数は増やさない'}）</span>　→ ${tag(x)}
          <span class="hint">・余 ${x.sur}コマ</span></span>
        ${(x.compUp || (x.sc && b.sc && x.sc.comp > b.sc.comp))
          ? '<span class="hint">⛔ 6連勤以上になるため選べません</span>'
          : `<button class="btn ${i === 0 ? 'btn-primary' : ''}" data-plan="${i}">この通りに作り直す</button>`}
      </div>`).join('')}
      <div style="margin-top:8px">
        ${planRows.left ? `<button id="planMore" class="btn btn-primary">➕ さらに候補を探す（残り${planRows.left}件・約90秒）</button>` : '<span class="hint">ほかに候補はありません。</span>'}
        <button id="planSearch" class="btn" style="margin-left:6px">🔁 最初から探し直す</button>
        <div id="planProg" style="margin-top:8px"></div></div>
    </div>`;
  };

  const render = () => {
    const list = listSurplusCells();
    if (recoDirty) { recoCache = null; recoDirty = false; }
    const total = list.length;
    // 余の内訳（誰に何コマ）
    const byStaff = {};
    list.forEach(c => { (byStaff[c.id] || (byStaff[c.id] = { name: c.name, days: [] })).days.push(c.day); });
    const breakdown = total
      ? Object.keys(byStaff).map(id => `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:999px;background:var(--surface-3);font-size:12px">
          ${escapeHtml(byStaff[id].name)} ${byStaff[id].days.length}コマ（${byStaff[id].days.join('・')}日）</span>`).join('')
      : '<span class="hint">余はありません 🎉 コマ数はぴったりです。</span>';

    // 初期値は「余が出ている本人・その日」にする。全員の先頭を出していたため、
    // 余と無関係な人が選ばれ、「この人が入れるシフトがありません」という
    // 行き止まりが最初に表示されていた。
    if (!selPaid.id) selPaid.id = list.length ? list[0].id : (AppState.staff[0] || {}).id || '';
    if (!selWork.id) selWork.id = list.length ? list[0].id : (AppState.staff[0] || {}).id || '';
    if (!selPaid.day && list.length) selPaid.day = list[0].day;
    if (!selWork.day && list.length) selWork.day = list[0].day;

    const wStaff = AppState.staff.find(x => x.id === selWork.id) || {};
    const cands = candidateShiftsFor(wStaff, parseInt(selWork.day) || 1);
    if (cands.length && !cands.includes(selWork.key)) selWork.key = cands[0];

    const pStaff = AppState.staff.find(x => x.id === selPaid.id) || {};

    // 教育: 既定は「副店長・チーフ」を指導役の候補に、いちばん下の役職を教わる人に
    const pri = s2 => (POSITION_TYPES[s2.positionType] || {}).priority || 9;
    if (!selPair.tutors) {
      const list = (AppState.staff || []);
      selPair.tutors = list.filter(x => pri(x) <= 2).map(x => x.id);
      if (!selPair.tutors.length) {
        const sorted = list.slice().sort((x, y) => pri(x) - pri(y));
        selPair.tutors = sorted.slice(0, 2).map(x => x.id);
      }
    }
    if (!selPair.b) {
      // 余が出ている本人を既定にする。無関係な人が既定だと、そのままでは
      // 余が減らない候補ばかり並んでしまう。
      const owner = list[0];
      if (owner) {
        selPair.b = owner.id;
        selPair.tutors = selPair.tutors.filter(t => t !== owner.id);
      } else {
        const sorted = (AppState.staff || []).slice().sort((x, y) => pri(x) - pri(y));
        const cand = sorted.filter(x => !selPair.tutors.includes(x.id));
        if (cand.length) selPair.b = cand[cand.length - 1].id;
        else if (sorted.length) selPair.b = sorted[sorted.length - 1].id;
      }
    }

    modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35);border:1px solid var(--border)">
      <div id="surplusDrag" style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:move;user-select:none;background:var(--surface-2);border-radius:12px 12px 0 0">
        <h3 style="margin:0;flex:1;font-size:16px">⚖️ 余の解消</h3>
        <span class="hint" style="font-size:11px">ここをつかんで動かせます</span>
        <button id="surplusMin" class="btn" style="padding:2px 10px" title="小さくして表を見る">▁</button>
        <button id="surplusX" class="btn" style="padding:2px 10px" title="閉じる">✕</button>
      </div>
      <div id="surplusBody" style="overflow:auto;padding:16px 20px 20px">
      <p class="hint" style="margin:0 0 10px">
        余（人員余り）を、<b>有給</b>にするか、<b>その日の必要人数を1人増やして出勤</b>にするかで埋めます。
        <b>誰を・どの日に入れるかは、あなたが自由に指定できます。</b>
        エラーが増える指定は警告しますが、実行するかはご自身で選べます。
      </p>

      <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--surface-2)">
        <div style="font-weight:700;margin-bottom:6px">残りの余：<span style="font-size:18px">${total}</span> コマ</div>
        <div>${breakdown}</div>
      </div>

      <div id="resolveMsg" style="display:none;margin:10px 0;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.7"></div>

      ${recoHtml()}

      <details style="margin:10px 0"><summary style="cursor:pointer;font-weight:700">自分で指定する（上級者向け）</summary>

      <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0">
        <div style="font-weight:700;margin-bottom:8px">🏖 有給を入れる</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="paidStaff" style="min-width:150px">${staffOptions(selPaid.id)}</select>
          <select id="paidDay" style="min-width:130px">${dayOptions(selPaid.id, selPaid.day)}</select>
          <button id="paidGo" class="btn btn-primary">有給にする</button>
          <span class="hint">現在の有給日数：${pStaff.paidLeave || 0}日 → 実行すると +1日</span>
        </div>
        <div id="previewPaid" style="margin-top:8px;font-size:13px"></div>
      </div>

      <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0">
        <div style="font-weight:700;margin-bottom:8px">👥 出勤を増やす（その日の必要人数を+1）</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="workStaff" style="min-width:150px">${staffOptions(selWork.id)}</select>
          <select id="workDay" style="min-width:130px">${dayOptions(selWork.id, selWork.day)}</select>
          ${cands.length
            ? `<select id="workKey" style="min-width:100px">${cands.map(k => `<option value="${k}" ${selWork.key === k ? 'selected' : ''}>${escapeHtml(k)}</option>`).join('')}</select>
               <button id="workGo" class="btn btn-primary">出勤にする（定数+1）</button>`
            : '<span class="hint">この人が入れるシフトがありません（責任者・総務は1日1人のため増やせません）</span>'}
        </div>
        <div id="previewWork" style="margin-top:8px;font-size:13px"></div>
      </div>

      </details>

      <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0">
        <div style="font-weight:700;margin-bottom:4px">🎓 そばで教える日を探す（教育・トレーニング用）</div>
        <p class="hint" style="margin:0 0 8px">
          余った人手を教育に使うとき用です。<b>指導役と同じ時間帯</b>に教わる人を入れられる日を探します。<br>
          指導役がすでにその時間帯に出勤している日なら、<b>予定を動かさずに教わる人を足すだけ</b>で済みます。
        </p>
        <div style="margin-bottom:8px">
          <div class="hint" style="margin-bottom:4px">指導役の候補（この中の<b>誰か1人でも</b>いる日を探します）</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)">
            ${(AppState.staff || []).map(x => `<label style="white-space:nowrap;font-size:13px">
              <input type="checkbox" data-tutor="${x.id}" ${selPair.tutors.includes(x.id) ? 'checked' : ''}/>
              ${escapeHtml(x.name)}<span class="hint">（${escapeHtml((POSITION_TYPES[x.positionType] || {}).label || '－')}）</span></label>`).join('')}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="hint">のそばに</span>
          <select id="pairB" style="min-width:150px">${staffOptions(selPair.b)}</select>
          <select id="pairBand" style="min-width:100px">
            <option value="e" ${selPair.band === 'e' ? 'selected' : ''}>早番帯</option>
            <option value="l" ${selPair.band === 'l' ? 'selected' : ''}>遅番帯</option>
          </select>
          <button id="pairFind" class="btn btn-primary">入れられる日を探す</button>
        </div>
        <div id="pairResult" style="margin-top:10px;font-size:13px"></div>
      </div>

      </div>
    </div>`;
    bind();
    refreshPreview();
    if (lastMsg) say(lastMsg.text, lastMsg.ok, true);   // 再描画後もメッセージを残す
  };

  // 押す前に「この指定だと何がどうなるか」を先に計算する。
  // 実際には変えず、調べたあとで必ず元に戻す。
  const preview = (apply) => {
    const bk = {
      shifts: JSON.parse(JSON.stringify(AppState.shifts)),
      daily:  JSON.parse(JSON.stringify(AppState.dailyRequirements || {})),
      dailyC: JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {})),
    };
    const bV = checkViolations(AppState.shifts);
    let after, sd;
    try {
      apply();
      const aV = checkViolations(AppState.shifts);
      after = aV.length;
      sd = _diffOfLists(bV, aV);
    } finally {
      AppState.shifts = bk.shifts;
      AppState.dailyRequirements = bk.daily;
      AppState.dailyRequirementsCast = bk.dailyC;
    }
    return { before: bV.length, after, sd };
  };

  // プレビューの結果を1行で表す
  // 判定は scoreBetter / scoreWorsened（合計件数では決めない）。6連勤以上になるなら ⛔。
  const previewLine = (r) => {
    if (!r || !r.sd) return '';
    const sg = _diffSign(r.sd);
    const comp = r.sd.compUp;
    const icon = comp ? '⛔' : sg <= 0 ? '✅' : scoreWorsened(r.sd.a, r.sd.b).some(x => x.key !== 'soft') ? '🚨' : '⚠️';
    const col = comp || icon === '🚨' ? 'var(--danger)' : icon === '⚠️' ? '#b7791f' : 'var(--success)';
    return `<span style="color:${col};font-weight:700">${icon} ${escapeHtml(_diffWords(r.sd))}</span>`
         + (comp ? '<span class="hint">（この指定は実行できません）</span>' : '');
  };

  // いまの選択内容でプレビューを出しなおす
  const refreshPreview = () => {
    const $p = modal.querySelector('#previewPaid');
    if ($p) {
      const id = selPaid.id, d = parseInt(selPaid.day);
      const st = AppState.staff.find(x => x.id === id);
      $p.innerHTML = (st && d)
        ? previewLine(preview(() => {
            AppState.shifts[id] = AppState.shifts[id] || {};
            AppState.shifts[id][d] = '有';
          }))
        : '';
    }
    const $w = modal.querySelector('#previewWork');
    if ($w) {
      const id = selWork.id, d = parseInt(selWork.day), key = selWork.key;
      const st = AppState.staff.find(x => x.id === id);
      $w.innerHTML = (st && d && key)
        ? previewLine(preview(() => {
            const cast = getStaffDepartment(st) === 'cast';
            const store = cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                               : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
            const base = (cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[key] || 0;
            store[key] = store[key] || {};
            store[key][d] = (store[key][d] != null ? store[key][d] : base) + 1;
            AppState.shifts[id] = AppState.shifts[id] || {};
            AppState.shifts[id][d] = key;
          })) + '<span class="hint"> ※つじつま合わせ前の目安です</span>'
        : '';
    }
  };

  // 教育ペア: 指導役と同じ時間帯（早番帯／遅番帯）に、教わる人を入れられる日を探す。
  // 指導役がすでにその時間帯に入っている日なら、教わる人を足すだけで済む。
  const bandOf = (k) => isEarlyCategory(k) ? 'e' : (isLate(k) ? 'l' : null);
  const bandLabel = (b) => b === 'e' ? '早番帯' : '遅番帯';

  // 教わる人が、その時間帯で入れるシフト。
  // ① 担当できる通常シフト（1日1人の役は増やせないので除く）
  // ② 研修シフト（人員にカウントされないので、定数を変えずに横につけられる）
  //    ＝ 担当シフトが「1日1人の役」だけの人でも、教育に入れられる
  const trainingKeys = (band) => (AppState.shiftTypes || [])
    .filter(t => t.isTraining && bandOf(t.key) === band)
    .map(t => t.key);
  const learnerKeys = (st, band) =>
    candidateShiftsFor(st, 1).filter(k => bandOf(k) === band).concat(trainingKeys(band));
  const isTrainKey = (k) => (AppState.shiftTypes || []).some(t => t.key === k && t.isTraining);

  const findPairDays = (tutorIds, idL, band) => {
    const L = AppState.staff.find(x => x.id === idL);
    const tutors = (tutorIds || []).map(id => AppState.staff.find(x => x.id === id)).filter(Boolean)
                    .filter(x => x.id !== idL);
    if (!L || !tutors.length || !band) return [];
    const lkeys = learnerKeys(L, band);
    if (!lkeys.length) return [];
    const castL = getStaffDepartment(L) === 'cast';
    const rows = [];
    for (let d = 1; d <= days; d++) {
      const vl = cellOf(idL, d);
      // 教わる人が空いている日だけが対象
      const freeL = !vl || vl === '余' || isPublicOff(vl);
      if (!freeL) continue;
      // 候補のうち、その日その時間帯にいる人を探す（いなければ入れられる人を探す）
      let T = null, vt = '', mode = null, tkeysFree = [];
      for (const t of tutors) {                       // ① すでにその時間帯にいる人を優先
        const v = cellOf(t.id, d);
        if (v && isWork(v) && bandOf(v) === band) { T = t; vt = v; mode = 'already'; break; }
      }
      if (!T) for (const t of tutors) {               // ② いなければ、その時間帯に入れる人
        const v = cellOf(t.id, d);
        const kf = candidateShiftsFor(t, 1).filter(k => bandOf(k) === band);
        if ((!v || v === '余' || isPublicOff(v)) && kf.length) { T = t; vt = v; mode = 'both'; tkeysFree = kf; break; }
      }
      if (!mode) continue;
      const idT = T.id;
      // 教わる人のシフトは、いちばんエラーが増えないものを選ぶ
      let best = null;
      lkeys.forEach(lk => {
        const r = preview(() => {
          if (!isTrainKey(lk)) {   // 研修は人員にカウントされないので定数はそのまま
            const store = castL ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                                : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
            const base = (castL ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[lk] || 0;
            store[lk] = store[lk] || {};
            store[lk][d] = (store[lk][d] != null ? store[lk][d] : base) + 1;
          }
          AppState.shifts[idL] = AppState.shifts[idL] || {}; AppState.shifts[idL][d] = lk;
          if (mode === 'both') {
            const tk = tkeysFree[0];
            const st2 = getStaffDepartment(T) === 'cast'
              ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
              : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
            const b2 = (getStaffDepartment(T) === 'cast' ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[tk] || 0;
            st2[tk] = st2[tk] || {};
            st2[tk][d] = (st2[tk][d] != null ? st2[tk][d] : b2) + 1;
            AppState.shifts[idT] = AppState.shifts[idT] || {}; AppState.shifts[idT][d] = tk;
          }
        });
        if (!best || _diffCmp(r.sd, best.sd) < 0) best = Object.assign({ lk }, r);
      });
      if (!best) continue;
      rows.push({ d, mode, tutorId: idT, tutorName: T.name, lk: best.lk, tk: mode === 'both' ? tkeysFree[0] : vt,
                  add: best.after - best.before, before: best.before, after: best.after, sd: best.sd,
                  wasSurplus: (vl === '余' ? 1 : 0) + (vt === '余' ? 1 : 0) });
    }
    // 6連勤以上になる日は出さない。並べ方は scoreCompare（① 6連勤以上 ② 人員不足
    // ③ 🚨 ④ 連勤の超過日数 ⑤ 🟡）、同じなら指導役がすでにいる日、次に余を消せる日
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].sd && rows[i].sd.compUp) rows.splice(i, 1);
    rows.sort((x, y) => _diffCmp(x.sd, y.sd)
                     || (x.mode === 'already' ? 0 : 1) - (y.mode === 'already' ? 0 : 1)
                     || y.wasSurplus - x.wasSurplus || x.d - y.d);
    return rows;
  };

  // 候補日の一覧を描く
  const renderPairRows = () => {
    const $r = modal.querySelector('#pairResult');
    if (!$r) return;
    if (!pairRows) { $r.innerHTML = ''; return; }
    const L = AppState.staff.find(x => x.id === selPair.b) || {};
    if (!pairRows.length) {
      $r.innerHTML = `<span class="hint">指導役の候補と同じ${bandLabel(selPair.band)}に
        ${escapeHtml(L.name || '')}を入れられる日がありませんでした。
        指導役の候補を増やす、時間帯を変える、${escapeHtml(L.name || '')}の休みを空ける、などをお試しください。</span>`;
      return;
    }
    const top = pairRows.slice(0, 8);
    $r.innerHTML = `<div class="hint" style="margin-bottom:6px">
        ${escapeHtml(L.name || '')}を<b>${bandLabel(selPair.band)}</b>に入れられる日（エラーが増えにくい順）</div>`
      + top.map(r => {
          const tag = previewLine(r);
          const note = isTrainKey(r.lk) ? '<span class="hint">（研修なので人員にはカウントされず、定数も増えません）</span>' : '';
          const how = r.mode === 'already'
            ? `指導役 <b>${escapeHtml(r.tutorName)}</b> が<b>${escapeHtml(r.tk)}</b>で出勤済 ／ ${escapeHtml(L.name)}を<b>${escapeHtml(r.lk)}</b>で追加${note}`
            : `指導役 <b>${escapeHtml(r.tutorName)}</b> を<b>${escapeHtml(r.tk)}</b>・${escapeHtml(L.name)}を<b>${escapeHtml(r.lk)}</b>で2人とも追加${note}`;
          return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px dashed var(--border)">
            <b style="min-width:78px">${dayLabel(r.d)}</b>
            <span style="flex:1;min-width:260px">${tag}
              <span class="hint">${r.wasSurplus ? '・余を' + r.wasSurplus + 'コマ消せます' : ''}</span>
              <br><span class="hint">${how}</span></span>
            <button class="btn" data-pairgo="${r.d}">この日に入れる</button>
          </div>`;
        }).join('')
      + (pairRows.length > top.length ? `<div class="hint" style="margin-top:6px">※ 他に ${pairRows.length - top.length} 日あります（エラーが多いため省略）</div>` : '')
      + '<div class="hint" style="margin-top:6px">※ つじつま合わせ前の目安です</div>';
    $r.querySelectorAll('[data-pairgo]').forEach(btn => btn.addEventListener('click', () => applyPair(parseInt(btn.dataset.pairgo))));
  };

  // 選んだ日に配置する
  const applyPair = async (d) => {
    const row = (pairRows || []).find(x => x.d === d);
    const T = row && AppState.staff.find(x => x.id === row.tutorId);
    const L = AppState.staff.find(x => x.id === selPair.b);
    if (!row || !T || !L) return;
    busy(true);
    say('⏳ 周りのつじつまを合わせています…', true, true);
    const bump = (st, key) => {
      if (!isTrainKey(key)) {   // 研修は人員にカウントされないので定数はそのまま
        const cast = getStaffDepartment(st) === 'cast';
        const store = cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                           : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
        const base = (cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[key] || 0;
        store[key] = store[key] || {};
        store[key][d] = (store[key][d] != null ? store[key][d] : base) + 1;
      }
      AppState.fixedShifts[st.id] = AppState.fixedShifts[st.id] || {};
      AppState.fixedShifts[st.id][d] = key;
      AppState.shifts[st.id] = AppState.shifts[st.id] || {};
      AppState.shifts[st.id][d] = key;
    };
    const r = await trySurplusChange(() => {
      bump(L, row.lk);
      if (row.mode === 'both') bump(T, row.tk);
      else {  // 指導役はすでに出勤済み。動かされないよう固定だけしておく
        AppState.fixedShifts[T.id] = AppState.fixedShifts[T.id] || {};
        AppState.fixedShifts[T.id][d] = row.tk;
      }
    }, { adjust: true, k: 32, confirm: askWorsen });
    busy(false);
    say(r.ok ? `${r.hadCritical ? '🚨' : r.worsened ? '⚠️' : '✅'} ${d}日 ${escapeHtml(T.name)}（${escapeHtml(row.tk)}）のそばに ${escapeHtml(L.name)}（${escapeHtml(row.lk)}）を入れました（${r.message}）。${diffText(r)}`
             : `↩ ${d}日の指定を取り消しました。${r.message}`, r.ok && !r.worsened);
    pairRows = null; recoDirty = true;
    renderResultTable(); render();
  };

  // 実行後の結果に「何が増えたか」を添える
  const diffText = (r) => {
    const sd = r && r.sd; if (!sd) return '';
    const up = scoreWorsened(sd.a, sd.b);
    if (!up.length) return '';
    const lab = (k) => k === 'comp' ? '⛔コンプラ違反' : k === 'over' ? '連勤の超過' : k === 'bsOver' ? '切り替えの超過' : k === 'soft' ? '🟡'
      : ((typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[k]) || k);
    return `<br><span class="hint">増えたもの：${up.map(x => escapeHtml(lab(x.key)) + ` ${x.from}→${x.to}${x.key === 'over' ? '日' : x.key === 'bsOver' ? '回' : '件'}`).join('、')}</span>`;
  };

  const busy = (on) => modal.querySelectorAll('button, select').forEach(el => {
    if (['surplusX', 'surplusMin'].indexOf(el.id) >= 0) return;   // 閉じる・最小化は常に押せる
    el.disabled = on;
  });

  // ===== 組み直して比べる =====
  // いまの表を固定したまま1マスだけ差し替えて数える方法では、その人の前後が
  // 埋まっていると必ず連勤超過になり、良い案が1つも出ないことがある。
  // 研修日を決めてから表全体を組み直すと、余の位置ごと動かせる。
  // 全部組み直すと時間がかかるので、まず今の表で見込みを測って上位だけ組み直す。
  let planRows = null, planBusy = false;

  // 余の使い道の候補を作る。
  //  ㋐ 定数+1で早番/遅番などに入れる（人手として数える。基本はこちら）
  //  ㋑ 研修で入れる（人数には数えない。定数を動かしたくないとき用）
  // いずれも「上位者が同じ時間帯に出勤している日」に限る＝そばで教えられる日。
  const planCandidates = () => {
    const pri2 = x => (POSITION_TYPES[x.positionType] || {}).priority || 9;
    const bandOf2 = (k) => isEarlyCategory(k) ? 'e' : (isLate(k) ? 'l' : null);
    const trainKeys = (AppState.shiftTypes || []).filter(t => t.isTraining).map(t => t.key);
    const base = checkViolations(AppState.shifts).length;
    const baseV = checkViolations(AppState.shifts);
    const bkS = JSON.parse(JSON.stringify(AppState.shifts));
    const bkD = JSON.parse(JSON.stringify(AppState.dailyRequirements || {}));
    const bkC = JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {}));
    const undo = () => {
      AppState.shifts = JSON.parse(JSON.stringify(bkS));
      AppState.dailyRequirements = JSON.parse(JSON.stringify(bkD));
      AppState.dailyRequirementsCast = JSON.parse(JSON.stringify(bkC));
    };
    const out = [];
    (AppState.staff || []).forEach(L => {
      const cast = getStaffDepartment(L) === 'cast';
      for (let d = 1; d <= days; d++) {
        if ((AppState.requests[L.id] || {})[d]) continue;                       // 希望は動かさない
        if (typeof getFixedShiftAt === 'function' && getFixedShiftAt(L.id, d)) continue;
        const v = cellOf(L.id, d);
        if (!(v === '余' || isPublicOff(v) || v === '有')) continue;            // 空いている日だけ
        // その日その時間帯に出勤している上位者
        const tutorAt = (bd) => (AppState.staff || []).find(x => {
          if (x.id === L.id || pri2(x) >= pri2(L)) return false;
          const vt = cellOf(x.id, d);
          return vt && isWork(vt) && bandOf2(vt) === bd;
        });
        // ㋐ 定数+1で入れる
        candidateShiftsFor(L, d).forEach(k => {
          const bd = bandOf2(k); if (!bd) return;
          const T = tutorAt(bd); if (!T) return;
          const store = cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                             : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
          const b0 = (cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[k] || 0;
          store[k] = store[k] || {};
          store[k][d] = (store[k][d] != null ? store[k][d] : b0) + 1;
          AppState.shifts[L.id][d] = k;
          const aV = checkViolations(AppState.shifts);
          undo();
          out.push({ kind: 'work', id: L.id, name: L.name, day: d, key: k, tutor: T.name, cast, guess: aV.length - base, sd: _diffOfLists(baseV, aV) });
        });
        // ㋑ 研修で入れる
        trainKeys.forEach(tk => {
          const bd = bandOf2(tk); if (!bd) return;
          const T = tutorAt(bd); if (!T) return;
          AppState.shifts[L.id][d] = tk;
          const aV = checkViolations(AppState.shifts);
          undo();
          out.push({ kind: 'train', id: L.id, name: L.name, day: d, key: tk, tutor: T.name, cast, guess: aV.length - base, sd: _diffOfLists(baseV, aV) });
        });
      }
    });
    out.sort((a, b) => _diffCmp(a.sd, b.sd) || (a.day - b.day));
    return out;
  };

  // 上位の候補を実際に組み直して、本当の結果で比べる。
  // 実測（同じデータを同じ条件で解いて結果が揃うか）で決めた設定:
  //   1本ずつ 12件/61秒、2本同時 12件/62秒、3本同時+90秒 11件/87秒、
  //   5本同時+120秒 18件/101秒（揃うが品質が大幅低下）。
  // → 3本同時・90秒が最良。1回90秒で3本ぶん終わるので、まず基準＋候補2件を
  //   出して、足りなければ「さらに探す」で3件ずつ足していく。
  const PLAN_PAR = 3, PLAN_TL = 90;
  let planQueue = null;

  const runPlanSearch = async (more) => {
    if (planBusy) return;
    if (!more || !planQueue) {
      const cands = planCandidates();
      if (!cands.length) { say('入れられる日が見つかりませんでした。指導役が同じ時間帯に出勤している日が必要です。', false); return; }
      // 基本は「定数+1で早番/遅番に入れる」。研修は定数を動かしたくないとき用。
      // 同じ人ばかりにならないよう1人2件までにする。
      const perPerson = {}, picked = [];
      const take = (arr, max) => {
        for (const c of arr) {
          if (picked.length >= max) break;
          if ((perPerson[c.id] || 0) >= 2) continue;
          if (picked.some(t => t.id === c.id && t.day === c.day)) continue;
          perPerson[c.id] = (perPerson[c.id] || 0) + 1;
          picked.push(c);
        }
      };
      take(cands.filter(c => c.kind === 'work'), 8);
      take(cands.filter(c => c.kind === 'train'), 11);
      take(cands, 11);
      planQueue = picked;
      planRows = null;
    }
    // 1回で回す本数。初回は基準を1本使うので候補は2件、以降は3件。
    const first = !planRows;
    const batch = planQueue.splice(0, first ? PLAN_PAR - 1 : PLAN_PAR);
    if (!batch.length) { say('これ以上の候補はありません。', true); render(); return; }

    if (!calcBegin('余の使い道の候補さがし')) { planQueue.unshift(...batch); return; }
    planBusy = true; busy(true);
    planProg = { done: 0, total: batch.length + (first ? 1 : 0), t0: Date.now() };
    const timer = setInterval(drawPlanProgress, 500);
    const baseFx   = JSON.parse(JSON.stringify(AppState.fixedShifts || {}));
    const baseDaily  = JSON.parse(JSON.stringify(AppState.dailyRequirements || {}));
    const baseDailyC = JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {}));
    const payload = (fx) => Object.assign(_milpPayload(), { fixedShifts: fx });
    const jobs = [];
    if (first) jobs.push({ kind: 'base', pl: payload(baseFx) });
    batch.forEach(c => {
      const fx = JSON.parse(JSON.stringify(baseFx));
      fx[c.id] = fx[c.id] || {}; fx[c.id][c.day] = c.key;
      const pl = payload(fx);
      if (c.kind === 'work') {   // 定数+1もいっしょに送る（研修は人数に数えないので不要）
        const store = JSON.parse(JSON.stringify(c.cast ? baseDailyC : baseDaily));
        const b0 = (c.cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[c.key] || 0;
        store[c.key] = store[c.key] || {};
        store[c.key][c.day] = (store[c.key][c.day] != null ? store[c.key][c.day] : b0) + 1;
        if (c.cast) pl.dailyRequirementsCast = store; else pl.dailyRequirements = store;
      }
      jobs.push({ kind: 'cand', c, pl });
    });
    const countSurIn = (sh) => {
      let n = 0; for (const id in (sh || {})) { const row = sh[id]; for (const d in row) if (row[d] === '余') n++; }
      return n;
    };
    try {
      const rs = await Promise.all(jobs.map(j =>
        milpTrial(j.pl, 0, PLAN_TL)
          .then(r => { planProg.done++; drawPlanProgress(); return { j, r }; })
          .catch(() => { planProg.done++; drawPlanProgress(); return null; })));
      const got = rs.filter(Boolean);
      const bRow = got.find(x => x.j.kind === 'base');
      if (bRow) planRows = { base: { n: bRow.r.violations.length, sc: scoreViolations(bRow.r.violations), v: bRow.r.violations, sur: countSurIn(bRow.r.shifts) }, rows: [] };
      if (!planRows) { const v0 = checkViolations(AppState.shifts);
        planRows = { base: { n: v0.length, sc: scoreViolations(v0), v: v0, sur: listSurplusCells().length }, rows: [] }; }
      got.filter(x => x.j.kind === 'cand').forEach(x =>
        planRows.rows.push(Object.assign({}, x.j.c, { n: x.r.violations.length, sc: scoreViolations(x.r.violations),
          compUp: compWorsened(planRows.base.v, x.r.violations).length > 0, sur: countSurIn(x.r.shifts) })));
      planRows.rows.sort((a, b2) => scoreCompare(a.sc, b2.sc) || (a.sur - b2.sur));
      planRows.left = planQueue.length;
      say(planRows.rows.length ? '✅ 比べ終わりました。下の一覧からお選びください。' : '組み直せる候補がありませんでした。', true);
    } catch (e) {
      say('計算に失敗しました: ' + escapeHtml(e.message), false);
    } finally {
      clearInterval(timer);
      calcEnd();
      planBusy = false; planProg = null; busy(false); render();
    }
  };

  // 進み具合のバー。計算中に画面が止まって見えるので、本数と経過秒を出す。
  let planProg = null;
  const drawPlanProgress = () => {
    const $b = modal.querySelector('#planProg');
    if (!$b || !planProg) return;
    const pct = Math.round(planProg.done / planProg.total * 100);
    const sec = Math.floor((Date.now() - planProg.t0) / 1000);
    $b.innerHTML = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:180px;height:10px;border-radius:999px;background:var(--surface-3);overflow:hidden">
          <div style="width:${pct}%;height:100%;background:var(--accent);transition:width .3s"></div>
        </div>
        <span class="hint">${planProg.done} / ${planProg.total} 本　経過 ${sec}秒</span>
      </div>
      <div class="hint" style="margin-top:4px">同時に計算しています。画面が止まって見えても動いています。</div>`;
  };

  // 研修で入れる: 人員にカウントされないので定数は動かさず、その人をその日に固定する
  const applyTrainReco = async (x) => {
    const st = AppState.staff.find(y => y.id === x.id); if (!st) return;
    busy(true);
    const r = await trySurplusChange(() => {
      AppState.fixedShifts[x.id] = AppState.fixedShifts[x.id] || {};
      AppState.fixedShifts[x.id][x.day] = x.key;
      AppState.shifts[x.id] = AppState.shifts[x.id] || {};
      AppState.shifts[x.id][x.day] = x.key;
    }, { adjust: false, confirm: askWorsen });
    busy(false);
    say(r.ok ? `${r.worsened ? '⚠️' : '✅'} ${escapeHtml(st.name)} ${x.day}日 を「${escapeHtml(x.key)}」で ${escapeHtml(x.tutor)}さんのそばに入れました（${r.message}）。${diffText(r)}`
             : `↩ ${escapeHtml(st.name)} ${x.day}日 の指定を取り消しました。${r.message}`, r.ok && !r.worsened);
    recoDirty = true; renderResultTable(); render();
  };

  const bind = () => {
    const $ = (id) => modal.querySelector('#' + id);
    $('surplusX').addEventListener('click', () => { modal._closePanel(); });

    if ($('planSearch')) $('planSearch').addEventListener('click', () => { planQueue = null; planRows = null; runPlanSearch(false); });
    if ($('planMore'))   $('planMore').addEventListener('click',   () => { runPlanSearch(true); });
    modal.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', async () => {
      const x = planRows && planRows.rows[parseInt(btn.dataset.plan)];
      if (!x) return;
      if (!calcBegin('余の使い道の作り直し')) return;
      busy(true);
      say(`⏳ ${escapeHtml(x.name)}さん ${x.day}日 を ${escapeHtml(x.key)} に固定して作り直しています…`, true, true);
      // 作り直した結果が6連勤以上を増やすなら、元に戻す（⛔ で止める）
      const bkAll = { shifts: JSON.parse(JSON.stringify(AppState.shifts)),
                      fixed: JSON.parse(JSON.stringify(AppState.fixedShifts)),
                      daily: JSON.parse(JSON.stringify(AppState.dailyRequirements || {})),
                      dailyC: JSON.parse(JSON.stringify(AppState.dailyRequirementsCast || {})) };
      const bV0 = checkViolations(AppState.shifts);
      const bSc = scoreViolations(bV0);
      AppState.fixedShifts[x.id] = AppState.fixedShifts[x.id] || {};
      AppState.fixedShifts[x.id][x.day] = x.key;
      if (x.kind === 'work') {   // その日の必要人数を1人増やす
        const store = x.cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                             : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
        const b0 = (x.cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[x.key] || 0;
        store[x.key] = store[x.key] || {};
        store[x.key][x.day] = (store[x.key][x.day] != null ? store[x.key][x.day] : b0) + 1;
      }
      try {
        await optimizeScheduleMILP(null, { fastMode: true });
        AppState.violations = checkViolations(AppState.shifts);
        const aSc = scoreViolations(AppState.violations);
        // ほかの所と同じ判定（新しくできた・伸びた・つながった、または本数が増えた）
        if (_diffOfLists(bV0, AppState.violations).compUp) {
          AppState.shifts = bkAll.shifts; AppState.fixedShifts = bkAll.fixed;
          AppState.dailyRequirements = bkAll.daily; AppState.dailyRequirementsCast = bkAll.dailyC;
          AppState.violations = checkViolations(AppState.shifts);
          throw new Error('⛔ 作り直すと6連勤以上（コンプラ違反）になるため、元に戻しました');
        }
        const sgn = _diffSign(_scoreDiff(bSc, aSc));
        say(`${sgn <= 0 ? '✅' : '⚠️'} ${escapeHtml(_diffWords(_scoreDiff(bSc, aSc)))}。${escapeHtml(x.name)}さん ${x.day}日 を ${escapeHtml(x.tutor)}さんのそばに入れて作り直しました（余 ${listSurplusCells().length}コマ）。`, true);
      } catch (e) {
        // 中止・失敗のときは、固定と必要人数の変更も元に戻す（作り直していない表に変更だけ残さない）
        AppState.shifts = bkAll.shifts; AppState.fixedShifts = bkAll.fixed;
        AppState.dailyRequirements = bkAll.daily; AppState.dailyRequirementsCast = bkAll.dailyC;
        AppState.violations = checkViolations(AppState.shifts);
        say((/^cancel/.test(e.message || '') ? '中止しました。元に戻しました。' : '作り直しに失敗しました: ' + escapeHtml(e.message)), false);
      } finally { calcEnd(); }
      planRows = null; recoDirty = true;
      busy(false); renderResultTable(); render();
    }));

    // 👑 おすすめ: 選択欄にその内容を入れてから、同じ実行処理を呼ぶ
    modal.querySelectorAll('[data-reco]').forEach(btn => btn.addEventListener('click', () => {
      const x = (recoCache || [])[parseInt(btn.dataset.reco)];
      if (!x) return;
      if (Date.now() < recoHoldUntil) return;
      // ボタンに書いてある人・日・内容と、実行する中身が同じかを確かめる
      const same = btn.dataset.rid === String(x.id) && btn.dataset.rday === String(x.day) &&
                   btn.dataset.rkind === x.kind && btn.dataset.rkey === String(x.key || '');
      // 一覧を作ったあとに表が変わっていたら、古い一覧のまま実行しない（手で直したマスを上書きしていた）
      if (!same || stateFp() !== recoFp || cellOf(x.id, x.day) !== '余') {
        recoCache = null; recoHoldUntil = Date.now() + 2000; render();
        say('🔄 表が変わっていたので、おすすめを数え直しました。新しい一覧を確かめてから、もう一度お選びください。', false);
        setTimeout(() => { if (modal.isConnected) modal.querySelectorAll('[data-reco]').forEach(b => { b.disabled = false; }); }, 2000);
        return;
      }
      if (x.kind === 'paid') { selPaid = { id: x.id, day: x.day }; render(); modal.querySelector('#paidGo').click(); }
      else if (x.kind === 'train') { applyTrainReco(x); }
      else { selWork = { id: x.id, day: x.day, key: x.key }; render(); const g = modal.querySelector('#workGo'); if (g) g.click(); }
    }));

    // 小さくして、裏のシフト表をしっかり見られるようにする
    $('surplusMin').addEventListener('click', () => {
      const body = $('surplusBody');
      const min = body.style.display !== 'none';
      body.style.display = min ? 'none' : '';
      $('surplusMin').textContent = min ? '▲' : '▁';
      $('surplusMin').title = min ? '元の大きさに戻す' : '小さくして表を見る';
      minimized = min;
    });

    // ヘッダーをつかんで動かす
    const head = $('surplusDrag');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = modal.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        // 画面の外に出て、つかめなくなるのを防ぐ
        const x = Math.min(Math.max(0, ev.clientX - ox), window.innerWidth  - 120);
        const y = Math.min(Math.max(0, ev.clientY - oy), window.innerHeight - 60);
        modal.style.left = x + 'px'; modal.style.top = y + 'px';
        modal.style.right = 'auto';
        pos = { x, y };
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 動かした位置・小さくした状態を、再描画のあとも保つ
    if (pos) { modal.style.left = pos.x + 'px'; modal.style.top = pos.y + 'px'; modal.style.right = 'auto'; }
    if (minimized) {
      $('surplusBody').style.display = 'none';
      $('surplusMin').textContent = '▲';
    }

    $('paidStaff').addEventListener('change', e => { selPaid.id = e.target.value; render(); });
    $('paidDay').addEventListener('change', e => { selPaid.day = e.target.value; refreshPreview(); });
    $('workStaff').addEventListener('change', e => { selWork.id = e.target.value; selWork.key = ''; render(); });
    $('workDay').addEventListener('change', e => { selWork.day = e.target.value; selWork.key = ''; render(); });
    if ($('workKey')) $('workKey').addEventListener('change', e => { selWork.key = e.target.value; refreshPreview(); });

    // 🎓 2人を一緒に入れる
    modal.querySelectorAll('input[data-tutor]').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.dataset.tutor;
      if (cb.checked) { if (!selPair.tutors.includes(id)) selPair.tutors.push(id); }
      else selPair.tutors = selPair.tutors.filter(x => x !== id);
      pairRows = null; renderPairRows();
    }));
    if ($('pairB')) $('pairB').addEventListener('change', e => { selPair.b = e.target.value; pairRows = null; render(); });
    if ($('pairBand')) $('pairBand').addEventListener('change', e => { selPair.band = e.target.value; pairRows = null; renderPairRows(); });
    if ($('pairFind')) $('pairFind').addEventListener('click', () => {
      const t = selPair.tutors.filter(x => x !== selPair.b);
      if (!t.length) { say('⚠️ 指導役の候補を1人以上えらんでください。', false); return; }
      const $r = modal.querySelector('#pairResult');
      if ($r) $r.innerHTML = '<span class="hint">⏳ 入れられる日を調べています…</span>';
      setTimeout(() => { pairRows = findPairDays(t, selPair.b, selPair.band); renderPairRows(); }, 30);
    });
    renderPairRows();

    $('paidGo').addEventListener('click', async () => {
      const id = selPaid.id, d = parseInt(selPaid.day);
      const s = AppState.staff.find(x => x.id === id); if (!s || !d) return;
      const cur = cellOf(id, d);
      if (cur === '有') { say(`⚠️ ${escapeHtml(s.name)} ${d}日 はすでに有給です。`, false); return; }
      busy(true);
      const r = await trySurplusChange(() => {
        AppState.requests[id] = AppState.requests[id] || {};
        AppState.requests[id][d] = '有';
        AppState.shifts[id] = AppState.shifts[id] || {};
        AppState.shifts[id][d] = '有';
        s.paidLeave = (parseInt(s.paidLeave) || 0) + 1;   // 有給の消化日数を1日増やす
      }, { adjust: false, confirm: askWorsen });
      busy(false);
      say(r.ok ? `${r.hadCritical ? '🚨' : r.worsened ? '⚠️' : '✅'} ${escapeHtml(s.name)} ${d}日 を有給にしました（${r.message}）。有給日数は ${s.paidLeave}日 になりました。${diffText(r)}`
               : `↩ ${escapeHtml(s.name)} ${d}日 の有給を取り消しました。${r.message}`, r.ok && !r.worsened);
      recoDirty = true; renderResultTable(); render();
    });

    if (!$('workGo')) return;
    $('workGo').addEventListener('click', async () => {
      const id = selWork.id, d = parseInt(selWork.day), key = selWork.key;
      const s = AppState.staff.find(x => x.id === id); if (!s || !d || !key) return;
      busy(true);
      say('⏳ 周りのつじつまを合わせています…', true, true);
      const cast = getStaffDepartment(s) === 'cast';
      const r = await trySurplusChange(() => {
        const store = cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                           : (AppState.dailyRequirements     || (AppState.dailyRequirements     = {}));
        const base = (cast ? (AppState.roleRequirementsCast || {}) : AppState.roleRequirements)[key] || 0;
        store[key] = store[key] || {};
        store[key][d] = (store[key][d] != null ? store[key][d] : base) + 1;   // その日だけ定数を+1
        AppState.fixedShifts[id] = AppState.fixedShifts[id] || {};
        AppState.fixedShifts[id][d] = key;                                     // その人をその日に固定
        AppState.shifts[id] = AppState.shifts[id] || {};
        AppState.shifts[id][d] = key;
      }, { adjust: true, k: 24, confirm: askWorsen });
      busy(false);
      say(r.ok ? `${r.hadCritical ? '🚨' : r.worsened ? '⚠️' : '✅'} ${escapeHtml(s.name)} ${d}日 を「${escapeHtml(key)}」で出勤にしました（${r.message}）。その日の「${escapeHtml(key)}」の必要人数を1人増やしています。${diffText(r)}`
               : `↩ ${escapeHtml(s.name)} ${d}日 の「${escapeHtml(key)}」を取り消しました。${r.message}`, r.ok && !r.worsened);
      recoDirty = true; renderResultTable(); render();
    });
  };

  const pop = document.getElementById('surplusPopup');
  if (pop) pop.remove();          // 生成直後のポップアップが残っていたら閉じる
  document.body.appendChild(modal);
  render();
}

/* ===========================================
   まとめて固定（ドラッグで範囲選択して 🔒固定 / 🔓解除）
   Excel のように表の上をなぞって四角い範囲を選び、
   その中のマスをまとめて固定・解除する。
   =========================================== */

const RangeLock = {
  on: false,          // 範囲選択モードかどうか
  action: 'lock',     // 'lock' = 固定する / 'unlock' = 解除する
  dragging: false,
  anchor: null,       // ドラッグ開始位置 {row, day}

  // 表の中の「スタッフ行」を上から順に並べ、行番号を引けるようにする
  rowsOf() {
    const tbl = document.getElementById('resultTable') || document.querySelector('#panel-result table');
    if (!tbl) return [];
    return [...tbl.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('td[data-sid]'));
  },
  posOf(td) {
    const tr = td.closest('tr');
    const rows = this.rowsOf();
    return { row: rows.indexOf(tr), day: parseInt(td.dataset.day) };
  },

  // いま選ばれている四角い範囲に印を付ける
  paint(cur) {
    const tbl = document.getElementById('resultTable') || document.querySelector('#panel-result table');
    if (!tbl) return;
    tbl.querySelectorAll('td.range-sel').forEach(td => td.classList.remove('range-sel'));
    if (!this.anchor || !cur) return;
    const r0 = Math.min(this.anchor.row, cur.row), r1 = Math.max(this.anchor.row, cur.row);
    const d0 = Math.min(this.anchor.day, cur.day), d1 = Math.max(this.anchor.day, cur.day);
    const rows = this.rowsOf();
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const tr = rows[r]; if (!tr) continue;
      tr.querySelectorAll('td[data-sid]').forEach(td => {
        const d = parseInt(td.dataset.day);
        if (d >= d0 && d <= d1) { td.classList.add('range-sel'); n++; }
      });
    }
    const $c = document.getElementById('rangeLockCount');
    if ($c) $c.textContent = `${n}マス選択中`;
  },

  // 選んだ範囲に固定／解除を適用する
  apply() {
    const tbl = document.getElementById('resultTable') || document.querySelector('#panel-result table');
    if (!tbl) return;
    const sel = [...tbl.querySelectorAll('td.range-sel')];
    if (!sel.length) return;
    if (typeof calcBusy === 'function' && calcBusy()) { calcBusyToast(); return; }
    if (typeof recordShiftHistory === 'function') recordShiftHistory();
    let n = 0;
    sel.forEach(td => {
      const sid = td.dataset.sid, d = parseInt(td.dataset.day);
      const val = (AppState.shifts[sid] || {})[d] || '';
      AppState.fixedShifts[sid] = AppState.fixedShifts[sid] || {};
      if (this.action === 'lock') {
        if (!val) return;                       // 中身が空のマスは固定しない
        AppState.fixedShifts[sid][d] = val;     // 中身に関係なく、いまの値をそのまま固定
        n++;
      } else {
        if (AppState.fixedShifts[sid][d] == null) return;
        delete AppState.fixedShifts[sid][d];
        n++;
      }
    });
    saveToStorage();
    const keep = this.on;
    renderResultTable();
    if (keep) this.enable(true);                // 再描画で消えたモードを戻す
    toast(this.action === 'lock' ? `🔒 ${n}マスを固定しました（Ctrl+Zで戻せます）`
                                 : `🔓 ${n}マスの固定を解除しました（Ctrl+Zで戻せます）`, 'success', 3000);
  },

  bar() {
    const old = document.getElementById('rangeLockBar');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.id = 'rangeLockBar';
    bar.innerHTML = `
      <b style="font-size:13px">まとめて固定</b>
      <button class="btn rl-mode ${this.action === 'lock' ? 'active' : ''}" data-rl="lock">🔒 固定する</button>
      <button class="btn rl-mode ${this.action === 'unlock' ? 'active' : ''}" data-rl="unlock">🔓 解除する</button>
      <span class="hint" id="rangeLockCount">表の上をドラッグして範囲を選んでください</span>
      <button class="btn btn-primary" data-rl="close">終了</button>`;
    document.body.appendChild(bar);
    bar.querySelectorAll('[data-rl]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.rl;
      if (v === 'close') { RangeLock.disable(); return; }
      RangeLock.action = v;
      bar.querySelectorAll('.rl-mode').forEach(x => x.classList.toggle('active', x.dataset.rl === v));
    }));
  },

  enable(silent) {
    const tbl = document.getElementById('resultTable') || document.querySelector('#panel-result table');
    if (!tbl) { toast('シフト表がありません', 'error'); return; }
    this.on = true;
    tbl.classList.add('range-select-mode');
    this.bar();
    const btn = document.getElementById('btnRangeLock');
    if (btn) { btn.textContent = '✅ まとめて固定を終了'; btn.classList.add('btn-primary'); }
    if (!silent) toast('表の上をドラッグして範囲を選んでください', 'info', 3500);
  },

  disable() {
    this.on = false; this.dragging = false; this.anchor = null;
    document.querySelectorAll('.range-select-mode').forEach(t => t.classList.remove('range-select-mode'));
    document.querySelectorAll('td.range-sel').forEach(td => td.classList.remove('range-sel'));
    const bar = document.getElementById('rangeLockBar'); if (bar) bar.remove();
    const btn = document.getElementById('btnRangeLock');
    if (btn) { btn.textContent = '🔒 まとめて固定'; btn.classList.remove('btn-primary'); }
  },

  toggle() { this.on ? this.disable() : this.enable(); },
};

// マウス操作は document 側で1回だけ拾う（表は再描画されるため）
document.addEventListener('mousedown', (e) => {
  if (!RangeLock.on) return;
  const td = e.target.closest && e.target.closest('td[data-sid]');
  if (!td || !td.closest('.range-select-mode')) return;
  e.preventDefault();
  RangeLock.dragging = true;
  RangeLock.anchor = RangeLock.posOf(td);
  RangeLock.paint(RangeLock.anchor);
});
document.addEventListener('mouseover', (e) => {
  if (!RangeLock.on || !RangeLock.dragging) return;
  const td = e.target.closest && e.target.closest('td[data-sid]');
  if (!td || !td.closest('.range-select-mode')) return;
  RangeLock.paint(RangeLock.posOf(td));
});
document.addEventListener('mouseup', () => {
  if (!RangeLock.on || !RangeLock.dragging) return;
  RangeLock.dragging = false;
  RangeLock.apply();
});

/* ===========================================
   途中から作り直す（◯日以降だけ再生成）
   月の途中で予定が変わったとき、すでに配ったぶん（前半）は
   1マスも動かさず、指定日以降だけを作り直す。
   仕組みは「前日までを🔒で固定してから生成し直す」だけ。
   =========================================== */

function showPartialRegenModal() {
  if (!AppState.generated) { toast('シフトを生成してから実行してください', 'error'); return; }
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const wd = (d) => WD[getWeekday(AppState.settings.targetMonth, d)] || '';

  // 既定値: 今日が対象月なら今日、そうでなければ月の真ん中あたり
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let cut = (ym === AppState.settings.targetMonth) ? now.getDate() : Math.ceil(days / 2);
  cut = Math.min(Math.max(2, cut), days);

  // 固定される対象マスを数える（中身が空のマスは対象外）
  const countCells = (c) => {
    let n = 0;
    (AppState.staff || []).forEach(s => {
      for (let d = 1; d < c; d++) if (((AppState.shifts[s.id] || {})[d] || '')) n++;
    });
    return n;
  };

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.zIndex = 10050;

  const render = () => {
    modal.innerHTML = `
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h3 style="margin:0">📅 途中から作り直す</h3>
          <button class="modal-close" id="prClose">✕</button>
        </div>
        <div class="modal-body" style="padding:18px 20px">
          <p class="hint" style="margin:0 0 14px">
            指定した日より前は<b>1マスも変えずにそのまま残し</b>、その日以降だけを作り直します。<br>
            月の途中で予定が変わったときに使ってください。
          </p>

          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <b style="font-size:15px">
              <input type="number" id="prDay" min="2" max="${days}" value="${cut}"
                     style="width:64px;font-size:18px;text-align:center;font-weight:700"/> 日
            </b>
            <span style="font-size:15px">（${wd(cut)}）<b>以降</b>を作り直す</span>
          </div>

          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px;line-height:1.8">
            🔒 <b>1日 〜 ${cut - 1}日</b>（${wd(cut - 1)}まで）の <b>${countCells(cut)}マス</b> をそのまま固定します<br>
            🔄 <b>${cut}日 〜 ${days}日</b> を作り直します
          </div>

          <p class="hint" style="margin:0 0 14px">
            月の公休数・有給日数・連勤は、<b>前半で消化したぶんを差し引いて計算</b>されます。
            前半で3日休んでいれば、後半は残り6日分で組み立てます。
          </p>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="prGoDeep" class="btn btn-primary">🎯 じっくり作り直す（最大10分）</button>
            <button id="prGoFast" class="btn">⚡ 速く作り直す（最大60秒）</button>
            <button id="prCancel" class="btn">やめる</button>
          </div>
        </div>
      </div>`;
    bind();
    const _rc = modal.querySelector('#spApply');
    if (_rc) { const ev = new Event('change'); void ev; }
  };

  const bind = () => {
    const $ = (id) => modal.querySelector('#' + id);
    const close = () => modal.remove();
    $('prClose').addEventListener('click', close);
    $('prCancel').addEventListener('click', close);
    $('prDay').addEventListener('change', e => {
      let v = parseInt(e.target.value) || 2;
      cut = Math.min(Math.max(2, v), days);
      render();
    });
    const run = (opts) => {
      // ほかの計算中なら、固定をかける前に止める（固定だけ残って作り直されないのを防ぐ）
      if (calcBusy()) { calcBusyToast(); return; }
      // 中止・失敗したときは、前半の固定と「◯日以前は数えない」を元に戻す（固定だけ残っていた）
      const bkFixed = JSON.parse(JSON.stringify(AppState.fixedShifts || {}));
      const bkCut = AppState.settings.ignoreVioBeforeDay || 0;
      opts = Object.assign({}, opts, { onAbort: () => {
        AppState.fixedShifts = bkFixed;
        AppState.settings.ignoreVioBeforeDay = bkCut;
        if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
        AppState.violations = checkViolations(AppState.shifts);
        saveToStorage(); refreshAllUI();
        toast('作り直しをやめたので、前半の🔒固定と「◯日以前は数えない」を元に戻しました', 'info', 6000);
      } });
      const n = applyPartialLock(cut);
      close();
      toast(`🔒 1〜${cut - 1}日の ${n}マス を固定しました。${cut}日以降を作り直します…`, 'info', 4000);
      // 自動生成タブへ移動してから実行（進捗バーが見えるように）
      const gt = document.querySelector('.tab[data-tab="generate"]');
      if (gt) gt.click();
      setTimeout(() => {
        if (typeof window._runGenerate === 'function') window._runGenerate(opts);
        else toast('生成処理が見つかりません。ページを再読み込みしてください', 'error');
      }, 300);
    };
    $('prGoDeep').addEventListener('click', () => run({}));
    $('prGoFast').addEventListener('click', () => run({ fastMode: true }));
  };

  document.body.appendChild(modal);
  render();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/** 1日〜(cut-1)日を、いまの表のとおりに固定する。戻り値=固定したマス数 */
function applyPartialLock(cut) {
  if (typeof recordShiftHistory === 'function') recordShiftHistory();
  let n = 0;
  (AppState.staff || []).forEach(s => {
    AppState.fixedShifts[s.id] = AppState.fixedShifts[s.id] || {};
    for (let d = 1; d < cut; d++) {
      const v = (AppState.shifts[s.id] || {})[d] || '';
      if (!v) continue;                       // 空のマスは固定しない
      AppState.fixedShifts[s.id][d] = v;      // 公休・有給・余・出勤すべてそのまま固定
      n++;
    }
  });
  // 確定済みの前半は、もう直せないのでエラーに数えない
  AppState.settings.ignoreVioBeforeDay = cut;
  AppState.violations = checkViolations(AppState.shifts);
  saveToStorage();
  return n;
}

/** 確定済み扱いをやめて、月全体をエラー集計に戻す */
function clearPartialIgnore() {
  AppState.settings.ignoreVioBeforeDay = 0;
  AppState.violations = checkViolations(AppState.shifts);
  saveToStorage();
  refreshAllUI();
  toast('月全体をエラー集計の対象に戻しました', 'info', 3000);
}

/** 「◯日以前は集計から除外中」の帯を、シフト表の上に出す */
function renderPartialIgnoreBanner() {
  const host = document.getElementById('partialIgnoreBar');
  if (!host) return;
  const cut = parseInt(AppState.settings.ignoreVioBeforeDay) || 0;
  if (!(cut > 1)) { host.style.display = 'none'; host.innerHTML = ''; return; }
  // 隠している件数を数える（除外しない状態で数え直して差を取る）
  const save = AppState.settings.ignoreVioBeforeDay;
  AppState.settings.ignoreVioBeforeDay = 0;
  let all = [];
  try { all = checkViolations(AppState.shifts); } catch (_) {}
  AppState.settings.ignoreVioBeforeDay = save;
  const hidden = all.filter(v => v.day > 0 && v.day < cut).length;
  host.style.display = 'block';
  host.style.cssText = 'display:block;margin:0 0 10px;padding:8px 12px;border-radius:8px;font-size:13px;line-height:1.7;'
    + 'background:color-mix(in srgb, var(--accent) 12%, var(--surface));border:1px solid color-mix(in srgb, var(--accent) 35%, transparent)';
  host.innerHTML = `📅 <b>1日〜${cut - 1}日は確定済み</b>として、エラー集計から<b>${hidden}件</b>を除外しています`
    + `（もう直せないため）。<a href="#" id="pibClear" style="margin-left:6px">月全体を集計に戻す</a>`;
  const a = host.querySelector('#pibClear');
  if (a) a.addEventListener('click', e => { e.preventDefault(); clearPartialIgnore(); });
}

// ===== 必要人数のルール =====
// 日付を1つずつ入れる代わりに「条件」で必要人数を決める。
// 月が変わっても日付が自動で決まるので、毎月の手入力と入れ違いが無くなる。
const _WD_LABEL = ['日', '月', '火', '水', '木', '金', '土'];
const _SPECIAL_LABEL = { '': '指定なし', replacement: '入れ替え日', renewal: '新装日', delivery: '搬入日' };

function _reqRules() {
  if (!Array.isArray(AppState.settings.reqRules)) AppState.settings.reqRules = [];
  return AppState.settings.reqRules;
}

// そのルールが今月どの日に当たるかを、実際に計算して見せる
function _ruleHitDays(rule) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const out = [];
  for (let d = 1; d <= days; d++) if (dayMatchesRule(rule, d)) out.push(d);
  return out;
}

function renderReqRules(hostId) {
  const $list = document.getElementById(hostId || 'reqRuleList');
  if (!$list) return;
  const rules = _reqRules();
  const keys = (typeof getWorkShiftKeys === 'function') ? getWorkShiftKeys() : [];
  if (!rules.length) {
    $list.innerHTML = '<p class="hint">まだルールがありません。「よく使うルールを入れる」を押すと、入れ替え日・搬入日・土日の分をまとめて作れます。</p>';
    return;
  }
  $list.innerHTML = rules.map((r, i) => {
    const w = r.when || {};
    const hit = _ruleHitDays(r);
    const hitTxt = hit.length
      ? hit.map(d => `${d}日`).join('・')
      : '<span style="color:var(--danger)">今月は当てはまる日がありません</span>';
    const wdBoxes = _WD_LABEL.map((lb, wd) =>
      `<label style="margin-right:8px;white-space:nowrap"><input type="checkbox" data-rr="wd" data-i="${i}" value="${wd}"
        ${(w.weekday || []).indexOf(wd) >= 0 ? 'checked' : ''}/> ${lb}</label>`).join('');
    const endBoxes = [0,1,2,3,4,5,6,7,8,9].map(n =>
      `<label style="margin-right:6px;white-space:nowrap"><input type="checkbox" data-rr="end" data-i="${i}" value="${n}"
        ${(w.dayEnds || []).indexOf(n) >= 0 ? 'checked' : ''}/> ${n}</label>`).join('');
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--surface-2)">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label style="white-space:nowrap"><input type="checkbox" data-rr="on" data-i="${i}" ${r.enabled === false ? '' : 'checked'}/> 使う</label>
        <input type="text" data-rr="name" data-i="${i}" value="${escapeHtml(r.name || '')}"
               placeholder="ルールの名前（例: 入れ替え日は遅番2人）" style="flex:1;min-width:220px"/>
        <button class="btn" data-rr="del" data-i="${i}" style="padding:4px 10px">削除</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px">
        <span>条件：</span>
        <select data-rr="sp" data-i="${i}">
          ${Object.keys(_SPECIAL_LABEL).map(k => `<option value="${k}" ${(w.special || '') === k ? 'selected' : ''}>${_SPECIAL_LABEL[k]}</option>`).join('')}
        </select>
        <span style="margin-left:6px">曜日:</span><span>${wdBoxes}</span>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;margin-top:6px">
        <span>◯のつく日:</span><span>${endBoxes}</span>
        <span style="margin-left:6px">日付を直接:</span>
        <input type="text" data-rr="days" data-i="${i}" value="${(w.days || []).join(',')}" placeholder="例: 3,17" style="width:110px"/>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;margin-top:8px">
        <span><b>その日の</b></span>
        <select data-rr="key" data-i="${i}">
          ${keys.map(k => `<option value="${k}" ${r.key === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
        <span>を</span>
        <input type="number" data-rr="to" data-i="${i}" value="${r.to != null ? r.to : 1}" min="0" max="20" style="width:70px"/>
        <span>人にする</span>
      </div>
      <div class="hint" style="margin-top:8px">今月あてはまる日：${hitTxt}</div>
    </div>`;
  }).join('');

  const rerender = () => { autoSave(); renderReqRules(hostId); };
  $list.querySelectorAll('[data-rr]').forEach(el => {
    const i = parseInt(el.dataset.i), kind = el.dataset.rr, r = rules[i];
    if (!r) return;
    if (kind === 'del') { el.addEventListener('click', () => { rules.splice(i, 1); rerender(); }); return; }
    const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'change';
    el.addEventListener(ev, () => {
      r.when = r.when || {};
      if (kind === 'on')   r.enabled = el.checked;
      if (kind === 'name') r.name = el.value;
      if (kind === 'key')  r.key = el.value;
      if (kind === 'to')   r.to = Math.max(0, parseInt(el.value) || 0);
      if (kind === 'sp')   { if (el.value) r.when.special = el.value; else delete r.when.special; }
      if (kind === 'days') r.when.days = el.value.split(',').map(x => parseInt(x.trim())).filter(x => x > 0 && x <= 31);
      if (kind === 'wd' || kind === 'end') {
        const field = kind === 'wd' ? 'weekday' : 'dayEnds';
        const box = $list.querySelectorAll(`[data-rr="${kind}"][data-i="${i}"]`);
        r.when[field] = Array.from(box).filter(b => b.checked).map(b => parseInt(b.value));
      }
      rerender();
    });
  });
}

function setupReqRules() {
  const $add = document.getElementById('btnAddReqRule');
  const $pre = document.getElementById('btnReqRulePreset');
  if ($add) $add.addEventListener('click', () => {
    const keys = (typeof getWorkShiftKeys === 'function') ? getWorkShiftKeys() : ['早'];
    _reqRules().push({ id: 'r' + Date.now(), name: '', key: keys[0], to: 2, enabled: true, when: {} });
    autoSave(); renderReqRules();
  });
  if ($pre) $pre.addEventListener('click', () => {
    const keys = (typeof getWorkShiftKeys === 'function') ? getWorkShiftKeys() : [];
    const late  = keys.find(k => k === '遅') || keys.find(k => isLate(k)) || keys[0];
    const early = keys.find(k => k === '早') || keys.find(k => isEarlyCategory(k)) || keys[0];
    const rules = _reqRules();
    const add = (name, key, to, when) => {
      if (rules.some(r => r.name === name)) return;
      rules.push({ id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), name, key, to, enabled: true, when });
    };
    add('入れ替え日は遅番を2人', late, 2, { special: 'replacement' });
    add('搬入日は遅番を2人',     late, 2, { special: 'delivery' });
    add('土日かつ2・8のつく日は早番を2人', early, 2, { weekday: [0, 6], dayEnds: [2, 8] });
    autoSave(); renderReqRules();
    toast('よく使うルールを3つ追加しました。中身は自由に変えられます', 'info', 5000);
  });
  renderReqRules();
}

// ===== 余（あまり）の使い道を決める =====
// 出せる人日が必要人日より多いと、その差は「余」として捨てられる。
// 「余は全部使い切る」という現場の要望に応えるため、
//   ① 最適化に「どこに1人足すのが一番傷が浅いか」を選ばせ
//   ② その案を、指導役が同じ時間帯にいるかと一緒に並べ
//   ③ 人が選んだ分だけを必要人数に反映する
// 完全自動にしないのは、キャスト出勤日など「機械が知らない事情」があるため。
function _surplusOf() {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  return getDepartmentGroups(AppState.staff).map(g => {
    const c = calcCapacity(g, days);
    return { key: g.key, label: g.label || g.key, surplus: c.surplus, required: c.required, avail: c.avail };
  });
}

// その日その時間帯にいる指導役（副店長を先に、次にチーフ）
// shifts: どの表で見るか（省略時は本物の表）。余の使い道の試し計算では、試し計算の表を渡す
// （本物の表を見ていたため、まだ生成していないと指導役が誰もいないことになり、日付順になっていた）。
function _tutorsOn(day, band, shifts) {
  const rank = { viceManager: 0, chief: 1 };
  const SH = shifts || AppState.shifts;
  return (AppState.staff || [])
    .filter(s => rank[s.positionType] != null)
    .map(s => {
      const v = (SH[s.id] || {})[day] || '';
      const here = v && isWork(v) && (band === 'e' ? isEarlyCategory(v) : isLate(v));
      const canBe = (s.allowedShifts || []).some(k => (band === 'e' ? isEarlyCategory(k) : isLate(k)));
      return { s, v, here, canBe };
    })
    .filter(x => x.here)
    .sort((a, b) => rank[a.s.positionType] - rank[b.s.positionType]);
}

// 教わる人を決めて「指導役がいる日に追加で出勤させる」候補を探す。
// 生成する前なので誰がどこに入るかはまだ決まっていない。そこで
//   ・その日その時間帯に入れる指導役が何人いるか（希望休でない人）
//   ・その時間帯を0人に設定していないか
// で並べ、上から採れば外れにくいようにする。
function _trainingCandidates(learnerId, band, tutorIds) {
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const L = AppState.staff.find(x => x.id === learnerId);
  if (!L) return [];
  const cast = getStaffDepartment(L) === 'cast';
  const store = cast ? (AppState.dailyRequirementsCast || {}) : (AppState.dailyRequirements || {});
  const g = getDepartmentGroups(AppState.staff).find(x => x.staff.some(y => y.id === L.id))
            || { reqs: AppState.roleRequirements, dailyReqs: AppState.dailyRequirements };
  const inBand = (k) => band === 'any' ? (isEarlyCategory(k) || isLate(k)) : (band === 'e' ? isEarlyCategory(k) : isLate(k));
  const myKeys = (L.allowedShifts || []).filter(k => inBand(k) && !isTraining(k));
  if (!myKeys.length) return [];
  const tutors = (AppState.staff || []).filter(t => tutorIds.indexOf(t.id) >= 0 && t.id !== L.id);
  const maxC  = (typeof getMaxConsFor === 'function') ? getMaxConsFor(L) : (parseInt(AppState.settings.maxConsecutive) || 0);
  const prevC = (typeof getPrevMonthEnd === 'function') ? (getPrevMonthEnd(L).cons || 0) : 0;
  const bandKeysAll = (typeof getWorkShiftKeys === 'function' ? getWorkShiftKeys() : []).filter(k => inBand(k));
  // すでに固定で入れてある日（前に反映した分）も分かるようにする
  const fixedOf = (d) => (AppState.fixedShifts[L.id] || {})[d] || '';

  const out = [];
  for (let d = 1; d <= days; d++) {
    const st = staffDayState(L, d);
    const already = fixedOf(d);
    if (st !== 'free' && !already) continue;            // 希望休・有給の日だけ外す
    const warn = [];
    // 前月末からの連勤が上限に達しているなら、1日目は必ず連勤超過になる
    if (d === 1 && prevC >= maxC && maxC > 0) warn.push(`前月末から${prevC}連勤中のため、1日に入れると連勤超過になります`);
    // その時間帯の人数を意図的に減らしている日（キャスト出勤日など）
    const reduced = bandKeysAll.some(k2 => {
      const v = (store[k2] || {})[d];
      return v != null && v < ((g.reqs || {})[k2] || 0);
    });
    if (reduced) warn.push('この日は人数を減らす設定にしています（キャスト出勤日など）');
    // その日いられる指導役
    const av = tutors.filter(t => staffDayState(t, d) === 'free' && (t.allowedShifts || []).some(k => inBand(k)));
    if (!av.length) warn.push('この日は指導役が全員お休みです');
    // どのシフトで入れるか（すでに固定済みならそれ、無ければ最初の候補）
    const k = already && myKeys.indexOf(already) >= 0 ? already : myKeys[0];
    const need = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
    // 前後の日の予定とつじつまが合うか（遅番の翌日が早番・研修 など）
    const confAt = (dd) => {
      if (dd < 1 || dd > days) return '';
      const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(L.id, dd) : null;
      return fx || (AppState.requests[L.id] || {})[dd] || '';
    };
    const nm = (v) => isTraining(v) ? '研修' : v;
    const neighborWarn = (kk) => {
      const w = [], pv = confAt(d - 1), nx = confAt(d + 1), n2 = confAt(d + 2), p2 = confAt(d - 2);
      if (AppState.settings.forbidLateEarly !== false) {
        if (isLate(kk) && nx && isWork(nx) && isEarlyCategory(nx))
          w.push(`翌日 ${d + 1}日 が「${nm(nx)}」の予定です。休みを挟まずに遅番→${isTraining(nx) ? '研修' : '早番'}になります`);
        if (isEarlyCategory(kk) && pv && isWork(pv) && isLate(pv))
          w.push(`前日 ${d - 1}日 が「${nm(pv)}」の予定です。休みを挟まずに遅番→早番になります`);
      }
      if (isLate(kk) && nx && isOff(nx) && n2 && isWork(n2) && isEarlyCategory(n2))
        w.push(`${d + 1}日が休みで ${d + 2}日 が「${nm(n2)}」のため、遅→休→早になります`);
      if (isEarlyCategory(kk) && pv && isOff(pv) && p2 && isWork(p2) && isLate(p2))
        w.push(`${d - 1}日が休みで ${d - 2}日 が「${nm(p2)}」のため、遅→休→早になります`);
      return w;
    };
    const w2 = warn.concat(neighborWarn(k));
    // どのシフトなら前後とぶつからないかも調べておく（選び直しの目安）
    const okKeys = myKeys.filter(kk => neighborWarn(kk).length === 0);
    out.push({
      d, k, keys: myKeys, okKeys, from: need, to: need + 1, cast,
      learnerId: L.id, learnerName: L.name, tutorCand: av,
      warn: w2, zeroed: reduced, already: !!already, neighborWarn,
      score: (av.length ? 0 : 2) + (reduced ? 2 : 0) + (w2.length ? 1 : 0),
      checked: !!already,
    });
  }
  // 警告は「こうなるかもしれない」という注意書きでしかなく、どれを選べばよいかが
  // 分からなかった。実際にその日へ入れて数え直し、エラーが何件増えるかを付ける。
  out.forEach(r => { r.delta = _measureSurplusPick(r); });
  return out;   // 絞らない。並べ替えと選択は画面側でする
}

// 「入れてみた前後」を比べる共通の物差し（optimizer.js の scoreViolations と同じ）。
// 良し悪しは scoreBetter（どの🚨も増えず、どれかが減る）、並べ替えは scoreCompare
// （① 6連勤以上 ② 人員不足 ③ 🚨 ④ 連勤の超過日数 ⑤ 🟡）。表示は件数と超過日数を分けて出す。
// compUp: 6連勤以上が新しくできた・伸びた・つながったか（compWorsened）。回数だけで
// 判定すると、6連勤を7連勤に伸ばす変更などを見逃すため、分かるときは渡す。
function _scoreDiff(before, after, compUp) {
  return { b: before, a: after, dn: after.count - before.count, before: before.count, after: after.count,
           compUp: !!compUp || after.comp > before.comp };
}
// 違反の一覧どうしから _scoreDiff を作る（⛔の判定まで含めて）
function _diffOfLists(bV, aV) {
  return _scoreDiff(scoreViolations(bV), scoreViolations(aV), compWorsened(bV, aV).length > 0);
}
// 良くなる: -1 / 変わらない: 0 / 悪くなる: 1 / 減るものと増えるものがある: 2
function _diffSign(d) {
  if (!d) return null;
  if (scoreBetter(d.a, d.b)) return -1;
  const up = scoreWorsened(d.a, d.b);
  if (!up.length) return 0;
  return scoreBetter(d.b, d.a) ? 1 : 2;
}
// 並べ替え用（良い順）。測れなかったもの(null)は最後
function _diffCmp(x, y) {
  if (!x || !y) return (x ? -1 : 0) + (y ? 1 : 0);
  // 6連勤以上ができる・伸びる案（必ず止められる案）は、いつも一番後ろ
  return ((x.compUp ? 1 : 0) - (y.compUp ? 1 : 0)) || scoreCompare(x.a, y.a);
}
// 画面に出す言い方。件数と連勤の超過日数を分けて出し、判定と食い違わないようにする
function _diffWords(d) {
  if (!d) return '';
  const b = d.b, a = d.a, ch = [];
  if (a.comp !== b.comp) ch.push(`⛔コンプラ違反 ${b.comp}→${a.comp}件`);
  // 🚨は⛔（6連勤以上）を除いた件数で出す（⛔は別に出す）
  if (a.must - a.comp !== b.must - b.comp) ch.push(`🚨 ${b.must - b.comp}→${a.must - a.comp}件`);
  if (a.over !== b.over) ch.push(`連勤の超過 ${b.over}→${a.over}日`);
  if ((a.bsOver || 0) !== (b.bsOver || 0)) ch.push(`切り替えの超過 ${b.bsOver || 0}→${a.bsOver || 0}回`);
  if (a.soft !== b.soft) ch.push(`🟡 ${b.soft}→${a.soft}件`);
  const sg = _diffSign(d);
  const head = d.compUp ? '⛔ コンプラ違反（6連勤以上）になります・伸びます'
             : sg < 0 ? '良くなります' : sg === 0 ? '変わりません'
             : sg === 1 ? '悪くなります' : '減るものと増えるものがあります';
  // 🚨の種類が入れ替わっただけ（件数は同じ）のときも分かるように、増えた種類を出す
  const up = scoreWorsened(a, b).filter(x => x.key !== 'comp' && x.key !== 'over' && x.key !== 'bsOver' && x.key !== 'soft')
    .map(x => `${(typeof VIOLATION_LABEL !== 'undefined' && VIOLATION_LABEL[x.key]) || x.key} +${x.to - x.from}`);
  if (sg === 2 && up.length) ch.push('増える🚨: ' + up.join('・'));
  return ch.length ? `${head}（${ch.join('・')}）` : head;
}

function _spMark(r) {
  if (r.sd && r.sd.compUp) return '⛔';   // 6連勤以上になる・伸びる（コンプラ違反）
  const sg = _diffSign(r.sd);
  if (sg === 0) return '⭐';
  if (sg > 0)   return '⚠️';
  if (sg < 0)   return '🎉';
  return (r.warn && r.warn.length) ? '⚠️' : '⭐';
}
function _spDeltaTag(r) {
  if (!r.sd) return '';
  const sg = _diffSign(r.sd);
  const col = sg > 0 ? 'var(--danger)' : (sg < 0 ? 'var(--success, #2e7d32)' : 'var(--text-dim, inherit)');
  return `<span style="margin-left:8px;font-size:12px;color:${col}">（${_diffWords(r.sd)}）</span>`;
}

function _measureSurplusPick(r) {
  if (typeof checkViolations !== 'function' || !AppState.shifts) return null;
  try {
    const baseV = checkViolations(AppState.shifts);
    const row  = AppState.shifts[r.learnerId];
    if (!row) return null;
    const store = r.cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                         : (AppState.dailyRequirements || (AppState.dailyRequirements = {}));
    store[r.k] = store[r.k] || {};
    const hadShift = row[r.d], hadReq = store[r.k][r.d];
    row[r.d] = r.k; store[r.k][r.d] = r.to;
    const nowV = checkViolations(AppState.shifts);
    row[r.d] = hadShift;
    if (hadReq === undefined) delete store[r.k][r.d]; else store[r.k][r.d] = hadReq;
    r.sd = _diffOfLists(baseV, nowV);
    return r.sd.dn;
  } catch (e) { r.sd = null; return null; }
}

// 選んだ日を入れたら連勤がどうなるかを、その場で数える。
// 「確実に出勤」と決まっている日（固定・出勤希望）＋いま選んでいる日 だけを並べ、
// 休み希望と未定の日は連勤を切るものとして扱う（＝いちばん甘く見積もる）。
// それでも上限を超えるなら、生成しても必ず連勤超過になる。
function _consCheckForPick(learnerId, pickedDays) {
  const s = AppState.staff.find(x => x.id === learnerId);
  if (!s) return null;
  const mc = (typeof getMaxConsFor === 'function') ? getMaxConsFor(s) : (parseInt(AppState.settings.maxConsecutive) || 0);
  if (!(mc >= 1)) return null;
  const prev = (typeof getPrevMonthEnd === 'function') ? (getPrevMonthEnd(s).cons || 0) : 0;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const pick = new Set(pickedDays);
  const out = [];
  let run = 0, from = 0;
  for (let d = 1; d <= days + 1; d++) {
    let working = false;
    if (d <= days) {
      if (pick.has(d)) working = true;
      else {
        const rq = (AppState.requests[s.id] || {})[d];
        const fx = (typeof getFixedShiftAt === 'function') ? getFixedShiftAt(s.id, d) : null;
        const v = fx || rq || '';
        working = !!(v && isWork(v) && !isTraining(v));
      }
    }
    if (working) { if (!run) from = d; run++; continue; }
    if (run) {
      const total = (from === 1) ? run + prev : run;
      if (total > mc) out.push({ from, to: d - 1, total, over: total - mc, withPrev: from === 1 && prev > 0, prev });
      run = 0;
    }
  }
  return { max: mc, runs: out };
}

function showSurplusPlanModal() {
  if (!AppState.staff.length || !AppState.settings.targetMonth) {
    toast('スタッフと対象年月を設定してください', 'error'); return;
  }
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const [_y, _m] = String(AppState.settings.targetMonth).split('-').map(Number);
  const wdOf = (d) => WD[new Date(_y, _m - 1, d).getDay()];
  const caps = _surplusOf();
  let rows = null;
  // 教育モードの選択内容
  const rank = { viceManager: 0, chief: 1 };
  let sel = {
    learner: '',
    band: 'l',
    tutors: (AppState.staff || []).filter(x => rank[x.positionType] != null).map(x => x.id),
    pinTutor: false,
  };

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
  const render = () => {
    const capTxt = caps.map(c => c.surplus > 0
      ? `${caps.length > 1 ? '【' + c.label + '】' : ''}必要 ${c.required}人日 ／ 出せる ${c.avail}人日 → <b style="color:var(--accent)">余り ${c.surplus}人日</b>`
      : `${caps.length > 1 ? '【' + c.label + '】' : ''}余りはありません（${c.surplus < 0 ? (-c.surplus) + '人日 不足' : 'ちょうど'}）`).join('<br>');
    const total0 = caps.reduce((a, c) => a + Math.max(0, c.surplus), 0);
    const staffOpt = (AppState.staff || []).map(x =>
      `<option value="${x.id}" ${sel.learner === x.id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
    const tutorBox = (AppState.staff || []).filter(x => rank[x.positionType] != null)
      .sort((a, b) => rank[a.positionType] - rank[b.positionType])
      .map(x => `<label style="margin-right:10px;white-space:nowrap">
          <input type="checkbox" data-tu="${x.id}" ${sel.tutors.indexOf(x.id) >= 0 ? 'checked' : ''}/>
          ${escapeHtml(x.name)}<span class="hint">(${x.positionType === 'viceManager' ? '副店長' : 'チーフ'})</span></label>`).join('');
    const picker = `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="font-weight:700;margin-bottom:6px">🎓 教える相手を決めて入れる</div>
      <div class="hint" style="margin-bottom:8px">
        余った人日を使って、<b>この人を追加で出勤させます</b>。入れられる日を全部出しますので、
        実際にその日へ入れて数え直した結果を「エラー増えません」「エラー +1件」として出しています。
        ⭐＝増えない日、⚠️＝増える日です。増えない日から選べば失敗しません。
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px">
        <span>教わる人:</span>
        <select id="spLearner"><option value="">（選ばない＝機械に任せる）</option>${staffOpt}</select>
        <span style="margin-left:6px">時間帯:</span>
        <select id="spBand">
          <option value="l" ${sel.band === 'l' ? 'selected' : ''}>遅番帯</option>
          <option value="e" ${sel.band === 'e' ? 'selected' : ''}>早番帯</option>
          <option value="any" ${sel.band === 'any' ? 'selected' : ''}>どちらでも</option>
        </select>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:13px;margin-top:8px">
        <span>指導役の候補:</span>${tutorBox || '<span class="hint">副店長・チーフが登録されていません</span>'}
      </div>
    </div>`;
    const list = rows === null
      ? `${picker}<div class="hint" style="padding:10px 0">
           <b>教わる人を選んで「候補を出す」</b>を押すと、入れられる日が全部出ます（すぐ出ます）。<br>
           選ばずに押した場合は、最適化に一番傷が浅い場所を計算させます（1分ほどかかります）。</div>`
      : rows.length === 0
        ? `${picker}<div class="hint" style="padding:10px 0">入れられる日が見つかりませんでした。時間帯や担当シフトをご確認ください。</div>`
        : `${picker}<div style="max-height:44vh;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">` + rows.map((r, i) => `
          <div style="border-bottom:1px solid var(--border);padding:8px 10px;${r.checked ? 'background:color-mix(in srgb, var(--accent) 8%, transparent)' : ''}">
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
              <input type="checkbox" data-sp="${i}" ${r.checked ? 'checked' : ''} style="margin-top:3px"/>
              <span style="flex:1">
                <b>${_spMark(r)} ${r.d}日(${wdOf(r.d)})</b>${_spDeltaTag(r)}
                <span style="margin-left:8px">${r.from}人 → ${r.to}人</span>
                ${r.keys && r.keys.length > 1
                  ? `<select data-spk="${i}" style="margin-left:8px">${r.keys.map(k => `<option value="${k}" ${r.k === k ? 'selected' : ''}>${k}${(r.okKeys && r.okKeys.indexOf(k) >= 0) ? ' ◯' : ''}</option>`).join('')}</select>`
                  : `<span style="margin-left:8px"><b>${escapeHtml(r.k)}</b></span>`}
                ${r.learnerName ? `<span style="margin-left:6px">に ${escapeHtml(r.learnerName)}さん</span>` : ''}
                ${r.already ? '<span class="hint" style="margin-left:6px">（設定済み）</span>' : ''}
                <div class="hint" style="margin-top:2px">
                  ${(r.tutorCand && r.tutorCand.length) ? '指導役: ' + r.tutorCand.map(t => escapeHtml(t.name)).join('・') : ''}
                  ${(r.warn || []).map(w => `<br><span style="color:var(--danger)">⚠️ ${escapeHtml(w)}</span>`).join('')}
                </div>
              </span>
            </label>
          </div>`).join('') + '</div>';
    const picked = rows ? rows.filter(r => r.checked).length : 0;
    const total = caps.reduce((a, c) => a + Math.max(0, c.surplus), 0);
    const found = rows ? rows.reduce((a, r) => a + (r.to - r.from), 0) : 0;
    const isTrain = !!(rows && rows.length && rows[0].learnerId);
    const restTxt = (rows && rows.length)
      ? (isTrain
          ? `<div class="hint" id="spRest" style="margin-top:8px">余り ${total}人日 のうち ${picked}日 を選んでいます。</div>`
          : (found >= total
              ? `<div class="hint" style="margin-top:8px">全部チェックすると余はゼロになります。</div>`
              : `<div class="hint" style="margin-top:8px">見つかった置き場所は ${found}人日ぶんです。
                   残り ${total - found}人日 は、どこに入れても他のルールが崩れるため休み（余）のまま残ります。
                   <b>「教わる人」を選んで出し直すと、もっと多くの候補が出ます。</b></div>`))
      : '';
    modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;max-width:700px;width:100%;max-height:85vh;overflow:auto;padding:20px">
      <h3 style="margin:0 0 4px">⚖️ 余の使い道を決める</h3>
      <p class="hint" style="margin:0 0 10px">
        出せる人日が必要人日より多いと、その差は「余（あまり）」として休みになります。
        <b>どこかの必要人数を増やして出勤に回すと、余がなくなります。</b>
        <b>教える相手を決めれば、その人を指導役のいる日に入れられます。</b>
        決めない場合は、機械が「一番傷が浅い場所」だけを計算して並べます。どちらも最後に選ぶのは社長です。
      </p>
      <div style="padding:10px 12px;border-radius:8px;background:var(--surface-2);margin-bottom:10px;line-height:1.8">${capTxt}</div>
      ${list}
      <div id="spConsWarn" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;line-height:1.8;
           background:color-mix(in srgb, var(--danger) 14%, var(--surface));
           border:1px solid color-mix(in srgb, var(--danger) 45%, transparent)"></div>
      ${restTxt}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center">
        <button id="spCalc" class="btn ${rows === null ? 'btn-primary' : ''}">${rows === null ? '候補を出す' : '出し直す'}</button>
        ${rows && rows.length ? `<button id="spApply" class="btn btn-primary">選んだ ${picked}件 を必要人数に反映する</button>` : ''}
        <span style="flex:1"></span>
        <span class="hint" id="spCount2">余り ${total}人日 / 選択 ${picked}件</span>
        <button id="spClose" class="btn">閉じる</button>
      </div>
    </div>`;
    bind();
  };

  const bind = () => {
    const $c = modal.querySelector('#spCalc'), $a = modal.querySelector('#spApply'), $x = modal.querySelector('#spClose');
    if ($x) $x.addEventListener('click', () => modal.remove());
    // チェックのたびに全部描き直すと、長い一覧でスクロール位置が飛んでしまう。
    // 選んだ数と行の色だけをその場で更新する。
    const refreshCounts = () => {
      const n = rows ? rows.filter(r => r.checked).length : 0;
      // 連勤の見通しをその場で出す
      const $w = modal.querySelector('#spConsWarn');
      if ($w) {
        const lid = rows && rows.length && rows[0].learnerId;
        const cc = lid ? _consCheckForPick(lid, rows.filter(r => r.checked).map(r => r.d)) : null;
        if (cc && cc.runs.length) {
          const name = rows[0].learnerName;
          $w.style.display = 'block';
          $w.innerHTML = '<b>⛔ このまま進めると連勤超過になります</b><br>'
            + cc.runs.map(r => `${escapeHtml(name)}さん：${r.from}日〜${r.to}日 が続けて出勤`
                + (r.withPrev ? `（前月末の${r.prev}連勤と合わせて${r.total}連勤）` : `（${r.total}連勤）`)
                + ` → 上限${cc.max}日を ${r.over}日 超過。この中から ${r.over}日 ぶんチェックを外してください`).join('<br>');
        } else { $w.style.display = 'none'; $w.innerHTML = ''; }
      }
      const t = caps.reduce((a, c) => a + Math.max(0, c.surplus), 0);
      const $ap = modal.querySelector('#spApply');
      if ($ap) $ap.textContent = `選んだ ${n}件 を必要人数に反映する`;
      const $ct = modal.querySelector('#spCount2');
      if ($ct) $ct.textContent = `余り ${t}人日 / 選択 ${n}件`;
      const $rest = modal.querySelector('#spRest');
      if ($rest) $rest.textContent = n > t
        ? `余りより ${n - t}日 多く選んでいます。その分は他の人の出勤が減るか、エラーになります。`
        : n === t ? '全部使い切ります。' : `余り ${t}人日 のうち ${n}日 を選んでいます。残り ${t - n}人日 は、別の人で出し直すと使えます。`;
    };
    modal.querySelectorAll('[data-sp]').forEach(cb => cb.addEventListener('change', () => {
      const r = rows[parseInt(cb.dataset.sp)];
      r.checked = cb.checked;
      const row = cb.closest('div');
      if (row) row.style.background = cb.checked ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : '';
      refreshCounts();
    }));
    refreshCounts();   // 開いた直後・描き直した直後にも一度出す
    modal.querySelectorAll('[data-spk]').forEach(sl => sl.addEventListener('change', () => {
      const r = rows[parseInt(sl.dataset.spk)];
      r.k = sl.value;
      // シフトを変えたら、前後の噛み合わせを計算し直す
      if (typeof r.neighborWarn === 'function') {
        const base = (r.warn || []).filter(w => !/翌日|前日|遅→休→早/.test(w));
        r.warn = base.concat(r.neighborWarn(r.k));
      }
      // シフトを変えたら「いま何人必要か」も取り直す
      const g2 = getDepartmentGroups(AppState.staff).find(x => x.staff.some(y => y.id === r.learnerId));
      const need = getDayReq((g2 || {}).reqs || AppState.roleRequirements, (g2 || {}).dailyReqs || AppState.dailyRequirements, r.k, r.d);
      r.from = need; r.to = need + 1;
      r.delta = _measureSurplusPick(r);
      render();
    }));
    const $le = modal.querySelector('#spLearner'), $bd = modal.querySelector('#spBand');
    if ($le) $le.addEventListener('change', () => { sel.learner = $le.value; rows = null; render(); });
    if ($bd) $bd.addEventListener('change', () => { sel.band = $bd.value; rows = null; render(); });
    modal.querySelectorAll('[data-tu]').forEach(cb => cb.addEventListener('change', () => {
      sel.tutors = Array.from(modal.querySelectorAll('[data-tu]')).filter(x => x.checked).map(x => x.dataset.tu);
      rows = null; render();
    }));
    if ($c) $c.addEventListener('click', async () => {
      // 教わる人を選んでいる場合は、その人を入れられる日をすぐ探す（生成は不要）
      if (sel.learner) {
        rows = _trainingCandidates(sel.learner, sel.band, sel.tutors);
        // 実際に入れて数えた結果が良い順に並べる（同点なら日付順）
        rows.sort((a, b) => _diffCmp(a.sd, b.sd) || (a.d - b.d));
        if (!rows.length) toast('入れられる日が見つかりませんでした。時間帯や担当シフトをご確認ください', 'error', 6000);
        render();
        return;
      }
      if (!calcBegin('余の使い道の試し計算')) return;
      $c.disabled = true; $c.textContent = '⏳ 計算中…';
      try {
        // 「余を残すな」と指示して解かせる。押し出しの強さは、実測では 8000 だと半分しか出ず、
        // 20000 で余ゼロまで届いた。設定は書き換えず、この計算にだけ渡す。
        // 試し計算なので、結果は本物の表に反映しない（noApply）。候補を拾うのにだけ使う。
        const res = await optimizeScheduleMILP(
          (pct, msg) => { $c.textContent = '⏳ ' + String(msg || '').slice(0, 22); },
          { fastMode: true, pickBy: 'surplus', noApply: true,
            settingsPatch: { useUpSurplus: true, penalties: { offSurplusUnused: 20000 } } });
        rows = _collectSurplusRows(res._shifts);
      } catch (e) {
        if (/^cancel/.test(e.message || '')) toast('試し計算を中止しました', 'info');
        else toast('計算に失敗しました: ' + e.message, 'error');
      } finally { calcEnd(); }
      render();
    });
    if ($a) $a.addEventListener('click', () => {
      const pick = rows.filter(r => r.checked);
      if (!pick.length) { toast('反映する場所が選ばれていません', 'error'); return; }
      pick.forEach(r => {
        const store = r.cast ? (AppState.dailyRequirementsCast || (AppState.dailyRequirementsCast = {}))
                             : (AppState.dailyRequirements || (AppState.dailyRequirements = {}));
        store[r.k] = store[r.k] || {};
        store[r.k][r.d] = r.to;
        // 教わる人が決まっているときは、その枠にその人を固定する。
        // 固定しないと、増やした枠に別の人が入ってしまい、教育にならない。
        if (r.learnerId) {
          AppState.fixedShifts[r.learnerId] = AppState.fixedShifts[r.learnerId] || {};
          AppState.fixedShifts[r.learnerId][r.d] = r.k;
        }
      });
      autoSave(); refreshAllUI();
      const who = pick[0] && pick[0].learnerName;
      toast(`${pick.length}件を反映しました${who ? '（' + who + 'さんをその日そのシフトに固定しました）' : ''}。続けて生成してください`, 'success', 7000);
      modal.remove();
    });
  };

  // 試し計算の表から「必要人数より多く入っている場所」を拾う＝最適化が足したかった場所
  function _collectSurplusRows(trial) {
    const SH = trial || AppState.shifts;
    const out = [];
    const keys = getWorkShiftKeys().filter(k => { const t = AppState.shiftTypes.find(x => x.key === k); return t && !t.isTraining; });
    getDepartmentGroups(AppState.staff).forEach(g => {
      const cast = g.key === 'cast';
      const store = cast ? (AppState.dailyRequirementsCast || {}) : (AppState.dailyRequirements || {});
      for (let d = 1; d <= days; d++) {
        const cnt = {}; keys.forEach(k => cnt[k] = 0);
        g.staff.forEach(s => { const v = (SH[s.id] || {})[d]; if (cnt[v] != null) cnt[v]++; });
        keys.forEach(k => {
          const need = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
          if (cnt[k] <= need) return;
          out.push({ d, k, from: need, to: cnt[k], cast, checked: !((store[k] || {})[d] === 0),
                     zeroed: (store[k] || {})[d] === 0,
                     tutors: _tutorsOn(d, isEarlyCategory(k) ? 'e' : 'l', SH) });
        });
      }
    });
    // 指導役がいる日を上に、次に日付順
    out.sort((a, b) => (b.tutors.length ? 1 : 0) - (a.tutors.length ? 1 : 0) || a.d - b.d);
    return out;
  }

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  render();
}

// ===== 次にやること（一本道の案内） =====
// ボタンがたくさん並んでいると、初めての人はどれを押せばいいか分からない。
// いまの状態から「次にやるべきこと」を1つだけ決めて、その場で直せるボタンを出す。
// 指示どおりに押していけば、誰でも同じ手順で完成にたどり着けるようにする。

// 「確認しました」を押したかどうか（この画面を開いている間だけ覚える）
let _nextStepAcked = false;

// 指摘に付いている「ボタン1つで直せる操作」を実行する
function applyNextAct(act) {
  if (!act) return false;
  if (act.type === 'request') {
    AppState.requests[act.staffId] = AppState.requests[act.staffId] || {};
    AppState.requests[act.staffId][act.day] = act.to;
    return true;
  }
  if (act.type === 'dailyReq') {
    AppState.dailyRequirements = AppState.dailyRequirements || {};
    AppState.dailyRequirements[act.key] = AppState.dailyRequirements[act.key] || {};
    AppState.dailyRequirements[act.key][act.day] = act.to;
    return true;
  }
  if (act.type === 'dailyReqDelete') {
    const st = (AppState.dailyRequirements || {})[act.key];
    if (st) delete st[act.day];
    return true;
  }
  return false;
}

// いまの状態から「次の一手」を決める
function computeNextStep() {
  const S = (t, d, opt) => Object.assign({ title: t, detail: d }, opt || {});
  if (!AppState.staff.length) {
    return S('スタッフを登録してください',
             'まず「👥 スタッフ管理」で、シフトに入る方を登録します。', { goTab: 'staff', btn: 'スタッフ管理をひらく' });
  }
  if (!AppState.settings.targetMonth) {
    return S('対象の月を決めてください',
             '「⚙️ 基本設定」で、何月のシフトを作るかを選びます。', { goTab: 'settings', btn: '基本設定をひらく' });
  }
  const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
  const hard = (lb && lb.reasons) || [];
  const made = !!(AppState.generated && Object.keys(AppState.shifts || {}).length);

  // ① ボタン1つで直せる問題は、作る前でも後でも最優先で出す
  const fixable = hard.find(r => r.act);
  if (fixable) {
    return S('先に直すところがあります', fixable.text,
             { danger: true, act: fixable.act, btn: fixable.act.label,
               more: hard.length - 1,
               why: 'このままだと、どう並べても必ずエラーが残ります。' });
  }

  // ② まだ作っていないときは、案内をウィザードに一本化する
  if (!made) {
    const d0 = getDaysInMonth(AppState.settings.targetMonth);
    let sur0 = 0;
    getDepartmentGroups(AppState.staff).forEach(g => { const c = calcCapacity(g, d0); if (c.surplus > 0) sur0 += c.surplus; });
    const lines = [];
    lines.push(hard.length ? `・先に直すところが ${hard.length}件 あります` : '・先に直すところはありません');
    lines.push(sur0 > 0 ? `・余（あまり）が ${sur0}人日 あります` : '・余（あまり）はありません');
    return S('シフトを作ります', 'いまの状態はこちらです。\n' + lines.join('\n'),
             { why: '下の「🧭 順番に確認して生成する」を押すと、確認しながら順番に進められます。' });
  }

  // ③ 設定を変えた直後は、まず作り直してもらう
  if (AppState._needsRegen) {
    return S('設定を変えました。作り直してください',
             '変えた設定は、シフトを作り直して初めて反映されます。いまの表はまだ前の設定のままです。',
             { btn: '🎯 じっくり生成で作り直す', run: 'generate',
               skip: '⚡ 速い生成で様子を見る', skipRun: 'generateFast',
               why: '作り直すと、いま見えているエラーの数も変わります。' });
  }

  // ③ 作ったあと
  const vios = AppState.violations || [];
  if (!vios.length) {
    return S('🎉 完成です', 'エラーはありません。「📊 シフト表」から Excel や CSV に書き出せます。',
             { ok: true, goTab: 'result', btn: 'シフト表をひらく' });
  }
  // 6連勤以上（コンプラ違反）が残っているときは、ほかより先にそれを直してもらう。
  // 設定を緩めても消えないので「このまま運用」とは言わない。
  const comps = vios.filter(v => v.type === 'consecutive' && v.compliance);
  if (comps.length) {
    const nm = (id) => (AppState.staff.find(s => s.id === id) || {}).name || '';
    const lines = comps.slice(0, 5).map(v => `・${nm(v.staffId)}さん ${v.from >= 1 ? v.from + '日' : '前月'}〜${v.to}日（${v.len}連勤）`);
    return S(`⛔ コンプラ違反（6連勤以上）が ${comps.length}件 あります。先に直してください`,
             lines.join('\n') + (comps.length > 5 ? `\n・ほか ${comps.length - 5}件` : '')
             + '\n\n連勤の途中に休みを入れてください（ほかの人と休みを入れ替える、または作り直す）。'
             + '連勤の上限を上げても消えません。',
             { danger: true, goTab: 'result', btn: 'シフト表をひらく',
               why: '6連勤以上はコンプライアンス違反のため、このままでは使えません。' });
  }
  const plans = (typeof buildRelaxPlans === 'function') ? buildRelaxPlans(vios) : [];
  const best = plans.find(p => p.measured && p.measured.gain > 0 && !p.manual);
  if (best) {
    return S(`エラーが ${vios.length}件 残っています`,
             `いちばん効くのはこれです：\n「${best.title}」\n→ いまの表で ${best.measured.gain}件 消えます。`,
             { btn: 'この設定にする', run: 'relax', plan: best,
               skip: '残りは手で直す', skipRun: 'result',
               why: '効き目は、実際に計算して確かめた数字です。' });
  }
  // ボタンでは直せない、設定そのものを見直さないと減らない問題が残っている場合
  if (hard.length) {
    const r = hard[0];
    return S(`エラー ${vios.length}件 のうち、設定を見直さないと減らないものがあります`,
             r.text + (r.fix ? '\n\n→ ' + r.fix : ''),
             { danger: true, more: hard.length - 1,
               btn: '🧭 設定を見直す（ウィザード）', run: 'wizard',
               skip: 'このまま使う（シフト表をひらく）', skipRun: 'result',
               why: '配置をどう変えても消えないので、希望休か必要人数のどちらかを動かす必要があります。' });
  }
  return S(`エラー ${vios.length}件 はここまでです`,
           '設定を緩めても、これ以上は減りません。残りは「📊 シフト表」で手直しするか、'
           + 'このまま運用してください。どうしても減らしたい場合は、希望休や必要人数の見直しが必要です。',
           { goTab: 'result', btn: 'シフト表をひらく',
             why: 'これ以上は、いまの条件では数学的に減らせないところまで来ています。' });
}

function renderNextStep() {
  const $c = document.getElementById('nextStepCard');
  if (!$c) return;
  let st;
  try { st = computeNextStep(); } catch (e) { $c.innerHTML = ''; return; }
  const tone = st.ok ? 'var(--success)' : st.danger ? 'var(--danger)' : 'var(--accent)';
  $c.innerHTML = `<div class="card" style="border-left:5px solid ${tone}">
    <div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:${tone};margin-bottom:4px">つぎにやること</div>
    <h3 style="margin:0 0 6px">${escapeHtml(st.title)}</h3>
    <div style="font-size:14px;line-height:1.8;white-space:pre-wrap">${escapeHtml(st.detail)}</div>
    ${st.why ? `<div class="hint" style="margin-top:6px">${escapeHtml(st.why)}</div>` : ''}
    ${st.more > 0 ? `<div class="hint" style="margin-top:4px">ほかにも ${st.more}件あります。1つ直すたびに、次のものが出ます。</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${st.btn ? `<button id="nsGo" class="btn btn-primary btn-large">${escapeHtml(st.btn)}</button>` : ''}
      ${st.skip ? `<button id="nsSkip" class="btn">${escapeHtml(st.skip)}</button>` : ''}
    </div>
  </div>`;
  const go = (what) => {
    if (what === 'surplus') { showSurplusPlanModal(); return; }
    if (what === 'generate') { const b = document.getElementById('btnGenerate'); if (b) b.click(); return; }
    if (what === 'generateFast') { const b = document.getElementById('btnGenerateFast'); if (b) b.click(); return; }
    if (what === 'result') { const t = document.querySelector('.tab[data-tab="result"]'); if (t) t.click(); return; }
    if (what === 'wizard') { showGenerateWizard(); return; }
    if (what === 'ack') { _nextStepAcked = true; renderNextStep(); return; }
    if (what === 'settings') { const t = document.querySelector('.tab[data-tab="settings"]'); if (t) t.click(); return; }
  };
  const $go = document.getElementById('nsGo');
  if ($go) $go.addEventListener('click', () => {
    if (st.act) {
      if (applyNextAct(st.act)) { autoSave(); refreshAllUI(); toast('直しました', 'success'); renderNextStep(); }
      return;
    }
    if (st.run === 'relax' && st.plan) {
      const ch = applyRelaxPlan(st.plan);
      AppState._needsRegen = true;          // 設定を変えたので作り直しが必要
      autoSave(); refreshAllUI();
      toast('設定を変えました：' + (ch || []).join(' / ') + '　もう一度生成してください', 'success', 7000);
      renderNextStep();
      return;
    }
    if (st.run) { go(st.run); return; }
    if (st.goTab) { const t = document.querySelector(`.tab[data-tab="${st.goTab}"]`); if (t) t.click(); }
  });
  const $sk = document.getElementById('nsSkip');
  if ($sk) $sk.addEventListener('click', () => go(st.skipRun));
}

// ===== 生成ウィザード =====
// 生成の前に確認すべきことを、順番に1つずつ見せて進む。
// 初めて触る人でも、書いてあるとおりに［次へ］を押していけば同じ手順で作れる。
// 途中で直すべきことがあれば、その場で直せるボタンを出す。
function showGenerateWizard() {
  if (!AppState.staff.length || !AppState.settings.targetMonth) {
    toast('スタッフと対象年月を設定してください', 'error'); return;
  }
  const STEPS = ['ルール', '必要人数', '希望の噛み合わせ', '余（あまり）', '生成'];
  let step = 1;
  // ── 取り消しのしくみ ────────────────────────────────
  // 「次へ」で進むとその内容が確定、「戻る」はそのページでやったことを取り消す。
  // ウィザードを開いた時点の状態も覚えておき、まるごと元に戻せるようにする。
  const SNAP_KEYS = ['settings', 'dailyRequirements', 'dailyRequirementsCast',
                     'specialDays', 'requests', 'fixedShifts', 'staff', 'skills'];
  const snap = () => { const o = {}; SNAP_KEYS.forEach(k => { o[k] = JSON.parse(JSON.stringify(AppState[k] || (Array.isArray(AppState[k]) ? [] : {}))); }); return o; };
  const restore = (o) => { if (!o) return; SNAP_KEYS.forEach(k => { AppState[k] = JSON.parse(JSON.stringify(o[k])); }); autoSave(); refreshAllUI(); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const openSnap = snap();          // 開いた時点
  let stepSnap = snap();            // いまのページに入った時点
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9980;padding:16px';
  const days = () => getDaysInMonth(AppState.settings.targetMonth);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const wdOf = (d) => { const [y, m] = String(AppState.settings.targetMonth).split('-').map(Number); return WD[new Date(y, m - 1, d).getDay()]; };
  const gotoTab = (t) => { const el = document.querySelector(`.tab[data-tab="${t}"]`); if (el) el.click(); modal.remove(); };

  // ── 各ステップの中身 ──────────────────────────────
  const body1 = () => {
    const spDays = (kind) => Object.keys(AppState.specialDays || {})
      .filter(d => AppState.specialDays[d] === kind).map(Number).sort((a, b) => a - b).join(',');
    return {
      html: `<p>必要人数を「条件」で決めておくと、<b>月が変わっても日付が自動で決まります</b>。
             毎月カレンダーに入れ直す必要がなくなり、入れ違いも起きません。</p>
        <div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px">
          <div style="font-weight:700;margin-bottom:6px">🌟 特別日（今月の日付）</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;font-size:13px">
            <span>入れ替え日</span><input type="text" id="wzRepl" value="${spDays('replacement')}" placeholder="例: 4,18,25" style="width:100%"/>
            <span>新装日</span><input type="text" id="wzRenw" value="${spDays('renewal')}" placeholder="例: 5,19,26" style="width:100%"/>
            <span>搬入日</span><input type="text" id="wzDelv" value="${spDays('delivery')}" placeholder="例: 3" style="width:100%"/>
          </div>
          <div class="hint" style="margin-top:6px">カンマ区切りで日付を入れてください。入れるとすぐ下のルールに反映されます。</div>
        </div>
        <div style="font-weight:700;margin-bottom:6px">📐 必要人数のルール</div>
        <div id="wzRules" style="max-height:38vh;overflow:auto"></div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button id="wzAddRule" class="btn">＋ ルールを追加</button>
          <button id="wzPreRule" class="btn">よく使うルールを入れる</button>
        </div>`,
      after: () => {
        renderReqRules('wzRules');
        const bindSp = (id, kind) => {
          const el = modal.querySelector('#' + id);
          if (!el) return;
          el.addEventListener('change', () => {
            for (const d in AppState.specialDays) if (AppState.specialDays[d] === kind) delete AppState.specialDays[d];
            el.value.split(',').map(x => parseInt(x.trim())).filter(x => x > 0 && x <= 31)
              .forEach(x => { AppState.specialDays[x] = kind; });
            autoSave(); reRender();
          });
        };
        bindSp('wzRepl', 'replacement'); bindSp('wzRenw', 'renewal'); bindSp('wzDelv', 'delivery');
        const add = modal.querySelector('#wzAddRule'), pre = modal.querySelector('#wzPreRule');
        if (add) add.addEventListener('click', () => { document.getElementById('btnAddReqRule').click(); reRender(); });
        if (pre) pre.addEventListener('click', () => { document.getElementById('btnReqRulePreset').click(); reRender(); });
      },
    };
  };

  const body2 = () => {
    const g = getDepartmentGroups(AppState.staff)[0] || { reqs: AppState.roleRequirements, dailyReqs: AppState.dailyRequirements };
    const keys = getWorkShiftKeys().filter(k => { const t = AppState.shiftTypes.find(x => x.key === k); return t && !t.isTraining; });
    const rowsOut = [];
    for (let d = 1; d <= days(); d++) {
      const diff = [];
      keys.forEach(k => {
        const base = (g.reqs || {})[k] || 0;
        const now = getDayReq(g.reqs, g.dailyReqs || {}, k, d);
        if (now === base) return;
        const manual = ((AppState.dailyRequirements || {})[k] || {})[d];
        const src = manual != null ? '手入力' : 'ルール';
        diff.push(`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
          ${escapeHtml(k)} ${base}→
          <input type="number" data-wzq="${k}|${d}" value="${now}" min="0" max="20" style="width:58px"/>人
          <span class="hint">(${src})</span>
          ${manual != null ? `<button class="btn" data-wzdel="${k}|${d}" style="padding:1px 7px;font-size:11px">手入力を消す</button>` : ''}
        </span>`);
      });
      if (diff.length) rowsOut.push(`<div style="padding:6px 10px;border-bottom:1px solid var(--border)"><b>${d}日(${wdOf(d)})</b> ${diff.join('')}</div>`);
    }
    const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
    const notes = (lb && lb.notes || []).map(n =>
      `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--accent) 10%, var(--surface))">
         💡 ${escapeHtml(n.text)}<div class="hint">${escapeHtml(n.fix || '')}</div></div>`).join('');
    return {
      html: `<p>既定の人数と違う日だけを並べています。<b>「ルール」は自動、「手入力」は直接入れた分</b>です。
             <b>この場で直せます。</b>「手入力を消す」を押すと、ルールどおりの人数に戻ります。</p>
        ${rowsOut.length ? `<div style="border:1px solid var(--border);border-radius:8px;max-height:36vh;overflow:auto">${rowsOut.join('')}</div>`
                         : '<p class="hint">すべて既定の人数です。</p>'}
        ${notes}
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px">
          <span>別の日を足す:</span>
          <select id="wzAddKey">${keys.map(k => `<option value="${k}">${escapeHtml(k)}</option>`).join('')}</select>
          <input type="number" id="wzAddDay" placeholder="日" min="1" max="31" style="width:64px"/>
          <input type="number" id="wzAddNum" placeholder="人数" min="0" max="20" style="width:74px"/>
          <button id="wzAddReq" class="btn">追加</button>
        </div>`,
      after: () => {
        modal.querySelectorAll('[data-wzq]').forEach(el => el.addEventListener('change', () => {
          const [k, d] = el.dataset.wzq.split('|');
          AppState.dailyRequirements = AppState.dailyRequirements || {};
          AppState.dailyRequirements[k] = AppState.dailyRequirements[k] || {};
          AppState.dailyRequirements[k][d] = Math.max(0, parseInt(el.value) || 0);
          autoSave(); reRender();
        }));
        modal.querySelectorAll('[data-wzdel]').forEach(el => el.addEventListener('click', () => {
          const [k, d] = el.dataset.wzdel.split('|');
          if ((AppState.dailyRequirements || {})[k]) delete AppState.dailyRequirements[k][d];
          autoSave(); reRender();
        }));
        const ad = modal.querySelector('#wzAddReq');
        if (ad) ad.addEventListener('click', () => {
          const k = modal.querySelector('#wzAddKey').value;
          const d = parseInt(modal.querySelector('#wzAddDay').value);
          const n = parseInt(modal.querySelector('#wzAddNum').value);
          if (!(d >= 1 && d <= days()) || isNaN(n)) { toast('日付と人数を入れてください', 'error'); return; }
          AppState.dailyRequirements = AppState.dailyRequirements || {};
          AppState.dailyRequirements[k] = AppState.dailyRequirements[k] || {};
          AppState.dailyRequirements[k][d] = Math.max(0, n);
          autoSave(); reRender();
        });
      },
    };
  };

  const body3 = () => {
    const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
    const hard = (lb && lb.reasons) || [];
    if (!hard.length) {
      return { html: `<p>✅ <b>噛み合わせの問題はありません。</b></p>
        <p class="hint">希望休・スキル・役割・連勤のどれにも、「どう並べても必ずエラーになる」組み合わせは見つかりませんでした。</p>` };
    }
    const html = hard.map((r, i) => `
      <div style="padding:10px 12px;border:1px solid color-mix(in srgb, var(--danger) 35%, transparent);border-radius:8px;margin:8px 0">
        <div>${escapeHtml(r.text)}</div>
        ${r.act ? `<button class="btn btn-primary" data-wzfix="${i}" style="margin-top:8px">${escapeHtml(r.act.label)}</button>`
                : `<div class="hint" style="margin-top:4px">${escapeHtml(r.fix || '手で直してください')}</div>`}
      </div>`).join('');
    return { html: `<p>🚨 <b>直すところが ${hard.length}件 あります。</b>
        ${lb.minErrors > 0 ? `このままだと、どう並べても ${lb.minErrors}件 のエラーが残ります。` : ''}</p>
      <p class="hint">ボタンがあるものは、押すだけで直ります。無いものは書いてある場所を直してください。</p>
      <div style="max-height:44vh;overflow:auto">${html}</div>`,
      fixes: hard };
  };

  const body4 = () => {
    let sur = 0;
    getDepartmentGroups(AppState.staff).forEach(g => { const c = calcCapacity(g, days()); if (c.surplus > 0) sur += c.surplus; });
    if (sur <= 0) return { html: `<p>✅ 余り（使われずに休みになる人日）はありません。</p>` };
    const tutors = (AppState.staff || []).filter(s => s.positionType === 'viceManager' || s.positionType === 'chief');
    return { html: `<p><b>余りが ${sur}人日 あります。</b>このままだと、その分は休みになります。</p>
      <p class="hint">トレーニングに使う場合は、<b>教わる人</b>を決めて、指導役がいる日に追加で出勤させます。
      指導役の候補は ${tutors.length ? tutors.map(t => escapeHtml(t.name)).join('・') : '（副店長・チーフが未登録）'} です。<br>
      使わない場合はそのまま［次へ］に進んでください。休みとして残ります。</p>`,
      sub: [{ label: '余の使い道を決める', run: () => { showSurplusPlanModal(); } }] };
  };

  // 生成する前の確認リスト。短く・毎回同じ順番で・右側に現状を自動で出す。
  // 「入れたつもり」を潰すのが目的なので、全部チェックしないと生成へ進めない。
  let checkState = {};
  const body5 = () => {
    const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
    const floor = lb ? lb.minErrors : 0;
    const hard = (lb && lb.reasons) || [];
    const d = days();

    // ① 希望休が1件も入っていない人
    const noReq = AppState.staff.filter(s => {
      const r = AppState.requests[s.id] || {}, f = AppState.fixedShifts[s.id] || {};
      return Object.keys(r).length === 0 && Object.keys(f).length === 0;
    });
    // ② 特別日
    const sp = { replacement: 0, renewal: 0, delivery: 0 };
    Object.keys(AppState.specialDays || {}).forEach(k => { if (sp[AppState.specialDays[k]] != null) sp[AppState.specialDays[k]]++; });
    const spTotal = sp.replacement + sp.renewal + sp.delivery;
    // ③ 余
    let sur = 0;
    getDepartmentGroups(AppState.staff).forEach(g => { const c = calcCapacity(g, d); if (c.surplus > 0) sur += c.surplus; });

    const items = [
      { id: 'c1', label: '希望休は入力しましたか？',
        // 希望休が無い人がいるのは普通のことなので、警告にはしない
        ok: true, info: noReq.length > 0,
        now: noReq.length === AppState.staff.length
               ? 'まだ1件も入っていません（希望休が無い月なら、このままで大丈夫です）'
               : noReq.length
                 ? `${AppState.staff.length - noReq.length}名ぶん入っています（希望休なし: ${noReq.map(x => x.name).join('・')}）`
                 : `${AppState.staff.length}名ぶん入っています`, go: 'calendar' },
      { id: 'c2', label: '今月の特別日を入れましたか？',
        ok: spTotal > 0,
        now: spTotal ? `入れ替え日${sp.replacement}件・新装日${sp.renewal}件・搬入日${sp.delivery}件`
                     : 'まだ1件も入っていません', step: 1 },
      { id: 'c3', label: '余（あまり）の使い道は決めましたか？',
        ok: sur === 0,
        now: sur > 0 ? `${sur}人日 が未使用です（休みになります）` : '余りはありません', step: 4 },
      { id: 'c4', label: '赤いエラーは全部直しましたか？',
        ok: hard.length === 0,
        now: hard.length ? `残り ${hard.length}件` : '残っていません', step: 3 },
    ];
    const allChecked = items.every(x => checkState[x.id]);

    const rows = items.map(x => `
      <label style="display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-bottom:1px solid var(--border);cursor:pointer">
        <input type="checkbox" data-ck="${x.id}" ${checkState[x.id] ? 'checked' : ''} style="margin-top:3px"/>
        <span style="flex:1">
          <b>${escapeHtml(x.label)}</b>
          <div class="hint" style="margin-top:2px;color:${x.ok ? 'var(--text-soft)' : 'var(--danger)'}">
            ${x.ok ? (x.info ? 'ℹ️' : '✅') : '⚠️'} ${escapeHtml(x.now)}
          </div>
        </span>
        ${(x.go || x.step) ? `<button class="btn" data-ckgo="${x.id}" style="padding:2px 10px;font-size:12px;align-self:center">見に行く</button>` : ''}
      </label>`).join('');

    const vios = AppState.violations || [];
    const plans = (vios.length && typeof buildRelaxPlans === 'function') ? buildRelaxPlans(vios) : [];
    const best = plans.find(pl => pl.measured && pl.measured.gain > 0 && !pl.manual);

    return {
      html: `<p><b>生成する前の確認（4つだけ）</b><br>
             <span class="hint">右側に今の状態を出しています。「入れたつもり」を防ぐためのものです。</span></p>
        <div style="border:1px solid var(--border);border-radius:8px">${rows}</div>
        <div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--surface-2);line-height:1.9">
          ${floor > 0
            ? `⚠️ <b>どう並べても ${floor}件 のエラーは残ります</b>（証明済み）。それ以外は並べ方しだいで消せます。`
            : `✅ <b>「どう並べても残るエラー」はありません。</b>並び方のルール（連休の長さ・時間帯の切替など）によるエラーは出ることがあります。`}
          ${best ? `<br>💡 前回の表では「${escapeHtml(best.title)}」で ${best.measured.gain}件 減りました。` : ''}
        </div>
        ${allChecked ? '' : '<p class="hint" style="margin-top:8px;color:var(--danger)">4つ全部にチェックを入れると、生成できるようになります。</p>'}`,
      sub: [{ label: '⚡ 速い生成（1分）で様子を見る', run: () => { modal.remove(); const b = document.getElementById('btnGenerateFast'); if (b) b.click(); } }],
      after: () => {
        modal.querySelectorAll('[data-ck]').forEach(cb => cb.addEventListener('change', () => {
          checkState[cb.dataset.ck] = cb.checked; reRender();
        }));
        modal.querySelectorAll('[data-ckgo]').forEach(btn => btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const it = items.find(x => x.id === btn.dataset.ckgo);
          if (!it) return;
          if (it.step) { step = it.step; stepSnap = snap(); render(); return; }
          if (it.go) gotoTab(it.go);
        }));
        const g = modal.querySelector('#wzNext');
        if (g) { g.disabled = !allChecked; g.style.opacity = allChecked ? '' : '.5'; }
      },
    };
  };

  const BODIES = [body1, body2, body3, body4, body5];

  // 入力欄の操作中に描き直すと、ブラウザが「消えた要素を触ろうとした」と怒るので一拍おく
  const reRender = () => setTimeout(() => { try { render(); } catch (e) { /* 閉じた後は何もしない */ } }, 0);
  const render = () => {
    const b = BODIES[step - 1]();
    const now = snap();
    const changedStep = !same(stepSnap, now);
    const changedAll  = !same(openSnap, now);
    const nav = STEPS.map((s, i) => {
      const n = i + 1, cur = n === step;
      return `<span style="padding:3px 9px;border-radius:999px;font-size:12px;white-space:nowrap;
        ${cur ? 'background:var(--accent);color:#fff;font-weight:700' : 'background:var(--surface-2);color:var(--text-soft)'}">${n}. ${s}</span>`;
    }).join('<span style="color:var(--text-soft)">›</span>');
    modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;max-width:720px;width:100%;max-height:88vh;overflow:auto;padding:20px">
      <h3 style="margin:0 0 8px">🧭 順番に確認して生成する</h3>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:14px">${nav}</div>
      <div style="font-size:14px;line-height:1.8">${b.html}</div>
      ${changedStep ? `<div style="margin-top:10px;padding:8px 12px;border-radius:8px;font-size:13px;
             background:color-mix(in srgb, var(--accent) 10%, var(--surface));
             border:1px solid color-mix(in srgb, var(--accent) 30%, transparent)">
          このページで設定を変えました。<b>［次へ］で確定</b>、<b>［戻る］か［このページの変更を取り消す］で元に戻ります。</b>
        </div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center">
        ${step > 1 ? '<button id="wzPrev" class="btn">← 戻る</button>' : ''}
        ${changedStep ? '<button id="wzUndo" class="btn">このページの変更を取り消す</button>' : ''}
        ${(b.sub || []).map((x, i) => `<button class="btn" data-wzsub="${i}">${escapeHtml(x.label)}</button>`).join('')}
        <span style="flex:1"></span>
        ${changedAll ? '<button id="wzReset" class="btn">最初の状態に戻す</button>' : ''}
        <button id="wzClose" class="btn">閉じる</button>
        <button id="wzNext" class="btn btn-primary btn-large">${step < 5 ? '次へ →' : '🎯 じっくり生成をはじめる'}</button>
      </div>
    </div>`;
    const $ = (id) => modal.querySelector('#' + id);
    if ($('wzPrev')) $('wzPrev').addEventListener('click', () => {
      // このページでやったことは取り消してから戻る
      if (!same(stepSnap, snap())) { restore(stepSnap); toast('このページでの変更を取り消しました', 'info'); }
      step--; stepSnap = snap(); render();
    });
    if ($('wzUndo')) $('wzUndo').addEventListener('click', () => {
      restore(stepSnap); toast('このページでの変更を取り消しました', 'info'); render();
    });
    if ($('wzReset')) $('wzReset').addEventListener('click', () => {
      restore(openSnap); stepSnap = snap();
      toast('ウィザードを開く前の状態に戻しました', 'info', 5000); render();
    });
    if ($('wzClose')) $('wzClose').addEventListener('click', () => {
      if (!same(openSnap, snap())) {
        if (!confirm('ここで変えた設定は残ります。\n\n［OK］変更を残して閉じる\n［キャンセル］閉じずに続ける')) return;
      }
      modal.remove();
    });
    if ($('wzNext')) $('wzNext').addEventListener('click', () => {
      if (step < 5) { step++; stepSnap = snap(); render(); return; }
      modal.remove();
      const g = document.getElementById('btnGenerate'); if (g) g.click();
    });
    modal.querySelectorAll('[data-wzsub]').forEach(btn => btn.addEventListener('click', () => {
      const x = (b.sub || [])[parseInt(btn.dataset.wzsub)];
      if (!x) return;
      if (x.go) { gotoTab(x.go); return; }
      if (x.run) { x.run(); }
    }));
    modal.querySelectorAll('[data-wzfix]').forEach(btn => btn.addEventListener('click', () => {
      const r = (b.fixes || [])[parseInt(btn.dataset.wzfix)];
      if (r && r.act && applyNextAct(r.act)) { autoSave(); refreshAllUI(); toast('直しました', 'success'); render(); }
    }));
    if (b.after) b.after();
  };
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  render();
}
