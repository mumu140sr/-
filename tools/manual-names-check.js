// 手引き（manual.html）に出てくる画面の名前が、今のアプリの画面に出る文字と1文字も違わないかを確かめる道具（v257〜）。
//
// 手引きでは、画面の名前を次の印で書いている（manual.html）:
//   .m-tab  左メニューの画面の名前（基本設定 など）
//   .m-btn  ボタンの名前
//   .m-ui   「」で囲む欄・見出し・選択肢の名前
//   .m-msg  知らせの文。data-pat の「◯」は、日付や件数など変わる所
// アプリを、作り物のデータ（tools/suite/cases。本物のデータは使わない）でいろいろな状態にして、
// 画面に出た文字を集め、手引きの名前と突き合わせる。状態：6つの画面、開いた小窓（実現性チェック・
// エラー解消プラン・余の使い道・見込み・順番に確認して生成する・余の解消・途中から作り直す・まとめて固定・
// 自動修正の案・シフト編集・人手が足りない理由の枠・余り・不足の内訳と表の一言）、計算中、確認の文、知らせ、月の切り替え、1分生成のあとの知らせ。
// 実際に出せなかった名前は、JS の文字列と CSS の content でも探し、そうと分かるように出す。
//
// 使い方（リポジトリの一番上で）:
//   node tools/manual-names-check.js [作り物のデータ（既定: tools/suite/cases/case01.json）]
// 必要なもの: Playwright と Chromium。場所は次の環境変数で変えられる。
//   PLAYWRIGHT_MODULE（既定: playwright → /opt/node22/lib/node_modules/playwright/node_modules/playwright-core）
//   PW_CHROMIUM（既定: /opt/pw-browsers/chromium-1194/chrome-linux/chrome。無ければ Playwright の既定）
// 1分生成を1回と、自動修正の案を1回計算するので、全部で数分かかる。
// 一致しない名前が1つでもあれば、終わりのコードを 1 にする。
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'tools', 'suite', 'cases', 'case01.json');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core',
    '/opt/node22/lib/node_modules/playwright/node_modules/playwright-core'].filter(Boolean);
  for (const m of tries) { try { return require(m); } catch (_) {} }
  throw new Error('Playwright が見つかりません（PLAYWRIGHT_MODULE で場所を指定してください）');
}

// リポジトリを配る小さなサーバー（外へは出ない）
function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const norm = s => String(s || '').replace(/\s+/g, '');

