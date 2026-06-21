/* ===========================================
   ui.js - UI描画とイベント管理
   =========================================== */

function toast(message, type = 'info', duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast ' + type; }, duration);
}

let _autoSaveTimer = null;
function autoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    if (typeof saveToStorage === 'function') saveToStorage();
    _autoSaveTimer = null;
  }, 300);
}

function refreshAllUI() {
  const $month = document.getElementById('targetMonth');
  const $maxCons = document.getElementById('maxConsecutive');
  const $forbidLE = document.getElementById('forbidLateEarly');
  const $penaltySO = document.getElementById('penaltySingleOff');
  const $maxAtt = document.getElementById('maxAttempts');
  const $replacementDays = document.getElementById('replacementDays');
  const $renewalDays = document.getElementById('renewalDays');
  if ($month) $month.value = AppState.settings.targetMonth || '';
  if ($maxCons) $maxCons.value = AppState.settings.maxConsecutive;
  if ($forbidLE) $forbidLE.checked = AppState.settings.forbidLateEarly;
  if ($penaltySO) $penaltySO.checked = AppState.settings.penaltySingleOff;
  if ($maxAtt) $maxAtt.value = AppState.settings.maxAttempts;
  if ($replacementDays) {
    const arr = Object.keys(AppState.specialDays).filter(d => AppState.specialDays[d] === 'replacement');
    $replacementDays.value = arr.join(',');
  }
  if ($renewalDays) {
    const arr = Object.keys(AppState.specialDays).filter(d => AppState.specialDays[d] === 'renewal');
    $renewalDays.value = arr.join(',');
  }
  renderRoleTable();
  renderStaffTable();
  renderCalendar();
  renderResultTable();
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + target).classList.add('active');

      if (target === 'roles') renderRoleTable();
      if (target === 'staff') renderStaffTable();
      if (target === 'calendar') renderCalendar();
      if (target === 'result') renderResultTable();
    });
  });
}

