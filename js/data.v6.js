/* ===========================================
   data.js - データモデルと定数定義
   =========================================== */

// 休み記号（固定）
// countsAsPublic: 公休数（maxOff目標）にカウントするか。有給・季節休暇などは公休とは別枠。
const OFF_TYPES = {
  '休': { label: '公休',     class: 's-off',    isOff: true, countsAsPublic: true  },
  '公': { label: '公休',     class: 's-public', isOff: true, countsAsPublic: true  },
  '有': { label: '有給',     class: 's-paid',   isOff: true, countsAsPublic: false },
  '半': { label: '半休',     class: 's-half',   isOff: true,  countsAsPublic: false }, // 半休（休み扱い・公休にはカウントしない。集計は有給他に含む）
  '余': { label: '余剰',     class: 's-surplus',isOff: true,  countsAsPublic: false }, // 人員余剰による休み（公休・有給とは別枠）
  '☆': { label: '希望休',   class: 's-off',    isOff: true, countsAsPublic: true  },
  '季': { label: '季節休暇', class: 's-off',    isOff: true, countsAsPublic: false },
  '引': { label: '引継',     class: 's-off',    isOff: true, countsAsPublic: false },
  '慶': { label: '慶弔休',   class: 's-off',    isOff: true, countsAsPublic: false },
};

// 部門（社員 / キャスト）
const DEPARTMENTS = {
  employee: { label: '社員'     },
  cast:     { label: 'キャスト' },
};

// 役職タイプ（副店長の常勤ロジック等で使用）
const POSITION_TYPES = {
  viceManager: { label: '副店長', priority: 1 },
  chief:       { label: 'チーフ', priority: 2 },
  leader:      { label: 'リーダー', priority: 3 },
  staff:       { label: 'スタッフ', priority: 4 },
};

// 早遅バランス比率
const SHIFT_BALANCE = {
  earlyHeavy: { label: '早番多め',     earlyRatio: 0.7, lateRatio: 0.3 },
  earlyMore:  { label: '早番やや多め', earlyRatio: 0.6, lateRatio: 0.4 },
  balanced:   { label: '均等',         earlyRatio: 0.5, lateRatio: 0.5 },
  lateMore:   { label: '遅番やや多め', earlyRatio: 0.4, lateRatio: 0.6 },
  lateHeavy:  { label: '遅番多め',     earlyRatio: 0.3, lateRatio: 0.7 },
};

// カテゴリ希望（早可 = カテゴリA可、遅可 = カテゴリB可）
const SHIFT_PREFS = ['早可', '遅可'];

// ---- 旧データ互換用 ROLE_TYPES（loadFromStorage のマイグレーションのみで使用） ----
const _LEGACY_ROLE_SHIFTS = {
  responsible: ['早責', '遅責'],
  normal:      ['早', '遅'],
  normalSales: ['早', '遅'],
  affairs:     ['早総務', '遅総務'],
};

// デフォルトのシフト種別（ユーザーが自由に追加・編集・削除可能）
// workHours: 1コマあたりの労働時間（総労働時間の集計に使用）
function getDefaultShiftTypes() {
  return [
    { key: '早責',  label: '早番責任者', color: '#fde2e2', category: 'A', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '遅責',  label: '遅番責任者', color: '#d1c4e9', category: 'B', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '早総務', label: '早番総務',  color: '#fce4b6', category: 'A', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '遅総務', label: '遅番総務',  color: '#c8e6c9', category: 'B', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '早',    label: '早番',       color: '#d4eaf7', category: 'A', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '遅',    label: '遅番',       color: '#ffe0b2', category: 'B', countForStaff: true,  isTraining: false, isNight: false, workHours: 8 },
    { key: '研',    label: '研修',       color: '#e0f7fa', category: 'A', countForStaff: false, isTraining: true,  isNight: false, workHours: 8 },
  ];
}

