// 試験用の月の詰め合わせを作る（名前を伏せた土台 base.json から、条件を少しずつ変える）。
// 土台は実際の希望をそのまま使っているので、リポジトリには入れない（.gitignore）。
// 入れるのは、条件を変え、スタッフの並び順と ID をばらばらにした18通りだけ。
// 特定の月に合わせた直しにならないよう、直しはこの詰め合わせ全部で悪くならないことを
// 確かめてから入れる（CLAUDE.md「測り方」）。
//
// 変える条件（直交表 L18 で、どの2つの条件の組み合わせも少なくとも1回は出る18通り）:
//   日数       31日 / 30日
//   希望の量   少（休み・種類の希望を半分）/ 普通 / 多（1.5倍）
//   スキル     早番 / 遅番 / 早番と遅番の両方
//   人手       余裕（+1人）/ ぎりぎり（そのまま）/ 不足（-1人）
//   特別日     無し / 普通 / 多（+4日）
//   半休・有給 少（無し）/ 普通 / 多（1.5倍・有給日数+1）
//   並べ替え   希望を足す・減らす日の選び方（乱数の種）
// 乱数の種は固定なので、何度作っても同じものができる。
// 使い方: node tools/suite/make_suite.js [土台.json] [出力フォルダ]
//   土台は anonymize.js で手元に作る（リポジトリには無い）。
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || path.join(__dirname, 'base.json');
const OUT = process.argv[3] || path.join(__dirname, 'cases');

// L18（2^1 × 3^7）。列: 日数, 希望, スキル, 人手, 特別日, 半休有給, 種, (予備)
const L18 = [
  [1,1,1,1,1,1,1,1],[1,1,2,2,2,2,2,2],[1,1,3,3,3,3,3,3],
  [1,2,1,1,2,2,3,3],[1,2,2,2,3,3,1,1],[1,2,3,3,1,1,2,2],
  [1,3,1,2,1,3,2,3],[1,3,2,3,2,1,3,1],[1,3,3,1,3,2,1,2],
  [2,1,1,3,3,2,2,1],[2,1,2,1,1,3,3,2],[2,1,3,2,2,1,1,3],
  [2,2,1,2,3,1,3,2],[2,2,2,3,1,2,1,3],[2,2,3,1,2,3,2,1],
  [2,3,1,3,2,3,1,2],[2,3,2,1,3,1,2,3],[2,3,3,2,1,2,3,1],
];
const NAMES = {
  days: ['31日', '30日'], req: ['希望少', '希望普通', '希望多'], skill: ['スキル早', 'スキル遅', 'スキル両方'],
  staff: ['人手余裕', '人手ぎりぎり', '人手不足'], sp: ['特別日無', '特別日普通', '特別日多'], hp: ['半有少', '半有普通', '半有多'],
};

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const daysOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const isRest = (v) => v === '休' || v === '公';
const isHalfOrPaid = (v) => v === '半' || v === '有';

