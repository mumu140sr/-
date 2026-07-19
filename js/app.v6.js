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

      let candidates = [];
      const canParallel = numCand > 1 &&
        typeof optimizeCandidatesParallel === 'function' && typeof Worker !== 'undefined';
      if (canParallel) {
        // 複数案を並列 Worker で同時生成（マルチコア活用 → 1案分の時間で全案完成）
        try {
          candidates = await optimizeCandidatesParallel(numCand, (pct, msg) => {
            $bar.style.width = pct + '%';
            $text.textContent = msg;
          });
        } catch (e) {
          console.warn('並列生成に失敗、逐次生成にフォールバック:', e);
          candidates = [];
        }
      }
      if (candidates.length === 0) {
        // フォールバック: 逐次生成
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
          // 十分良い案（違反2件以下）が出たら早期終了
          if (res.violations.length <= 2) break;
        }
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

      // 仕上げ: 違反が残っていれば自動でエラー修正まで走らせて最良の状態にする
      if (best.violations.length > 0) {
        $text.textContent = '仕上げ中（エラーを自動修正）...';
        try {
          const repairRunner = (typeof repairScheduleViaWorker === 'function')
            ? repairScheduleViaWorker : repairSchedule;
          const rep = await repairRunner((pct, msg) => {
            $bar.style.width = pct + '%';
            $text.textContent = msg;
          });
          // repair は AppState.shifts/violations を更新済み。結果に反映
          const beforeN = result.violations.length;
          result.violations = AppState.violations;
          result.score      = AppState.violations.length;
          result.success    = AppState.violations.length === 0;
          if (rep && rep.improved) {
            result.candidateSummary = (result.candidateSummary ? result.candidateSummary + '　' : '') +
              `自動修正: 違反${beforeN}→${AppState.violations.length}件`;
          }
        } catch (repErr) {
          console.error('[generate] 仕上げの自動修正に失敗（生成結果のまま続行）:', repErr);
          toast('仕上げの自動修正に失敗しました。🛠 エラーを自動修正 を手動でお試しください', 'info', 5000);
        }
      }

      // B. まだ違反が多く残る場合のみ、反復回数を自動で増やして再挑戦（最良を保持）
      // 3件以下ならフル再生成より手動修正の方が早いためスキップ（時間短縮）
      if (result.violations.length > 3) {
        let bestShifts = JSON.parse(JSON.stringify(AppState.shifts));
        let bestVios   = AppState.violations.slice();
        const origMax  = AppState.settings.maxAttempts;
        const repairRunner = (typeof repairScheduleViaWorker === 'function')
          ? repairScheduleViaWorker : repairSchedule;
        for (let retry = 1; retry <= 1 && bestVios.length > 0; retry++) {
          const boosted = Math.min(1000000, Math.floor(origMax * (1 + 0.7 * retry)));
          if (boosted <= origMax) break;
          AppState.settings.maxAttempts = boosted;
          $text.textContent = `違反${bestVios.length}件 → 別の案をもう1回生成して比較します（現在の最良${bestVios.length}件は保持中）…`;
          try {
            const keepNote = `｜現在の最良 ${bestVios.length}件は保持中（悪化しません）`;
            await runner((pct, msg) => { $bar.style.width = pct + '%'; $text.textContent = `再挑戦${retry}: ${msg}${keepNote}`; });
            if (AppState.violations.length > 0) {
              await repairRunner((pct, msg) => { $text.textContent = `再挑戦${retry} 仕上げ: ${msg}${keepNote}`; });
            }
            if (AppState.violations.length < bestVios.length) {
              bestShifts = JSON.parse(JSON.stringify(AppState.shifts));
              bestVios   = AppState.violations.slice();
            }
          } catch (_) { /* この再挑戦は失敗、最良を維持 */ }
        }
        AppState.settings.maxAttempts = origMax; // 元に戻す
        AppState.shifts     = bestShifts;         // 最良を確定
        AppState.violations = bestVios;
        result.violations   = bestVios;
        result.score        = bestVios.length;
        result.success      = bestVios.length === 0;
      }

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
 * 生成後の案内ポップアップ。
 *  - コマ不足（必要コマ合計 > 出せるコマ合計、または人員不足の違反あり）→ 不足の案内
 *  - 人員余り（「余」がある）→ 余りの案内
 * を1つのポップアップで表示する。
 */
