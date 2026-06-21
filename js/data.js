/* ===========================================
   data.js - データモデルと定数定義
   =========================================== */

// シフト種別の定義（出勤扱い）
const SHIFT_TYPES = {
  EARLY_RESP:  { key: '早責', label: '早番責任者', class: 's-early-resp',  category: 'early',   isResp: true,  isWork: true  },
  LATE_RESP:   { key: '遅責', label: '遅番責任者', class: 's-late-resp',   category: 'late',    isResp: true,  isWork: true  },
  EARLY_GEN:   { key: '早総務', label: '早番総務',   class: 's-early-gen',   category: 'early', isResp: false, isWork: true, isGeneral: true },
  LATE_GEN:    { key: '遅総務', label: '遅番総務',   class: 's-late-gen',    category: 'late',  isResp: false, isWork: true, isGeneral: true },
  EARLY:       { key: '早',   label: '早番',       class: 's-early',       category: 'early',   isResp: false, isWork: true  },
  LATE:        { key: '遅',   label: '遅番',       class: 's-late',        category: 'late',    isResp: false, isWork: true  },
  // 研修: 出勤扱いだが特殊カテゴリ（必要人数には含めない・公休にも含めない）
  TRAINING:    { key: '研',   label: '研修',       class: 's-training',    category: 'training', isResp: false, isWork: true, isTraining: true },
  // 夜勤: 翌日は必ず休み
  NIGHT:       { key: '夜勤', label: '夜勤',       class: 's-night',       category: 'night',    isResp: false, isWork: true, isNight: true },
};

// 休み記号の定義
const OFF_TYPES = {
  '休': { label: '公休',         class: 's-off',      isOff: true, isRequest: true },
  '公': { label: '公休',         class: 's-public',   isOff: true, isRequest: true },
  '有': { label: '有給',         class: 's-paid',     isOff: true, isRequest: true },
  '☆': { label: '希望休',        class: 's-off',      isOff: true, isRequest: true },
  '季': { label: '季節休暇',     class: 's-off',      isOff: true, isRequest: true },
  '引': { label: '引継',         class: 's-off',      isOff: true, isRequest: true },
  '慶': { label: '慶弔休',       class: 's-off',      isOff: true, isRequest: true },
};

// 役職タイプ（組織上の地位）
const POSITION_TYPES = {
  viceManager: { label: '副店長', priority: 1 },
  chief:       { label: 'チーフ', priority: 2 },
  leader:      { label: 'リーダー', priority: 3 },
  staff:       { label: 'スタッフ', priority: 4 },
};

// 役割タイプ（業務上の役割）→ 入れるシフト種別
const ROLE_TYPES = {
  responsible: { label: '責任者',       shifts: ['早責', '遅責'] },
  normal:      { label: '一般',         shifts: ['早', '遅'] },
  normalSales: { label: '一般（営業）', shifts: ['早', '遅'] },
  affairs:     { label: '総務',         shifts: ['早総務', '遅総務'] },
  nightShift:  { label: '夜勤',         shifts: ['夜勤'] },
};

// シフト希望の選択肢
const SHIFT_PREFS = ['早可', '遅可'];

// 早遅比率の選択肢
const SHIFT_BALANCE = {
  earlyHeavy:  { label: '早番多め', earlyRatio: 0.7, lateRatio: 0.3 },
  earlyMore:   { label: '早番やや多め', earlyRatio: 0.6, lateRatio: 0.4 },
  balanced:    { label: '均等',     earlyRatio: 0.5, lateRatio: 0.5 },
  lateMore:    { label: '遅番やや多め', earlyRatio: 0.4, lateRatio: 0.6 },
  lateHeavy:   { label: '遅番多め', earlyRatio: 0.3, lateRatio: 0.7 },
};

