/* ===========================================
   ui.js - UI描画とイベント管理 (v3 - 動的シフト種別対応)
   =========================================== */

// ===== トースト表示 =====
function toast(message, type = 'info', duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast ' + type; }, duration);
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

  if ($month)     $month.value       = AppState.settings.targetMonth || '';
  if ($maxCons)   $maxCons.value     = AppState.settings.maxConsecutive;
  if ($forbidLE)  $forbidLE.checked  = AppState.settings.forbidLateEarly;
  if ($penaltySO) $penaltySO.checked = AppState.settings.penaltySingleOff;
  if ($maxAtt)    $maxAtt.value      = AppState.settings.maxAttempts;

  if ($replDays) {
    $replDays.value = Object.keys(AppState.specialDays)
      .filter(d => AppState.specialDays[d] === 'replacement').join(',');
  }
  if ($renwDays) {
    $renwDays.value = Object.keys(AppState.specialDays)
      .filter(d => AppState.specialDays[d] === 'renewal').join(',');
  }

  // ペナルティパネルが開いていれば再描画
  const pp = document.getElementById('penaltyPanel');
  if (pp && pp.style.display !== 'none') renderPenaltyInputs();

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
  document.querySelectorAll('.tab').forEach(tab => {
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
  $maxAtt.value      = AppState.settings.maxAttempts;

  $replDays.value = Object.keys(AppState.specialDays)
    .filter(d => AppState.specialDays[d] === 'replacement').join(',');
  $renwDays.value = Object.keys(AppState.specialDays)
    .filter(d => AppState.specialDays[d] === 'renewal').join(',');

  $month.addEventListener('change', () => {
    AppState.settings.targetMonth = $month.value;
    renderCalendar();
    renderResultTable();
    autoSave();
  });
  $maxCons.addEventListener('change', () => {
    AppState.settings.maxConsecutive = parseInt($maxCons.value) || 4;
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
  $maxAtt.addEventListener('change', () => {
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

// ペナルティパネル開閉（index.html の onclick="togglePenaltyPanel()" から呼ばれる）
function togglePenaltyPanel() {
  const panel  = document.getElementById('penaltyPanel');
  const toggle = document.getElementById('penaltyToggle');
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = isHidden ? 'block' : 'none';
  if (toggle) toggle.textContent = isHidden ? '▼ 閉じる' : '▶ 展開';
  if (isHidden) renderPenaltyInputs();
}

function renderPenaltyInputs() {
  const container = document.getElementById('penaltyInputs');
  if (!container) return;
  container.innerHTML = '';

  const P   = AppState.settings.penalties;
  const DEF = (typeof DEFAULT_PENALTIES !== 'undefined') ? DEFAULT_PENALTIES : {};
  const labels = {
    understaff:      '🚨 人員不足（1人あたり）',
    overstaff:       '⚠️ 人員超過（1人あたり）',
    respDuplicate:   '👥 責任者・総務の重複',
    disallowedShift: '🚫 担当外シフト',
    consBase:        '📅 連勤超過（1日あたり）',
    consSq:          '📅 連勤超過（二乗項）',
    lateEarly:       '🌙→☀️ 遅→早インターバル',
    categorySwitch:  '🔄 連勤中の時間帯切替',
    badRest:         '💤 遅→休→早',
    singleOff:          '🏖 単発休み',
    singleWork:         '💼 単発出勤',
    offShortage:        '📆 公休不足（1日あたり）',
    balanceDiff:        '⚖️ 早遅バランスずれ',
    viceManagerRest:    '👔 副店長が任意で休む',
    viceManagerDailyAbsent: '👔 副店長が1人も出勤しない日',
    hierarchyViolation: '👑 責任者ヒエラルキー違反',
    prefMismatch:       '🕐 早遅希望違反（早可/遅可）',
    eventAbsent:        '📌 行事日に対象者が休み',
    restPairBonus:      '🏝 連休ボーナス（2連休以上を優先）',
  };

  Object.entries(labels).forEach(([key, label]) => {
    const val = P[key] != null ? P[key] : (DEF[key] || 0);
    const div = document.createElement('div');
    div.className = 'penalty-item';
    div.innerHTML = `
      <label class="penalty-label">${label}</label>
      <input type="number" min="0" max="100000" step="100"
             value="${val}" data-pkey="${key}" class="penalty-input"/>
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('input[data-pkey]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.pkey;
      AppState.settings.penalties[key] = parseInt(e.target.value) || 0;
      autoSave();
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
               data-idx="${idx}" class="role-req-cast-input" style="width:60px"/>
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
  html += '<table style="border-collapse:collapse;font-size:12px">';
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

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // 全クリアボタン
  const btnClear = container.querySelector('#btnClearDailyReq');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      const emp  = Object.keys(AppState.dailyRequirements || {}).some(k => Object.keys(AppState.dailyRequirements[k] || {}).length > 0);
      const cast = Object.keys(AppState.dailyRequirementsCast || {}).some(k => Object.keys(AppState.dailyRequirementsCast[k] || {}).length > 0);
      if (!emp && !cast) { toast('上書き設定はありません', 'info'); return; }
      if (!confirm('日別の上書き設定を全てクリアしますか？\nデフォルト必要人数には影響しません。')) return;
      AppState.dailyRequirements     = {};
      AppState.dailyRequirementsCast = {};
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
    return `
    <div class="skill-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <input type="text" value="${escapeHtml(sk.name)}" data-skill-idx="${i}" data-skill-field="name"
             style="width:140px" placeholder="スキル名（例: 営業）"/>
      <select data-skill-idx="${i}" data-skill-field="target" style="width:72px">
        <option value="late"  ${target === 'late'  ? 'selected' : ''}>遅番</option>
        <option value="early" ${target === 'early' ? 'selected' : ''}>早番</option>
      </select>
      <span class="hint">に必要な人数:</span>
      <input type="number" min="0" max="20" value="${req}" data-skill-idx="${i}" data-skill-field="req"
             style="width:56px"/>
      <button class="btn-icon" data-skill-del="${i}" title="削除">🗑</button>
    </div>`;
  }).join('');

  container.querySelectorAll('input[data-skill-field]').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.skillIdx);
      const field = e.target.dataset.skillField;
      if (!AppState.skills[idx]) return;
      const oldName = AppState.skills[idx].name;
      if (field === 'req') {
        AppState.skills[idx].req = parseInt(e.target.value) || 0;
        delete AppState.skills[idx].lateReq; // 旧フィールドを掃除
      } else if (field === 'target') {
        AppState.skills[idx].target = e.target.value;
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
        renderStaffTable();
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
      renderSkillsPanel();
      renderStaffTable();
      autoSave();
    });
  });
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
        <select data-field="balance" data-id="${s.id}" style="min-width:90px">
          ${Object.entries(SHIFT_BALANCE).map(([k, v]) =>
            `<option value="${k}" ${(s.balance || 'balanced') === k ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </td>
      <td>
        <input type="number" min="0" max="6" value="${s.prevConsecutive || 0}"
               data-field="prevConsecutive" data-id="${s.id}" style="width:50px"/>
      </td>
      <td>
        <select data-field="prevLastShift" data-id="${s.id}">
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
      if (['maxOff', 'prevConsecutive', 'paidLeave'].includes(field)) val = parseInt(val) || 0;
      staff[field] = val;
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
      sep.innerHTML = `<td colspan="${days + 1}" style="background:#edf2f7;font-weight:700;padding:4px 8px">${g.label}</td>`;
      tbody.appendChild(sep);
    }
    g.staff.forEach(s => {
      const tr = document.createElement('tr');
      let html = `<td>${escapeHtml(s.name)}</td>`;
      for (let d = 1; d <= days; d++) {
        const w     = getWeekday(AppState.settings.targetMonth, d);
        const cls   = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
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

  // ヘッダー
  const STAT_COLS = 7; // 名前列1 + 統計列6（公休/有給他/余/出勤/差/労働時間）
  const thead = document.createElement('thead');
  let headRow = '<tr><th>名前</th>';
  for (let d = 1; d <= days; d++) {
    const w   = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    headRow += `<th class="${cls}">${d}<br><small>${getWeekdayLabel(w)}</small></th>`;
  }
  headRow += '<th>公休</th><th>有給他</th><th>余<br><small>余剰</small></th><th>出勤</th><th>差</th><th>労働<br><small>時間</small></th></tr>';
  thead.innerHTML = headRow;
  table.appendChild(thead);

  // 違反マップ
  const vioMap = {};
  AppState.violations.forEach(v => {
    if (!vioMap[v.staffId]) vioMap[v.staffId] = {};
    vioMap[v.staffId][v.day] = v;
  });

  const tbody = document.createElement('tbody');
  const resGroups = getDepartmentGroups();

  resGroups.forEach(g => {
    if (resGroups.length > 1) {
      const sep = document.createElement('tr');
      sep.className = 'dept-separator';
      sep.innerHTML = `<td colspan="${days + STAT_COLS}" style="background:#edf2f7;font-weight:700;padding:4px 8px">${g.label}</td>`;
      tbody.appendChild(sep);
    }

    // スタッフ行
    g.staff.forEach(s => {
      const tr = document.createElement('tr');
      let workCount = 0, publicOffCount = 0, otherOffCount = 0, surplusCount = 0, totalHours = 0;
      let cells = `<td>${escapeHtml(s.name)}</td>`;
      for (let d = 1; d <= days; d++) {
        const w     = getWeekday(AppState.settings.targetMonth, d);
        const wcls  = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
        const shift = (AppState.shifts[s.id] || {})[d] || '';
        const cls   = getShiftClass(shift);
        const sty   = getShiftStyle(shift);
        const vio     = (vioMap[s.id] || {})[d] ? ' violation' : '';
        const vMsg    = vio ? escapeHtml(((vioMap[s.id] || {})[d] || {}).message || '') : '';
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

    // 集計行（部門の必要人数 > 0 のシフト種別）
    const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);
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
        cells += `<td class="${cls}">${count}</td>`;
      }
      cells += '<td></td><td></td><td></td><td></td><td></td><td></td>';
      tr.innerHTML = cells;
      tbody.appendChild(tr);
    });
  });

  table.appendChild(tbody);

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
      recordShiftHistory();
      const sid1 = dragSource.dataset.sid, d1 = parseInt(dragSource.dataset.day);
      const sid2 = td.dataset.sid,         d2 = parseInt(td.dataset.day);
      const v1 = (AppState.shifts[sid1] || {})[d1] || '';
      const v2 = (AppState.shifts[sid2] || {})[d2] || '';
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
      refreshAfterManualEdit();
      toast('シフトを交換しました', 'info', 1500);
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
    recordShiftHistory();
    const sid      = editingCell.dataset.sid;
    const d        = parseInt(editingCell.dataset.day);
    const newShift = btn.dataset.shift;
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
    refreshAfterManualEdit();
    const fixedMark = newShift ? ' 🔒' : '';
    toast(`${staffName} ${d}日 →「${newShift || '空'}」に変更${fixedMark}`, 'info', 1500);
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

function _snapshotShiftState() {
  return {
    shifts: JSON.parse(JSON.stringify(AppState.shifts || {})),
    fixed:  JSON.parse(JSON.stringify(AppState.fixedShifts || {})),
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
  if (_undoStack.length === 0) { toast('これ以上 戻せません', 'info', 1200); return; }
  _redoStack.push(_snapshotShiftState());
  _applyShiftState(_undoStack.pop());
  toast('元に戻しました', 'info', 1200);
}

function redoShiftEdit() {
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
function refreshAfterManualEdit() {
  AppState.violations = checkViolations(AppState.shifts);
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
