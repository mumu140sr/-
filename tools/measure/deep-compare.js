// 使い方（1行の例。前の版と新しい版のアプリのフォルダーを指定し、1つの月を 🎯 じっくり生成と同じ条件で4通りずつ作って比べる）:
//   node tools/measure/deep-compare.js --old ../app-v268 --new . --month tools/measure/months/syn_m4c_nm.json --rounds 1 --out /tmp/dc
//
// - 🎯 じっくり生成と同じ条件: newTiering あり・deepMode なし・fastMode なし（⏳ 妥協なしで再計算の条件ではない）。--mode fast で1分生成。
// - アプリと同じく、1つの版の4通りを同時に作る（4本同時）。前の版 → 新しい版 → 前の版 … と交互に、--rounds 回ずつ作る。
//   1つの作業場所で、同時にいくつもの月を回さない（CPU が混むと、同じ時間で探せる量が減って結果が変わる。CLAUDE.md「測り方」）。
// - 4通りから選ぶのは、アプリと同じ並べ方（その版の optimizer.js の scoreCompare）。違反の一覧は、その版の検査で数えたもの（画面に出るもの）。
// - 書き出すもの: 回ごとに、選んだ通り・⛔ 6連勤以上・人員不足・絶対（⛔を除く）・できれば・種類ごとの件数、通りごとの数、
//   v269 の決まり（新しい版の選んだ答えが前の版より悪いか。scoreCompare）。--out のフォルダーに4通りの結果（違反の一覧）も残す。
// - アプリのフォルダーは、index.html と js/（milp.worker.js・milp-core.js・data.js・optimizer.js・vendor/highs.js）がある所。
//   前の版は、例えば `git worktree add ../app-v268 <前の版のコミット>` で作る。
// - months/ の月は、どれも作り物（tools/suite の case01 から作った月に、深夜などを足したもの）。本物の名前・希望は入っていない。
//   *_rl.json: 深夜（SH1・夜勤・遅番の仲間・3・10・17・24日に1人）に「責任者として数える」印あり。副店長 D と1人のリーダーが担当。
//              3日・17日は入れ替え日、10日は新装日。
//   *_nm.json: 同じ月の印なし。  syn_m4c_nn.json: 印なしで、深夜が 3・4・5日と17・18日に続く月（夜勤が続くのはよい、の確かめ）。
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
      violations: last && last.violations, safetyPick: last && last.safetyPick, solverProven: last && last.solverProven }));
  }).catch(e => { fs.writeFileSync(OUT, JSON.stringify({ v: +V, error: String(e) })); });
  return;
}

// ---- 親 ----
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const OLD = arg('old'), NEW = arg('new', '.'), MONTH = arg('month'), ROUNDS = parseInt(arg('rounds', '1'), 10);
const MODE = arg('mode', 'goal'), OUTDIR = arg('out', path.join(require('os').tmpdir(), 'deep-compare'));
if (!OLD || !MONTH) { console.error('--old と --month を指定してください（いちばん上の使い方を見てください）'); process.exit(2); }
const name = path.basename(MONTH, '.json');
fs.mkdirSync(OUTDIR, { recursive: true });

function ctxOf(root, raw) {   // その版の検査・並べ方
  const c = { console: { log() {}, warn() {}, error() {} } }; c.globalThis = c; c.self = c; c.window = c; vm.createContext(c);
  ['data.js', 'optimizer.js'].forEach(f => vm.runInContext(fs.readFileSync(path.resolve(root, 'js', f), 'utf8'), c, { filename: f }));
  c.__raw = raw; vm.runInContext('applyAppData(normalizeAppData(__raw)); _shiftKeysCache = null;', c); return c;
}
function runVersion(label, root, round) {
  const dir = path.join(OUTDIR, `${name}_${label}_${round}`); fs.mkdirSync(dir, { recursive: true });
  const kids = [0, 1, 2, 3].map(v => new Promise(res => {
    const out = path.join(dir, `way${v}.json`);
    const p = cp.spawn(process.execPath, [__filename, '--child', path.resolve(root), path.resolve(MONTH), MODE, String(v), out], { stdio: 'inherit' });
    p.on('exit', () => res(fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { v, error: '結果がありません' }));
  }));
  return Promise.all(kids);
}
function summarize(root, raw, ways) {
  const c = ctxOf(root, raw);
  if (ways.some(w => w.error || !w.violations)) return { error: ways.map(w => w.error).filter(Boolean).join(' / ') };
  c.__a = ways.map(w => w.violations);
  const s = vm.runInContext(`__a.map(vs => { const r = scoreViolations(vs); const t = {}; vs.forEach(v => { t[v.type] = (t[v.type] || 0) + 1; });
    return { sc: r, comp: r.comp, under: r.under, must: r.must - r.comp, soft: r.soft, types: t }; })`, c);
  c.__s = s;
  const best = vm.runInContext('__s.map((x, i) => i).sort((i, j) => scoreCompare(__s[i].sc, __s[j].sc) || i - j)[0]', c);
  return { best, ways: s, ctx: c };
}
const fmt = b => `⛔${b.comp} 人員不足${b.under} 絶対${b.must} できれば${b.soft}`;
(async () => {
  const raw = JSON.parse(fs.readFileSync(MONTH, 'utf8'));
  let worse = 0, better = 0, same = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const res = {};
    for (const [label, root] of [['old', OLD], ['new', NEW]]) {
      const t0 = Date.now(); const ways = await runVersion(label, root, r);
      res[label] = summarize(root, raw, ways); res[label].sec = Math.round((Date.now() - t0) / 1000);
    }
    if (res.old.error || res.new.error) { console.log(`${name} ${r}回目 失敗: 前 ${res.old.error || 'なし'} ／ 新 ${res.new.error || 'なし'}`); continue; }
    const o = res.old.ways[res.old.best], n = res.new.ways[res.new.best];
    res.new.ctx.__x = n.sc; res.new.ctx.__y = o.sc;
    const cmp = vm.runInContext('scoreCompare(__x, __y)', res.new.ctx);
    if (cmp > 0) worse++; else if (cmp < 0) better++; else same++;
    console.log(`${name} ${r}回目  前の版: 通り${res.old.best} ${fmt(o)}（${res.old.sec}秒）  新しい版: 通り${res.new.best} ${fmt(n)}（${res.new.sec}秒）  → ${cmp > 0 ? '新しい版が悪い' : cmp < 0 ? '新しい版が良い' : '同じ'}`);
    console.log(`   通りごと（⛔/人員不足/絶対/できれば）前: ${res.old.ways.map(fmtW).join('  ')}  新: ${res.new.ways.map(fmtW).join('  ')}`);
    console.log(`   選んだ答えの種類ごと 前: ${JSON.stringify(o.types)}`);
    console.log(`   選んだ答えの種類ごと 新: ${JSON.stringify(n.types)}`);
  }
  console.log(`${name}: ${ROUNDS}回のうち 新しい版が悪い ${worse}・良い ${better}・同じ ${same}`
    + (ROUNDS >= 3 ? (worse >= 2 ? '（3回中2回以上悪い → 決まりでは公開しない）' : '（ぶれと判断）') : ''));
  function fmtW(x) { return `${x.comp}/${x.under}/${x.must}/${x.soft}`; }
})();
