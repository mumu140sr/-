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

  // 段階最適化の順番。大事なものから順に0を目指し、達成できたら以後は動かさない。
  // 上の段ほど「店舗が回らなくなる」影響が大きいルール。
  const TIERS = [
    { label: '人員・役職',     types: ['understaff', 'resp-duplicate', 'skill-late', 'vicemanager-absent'] },
    { label: '公休・有給',     types: ['off-count', 'paid'] },
    { label: '連勤・遅→早',    types: ['consecutive', 'late-early'] },
    { label: '単発出勤・定数',  types: ['single-work', 'overstaff'] },
    { label: 'リズム',        types: ['category-switch', 'bad-rest', 'long-rest', 'pair-rest'] },
    { label: '希望・その他',   types: ['hierarchy', 'pref-mismatch', 'balance-diff', 'skill-short', 'surplus-unwanted', 'single-off'] },
  ];

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
    // 既定が0でも日別上書きがあれば対象にする
    const skills = (AppState.skills || []).filter(sk =>
      ((sk.req != null ? sk.req : sk.lateReq) > 0) || hasDailySkillOverride(sk.name));

    const sidOf = {}; gStaff.forEach((s, i) => sidOf[s.id] = i);
    const V = (si, d, ki) => `x_${si}_${d}_${ki}`;

    const req = (s) => (s.requests || (AppState.requests[s.id] || {}));
    // 固定シフト（手動固定＋④で指定した出勤系シフト）。旧データ互換も含む。
    const fx  = (s, d) => getFixedShiftAt(s.id, d) || undefined;
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
    // 罰点変数（スラック）を、どのルールのものかを覚えながら追加する。
    // 段階最適化では「このルールだけを最小化する」ため、ルール別の一覧が必要。
    const objEntries = [];                  // { w, name, type }
    const slackByType = {};                 // ルール → 変数名の配列
    // 罰点を直接つける（スラック変数ではなく、決定変数そのものに重みを置く場合）
    const addObj = (weight, name, type) => {
      if (!(weight > 0)) return;
      obj.push(`${weight} ${name}`);
      objEntries.push({ w: weight, name, type: type || 'other' });
    };
    const addSlack = (name, ub, weight, type) => {
      gen.add(name);
      bnd.push(ub != null ? `0 <= ${name} <= ${ub}` : `0 <= ${name}`);
      const t = type || 'other';
      (slackByType[t] || (slackByType[t] = [])).push(name);
      if (weight > 0) { obj.push(`${weight} ${name}`); objEntries.push({ w: weight, name, type: t }); }
    };

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
          const u = `u_${d}_${roleIdx[k]}`; addSlack(u, null, ruleW('understaff', P.understaff || 20000), 'understaff');
          cons.push(`req_${d}_${roleIdx[k]}: ${(vterms.length ? vterms.join(' + ') + ' + ' : '')}${u} >= ${need - cconst}`);
          // 超過（定数より多い）を罰して「定数ちょうど」に寄せる。余った人手は休み(→余)に回る。
          // SOLO役割(早責/遅責等)は下の重複制約(rd)で扱うため二重には入れない。
          const wOver = (P.overstaff || 6000);
          if (wOver > 0 && vterms.length && !SOLO.has(k)) {
            const ov = `ov_${d}_${roleIdx[k]}`; addSlack(ov, null, wOver, 'overstaff');
            cons.push(`ovr_${d}_${roleIdx[k]}: ${vterms.join(' + ')} - ${ov} <= ${need - cconst}`);
          }
        }
        if (SOLO.has(k) && (vterms.length)) {
          const cap = Math.max(0, (need || 1) - cconst);
          const w = ruleW('resp-duplicate', P.respDuplicate || 8000);
          if (w > 0) { const o = `rd_${d}_${roleIdx[k]}`; addSlack(o, null, w, 'resp-duplicate'); cons.push(`dup_${d}_${roleIdx[k]}: ${vterms.join(' + ')} - ${o} <= ${cap}`); }
        }
      });
    }

    // スキル（早/遅帯）: 最低 min・目標 req
    skills.forEach((sk, xi) => {
      const early = (sk.target || 'late') === 'early';
      const bandRoles = early ? earlyRoles : lateRoles;
      for (let d = 1; d <= days; d++) {
        // 目標人数・最低ラインは日別上書きを反映（日別必要人数パネルで設定）
        const { need, min } = getDaySkillReq(sk, d);
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
        if (wm > 0 && min > 0) { const sm = `sm_${xi}_${d}`; addSlack(sm, null, wm, 'skill-late'); cons.push(`skm_${xi}_${d}: ${(lhs ? lhs + ' + ' : '')}${sm} >= ${min - c}`); }
        const ws = ruleW('skill-short', P.skillSoftShortage || 1500);
        if (ws > 0 && need > min) { const ss = `ss_${xi}_${d}`; addSlack(ss, null, ws, 'skill-short'); cons.push(`sks_${xi}_${d}: ${(lhs ? lhs + ' + ' : '')}${ss} >= ${need - c}`); }
      }
    });

    // 副店長カバレッジ（毎日≥1）
    const vms = gStaff.filter(s => s.positionType === 'viceManager');
    if (vms.length >= 2) {
      const w = ruleW('vicemanager-absent', P.viceManagerDailyAbsent || 9000);
      if (w > 0) for (let d = 1; d <= days; d++) {
        const terms = []; let c = 0;
        vms.forEach(s => { allowRoles(s).forEach(k => { if (fx(s, d) === k) c++; else if (free(s, d)) terms.push(V(sidOf[s.id], d, roleIdx[k])); }); });
        if (c === 0) { const va = `va_${d}`; addSlack(va, 1, w, 'vicemanager-absent'); cons.push(`vice_${d}: ${(terms.length ? terms.join(' + ') + ' + ' : '')}${va} >= 1`); }
      }
    }

    // 横（各スタッフ）: 連勤・公休・リズム・ヒエラルキー
    const cellTerms = (s, d) => { // {c, w:[], e:[], l:[]}  勤務=役割+研+固定
      const o = { c: 0, w: [], e: [], l: [] };
      // 研修は既定で早番系。②シフト種別マスターでカテゴリB（遅番）にした場合はそれに従う。
      if (isTrainDay(s, d)) { o.c = 1; (cat(fx(s, d)) === 'l' ? o.l : o.e).push('_'); return o; }
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
          if (t.length) { const cv = `cw_${si}_${d}`; addSlack(cv, null, wc, 'consecutive'); cons.push(`con_${si}_${d}: ${t.join(' + ')} - ${cv} <= ${maxCons - cc}`); }
        }
        // 前月末の連勤を反映：前月から pc 連勤で入ってくる場合、月初の窓に pc を定数として加える。
        // j 日ぶんの前月勤務＋月初(1..win-j 日)の勤務合計 ≤ maxCons。
        const pc = Math.min(maxCons, getPrevMonthEnd(s).cons);
        for (let j = 1; j <= pc; j++) {
          const lastDay = Math.min(win - j, days);
          if (lastDay < 1) continue;
          let cc = 0, t = [];
          for (let dd = 1; dd <= lastDay; dd++) { const o = cellTerms(s, dd); cc += o.c; t = t.concat(realT(o.w)); }
          if (t.length) { const cv = `cb_${si}_${j}`; addSlack(cv, null, wc, 'consecutive'); cons.push(`conb_${si}_${j}: ${t.join(' + ')} - ${cv} <= ${(maxCons - j) - cc}`); }
        }
      }
      // 公休不足（キャストは対象外）
      if (!isCast) {
        const wo = ruleW('off-count', P.offShortage || 4000);
        if (wo > 0) {
          let paidN = 0, trainN = 0, fixN = 0, otherOffN = 0, roleT = [];
          for (let d = 1; d <= days; d++) {
            // カレンダー・固定で休みが確定している日は「働けない日」として日数から差し引く。
            // 公休系(休/公/☆)は maxOff に含まれるので加算しないが、有給・半休・
            // 季節休暇・慶弔休・引継は maxOff の外なので個別に差し引く必要がある。
            // （差し引かないと「1日多く働ける」と誤認し、結果として公休が不足する）
            const r  = rq(s, d);
            const fv = (AppState.fixedShifts[s.id] || {})[d];
            const lockedOff = (r && isOff(r)) ? r : ((fv && isOff(fv)) ? fv : '');
            if (lockedOff) {
              if (lockedOff === '有') paidN++;
              else if (!isPublicOff(lockedOff)) otherOffN++;   // 半 / 季 / 慶 / 引 など
              continue;
            }
            if (isTrainDay(s, d)) { trainN++; continue; }
            if (isFixWork(s, d)) { fixN++; continue; }
            if (free(s, d)) allowRoles(s).forEach(k => roleT.push(V(si, d, roleIdx[k])));
          }
          const workTarget = days - (s.maxOff || 0) - trainN - paidN - otherOffN - (paidTarget[s.id] || 0);
          if (roleT.length) { const os = `os_${si}`; addSlack(os, null, wo, 'off-count'); cons.push(`off_${si}: ${roleT.join(' + ')} - ${os} <= ${workTarget - fixN}`); }
          // 余剰休み（余）を誰に寄せるか。余は「目標公休より多く休んだ分」なので、
          // 目標どおり働けば余は出ない。人員不足より弱いソフト制約にする。
          if (roleT.length) {
            const pref = s.surplusPref || '';
            if (pref === 'avoid') {
              // 付けたくない人：目標日数を下回ったら罰点（＝優先して出勤に回す）
              const wa = P.surplusAvoid || 700;
              if (wa > 0) { const sv = `sv_${si}`; addSlack(sv, null, wa, 'surplus-unwanted'); cons.push(`sur_${si}: ${roleT.join(' + ')} + ${sv} >= ${workTarget - fixN}`); }
            } else if (pref === 'prefer') {
              // 優先して付ける人：出勤1日ごとにごく小さな罰点を置き、余りをこの人へ寄せる
              const wp = P.surplusPrefer || 200;
              if (wp > 0) roleT.forEach(v => addObj(wp, v, 'surplus-unwanted'));
            }
          }
        }
        // 有給(有)を目標日数だけ確保（不足分をソフトで強制。人員不足より弱いので、埋まっている日は無理に取らない）
        if (paidTarget[s.id] > 0) {
          const yt = [];
          for (let d = 1; d <= days; d++) if (free(s, d)) yt.push(Y(si, d));
          if (yt.length) {
            const need = Math.min(paidTarget[s.id], yt.length);
            const ps = `ps_${si}`; addSlack(ps, null, 6000, 'paid');
            cons.push(`paid_${si}: ${yt.join(' + ')} + ${ps} >= ${need}`);
            // 目標超過は禁止：余分な'有'は公休(maxOff)を削り「公休不足」を招くため、ちょうど need 日までに制限。
            cons.push(`paidhi_${si}: ${yt.join(' + ')} <= ${need}`);
          }
        }
      }
      // 早遅バランス（早番多め/遅番多め など）と 早可/遅可 の希望
      // ─ どちらも「早番の帯 / 遅番の帯」の割り振りを整えるルール。
      {
        // その人が早番帯・遅番帯の両方に入れる場合だけ意味を持つ
        const myE = allowRoles(s).filter(k => cat(k) === 'e');
        const myL = allowRoles(s).filter(k => cat(k) === 'l');

        // ① 早可 / 遅可（希望に反する帯への割当を罰する。ソフトなので人員不足よりは弱い）
        const wPF = ruleW('pref-mismatch', P.prefMismatch || 7000);
        if (wPF > 0 && (s.prefs || []).length > 0) {
          const okE = s.prefs.includes('早可'), okL = s.prefs.includes('遅可');
          if (!okE || !okL) {
            const bad = [];
            for (let d = 1; d <= days; d++) {
              if (!free(s, d)) continue;
              allowRoles(s).forEach(k => {
                const c = cat(k);
                if ((c === 'e' && !okE) || (c === 'l' && !okL)) bad.push(V(si, d, roleIdx[k]));
              });
            }
            if (bad.length) {
              const pv = `pf_${si}`; addSlack(pv, null, wPF, 'pref-mismatch');
              cons.push(`pfm_${si}: ${bad.join(' + ')} - ${pv} <= 0`);
            }
          }
        }

        // ② 早遅バランス比率
        const wBAL = ruleW('balance-diff', P.balanceDiff || 80);
        const ratio = getBalanceRatio(s);   // 「指定なし(OFF)」の人は null → 制約を作らない
        if (wBAL > 0 && ratio && myE.length && myL.length) {
          // 目標: 早番数 : 遅番数 = earlyRatio : lateRatio
          // ずれ D = lateRatio*早番数 - earlyRatio*遅番数（0 に近いほど目標どおり）
          // 係数は 10 倍して整数化する（1日ぶんのずれ ＝ 10 単位）。
          const ce = Math.round(ratio.lateRatio * 10);
          const cl = Math.round(ratio.earlyRatio * 10);
          const terms = []; let konst = 0;
          for (let d = 1; d <= days; d++) {
            const o = cellTerms(s, d);
            realT(o.e).forEach(v => terms.push(`+ ${ce} ${v}`));
            realT(o.l).forEach(v => terms.push(`- ${cl} ${v}`));
            konst += constOf(o.e) * ce - constOf(o.l) * cl;   // 固定・研修ぶんは定数
          }
          if (terms.length) {
            const tol = 10 * Math.max(0, parseInt(AppState.settings.balanceTolerance) || 0);
            const wu = Math.max(0.1, wBAL / 10);   // 1日ぶんのずれ = wBAL 点
            const bp = `bp_${si}`, bm = `bm_${si}`;
            addSlack(bp, null, wu, 'balance-diff'); addSlack(bm, null, wu, 'balance-diff');
            const lhs = terms.join(' ').replace(/^\+ /, '');
            cons.push(`balh_${si}: ${lhs} - ${bp} <= ${tol - konst}`);
            cons.push(`ball_${si}: ${lhs} + ${bm} >= ${-tol - konst}`);
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
        if (B && wLE > 0) { const t = [...realT(A.l), ...realT(B.e)]; const rhs = 1 - constOf(A.l) - constOf(B.e); if (t.length && rhs >= 0) { const v = `le_${si}_${d}`; addSlack(v, 1, wLE, 'late-early'); cons.push(`le_${si}_${d}: ${t.join(' + ')} - ${v} <= ${rhs}`); } }
        // 単発出勤（前後が休みで1日だけ出勤）。研修・固定出勤(A.c>=1)の日も対象にする
        // （checkViolations は研修も出勤として数えるため。可能なら前後どちらかに勤務を入れて孤立を防ぐ）。
        if (Pd && B && wSW > 0 && (realT(A.w).length || A.c >= 1)) { const v = `sw_${si}_${d}`; addSlack(v, 1, wSW, 'single-work'); const lhs = [...realT(A.w), ...realT(Pd.w).map(x => `- ${x}`), ...realT(B.w).map(x => `- ${x}`), `- ${v}`]; cons.push(`sw_${si}_${d}: ${(lhs.join(' + ').replace(/\+ -/g, '-')) || `- ${v}`} <= ${-A.c + Pd.c + B.c}`); }
        if (B && wCS > 0) { const v = `cs_${si}_${d}`; addSlack(v, 1, wCS, 'category-switch'); const t1 = [...realT(A.e), ...realT(B.l)]; if (t1.length) cons.push(`cs1_${si}_${d}: ${t1.join(' + ')} - ${v} <= ${1 - constOf(A.e) - constOf(B.l)}`); const t2 = [...realT(A.l), ...realT(B.e)]; if (t2.length) cons.push(`cs2_${si}_${d}: ${t2.join(' + ')} - ${v} <= ${1 - constOf(A.l) - constOf(B.e)}`); }
        // 「遅→早は連休必須」の人は、遅→休1日→早 をより強く避ける（検査側は月全体で見ている）
        const wBRm = s.needPairRest ? ruleW('pair-rest', (P.lateEarly || 9000) * 2) : wBR;
        if (B && C && wBRm > 0) { const v = `br_${si}_${d}`; addSlack(v, 1, wBRm, s.needPairRest ? 'pair-rest' : 'bad-rest'); const t = [...realT(A.l), ...realT(C.e), ...realT(B.w).map(x => `- ${x}`), `- ${v}`]; if (realT(A.l).length && realT(C.e).length) cons.push(`br_${si}_${d}: ${t.join(' + ').replace(/\+ -/g, '-')} <= ${1 - constOf(A.l) - constOf(C.e) + B.c}`); }
        // 連休の上限（設定日数を超える連続休みを避ける）: (上限+1)日の窓に最低1日の勤務を要求
        if (wLR > 0) {
          const lrWin = getMaxOffRun() + 1;
          if (d + lrWin - 1 <= days) {
            let t = [], cc = 0;
            for (let k = 0; k < lrWin; k++) { const o = cellTerms(s, d + k); cc += o.c; t = t.concat(realT(o.w)); }
            if (t.length) { const v = `lr_${si}_${d}`; addSlack(v, 1, wLR, 'long-rest'); cons.push(`lr_${si}_${d}: ${t.join(' + ')} + ${v} >= ${1 - cc}`); }
          }
        }
      }
      // 前月末シフト(prevLastShift)を反映：1日目の 遅→早（インターバル不足）と連勤中の時間帯切替。
      // checkViolations は前月末シフトを見て罰する（consWork/prevShift）のに、生成側が無視すると
      // 1日目に必ず違反が出る。境界を制約に加えて回避する。
      const pme = getPrevMonthEnd(s);
      const pls = pme.lastShift;
      if (pls) {
        const A1 = cellTerms(s, 1);
        const earlyD1 = realT(A1.e), lateD1 = realT(A1.l);
        if (isLate(pls)) {
          // 遅→早（🔴）：1日目に早番系を入れない
          if (wLE > 0 && earlyD1.length) { const v = `leb_${si}`; addSlack(v, 1, wLE, 'late-early'); cons.push(`leb_${si}: ${earlyD1.join(' + ')} - ${v} <= 0`); }
          // 連勤中の時間帯切替 遅→早（🟡）：前月から連勤継続中なので該当
          if (wCS > 0 && earlyD1.length) { const v = `csb_${si}`; addSlack(v, 1, wCS, 'category-switch'); cons.push(`csb_${si}: ${earlyD1.join(' + ')} - ${v} <= 0`); }
        } else if (isEarlyCategory(pls)) {
          // 連勤中の時間帯切替 早→遅（🟡）
          if (wCS > 0 && lateD1.length) { const v = `csb_${si}`; addSlack(v, 1, wCS, 'category-switch'); cons.push(`csb_${si}: ${lateD1.join(' + ')} - ${v} <= 0`); }
        }
        // 月をまたぐ「遅→休→早」を避ける: 早番系(2日目) − 勤務(1日目) ≤ v
        // （1日目が休みで2日目が早番系なら違反。1日目に出勤すれば成立しない）
        if (days >= 2 && isLate(pls)) {
          const A1b = cellTerms(s, 1), B1b = cellTerms(s, 2);
          const w1 = realT(A1b.w), e2 = realT(B1b.e);
          const wBad = s.needPairRest ? ruleW('pair-rest', (P.lateEarly || 9000) * 2) : wBR;
          if (wBad > 0 && (e2.length || constOf(B1b.e))) {
            const v = `brb_${si}`; addSlack(v, 1, wBad, 'bad-rest');
            const lhs = [...e2, ...w1.map(x => `- ${x}`), `- ${v}`];
            cons.push(`brb_${si}: ${lhs.join(' + ').replace(/\+ -/g, '-')} <= ${A1b.c - constOf(B1b.e)}`);
          }
        }
      }
      // 月をまたぐ「単発休み」を避ける（前月末=勤務 → 1日目=休み → 2日目=勤務）。
      // 前月末シフトの記号が未設定でも「前日が勤務だった」ことは連勤日数から分かる。
      if (days >= 2 && pme.cons > 0 && AppState.settings.penaltySingleOff) {
        const wSO = P.singleOff || 50;
        const A1c = cellTerms(s, 1), B1c = cellTerms(s, 2);
        const w1 = realT(A1c.w), w2 = realT(B1c.w);
        if (wSO > 0 && (w2.length || B1c.c)) {
          const v = `sob_${si}`; addSlack(v, 1, wSO, 'single-off');
          const lhs = [...w2, ...w1.map(x => `- ${x}`), `- ${v}`];
          cons.push(`sob_${si}: ${lhs.join(' + ').replace(/\+ -/g, '-')} <= ${A1c.c - B1c.c}`);
        }
      }
      // 前月末が休みで終わっている場合、1日目の孤立出勤（1日目=出勤・2日目=休み）も単発出勤。
      // checkViolations と揃えて、生成側でも避けるようにする。
      if (wSW > 0 && pme.cons === 0 && days >= 2) {
        const A1 = cellTerms(s, 1), B1 = cellTerms(s, 2);
        if (realT(A1.w).length || A1.c >= 1) {
          const v = `sw1_${si}`; addSlack(v, 1, wSW, 'single-work');
          const lhs = [...realT(A1.w), ...realT(B1.w).map(x => `- ${x}`), `- ${v}`];
          cons.push(`sw1_${si}: ${lhs.join(' + ').replace(/\+ -/g, '-')} <= ${-A1.c + B1.c}`);
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
                if (loResp === '1c') { if (hiT.length) { const v = `h_${band}_${d}_${sidOf[lo.id]}_${sidOf[hi.id]}`; addSlack(v, 1, wH, 'hierarchy'); cons.push(`${v}c: ${hiT.join(' + ')} - ${v} <= ${1 - hiC}`); } return; }
                const v = `h_${band}_${d}_${sidOf[lo.id]}_${sidOf[hi.id]}`; addSlack(v, 1, wH, 'hierarchy');
                const t = [loResp, ...hiT, `- ${v}`]; cons.push(`${v}c: ${t.join(' + ').replace(/\+ -/g, '-')} <= ${1 - hiC}`);
              });
            });
          }
        });
      });
    }

    if (!obj.length) obj.push('0 z_dummy'), gen.add('z_dummy'), bnd.push('0 <= z_dummy <= 0');
    const parts = { objEntries, cons, bnd, bin: [...bin], gen: [...gen], slackByType };
    const lp = composeLP(parts, null);
    return { lp, parts, slackByType, sidOf, roleIdx, roles, gStaff, days };
  }

  /**
   * モデルの部品から LP 文字列を組み立てる（段階最適化用）。
   * @param parts buildGroupModel が返す parts
   * @param opts  null なら従来どおり全ルールを一度に最小化。
   *   { types: [最小化するルール], budgets: [{ names:[変数名], max:上限 }] }
   *   budgets は「前の段で達成した件数を超えない」という約束（＝確定の固定）。
   */
  function composeLP(parts, opts) {
    const o = opts || {};
    const entries = o.types
      ? parts.objEntries.filter(e => o.types.indexOf(e.type) >= 0)
      : parts.objEntries;
    const objStr = entries.length ? entries.map(e => `${e.w} ${e.name}`).join(' + ') : '0 z_dummy';
    const extra = [];
    (o.budgets || []).forEach((b, i) => {
      if (!b.names || !b.names.length) return;
      extra.push(`bud_${i}: ${b.names.join(' + ')} <= ${b.max}`);
    });
    const gen = parts.gen.indexOf('z_dummy') >= 0 ? parts.gen : parts.gen.concat(['z_dummy']);
    const bnd = parts.bnd.concat(parts.bnd.some(x => /z_dummy/.test(x)) ? [] : ['0 <= z_dummy <= 0']);
    return `Minimize\n obj: ${objStr}\nSubject To\n ${parts.cons.concat(extra).join('\n ')}` +
           `\nBounds\n ${bnd.join('\n ')}\nBinary\n ${parts.bin.join('\n ')}` +
           `\nGeneral\n ${gen.join('\n ')}\nEnd\n`;
  }

  // 解から、指定ルールのスラック合計（＝そのルールの違反件数）を取り出す
  function slackTotal(sol, parts, types) {
    let n = 0;
    (types || []).forEach(t => (parts.slackByType[t] || []).forEach(name => {
      const c = sol.Columns && sol.Columns[name];
      if (c && c.Primal > 0) n += c.Primal;
    }));
    return Math.round(n);
  }
  function slackNames(parts, types) {
    const out = [];
    (types || []).forEach(t => (parts.slackByType[t] || []).forEach(n => out.push(n)));
    return out;
  }

  // 解を shifts に反映（固定・希望休はそのまま）
  function applyGroupSolution(model, sol, shifts) {
    const { gStaff, days, sidOf, roleIdx, roles } = model;
    gStaff.forEach(s => {
      const si = sidOf[s.id]; shifts[s.id] = shifts[s.id] || {};
      for (let d = 1; d <= days; d++) {
        const f = getFixedShiftAt(s.id, d);
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

  global.MILP = { buildGroupModel, applyGroupSolution, composeLP, slackTotal, slackNames, TIERS };
})(typeof self !== 'undefined' ? self : this);