function setupSettingsPanel() {
  const $month = document.getElementById('targetMonth');
  const $maxCons = document.getElementById('maxConsecutive');
  const $forbidLE = document.getElementById('forbidLateEarly');
  const $penaltySO = document.getElementById('penaltySingleOff');
  const $maxAtt = document.getElementById('maxAttempts');
  const $replacementDays = document.getElementById('replacementDays');
  const $renewalDays = document.getElementById('renewalDays');

  if (!AppState.settings.targetMonth) {
    const now = new Date();
    AppState.settings.targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  $month.value = AppState.settings.targetMonth;
  $maxCons.value = AppState.settings.maxConsecutive;
  $forbidLE.checked = AppState.settings.forbidLateEarly;
  $penaltySO.checked = AppState.settings.penaltySingleOff;
  $maxAtt.value = AppState.settings.maxAttempts;

  const replacementArr = Object.keys(AppState.specialDays).filter(d => AppState.specialDays[d] === 'replacement');
  const renewalArr = Object.keys(AppState.specialDays).filter(d => AppState.specialDays[d] === 'renewal');
  $replacementDays.value = replacementArr.join(',');
  $renewalDays.value = renewalArr.join(',');

  $month.addEventListener('change', () => {
    AppState.settings.targetMonth = $month.value;
    renderCalendar();
    renderResultTable();
    renderDailyReqTable();
  });
  $maxCons.addEventListener('change', () => {
    AppState.settings.maxConsecutive = parseInt($maxCons.value) || 4;
  });
  $forbidLE.addEventListener('change', () => {
    AppState.settings.forbidLateEarly = $forbidLE.checked;
  });
  $penaltySO.addEventListener('change', () => {
    AppState.settings.penaltySingleOff = $penaltySO.checked;
  });
  $maxAtt.addEventListener('change', () => {
    AppState.settings.maxAttempts = parseInt($maxAtt.value) || 100000;
  });

  $replacementDays.addEventListener('change', () => {
    const days = $replacementDays.value.split(',').map(d => parseInt(d.trim())).filter(d => d > 0 && d <= 31);
    for (const d in AppState.specialDays) {
      if (AppState.specialDays[d] === 'replacement') delete AppState.specialDays[d];
    }
    days.forEach(d => AppState.specialDays[d] = 'replacement');
  });

  $renewalDays.addEventListener('change', () => {
    const days = $renewalDays.value.split(',').map(d => parseInt(d.trim())).filter(d => d > 0 && d <= 31);
    for (const d in AppState.specialDays) {
      if (AppState.specialDays[d] === 'renewal') delete AppState.specialDays[d];
    }
    days.forEach(d => AppState.specialDays[d] = 'renewal');
  });
}

function renderRoleTable() {
  const tbody = document.getElementById('roleTableBody');
  tbody.innerHTML = '';
  Object.entries(SHIFT_TYPES).forEach(([enumKey, info]) => {
    const tr = document.createElement('tr');
    const req = AppState.roleRequirements[info.key] || 0;
    const color = AppState.roleColors[info.key] || '#ffffff';
    tr.innerHTML = `
      <td><span class="shift-cell ${info.class}" style="display:inline-block;width:48px;height:28px;line-height:28px;border-radius:4px">${info.key}</span></td>
      <td>${info.label}</td>
      <td><input type="number" min="0" max="20" value="${req}" data-role="${info.key}" class="role-req-input"/></td>
      <td><input type="color" value="${color}" data-role="${info.key}" class="role-color-input"/></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.role-req-input').forEach(input => {
    input.addEventListener('change', e => {
      const role = e.target.dataset.role;
      AppState.roleRequirements[role] = parseInt(e.target.value) || 0;
      autoSave();
    });
  });
  tbody.querySelectorAll('.role-color-input').forEach(input => {
    input.addEventListener('change', e => {
      const role = e.target.dataset.role;
      AppState.roleColors[role] = e.target.value;
      autoSave();
    });
  });

  renderDailyReqTable();
}

function renderDailyReqTable() {
  const area = document.getElementById('dailyReqArea');
  if (!area) return;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  if (!AppState.settings.targetMonth) {
    area.innerHTML = '<p class="hint">対象年月を設定すると入力欄が表示されます。</p>';
    return;
  }

  const keys = Object.values(SHIFT_TYPES).map(v => v.key);

  let html = '<div class="table-wrap"><table class="daily-req-table"><thead><tr><th>シフト</th>';
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    html += `<th class="${cls}">${d}</th>`;
  }
  html += '</tr></thead><tbody>';

  keys.forEach(key => {
    html += `<tr><th>${key}</th>`;
    for (let d = 1; d <= days; d++) {
      const dr = AppState.dailyRequirements;
      const val = (dr[d] && dr[d][key] !== undefined) ? dr[d][key] : '';
      html += `<td><input type="number" min="0" max="20" placeholder="${AppState.roleRequirements[key] || 0}" value="${val}" data-day="${d}" data-key="${key}" class="daily-req-input"/></td>`;
    }
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  area.innerHTML = html;

  area.querySelectorAll('.daily-req-input').forEach(input => {
    input.addEventListener('change', e => {
      const d = parseInt(e.target.dataset.day);
      const key = e.target.dataset.key;
      const val = e.target.value.trim();
      if (!AppState.dailyRequirements[d]) AppState.dailyRequirements[d] = {};
      if (val === '') {
        delete AppState.dailyRequirements[d][key];
        if (Object.keys(AppState.dailyRequirements[d]).length === 0) {
          delete AppState.dailyRequirements[d];
        }
      } else {
        AppState.dailyRequirements[d][key] = parseInt(val) || 0;
      }
      autoSave();
    });
  });
}

function renderStaffTable() {
  const tbody = document.getElementById('staffTableBody');
  tbody.innerHTML = '';
  AppState.staff.forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(s.name)}" data-field="name" data-id="${s.id}"/></td>
      <td>
        <select data-field="positionType" data-id="${s.id}">
          ${Object.entries(POSITION_TYPES).map(([k, v]) =>
            `<option value="${k}" ${s.positionType === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </td>
      <td>
        <select data-field="roleType" data-id="${s.id}">
          ${Object.entries(ROLE_TYPES).map(([k, v]) =>
            `<option value="${k}" ${s.roleType === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" min="0" max="31" value="${s.maxOff}" data-field="maxOff" data-id="${s.id}"/></td>
      <td>
        <div class="shift-pref">
          ${SHIFT_PREFS.map(p =>
            `<label><input type="checkbox" data-pref="${p}" data-id="${s.id}" ${s.prefs.includes(p) ? 'checked' : ''}/>${p}</label>`).join('')}
        </div>
      </td>
      <td>
        <select data-field="balance" data-id="${s.id}">
          ${Object.entries(SHIFT_BALANCE).map(([k, v]) =>
            `<option value="${k}" ${(s.balance || 'balanced') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" min="0" max="6" value="${s.prevConsecutive}" data-field="prevConsecutive" data-id="${s.id}"/></td>
      <td>
        <select data-field="prevLastShift" data-id="${s.id}">
          <option value=""  ${(s.prevLastShift || '') === ''  ? 'selected' : ''}>―</option>
          <option value="早" ${(s.prevLastShift || '') === '早' ? 'selected' : ''}>早</option>
          <option value="遅" ${(s.prevLastShift || '') === '遅' ? 'selected' : ''}>遅</option>
        </select>
      </td>
      <td><input type="text" value="${escapeHtml(s.note || '')}" data-field="note" data-id="${s.id}"/></td>
      <td><button class="btn-icon" data-del="${s.id}" title="削除">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('input[data-field], select[data-field]').forEach(el => {
    el.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const field = e.target.dataset.field;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      let val = e.target.value;
      if (['maxOff', 'prevConsecutive'].includes(field)) val = parseInt(val) || 0;
      staff[field] = val;
    });
  });
  tbody.querySelectorAll('input[data-pref]').forEach(el => {
    el.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const pref = e.target.dataset.pref;
      const staff = AppState.staff.find(s => s.id === id);
      if (!staff) return;
      if (e.target.checked) {
        if (!staff.prefs.includes(pref)) staff.prefs.push(pref);
      } else {
        staff.prefs = staff.prefs.filter(p => p !== pref);
      }
    });
  });
  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.del;
      if (confirm('このスタッフを削除しますか？')) {
        AppState.staff = AppState.staff.filter(s => s.id !== id);
        delete AppState.requests[id];
        delete AppState.shifts[id];
        renderStaffTable();
      }
    });
  });
}