function showSurplusPopup() {
  if (!AppState.generated) return;
  const days   = getDaysInMonth(AppState.settings.targetMonth);
  const groups = getDepartmentGroups();

  // 出せるコマ合計（各人の 月日数 − 公休 − 有給）と 必要コマ合計（定数×日）
  let availableWork = 0;
  AppState.staff.forEach(s => {
    availableWork += Math.max(0, days - (s.maxOff || 0) - (s.paidLeave || 0));
  });
  const workKeys = AppState.shiftTypes.filter(t => t.countForStaff && !t.isTraining).map(t => t.key);
  let requiredWork = 0;
  groups.forEach(g => {
    workKeys.forEach(key => {
      if (!(g.reqs[key] > 0)) return;
      for (let d = 1; d <= days; d++) requiredWork += getDayReq(g.reqs, g.dailyReqs || {}, key, d);
    });
  });
  const shortageComa = requiredWork - availableWork; // 正なら不足

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

  const allVios     = AppState.violations || [];
  const hasShortage = shortageComa > 0 || understaffVios.length > 0;
  const hasSurplus  = surplusTotal > 0;
  const hasErrors   = allVios.length > 0;
  if (!hasShortage && !hasSurplus && !hasErrors) return; // 何もなければ出さない

  // ── 今回のエラーの原因まとめ（種類ごとに件数と原因・対処を表示）──
  const CAUSE = {
    'understaff':         ['人員不足',              'その日その担当に人が足りない',           '定数を下げる／人を増やす'],
    'off-count':          ['公休不足',              'その人が働きすぎで公休が取りきれない',   '担当できる人を増やして負担を分散'],
    'consecutive':        ['連勤超過',              '休みの配置が偏って連勤が長い',           '連勤の間に休みを挟む'],
    'category-switch':    ['連勤中の時間帯切替',    '連勤の中で早番⇔遅番が混ざっている',     '連勤は同じ時間帯で揃える'],
    'bad-rest':           ['遅→休→早（リズム）',   '休みの前後で時間帯がちぐはぐ',           '休みの前後の時間帯を揃える'],
    'pair-rest':          ['個人ルール: 切替時2連休', '遅→早の間の休みが1日しかない',         '休みを2連休以上にする'],
    'weekend-pref':       ['個人希望: 土日休み',      '土日休み（絶対）の人が土日に出勤',       'その日を休みにして平日と入れ替える'],
    'rest-style':         ['個人希望: 休み方',        '連休/分散の希望（絶対）に反する配置',     '休みの位置を調整する'],
    'single-work':        ['単発出勤',              '前後が休みで1日だけ出勤',               '出勤日を連続させる'],
    'late-early':         ['遅→早',                '退勤から翌出勤までが短い',               '順序を入れ替える'],
    'long-rest':          ['4連休以上',            '連休が長すぎる（余は除く）',             '休みを分散する'],
    'hierarchy':          ['責任者の順位',          '上位者がいるのに下位者が責任者',         '責任者を入れ替える'],
    'skill-late':         ['スキル不足',            '必要スキルの人がその時間帯に足りない',   'スキル保有者を配置／スキル設定を見直す'],
    'vicemanager-absent': ['副店長・責任者の不在',  'その日カバーできていない',               '副店長かチーフ責任者を配置'],
    'resp-duplicate':     ['責任者の重複',          '同じ時間帯に責任者が過剰',               'どちらかを通常シフトに'],
    'role-mismatch':      ['担当外シフト',          '入れないシフトに配置されている',         '担当を見直す／担当を広げる'],
    'pref-mismatch':      ['早遅希望と不一致',      '早可/遅可の希望に反している',             '希望に合うよう入れ替える'],
    'event-absent':       ['行事日の欠勤',          '行事の対象者が休みになっている',         'その日を出勤に'],
  };
  const typeCount = {};
  allVios.forEach(v => { typeCount[v.type] = (typeCount[v.type] || 0) + 1; });
  const causeRows = Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1])
    .map(([type, cnt]) => {
      const c = CAUSE[type] || [type, '', ''];
      return `<tr>
        <td style="padding:3px 8px;font-weight:700;white-space:nowrap">${escapeHtml(c[0])}</td>
        <td style="padding:3px 8px;text-align:center;color:#c53030;font-weight:700">${cnt}件</td>
        <td style="padding:3px 8px;color:#4a5568">${escapeHtml(c[1])}${c[2] ? `<br><span style="color:#2b6cb0">→ ${escapeHtml(c[2])}</span>` : ''}</td>
      </tr>`;
    }).join('');
  // 根本原因（症状の裏にある本当の原因）を最優先で表示
  let rootHtml = '';
  if (hasErrors && typeof analyzeRootCauses === 'function') {
    const roots = analyzeRootCauses().slice(0, 3);
    if (roots.length) {
      rootHtml = `
        <div style="background:#fff5f5;border-left:4px solid #e53e3e;padding:10px 12px;border-radius:6px;margin-bottom:12px">
          <b>🔍 根本原因</b>
          ${roots.map((r, i) => `
            <div style="margin-top:${i ? 8 : 6}px">
              <div style="font-weight:700;color:#c53030">${i + 1}. ${escapeHtml(r.title)}</div>
              <div style="color:#4a5568;font-size:13px;margin:2px 0">${escapeHtml(r.detail)}</div>
              <div style="color:#2b6cb0;font-size:13px">→ ${escapeHtml(r.fix)}</div>
            </div>`).join('')}
        </div>`;
    }
  }

  const causeHtml = hasErrors ? `${rootHtml}
    <div style="background:#fffaf0;border-left:4px solid #ed8936;padding:10px 12px;border-radius:6px;margin-bottom:12px">
      <b>📋 今回のエラーの原因（症状の内訳・${allVios.length}件）</b>
      <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:13px;margin-top:6px;width:100%">
        <tr style="color:#718096"><td style="padding:3px 8px">種類</td><td style="padding:3px 8px;text-align:center">件数</td><td style="padding:3px 8px">原因 → 対処</td></tr>
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
          ? `<br><span style="color:#2b6cb0">→ 余っている <b>${escapeHtml(b.surplusCandidates.slice(0, 4).join('・'))}</b> に任せられると分散できます</span>`
          : '';
        return `<li>「<b>${escapeHtml(b.key)}</b>」ができるのは <b>${b.capable.length}人</b>だけ（${escapeHtml(b.capable.slice(0, 5).join('・'))}）${cand}</li>`;
      }).join('');
      bottleneckHtml = `
        <div style="background:#ebf8ff;border-left:4px solid #4299e1;padding:10px 12px;border-radius:6px;margin-top:12px">
          <b>⚖️ 根本原因：担当できる人の偏り</b>
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
      .map(v => `<li>${escapeHtml(v.message.replace(/^🚨\s*/, ''))}</li>`).join('');
    const offShort = understaffVios.filter(v => v.type === 'off-count')
      .map(v => { const s = AppState.staff.find(m => m.id === v.staffId); return s ? s.name : ''; })
      .filter(Boolean);

    title = shortageComa > 0
      ? `⚠️ コマ数が ${shortageComa}コマ 足りません`
      : `⚠️ 人手が足りない日があります`;
    body = `${causeHtml}
      <p>必要コマ合計 <b>${requiredWork}</b> に対して、出せるコマ合計は <b>${availableWork}</b> です。
      ${shortageComa > 0 ? `<b style="color:#c53030">${shortageComa}コマ不足</b>しています。` : '合計は足りていますが、特定の日・シフトで埋められていません。'}</p>
      ${shortDays ? `<div style="margin:8px 0"><b>埋まっていない主な箇所：</b><ul style="margin:4px 0;padding-left:20px;line-height:1.7">${shortDays}</ul></div>` : ''}
      ${offShort.length ? `<p>公休が足りていない人：<b>${escapeHtml(offShort.join('・'))}</b></p>` : ''}
      <div style="background:#fff5f5;border-left:4px solid #fc8181;padding:10px 12px;border-radius:6px">
        <b>不足の解消方法：</b>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
          <li><b>必要人数（定数）を減らす</b>（②シフト種別 or シフト表の集計行で日別に）</li>
          <li><b>公休数・有給数を減らす</b>（③スタッフ管理）</li>
          <li><b>スタッフを増やす</b>（③スタッフ管理）</li>
          <li>調整後 <b>「🛠 エラーを自動修正」</b>または再生成</li>
        </ol>
      </div>${bottleneckHtml}`;
  } else if (hasSurplus) {
    const list = surplusItems.sort((a, b) => b.yo - a.yo)
      .map(r => `<li><b>${escapeHtml(r.name)}</b>：余 ${r.yo}コマ</li>`).join('');
    title = `📢 人員が ${surplusTotal}コマ 余っています`;
    body = `${causeHtml}
      <p>必要人数（定数）を守った結果、下記の人が「<span style="color:#bf5b00;font-weight:700">余</span>（人員余り）」になっています。</p>
      <ul style="margin:8px 0 12px;padding-left:20px;line-height:1.8">${list}</ul>
      <div style="background:#fff8e1;border-left:4px solid #f6ad55;padding:10px 12px;border-radius:6px">
        <b>この余りの使い方：</b>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
          <li><b>忙しい日の必要人数を増やす</b>（②シフト種別 →「日別必要人数」）</li>
          <li>または <b>有給を増やす</b>（③スタッフ管理 → 有給数）</li>
          <li>入力したら <b>「🛠 エラーを自動修正」</b>を押す → 余が減ります</li>
        </ol>
      </div>${bottleneckHtml}`;
  } else {
    // 不足も余りもないが、エラー（時間帯切替・リズムなど）がある場合
    title = `⚠️ ${allVios.length}件のエラーがあります`;
    body = `${causeHtml}
      <div style="background:#fffaf0;border-left:4px solid #ed8936;padding:10px 12px;border-radius:6px">
        <b>減らし方：</b>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.8">
          <li><b>「🛠 エラーを自動修正」</b>を押す（数回押すとさらに減ります）</li>
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
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

/**
 * 🧭 修正ガイド: 残っているエラーごとに「1手で直る具体案」を提示し、
 * 「この修正を適用」ボタンで誰でも直せるようにするモーダル。
 */
function showFixGuide() {
  if (!AppState.generated) {
    toast('シフトを生成してから実行してください', 'error');
    return;
  }
  AppState.violations = checkViolations(AppState.shifts);
  const total = AppState.violations.length;

  const old = document.getElementById('fixGuideModal');
  if (old) old.remove();

  let body;
  if (total === 0) {
    body = `<p style="font-size:15px">🎉 エラーはありません。修正の必要はありません！</p>`;
  } else {
    const sugg = suggestViolationFixes(10);
    const items = sugg.map((s, i) => {
      const name = s.v.staffId
        ? ((AppState.staff.find(m => m.id === s.v.staffId) || {}).name || '')
        : '全体';
      const dayStr = s.v.day > 0 ? ` (${s.v.day}日)` : '';
      const head = `<div style="font-weight:700;margin-bottom:4px">${escapeHtml(name)}${dayStr}｜${escapeHtml(s.v.message)}</div>`;
      if (s.desc) {
        return `<div style="background:#f0fff4;border-left:4px solid #68d391;padding:10px 12px;border-radius:6px;margin-bottom:10px">
          ${head}
          <div style="color:#276749;margin-bottom:6px">✅ 直し方: <b>${escapeHtml(s.desc)}</b>
            <span style="color:#718096">（エラー ${total}→${s.after}件）</span></div>
          <button class="btn btn-primary" data-guide-apply="${i}" style="font-size:13px">この修正を適用</button>
        </div>`;
      }
      return `<div style="background:#fffaf0;border-left:4px solid #f6ad55;padding:10px 12px;border-radius:6px;margin-bottom:10px">
        ${head}
        <div style="color:#975a16">⚠ ${escapeHtml(s.reason)}</div>
      </div>`;
    }).join('');
    body = `
      <p>残りエラー <b>${total}件</b>。緑のカードは<b>ボタン1つで直せます</b>（上から順に押すのがおすすめ。適用のたびに再計算されます）。</p>
      ${items}
      ${total > 10 ? `<p class="hint">※上位10件のみ表示。適用して減らすと次が表示されます。</p>` : ''}`;
    // 適用データを保持
    showFixGuide._sugg = sugg;
  }

  const modal = document.createElement('div');
  modal.id = 'fixGuideModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:640px">
      <div class="modal-header">
        <h3 style="margin:0">🧭 修正ガイド</h3>
        <button class="modal-close" id="fixGuideClose">✕</button>
      </div>
      <div class="modal-body" style="padding:16px">${body}</div>
      <div style="padding:0 16px 16px;text-align:right">
        <button class="btn" id="fixGuideOk">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#fixGuideClose').addEventListener('click', close);
  modal.querySelector('#fixGuideOk').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  modal.querySelectorAll('button[data-guide-apply]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = (showFixGuide._sugg || [])[parseInt(btn.dataset.guideApply)];
      if (!s || !s.move) return;
      if (typeof recordShiftHistory === 'function') recordShiftHistory();
      const sh = AppState.shifts, m = s.move;
      if (m.kind === 'set') {
        sh[m.sid][m.d] = m.to;
      } else if (m.kind === 'swapDays') {
        const a = sh[m.sid][m.d1], b = sh[m.sid][m.d2];
        sh[m.sid][m.d1] = b; sh[m.sid][m.d2] = a;
      } else if (m.kind === 'swapStaff') {
        const a = sh[m.aId][m.d], b = sh[m.bId][m.d];
        sh[m.aId][m.d] = b; sh[m.bId][m.d] = a;
      } else if (m.kind === 'swapStaff2') {
        // 2日連続で絡み合った違反用: 2人のシフトを両日とも入れ替える
        [m.d1, m.d2].forEach(d => {
          const a = sh[m.aId][d], b = sh[m.bId][d];
          sh[m.aId][d] = b; sh[m.bId][d] = a;
        });
      }
      AppState.violations = checkViolations(sh);
      saveToStorage();
      renderResultTable();
      toast(`✅ 適用しました（残りエラー ${AppState.violations.length}件・Ctrl+Zで戻せます）`, 'success', 3000);
      showFixGuide(); // 再計算して次の提案を表示
    });
  });
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

  // 🧩 かんたん調整: 手動修正(🔒)は保ったまま、玉突きの崩れだけを高速で吸収
  const btnQuick = document.getElementById('btnQuickAdjust');
  if (btnQuick) {
    btnQuick.addEventListener('click', () => {
      if (!AppState.generated) {
        toast('シフトを生成してから実行してください', 'error');
        return;
      }
      const before = checkViolations(AppState.shifts).length;
      if (before === 0) {
        toast('エラーはありません 🎉', 'success');
        return;
      }
      if (typeof recordShiftHistory === 'function') recordShiftHistory();
      const backup = JSON.parse(JSON.stringify(AppState.shifts));

      btnQuick.disabled = true;
      btnQuick.textContent = '⏳ 調整中...';
      // 描画を1フレーム挟んでからサッと実行（violationPolish は焼きなましなしの高速探索）
      setTimeout(() => {
        try {
          violationPolish(AppState.shifts, 4);
          markSurplusRest(AppState.shifts); // 公休超過を余に整える
          AppState.violations = checkViolations(AppState.shifts);
          if (AppState.violations.length >= before) {
            // 改善なし → 完全に元へ戻す
            AppState.shifts = backup;
            AppState.violations = checkViolations(backup);
            if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
            toast('🧩では直せませんでした（変更なし）。編集済み🔒のマスは動かせないため、' +
                  'より強力な「🛠 エラーを自動修正」を試すか、関係する🔒を解除してください', 'info', 6000);
          } else {
            toast(`🧩 エラー ${before}件 → ${AppState.violations.length}件 に調整（Ctrl+Zで戻せます）`, 'success', 4000);
          }
          renderResultTable();
          const reportCard = document.getElementById('reportCard');
          if (reportCard && reportCard.style.display !== 'none') {
            renderReport({ success: AppState.violations.length === 0,
              score: AppState.violations.length, violations: AppState.violations });
          }
          saveToStorage();
        } catch (e) {
          console.error(e);
          AppState.shifts = backup;
          if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
          toast('調整中にエラーが発生しました: ' + e.message, 'error');
        } finally {
          btnQuick.disabled = false;
          btnQuick.textContent = '🧩 かんたん調整';
        }
      }, 50);
    });
  }

  // 🧭 修正ガイド: エラーごとに「1手で直る具体案」を提示してボタンで適用
  const btnGuide = document.getElementById('btnFixGuide');
  if (btnGuide) btnGuide.addEventListener('click', () => showFixGuide());

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
