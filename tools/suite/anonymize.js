// 実データ（アプリの書き出しファイル）から、詰め合わせの土台を作る。
// 誰でも見られるリポジトリに入れるので、名前は A〜、メモ欄は空、ID は振り直す。
// 表（shifts）と保存日時は入れない。
// 使い方: node tools/suite/anonymize.js <書き出したファイル.json> <出力.json>
const fs = require('fs');
const [,, src, out] = process.argv;
const D = JSON.parse(fs.readFileSync(src, 'utf8'));
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const map = {};
D.staff.forEach((s, i) => { map[s.id] = 'S' + String(i + 1).padStart(3, '0'); });
const remapKeys = (o) => { const r = {}; for (const id in (o || {})) if (map[id]) r[map[id]] = o[id]; return r; };
const outD = {
  _app: 'shift-app', _version: 1,
  settings: D.settings, shiftTypes: D.shiftTypes,
  roleRequirements: D.roleRequirements, roleRequirementsCast: D.roleRequirementsCast || {},
  dailyRequirements: D.dailyRequirements || {}, dailyRequirementsCast: D.dailyRequirementsCast || {},
  skills: D.skills || [], dailySkills: D.dailySkills || {},
  staff: D.staff.map((s, i) => Object.assign({}, s, { id: map[s.id], name: L[i] || ('Z' + i), note: '' })),
  requests: remapKeys(D.requests), fixedShifts: remapKeys(D.fixedShifts),
  specialDays: D.specialDays || {},
  events: (D.events || []).map(e => Object.assign({}, e, { name: '行事', staffIds: (e.staffIds || []).map(id => map[id]).filter(Boolean) })),
};
// 念のため: 元の名前がどこにも残っていないか確かめる
const text = JSON.stringify(outD);
D.staff.forEach(s => { if (s.name && s.name.length > 1 && text.includes(s.name)) throw new Error('名前が残っています'); });
fs.writeFileSync(out, JSON.stringify(outD, null, 1));
console.log('書き出しました:', out, '（' + outD.staff.length + '人）');
