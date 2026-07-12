/* ===========================================
   app.js - アプリのエントリーポイントとイベント結合
   =========================================== */

document.addEventListener('DOMContentLoaded', () => {
  // データ読込
  const loaded = loadFromStorage();
  if (!loaded || AppState.staff.length === 0) {
    addSampleStaff();
  }

  // UI初期化
  setupTabs();
  setupSettingsPanel();
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
    toast('前回のデータを読込みました', 'success');
  } else {
    toast('シフト自動生成アプリへようこそ！', 'success');
  }
});

// ヘッダーアクション
function setupHeaderActions() {
  document.getElementById('btnSave').addEventListener('click', () => {
    saveToStorage();
    toast('設定を保存しました', 'success');
  });

  document.getElementById('btnLoad').addEventListener('click', () => {
    if (loadFromStorage()) {
      refreshAllUI();
      toast('設定を読込みました', 'success');
    } else {
      toast('保存されたデータがありません', 'error');
    }
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    if (confirm('全てのデータをリセットしますか？（保存データも削除されます）')) {
      resetAll();
      addSampleStaff();
      refreshAllUI();
      toast('リセットしました', 'info');
    }
  });
}

// ⑤ 自動生成パネル
function setupGeneratePanel() {
  const btn = document.getElementById('btnGenerate');
  const btnCancel = document.getElementById('btnCancelGenerate');

  btn.addEventListener('click', async () => {
    if (AppState.staff.length === 0) {
      toast('スタッフを登録してください', 'error');
      return;
    }
    if (!AppState.settings.targetMonth) {
      toast('対象年月を設定してください', 'error');
      return;
    }

    const $area = document.getElementById('progressArea');
    const $bar = document.getElementById('progressBar');
    const $text = document.getElementById('progressText');
    const $report = document.getElementById('reportCard');

    btn.disabled = true;
    btn.textContent = '⏳ 最適化中...';
    if (btnCancel) btnCancel.style.display = 'inline-block';
    $area.style.display = 'block';
    $report.style.display = 'none';
    $bar.style.width = '0%';
    $text.textContent = 'バックグラウンドで初期解を生成中...';

    const startedAt = Date.now();
    try {
      // Worker 版を使う（フォールバック付き）
      const runner = (typeof optimizeScheduleViaWorker === 'function')
        ? optimizeScheduleViaWorker
        : optimizeSchedule;

      // 複数案を生成して最良案を採用
      const numCand = Math.max(1, Math.min(5,
        parseInt(document.getElementById('numCandidates')?.value) || 3));
      AppState.settings.numCandidates = numCand;

      const candidates = [];
      for (let ci = 0; ci < numCand; ci++) {
        const res = await runner((pct, msg) => {
          const mapped = Math.floor((ci * 100 + pct) / numCand);
          $bar.style.width = mapped + '%';
          $text.textContent = numCand > 1 ? `案${ci + 1}/${numCand}: ${msg}` : msg;
        });
        candidates.push({
          result:     res,
          shifts:     AppState.shifts,
          violations: AppState.violations,
        });
        // 全案違反ゼロなら早期終了
        if (res.violations.length === 0) break;
      }

      // 最良案: 違反件数 → スコア の順で比較
      let bestIdx = 0;
      candidates.forEach((c, i) => {
        const b = candidates[bestIdx];
        if (c.violations.length < b.violations.length ||
            (c.violations.length === b.violations.length && c.result.score < b.result.score)) {
          bestIdx = i;
        }
      });
      const best = candidates[bestIdx];
      AppState.shifts     = best.shifts;
      AppState.violations = best.violations;
      AppState.generated  = true;
      const result = best.result;
      result.candidateSummary = candidates.length > 1
        ? candidates.map((c, i) =>
            `案${i + 1}: 違反${c.violations.length}件 / スコア${c.result.score}${i === bestIdx ? ' ←採用' : ''}`).join('　')
        : null;

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      $bar.style.width = '100%';
      $text.textContent = `完了！ 最終スコア: ${result.score} (${elapsed}秒)`;

      // 生成直後の状態を履歴の出発点にする（以後の手動編集を Ctrl+Z で戻せる）
      if (typeof resetShiftHistory === 'function') resetShiftHistory();

      // レポート表示
      $report.style.display = 'block';
      renderReport(result);

      // 自動でシフト表タブへ → 余剰があればポップアップ案内
      setTimeout(() => {
        document.querySelector('.tab[data-tab="result"]').click();
        if (typeof showSurplusPopup === 'function') showSurplusPopup();
      }, 800);

      if (result.success) {
        toast('🎉 シフト生成完了！全ルールクリア！', 'success', 5000);
      } else {
        toast(`シフト生成完了（${result.violations.length}件の違反あり）`, 'info', 5000);
      }
      saveToStorage();
    } catch (e) {
      console.error(e);
      if (e && /terminated|cancel/i.test(e.message || '')) {
        toast('最適化を中止しました', 'info');
        $text.textContent = '中止しました';
      } else {
        toast('エラーが発生しました: ' + e.message, 'error');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 シフト自動生成を実行';
      if (btnCancel) btnCancel.style.display = 'none';
    }
  });

  // キャンセルボタン
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (typeof cancelActiveOptimization === 'function' && cancelActiveOptimization()) {
        toast('中止リクエストを送りました', 'info');
        btnCancel.style.display = 'none';
        btn.disabled = false;
        btn.textContent = '🚀 シフト自動生成を実行';
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
 * 生成後、人員が余っている（「余」がある）場合にシフト表で目立つ案内を出す。
 * 定数を守った結果あぶれた人を「余」で可視化し、次のアクションを促す。
 */
function showSurplusPopup() {
  if (!AppState.generated) return;
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const items = [];
  let total = 0;
  AppState.staff.forEach(s => {
    let yo = 0;
    for (let d = 1; d <= days; d++) {
      if ((AppState.shifts[s.id] || {})[d] === '余') yo++;
    }
    if (yo > 0) { items.push({ name: s.name, yo }); total += yo; }
  });
  if (total === 0) return; // 余りなし → 出さない

  const old = document.getElementById('surplusPopup');
  if (old) old.remove();

  const list = items.sort((a, b) => b.yo - a.yo)
    .map(r => `<li><b>${escapeHtml(r.name)}</b>：余 ${r.yo}コマ</li>`).join('');

  const modal = document.createElement('div');
  modal.id = 'surplusPopup';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:560px">
      <div class="modal-header">
        <h3 style="margin:0">📢 人員が ${total}コマ 余っています</h3>
        <button class="modal-close" id="surplusClose">✕</button>
      </div>
      <div class="modal-body" style="padding:16px">
        <p>必要人数（定数）を守った結果、下記の人が「<span style="color:#bf5b00;font-weight:700">余</span>（人員余り）」になっています。</p>
        <ul style="margin:8px 0 12px;padding-left:20px;line-height:1.8">${list}</ul>
        <div style="background:#fff8e1;border-left:4px solid #f6ad55;padding:10px 12px;border-radius:6px">
          <b>この余りの使い方：</b>
          <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
            <li><b>忙しい日の必要人数を増やす</b>（②シフト種別 →「日別必要人数」）</li>
            <li>または <b>有給を増やす</b>（③スタッフ管理 → 有給数）</li>
            <li>入力したら <b>「🛠 エラーを自動修正」</b>を押す → 余が減ります</li>
          </ol>
        </div>
      </div>
      <div style="padding:0 16px 16px;text-align:right">
        <button class="btn btn-primary" id="surplusOk">わかった</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#surplusClose').addEventListener('click', close);
  modal.querySelector('#surplusOk').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

function renderReport(result) {
  const $c = document.getElementById('reportContent');

  // ── AI 診断セクション ──────────────────────────────────────
  const diagItems = (typeof runAIDiagnosis === 'function') ? runAIDiagnosis() : [];
  const diagColors = {
    error:   { bg: '#fff5f5', border: '#fc8181', title: '#742a2a', body: '#9b2335' },
    warning: { bg: '#fffaf0', border: '#f6ad55', title: '#744210', body: '#975a16' },
    info:    { bg: '#ebf8ff', border: '#63b3ed', title: '#2a4365', body: '#2c5282' },
    ok:      { bg: '#f0fff4', border: '#68d391', title: '#22543d', body: '#276749' },
  };
  const diagIcons = { error: '🚨', warning: '⚠️', info: 'ℹ️', ok: '✅' };

  let diagHtml = '';
  if (result.candidateSummary) {
    diagHtml += `<div class="diag-item" style="background:#ebf8ff;border-left:4px solid #63b3ed;margin-bottom:8px">
      <div class="diag-title" style="color:#2a4365">🔀 複数案の比較</div>
      <div class="diag-detail" style="color:#2c5282">${escapeHtml(result.candidateSummary)}</div>
    </div>`;
  }
  diagHtml += '<div class="diag-section">';
  diagItems.forEach(d => {
    const c = diagColors[d.level] || diagColors.info;
    const detailLines = escapeHtml(d.detail).replace(/\n/g, '<br>');
    diagHtml += `
      <div class="diag-item" style="background:${c.bg};border-left:4px solid ${c.border}">
        <div class="diag-title" style="color:${c.title}">${diagIcons[d.level]} ${escapeHtml(d.title)}</div>
        <div class="diag-detail" style="color:${c.body}">${detailLines}</div>
        ${d.suggestion ? `<div class="diag-suggestion">💡 ${escapeHtml(d.suggestion)}</div>` : ''}
      </div>`;
  });
  diagHtml += '</div>';

  // ── 違反なし ────────────────────────────────────────────────
  if (result.success) {
    $c.innerHTML = diagHtml + `
      <div class="report-success">✨ 全てのMUSTルールがクリアされました！ スコア: 0 / 違反: 0件</div>`;
    return;
  }

  // ── 違反リスト ───────────────────────────────────────────────
  let html = diagHtml + `
    <div class="report-warning">
      ⚠️ 違反件数: ${result.violations.length}件 / スコア: ${result.score}
    </div>
    <div class="violation-list">
  `;
  result.violations.forEach(v => {
    const s          = AppState.staff.find(m => m.id === v.staffId);
    const targetName = s ? s.name : '全体';
    const dayStr     = v.day > 0 ? ` (${v.day}日)` : '';
    html += `
      <div class="violation-item">
        <span class="v-target">${escapeHtml(targetName)}${dayStr}</span>
        ${escapeHtml(v.message)}
        <span class="v-action">💡 ${escapeHtml(v.action)}</span>
      </div>`;
  });
  html += '</div>';
  $c.innerHTML = html;
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

  document.getElementById('btnClearFixed').addEventListener('click', () => {
    let count = 0;
    for (const sid in AppState.fixedShifts) {
      count += Object.keys(AppState.fixedShifts[sid] || {}).length;
    }
    if (count === 0) {
      toast('固定されているシフトはありません', 'info');
      return;
    }
    if (!confirm(`固定（🔒）されている ${count}件 のシフトをすべて解除しますか？\n※シフトの内容はそのまま残り、再生成で動かせるようになります。`)) return;
    AppState.fixedShifts = {};
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
        toast('エラーはありません 🎉', 'success');
        return;
      }

      // 修復前の状態を履歴に積む → 気に入らなければ Ctrl+Z で戻せる
      if (typeof recordShiftHistory === 'function') recordShiftHistory();

      // シフト表タブ内の進捗バーを使う（⑤自動生成のバーは別タブで見えないため）
      const $area = document.getElementById('repairProgress');
      const $bar  = document.getElementById('repairBar');
      const $text = document.getElementById('repairText');
      const orig  = btnRepair.textContent;
      btnRepair.disabled = true;
      btnRepair.textContent = '⏳ 修復中...';
      if ($area) $area.style.display = 'block';
      if ($bar)  $bar.style.width = '0%';
      if ($text) $text.textContent = 'エラー箇所を修復中...';

      try {
        const runner = (typeof repairScheduleViaWorker === 'function')
          ? repairScheduleViaWorker : repairSchedule;
        const res = await runner((pct, msg) => {
          if ($bar)  $bar.style.width = pct + '%';
          if ($text) $text.textContent = msg;
        });

        if ($bar) $bar.style.width = '100%';
        renderResultTable();
        document.getElementById('reportCard').style.display = 'block';
        renderReport({ success: res.success, score: res.violations.length, violations: res.violations });

        if (res.improved) {
          if ($text) $text.textContent = `修復完了: 違反 ${res.before}件 → ${res.after}件`;
          toast(`✅ エラーを ${res.before - res.after}件 減らしました（${res.before}→${res.after}件）`, 'success', 5000);
        } else {
          // 悪化させないので元のまま。積んだ履歴は無駄なので捨てる
          if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
          if ($text) $text.textContent = `自動では改善できませんでした（違反 ${res.before}件）`;
          toast('自動では改善できませんでした。残りは手動修正が必要です', 'info', 5000);
        }
        saveToStorage();
      } catch (e) {
        console.error(e);
        if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
        toast('修復中にエラーが発生しました: ' + e.message, 'error');
      } finally {
        btnRepair.disabled = false;
        btnRepair.textContent = orig;
        // 数秒後に進捗表示を隠す（結果は表とレポートに残る）
        setTimeout(() => { if ($area) $area.style.display = 'none'; }, 4000);
      }
    });
  }

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
        row.push(sh);
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
      const row = [`${key}(${req})`];
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
  for (let d = 1; d <= days; d++) colWidths.push({ wch: 6 });
  colWidths.push({ wch: 6 }, { wch: 7 }, { wch: 6 }, { wch: 9 }, { wch: 5 }, { wch: 11 });
  ws['!cols'] = colWidths;

  // セル色を設定（動的 shiftTypes + 固定 off 系）
  const colorMap = {};
  AppState.shiftTypes.forEach(t => {
    // Excelの色形式: RRGGBB (# を除く6桁)
    colorMap[t.key] = t.color.replace('#', '').toUpperCase().padStart(6, '0');
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
      if (cell && colorMap[cell.v]) {
        cell.s = { fill: { patternType: 'solid', fgColor: { rgb: colorMap[cell.v] } } };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'シフト表');

  // 集計シート（動的・部門順）
  const summaryHeader = ['部門', 'スタッフ', ...AppState.shiftTypes.map(t => t.key), '公休', '有給他', '余剰', '出勤日数', '差', '総労働時間'];
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
        row.push(sh);
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
