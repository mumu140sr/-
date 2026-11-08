// 使い方（1行の例。同じ版のアプリで、設定を2通り（A・B）にして、1つの月を 🎯 じっくり生成と同じ条件で4通りずつ作って比べる）:
//   node tools/measure/setting-compare.js --app . --month tools/measure/months/syn_m4c_nm.json --rounds 3 --out /tmp/sc \
//     --a '{"maxBandSwitch":2,"ruleLevels":{"band-switch":"must"}}' --b '{"maxBandSwitch":1,"ruleLevels":{"band-switch":"must"}}'
//
// - --a・--b は、月のデータの settings に重ねる設定（ruleLevels は、月のデータの ruleLevels に重ねる）。生成の計算は同じ版のまま。
// - 🎯 じっくり生成と同じ条件: newTiering あり・deepMode なし・fastMode なし。--mode fast で1分生成。
// - deep-compare.js と同じく、1つの設定の4通りを同時に作る（4本同時）。A → B → A … と交互に、--rounds 回ずつ作る。
//   1つの作業場所で、同時にいくつもの月を回さない（CPU が混むと結果が変わる。CLAUDE.md「測り方」）。
// - 4通りから選ぶのは、アプリと同じ並べ方（scoreCompare）。数えるのは、その設定での検査の結果（画面に出るもの）。
// - 書き出すもの: 回ごとに、選んだ答えの ⛔ 6連勤以上・人員不足・絶対（⛔と「早遅の切り替え回数」を除く）・できれば（同じく除く）・
//   早遅の切り替えの合計（検査と同じ数え方。上限を超えたかにかかわらず、数える人の全員）・1人の最多・上限を超えた人・
//   遅→休→早・連勤中の時間帯切替・種類ごとの件数。--out のフォルダーに4通りの表と違反の一覧も残す。
// - 「早遅の切り替え回数」の件数は、上限によって数え方が変わるので（上限2回と1回では、同じ表でも件数が違う）、
//   絶対・できれば の数からは外し、切り替えの合計で比べる。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');

// ---- 子: 1通りを解いて書き出す（親から --child で呼ぶ） ----
if (process.argv[2] === '--child') {
  const [, , , ROOT, SRC, MODE, V, OUT] = process.argv;
  const RAW = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const c = { console: { log() {}, warn() {}, error() {} } }; c.globalThis = c; c.self = c; c.window = c; vm.createContext(c);
  c.importScripts = (...files) => files.forEach(f => {
    const b = f.split('?')[0];
    if (b.indexOf('highs.js') >= 0) {
      const fa = require(path.resolve(ROOT, 'js/vendor/highs.js'));
      c.Module = o => fa(Object.assign({}, o || {}, { locateFile: x => path.resolve(ROOT, 'js/vendor', x.split('/').pop()) }));
      return;
    }
    vm.runInContext(fs.readFileSync(path.resolve(ROOT, 'js', b), 'utf8'), c, { filename: b });
  });
  let h = null; c.addEventListener = (t, fn) => { if (t === 'message') h = fn; };
  let last = null; c.postMessage = m => { if (m && m.type !== 'progress' && m.type !== 'trace' && m.type !== 'trace-screen' && m.type !== 'trace-tighten' && m.type !== 'trace-prepolish') last = m; };
  vm.runInContext(fs.readFileSync(path.resolve(ROOT, 'js/milp.worker.js'), 'utf8'), c, { filename: 'milp.worker.js' });
  const t0 = Date.now();
  const msg = { type: 'milp', variant: parseInt(V, 10), appState: RAW,
    newTiering: MODE === 'goal', fastMode: MODE === 'fast', deepMode: false };
  Promise.resolve(h({ data: msg })).then(() => {
    fs.writeFileSync(OUT, JSON.stringify({ v: +V, sec: Math.round((Date.now() - t0) / 1000), error: last && last.type === 'error' ? last.message : undefined,
      shifts: last && last.shifts, violations: last && last.violations }));
  }).catch(e => { fs.writeFileSync(OUT, JSON.stringify({ v: +V, error: String(e) })); });
  return;
}

// ---- 親 ----
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const APP = arg('app', '.'), MONTH = arg('month'), ROUNDS = parseInt(arg('rounds', '1'), 10);
const MODE = arg('mode', 'goal'), OUTDIR = arg('out', path.join(require('os').tmpdir(), 'setting-compare'));
if (!MONTH || !arg('a') || !arg('b')) { console.error('--month・--a・--b を指定してください（いちばん上の使い方を見てください）'); process.exit(2); }
const PATCH = { A: JSON.parse(arg('a')), B: JSON.parse(arg('b')) };
const name = path.basename(MONTH, '.json');
fs.mkdirSync(OUTDIR, { recursive: true });
const base = JSON.parse(fs.readFileSync(MONTH, 'utf8'));
function patched(p) {
  const raw = JSON.parse(JSON.stringify(base));
  raw.settings = raw.settings || {};
  const { ruleLevels, ...rest } = p;
  Object.assign(raw.settings, rest);
  if (ruleLevels) raw.settings.ruleLevels = Object.assign({}, raw.settings.ruleLevels || {}, ruleLevels);
  return raw;
}
const RAWS = { A: patched(PATCH.A), B: patched(PATCH.B) };
const SRCS = {};
['A', 'B'].forEach(k => { SRCS[k] = path.join(OUTDIR, `${name}_${k}_input.json`); fs.writeFileSync(SRCS[k], JSON.stringify(RAWS[k])); });