function setupStaffPanel() {
  document.getElementById('btnAddStaff').addEventListener('click', () => {
    if (AppState.staff.length >= 20) {
      toast('最大20人までです', 'error');
      return;
    }
    AppState.staff.push({
      id: newStaffId(),
      name: '新規スタッフ',
      positionType: 'staff',
      roleType: 'normal',
      maxOff: 9,
      prefs: ['早可', '遅可'],
      balance: 'balanced',
      prevConsecutive: 0,
      prevLastShift: '',
      note: '',
    });
    renderStaffTable();
  });
}

let selectedMark = '休';

function renderCalendar() {
  const table = document.getElementById('calendarTable');
  table.innerHTML = '';
  const days = getDaysInMonth(AppState.settings.targetMonth);

  const thead = document.createElement('thead');
  let headRow = '<tr><th>名前</th>';
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    headRow += `<th class="${cls}">${d}<br><small>${getWeekdayLabel(w)}</small></th>`;
  }
  headRow += '</tr>';
  thead.innerHTML = headRow;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  AppState.staff.forEach(s => {
    const tr = document.createElement('tr');
    let html = `<td>${escapeHtml(s.name)}</td>`;
    for (let d = 1; d <= days; d++) {
      const w = getWeekday(AppState.settings.targetMonth, d);
      const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
      const cur = (AppState.requests[s.id] || {})[d] || '';
      const shiftCls = getShiftClass(cur);
      html += `<td class="${cls}" data-sid="${s.id}" data-day="${d}"><span class="shift-cell ${shiftCls}">${cur}</span></td>`;
    }
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tbody.querySelectorAll('td[data-sid]').forEach(td => {
    td.addEventListener('click', () => {
      const sid = td.dataset.sid;
      const d = parseInt(td.dataset.day);
      if (!AppState.requests[sid]) AppState.requests[sid] = {};
      if (selectedMark === '') {
        delete AppState.requests[sid][d];
      } else {
        AppState.requests[sid][d] = selectedMark;
      }
      const span = td.querySelector('.shift-cell');
      span.textContent = selectedMark;
      span.className = 'shift-cell ' + getShiftClass(selectedMark);
    });
    td.addEventListener('dblclick', () => {
      const sid = td.dataset.sid;
      const d = parseInt(td.dataset.day);
      if (AppState.requests[sid]) delete AppState.requests[sid][d];
      const span = td.querySelector('.shift-cell');
      span.textContent = '';
      span.className = 'shift-cell s-empty';
    });
  });
}

function setupCalendarPanel() {
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMark = btn.dataset.mark;
    });
  });
  document.querySelector('.chip-btn[data-mark="休"]').classList.add('active');
}

