/* ===========================================
   ui-shell.js - 画面の外枠（見た目の作り直し 工程2〜。v251）
   - 各画面の下の「前へ」「次へ」：左メニューのボタンを click() するだけ
   - ヘッダーの「データ」メニューを開く・閉じる（中のボタンは今のボタンそのもの）
   - ②の各行の「詳細」を開く・閉じる（v252）
   - ⑤「シフトを作る」: 選んだ作り方の今のボタンを click() し、元が押せない間は押せなくする（v253）
   - ⑥「その他の操作」メニューを開く・閉じる（中のボタンは今のボタンそのもの。v254）
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

  document.addEventListener('DOMContentLoaded', () => {
    setupMakeShift();
    setupRoleMore();
    setupStepNav();
    setupMenu(document.getElementById('btnDataMenu'), document.getElementById('dataMenu'));
    setupMenu(document.getElementById('btnResultMenu'), document.getElementById('resultMenu'));   // ⑥「その他の操作」（v254）
  });
})();
