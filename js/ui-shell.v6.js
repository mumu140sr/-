/* ===========================================
   ui-shell.js - 画面の外枠（見た目の作り直し 工程2〜。v251）
   - 各画面の下の「前へ」「次へ」：左メニューのボタンを click() するだけ
   - ヘッダーの「データ」メニューを開く・閉じる（中のボタンは今のボタンそのもの）
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

  document.addEventListener('DOMContentLoaded', () => {
    setupStepNav();
    setupMenu(document.getElementById('btnDataMenu'), document.getElementById('dataMenu'));
  });
})();