function renderResultTable() {
  const table = document.getElementById('resultTable');
  table.innerHTML = '';
  const days = getDaysInMonth(AppState.settings.targetMonth);

  if (!AppState.generated || AppState.staff.length === 0) {
    table.innerHTML = '<tr><td style="padding:30px;text-align:center;color:#999">まだシフトが生成されていません。「⑤ 自動生成」タブから実行してください。</td></tr>';
    document.getElementById('summaryArea').innerHTML = '';
    return;
  }

  const thead = document.createElement('thead');
  let headRow = '<tr><th>名前</th>';
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    const cls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
    headRow += `<th class="${cls}">${d}<br><small>${getWeekdayLabel(w)}</small></th>`;
  }
  headRow += '<th>勤務</th><th>休</th></tr>';
  thead.innerHTML = headRow;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const violationsMap = {};
  AppState.violations.forEach(v => {
    if (!violationsMap[v.staffId]) violationsMap[v.staffId] = {};
    violationsMap[v.staffId][v.day] = v;
  });

  AppState.staff.forEach(s => {
    const tr = document.createElement('tr');
    let workCount = 0, offCount = 0;
    let cells = `<td>${escapeHtml(s.name)}</td>`;
    for (let d = 1; d <= days; d++) {
      const w = getWeekday(AppState.settings.targetMonth, d);
      const wcls = w === 0 ? 'weekend-sun' : w === 6 ? 'weekend-sat' : '';
      const shift = (AppState.shifts[s.id] || {})[d] || '';
      const cls = getShiftClass(shift);
      const vio = violationsMap[s.id] && violationsMap[s.id][d] ? ' violation' : '';
      const vTitle = vio ? `title="${escapeHtml(violationsMap[s.id][d].message)}"` : '';
      if (isWork(shift)) workCount++;
      else if (isOff(shift)) offCount++;
      cells += `<td class="${wcls}" data-sid="${s.id}" data-day="${d}">
        <span class="shift-cell ${cls}${vio}" draggable="true" ${vTitle}>${shift}</span>
      </td>`;
    }
    cells += `<td>${workCount}</td><td>${offCount}</td>`;
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  });

  const summaryShiftKeys = ['早責', '遅責', '早総務', '遅総務', '早', '遅', '夜勤'];
  summaryShiftKeys.forEach(key => {
    let hasAny = false;
    for (let d = 1; d <= days; d++) { if (getDayReq(d, key) > 0) { hasAny = true; break; } }
    if (!hasAny) return;
    const defaultReq = AppState.roleRequirements[key] || 0;
    const tr = document.createElement('tr');
    tr.className = 'summary-row';
    let cells = `<td>${key} (必要${defaultReq})</td>`;
    for (let d = 1; d <= days; d++) {
      let count = 0;
      AppState.staff.forEach(s => {
        if ((AppState.shifts[s.id] || {})[d] === key) count++;
      });
      const req = getDayReq(d, key);
      const cls = count < req ? 'under' : (count > req ? 'over' : '');
      cells += `<td class="${cls}">${count}</td>`;
    }
    cells += '<td></td><td></td>';
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  setupDragAndDrop();
  setupManualEdit();
  renderSummary();
}

function renderSummary() {
  const area = document.getElementById('summaryArea');
  const days = getDaysInMonth(AppState.settings.targetMonth);

  let html = '<table style="width:auto"><thead><tr><th>スタッフ</th>';
  ['早責', '遅責', '早総務', '遅総務', '早', '遅', '研', '休系', '合計勤務'].forEach(h => html += `<th>${h}</th>`);
  html += '</tr></thead><tbody>';

  AppState.staff.forEach(s => {
    const counts = { '早責': 0, '遅責': 0, '早総務': 0, '遅総務': 0, '早': 0, '遅': 0, '研': 0, off: 0, work: 0 };
    for (let d = 1; d <= days; d++) {
      const sh = (AppState.shifts[s.id] || {})[d] || '';
      if (counts[sh] !== undefined) {
        counts[sh]++;
        counts.work++;
      } else if (isOff(sh)) {
        counts.off++;
      }
    }
    html += `<tr><td>${escapeHtml(s.name)}</td>`;
    ['早責', '遅責', '早総務', '遅総務', '早', '遅', '研'].forEach(k => html += `<td>${counts[k]}</td>`);
    html += `<td>${counts.off}</td><td>${counts.work}</td></tr>`;
  });
  html += '</tbody></table>';
  area.innerHTML = html;
}

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
      setTimeout(() => { dragSource = null; }, 50);
    });
  });
  document.querySelectorAll('.result-table td[data-sid]').forEach(td => {
    td.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const span = td.querySelector('.shift-cell');
      if (span) span.classList.add('drag-over');
    });
    td.addEventListener('dragleave', e => {
      const span = td.querySelector('.shift-cell');
      if (span) span.classList.remove('drag-over');
    });
    td.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSource || dragSource === td) return;
      const sid1 = dragSource.dataset.sid;
      const d1 = parseInt(dragSource.dataset.day);
      const sid2 = td.dataset.sid;
      const d2 = parseInt(td.dataset.day);
      const v1 = (AppState.shifts[sid1] || {})[d1] || '';
      const v2 = (AppState.shifts[sid2] || {})[d2] || '';
      if (!AppState.shifts[sid1]) AppState.shifts[sid1] = {};
      if (!AppState.shifts[sid2]) AppState.shifts[sid2] = {};
      AppState.shifts[sid1][d1] = v2;
      AppState.shifts[sid2][d2] = v1;
      dragSource = null;
      refreshAfterManualEdit();
      toast('シフトを交換しました', 'info', 1500);
    });
  });
}

