/* ===========================================
   milp-core.js — 数理最適化(MILP)モデル生成コア（ベータ）
   data.js / optimizer.js の後に読み込む前提（各種ヘルパを利用）。
   AppState から、部門グループごとに CPLEX LP 形式のモデルを組み立て、
   HiGHS(WASM) の解を AppState.shifts に変換する。すべてソフト制約（スラック）
   で組むため、常に実行可能（infeasible にならない）＝安全に併用できる。
   =========================================== */
(function (global) {
  'use strict';

  // ルール強弱を重みに反映。off=0（制約を入れない）、must=強め、should=通常。
  function ruleW(type, base) {
    const lv = (typeof getRuleLevel === 'function') ? getRuleLevel(type) : 'must';
    if (lv === 'off') return 0;
    return lv === 'must' ? base : Math.max(1, Math.round(base * 0.4));
  }
  const cat = k => isEarlyCategory(k) ? 'e' : (isLate(k) ? 'l' : null);

  // 1部門グループ分の LP を作る。戻り値 { lp, vars, roles, gStaff, days }
  function buildGroupModel(gStaff, reqs, dailyReqs) {
    const days = getDaysInMonth(AppState.settings.targetMonth);
    const allRoles = getWorkShiftKeys().filter(k => {
      const t = AppState.shiftTypes.find(x => x.key === k);
      return t && !t.isTraining;
    });
    // この部門で必要数のある役割のみ対象
    const roles = allRoles.filter(k => {
      if ((reqs || {})[k] > 0) return true;
      const dr = (dailyReqs || {})[k] || {};
      return Object.keys(dr).some(d => dr[d] > 0);
    });
    const roleIdx = {}; roles.forEach((k, i) => roleIdx[k] = i);
    const earlyRoles = roles.filter(k => cat(k) === 'e');
    const lateRoles  = roles.filter(k => cat(k) === 'l');
    const SOLO = (typeof SOLO_SHIFT_KEYS !== 'undefined') ? new Set(SOLO_SHIFT_KEYS) : new Set();
    const P = AppState.settings.penalties || {};
    const skills = (AppState.skills || []).filter(sk => (sk.req != null ? sk.req : sk.lateReq) > 0);

    const sidOf = {}; gStaff.forEach((s, i) => sidOf[s.id] = i);
    const V = (si, d, ki) => `x_${si}_${d}_${ki}`;

    const req = (s) => (s.requests || (AppState.requests[s.id] || {}));
    const fx  = (s, d) => (AppState.fixedShifts[s.id] || {})[d];
    const rq  = (s, d) => (AppState.requests[s.id] || {})[d];
    const allowRoles = s => (s.allowedShifts || []).filter(k => roles.includes(k));
    // その日、役割を割り当て可能か（休/有/固定/研 でない）
    const free = (s, d) => {
      const r = rq(s, d); if (r && isOff(r)) return false;
      const f = fx(s, d); if (f) return false;
      return true;
    };
    const isTrainDay = (s, d) => { const f = fx(s, d); return f && isTraining(f); };
    const isFixWork  = (s, d) => { const f = fx(s, d); return f && isWork(f) && !isTraining(f); };

    // 個人有給(有)の自動付与目標：設定 paidLeave からカレンダー指定済みの'有'を差し引いた不足分。
    // 不足分を空き日に'有'(y変数)として配置して目標日数を満たす（社員のみ・キャスト対象外）。
    const paidTarget = {};
    gStaff.forEach(s => {
      if (getStaffDepartment(s) === 'cast') { paidTarget[s.id] = 0; return; }
      let reqPaid = 0;
      for (let d = 1; d <= days; d++) if ((AppState.requests[s.id] || {})[d] === '有') reqPaid++;
      paidTarget[s.id] = Math.max(0, (parseInt(s.paidLeave) || 0) - reqPaid);
    });
    const Y = (si, d) => `y_${si}_${d}`;

    const obj = [], cons = [], bin = new Set(), gen = new Set(), bnd = [];
    const addSlack = (name, ub, weight) => { gen.add(name); bnd.push(ub != null ? `0 <= ${name} <= ${ub}` : `0 <= ${name}`); if (weight > 0) obj.push(`${weight} ${name}`); };

    // 決定変数 x（担当可能かつ自由なマス）＋ 固定・不可マスの0/1固定＋ 1日1シフト
    gStaff.forEach(s => {
      const si = sidOf[s.id];
      for (let d = 1; d <= days; d++) {
        const ks = allowRoles(s);
        if (isFixWork(s, d) && roles.includes(fx(s, d))) {
          bin.add(V(si, d, roleIdx[fx(s, d)]));
          cons.push(`fx_${si}_${d}: ${V(si, d, roleIdx[fx(s, d)])} = 1`);
          ks.forEach(k => { if (k !== fx(s, d)) { bin.add(V(si, d, roleIdx[k])); cons.push(`fz_${si}_${d}_${roleIdx[k]}: ${V(si, d, roleIdx[k])} = 0`); } });
          continue;
        }
        if (!free(s, d)) { ks.forEach(k => { bin.add(V(si, d, roleIdx[k])); cons.push(`z_${si}_${d}_${roleIdx[k]}: ${V(si, d, roleIdx[k])} = 0`); }); continue; }
        const t = []; ks.forEach(k => { bin.add(V(si, d, roleIdx[k])); t.push(V(si, d, roleIdx[k])); });
        if (paidTarget[s.id] > 0) { const yv = Y(si, d); bin.add(yv); t.push(yv); } // 有給候補（勤務と排他）
        if (t.length) cons.push(`one_${si}_${d}: ${t.join(' + ')} <= 1`);
      }
    });

    // 各日・各役割の必要人数（不足スラック u）＋ SOLO重複
    for (let d = 1; d <= days; d++) {
      roles.forEach(k => {
        const need = getDayReq(reqs || {}, dailyReqs || {}, k, d);
        const terms = [];
        gStaff.forEach(s => {
          if (!(s.allowedShifts || []).includes(k)) return;
          if (fx(s, d) === k) terms.push('1c'); // 固定で入る（定数）
          else if (free(s, d)) terms.push(V(sidOf[s.id], d, roleIdx[k]));
        });
        const cconst = terms.filter(x => x === '1c').length;
        const vterms = terms.filter(x => x !== '1c');
        if (need > 0) {
          const u = `u_${d}_${roleIdx[k]}`; addSlack(u, null, ruleW('understaff', P.understaff || 20000));
          cons.push(`req_${d}_${roleIdx[k]}: ${(vterms.length ? vterms.join(' + ') + ' + ' : '')}${u} >= ${need - cconst}`);
          // 超過（定数より多い）を罰して「定数ちょうど」に寄せる。余った人手は休み(→余)に回る。
          // SOLO役割(早責/遅責等)は下の重複制約(rd)で扱うため二重には入れない。
          const wOver = (P.overstaff || 6000);
          if (wOver > 0 && vterms.length && !SOLO.has(k)) {
            const ov = `ov_${d}_${roleIdx[k]}`; addSlack(ov, null, wOver);
            cons.push(`ovr_${d}_${roleIdx[k]}: ${vterms.join(' + ')} - ${ov} <= ${need - cconst}`);
          }
        }
        if (SOLO.has(k) && (vterms.length)) {
          const cap = Math.max(0, (need || 1) - cconst);
          const w = ruleW('resp-duplicate', P.respDuplicate || 8000);
          if (w > 0) { const o = `rd_${d}_${roleIdx[k]}`; addSlack(o, null, w); cons.push(`dup_${d}_${roleIdx[k]}: ${vterms.join(' + ')} - ${o} <= ${cap}`); }
        }
      });
    }

    // スキル（早/遅帯）: 最低 min・目標 req
    skills.forEach((sk, xi) => {
      const need = (sk.req != null ? sk.req : sk.lateReq) || 0;
      const min = (sk.min != null && sk.min >= 0 && sk.min <= need) ? sk.min : need;
      const early = (sk.target || 'late') === 'early';
      const bandRoles = early ? earlyRoles : lateRoles;
      for (let d = 1; d <= days; d++) {
        const terms = []; let c = 0;
        gStaff.forEach(s => {
          if (!(s.skills || []).includes(sk.name)) return;
          bandRoles.forEach(k => {
            if (!(s.allowedShifts || []).includes(k)) return;
            if (fx(s, d) === k) c++;
            else if (free(s, d)) terms.push(V(sidOf[s.id], d, roleIdx[k]));
          });
        });
        const lhs = terms.length ? terms.join(' + ') : '';
        const wm = ruleW('skill-late', P.skillLateShortage || 9000);
        if (wm > 0 && min > 0) { const sm = `sm_${xi}_${d}`; addSlack(sm, null, wm); cons.push(`skm_${xi}_${d}: ${(lhs ? lhs + ' + ' : '')}${sm} >= ${min - c}`); }
        const ws = ruleW('skill-short', P.skillSoftShortage || 1500);
        if (ws > 0 && need > min) { const ss = `ss_${xi}_${d}`; addSlack(ss, null, ws); cons.push(`sks_${xi}_${d}: ${(lhs ? lhs + ' + ' : '')}${ss} >= ${need - c}`); }
      }
    });

    // 副店長カバレッジ（毎日≥1）
    const vms = gStaff.filter(s => s.positionType === 'viceManager');
    if (vms.length >= 2) {
      const w = ruleW('vicemanager-absent', P.viceManagerDailyAbsent || 9000);
      if (w > 0) for (let d = 1; d <= days; d++) {
        const terms = []; let c = 0;
        vms.forEach(s => { allowRoles(s).forEach(k => { if (fx(s, d) === k) c++; else if (free(s, d)) terms.push(V(sidOf[s.id], d, roleIdx[k])); }); });
        if (c === 0) { const va = `va_${d}`; addSlack(va, 1, w); cons.push(`vice_${d}: ${(terms.length ? terms.join(' + ') + ' + ' : '')}${va} >= 1`); }
      }
    }

    // 横（各スタッフ）: 連勤・公休・リズム・ヒエラルキー
    const cellTerms = (s, d) => { // {c, w:[], e:[], l:[]}  勤務=役割+研+固定
      const o = { c: 0, w: [], e: [], l: [] };
      if (isTrainDay(s, d)) { o.c = 1; o.e.push('_'); return o; } // 研=早系（定数扱い）
      if (isFixWork(s, d)) { o.c = 1; const k = fx(s, d); (cat(k) === 'l' ? o.l : o.e).push('_'); return o; }
      if (!free(s, d)) return o;
      allowRoles(s).forEach(k => { const v = V(sidOf[s.id], d, roleIdx[k]); o.w.push(v); (cat(k) === 'l' ? o.l : o.e).push(v); });
      return o;
    };
    const realT = arr => arr.filter(x => x !== '_');
    const constOf = (arr) => arr.filter(x => x === '_').length;

    gStaff.forEach(s => {
      const isCast = getStaffDepartment(s) === 'cast';
      const si = sidOf[s.id];
      const maxCons = getMaxConsFor(s);
      // 連勤上限（(maxCons+1)連続窓 ≤ maxCons）
      const wc = ruleW('consecutive', (P.consBase || 6000));
      if (wc > 0) {
        const win = maxCons + 1;
        for (let d = 1; d + win - 1 <= days; d++) {
          let cc = 0, t = [];
          for (let dd = d; dd < d + win; dd++) { const o = cellTerms(s, dd); cc += o.c; t = t.concat(realT(o.w)); }
          if (t.length) { const cv = `cw_${si}_${d}`; addSlack(cv, null, wc); cons.push(`con_${si}_${d}: ${t.join(' + ')} - ${cv} <= ${maxCons - cc}`); }
        }
        // 前月末の連勤を反映：前月から pc 連勤で入ってくる場合、月初の窓に pc を定数として加える。
        // j 日ぶんの前月勤務＋月初(1..win-j 日)の勤務合計 ≤ maxCons。
        const pc = Math.min(maxCons, s.prevConsecutive || 0);
        for (let j = 1; j <= pc; j++) {
          const lastDay = Math.min(win - j, days);
          if (lastDay < 1) continue;
          let cc = 0, t = [];
          for (let dd = 1; dd <= lastDay; dd++) { const o = cellTerms(s, dd); cc += o.c; t = t.concat(realT(o.w)); }
          if (t.length) { const cv = `cb_${si}_${j}`; addSlack(cv, null, wc); cons.push(`conb_${si}_${j}: ${t.join(' + ')} - ${cv} <= ${(maxCons - j) - cc}`); }
        }
      }
      // 公休不足（キャストは対象外）
      if (!isCast) {
        const wo = ruleW('off-count', P.offShortage || 4000);
        if (wo > 0) {
          let paidN = 0, trainN = 0, fixN = 0, roleT = [];
          for (let d = 1; d <= days; d++) {
            const r = rq(s, d); if (r === '有') { paidN++; continue; }
            if (isTrainDay(s, d)) { trainN++; continue; }
            if (isFixWork(s, d)) { fixN++; continue; }
            if (free(s, d)) allowRoles(s).forEach(k => roleT.push(V(si, d, roleIdx[k])));
          }
          const workTarget = days - (s.maxOff || 0) - trainN - paidN - (paidTarget[s.id] || 0);
          if (roleT.length) { const os = `os_${si}`; addSlack(os, null, wo); cons.push(`off_${si}: ${roleT.join(' + ')} - ${os} <= ${workTarget - fixN}`); }
        }
        // 有給(有)を目標日数だけ確保（不足分をソフトで強制。人員不足より弱いので、埋まっている日は無理に取らない）
        if (paidTarget[s.id] > 0) {
          const yt = [];
          for (let d = 1; d <= days; d++) if (free(s, d)) yt.push(Y(si, d));
          if (yt.length) {
            const need = Math.min(paidTarget[s.id], yt.length);
            const ps = `ps_${si}`; addSlack(ps, null, 6000);
            cons.push(`paid_${si}: ${yt.join(' + ')} + ${ps} >= ${need}`);
            // 目標超過は禁止：余分な'有'は公休(maxOff)を削り「公休不足」を招くため、ちょうど need 日までに制限。
            cons.push(`paidhi_${si}: ${yt.join(' + ')} <= ${need}`);
          }
        }
      }
      if (isCast) return; // キャストはリズム系ルール免除
      // リズム: late-early / single / category-switch / bad-rest / long-rest / hierarchy
      const wLE = ruleW('late-early', P.lateEarly || 9000);
      const wSW = ruleW('single-work', P.singleWork || 5000);
      const wCS = ruleW('category-switch', P.categorySwitch || 3000);
      const wBR = ruleW('bad-rest', P.badRest || 2500);
      const wLR = ruleW('long-rest', P.longRest || 2000);
      for (let d = 1; d <= days; d++) {
        const A = cellTerms(s, d), B = d < days ? cellTerms(s, d + 1) : null, C = d + 2 <= days ? cellTerms(s, d + 2) : null, Pd = d > 1 ? cellTerms(s, d - 1) : null;
        if (B && wLE > 0) { const t = [...realT(A.l), ...realT(B.e)]; const rhs = 1 - constOf(A.l) - constOf(B.e); if (t.length && rhs >= 0) { const v = `le_${si}_${d}`; addSlack(v, 1, wLE); cons.push(`le_${si}_${d}: ${t.join(' + ')} - ${v} <= ${rhs}`); } }
        // 単発出勤（前後が休みで1日だけ出勤）。研修・固定出勤(A.c>=1)の日も対象にする
        // （checkViolations は研修も出勤として数えるため。可能なら前後どちらかに勤務を入れて孤立を防ぐ）。
        if (Pd && B && wSW > 0 && (realT(A.w).length || A.c >= 1)) { const v = `sw_${si}_${d}`; addSlack(v, 1, wSW); const lhs = [...realT(A.w), ...realT(Pd.w).map(x => `- ${x}`), ...realT(B.w).map(x => `- ${x}`), `- ${v}`]; cons.push(`sw_${si}_${d}: ${(lhs.join(' + ').replace(/\+ -/g, '-')) || `- ${v}`} <= ${-A.c + Pd.c + B.c}`); }
        if (B && wCS > 0) { const v = `cs_${si}_${d}`; addSlack(v, 1, wCS); const t1 = [...realT(A.e), ...realT(B.l)]; if (t1.length) cons.push(`cs1_${si}_${d}: ${t1.join(' + ')} - ${v} <= ${1 - constOf(A.e) - constOf(B.l)}`); const t2 = [...realT(A.l), ...realT(B.e)]; if (t2.length) cons.push(`cs2_${si}_${d}: ${t2.join(' + ')} - ${v} <= ${1 - constOf(A.l) - constOf(B.e)}`); }
        if (B && C && wBR > 0) { const v = `br_${si}_${d}`; addSlack(v, 1, wBR); const t = [...realT(A.l), ...realT(C.e), ...realT(B.w).map(x => `- ${x}`), `- ${v}`]; if (realT(A.l).length && realT(C.e).length) cons.push(`br_${si}_${d}: ${t.join(' + ').replace(/\+ -/g, '-')} <= ${1 - constOf(A.l) - constOf(C.e) + B.c}`); }
        if (wLR > 0 && d + 3 <= days) { const D2 = cellTerms(s, d + 1), D3 = cellTerms(s, d + 2), D4 = cellTerms(s, d + 3); const t = [...realT(A.w), ...realT(D2.w), ...realT(D3.w), ...realT(D4.w)]; const cc = A.c + D2.c + D3.c + D4.c; if (t.length) { const v = `lr_${si}_${d}`; addSlack(v, 1, wLR); cons.push(`lr_${si}_${d}: ${t.join(' + ')} + ${v} >= ${1 - cc}`); } }
      }
      // 前月末シフト(prevLastShift)を反映：1日目の 遅→早（インターバル不足）と連勤中の時間帯切替。
      // checkViolations は前月末シフトを見て罰する（consWork/prevShift）のに、生成側が無視すると
      // 1日目に必ず違反が出る。境界を制約に加えて回避する。
      const pls = (s.prevConsecutive > 0 && s.prevLastShift && isWork(s.prevLastShift)) ? s.prevLastShift : '';
      if (pls) {
        const A1 = cellTerms(s, 1);
        const earlyD1 = realT(A1.e), lateD1 = realT(A1.l);
        if (isLate(pls)) {
          // 遅→早（🔴）：1日目に早番系を入れない
          if (wLE > 0 && earlyD1.length) { const v = `leb_${si}`; addSlack(v, 1, wLE); cons.push(`leb_${si}: ${earlyD1.join(' + ')} - ${v} <= 0`); }
          // 連勤中の時間帯切替 遅→早（🟡）：前月から連勤継続中なので該当
          if (wCS > 0 && earlyD1.length) { const v = `csb_${si}`; addSlack(v, 1, wCS); cons.push(`csb_${si}: ${earlyD1.join(' + ')} - ${v} <= 0`); }
        } else if (isEarlyCategory(pls)) {
          // 連勤中の時間帯切替 早→遅（🟡）
          if (wCS > 0 && lateD1.length) { const v = `csb_${si}`; addSlack(v, 1, wCS); cons.push(`csb_${si}: ${lateD1.join(' + ')} - ${v} <= 0`); }
        }
      }
    });

    // ヒエラルキー（早責/遅責）
    const wH = ruleW('hierarchy', P.hierarchyViolation || 3000);
    if (wH > 0) {
      [['e', earlyRoles], ['l', lateRoles]].forEach(([band, bandRoles]) => {
        bandRoles.filter(r => SOLO.has(r)).forEach(resp => {
          const capable = gStaff.filter(s => (s.allowedShifts || []).includes(resp));
          for (let d = 1; d <= days; d++) {
            capable.forEach(lo => {
              let loResp = null;
              if (fx(lo, d) === resp) loResp = '1c';
              else if (free(lo, d)) loResp = V(sidOf[lo.id], d, roleIdx[resp]);
              else return;
              capable.forEach(hi => {
                if (hi.id === lo.id || getStaffPriority(hi) >= getStaffPriority(lo)) return;
                const o = cellTerms(hi, d); const bandArr = band === 'e' ? o.e : o.l;
                const hiT = realT(bandArr), hiC = constOf(bandArr);
                if (loResp === '1c') { if (hiT.length) { const v = `h_${band}_${d}_${sidOf[lo.id]}_${sidOf[hi.id]}`; addSlack(v, 1, wH); cons.push(`${v}c: ${hiT.join(' + ')} - ${v} <= ${1 - hiC}`); } return; }
                const v = `h_${band}_${d}_${sidOf[lo.id]}_${sidOf[hi.id]}`; addSlack(v, 1, wH);
                const t = [loResp, ...hiT, `- ${v}`]; cons.push(`${v}c: ${t.join(' + ').replace(/\+ -/g, '-')} <= ${1 - hiC}`);
              });
            });
          }
        });
      });
    }

    if (!obj.length) obj.push('0 z_dummy'), gen.add('z_dummy'), bnd.push('0 <= z_dummy <= 0');
    const lp = `Minimize\n obj: ${obj.join(' + ')}\nSubject To\n ${cons.join('\n ')}\nBounds\n ${bnd.join('\n ')}\nBinary\n ${[...bin].join('\n ')}\nGeneral\n ${[...gen].join('\n ')}\nEnd\n`;
    return { lp, sidOf, roleIdx, roles, gStaff, days };
  }

  // 解を shifts に反映（固定・希望休はそのまま）
  function applyGroupSolution(model, sol, shifts) {
    const { gStaff, days, sidOf, roleIdx, roles } = model;
    gStaff.forEach(s => {
      const si = sidOf[s.id]; shifts[s.id] = shifts[s.id] || {};
      for (let d = 1; d <= days; d++) {
        const f = (AppState.fixedShifts[s.id] || {})[d];
        const r = (AppState.requests[s.id] || {})[d];
        if (f) { shifts[s.id][d] = f; continue; }
        if (r && isOff(r)) { shifts[s.id][d] = r; continue; }
        if (r === '有') { shifts[s.id][d] = '有'; continue; }
        let assigned = '休';
        roles.forEach(k => { if (!(s.allowedShifts || []).includes(k)) return; const col = sol.Columns && sol.Columns[`x_${si}_${d}_${roleIdx[k]}`]; if (col && col.Primal > 0.5) assigned = k; });
        if (assigned === '休') { const yc = sol.Columns && sol.Columns[`y_${si}_${d}`]; if (yc && yc.Primal > 0.5) assigned = '有'; }
        shifts[s.id][d] = assigned;
      }
    });
  }

  global.MILP = { buildGroupModel, applyGroupSolution };
})(typeof self !== 'undefined' ? self : this);