(async () => {
  const { chromium } = loadPlaywright();
  const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const b = await chromium.launch(Object.assign({ args: ['--no-sandbox'] }, fs.existsSync(exe) ? { executablePath: exe } : {}));
  const srv = await startServer();
  const BASE = `http://127.0.0.1:${srv.address().port}`;
  // 外のサイト（Excel の部品の CDN など）には行かない
  const blockOutside = async ctx => ctx.route(u => !String(u).startsWith(BASE), r => r.abort());

  const live = new Set(), tabs = new Set();
  const grab = async (p) => {
    const r = await p.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const t = n.textContent.trim(); if (t) out.push(t); }
      document.querySelectorAll('*').forEach(e => {
        const t = (e.textContent || '').trim(); if (t && t.length <= 80) out.push(t);
        ['title', 'aria-label', 'placeholder'].forEach(a => { const v = e.getAttribute && e.getAttribute(a); if (v) out.push(v); });
      });
      document.querySelectorAll('option').forEach(o => out.push(o.textContent.trim()));
      return { out, tb: [...document.querySelectorAll('.tab-txt')].map(e => e.textContent.trim()),
               toasts: [...document.querySelectorAll('.toast')].map(t => t.innerText) };
    });
    r.out.forEach(t => live.add(norm(t))); r.tb.forEach(t => tabs.add(norm(t))); r.toasts.forEach(t => live.add(norm(t)));
  };

  // 1. 作り物のデータを入れ、1分生成で表を作る（このあとの各状態の出発点）
  let baseData;
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await blockOutside(ctx);
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    await p.goto(BASE + '/index.html'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(800);
    const ok = await p.evaluate((txt) => {
      const d = JSON.parse(txt);
      const n = normalizeAppData(d, defaultAppDataBase()); applyAppData(n);
      refreshAllUI(); if (typeof resetShiftHistory === 'function') resetShiftHistory(); saveToStorage(); return true;
    }, fs.readFileSync(DATA, 'utf8'));
    if (!ok) throw new Error('データを入れられませんでした');
    await p.click('.tab[data-tab="generate"]');
    await p.check('input[name="genMode"][value="fast"]');
    await p.click('#btnMakeShift');
    await p.waitForFunction(() => AppState.generated && !document.getElementById('btnMakeShift').disabled, null, { timeout: 600000 });
    await p.waitForTimeout(1500);
    await grab(p);   // 1分生成のあとの知らせ
    await p.evaluate(() => saveToStorage());
    baseData = await p.evaluate(() => localStorage.getItem('shiftAppData'));
    await ctx.close();
  }
  console.log('表を作りました。画面の文字を集めます…');

  async function fresh() {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await blockOutside(ctx);
    const p = await ctx.newPage();
    p.on('dialog', async d => { live.add(norm(d.message())); await d.dismiss(); });
    await p.goto(BASE + '/index.html'); await p.evaluate(d => localStorage.setItem('shiftAppData', d), baseData); await p.reload();
    await p.waitForTimeout(1200);
    return { ctx, p };
  }
  const adv = async p => { await p.click('.tab[data-tab="generate"]'); await p.evaluate(() => { document.getElementById('advGenerate').open = true; }); };
  const menu = async (p, id) => { await p.click('.tab[data-tab="result"]'); await p.click('#btnResultMenu'); await p.click('#' + id); };
  const steps = {
    base:      async p => { await p.evaluate(() => { document.getElementById('settingsMore').open = true; toggleRuleLevelsPanel(); toggleDailyReqPanel(); });
                            await p.click('.tab[data-tab="roles"]'); await p.evaluate(() => document.querySelectorAll('.role-more-btn').forEach(x => x.click())); },
    addshift:  async p => { await p.click('.tab[data-tab="roles"]'); await p.click('#btnAddShiftType'); await p.waitForTimeout(300); },
    // 日ごとに要るスキル（v264）: 指定が1つある状態の一覧（「外す」）と欄
    dayskill:  async p => { await p.click('.tab[data-tab="roles"]');
                            await p.evaluate(() => { const n = (AppState.skills[0] || {}).name; if (n) AppState.dailyShiftSkills = { [getWorkShiftKeys()[0]]: { 3: [n] } };
                              toggleDailyReqPanel(); }); await p.waitForTimeout(300); },
    feas:      async p => { await adv(p); await p.click('#btnFeasibility'); await p.waitForTimeout(3000); },
    relax:     async p => { await adv(p); await p.click('#btnRelax'); await p.waitForTimeout(4000); },
    surplan:   async p => { await adv(p); await p.click('#btnSurplusPlan'); await p.waitForTimeout(2000); },
    forecast:  async p => { await adv(p); await p.click('#btnForecast'); await p.waitForTimeout(2000); },
    wizard:    async p => { await p.click('.tab[data-tab="generate"]'); await p.click('#btnWizard'); await p.waitForTimeout(2000); },
    resolve:   async p => { await menu(p, 'btnResolveSurplus'); await p.waitForTimeout(2500); },
    partial:   async p => { await menu(p, 'btnPartialRegen'); await p.waitForTimeout(1200); },
    rangelock: async p => { await menu(p, 'btnRangeLock'); await p.waitForTimeout(800); },
    cell:      async p => { await p.click('.tab[data-tab="result"]'); await p.click('#resultTable td[data-sid]'); await p.waitForTimeout(400); },
    // 人手が足りない理由（v265）: 帯の下の文の「理由を見る」で、画面の下の理由の枠を開く（足りない所が無い表なら何もしない）
    // 余り・不足の内訳（v267）: 帯の「不足」（無ければ「余」）を押して、下の枠を開く。スキルの行が出るように、
    // この状態の中だけでスキルの最低ラインを上げて数え直す（作り物のデータの写しの中だけ）
    band:      async p => { await p.click('.tab[data-tab="result"]');
                            await p.evaluate(() => { (AppState.skills || []).forEach(sk => { sk.min = 9; sk.req = 9; }); AppState.violations = checkViolations(AppState.shifts); renderResultTable(); });
                            await p.click('[data-band-open="short"], [data-band-open="sur"]'); await p.waitForTimeout(800);
                            const t = await p.$('#shpBody [data-rc-toggle]'); if (t) { await t.click(); await p.waitForTimeout(200); } },
    // 余り・不足の表の一言（v267）: この状態の中だけ（作り物のデータの写し）、7日はほとんどの人を休みの希望にし（全体の行の
    // 「月の合計では足りますが…」）、出られる日数0の人を、ふだん0人で3日だけ1人のシフトに決める（「希望・固定で、休み・有給を削った…」）。
    // 表の見方の折りたたみも開く
    bandnote:  async p => { await p.click('.tab[data-tab="result"]');
                            await p.evaluate(() => {
                              const days = getDaysInMonth(AppState.settings.targetMonth);
                              AppState.staff.forEach((s, i) => { if (i >= 2) { AppState.requests[s.id] = AppState.requests[s.id] || {}; AppState.requests[s.id][7] = '休'; } });
                              AppState.shiftTypes.push({ key: 'SH9', sym: '夜', label: '夜間', color: '#e2e8f0', category: 'B', countForStaff: true, isTraining: false, isNight: false, workHours: 8 });
                              AppState.roleRequirements.SH9 = 0; AppState.dailyRequirements = AppState.dailyRequirements || {}; AppState.dailyRequirements.SH9 = { 3: 1 };
                              const s = AppState.staff[0]; s.allowedShifts = (s.allowedShifts || []).concat('SH9'); s.maxOff = days;
                              AppState.requests[s.id] = AppState.requests[s.id] || {}; AppState.requests[s.id][3] = 'SH9';
                              AppState.violations = checkViolations(AppState.shifts); renderResultTable(); });
                            await p.click('[data-band-open="short"], [data-band-open="sur"]'); await p.waitForTimeout(800);
                            const h = await p.$('#shpBody details.rc-help > summary'); if (h) { await h.click(); await p.waitForTimeout(200); } },
    shortwhy:  async p => { await p.click('.tab[data-tab="result"]');
                            const bt = await p.$('#shortageNote:not([hidden]) .sn-why') || await p.$('.short-why');
                            if (bt) { await bt.click(); await p.waitForTimeout(800); } },
    recheck:   async p => { await menu(p, 'btnRecheck'); await p.waitForTimeout(800); await p.click('.tab[data-tab="generate"]'); },
    month:     async p => { await p.evaluate(() => { const m = document.getElementById('targetMonth'); const [y, mo] = m.value.split('-').map(Number);
                              m.value = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; m.dispatchEvent(new Event('change')); });
                            await p.waitForTimeout(1300); },
    theme:     async p => { await p.click('#btnDataMenu'); await p.click('#btnTheme'); await p.waitForTimeout(300); await p.click('#btnDataMenu'); },
    // 計算中（希望の欄を押したときの知らせと「中止」）
    calc:      async p => { await p.click('.tab[data-tab="generate"]'); await p.click('#btnMakeShift'); await p.waitForTimeout(1500);
                            await p.click('.tab[data-tab="settings"]'); await p.click('#maxConsecutive').catch(() => {}); await p.waitForTimeout(300);
                            await grab(p); await p.click('.tab[data-tab="generate"]'); await p.click('#btnCancelGenerate'); await p.waitForTimeout(800); },
    clearfixed: async p => { await p.click('.tab[data-tab="result"]'); await p.click('#resultTable td[data-sid]');
                            await p.click('#shiftOptionContainer .shift-option:not([data-shift=""])'); await p.waitForTimeout(300);
                            await p.click('#btnResultMenu'); await p.click('#btnClearFixed'); await p.waitForTimeout(300); },
    // 自動修正の案（1マスくずしてから。案が出たら「反映」のボタンまで）
    repair:    async p => { await p.click('.tab[data-tab="result"]');
                            await p.evaluate(() => { const s = AppState.staff[0]; const row = AppState.shifts[s.id] || {};
                              const d = Object.keys(row).find(k => isWork(row[k]) === false && +k > 3);
                              if (d) row[d] = (AppState.shiftTypes.find(t => (s.allowedShifts || []).includes(t.key)) || AppState.shiftTypes[0]).key;
                              AppState.violations = checkViolations(AppState.shifts); renderResultTable(); });
                            await p.click('#btnRepair');
                            await p.waitForFunction(() => { const x = document.querySelector('[data-rcgo]');
                              return (x && !x.disabled) || /見つかりませんでした|中止しました|失敗/.test((document.getElementById('rcRows') || {}).innerText || ''); },
                              null, { timeout: 300000 }).catch(() => {}); },
  };
  for (const k of Object.keys(steps)) {
    const { ctx, p } = await fresh();
    try { await steps[k](p); await grab(p); } catch (e) { console.log('  状態', k, 'を作れませんでした:', String(e.message).split('\n')[0]); }
    await ctx.close();
  }

  // CSS の content の文字（③の詳細の項目名など）と、JS の文字列
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  const cssC = new Set([...css.matchAll(/content:\s*"([^"]+)"/g)].map(m => norm(m[1])));
  const jsN = norm(['ui.v6.js', 'app.v6.js', 'milp.v6.js', 'ui-shell.v6.js', 'ai-explain.v6.js', 'optimizer.v6.js', 'data.v6.js']
    .map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n'));
  const liveJoined = [...live].join('\u0001');

  // 手引きの名前
  const ctx = await b.newContext(); await blockOutside(ctx);
  const mp = await ctx.newPage(); await mp.goto(BASE + '/manual.html');
  const names = await mp.evaluate(() => {
    const g = s => [...document.querySelectorAll(s)].filter(e => !e.closest('.m-bar')).map(e => ({ cls: s, t: e.textContent.trim(), pat: e.dataset.pat || '' }));
    return [...g('.m-tab'), ...g('.m-btn'), ...g('.m-ui'), ...g('.m-msg')];
  });
  const own = new Set(['印刷／PDF保存']);   // 手引き自身のボタン
  const seen = new Map();
  for (const n of names) {
    const key = n.cls + '|' + (n.pat || n.t);
    if (seen.has(key)) { seen.get(key).count++; continue; }
    let how = ''; const t = norm(n.t);
    if (n.cls === '.m-tab') how = tabs.has(t) ? '画面（左メニュー）' : '';
    else if (n.cls === '.m-msg') {
      const re = new RegExp(norm(n.pat || n.t).split('◯').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?'));
      how = re.test(liveJoined) ? '画面に出た文' : (re.test(jsN) ? 'JSの文字列（実際には出していない）' : '');
    } else if (own.has(n.t)) how = '手引き自身のボタン';
    else how = live.has(t) ? '画面' : (cssC.has(t) ? '画面（CSSの文字）' : (jsN.includes(t) ? 'JSの文字列（実際には出していない）' : ''));
    seen.set(key, Object.assign({}, n, { how, count: 1 }));
  }
  const rows = [...seen.values()];
  const bad = rows.filter(r => !r.how), jsOnly = rows.filter(r => /JS/.test(r.how));
  console.log(`手引きの名前 ${rows.length}種類（${names.length}か所）／ 一致しない ${bad.length} ／ JSの文字列でだけ一致 ${jsOnly.length}`);
  bad.forEach(r => console.log('  一致しない:', r.cls, r.pat || r.t));
  jsOnly.forEach(r => console.log('  JSだけ:', r.cls, r.pat || r.t));
  await b.close(); srv.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