// デフォルトのペナルティ重み
const DEFAULT_PENALTIES = {
  understaff:      10000,  // 人員不足（1人あたり）
  overstaff:        6000,  // 人員超過（1人あたり）— 【優先1: 定数厳守】超えたら強く回避、余った人は「余」に
  respDuplicate:    8000,  // 責任者重複（早責/遅責が同じ時間帯に2人以上）
  disallowedShift: 50000,  // 担当外シフト
  consBase:         2500,  // 連勤超過（1日超過あたり）— 残存違反ゼロを目指し強化
  consSq:            500,  // 連勤超過（二乗項）
  lateEarly:        2500,  // 遅→早インターバル不足
  categorySwitch:   3000,  // 連勤中の時間帯切替（早→遅など）
  badRest:          2500,  // 遅→休→早（リズム悪）
  singleOff:          50,  // 単発休み
  singleWork:       2500,  // 単発出勤 — 残存違反の最多要因のため強化
  offShortage:       4000,  // 公休不足（1日あたり）— 【優先2】設定した公休は必ず消化させる
  longRest:          2000,  // 4連休以上（自動配置分）— 【優先3】連休は最大3日まで
  offSurplus:         400,  // 公休余剰（未使用 — tryConvertSurplusRest ムーブで自然削減）
  balanceDiff:         80,  // 早遅バランスずれ（1日あたり）
  viceManagerRest:   1200,  // 副店長が任意で休む
  viceManagerDailyAbsent: 9000, // その日、副店長が1人も出勤していない（毎日1人は必須）
  hierarchyViolation: 3000, // 責任者ヒエラルキー違反（より上位者が働いているのに下位者が責任者）
  prefMismatch:      12000, // prefs希望違反（早可/遅可 に反するシフト）
  eventAbsent:       20000, // イベント日に対象スタッフが休んでいる
  restPairBonus:       100, // 2連休以上のまとまった休みへのボーナス（スコアから減算）
  nightAfterWork:     8000, // 夜勤翌日に休みでない（夜勤明けは必ず休み）
  skillLateShortage:  9000, // 遅番に必要スキル保有者が不足（1人あたり）
  bandConcentration:   700, // 早番・遅番の片寄せ（少ない方の時間帯の日数×。切替を根本から減らす）
};

// アプリケーションの状態
const AppState = {
  settings: {
    targetMonth: '',
    maxConsecutive: 4,
    forbidLateEarly: true,
    penaltySingleOff: true,
    maxAttempts: 250000,
    penalties: { ...DEFAULT_PENALTIES },
  },
  // ユーザーが自由に定義・編集できるシフト種別
  shiftTypes: getDefaultShiftTypes(),
  // シフト種別ごとの1日の必要人数 { shiftKey: 人数 }（社員部門）
  roleRequirements: {
    '早責': 1, '遅責': 1, '早総務': 1, '遅総務': 1, '早': 2, '遅': 2,
  },
  // キャスト部門の1日の必要人数 { shiftKey: 人数 }
  roleRequirementsCast: {},
  // 日別必要人数（上書き設定）{ shiftKey: { day: 人数 } } 空なら roleRequirements を使用
  dailyRequirements: {},
  // キャスト部門の日別必要人数
  dailyRequirementsCast: {},
  // スキル要件 [{ name: '営業', lateReq: 2 }] — 遅番にそのスキル保有者が lateReq 人以上必要
  skills: [],
  // スタッフ一覧
  // 各スタッフ: { id, name, department, positionType, allowedShifts[], maxOff, prefs[], balance, prevConsecutive, prevLastShift, note }
  staff: [],
  requests:    {},  // 希望休 { staffId: { day: '休' } }
  shifts:      {},  // 生成結果 { staffId: { day: '早' } }
  fixedShifts: {},  // 手動固定 { staffId: { day: '早責' } }
  specialDays: {},  // 特別日 { day: 'replacement' | 'renewal' }
  events:      [],  // 行事 [{ day, name, staffIds: [] }] — 対象スタッフはその日必ず出勤
  violations:  [],
  generated:   false,
};

let _staffIdCounter = 1;
function newStaffId() {
  return 'S' + (_staffIdCounter++).toString().padStart(3, '0');
}

// ===== ユーティリティ =====

function getDaysInMonth(yearMonth) {
  if (!yearMonth) return 31;
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function getWeekday(yearMonth, day) {
  if (!yearMonth) return 0;
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m - 1, day).getDay();
}

function getWeekdayLabel(w) {
  return ['日', '月', '火', '水', '木', '金', '土'][w];
}

