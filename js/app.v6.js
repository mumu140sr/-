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
    if (btnTheme) btnTheme.textContent = (t === 'dark') ? '☀️' : '🌙';
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

// 実現性チェック（生成前）: 各エラーが「避けられる/避けられない」かを判定して表示
function showFeasibilityModal() {
  if (!AppState.staff.length || !AppState.settings.targetMonth) {
    toast('スタッフと対象年月を設定してください', 'error');
    return;
  }
  const items = (typeof runAIDiagnosis === 'function') ? runAIDiagnosis() : [];
  // 「エラー0件が数学的に可能か」の判定を最上部に出す（配置では消せない原因の特定）
  const lb = (typeof analyzeLowerBound === 'function') ? analyzeLowerBound() : null;
  const colors = {
    error:   { bg: '#fff5f5', border: '#fc8181', title: '#742a2a', body: '#9b2335' },
    warning: { bg: '#fffaf0', border: '#f6ad55', title: '#744210', body: '#975a16' },
    info:    { bg: '#ebf8ff', border: '#63b3ed', title: '#2a4365', body: '#2c5282' },
    ok:      { bg: '#f0fff4', border: '#68d391', title: '#22543d', body: '#276749' },
  };
  const body = items.map(d => {
    const c = colors[d.level] || colors.info;
    const detail = escapeHtml(d.detail || '').replace(/\n/g, '<br>');
    return `<div style="background:${c.bg};border-left:4px solid ${c.border};padding:10px 12px;margin:8px 0;border-radius:6px">
      <div style="font-weight:600;color:${c.title};margin-bottom:4px">${escapeHtml(d.title)}</div>
      <div style="color:${c.body};font-size:13px;line-height:1.6">${detail}</div>
      ${d.suggestion ? `<div style="margin-top:6px;color:#2c5282;font-size:13px">💡 ${escapeHtml(d.suggestion)}</div>` : ''}
    </div>`;
  }).join('') || '<p>データが不足しています。</p>';

  // 判定の見出し（可能／不可能）と、不可能な場合の具体的な原因
  let verdict = '';
  if (lb) {
    if (lb.possible) {
      verdict = `<div style="padding:14px 16px;border-radius:10px;margin:0 0 14px;
          background:color-mix(in srgb, var(--success) 14%, var(--surface));
          border:1px solid color-mix(in srgb, var(--success) 38%, transparent);line-height:1.8">
        <b style="font-size:15px">✅ 人員の面では足りています</b><br>
        <span style="font-size:13px">日ごとの人数・役割・スキル・副店長・連勤上限・月全体の人日、いずれにも
        「配置では消せない不足」はありません。<br>
        <b>ただし、これは人員の話だけです。</b>並び方のルール（単発出勤・遅→早・時間帯の切替・連休の長さ・
        早遅バランスなど）はここでは判定していないため、<b>これらのエラーは出ることがあります</b>。<br>
        並び方のエラーは配置で消せるものが多いので、<b>🎯じっくり生成</b>で時間をかけると減ります。
        それでも残る場合は <b>🩹 エラー解消プラン</b> で該当ルールを緩めてください。</span>
      </div>`;
    } else {
      const lines = lb.reasons.slice(0, 12).map(r => `・${escapeHtml(r.text)}`).join('<br>');
      const more = lb.reasons.length > 12 ? `<br>…ほか ${lb.reasons.length - 12}件` : '';
      verdict = `<div style="padding:14px 16px;border-radius:10px;margin:0 0 14px;
          background:color-mix(in srgb, var(--danger) 12%, var(--surface));
          border:1px solid color-mix(in srgb, var(--danger) 38%, transparent);line-height:1.8">
        <b style="font-size:15px">🚨 人員が足りていません（配置では消せません）</b><br>
        <span style="font-size:13px">配置をどう変えても、最低 <b>${lb.minErrors}件</b> のエラーが残ります。原因は次のとおりです。
        （これに加えて、並び方のルールによるエラーが出ることもあります）</span>
        <div style="font-size:13px;margin-top:8px">${lines}${more}</div>
        <div style="font-size:13px;margin-top:8px">💡 <b>🩹 エラー解消プラン</b>で、どの設定をいくつ動かせば解消するか確認できます。</div>
      </div>`;
    }
  }

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
  modal.innerHTML = `<div style="background:var(--surface);color:var(--text);border-radius:12px;max-width:720px;width:100%;max-height:85vh;overflow:auto;padding:20px">
    <h3 style="margin:0 0 4px">🔍 実現性チェック（生成する前の判定）</h3>
    <p class="hint" style="margin:0 0 12px">
      まず「<b>人員が足りているか</b>」を判定します。足りない場合は、どの日の何が原因かまで特定します。<br>
      <b>並び方のルール（単発出勤・遅→早・連休など）はここでは判定していません。</b>人員が足りていても、
      これらのエラーは出ることがあります。その下は参考情報です。
    </p>
    ${verdict}
    ${body}
    <div style="text-align:right;margin-top:12px"><button id="feasClose" class="btn btn-primary">閉じる</button></div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#feasClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

/**
 * 生成結果が「数学的に最良と証明できた」のか「時間切れで打ち切った」のかを表示する。
 * 打ち切りだった場合は、時間を延ばして再計算するボタンを出す（＝まだ減る可能性がある）。
 */
function showOptimalityNotice(cutOff, vioCount, elapsed, wasDeep, usedGap, wasFast) {
  const $report = document.getElementById('reportCard');
  if (!$report) return;
  const old = document.getElementById('optimalityNotice');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'optimalityNotice';
  box.style.cssText = 'padding:12px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;line-height:1.7';

  if (wasFast) {
    // 速い生成: 証明していないので「最良とは限らない」と正直に出し、証明ありへの導線を置く
    box.style.background = 'color-mix(in srgb, var(--accent) 12%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--accent) 32%, transparent)';
    box.innerHTML = `⚡ <b>速い生成（証明なし）で完了しました（${elapsed}秒）</b>：` +
      (vioCount === 0
        ? 'エラー0件です。<b>0件なのでこれ以上良くなりようがありません</b>。このまま使えます。'
        : `エラー ${vioCount}件。<b>これが最良とは限りません</b>（60秒で打ち切ったため、証明していません）。<br>
           じっくり生成にすると<b>さらに減ることがあります</b>。人手がぎりぎりの月ほど差が大きくなる傾向があります。
           最終確定の前に、一度は下のボタンで解き直すことをおすすめします。`) +
      (vioCount > 0
        ? '<br><button id="btnProofOptimize" class="btn btn-primary" style="margin-top:8px">🎯 じっくり生成で解き直す（証明あり・最大10分）</button>'
        : '');
  } else if (!cutOff) {
    box.style.background = 'color-mix(in srgb, var(--success) 14%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--success) 35%, transparent)';
    box.innerHTML = vioCount === 0
      ? `✅ <b>計算完了（${elapsed}秒）</b>：エラー0件。数学的にこれが最良と確認できました。`
      : `✅ <b>計算完了（${elapsed}秒）</b>：残った ${vioCount}件は、<b>今の設定では避けられません</b>（これ以上良い組み合わせが存在しないことを確認済み）。<br>
         減らすには、必要人数・公休数・担当シフト・希望休などの設定を見直してください。`;
  } else {
    box.style.background = 'color-mix(in srgb, var(--warning) 16%, var(--surface))';
    box.style.border = '1px solid color-mix(in srgb, var(--warning) 40%, transparent)';
    // じっくりモードで改善余地があるのは「早期停止(gap許容)を使った＝21人以上の部門」のときだけ。
    // 20人以下は既に上限10分・gap=0で解いているため、再計算しても結果は変わらない。
    const canRetry = !wasDeep && usedGap;
    box.innerHTML = `⏱ <b>時間切れで打ち切りました（${elapsed}秒）</b>：残り ${vioCount}件は
      <b>「避けられない」とは限りません</b>。計算時間（1部門あたり最大10分）が足りず、
      途中までの best 解を表示しています。<br>
      ${canRetry
        ? '<button id="btnDeepOptimize" class="btn btn-primary" style="margin-top:8px">⏳ 妥協なしで再計算（早期停止を無効・最大10分）</button>'
        : '上限いっぱいまで計算しても解ききれませんでした。⑤自動生成の「🔍 実現性チェック」で人手の不足を確認し、有給日数・日別必要人数・公休数のいずれかを緩めてください。'}`;
  }
  // エラーが残ったときは、その場から「どう緩めれば消えるか」へ行けるようにする
  if (vioCount > 0) {
    const go = document.createElement('button');
    go.className = 'btn';
    go.style.cssText = 'margin-top:8px;margin-left:8px;background:#dd6b20;color:#fff';
    go.textContent = '🩹 エラー解消プランを見る';
    go.addEventListener('click', () => { if (typeof showRelaxModal === 'function') showRelaxModal(); });
    box.appendChild(document.createElement('br'));
    box.appendChild(go);
  }
  $report.insertBefore(box, $report.firstChild);
  const bp = document.getElementById('btnProofOptimize');
  if (bp) bp.addEventListener('click', () => {
    if (typeof window._runGenerate === 'function') {
      toast('じっくり生成で解き直します（1部門あたり最大10分）', 'info', 4000);
      window._runGenerate({});
    }
  });
  const bd = document.getElementById('btnDeepOptimize');
  if (bd) bd.addEventListener('click', () => {
    if (typeof window._runGenerate === 'function') {
      toast('妥協なしモードで再計算します（1部門あたり最大10分）', 'info', 4000);
      window._runGenerate({ deepMode: true });
    }
  });
}

// ⑤ 自動生成パネル
function setupGeneratePanel() {
  const btn = document.getElementById('btnGenerate');          // 🎯 じっくり生成（証明あり）
  const btnFast = document.getElementById('btnGenerateFast');  // ⚡ 速い生成（証明なし）
  const BTN_LABEL = { proof: '🎯 じっくり生成（証明あり・最大10分）', fast: '⚡ 速い生成（証明なし・最大60秒）' };
  const setBusy = (busy) => {
    [btn, btnFast].forEach(b => { if (b) b.disabled = busy; });
    if (busy) { if (btn) btn.textContent = '⏳ 計算中...'; if (btnFast) btnFast.textContent = '⏳ 計算中...'; }
    else { if (btn) btn.textContent = BTN_LABEL.proof; if (btnFast) btnFast.textContent = BTN_LABEL.fast; }
  };
  const btnCancel = document.getElementById('btnCancelGenerate');
  const btnFeas = document.getElementById('btnFeasibility');
  if (btnFeas) btnFeas.addEventListener('click', showFeasibilityModal);
  const btnRelax = document.getElementById('btnRelax');
  if (btnRelax) btnRelax.addEventListener('click', showRelaxModal);

  // opts.deepMode = true でじっくり最適化（時間上限を大幅に延長）
  const runGenerate = async (opts) => {
    opts = opts || {};
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

    setBusy(true);
    if (btnCancel) btnCancel.style.display = 'inline-block';
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
      const prog = (pct, msg) => { $bar.style.width = pct + '%'; $text.textContent = '数理最適化: ' + msg; };
      const res = await optimizeScheduleMILP(prog, { deepMode: !!opts.deepMode, fastMode: !!opts.fastMode });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      $bar.style.width = '100%';
      const cutOff = (res.allOptimal === false);   // 時間切れで打ち切られた＝最良解とは限らない
      $text.textContent = `完了！ 違反 ${res.violations.length}件（${elapsed}秒）` +
                          (opts.fastMode ? '｜⚡ 速い生成（証明なし）'
                                         : cutOff ? '｜⏱ 時間切れで打ち切り（まだ改善余地あり）'
                                                  : '｜✅ これ以上良い組み合わせは無いと確認済み');
      if (typeof resetShiftHistory === 'function') resetShiftHistory();
      $report.style.display = 'block';
      try {
        renderReport({ success: res.success, score: res.score, violations: res.violations,
          candidateSummary: `数理最適化で生成 — 違反${res.violations.length}件（${elapsed}秒）` });
      } catch (rErr) { console.error('[generate] レポート表示でエラー（表は表示します）:', rErr); }
      showOptimalityNotice(cutOff, res.violations.length, elapsed, !!opts.deepMode, res.usedGap === true, !!opts.fastMode);
      renderResultTable();
      setTimeout(() => {
        const rt = document.querySelector('.tab[data-tab="result"]'); if (rt) rt.click();
        if (typeof showSurplusPopup === 'function') showSurplusPopup();
      }, 800);
      if (res.success) toast('🎉 シフト生成完了！全ルールクリア！', 'success', 5000);
      else toast(`シフト生成完了（違反${res.violations.length}件）`, 'info', 5000);
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
      return;
    } finally {
      setBusy(false);
      if (btnCancel) btnCancel.style.display = 'none';
    }
  };
  window._runGenerate = runGenerate;   // 「証明ありで解き直す」等から呼ぶ
  btn.addEventListener('click', () => runGenerate({}));
  if (btnFast) btnFast.addEventListener('click', () => runGenerate({ fastMode: true }));

  // キャンセルボタン
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (typeof cancelActiveOptimization === 'function' && cancelActiveOptimization()) {
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

  // ── 違反を2段階（🔴絶対NG / 🟡注意）に分類 ───────────────────
  const must  = result.violations.filter(v => isMustViolation(v.type));
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
        ${escapeHtml(v.message)}
        <span class="v-action">💡 ${escapeHtml(v.action)}</span>
      </div>`;
  }).join('');

  // サマリー: 絶対NGが0なら実質クリア扱いのメッセージ
  let html = diagHtml;
  if (must.length === 0) {
    html += `<div class="report-success">✅ 絶対NG（人員不足・スキル・連勤超過・単発出勤など）は 0件！ 残り ${should.length}件 は「できれば避けたい」調整項目です。</div>`;
  } else {
    html += `<div class="report-warning">🔴 絶対NG: ${must.length}件 ／ 🟡 注意: ${should.length}件</div>`;
  }

  if (must.length) {
    html += `
      <div class="violation-group-title" style="color:#9b2335;font-weight:700;margin:12px 0 6px">🔴 絶対NG（必ず直す）— ${must.length}件</div>
      <div class="violation-list must">${renderItems(must)}</div>`;
  }
  if (should.length) {
    html += `
      <div class="violation-group-title" style="color:#975a16;font-weight:700;margin:14px 0 6px">🟡 注意（できれば避けたい）— ${should.length}件</div>
      <div class="violation-list should">${renderItems(should)}</div>`;
  }
  $c.innerHTML = html;
}