let editingCell = null;
let modalListenersInstalled = false;

function setupManualEdit() {
  const modal = document.getElementById('shiftEditModal');
  const modalTarget = document.getElementById('modalTarget');
  const modalCancel = document.getElementById('modalCancel');

  document.querySelectorAll('.result-table td[data-sid]').forEach(td => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', (e) => {
      if (dragSource) return;

      editingCell = td;
      const sid = td.dataset.sid;
      const d = parseInt(td.dataset.day);
      const staff = AppState.staff.find(s => s.id === sid);
      const staffName = staff ? staff.name : '';

      modalTarget.textContent = `${staffName} - ${d}日`;
      modal.classList.add('show');
      e.stopPropagation();
    });
  });

  if (modalListenersInstalled) return;
  modalListenersInstalled = true;

  document.querySelectorAll('.shift-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!editingCell) {
        console.warn('editingCell is null');
        return;
      }
      const sid = editingCell.dataset.sid;
      const d = parseInt(editingCell.dataset.day);
      const newShift = btn.dataset.shift;

      if (!AppState.shifts[sid]) AppState.shifts[sid] = {};
      AppState.shifts[sid][d] = newShift;

      modal.classList.remove('show');
      const editedLabel = `${(AppState.staff.find(s => s.id === sid) || {}).name || ''} ${d}日`;
      editingCell = null;

      refreshAfterManualEdit();

      toast(`${editedLabel} を「${newShift || '空'}」に変更しました`, 'info', 1500);
    });
  });

  modalCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    modal.classList.remove('show');
    editingCell = null;
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
      editingCell = null;
    }
  });
}

function refreshAfterManualEdit() {
  AppState.violations = checkViolations(AppState.shifts);
  renderResultTable();

  const reportCard = document.getElementById('reportCard');
  if (reportCard && reportCard.style.display !== 'none') {
    const result = {
      success: AppState.violations.length === 0,
      score: AppState.violations.length,
      violations: AppState.violations,
    };
    renderReport(result);
  }

  if (typeof saveToStorage === 'function') saveToStorage();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
