#!/usr/bin/env python3
"""営業スキル者を遅番から早番へ移したときの影響を、30分刻み×日付で数える。

使い方:
  python3 tools/shift_impact/analyze.py --plan <アプリの書き出しJSON> \
      --timecard <打刻CSV> --out <出力フォルダ>

  打刻CSVの列: staff_id,day,band(E=早番/L=遅番),hours(休憩を除いた労働時間),full_day(1=1日に数える)

出力: <出力フォルダ>/report.html（ブラウザで開くだけ）と result.json。
元のJSON・CSVは読むだけで書き換えない。
実データ（名前入り）は公開リポジトリに入れないこと。出力フォルダはリポジトリの外にする。
"""
import argparse
import calendar
import csv
import datetime
import html
import json
import os
from collections import defaultdict

# ── 前提（利用者に確認したもの） ─────────────────────────────
DAY_HOURS = 7.75                      # 実働（休憩1時間を除く）
SLOT_START, SLOT_END, SLOT = 7 * 60 + 30, 24 * 60 + 30, 30   # 7:30〜24:30 を30分刻み
SHIFT_TIMES = {                       # 分（24:30 = 1470）。休憩1時間を含む拘束時間
    '早責': (450, 975), '早': (450, 975),          # 7:30〜16:15
    '早総務': (465, 990),                           # 7:45〜16:30
    '遅責': (945, 1470), '遅総務': (945, 1470), '遅': (945, 1470),   # 15:45〜24:30
}
EARLY = {'早責', '早総務', '早'}
LATE = {'遅責', '遅総務', '遅'}
RESP = {'早責', '遅責'}               # 責任者＝その日に責任者のシフトに入っている人
BAND_WINDOW = {'early': SHIFT_TIMES['早'], 'late': SHIFT_TIMES['遅']}
CLOSE_FROM = 22 * 60                  # 22:00以降の締め
CLOSE_SKILL = 'P営業'                 # 締めに必要なスキル（アプリの設定で遅番帯の営業）
MOVE_SKILL = 'P営業'                  # 遅番にいる「営業」を表すスキル
MOVED_SHIFT = '早'                    # 移した人の早番のシフト（早番の時間は動かさない）


def slots():
    return list(range(SLOT_START, SLOT_END, SLOT))


def fmt(m):
    return f'{m // 60}:{m % 60:02d}'


def covers(times, s):
    """30分のコマ全体にいるときだけ数える（途中から・途中までは数えない）"""
    a, b = times
    return a <= s and s + SLOT <= b