// 違反の重要度分類。🔴絶対NG（MUST）= 現場で致命的なもの。それ以外は🟡注意。
// 単発出勤(single-work)はユーザー要望により絶対NGに含める。
const MUST_VIOLATION_TYPES = new Set([
  'understaff', 'skill-late', 'consecutive', 'resp-duplicate', 'hierarchy',
  'vicemanager-absent', 'single-work', 'pref-mismatch', 'role-mismatch',
  'event-absent', 'night-after-work',
  'off-count', 'late-early', // 公休不足・遅→早(休みなし) も絶対NG
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

      const before = AppState.violations.length;
      const backup = JSON.parse(JSON.stringify(AppState.shifts));
      try {
        if (typeof optimizeScheduleMILP !== 'function') throw new Error('数理最適化モジュール未読込（再読込してください）');
        // 🔒で固定したセルは保持し、それ以外を数理最適化で最適化し直す（悪化しない保証つき）
        const res = await optimizeScheduleMILP((pct, msg) => {
          if ($bar)  $bar.style.width = pct + '%';
          if ($text) $text.textContent = '数理最適化で修復中: ' + msg;
        });
        const after = res.violations.length;
        if (after < before) {
          if ($bar) $bar.style.width = '100%';
          renderResultTable();
          document.getElementById('reportCard').style.display = 'block';
          renderReport({ success: res.success, score: after, violations: res.violations });
          if ($text) $text.textContent = `修復完了: 違反 ${before}件 → ${after}件`;
          toast(`✅ 数理最適化でエラーを ${before - after}件 減らしました（🔒は保持）`, 'success', 5000);
        } else {
          // 改善なし → 完全に元へ戻す（悪化させない）
          AppState.shifts = backup; AppState.violations = checkViolations(backup);
          if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
          renderResultTable();
          if ($text) $text.textContent = `これ以上は改善できませんでした（違反 ${before}件）`;
          toast('これ以上は数理最適化でも減らせませんでした。関係する🔒を解除すると改善する場合があります', 'info', 6000);
        }
        saveToStorage();
      } catch (e) {
        console.error(e);
        AppState.shifts = backup; AppState.violations = checkViolations(backup);
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
      // 🔒は保持したまま、短時間の数理最適化でサッと再調整（悪化しない保証つき）
      (async () => {
        try {
          if (typeof optimizeScheduleMILP !== 'function') throw new Error('数理最適化モジュール未読込（再読込してください）');
          const res = await optimizeScheduleMILP(() => {});
          if (res.violations.length >= before) {
            AppState.shifts = backup;
            AppState.violations = checkViolations(backup);
            if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
            toast('🧩では直せませんでした（変更なし）。より時間をかける「🛠 エラーを自動修正」を試すか、関係する🔒を解除してください', 'info', 6000);
          } else {
            toast(`🧩 エラー ${before}件 → ${res.violations.length}件 に調整（🔒は保持・Ctrl+Zで戻せます）`, 'success', 4000);
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
          AppState.violations = checkViolations(backup);
          if (typeof discardLastShiftHistory === 'function') discardLastShiftHistory();
          toast('調整中にエラーが発生しました: ' + e.message, 'error');
        } finally {
          btnQuick.disabled = false;
          btnQuick.textContent = '🧩 かんたん調整';
        }
      })();
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