// シフト種別オブジェクトを取得（動的）
function getShiftType(shift) {
  return AppState.shiftTypes.find(t => t.key === shift) || null;
}

function isWork(shift) {
  return AppState.shiftTypes.some(t => t.key === shift);
}

function isOff(shift) {
  return !!OFF_TYPES[shift];
}

// 公休数（maxOff目標）にカウントされる休みか（有給・季節休暇などは対象外）
function isPublicOff(shift) {
  const t = OFF_TYPES[shift];
  return t ? !!t.countsAsPublic : false;
}

// 1コマあたりの労働時間（未設定シフトは8h扱い）
function getShiftHours(shift) {
  const t = getShiftType(shift);
  if (!t) return 0;
  return t.workHours != null ? Number(t.workHours) : 8;
}

// スタッフの部門（未設定は社員）
function getStaffDepartment(s) {
  return s.department === 'cast' ? 'cast' : 'employee';
}

// 部門ごとのグループ（スタッフが存在する部門のみ返す）
function getDepartmentGroups(staffList) {
  const all = staffList || AppState.staff;
  const groups = [];
  const emp  = all.filter(s => getStaffDepartment(s) === 'employee');
  const cast = all.filter(s => getStaffDepartment(s) === 'cast');
  if (emp.length)  groups.push({ key: 'employee', label: '社員',     staff: emp,  reqs: AppState.roleRequirements,     dailyReqs: AppState.dailyRequirements     || {} });
  if (cast.length) groups.push({ key: 'cast',     label: 'キャスト', staff: cast, reqs: AppState.roleRequirementsCast || {}, dailyReqs: AppState.dailyRequirementsCast || {} });
  return groups;
}

function isEarly(shift) {
  const t = getShiftType(shift);
  return t ? t.category === 'A' : false;
}

function isLate(shift) {
  const t = getShiftType(shift);
  return t ? t.category === 'B' : false;
}

function isTraining(shift) {
  const t = getShiftType(shift);
  return t ? t.isTraining : false;
}

function isNight(shift) {
  const t = getShiftType(shift);
  return t ? !!t.isNight : false;
}

// 日別必要人数を取得（per-day override がなければデフォルト値を返す）
function getDayReq(reqs, dailyReqs, shiftKey, day) {
  const override = (dailyReqs || {})[shiftKey];
  if (override && override[day] != null) return override[day];
  return reqs[shiftKey] || 0;
}

// 研修も早番カテゴリ（A）として扱う
function isEarlyCategory(shift) {
  return isEarly(shift) || isTraining(shift);
}

// 連勤カテゴリ（'A' / 'B' / null）
function getShiftCategory(shift) {
  if (isLate(shift)) return 'B';
  if (isEarlyCategory(shift)) return 'A';
  return null;
}

function isCountableWork(shift) {
  const t = getShiftType(shift);
  return t ? (t.countForStaff && !t.isTraining) : false;
}

// シフトセルの CSS クラス（オフ系はクラスで色管理、出勤系はインラインスタイル）
function getShiftClass(shift) {
  if (!shift) return 's-empty';
  if (getShiftType(shift)) return 's-work-cell'; // 出勤系（色はインラインスタイルで）
  if (OFF_TYPES[shift]) return OFF_TYPES[shift].class;
  return 's-empty';
}

// 出勤シフトのインラインスタイル文字列
function getShiftStyle(shift) {
  const t = getShiftType(shift);
  return t ? `background-color:${t.color};` : '';
}

// ===== ローカルストレージ =====