function ctxOf(raw) {   // その設定での検査・並べ方
  const c = { console: { log() {}, warn() {}, error() {} } }; c.globalThis = c; c.self = c; c.window = c; vm.createContext(c);
  ['data.js', 'optimizer.js'].forEach(f => vm.runInContext(fs.readFileSync(path.resolve(APP, 'js', f), 'utf8'), c, { filename: f }));
  c.__raw = raw; vm.runInContext('applyAppData(normalizeAppData(__raw)); _shiftKeysCache = null;', c); return c;
}
function runSetting(k, round) {
  const dir = path.join(OUTDIR, `${name}_${k}_${round}`); fs.mkdirSync(dir, { recursive: true });
  return Promise.all([0, 1, 2, 3].map(v => new Promise(res => {
    const out = path.join(dir, `way${v}.json`);
    const p = cp.spawn(process.execPath, [__filename, '--child', path.resolve(APP), SRCS[k], MODE, String(v), out], { stdio: 'inherit' });
    p.on('exit', () => res(fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { v, error: '結果がありません' }));
  })));
}
// 切り替えの数え方は、検査（optimizer の band-switch）と同じ: 早番・遅番の両方を担当でき、「早番のみ／遅番のみ」でない人。
// 休みの日は前の時間帯を引き継ぐ、半休は早番
const COUNT_SW = `(function (shifts) {
  const days = getDaysInMonth(AppState.settings.targetMonth); const per = [];
  AppState.staff.forEach(s => {
    const keys = s.allowedShifts || [];
    const both = keys.some(k => isEarlyCategory(k)) && keys.some(k => isLate(k));
    const r = (typeof getBalanceRatio === 'function') ? getBalanceRatio(s) : null;
    if (!both || (r && r.only)) return;
    let prevB = null, n = 0;
    for (let d = 1; d <= days; d++) {
      const v = (shifts[s.id] || {})[d] || '';
      const b = isHalfWork(v) ? 'e' : (isWork(v) ? (isEarlyCategory(v) ? 'e' : (isLate(v) ? 'l' : null)) : null);
      if (!b) continue;
      if (prevB && b !== prevB) n++;
      prevB = b;
    }
    per.push(n);
  });
  return per;
})`;
function summarize(k, ways) {
  if (ways.some(w => w.error || !w.violations || !w.shifts)) return { error: ways.map(w => w.error || '表がありません').filter(Boolean).join(' / ') };
  const c = ctxOf(RAWS[k]);
  c.__w = ways;
  const s = vm.runInContext(`__w.map(w => { const vs = w.violations; const r = scoreViolations(vs); const t = {}; vs.forEach(v => { t[v.type] = (t[v.type] || 0) + 1; });
    const bsN = t['band-switch'] || 0, bsIsMust = getRuleLevel('band-switch') === 'must' || MUST_TYPES_OPT.has('band-switch');   // scoreViolations と同じ分け方
    const bsMust = bsIsMust ? bsN : 0, bsSoft = bsIsMust ? 0 : bsN;
    const per = ${COUNT_SW}(w.shifts);
    return { sc: r, comp: r.comp, under: r.under, must: r.must - r.comp - bsMust, soft: r.soft - bsSoft, types: t,
      swTotal: per.reduce((a, b) => a + b, 0), swMax: per.length ? Math.max(...per) : 0,
      swOver: per.filter(n => n > Math.max(0, parseInt(AppState.settings.maxBandSwitch, 10) || 0)).length,
      badRest: t['bad-rest'] || 0, catSw: t['category-switch'] || 0, sec: w.sec }; })`, c);
  c.__s = s;
  const best = vm.runInContext('__s.map((x, i) => i).sort((i, j) => scoreCompare(__s[i].sc, __s[j].sc) || i - j)[0]', c);
  return { best, ways: s };
}
const fmt = b => `⛔${b.comp} 人員不足${b.under} 絶対${b.must} できれば${b.soft} ／ 切り替え 合計${b.swTotal}・1人の最多${b.swMax}・上限を超えた人${b.swOver} ／ 遅→休→早${b.badRest} 連勤中の時間帯切替${b.catSw}`;
(async () => {
  console.log(`${name}  A=${JSON.stringify(PATCH.A)}  B=${JSON.stringify(PATCH.B)}  （${MODE === 'goal' ? '🎯 じっくり生成の条件' : '1分生成'}）`);
  const all = { A: [], B: [] };
  for (let r = 1; r <= ROUNDS; r++) {
    for (const k of ['A', 'B']) {
      const t0 = Date.now(); const ways = await runSetting(k, r);
      const res = summarize(k, ways); const sec = Math.round((Date.now() - t0) / 1000);
      if (res.error) { console.log(`${name} ${r}回目 ${k} 失敗: ${res.error}`); continue; }
      const b = res.ways[res.best]; all[k].push(b);
      console.log(`${name} ${r}回目 ${k}: 通り${res.best} ${fmt(b)}（${sec}秒）`);
      console.log(`   通りごと（⛔/人員不足/絶対/できれば/切り替え合計）: ${res.ways.map(x => `${x.comp}/${x.under}/${x.must}/${x.soft}/${x.swTotal}`).join('  ')}`);
      console.log(`   種類ごと: ${JSON.stringify(b.types)}`);
    }
  }
  const col = (k, f) => all[k].map(f).join('・');
  console.log(`${name} まとめ（回ごと）`);
  for (const k of ['A', 'B']) console.log(`  ${k}: ⛔ ${col(k, x => x.comp)} ／ 人員不足 ${col(k, x => x.under)} ／ 絶対 ${col(k, x => x.must)} ／ できれば ${col(k, x => x.soft)} ／ 切り替え合計 ${col(k, x => x.swTotal)} ／ 1人の最多 ${col(k, x => x.swMax)} ／ 遅→休→早 ${col(k, x => x.badRest)} ／ 連勤中の時間帯切替 ${col(k, x => x.catSw)}`);
})();
