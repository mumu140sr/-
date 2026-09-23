/* ===========================================
   ai-explain.js
   違反一覧を自然言語で解説するロジック
   - グループ化 → 原因分析 → 解決提案
   - 完全クライアントサイド（外部API不要）
   =========================================== */

/**
 * 違反からAI風の解説テキストを生成
 * @returns {{ summary:string, sections:Array<{title,body,severity}>, suggestions:string[] }}
 */
function buildAIExplanation() {
  const violations = AppState.violations || [];
  const staff = AppState.staff || [];
  const staffName = (id) => {
    const s = staff.find(x => x.id === id);
    return s ? s.name : '不明';
  };

  // 違反タイプ別にグルーピング
  const byType = {};
  violations.forEach(v => {
    const k = v.type || 'other';
    (byType[k] = byType[k] || []).push(v);
  });

  // 全体サマリー
  const total = violations.length;
  const critical = violations.filter(v => /🚨/.test(v.message || '')).length;
  const warning = violations.filter(v => /⚠️/.test(v.message || '')).length;
  const info = violations.filter(v => /ℹ️/.test(v.message || '')).length;

  let summary;
  if (total === 0) {
    summary = '🎉 違反は0件です。すべてのルールをクリアした完璧なシフトが生成されました！';
  } else if (critical === 0 && warning === 0) {
    summary = `情報レベルの注意点が${info}件ありますが、致命的な問題はありません。実運用上は問題なく使えるシフトです。`;
  } else if (critical === 0) {
    summary = `致命的な違反はなく、軽微な警告が${warning}件、情報が${info}件です。微調整すれば完璧になります。`;
  } else {
    summary = `致命的な違反が${critical}件、警告が${warning}件あります。優先度の高いものから手動編集で修正することをお勧めします。`;
  }

  const sections = [];

  // === 1. 必要人数不足 ===
  if (byType['understaff']) {
    const items = byType['understaff'];
    const days = items.map(v => v.day);
    const uniqueDays = [...new Set(days)].sort((a,b) => a-b);
    // どのシフト種別が足りないか
    const shiftCounts = {};
    items.forEach(v => {
      const m = (v.message || '').match(/(早責|遅責|早総務|遅総務|早|遅|研)/);
      if (m) shiftCounts[m[1]] = (shiftCounts[m[1]] || 0) + 1;
    });
    const shiftBreakdown = Object.entries(shiftCounts)
      .sort((a,b) => b[1] - a[1])
      .map(([k,v]) => `${k}が${v}日`).join('、');

    let body = `${items.length}日で必要人数が足りていません（${shiftBreakdown}）。`;
    body += `\n対象日: ${uniqueDays.join('日, ')}日`;
    body += `\n\n【原因として考えられること】`;
    body += `\n• そのシフトに入れるスタッフが、その日に他の役割や休みで埋まっている`;
    body += `\n• 公休数（maxOff）が多すぎて、勤務できるスタッフが足りない`;
    body += `\n• 早遅希望の偏りで、特定の時間帯にスタッフが集中している`;
    body += `\n• 責任者・総務をできるスタッフが少ない（副店長・チーフ・該当役割の人数）`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ 各スタッフの「公休数」を見直す（多すぎる人がいないか）`;
    body += `\n✅ 役職マスタで該当シフトの「必要人数」を実情に合わせる`;
    body += `\n✅ 同じ日に休みが集中していないか希望休カレンダーを確認`;
    body += `\n✅ 該当日のシフト表を見て、勤務可能なスタッフを手動で割り当てる`;
    sections.push({ title: '🚨 必要人数の不足', body, severity: 'critical' });
  }

  // === 2. 連勤超過 ===
  if (byType['consecutive']) {
    const items = byType['consecutive'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(v.day);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join('日, ')}日）`).join('\n• ');
    const max = AppState.settings.maxConsecutive;

    let body = `連勤上限（${max}連勤）を超えているスタッフが${Object.keys(byStaff).length}名います。`;
    body += `\n• ${detail}`;
    body += `\n\n【原因として考えられること】`;
    body += `\n• 公休の配置が偏っていて、長期間休みなしになっている`;
    body += `\n• 前月末「連勤数」「最終シフト」の設定が現実と合っていない`;
    body += `\n• 月をまたぐ連勤が考慮されていない`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ 連勤超過のスタッフの公休を、連勤を分断する位置に手動で移動`;
    body += `\n✅ スタッフ管理タブで「前月末連勤数」を正しく入力`;
    body += `\n✅ 全体設定の「連勤上限」を実情に合わせる（4日→5日など）`;
    sections.push({ title: '🚨 連勤上限の超過', body, severity: 'critical' });
  }

  // === 3. 遅→早禁止 / 遅→研 ===
  if (byType['late-early']) {
    const items = byType['late-early'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(`${v.day}日(${v.message.includes('研') ? '→研' : '→早'})`);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join(', ')}）`).join('\n• ');

    let body = `遅番の翌日に早番(または研修)が入っているスタッフが${Object.keys(byStaff).length}名います。`;
    body += `\nこれは退勤から出勤までのインターバル不足になり、健康・労務面で問題があります。`;
    body += `\n• ${detail}`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ 該当スタッフの翌日のシフトを別の遅番系に変更する`;
    body += `\n✅ または遅番を別の日に動かす`;
    body += `\n✅ 月初の場合は前月末のシフトを「遅」に正しく設定`;
    sections.push({ title: '🚨 遅→早(研)のインターバル不足', body, severity: 'critical' });
  }

  // === 4. 役割タイプ違反 ===
  if (byType['role-mismatch']) {
    const items = byType['role-mismatch'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(`${v.day}日`);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join(', ')}）`).join('\n• ');

    let body = `本来入れないシフトに割り当てられているスタッフがいます。`;
    body += `\n• ${detail}`;
    body += `\n\n【原因として考えられること】`;
    body += `\n• 必要人数を満たすためにやむを得ず代替シフトに入った`;
    body += `\n• 役割タイプの設定ミス`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ スタッフ管理で役割タイプを確認`;
    body += `\n✅ 該当スタッフを別のシフトと交換`;
    sections.push({ title: '🚨 役割タイプの不一致', body, severity: 'critical' });
  }

  // === 5. 連勤中の時間帯切替 ===
  if (byType['category-switch']) {
    const items = byType['category-switch'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(`${v.day}日`);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join(', ')}）`).join('\n• ');

    let body = `連勤中に早番⇔遅番の切り替えが発生しています。`;
    body += `\n体内リズムや業務の連続性の観点で望ましくありません。`;
    body += `\n• ${detail}`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ 連勤中は同じ時間帯（早系または遅系）で揃える`;
    body += `\n✅ 切替前後の日を別のスタッフと交換`;
    sections.push({ title: '⚠️ 連勤内の時間帯切替', body, severity: 'warning' });
  }

  // === 6. 単発休（遅→休→早） ===
  if (byType['bad-rest']) {
    const items = byType['bad-rest'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(`${v.day}日`);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join(', ')}）`).join('\n• ');

    let body = `単発の休み（1日だけ休んで翌日また勤務）でリズムが悪い箇所があります。`;
    body += `\n特に「遅→休→早」は実質的に休んだ気がしない悪パターンです。`;
    body += `\n• ${detail}`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ 休みを連休にまとめる（前後の勤務日と交換）`;
    body += `\n✅ 休みの前後で時間帯を揃える`;
    sections.push({ title: '⚠️ 単発休でリズム悪', body, severity: 'warning' });
  }

  // === 7. 早遅希望違反 ===
  if (byType['pref-mismatch']) {
    const items = byType['pref-mismatch'];
    const byStaff = {};
    items.forEach(v => {
      const name = staffName(v.staffId);
      (byStaff[name] = byStaff[name] || []).push(`${v.day}日`);
    });
    const detail = Object.entries(byStaff)
      .map(([name, days]) => `${name}（${days.join(', ')}）`).join('\n• ');

    let body = `スタッフの早遅希望（「早可」「遅可」）に反する割当があります。`;
    body += `\n• ${detail}`;
    body += `\n\n【解決のヒント】`;
    body += `\n✅ スタッフ管理で希望の見直し（本当に不可なのか）`;
    body += `\n✅ 別のスタッフと該当日を交換`;
    sections.push({ title: '⚠️ 早遅希望と不一致', body, severity: 'warning' });
  }

  // === 8. 公休数不足/超過 ===
  const offCountIssues = (byType['off-count'] || []).concat(byType['off-count-over'] || []);
  if (offCountIssues.length > 0) {
    const shortage = byType['off-count'] || [];
    const over = byType['off-count-over'] || [];

    let body = '';
    if (shortage.length > 0) {
      const detail = shortage.map(v => {
        const m = (v.message || '').match(/休日数 (\d+)日.*目標(\d+)日.*差(-?\d+)/);
        return `${staffName(v.staffId)}: ${m ? `${m[1]}日（目標${m[2]}日、不足${Math.abs(m[3])}日）` : v.message}`;
      }).join('\n• ');
      body += `【公休不足】${shortage.length}名\n• ${detail}\n\n`;
    }
    if (over.length > 0) {
      const detail = over.map(v => {
        const m = (v.message || '').match(/休日数 (\d+)日.*目標(\d+)日.*差\+(\d+)/);
        return `${staffName(v.staffId)}: ${m ? `${m[1]}日（目標${m[2]}日、余剰${m[3]}日）` : v.message}`;
      }).join('\n• ');
      body += `【公休余剰】${over.length}名（人員余剰のため自然と休みが増えています）\n• ${detail}\n\n`;
    }
    body += `【解決のヒント】`;
    body += `\n✅ 公休不足: そのスタッフの勤務日を別の日と交換して休みを作る`;
    body += `\n✅ 公休余剰: 必要人数を増やすか、スタッフ人数を減らすかを検討`;
    sections.push({
      title: shortage.length > 0 ? '🚨 公休数の問題' : 'ℹ️ 公休数の余剰',
      body,
      severity: shortage.length > 0 ? 'critical' : 'info',
    });
  }

  // === 全体的な改善提案 ===
  const suggestions = [];
  if (critical > 0) {
    suggestions.push('🥇 まず「🚨」の付いた違反から1つずつ修正しましょう。シフト表でセルをドラッグ&ドロップまたはクリックで編集できます。');
  }
  if (byType['understaff']) {
    suggestions.push('💡 必要人数不足が多い場合、役職マスタで「必要人数」を実情に合わせて減らすか、スタッフを増員してください。');
  }
  if (byType['consecutive']) {
    suggestions.push('💡 連勤超過が多い場合、「公休数」をスタッフごとに増やすか、「連勤上限」を緩める検討を。');
  }
  if (byType['off-count']) {
    suggestions.push('💡 公休不足が出るのは、必要人数の合計に対してスタッフ数が足りていない兆候です。');
  }
  if (total === 0) {
    suggestions.push('✨ 完璧な状態です！必要であれば、シフト表で更に細かい調整（特定の人を特定の日に配置するなど）を行ってください。');
  }
  if (critical === 0 && warning > 0) {
    suggestions.push('⚙️ 設定タブで「単発休みにペナルティ」をON/OFFしたり、各スタッフの「早遅バランス」を見直すと警告が減らせます。');
  }

  return { summary, sections, suggestions, total, critical, warning, info };
}

/**
 * AI解説モーダルを表示
 */
function showAIExplanationModal() {
  // 既存モーダルがあれば消す
  const old = document.getElementById('aiExplainModal');
  if (old) old.remove();

  const expl = buildAIExplanation();

  const modal = document.createElement('div');
  modal.id = 'aiExplainModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:760px;max-height:85vh;overflow-y:auto">
      <div class="modal-header">
        <h3 style="margin:0">🤖 AI診断：シフトの違反解説</h3>
        <button class="modal-close" id="aiExplainClose">✕</button>
      </div>
      <div class="modal-body" style="padding:16px">
        <div class="ai-summary">
          <div class="ai-stats">
            <span class="ai-stat ai-stat-critical">🚨 致命的 ${expl.critical}件</span>
            <span class="ai-stat ai-stat-warning">⚠️ 警告 ${expl.warning}件</span>
            <span class="ai-stat ai-stat-info">ℹ️ 情報 ${expl.info}件</span>
          </div>
          <p class="ai-summary-text">${escapeHTML(expl.summary)}</p>
        </div>

        ${expl.sections.length === 0 ? '' : '<h4 style="margin-top:20px">📋 詳細分析</h4>'}
        ${expl.sections.map(sec => `
          <div class="ai-section ai-section-${sec.severity}">
            <div class="ai-section-title">${escapeHTML(sec.title)}</div>
            <div class="ai-section-body">${escapeHTML(sec.body).replace(/\n/g, '<br>')}</div>
          </div>
        `).join('')}

        ${expl.suggestions.length === 0 ? '' : `
          <h4 style="margin-top:20px">💡 全体的なアドバイス</h4>
          <ul class="ai-suggestions">
            ${expl.suggestions.map(s => `<li>${escapeHTML(s)}</li>`).join('')}
          </ul>
        `}

        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;text-align:right">
          <button class="btn btn-primary" id="aiExplainOk">わかった</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#aiExplainClose').addEventListener('click', close);
  modal.querySelector('#aiExplainOk').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

// HTMLエスケープ
function escapeHTML(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