function saveToStorage() {
  try {
    localStorage.setItem('shiftAppData', JSON.stringify({
      version: 4,
      settings:             AppState.settings,
      shiftTypes:           AppState.shiftTypes,
      roleRequirements:     AppState.roleRequirements,
      roleRequirementsCast: AppState.roleRequirementsCast,
      dailyRequirements:    AppState.dailyRequirements,
      dailyRequirementsCast: AppState.dailyRequirementsCast,
      skills:               AppState.skills,
      staff:                AppState.staff,
      requests:             AppState.requests,
      shifts:               AppState.shifts,
      fixedShifts:          AppState.fixedShifts,
      specialDays:          AppState.specialDays,
      events:               AppState.events,
      violations:           AppState.violations,
      generated:            AppState.generated,
      _staffIdCounter,
      savedAt: new Date().toISOString(),
    }));
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

    // settings（penalties がなければデフォルトで補完）
    const penalties = Object.assign({ ...DEFAULT_PENALTIES }, (data.settings || {}).penalties || {});
    // 優先順位（定数厳守 > 公休 > 連休）を反映して旧データのペナルティを補正
    if (!(penalties.overstaff  >= 5000)) penalties.overstaff  = DEFAULT_PENALTIES.overstaff;  // 優先1
    if (!(penalties.offShortage >= 3000)) penalties.offShortage = DEFAULT_PENALTIES.offShortage; // 優先2
    if (penalties.longRest == null || penalties.longRest >= 3000) penalties.longRest = DEFAULT_PENALTIES.longRest; // 優先3
    // 残り違反（切替・リズム・単発出勤・連勤超過・遅→早）を減らすため旧データも引き上げ
    if (!(penalties.categorySwitch >= 3000)) penalties.categorySwitch = DEFAULT_PENALTIES.categorySwitch;
    if (!(penalties.badRest        >= 2500)) penalties.badRest        = DEFAULT_PENALTIES.badRest;
    if (!(penalties.singleWork     >= 2500)) penalties.singleWork     = DEFAULT_PENALTIES.singleWork;
    if (!(penalties.consBase       >= 2500)) penalties.consBase       = DEFAULT_PENALTIES.consBase;
    if (!(penalties.consSq         >= 500))  penalties.consSq         = DEFAULT_PENALTIES.consSq;
    if (!(penalties.lateEarly      >= 2500)) penalties.lateEarly      = DEFAULT_PENALTIES.lateEarly;
    if (penalties.bandConcentration == null) penalties.bandConcentration = DEFAULT_PENALTIES.bandConcentration;
    Object.assign(AppState.settings, data.settings || {}, { penalties });

    // shiftTypes（v3以降）。workHours・isNight 未設定の旧データを補完
    AppState.shiftTypes = (data.shiftTypes || getDefaultShiftTypes()).map(t =>
      Object.assign({ workHours: 8, isNight: false }, t));

    // roleRequirements
    Object.assign(AppState.roleRequirements, data.roleRequirements || {});
    AppState.roleRequirementsCast  = data.roleRequirementsCast  || {};
    AppState.dailyRequirements     = data.dailyRequirements     || {};
    AppState.dailyRequirementsCast = data.dailyRequirementsCast || {};
    AppState.skills                = Array.isArray(data.skills) ? data.skills : [];

    // events（v4以降）
    AppState.events = Array.isArray(data.events) ? data.events : [];

    // スタッフ（旧データ v2: roleType → allowedShifts へマイグレーション）
    AppState.staff = (data.staff || []).map(s => {
      let allowedShifts = Array.isArray(s.allowedShifts) ? s.allowedShifts : null;
      if (!allowedShifts) {
        // 旧 roleType から allowedShifts を導出
        allowedShifts = (_LEGACY_ROLE_SHIFTS[s.roleType] || ['早', '遅']).slice();
        // 旧 positionType による代替追加
        if (s.positionType === 'viceManager' || s.positionType === 'chief') {
          if (!allowedShifts.includes('早責')) allowedShifts.push('早責');
          if (!allowedShifts.includes('遅責')) allowedShifts.push('遅責');
        }
        if ((s.positionType === 'leader' && (s.roleType === 'normal' || s.roleType === 'normalSales')) ||
            (s.positionType === 'staff'  &&  s.roleType === 'normal') ||
             s.positionType === 'chief') {
          if (!allowedShifts.includes('早総務')) allowedShifts.push('早総務');
          if (!allowedShifts.includes('遅総務')) allowedShifts.push('遅総務');
        }
      }
      return {
        id:              s.id,
        name:            s.name || '',
        department:      s.department === 'cast' ? 'cast' : 'employee',
        positionType:    s.positionType || 'staff',
        allowedShifts,
        maxOff:          s.maxOff != null ? s.maxOff : 9,
        paidLeave:       s.paidLeave != null ? s.paidLeave : 0,
        prefs:           Array.isArray(s.prefs) ? s.prefs : ['早可', '遅可'],
        balance:         s.balance || 'balanced',
        prevConsecutive: s.prevConsecutive || 0,
        prevLastShift:   s.prevLastShift || '',
        note:            s.note || '',
        skills:          Array.isArray(s.skills) ? s.skills : [],
      };
    });

    AppState.requests    = data.requests    || {};
    AppState.shifts      = data.shifts      || {};
    AppState.fixedShifts = data.fixedShifts || {};
    AppState.specialDays = data.specialDays || {};
    AppState.violations  = data.violations  || [];
    AppState.generated   = data.generated === true;
    _staffIdCounter = data._staffIdCounter || (AppState.staff.length + 1);
    return true;
  } catch (e) {
    console.error('読込エラー', e);
    return false;
  }
}