function makeCase(base, row, idx) {
  const [fDays, fReq, fSkill, fStaff, fSp, fHp, fSeed] = row;
  const D = clone(base);
  const R = rng(1000 * idx + 17 * fSeed);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];

  // 日数: 30日の月にする（31日の希望・固定・特別日・日ごとの必要人数を落とす）
  if (fDays === 2) {
    D.settings.targetMonth = '2026-11';
    const drop31 = (o) => { for (const k in (o || {})) delete (o[k] || {})['31']; };
    drop31(D.requests); drop31(D.fixedShifts); drop31(D.dailyRequirements); drop31(D.dailyRequirementsCast);
    drop31(D.dailySkills); delete D.specialDays['31'];
    D.events = (D.events || []).filter(e => e.day <= 30);
  }
  const N = daysOf(D.settings.targetMonth);

  // 人手: 余裕は1人足す（リーダーの写し）、不足は1人減らす（役職のない人から）
  if (fStaff === 1) {
    const src = D.staff.find(s => s.positionType === 'leader') || D.staff[D.staff.length - 1];
    const id = 'S' + String(D.staff.length + 1).padStart(3, '0');
    D.staff.push(Object.assign(clone(src), { id, name: String.fromCharCode(65 + D.staff.length), note: '' }));
  } else if (fStaff === 3) {
    const cand = D.staff.filter(s => s.positionType === 'leader' || s.positionType === 'staff');
    const gone = cand[cand.length - 1];
    D.staff = D.staff.filter(s => s.id !== gone.id);
    ['requests', 'fixedShifts'].forEach(k => { delete D[k][gone.id]; });
    D.events = (D.events || []).map(e => Object.assign({}, e, { staffIds: (e.staffIds || []).filter(x => x !== gone.id) }));
  }

  // 希望の量: 休み・シフトの種類の希望（半休・有給・研修は別）を半分にする／1.5倍にする
  const reqCells = [];
  D.staff.forEach(s => { const r = D.requests[s.id] || {};
    for (const d in r) if (!isHalfOrPaid(r[d]) && r[d] !== '研') reqCells.push([s.id, d]); });
  if (fReq === 1) {
    reqCells.forEach(([id, d]) => { if (R() < 0.5) delete D.requests[id][d]; });
  } else if (fReq === 3) {
    const add = Math.round(reqCells.length * 0.5);
    for (let k = 0, tries = 0; k < add && tries < add * 20; tries++) {
      const s = pick(D.staff), d = String(1 + Math.floor(R() * N));
      D.requests[s.id] = D.requests[s.id] || {};
      if (D.requests[s.id][d] || (D.fixedShifts[s.id] || {})[d]) continue;
      // 休みの希望を多めに、ときどき担当できるシフトの種類の希望
      const kinds = (s.allowedShifts || []).filter(x => x !== '研');
      D.requests[s.id][d] = (R() < 0.7 || !kinds.length) ? '休' : pick(kinds);
      k++;
    }
  }

  // 半休・有給: 少は無し、多は1.5倍（有給は有給日数も+1）
  const hpCells = [];
  D.staff.forEach(s => { const r = D.requests[s.id] || {}; for (const d in r) if (isHalfOrPaid(r[d])) hpCells.push([s.id, d, r[d]]); });
  if (fHp === 1) {
    hpCells.forEach(([id, d, v]) => { delete D.requests[id][d]; if (v === '有') { const s = D.staff.find(x => x.id === id); if (s) s.paidLeave = Math.max(0, (parseInt(s.paidLeave) || 0) - 1); } });
  } else if (fHp === 3) {
    const add = Math.max(2, Math.round(hpCells.length * 0.5));
    for (let k = 0, tries = 0; k < add && tries < add * 20; tries++) {
      const s = pick(D.staff), d = String(1 + Math.floor(R() * N));
      D.requests[s.id] = D.requests[s.id] || {};
      if (D.requests[s.id][d] || (D.fixedShifts[s.id] || {})[d]) continue;
      const v = R() < 0.5 ? '半' : '有';
      D.requests[s.id][d] = v;
      if (v === '有') s.paidLeave = (parseInt(s.paidLeave) || 0) + 1;
      k++;
    }
  }

  // スキルの時間帯: 早番 / 遅番 / 早番と遅番の両方（同じ人数を2つに分ける）
  if (D.skills && D.skills.length) {
    const sk = D.skills[0];
    if (fSkill === 1) sk.target = 'early';
    else if (fSkill === 2) sk.target = 'late';
    else {
      const half = Math.max(1, Math.floor((sk.req || 2) / 2));
      sk.target = 'early'; sk.req = half; sk.min = Math.min(sk.min || half, half);
      D.skills.push(Object.assign(clone(sk), { name: sk.name + '（遅）', target: 'late' }));
      D.staff.forEach(s => { if ((s.skills || []).includes(sk.name)) s.skills = s.skills.concat([sk.name + '（遅）']); });
      D.dailySkills = D.dailySkills || {}; D.dailySkills[sk.name + '（遅）'] = {};
    }
  }

  // 特別日: 無し / 普通 / 多（入れ替え日と新装日を2組足す）
  if (fSp === 1) D.specialDays = {};
  else if (fSp === 3) {
    for (let k = 0, tries = 0; k < 2 && tries < 50; tries++) {
      const d = 2 + Math.floor(R() * (N - 2));
      if (D.specialDays[d] || D.specialDays[d + 1]) continue;
      D.specialDays[d] = 'replacement'; D.specialDays[d + 1] = 'renewal'; k++;
    }
  }

  shuffleStaff(D, rng(7919 * (idx + 1) + 31));

  const tag = [NAMES.days[fDays - 1], NAMES.req[fReq - 1], NAMES.skill[fSkill - 1], NAMES.staff[fStaff - 1],
               NAMES.sp[fSp - 1], NAMES.hp[fHp - 1], '種' + fSeed].join('・');
  D._suite = { id: 'case' + String(idx + 1).padStart(2, '0'), tag };
  return D;
}

// スタッフの並び順と ID をばらばらにする（通しごとに別の並び）。並び順と役職がそのままだと、
// お店の人が見れば誰の希望か分かるため。名前は並べ替えたあとの順に A〜 を振り直し、
// ID は並びと関係のない番号にする。希望・固定・行事の ID も付け替える。
// 同じ役職の人どうしが入れ替わっただけだと役職の並びが元のままになるので、
// 半分以上の位置で役職が元と違うまで並べ直す。
function shuffleStaff(D, R) {
  const role = (s) => s.positionType + '/' + s.department;
  const orig = D.staff.map(role);
  let order;
  for (let tries = 0; tries < 1000; tries++) {
    order = D.staff.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1)); [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.filter((s, i) => role(s) !== orig[i]).length * 2 >= order.length) break;
  }
  const used = new Set(), map = {};
  order.forEach(s => {
    let n; do { n = 100 + Math.floor(R() * 900); } while (used.has(n));
    used.add(n); map[s.id] = 'S' + n;
  });
  const remap = (o) => { const r = {}; for (const id in (o || {})) if (map[id]) r[map[id]] = o[id]; return r; };
  D.requests = remap(D.requests);
  D.fixedShifts = remap(D.fixedShifts);
  D.events = (D.events || []).map(e => Object.assign({}, e, { staffIds: (e.staffIds || []).map(id => map[id]).filter(Boolean) }));
  D.staff = order.map((s, i) => Object.assign({}, s, { id: map[s.id], name: String.fromCharCode(65 + i), note: '' }));
}

const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
L18.forEach((row, i) => {
  const D = makeCase(base, row, i);
  fs.writeFileSync(path.join(OUT, D._suite.id + '.json'), JSON.stringify(D));
  console.log(D._suite.id, D._suite.tag);
});