// アプリケーションの状態
const AppState = {
  settings: {
    targetMonth: '',  // YYYY-MM
    maxConsecutive: 4,  // 連勤上限
    forbidLateEarly: true,
    penaltySingleOff: true,
    maxAttempts: 100000,
  },
  // 役職マスター: 各日に必要な人数（デフォルト）
  roleRequirements: {
    '早責': 1,
    '遅責': 1,
    '早総務': 1,
    '遅総務': 1,
    '早':   2,
    '遅':   2,
    '夜勤': 0,
  },
  // 日別必要人数（上書き）: { day: { shiftKey: count } }
  dailyRequirements: {},
  // 役職カラー（カスタマイズ用）
  roleColors: {
    '早責': '#fde2e2',
    '遅責': '#d1c4e9',
    '早総務': '#fce4b6',
    '遅総務': '#c8e6c9',
    '早':   '#d4eaf7',
    '遅':   '#ffe0b2',
    '夜勤': '#263238',
  },
  // スタッフ: [{id, name, positionType, roleType, maxOff, prefs:[], prevConsecutive, note}]
  staff: [],
  // 希望休（手動入力）: { staffId: { day: '休' } }
  requests: {},
  // 生成結果: { staffId: { day: '早' } }
  shifts: {},
  // 手動固定シフト: { staffId: { day: '早責' } } - 最適化で変更しない
  fixedShifts: {},
  // 特別日設定: { day: 'replacement' | 'renewal' }
  specialDays: {},
  // ルール違反: [{ staffId, day, type, message, action }]
  violations: [],
  // 生成済みフラグ
  generated: false,
};

let _staffIdCounter = 1;

function newStaffId() {
  return 'S' + (_staffIdCounter++).toString().padStart(3, '0');
}

function getDaysInMonth(yearMonth) {
  if (!yearMonth) return 31;
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function getWeekday(yearMonth, day) {
  if (!yearMonth) return 0;
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m - 1, day).getDay(); // 0=日, 6=土
}

function getWeekdayLabel(w) {
  return ['日', '月', '火', '水', '木', '金', '土'][w];
}

// シフト記号 → クラス
function getShiftClass(shift) {
  if (!shift) return 's-empty';
  if (SHIFT_TYPES[shiftKeyToEnum(shift)]) {
    return SHIFT_TYPES[shiftKeyToEnum(shift)].class;
  }
  if (OFF_TYPES[shift]) return OFF_TYPES[shift].class;
  return 's-empty';
}

function shiftKeyToEnum(key) {
  for (const [k, v] of Object.entries(SHIFT_TYPES)) {
    if (v.key === key) return k;
  }
  return null;
}

function isOff(shift) {
  return !!OFF_TYPES[shift];
}

function isWork(shift) {
  return !!shiftKeyToEnum(shift);
}

function isEarly(shift) {
  const enumKey = shiftKeyToEnum(shift);
  if (!enumKey) return false;
  return SHIFT_TYPES[enumKey].category === 'early';
}

function isLate(shift) {
  const enumKey = shiftKeyToEnum(shift);
  if (!enumKey) return false;
  return SHIFT_TYPES[enumKey].category === 'late';
}

// 研修判定
function isTraining(shift) {
  return shift === '研';
}

// 夜勤判定
function isNight(shift) {
  return shift === '夜勤';
}

// 日別必要人数（日ごとの上書き → なければデフォルト）
function getDayReq(d, k) {
  const dr = AppState.dailyRequirements;
  if (dr && dr[d] && dr[d][k] !== undefined) return dr[d][k];
  return AppState.roleRequirements[k] || 0;
}

// 通常の必要人数カウント対象シフトか（研修は除外）
function isCountableWork(shift) {
  return isWork(shift) && !isTraining(shift);
}

// 早番扱い（研修も早番時間帯のため早番カテゴリに含める）
function isEarlyCategory(shift) {
  return isEarly(shift) || isTraining(shift);
}

// 連続シフトの時間帯判定
function getShiftCategory(shift) {
  if (isNight(shift)) return 'night';
  if (isLate(shift)) return 'late';
  if (isEarlyCategory(shift)) return 'early';
  return null;
}