# ── 読み込み ────────────────────────────────────────────
def load_plan(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_timecard(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            rows.append({'id': r['staff_id'], 'day': int(r['day']), 'band': r['band'],
                         'hours': float(r['hours']), 'full': r['full_day'] == '1'})
    return rows


# ── 定数（30分ごとの必要人数） ──────────────────────────────
def role_req(plan, role, day):
    dr = plan.get('dailyRequirements', {}).get(role, {})
    if str(day) in dr:
        return int(dr[str(day)])
    return int(plan.get('roleRequirements', {}).get(role, 0))


def skill_req(plan, sk, day):
    ds = plan.get('dailySkills', {}).get(sk['name'], {}).get(str(day))
    if ds and 'req' in ds:
        return int(ds['req'])
    return int(sk.get('req', 0))


# ── 1か月を数える ────────────────────────────────────────
def evaluate(plan, shifts, ndays):
    staff = {s['id']: s for s in plan['staff']}
    skills = plan.get('skills', [])
    out = {'cells': {}, 'days': {}}
    for d in range(1, ndays + 1):
        on = {i: shifts[i].get(str(d)) for i in shifts}
        on = {i: v for i, v in on.items() if v in SHIFT_TIMES}
        for s in slots():
            here = [i for i, v in on.items() if covers(SHIFT_TIMES[v], s)]
            req = sum(role_req(plan, r, d) for r in SHIFT_TIMES if covers(SHIFT_TIMES[r], s))
            cell = {'req': req, 'have': len(here), 'diff': len(here) - req}
            sk_short = {}
            for sk in skills:
                if not covers(BAND_WINDOW[sk['target']], s):
                    continue
                need = skill_req(plan, sk, d)
                have = sum(sk['name'] in (staff[i].get('skills') or []) for i in here)
                sk_short[sk['name']] = {'req': need, 'have': have, 'short': max(0, need - have)}
            resp = sum(on[i] in RESP for i in here)
            cell['skills'] = sk_short
            cell['resp'] = resp
            cell['resp_short'] = 0 if resp >= 1 else 1
            cell['sales_short'] = max([v['short'] for v in sk_short.values()] or [0])
            close_have = sum(CLOSE_SKILL in (staff[i].get('skills') or []) for i in here)
            cell['close_short'] = 1 if s >= CLOSE_FROM and close_have < 1 else 0
            cell['total_short'] = max(0, -cell['diff'])
            # 延長で埋めるときに要る人数（責任者と営業の両方を持つ人が延長すれば同時に埋まるので最大をとる）
            cell['fill'] = max(cell['total_short'], cell['sales_short'], cell['resp_short'], cell['close_short'])
            out['cells'][(d, s)] = cell
    return out


def summarize(ev, ndays):
    cells = ev['cells']
    n = len(cells)
    tot_ok = sum(c['diff'] >= 0 for c in cells.values())
    sales_cells = [c for c in cells.values() if c['skills']]
    sales_ok = sum(c['sales_short'] == 0 for c in sales_cells)
    resp_ok = sum(c['resp_short'] == 0 for c in cells.values())
    all_ok = sum(c['fill'] == 0 for c in cells.values())
    close_fail_days = sorted({d for (d, s), c in cells.items() if c['close_short']})
    resp_fail_days = sorted({d for (d, s), c in cells.items() if c['resp_short']})
    hidden = sum(c['fill'] for c in cells.values()) * SLOT / 60
    hidden_by_day = defaultdict(float)
    for (d, s), c in cells.items():
        hidden_by_day[d] += c['fill'] * SLOT / 60
    return {
        'slots': n,
        'rate_total': tot_ok / n, 'rate_sales': sales_ok / len(sales_cells) if sales_cells else 1,
        'rate_resp': resp_ok / n, 'rate_all': all_ok / n,
        'ok_all': all_ok,
        'close_fail_days': close_fail_days, 'resp_fail_days': resp_fail_days,
        'hidden_hours': hidden, 'hidden_by_day': dict(hidden_by_day),
    }


def runs(cells, ndays, key):
    """同じ日に続くコマをまとめた一覧"""
    res = []
    for d in range(1, ndays + 1):
        cur = None
        for s in slots():
            c = cells[(d, s)]
            v = key(c)
            if v:
                label = v
                if cur and cur['label'] == label and cur['end'] == s:
                    cur['end'] = s + SLOT
                else:
                    if cur:
                        res.append(cur)
                    cur = {'day': d, 'start': s, 'end': s + SLOT, 'label': label}
            else:
                if cur:
                    res.append(cur)
                cur = None
        if cur:
            res.append(cur)
    return res


def shortage_label(c):
    parts = []
    if c['total_short']:
        parts.append(f"人数 −{c['total_short']}")
    for name, v in c['skills'].items():
        if v['short']:
            parts.append(f"{name} −{v['short']}")
    if c['resp_short']:
        parts.append('責任者 0人')
    return '／'.join(parts)


def surplus_label(c):
    return f"+{c['diff']}" if c['diff'] > 0 else ''


# ── 案を作る ─────────────────────────────────────────────
def move_all_late_sales(plan, shifts, ndays):
    """その日に遅番帯へ入っている営業スキル者（P営業）を全員早番へ。ほかの人は動かさない。"""
    staff = {s['id']: s for s in plan['staff']}
    new = {i: dict(v) for i, v in shifts.items()}
    moved = []
    for d in range(1, ndays + 1):
        for i in new:
            v = new[i].get(str(d))
            if v in LATE and MOVE_SKILL in (staff[i].get('skills') or []):
                new[i][str(d)] = MOVED_SHIFT
                moved.append((i, d, v))
    return new, moved


def move_keep_one(plan, shifts, ndays):
    """参考の案: 遅番に営業が定数より多い日だけ、余っている人（遅責でない人）を早番へ。"""
    staff = {s['id']: s for s in plan['staff']}
    sk = next((s for s in plan.get('skills', []) if s['name'] == MOVE_SKILL), None)
    new = {i: dict(v) for i, v in shifts.items()}
    moved = []
    for d in range(1, ndays + 1):
        need = max(1, skill_req(plan, sk, d) if sk else 1)
        late = [i for i in new if new[i].get(str(d)) in LATE and MOVE_SKILL in (staff[i].get('skills') or [])]
        extra = len(late) - need
        for i in sorted(late, key=lambda i: new[i][str(d)] == '遅責'):
            if extra <= 0:
                break
            if new[i][str(d)] == '遅責':
                continue
            moved.append((i, d, new[i][str(d)]))
            new[i][str(d)] = MOVED_SHIFT
            extra -= 1
    return new, moved


# ── 残業（9月の実績から見込む） ─────────────────────────────
def overtime_profile(tc):
    by = defaultdict(list)
    for r in tc:
        if r['full']:
            ot = max(0.0, r['hours'] - DAY_HOURS)
            by[(r['id'], r['band'])].append(ot)
            by[(r['id'], '*')].append(ot)
            by[('*', r['band'])].append(ot)
    avg = {k: sum(v) / len(v) for k, v in by.items() if v}
    sept_total = defaultdict(float)
    sept_days = defaultdict(int)
    for r in tc:
        if r['full']:
            sept_total[r['id']] += max(0.0, r['hours'] - DAY_HOURS)
            sept_days[r['id']] += 1
    return avg, dict(sept_total), dict(sept_days), {k: len(v) for k, v in by.items()}


def ot_rate(avg, sid, band):
    for k in ((sid, band), (sid, '*'), ('*', band)):
        if k in avg:
            return avg[k], k
    return 0.0, None


def project_overtime(plan, shifts, avg, ndays):
    res = {}
    for s in plan['staff']:
        sid = s['id']
        days = 0
        ot = 0.0
        for d in range(1, ndays + 1):
            v = shifts[sid].get(str(d))
            if v in EARLY or v == '研':
                band = 'E'
            elif v in LATE:
                band = 'L'
            elif v == '余':
                band = '*'
            else:
                continue
            days += 1
            ot += ot_rate(avg, sid, band)[0] if band != '*' else avg.get((sid, '*'), 0.0)
        res[sid] = {'days': days, 'scheduled': days * DAY_HOURS, 'ot': ot, 'actual': days * DAY_HOURS + ot}
    return res


# ── HTML ─────────────────────────────────────────────────
def esc(x):
    return html.escape(str(x))


def heatmap_svg(cells, ndays, year, month, metric, title):
    """metric(cell) -> ('short'|'ok'|'over', 数, 説明)"""
    cw, ch, left, top = 16, 12, 40, 30
    sl = slots()
    w = left + cw * ndays + 4
    h = top + ch * len(sl) + 4
    out = [f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{esc(title)}">']
    for d in range(1, ndays + 1):
        x = left + (d - 1) * cw
        wd = '月火水木金土日'[datetime.date(year, month, d).weekday()]
        cls = 'ax we' if wd in '土日' else 'ax'
        out.append(f'<text class="{cls}" x="{x + cw / 2}" y="12" text-anchor="middle">{d}</text>')
        out.append(f'<text class="{cls}" x="{x + cw / 2}" y="24" text-anchor="middle">{wd}</text>')
    for j, s in enumerate(sl):
        y = top + j * ch
        if s % 60 == 0 or j == 0:
            out.append(f'<text class="ax" x="{left - 4}" y="{y + ch - 2}" text-anchor="end">{fmt(s)}</text>')
        for d in range(1, ndays + 1):
            kind, n, tip = metric(cells[(d, s)])
            x = left + (d - 1) * cw
            out.append(f'<rect class="c-{kind}" x="{x + 1}" y="{y + 1}" width="{cw - 2}" height="{ch - 2}" rx="2">'
                       f'<title>{month}/{d} {fmt(s)}〜{fmt(s + SLOT)}　{esc(tip)}</title></rect>')
            if kind == 'short' and n > 1:
                out.append(f'<text class="cn" x="{x + cw / 2}" y="{y + ch - 3}" text-anchor="middle">{n}</text>')
    out.append('</svg>')
    return ''.join(out)


def m_total(c):
    if c['diff'] < 0:
        return 'short', -c['diff'], f"不足 {-c['diff']}人（配置{c['have']}／定数{c['req']}）"
    if c['diff'] > 0:
        return 'over', c['diff'], f"過剰 +{c['diff']}人（配置{c['have']}／定数{c['req']}）"
    return 'ok', 0, f"充足（配置{c['have']}／定数{c['req']}）"


def m_sales(c):
    if not c['skills']:
        return 'na', 0, '営業の定数なし'
    tip = '　'.join(f"{k} {v['have']}/{v['req']}" for k, v in c['skills'].items())
    sh = max(c['sales_short'], c['close_short'])
    if sh:
        return 'short', sh, '不足　' + tip
    over = any(v['have'] > v['req'] for v in c['skills'].values())
    return ('over' if over else 'ok'), 0, ('過剰　' if over else '充足　') + tip


def m_resp(c):
    if c['resp_short']:
        return 'short', 1, '責任者 0人'
    return ('over' if c['resp'] > 1 else 'ok'), 0, f"責任者 {c['resp']}人"


def bars_svg(groups, series, maxv, title, unit='', height=220):
    """groups: [(ラベル, [値…])]。series: [(名前, cssクラス)]。Y軸は maxv で固定。"""
    n, k = len(groups), len(series)
    step = max(1, -(-int(round(maxv)) // 4))      # 目盛りを整数にそろえる
    maxv = step * 4
    bw, gap, left, top, bottom = 22, 2, 36, 22, 40
    gw = k * bw + (k - 1) * gap + 22
    w = left + gw * n + 10
    ph = height - top - bottom
    out = [f'<svg viewBox="0 0 {w} {height}" width="{w}" height="{height}" role="img" aria-label="{esc(title)}">']
    for t in range(0, 5):
        v = maxv * t / 4
        y = top + ph - ph * t / 4
        out.append(f'<line class="grid" x1="{left}" x2="{w - 6}" y1="{y}" y2="{y}"/>'
                   f'<text class="ax" x="{left - 4}" y="{y + 4}" text-anchor="end">{round(v)}</text>')
    for gi, (lab, vals) in enumerate(groups):
        gx = left + gi * gw + 11
        for si, v in enumerate(vals):
            x = gx + si * (bw + gap)
            hh = 0 if maxv == 0 else ph * max(0, v) / maxv
            y = top + ph - hh
            out.append(f'<rect class="{series[si][1]}" x="{x}" y="{y}" width="{bw}" height="{max(hh, 0.5)}" rx="3">'
                       f'<title>{esc(lab)} {esc(series[si][0])}: {round(v)}{unit}</title></rect>')
            out.append(f'<text class="lbl" x="{x + bw / 2}" y="{y - 4}" text-anchor="middle">{round(v)}</text>')
        out.append(f'<text class="ax" x="{gx + (k * bw) / 2}" y="{top + ph + 16}" text-anchor="middle">{esc(lab)}</text>')
    out.append('</svg>')
    return ''.join(out)


CSS = """
:root{--bg:#fcfcfb;--card:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;
--short:#b42318;--ok:#efeeea;--over:#b7d3f6;--na:#fafaf8;--a:#2a78d6;--b:#eb6834;--bad:#b42318;--good:#1f7a3a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#1a1a19;--card:#222220;--ink:#fff;--ink2:#c3c2b7;
--line:#3a3a37;--short:#e66767;--ok:#2c2c2a;--over:#184f95;--na:#1f1f1d;--a:#3987e5;--b:#d95926;--bad:#e66767;--good:#4cc27a}}
:root[data-theme="dark"]{--bg:#1a1a19;--card:#222220;--ink:#fff;--ink2:#c3c2b7;--line:#3a3a37;--short:#e66767;--ok:#2c2c2a;
--over:#184f95;--na:#1f1f1d;--a:#3987e5;--b:#d95926;--bad:#e66767;--good:#4cc27a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:16px 0 6px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.verdict{border-left:6px solid var(--bad)}.verdict p{margin:2px 0}.v{font-size:20px;font-weight:700;color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.tile .k{color:var(--ink2);font-size:12px}.tile .n{font-size:22px;font-weight:700}
.scroll{overflow-x:auto}svg text{fill:var(--ink2);font-size:10px}svg .we{fill:var(--bad)}svg .lbl{fill:var(--ink);font-size:11px}svg .cn{fill:#fff;font-size:8px}
.c-short{fill:var(--short)}.c-ok{fill:var(--ok)}.c-over{fill:var(--over)}.c-na{fill:var(--na)}.grid{stroke:var(--line)}
.s-a{fill:var(--a)}.s-b{fill:var(--b)}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--ink2);font-size:12px;margin:4px 0}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:4px}
.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.pair>*,.tiles>*{min-width:0}@media (max-width:900px){.pair{grid-template-columns:minmax(0,1fr)}}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
td.r,th.r{text-align:right}.bad{color:var(--bad);font-weight:600}.good{color:var(--good)}details{margin:6px 0}summary{cursor:pointer;color:var(--ink2)}
ul{padding-left:20px}.muted{color:var(--ink2);font-size:12px}
"""


def rate(x):
    return f'{round(x * 100)}%'


def build_html(ctx):
    P = ctx
    y, m, nd = P['year'], P['month'], P['ndays']
    b, a = P['before'], P['after']
    sb, sa = b['sum'], a['sum']
    names = P['names']
    H = []
    H.append(f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
             f'<title>営業早番移動の影響</title><style>{CSS}</style></head><body><main>')
    H.append(f'<h1>営業スキル者を遅番→早番へ移す影響（{y}年{m}月）</h1>')
    H.append(f'<div class="card verdict"><div class="v">結論：{esc(P["verdict"])}</div>')
    for line in P['verdict_lines']:
        H.append(f'<p>{esc(line)}</p>')
    H.append('</div>')

    # 指標のタイル
    def tile(k, before, after, worse):
        cls = 'bad' if worse else 'good'
        return f'<div class="card tile"><div class="k">{esc(k)}</div><div class="n">{esc(before)} → <span class="{cls}">{esc(after)}</span></div></div>'
    H.append('<div class="tiles">')
    H.append(tile('充足率（全部の条件）', rate(sb['rate_all']), rate(sa['rate_all']), sa['rate_all'] < sb['rate_all']))
    H.append(tile('22時以降に営業0人の日', f"{len(sb['close_fail_days'])}日", f"{len(sa['close_fail_days'])}日",
                  len(sa['close_fail_days']) > len(sb['close_fail_days'])))
    H.append(tile('責任者0人のコマがある日', f"{len(sb['resp_fail_days'])}日", f"{len(sa['resp_fail_days'])}日",
                  len(sa['resp_fail_days']) > len(sb['resp_fail_days'])))
    H.append(tile('隠れ残業（延長で埋める時間・月）', f"{round(sb['hidden_hours'])}時間", f"{round(sa['hidden_hours'])}時間",
                  sa['hidden_hours'] > sb['hidden_hours']))
    H.append(tile('見込み残業の合計（10人・月）', f"{round(P['ot_before_total'])}時間", f"{round(P['ot_after_total'])}時間",
                  P['ot_after_total'] > P['ot_before_total']))
    H.append('</div>')

    # 充足率
    H.append('<h2>充足率</h2>')
    cats = [('全体の人数', 'rate_total'), ('営業', 'rate_sales'), ('責任者', 'rate_resp'), ('全部の条件', 'rate_all')]
    worst = min(cats, key=lambda c: sa[c[1]] - sb[c[1]])
    H.append(f'<h3>{esc(worst[0])}の充足率が {rate(sb[worst[1]])} → {rate(sa[worst[1]])} に下がる</h3>')
    H.append('<div class="legend"><span><i class="sw s-a" style="background:var(--a)"></i>現行案</span>'
             '<span><i class="sw" style="background:var(--b)"></i>移した案</span></div>')
    H.append('<div class="scroll">' + bars_svg([(c[0], [sb[c[1]] * 100, sa[c[1]] * 100]) for c in cats],
                                                [('現行案', 's-a'), ('移した案', 's-b')], 100, '充足率', '%') + '</div>')
    H.append(f'<p class="muted">充足率 ＝ 定数を満たしたコマ数 ÷ 全コマ数。全コマ＝{nd}日×{len(slots())}コマ（7:30〜24:30）＝{sb["slots"]}。'
             '営業は定数のある時間帯のコマだけで数える。</p>')

    # ヒートマップ
    H.append('<h2>時間帯×日付のヒートマップ</h2>')
    H.append('<div class="legend"><span><i class="sw" style="background:var(--short)"></i>不足（数字は不足人数、1人は数字なし）</span>'
             '<span><i class="sw" style="background:var(--ok)"></i>充足</span><span><i class="sw" style="background:var(--over)"></i>過剰</span>'
             '<span class="muted">マスにマウスを置くと中身が出ます</span></div>')
    for label, fn, key in [('全体の人数', m_total, 'total'), ('営業スキル（S営業＝早番帯・P営業＝遅番帯）', m_sales, 'sales'),
                           ('責任者（どの時間も1人以上）', m_resp, 'resp')]:
        H.append(f'<h3>{esc(P["heat_titles"][key])}</h3><div class="pair">')
        for nm, ev in (('現行案', b), ('移した案', a)):
            H.append(f'<div class="card"><div class="muted">{esc(label)}｜{nm}</div><div class="scroll">'
                     + heatmap_svg(ev['ev']['cells'], nd, y, m, fn, f'{label} {nm}') + '</div></div>')
        H.append('</div>')

    # 締め
    H.append('<h2>22:00以降の締めに営業スキル者がいるか</h2>')
    H.append(f'<h3>{esc(P["close_title"])}</h3><div class="scroll"><table><tr><th>日</th>')
    for d in range(1, nd + 1):
        H.append(f'<th class="r">{d}</th>')
    H.append('</tr>')
    for nm, s in (('現行案', sb), ('移した案', sa)):
        H.append(f'<tr><td>{nm}</td>')
        for d in range(1, nd + 1):
            H.append('<td class="r bad">✗</td>' if d in s['close_fail_days'] else '<td class="r good">○</td>')
        H.append('</tr>')
    H.append('</table></div>')
    H.append(f'<p class="muted">{fmt(CLOSE_FROM)}〜{fmt(SLOT_END)} の各コマに、{CLOSE_SKILL} を持つ人が1人以上いれば○。</p>')

    # 残業
    H.append('<h2>個人別の残業（実働 − 所定）</h2>')
    H.append(f'<h3>{esc(P["ot_title"])}</h3>')
    H.append('<div class="legend"><span><i class="sw" style="background:var(--a)"></i>現行案</span>'
             '<span><i class="sw" style="background:var(--b)"></i>移した案</span><span class="muted">単位：時間／月</span></div>')
    rows = P['ot_rows']
    maxv = max([1] + [max(r['before'], r['after']) for r in rows])
    maxv = (int(maxv) // 5 + 1) * 5
    H.append('<div class="scroll">' + bars_svg([(names[r['id']], [r['before'], r['after']]) for r in rows],
                                                [('現行案', 's-a'), ('移した案', 's-b')], maxv, '個人別残業', '時間') + '</div>')
    H.append('<div class="scroll"><table><tr><th>名前</th><th class="r">出勤日</th><th class="r">所定</th>'
             '<th class="r">実働（現行）</th><th class="r">残業（現行）</th><th class="r">実働（移した案）</th><th class="r">残業（移した案）</th>'
             '<th class="r">差</th><th class="r">移した日数</th><th class="r">9月の残業（実績）</th></tr>')
    for r in rows:
        d = r['after'] - r['before']
        cls = 'bad' if round(d) > 0 else ('good' if round(d) < 0 else '')
        H.append(f'<tr><td>{esc(names[r["id"]])}</td><td class="r">{r["days"]}</td><td class="r">{round(r["scheduled"])}</td>'
                 f'<td class="r">{round(r["actual_before"])}</td><td class="r">{round(r["before"])}</td>'
                 f'<td class="r">{round(r["actual_after"])}</td><td class="r">{round(r["after"])}</td>'
                 f'<td class="r {cls}">{"+" if round(d) > 0 else ""}{round(d)}</td><td class="r">{r["moved"]}</td>'
                 f'<td class="r">{round(r["sept"])}</td></tr>')
    H.append('</table></div>')
    H.append('<p class="muted">残業の見込み＝その月の出勤日ごとに、本人の9月の「1日あたりの残業」（早番・遅番で別）を足したもの。'
             '9月にその時間帯で働いていない人は、本人の全体の平均を使う。隠れ残業は含めない（下の節）。</p>')

    # 隠れ残業
    H.append('<h2>隠れ残業：不足を延長勤務で埋めると必要な時間</h2>')
    H.append(f'<h3>{esc(P["hidden_title"])}</h3>')
    hb = [sb['hidden_by_day'].get(d, 0) for d in range(1, nd + 1)]
    ha = [sa['hidden_by_day'].get(d, 0) for d in range(1, nd + 1)]
    mx = max([1] + hb + ha)
    mx = (int(mx) // 2 + 1) * 2
    H.append('<div class="legend"><span><i class="sw" style="background:var(--a)"></i>現行案</span>'
             '<span><i class="sw" style="background:var(--b)"></i>移した案</span><span class="muted">単位：時間／日</span></div>')
    H.append('<div class="scroll">' + bars_svg([(str(d), [hb[d - 1], ha[d - 1]]) for d in range(1, nd + 1)],
                                                [('現行案', 's-a'), ('移した案', 's-b')], mx, '隠れ残業', '時間', 200) + '</div>')
    H.append('<p class="muted">各コマで「人数の不足・営業の不足・責任者0人・締めの営業0人」のうち最も大きい人数を、延長して埋める人数とした'
             '（責任者と営業の両方を持つ人が延長すれば同時に埋まるため）。早番の時間は動かせないので、遅番帯の不足は早番の人の居残り（残業）になる。</p>')
    H.append(f'<p>{esc(P["hidden_note"])}</p>')

    # 一覧
    for nm, ev in (('現行案', b), ('移した案', a)):
        sh = ev['short_runs']
        ov = ev['over_runs']
        H.append(f'<h2>不足コマ・過剰コマの一覧（{nm}）</h2>')
        H.append(f'<details {"open" if nm == "移した案" else ""}><summary>不足 {len(sh)}件</summary><div class="scroll"><table>'
                 '<tr><th>日付</th><th>時間帯</th><th>不足（人数・スキル）</th></tr>')
        for r in sh:
            H.append(f'<tr><td>{m}/{r["day"]}（{"月火水木金土日"[datetime.date(y, m, r["day"]).weekday()]}）</td>'
                     f'<td>{fmt(r["start"])}〜{fmt(r["end"])}</td><td class="bad">{esc(r["label"])}</td></tr>')
        H.append('</table></div></details>')
        H.append(f'<details><summary>過剰 {len(ov)}件（全体の人数が定数より多い時間帯）</summary><div class="scroll"><table>'
                 '<tr><th>日付</th><th>時間帯</th><th>過剰人数</th></tr>')
        for r in ov:
            H.append(f'<tr><td>{m}/{r["day"]}</td><td>{fmt(r["start"])}〜{fmt(r["end"])}</td><td>{esc(r["label"])}</td></tr>')
        H.append('</table></div></details>')

    # 参考の案
    k = P['keep']
    H.append('<h2>参考：遅番に営業を1人残して、余っている人だけ移す案</h2>')
    H.append(f'<div class="card"><p>移せる日：{esc(k["days_text"])}（{k["n"]}人日）。'
             f'充足率（全部の条件）{rate(sb["rate_all"])} → {rate(k["sum"]["rate_all"])}、'
             f'22時以降に営業0人の日 {len(k["sum"]["close_fail_days"])}日、責任者0人の日 {len(k["sum"]["resp_fail_days"])}日、'
             f'隠れ残業 {round(k["sum"]["hidden_hours"])}時間／月、見込み残業の合計 {round(k["ot_total"])}時間（現行 {round(P["ot_before_total"])}時間）。</p></div>')

    # 移した内容
    H.append('<h2>移した内容（移した案）</h2><details><summary>一覧（{0}人日）</summary><div class="scroll"><table>'
             '<tr><th>日付</th><th>名前</th><th>現行</th><th>移した案</th></tr>'.format(len(P['moved'])))
    for sid, d, v in sorted(P['moved'], key=lambda t: (t[1], t[0])):
        H.append(f'<tr><td>{m}/{d}</td><td>{esc(names[sid])}</td><td>{esc(v)}</td><td>{MOVED_SHIFT}</td></tr>')
    H.append('</table></div></details>')

    # 前提
    H.append('<h2>前提と仮定</h2><ul>')
    for t in P['assumptions']:
        H.append(f'<li>{esc(t)}</li>')
    H.append('</ul><p class="muted">再計算: python3 tools/shift_impact/analyze.py --plan &lt;JSON&gt; --timecard &lt;CSV&gt; --out &lt;フォルダ&gt;</p>')
    H.append('</main></body></html>')
    return ''.join(H)


# ── 全体の流れ ─────────────────────────────────────────────
def run(plan_path, tc_path, out_dir):
    plan = load_plan(plan_path)
    tc = load_timecard(tc_path)
    y, m = map(int, plan['settings']['targetMonth'].split('-'))
    nd = calendar.monthrange(y, m)[1]
    names = {s['id']: s['name'] for s in plan['staff']}
    base = plan['shifts']

    def pack(shifts):
        ev = evaluate(plan, shifts, nd)
        return {'ev': ev, 'sum': summarize(ev, nd),
                'short_runs': runs(ev['cells'], nd, lambda c: shortage_label(c) if c['fill'] else ''),
                'over_runs': runs(ev['cells'], nd, surplus_label)}

    after_shifts, moved = move_all_late_sales(plan, base, nd)
    keep_shifts, keep_moved = move_keep_one(plan, base, nd)
    b, a, k = pack(base), pack(after_shifts), pack(keep_shifts)

    avg, sept, sept_days, _ = overtime_profile(tc)
    ob = project_overtime(plan, base, avg, nd)
    oa = project_overtime(plan, after_shifts, avg, nd)
    ok_ = project_overtime(plan, keep_shifts, avg, nd)
    moved_n = defaultdict(int)
    for sid, d, v in moved:
        moved_n[sid] += 1
    rows = [{'id': s['id'], 'days': ob[s['id']]['days'], 'scheduled': ob[s['id']]['scheduled'],
             'before': ob[s['id']]['ot'], 'after': oa[s['id']]['ot'],
             'actual_before': ob[s['id']]['actual'], 'actual_after': oa[s['id']]['actual'],
             'moved': moved_n[s['id']], 'sept': sept.get(s['id'], 0.0)} for s in plan['staff']]
    ot_b = sum(r['before'] for r in rows)
    ot_a = sum(r['after'] for r in rows)
    sb, sa = b['sum'], a['sum']

    # 結論
    hard = len(sa['close_fail_days']) > len(sb['close_fail_days']) or len(sa['resp_fail_days']) > len(sb['resp_fail_days'])
    if hard:
        verdict = '不可能（このままでは組めない）'
    elif sa['hidden_hours'] > sb['hidden_hours'] or ot_a > ot_b:
        verdict = '条件付きで可能'
    else:
        verdict = '可能'
    hd = sorted(h for h in sa['hidden_by_day'].values() if h > 0) or [0]
    per_day = hd[len(hd) // 2]          # 1日あたり（真ん中の値）
    lines = [
        f"遅番の営業スキル者を全員早番へ移すと、22時以降に営業が0人の日が {len(sb['close_fail_days'])}日→{len(sa['close_fail_days'])}日、"
        f"遅番の責任者が0人になる日が {len(sb['resp_fail_days'])}日→{len(sa['resp_fail_days'])}日。",
        f"営業も責任者も持たない遅番の人では埋められず、早番の居残りで埋めると隠れ残業が月 {round(sb['hidden_hours'])}→{round(sa['hidden_hours'])}時間"
        f"（1日あたり約{round(per_day)}時間）。",
        f"遅番に営業を1人残し、余っている人だけ移す案なら締め・責任者は毎日守れるが、移せるのは {len(keep_moved)}人日だけで、"
        f"遅番の人数が1人減るぶん隠れ残業が月 {round(k['sum']['hidden_hours'])}時間出る。",
    ]
    keep_days = sorted({d for _, d, _ in keep_moved})
    ctx = {
        'year': y, 'month': m, 'ndays': nd, 'names': names, 'before': b, 'after': a,
        'verdict': verdict, 'verdict_lines': lines, 'moved': moved,
        'ot_rows': rows, 'ot_before_total': ot_b, 'ot_after_total': ot_a,
        'heat_titles': {
            'total': f"全体の人数：不足コマ {sum(c['diff'] < 0 for c in b['ev']['cells'].values())}→{sum(c['diff'] < 0 for c in a['ev']['cells'].values())}、"
                     f"移した案は遅番帯が毎日 −{max(0, -min(c['diff'] for c in a['ev']['cells'].values()))}人まで不足、早番帯は過剰",
            'sales': f"営業：移した案は遅番帯（15:45〜24:30）の P営業が {len({d for (d, s), c in a['ev']['cells'].items() if c['skills'].get('P営業', {}).get('short')})}日で不足",
            'resp': f"責任者：移した案は {len(sa['resp_fail_days'])}日で遅番の時間に責任者がいない",
        },
        'close_title': f"締めの営業：現行案 {nd - len(sb['close_fail_days'])}/{nd}日 → 移した案 {nd - len(sa['close_fail_days'])}/{nd}日",
        'ot_title': (f"見込み残業の合計は {round(ot_b)}→{round(ot_a)}時間：遅番の居残りが減るぶん、移した人の残業はむしろ減る"
                     if ot_a < ot_b else f"見込み残業の合計は {round(ot_b)}→{round(ot_a)}時間"),
        'hidden_title': f"移した案は、遅番帯の穴を延長で埋めると月 {round(sa['hidden_hours'])}時間（現行 {round(sb['hidden_hours'])}時間）",
        'hidden_note': f"移した案の隠れ残業は、ふつうの日で1日約{round(per_day)}時間（遅番に営業が2人いた日はその2倍）。早番（16:15まで）の人が24:30まで残る計算になり、1日の拘束が17時間に"
                       "なるため、延長では現実的に埋められない（人を足すか、移す人を減らす必要がある）。",
        'keep': {'sum': k['sum'], 'n': len(keep_moved), 'ot_total': sum(v['ot'] for v in ok_.values()),
                 'days_text': '、'.join(f'{m}/{d}' for d in keep_days) or 'なし'},
        'assumptions': [
            '勤務時間（利用者の指定）: 早番・早番責任者 7:30〜16:15、早番総務 7:45〜16:30、遅番・遅番責任者・遅番総務 15:45〜24:30。どれも休憩1時間・実働7時間45分。',
            '休憩の時間帯は分からないので、休憩中も店にいるものとして数えた。',
            '30分のコマ全体にいる人だけを数えた（7:45始業の人は7:30〜8:00には数えない、16:15終業の人は16:00〜16:30には数えない）。定数も同じ数え方。そのため、現行案で S営業 の人が早番総務（7:45始業）に入っている日は、7:30〜8:00 の S営業 が1人足りない形になる（7日・各30分）。',
            '定数（30分ごと）: アプリの「日ごとの必要人数」（早責1・早総務1・早1／遅責1・遅総務1・遅1、日ごとの上書きあり）を、その勤務の時間に当てはめた（30分ごとの表は無い）。',
            '営業の定数: アプリの設定どおり。S営業＝早番帯に2人、P営業＝遅番帯に1人（1日・2日は2人）。締め（22:00以降）は P営業 で確かめた。',
            '責任者: その日に「早番責任者」「遅番責任者」のシフトに入っている人。早番の始まり（7:30）から遅番の終わり（24:30）まで、どのコマも1人以上。',
            '移した案: 各日に遅番帯（遅責・遅総務・遅）に入っている P営業 を持つ人を全員「早番」にした。ほかの人のシフトは動かしていない（早番の時間は動かせず、遅番の時間をずらしても遅番の人は営業・責任者を持たないため、穴は埋まらない）。',
            '「余」は出勤予定の日として残業・所定の計算に入れたが、早番か遅番か分からないので30分ごとの人数には入れていない。研修（研）は人数に数えない。',
            f'所定＝出勤予定日数×7時間45分。残業の見込み＝出勤日ごとに本人の9月の1日あたり残業（早番・遅番で別）を足したもの。9月の打刻で4時間以下の日（1日に数えない日）は平均から外した。',
            '9月の打刻の「労働時間」は、開始から退勤までから休憩1時間を引いたもの。開始が12時前の日を早番、12時以降を遅番とした。',
            '数値は整数に丸めて表示しているので、合計と内訳が1ずれることがある。',
        ],
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'report.html'), 'w', encoding='utf-8') as f:
        f.write(build_html(ctx))
    result = {
        'verdict': verdict, 'lines': lines,
        'before': {k2: v for k2, v in sb.items() if k2 != 'hidden_by_day'},
        'after': {k2: v for k2, v in sa.items() if k2 != 'hidden_by_day'},
        'keep_one': {k2: v for k2, v in k['sum'].items() if k2 != 'hidden_by_day'}, 'keep_moved': len(keep_moved),
        'moved': len(moved), 'overtime': rows, 'ot_before_total': ot_b, 'ot_after_total': ot_a,
        'sept_avg': {f'{k1}|{k2}': v for (k1, k2), v in avg.items()},
    }
    with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    return result


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--timecard', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    r = run(args.plan, args.timecard, args.out)
    print('結論:', r['verdict'])
    for line in r['lines']:
        print(' ', line)
