// 試験用の月の詰め合わせを作る（すべて作り物）。
// 本物の希望・勤務・スタッフ構成は使わない（名前を伏せても、役職・担当・スキルの組み合わせで
// 誰の希望か分かってしまうため。CLAUDE.md「個人情報を公開リポジトリに入れない」）。
// 店の決まり（シフトの種類・必要人数・設定の既定）は、アプリの既定値（js/data.js）を使う。
// スタッフ・担当・スキル・希望（休・シフトの種類・半休・有給・研修）・前月末・有給の日数・🔒固定は、
// 乱数（種を固定）ででたらめに作る。何度作っても同じものができる。
//
// 変える条件（直交表 L18 で、どの2つの条件の組み合わせも少なくとも1回は出る18通り）:
//   日数       31日（10月）/ 30日（11月）
//   希望の量   少 / 普通 / 多
//   スキル     早番 / 遅番 / 早番と遅番の両方
//   人手       余裕 / ぎりぎり / 不足
//   特別日     無し / 普通 / 多
//   半休・有給 少 / 普通 / 多
//   乱数の種   3通り
// 使い方: node tools/suite/make_suite.js [出力フォルダ]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OUT = process.argv[2] || path.join(__dirname, 'cases');

// アプリの既定値（店の決まり）を読む
const ctx = { console }; ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'data.js'), 'utf8'), ctx);
const DEF = JSON.parse(JSON.stringify(vm.runInContext('AppState', ctx)));