// ローカルストレージ保存/読込
function saveToStorage() {
  try {
    const data = {
      version: 3,
      settings: AppState.settings,
      roleRequirements: AppState.roleRequirements,
      dailyRequirements: AppState.dailyRequirements,
      roleColors: AppState.roleColors,
      staff: AppState.staff,
      requests: AppState.requests,
      shifts: AppState.shifts,
      fixedShifts: AppState.fixedShifts,
      specialDays: AppState.specialDays,
      violations: AppState.violations,
      generated: AppState.generated,
      _staffIdCounter,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem('shiftAppData', JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('保存エラー', e);
    return false;
  }
}

function loadFromStorage() {
  const raw = localStorage.getItem('shiftAppData');
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    Object.assign(AppState.settings, data.settings || {});
    Object.assign(AppState.roleRequirements, data.roleRequirements || {});
    AppState.dailyRequirements = data.dailyRequirements || {};
    Object.assign(AppState.roleColors, data.roleColors || {});
    AppState.staff = (data.staff || []).map(s => ({
      // 古いデータとの下位互換のためデフォルトを補完
      id: s.id,
      name: s.name || '',
      positionType: s.positionType || 'staff',
      roleType: s.roleType || 'normal',
      maxOff: s.maxOff != null ? s.maxOff : 9,
      prefs: Array.isArray(s.prefs) ? s.prefs : ['早可', '遅可'],
      balance: s.balance || 'balanced',
      prevConsecutive: s.prevConsecutive || 0,
      prevLastShift: s.prevLastShift || '',
      note: s.note || '',
    }));
    AppState.requests = data.requests || {};
    AppState.shifts = data.shifts || {};
    AppState.fixedShifts = data.fixedShifts || {};
    AppState.specialDays = data.specialDays || {};
    AppState.violations = data.violations || [];
    AppState.generated = data.generated === true;
    _staffIdCounter = data._staffIdCounter || (AppState.staff.length + 1);
    return true;
  } catch (e) {
    console.error('読込エラー', e);
    return false;
  }
}

function resetAll() {
  AppState.staff = [];
  AppState.requests = {};
  AppState.shifts = {};
  AppState.fixedShifts = {};
  AppState.specialDays = {};
  AppState.violations = [];
  AppState.generated = false;
  _staffIdCounter = 1;
  localStorage.removeItem('shiftAppData');
}

// 初期スタッフ（サンプル）
function addSampleStaff() {
  const samples = [
    { name: '田中 太郎',   positionType: 'viceManager', roleType: 'responsible', maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
    { name: '佐藤 花子',   positionType: 'chief',       roleType: 'responsible', maxOff: 9, prefs: ['早可', '遅可'], balance: 'earlyMore' },
    { name: '鈴木 一郎',   positionType: 'chief',       roleType: 'affairs',     maxOff: 9, prefs: ['早可', '遅可'], balance: 'lateMore' },
    { name: '高橋 美咲',   positionType: 'leader',      roleType: 'affairs',     maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
    { name: '伊藤 健太',   positionType: 'leader',      roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'earlyHeavy' },
    { name: '渡辺 由美',   positionType: 'leader',      roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'lateHeavy' },
    { name: '山本 拓也',   positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
    { name: '中村 さくら', positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'earlyMore' },
    { name: '小林 健',     positionType: 'staff',       roleType: 'normalSales', maxOff: 9, prefs: ['早可', '遅可'], balance: 'lateMore' },
    { name: '加藤 真理',   positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可'],         balance: 'earlyHeavy' },
    { name: '吉田 翔',     positionType: 'staff',       roleType: 'normalSales', maxOff: 9, prefs: ['遅可'],         balance: 'lateHeavy' },
    { name: '山田 恵子',   positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
    { name: '松本 大輔',   positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
    { name: '井上 千秋',   positionType: 'staff',       roleType: 'normal',      maxOff: 9, prefs: ['早可', '遅可'], balance: 'balanced' },
  ];
  samples.forEach(s => {
    AppState.staff.push({
      id: newStaffId(),
      name: s.name,
      positionType: s.positionType,
      roleType: s.roleType,
      maxOff: s.maxOff,
      prefs: s.prefs,
      balance: s.balance || 'balanced',
      prevConsecutive: 0,
      prevLastShift: '',  // 前月末最終勤務日のシフトカテゴリ ('' | '早' | '遅')
      note: '',
    });
  });
}
