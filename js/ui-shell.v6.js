/* ===========================================
   ui-shell.js - 画面の外枠（見た目の作り直し 工程2〜。v251）
   - 各画面の下の「前へ」「次へ」：左メニューのボタンを click() するだけ
   - ヘッダーの「データ」メニューを開く・閉じる（中のボタンは今のボタンそのもの）
   - ②の各行の「詳細」を開く・閉じる（v252）
   - ⑤「シフトを作る」: 選んだ作り方の今のボタンを click() し、元が押せない間は押せなくする（v253）
   - ⑥「その他の操作」メニューを開く・閉じる（中のボタンは今のボタンそのもの。v254）
   - ③ 左の一覧（表示用）と、選ぶ行の切り替え（v255）
   計算・保存・生成には触らない。新しい処理はここに足さない。
   =========================================== */
(function () {
  // 「前へ」「次へ」: data-go の手順の左メニューのボタンを押す
  function setupStepNav() {
    document.querySelectorAll('.step-nav [data-go]').forEach(b => {
      b.addEventListener('click', () => {
        const t = document.querySelector(`.tab[data-tab="${b.dataset.go}"]`);
        if (t) t.click();
        window.scrollTo(0, 0);
      });
    });
  }

  // メニュー（ボタン＋中身）を開く・閉じる。外を押す・Esc・中のボタンを押したら閉じる
  function setupMenu(btn, pop) {
    if (!btn || !pop) return;
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
    // 中のボタンの処理が終わってから閉じる（ボタン自身の click は先に動く）
    pop.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(close, 0); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
  }

  // ②の各行の「詳細」を開く・閉じる。表を描き直しても（合算を切り替えたときなど）、開いていた行は開いたままにする
  function setupRoleMore() {
    const tb = document.getElementById('roleTableBody');
    if (!tb) return;
    const open = new Set();
    const apply = () => tb.querySelectorAll('.role-more-btn').forEach(b => {
      const on = open.has(b.dataset.more);
      const tr = b.closest('tr');
      if (tr) tr.classList.toggle('open', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('.role-more-btn');
      if (!b) return;
      const k = b.dataset.more;
      if (open.has(k)) open.delete(k); else open.add(k);
      apply();
    });
    new MutationObserver(apply).observe(tb, { childList: true });
  }

  // ⑤「シフトを作る」: 選んだ作り方の今のボタン（1分生成＝btnGenerateFast、じっくり生成＝btnGenerate）を押すだけ。
  // 元のボタンが押せない間（計算中など）は「シフトを作る」も押せなくする（元の disabled を見て写す）
  function setupMakeShift() {
    const go = document.getElementById('btnMakeShift');
    const fast = document.getElementById('btnGenerateFast'), deep = document.getElementById('btnGenerate');
    if (!go || !fast || !deep) return;
    const pick = () => {
      const r = document.querySelector('input[name="genMode"]:checked');
      return r && r.value === 'deep' ? deep : fast;
    };
    const mirror = () => { go.disabled = !!pick().disabled; };
    go.addEventListener('click', () => { const b = pick(); if (!b.disabled) b.click(); });
    document.querySelectorAll('input[name="genMode"]').forEach(r => r.addEventListener('change', mirror));
    [fast, deep].forEach(b => new MutationObserver(mirror).observe(b, { attributes: true, attributeFilter: ['disabled'] }));
    mirror();
  }

  // ③ スタッフ管理: 左に一覧、右に選んだ人の設定（v255）。
  // 表（staffTableBody）は ui.v6.js が今までどおり描く。ここは「どの行を選ぶか」と、表示用の一覧を作るだけ。
  // 選んだ行に .is-selected を付けると、CSS がその行だけを詳細の形に見せる（ほかの行は DOM に残り、見えないだけ）。
  // 見出しの列が今の19列と違えば（だれかが列を足した など）、詳細の形にせず v254 と同じ表のまま出す（安全装置）。
  const STAFF_COLS = ['名前', '部門', '役職', '担当シフト', 'スキル', '公休数(月の休み数)', '有給(月の有給数)',
    '希望早可/遅可', '早遅バランス(割合／のみ＝絶対)', '連勤上限(個人・空欄=全体)', '連休上限(個人・空欄=全体)',
    '遅→早は連休必須', '土日休み希望', '休み方連休/分散', '連休回数(月・空欄=全体)', '前月末連勤日数0=月末は休み',
    '前月末シフト連勤1日以上で選択', '備考', '削除'];
  function setupStaffSplit() {
    const split = document.getElementById('staffSplit');
    const tb = document.getElementById('staffTableBody');
    const list = document.getElementById('staffList');
    const count = document.getElementById('staffCount');
    if (!split || !tb || !list) return;
    const table = tb.closest('table');
    let selId = null, prevIds = [];
    const rows = () => [...tb.children].filter(tr => tr.tagName === 'TR' && tr.querySelector('[data-id]'));
    const idOf = (tr) => { const e = tr.querySelector('[data-id]'); return e ? e.dataset.id : null; };
    // 表の形が今のままか（見出しの19列の文字と、各行のセルの数）
    const shapeOk = () => {
      const ths = table ? [...table.querySelectorAll('thead tr:first-child > th')] : [];
      if (ths.length !== STAFF_COLS.length) return false;
      if (!ths.every((th, i) => th.textContent.replace(/\s+/g, '') === STAFF_COLS[i])) return false;
      return rows().every(tr => tr.children.length === STAFF_COLS.length);
    };
    const fieldText = (tr, sel) => { const e = tr.querySelector(sel); return e ? (e.value || '') : ''; };
    const optText = (tr, sel) => { const e = tr.querySelector(sel); return e && e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].textContent.trim() : ''; };
    // 一覧を作る（表示用。表の入力欄の値を読むだけ）
    const build = () => {
      const rs = rows();
      if (count) count.textContent = rs.length + '人';
      list.textContent = '';
      rs.forEach(tr => {
        const id = idOf(tr);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'staff-item calc-view-only';   // 見るだけの部品（計算中も切り替えられる）
        b.dataset.sid = id;
        b.setAttribute('role', 'option');
        const main = document.createElement('span'); main.className = 'staff-item-main';
        const nm = document.createElement('span'); nm.className = 'staff-item-name';
        nm.textContent = fieldText(tr, 'input[data-field="name"]') || '（名前なし）';
        const sub = document.createElement('span'); sub.className = 'staff-item-sub';
        sub.textContent = [optText(tr, 'select[data-field="department"]'), optText(tr, 'select[data-field="positionType"]'),
          '公休 ' + (fieldText(tr, 'input[data-field="maxOff"]') || '0') + '日'].filter(Boolean).join('・');
        main.append(nm, sub);
        const tags = document.createElement('span'); tags.className = 'staff-item-tags';
        tr.querySelectorAll('input[data-allowed]:checked').forEach(cb => {
          const t = document.createElement('span'); t.className = 'staff-tag';
          t.textContent = cb.dataset.allowed;
          const lab = cb.closest('.allowed-label');
          if (lab && lab.style.background) t.style.background = lab.style.background;
          tags.appendChild(t);
        });
        b.append(main, tags);
        list.appendChild(b);
      });
    };
    // 選ぶ行を決めて付ける
    const apply = () => {
      const ok = shapeOk();
      split.classList.toggle('is-split', ok);
      const rs = rows(), ids = rs.map(idOf);
      const added = ids.filter(x => !prevIds.includes(x));
      if (prevIds.length && added.length === 1 && ids.length === prevIds.length + 1) selId = added[0];     // 追加した直後は新しい人
      else if (!ids.includes(selId)) {
        if (selId != null && ids.length === prevIds.length - 1 && prevIds.filter(x => x !== selId).every((x, k) => x === ids[k])) {
          const i = prevIds.indexOf(selId);                                                                // 削除した直後は同じ位置の人
          selId = ids[Math.min(i, ids.length - 1)] || null;
        } else selId = ids[0] || null;                                                                     // そのほか（読込など）は先頭
      }
      prevIds = ids;
      rs.forEach(tr => tr.classList.toggle('is-selected', idOf(tr) === selId));
      build();
      list.querySelectorAll('.staff-item').forEach(b => {
        const on = b.dataset.sid === selId;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    };
    const select = (id, focus) => {
      selId = id; apply();
      const b = list.querySelector(`.staff-item[data-sid="${CSS.escape(id)}"]`);
      if (b && focus) b.focus();
      if (b) b.scrollIntoView({ block: 'nearest' });
    };
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.staff-item');
      if (!b) return;
      select(b.dataset.sid, true);
      // 一覧の下に詳細があるとき（スマホ幅）は、詳細まで送る
      const det = split.querySelector('.staff-detail');
      if (det && det.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1) det.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    // キーボード: ↑↓ で人を選ぶ（Tab で詳細の入力欄へ移る）
    list.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const items = [...list.querySelectorAll('.staff-item')];
      if (!items.length) return;
      let i = items.findIndex(b => b.dataset.sid === selId);
      i = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      select(items[i].dataset.sid, true);
    });
    // 名前・部門・役職・公休数・担当シフトを打ち替えたら、一覧の表示もその場で直す
    tb.addEventListener('input', () => apply());
    tb.addEventListener('change', () => apply());
    new MutationObserver(apply).observe(tb, { childList: true });
    apply();
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupStaffSplit();
    setupMakeShift();
    setupRoleMore();
    setupStepNav();
    setupMenu(document.getElementById('btnDataMenu'), document.getElementById('dataMenu'));
    setupMenu(document.getElementById('btnResultMenu'), document.getElementById('resultMenu'));   // ⑥「その他の操作」（v254）
  });
})();