const L18 = [
  [1,1,1,1,1,1,1],[1,1,2,2,2,2,2],[1,1,3,3,3,3,3],
  [1,2,1,1,2,2,3],[1,2,2,2,3,3,1],[1,2,3,3,1,1,2],
  [1,3,1,2,1,3,2],[1,3,2,3,2,1,3],[1,3,3,1,3,2,1],
  [2,1,1,3,3,2,2],[2,1,2,1,1,3,3],[2,1,3,2,2,1,1],
  [2,2,1,2,3,1,3],[2,2,2,3,1,2,1],[2,2,3,1,2,3,2],
  [2,3,1,3,2,3,1],[2,3,2,1,3,1,2],[2,3,3,2,1,2,3],
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
const daysOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

function makeCase(row, idx) {
  const [fDays, fReq, fSkill, fStaff, fSp, fHp, fSeed] = row;
  const R = rng(9973 * (idx + 1) + 131 * fSeed);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const between = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const month = fDays === 1 ? '2026-10' : '2026-11';
  const N = daysOf(month);

  // スタッフ: 役職の人数も担当も、毎回でたらめに作る（人手の条件で人数を変える）
  const nStaff = { 1: between(13, 14), 2: 12, 3: 11 }[fStaff];   // 既定の必要人数は1日8人
  const roleOf = (i) => i < between(1, 2) ? 'viceManager' : (i < 4 ? pick(['chief', 'leader']) : (R() < 0.8 ? 'leader' : 'staff'));
  const ALLOW = {
    viceManager: [['早責', '遅責'], ['早責', '遅責', '早総務'], ['早責', '遅責', '遅総務']],
    chief:       [['早責', '遅責', '早総務', '遅総務'], ['早責', '遅責'], ['早責', '早総務', '遅総務', '早']],
    leader:      [['早', '遅'], ['早', '遅', '早総務'], ['早', '遅', '遅総務'], ['早総務', '遅総務', '早', '遅'], ['早', '早総務']],
    staff:       [['早', '遅'], ['遅'], ['早']],
  };
  const skillName = '営業';
  const staff = [];
  const usedIds = new Set();
  for (let i = 0; i < nStaff; i++) {
    const pos = roleOf(i);
    let n; do { n = 100 + Math.floor(R() * 900); } while (usedIds.has(n)); usedIds.add(n);
    staff.push({
      id: 'S' + n, name: String.fromCharCode(65 + i), department: 'employee', positionType: pos,
      allowedShifts: pick(ALLOW[pos]).slice(), maxOff: N === 31 ? 9 : 9, paidLeave: between(0, 2),
      prefs: [], balance: 'off', prevConsecutive: between(0, 4), prevLastShift: pick(['', '', '早', '遅']),
      note: '', skills: R() < 0.5 ? [skillName] : [], personalMaxCons: 0, personalMaxOff: 0,
      needPairRest: false, weekendPref: '', restStyle: '', pairRestTarget: 0,
    });
  }
  // 並び順もでたらめにする
  for (let i = staff.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [staff[i], staff[j]] = [staff[j], staff[i]]; }
  staff.forEach((s, i) => { s.name = String.fromCharCode(65 + i); });

  // 希望: 休・シフトの種類・半休・有給・研修を、でたらめな日に置く
  const requests = {}, fixedShifts = {};
  const reqMul = { 1: 0.5, 2: 1, 3: 1.5 }[fReq];
  const hpMul = { 1: 0, 2: 1, 3: 1.5 }[fHp];
  const put = (id, d, v) => { requests[id] = requests[id] || {}; if (!requests[id][d]) { requests[id][d] = v; return true; } return false; };
  staff.forEach(s => {
    const nOff = Math.max(2, Math.round(between(2, 6) * reqMul)), nKind = Math.round(between(0, 3) * reqMul);
    for (let k = 0, t = 0; k < nOff && t < 60; t++) if (put(s.id, String(between(1, N)), '休')) k++;
    for (let k = 0, t = 0; k < nKind && t < 60; t++) if (put(s.id, String(between(1, N)), pick(s.allowedShifts))) k++;
    const nHalf = Math.round((R() < 0.3 ? 1 : 0) * hpMul);
    for (let k = 0, t = 0; k < nHalf && t < 60; t++) if (put(s.id, String(between(1, N)), '半')) k++;
    const nPaid = Math.round(s.paidLeave * hpMul);
    for (let k = 0, t = 0; k < nPaid && t < 60; t++) if (put(s.id, String(between(1, N)), '有')) k++;
    if (fHp === 3) s.paidLeave += 1;
    if (R() < 0.15) put(s.id, String(between(1, N)), '研');
  });
  // 🔒固定: 数人に1〜2マス
  staff.forEach(s => { if (R() < 0.3) { const d = String(between(1, N)); if (!(requests[s.id] || {})[d]) { fixedShifts[s.id] = { [d]: pick(s.allowedShifts) }; } } });

  // スキルの時間帯
  const skills = [];
  if (fSkill === 1) skills.push({ name: skillName, target: 'early', req: 2, min: 1 });
  else if (fSkill === 2) skills.push({ name: skillName, target: 'late', req: 2, min: 1 });
  else {
    skills.push({ name: skillName, target: 'early', req: 1, min: 1 });
    skills.push({ name: skillName + '（遅）', target: 'late', req: 1, min: 1 });
    staff.forEach(s => { if (s.skills.includes(skillName)) s.skills.push(skillName + '（遅）'); });
  }

  // 特別日
  const specialDays = {};
  const nSp = { 1: 0, 2: 1, 3: 3 }[fSp];
  for (let k = 0, t = 0; k < nSp && t < 50; t++) {
    const d = between(2, N - 1);
    if (specialDays[d] || specialDays[d + 1]) continue;
    specialDays[d] = 'replacement'; specialDays[d + 1] = 'renewal'; k++;
  }

  const settings = Object.assign({}, DEF.settings, {
    targetMonth: month,
    ruleLevels: { 'vicemanager-absent': 'off', 'skill-short': 'must', 'long-rest': 'must', 'pref-mismatch': 'off',
                  'rest-style': 'off', 'pair-rest': 'off', 'pair-rest-count': 'off', 'weekend-pref': 'off', overstaff: 'must' },
  });
  const tag = [NAMES.days[fDays - 1], NAMES.req[fReq - 1], NAMES.skill[fSkill - 1], NAMES.staff[fStaff - 1],
               NAMES.sp[fSp - 1], NAMES.hp[fHp - 1], '種' + fSeed].join('・');
  return {
    _app: 'shift-app', _version: 1, _suite: { id: 'case' + String(idx + 1).padStart(2, '0'), tag, synthetic: true },
    settings, shiftTypes: DEF.shiftTypes, roleRequirements: DEF.roleRequirements, roleRequirementsCast: DEF.roleRequirementsCast || {},
    dailyRequirements: {}, dailyRequirementsCast: {}, skills, dailySkills: {},
    staff, requests, fixedShifts, specialDays, events: [],
  };
}

fs.mkdirSync(OUT, { recursive: true });
L18.forEach((row, i) => {
  const D = makeCase(row, i);
  fs.writeFileSync(path.join(OUT, D._suite.id + '.json'), JSON.stringify(D));
  console.log(D._suite.id, D._suite.tag, `${D.staff.length}人`);
});