function resetAll() {
  AppState.staff        = [];
  AppState.requests     = {};
  AppState.shifts       = {};
  AppState.fixedShifts  = {};
  AppState.specialDays  = {};
  AppState.events       = [];
  AppState.violations   = [];
  AppState.generated    = false;
  AppState.shiftTypes   = getDefaultShiftTypes();
  AppState.roleRequirements = {
    '早責': 1, '遅責': 1, '早総務': 1, '遅総務': 1, '早': 2, '遅': 2,
  };
  AppState.roleRequirementsCast  = {};
  AppState.dailyRequirements     = {};
  AppState.dailyRequirementsCast = {};
  AppState.skills                = [];
  AppState.settings.penalties = { ...DEFAULT_PENALTIES };
  _staffIdCounter = 1;
  localStorage.removeItem('shiftAppData');
}

// サンプルスタッフ（allowedShifts を直接指定）
function addSampleStaff() {
  const samples = [
    { name: '田中 太郎',   positionType: 'viceManager', allowedShifts: ['早責','遅責'],                                     maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
    { name: '佐藤 花子',   positionType: 'chief',       allowedShifts: ['早責','遅責','早総務','遅総務'],                    maxOff: 9, prefs: ['早可','遅可'], balance: 'earlyMore'  },
    { name: '鈴木 一郎',   positionType: 'chief',       allowedShifts: ['早総務','遅総務','早責','遅責'],                    maxOff: 9, prefs: ['早可','遅可'], balance: 'lateMore'   },
    { name: '高橋 美咲',   positionType: 'leader',      allowedShifts: ['早総務','遅総務'],                                  maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
    { name: '伊藤 健太',   positionType: 'leader',      allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'earlyHeavy' },
    { name: '渡辺 由美',   positionType: 'leader',      allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'lateHeavy'  },
    { name: '山本 拓也',   positionType: 'staff',       allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
    { name: '中村 さくら', positionType: 'staff',       allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'earlyMore'  },
    { name: '小林 健',     positionType: 'staff',       allowedShifts: ['早','遅'],                                          maxOff: 9, prefs: ['早可','遅可'], balance: 'lateMore'   },
    { name: '加藤 真理',   positionType: 'staff',       allowedShifts: ['早','早総務'],                                       maxOff: 9, prefs: ['早可'],         balance: 'earlyHeavy' },
    { name: '吉田 翔',     positionType: 'staff',       allowedShifts: ['遅'],                                               maxOff: 9, prefs: ['遅可'],         balance: 'lateHeavy'  },
    { name: '山田 恵子',   positionType: 'staff',       allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
    { name: '松本 大輔',   positionType: 'staff',       allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
    { name: '井上 千秋',   positionType: 'staff',       allowedShifts: ['早','遅','早総務','遅総務'],                         maxOff: 9, prefs: ['早可','遅可'], balance: 'balanced'   },
  ];
  samples.forEach(s => {
    AppState.staff.push({
      id:              newStaffId(),
      name:            s.name,
      department:      'employee',
      positionType:    s.positionType,
      allowedShifts:   s.allowedShifts,
      maxOff:          s.maxOff,
      paidLeave:       0,
      prefs:           s.prefs,
      balance:         s.balance,
      prevConsecutive: 0,
      prevLastShift:   '',
      note:            '',
      skills:          [],
    });
  });
}
