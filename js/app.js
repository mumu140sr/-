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
      const result = await runner((pct, msg) => {
        $bar.style.width = pct + '%';
        $text.textContent = msg;
      });

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      $bar.style.width = '100%';
      $text.textContent = `完了！ 最終スコア: ${result.score} (${elapsed}秒)`;

      // レポート表示
      $report.style.display = 'block';
      renderReport(result);

      // 自動でシフト表タブへ
      setTimeout(() => {
        document.querySelector('.tab[data-tab="result"]').click();
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

function renderReport(result) {
  const $c = document.getElementById('reportContent');
  if (result.success) {
    $c.innerHTML = `
      <div class="report-success">
        ✨ 全てのMUSTルールがクリアされました！<br>
        スコア: 0 / 違反: 0件
      </div>
    `;
    return;
  }

  // 違反を種別ごとに集計
  const grouped = {};
  result.violations.forEach(v => {
    if (!grouped[v.type]) grouped[v.type] = [];
    grouped[v.type].push(v);
  });

  let html = `
    <div class="report-warning">
      ⚠️ 違反件数: ${result.violations.length}件 / スコア: ${result.score}
    </div>
    <div class="violation-list">
  `;

  result.violations.forEach((v, idx) => {
    const staff = AppState.staff.find(s => s.id === v.staffId);
    const targetName = staff ? staff.name : '全体';
    const dayStr = v.day > 0 ? ` (${v.day}日)` : '';
    html += `
      <div class="violation-item">
        <span class="v-target">${escapeHtml(targetName)}${dayStr}</span>
        ${escapeHtml(v.message)}
        <span class="v-action">💡 ${escapeHtml(v.action)}</span>
      </div>
    `;
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
}

// Excel エクスポート
function exportToExcel() {
  if (!AppState.generated) {
    toast('シフトを生成してから実行してください', 'error');
    return;
  }
  const days = getDaysInMonth(AppState.settings.targetMonth);
  const data = [];

  // ヘッダー
  const header = ['名前'];
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    header.push(`${d}(${getWeekdayLabel(w)})`);
  }
  header.push('勤務日数', '休日数');
  data.push(header);

  // 各スタッフ
  AppState.staff.forEach(s => {
    const row = [s.name];
    let work = 0, off = 0;
    for (let d = 1; d <= days; d++) {
      const sh = (AppState.shifts[s.id] || {})[d] || '';
      row.push(sh);
      if (isWork(sh)) work++;
      else if (isOff(sh)) off++;
    }
    row.push(work, off);
    data.push(row);
  });

  // 集計行
  const shiftKeys = ['早責', '遅責', '早総務', '遅総務', '早', '遅', '夜勤'];
  shiftKeys.forEach(key => {
    const req = AppState.roleRequirements[key] || 0;
    if (req === 0) return;
    const row = [`${key}(${req})`];
    for (let d = 1; d <= days; d++) {
      let count = 0;
      AppState.staff.forEach(s => {
        if ((AppState.shifts[s.id] || {})[d] === key) count++;
      });
      row.push(count);
    }
    data.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(data);

  // 列幅設定
  const colWidths = [{ wch: 16 }];
  for (let d = 1; d <= days; d++) colWidths.push({ wch: 6 });
  colWidths.push({ wch: 8 }, { wch: 8 });
  ws['!cols'] = colWidths;

  // セル色を設定（シフト種別ごと）
  const colorMap = {
    '早責': 'FDE2E2', '遅責': 'D1C4E9',
    '早総務': 'FCE4B6', '遅総務': 'C8E6C9',
    '早':   'D4EAF7', '遅':   'FFE0B2',
    '休':   'EEEEEE', '公':   'F5F5F5',
    '有':   'FFF9C4', '研':   'E0F7FA',
  };
  for (let r = 1; r <= AppState.staff.length; r++) {
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

  // 集計シート
  const summary = [['スタッフ', '早責', '遅責', '早総務', '遅総務', '早', '遅', '研', '休系', '合計勤務']];
  AppState.staff.forEach(s => {
    const counts = { '早責': 0, '遅責': 0, '早総務': 0, '遅総務': 0, '早': 0, '遅': 0, '研': 0, off: 0, work: 0 };
    for (let d = 1; d <= days; d++) {
      const sh = (AppState.shifts[s.id] || {})[d] || '';
      if (counts[sh] !== undefined) { counts[sh]++; counts.work++; }
      else if (isOff(sh)) counts.off++;
    }
    summary.push([s.name, counts['早責'], counts['遅責'], counts['早総務'], counts['遅総務'], counts['早'], counts['遅'], counts['研'], counts.off, counts.work]);
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

  const header = ['名前'];
  for (let d = 1; d <= days; d++) {
    const w = getWeekday(AppState.settings.targetMonth, d);
    header.push(`${d}(${getWeekdayLabel(w)})`);
  }
  header.push('勤務', '休');
  csv += header.map(escapeCSV).join(',') + '\n';

  AppState.staff.forEach(s => {
    const row = [s.name];
    let work = 0, off = 0;
    for (let d = 1; d <= days; d++) {
      const sh = (AppState.shifts[s.id] || {})[d] || '';
      row.push(sh);
      if (isWork(sh)) work++;
      else if (isOff(sh)) off++;
    }
    row.push(work, off);
    csv += row.map(escapeCSV).join(',') + '\n';
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
