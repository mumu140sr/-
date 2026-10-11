# 見た目を変えても JS が探す要素・文字・押せない状態が残っているかを確かめる（v250〜）。
# 使い方（リポジトリの一番上で）:
#   python3 tools/ui-contract-check.py            … tools/ui-contract.txt と照らし合わせる（欠けがあれば終了コード 1）
#   python3 tools/ui-contract-check.py --build    … 今のコードから一覧を作り直して表示する（一覧を更新するときだけ）
import re, sys, os, glob, json

def js_files(repo):
    return sorted(glob.glob(os.path.join(repo, 'js', '*.v6.js')))

STR = r"""('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)"""

def selector_parts(sel):
    sel = re.sub(r'\$\{[^}]*\}', '', sel)          # テンプレートの差し込みは外す
    ids = re.findall(r'#([A-Za-z_][\w-]*)', sel)
    cls = re.findall(r'\.([A-Za-z_][\w-]*)', sel)
    attrs = re.findall(r'\[([A-Za-z_][\w-]*)', sel)
    return ids, cls, attrs

def extract(repo):
    ids, cls, attrs = {}, {}, {}
    def add(d, k, where):
        d.setdefault(k, set()).add(where)
    for f in js_files(repo):
        name = os.path.basename(f)
        src = open(f, encoding='utf-8').read()
        for m in re.finditer(r'getElementById\(\s*' + STR, src):
            s = m.group(1)[1:-1]
            if '${' in s: continue
            add(ids, s, name)
        for m in re.finditer(r'(?:querySelectorAll|querySelector|closest|matches)\(\s*' + STR, src):
            s = m.group(1)[1:-1]
            i, c, a = selector_parts(s)
            for x in i: add(ids, x, name)
            for x in c: add(cls, x, name)
            for x in a: add(attrs, x, name)
        for m in re.finditer(r'classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)', src):
            for s in re.findall(STR, m.group(1)):
                v = s[1:-1]
                if '${' in v or not v: continue
                add(cls, v, name)
        # 古い書き方: '#' + 'id' / modal.querySelector('#' + id) の $ ヘルパー
        for m in re.finditer(r"\$\(\s*'([A-Za-z_][\w-]*)'\s*\)", src):
            add(ids, m.group(1), name + '($)')
    return ids, cls, attrs

def where_defined(repo, kind, name):
    html = open(os.path.join(repo, 'index.html'), encoding='utf-8').read()
    jsall = ''.join(open(f, encoding='utf-8').read() for f in js_files(repo))
    if kind == 'id':
        h = len(re.findall(r'\bid="' + re.escape(name) + r'"', html))
        j = len(re.findall(r'\bid=\\?["\']' + re.escape(name) + r'\\?["\']', jsall)) + len(re.findall(r"\.id\s*=\s*'" + re.escape(name) + "'", jsall))
    elif kind == 'class':
        pat = r'class="[^"]*(?<![\w-])' + re.escape(name) + r'(?![\w-])[^"]*"'
        h = len(re.findall(pat, html))
        j = len(re.findall(r'class=\\?["\'][^"\']*(?<![\w-])' + re.escape(name) + r'(?![\w-])', jsall)) + \
            len(re.findall(r"className\s*[+]?=\s*[`'\"][^`'\"]*(?<![\w-])" + re.escape(name) + r'(?![\w-])', jsall)) + \
            len(re.findall(r"classList\.(?:add|toggle)\([^)]*'" + re.escape(name) + "'", jsall))
    elif kind == 'text':
        idv, txt = name.split('=', 1)
        h = 0
        j = len(re.findall(r'id=\\?["\']' + re.escape(idv) + r'\\?["\'][^>]*>\s*' + re.escape(txt) + r'\s*<', jsall))
    elif kind == 'textwrite':
        m = re.search(r'<(\w+)[^>]*\bid="' + re.escape(name) + r'"[^>]*>(.*?)</\1>', html, re.S)
        h = 1 if (m and '<' not in m.group(2)) else 0
        j = 0
    elif kind == 'disabled':
        h = len(re.findall(r'\bid="' + re.escape(name) + r'"', html))
        j = 0
    elif kind == 'value':
        a, v = name.split('=', 1)
        h = html.count(a + '="' + v + '"')
        j = 0
    elif kind == 'onclick':
        h = len(re.findall(r'\son\w+="' + re.escape(name) + r'\(', html))
        j = len(re.findall(r'function\s+' + re.escape(name) + r'\s*\(', jsall))
    else:
        h = len(re.findall(r'\b' + re.escape(name) + r'=', html))
        j = len(re.findall(r'\b' + re.escape(name) + r'=', jsall)) + len(re.findall(r'dataset\.', jsall)) * 0
    return h, j

def build(repo):
    ids, cls, attrs = extract(repo)
    rows = []
    for kind, d in (('id', ids), ('class', cls), ('attr', attrs)):
        for k in sorted(d):
            h, j = where_defined(repo, kind, k)
            src = 'HTML' if h else ('JS' if j else 'none')
            if kind == 'id' and k == 'panel-': continue   # 'panel-' + data-tab の値（下で個別に足す）
            rows.append((kind, k, src, h, sorted(d[k])))
    # data-tab・data-mark の値と、それに対応する panel-<tab>。index.html の onclick で呼ぶ関数
    html = open(os.path.join(repo, 'index.html'), encoding='utf-8').read()
    for v in re.findall(r'data-tab="([^"]*)"', html):
        rows.append(('value', 'data-tab=' + v, 'HTML', html.count('data-tab="' + v + '"'), ['ui.v6.js']))
        if os.path.exists(os.path.join(repo, 'index.html')) and ('id="panel-' + v + '"') in html:
            rows.append(('id', 'panel-' + v, 'HTML', html.count('id="panel-' + v + '"'), ['ui.v6.js']))
    for v in re.findall(r'data-mark="([^"]*)"', html):
        rows.append(('value', 'data-mark=' + v, 'HTML', html.count('data-mark="' + v + '"'), ['ui.v6.js']))
    for v in sorted(set(re.findall(r'\son\w+="([A-Za-z_]\w*)\(', html))):
        rows.append(('onclick', v, 'HTML', len(re.findall(r'\son\w+="' + v + r'\(', html)), ['index.html']))
    for idv, txt, note in TEXT_KEEP:
        rows.append(('text', idv + '=' + txt, 'JS', 1, [note]))
    for idv, note in TEXT_WRITE:
        rows.append(('textwrite', idv, 'HTML', 1, [note]))
    for idv, note in DISABLED_BY_JS:
        rows.append(('disabled', idv, 'HTML', 1, [note]))
    return rows

# 計算中の入力の鍵（milp.v6.js _calcInputGuard）は、閉じるボタンを文字（×・✕・閉じる）で見分ける。
# .calc-lock-area の中の閉じるボタンは、この文字のままにする（アイコンにすると計算中に閉じられなくなる）
TEXT_KEEP = [
  ('wzClose', '閉じる', 'milp.v6.js _calcInputGuard（順番に確認して生成する の閉じる）'),
  ('relaxClose', '閉じる', 'milp.v6.js _calcInputGuard（エラー解消プラン の閉じる）'),
  ('aiExplainClose', '✕', 'モーダルの閉じる'),
  ('surplusClose', '✕', 'モーダルの閉じる'),
  ('surplusX', '✕', 'モーダルの閉じる'),
  ('prClose', '✕', 'モーダルの閉じる'),
]
# JS が textContent / innerHTML を書き換える静的な要素。中に子の要素（アイコンなど）を置かない（書き換えで消えるため）。
# #appVersion の文字は genBaseTake が読み、保存データ（genBase.version）に入る
TEXT_WRITE = [
  ('appVersion', 'ui.v6.js genBaseTake が textContent を読む（v◯◯◯ の形のまま）'),
  ('btnTheme', 'app.v6.js setupUIChrome が textContent を書く'),
  ('btnGenerate', 'app.v6.js setBusy が textContent を書く（BTN_LABEL）'),
  ('btnGenerateFast', 'app.v6.js setBusy が textContent を書く（BTN_LABEL）'),
  ('btnRangeLock', 'ui.v6.js まとめて固定 が textContent を書く'),
  ('ruleLevelsToggle', 'ui.v6.js toggleRuleLevelsPanel が textContent を書く'),
  ('dailyReqToggle', 'ui.v6.js toggleDailyReqPanel が textContent を書く'),
  ('progressText', 'app.v6.js 生成の進み具合を textContent に書く'),
  ('modalTarget', 'ui.v6.js シフト編集の対象を textContent に書く'),
  ('toast', 'ui.v6.js toast が textContent を書く'),
]
# JS が disabled を切り替えるボタン（計算中の鍵 CALC_BUTTONS・元に戻す/やり直す・生成中）。
# 新しく作る代わりのボタンは、元のボタンが押せない間は同じく押せない見た目・動きにする
DISABLED_BY_JS = [
  ('btnGenerate', 'CALC_BUTTONS・setBusy'), ('btnGenerateFast', 'CALC_BUTTONS・setBusy'),
  ('btnWizard', 'CALC_BUTTONS'), ('btnRepair', 'CALC_BUTTONS・自動修正'), ('btnPartialRegen', 'CALC_BUTTONS'),
  ('btnSurplusPlan', 'CALC_BUTTONS'), ('btnRelax', 'CALC_BUTTONS'), ('btnResolveSurplus', 'CALC_BUTTONS'),
  ('btnUndo', 'updateHistoryButtons'), ('btnRedo', 'updateHistoryButtons'),
]

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    repo = args[0] if args else '.'
    if '--build' not in sys.argv and '--check' not in sys.argv:
        sys.argv += ['--check', os.path.join(repo, 'tools', 'ui-contract.txt')]
    rows = build(repo)
    if '--check' in sys.argv:
        cf = sys.argv[sys.argv.index('--check') + 1]
        base = []
        for line in open(cf, encoding='utf-8'):
            if not line.strip() or line.startswith('#'): continue
            kind, name, src, hn = line.split('\t')[:4]
            base.append((kind, name, src.strip(), int(hn)))
        bad = []
        for kind, name, src, hn in base:
            h, j = where_defined(repo, kind, name)
            if src == 'HTML':
                if h == 0: bad.append(f'{kind} {name}: index.html から消えた')
                if kind == 'id' and h > 1: bad.append(f'id {name}: index.html で {h} 回（重複）')
                if kind in ('value', 'onclick') and h != hn: bad.append(f'{kind} {name}: index.html で {hn} → {h} 回')
                if kind == 'textwrite' and h == 0: bad.append(f'textwrite {name}: 中に子の要素がある（JS の書き換えで消える）')
            elif src == 'JS':
                if h == 0 and j == 0: bad.append(f'{kind} {name}: JS の組み立て文字列から消えた（または文字が変わった）')
        print('契約', len(base), '件 / 欠け', len(bad))
        for b in bad: print('  NG', b)
        sys.exit(1 if bad else 0)
    print('# JS（js/*.v6.js）が DOM を探すときに使う id・クラス・data-* 属性の一覧（作業前 v249 で作成）')
    print('# 列: 種類 / 名前 / どこで作るか（HTML=index.html に書いてある、JS=JS の文字列で作る、none=作る所が見つからない）/ index.html での数 / 参照しているファイル')
    print('# HTML の行は index.html から消してはいけない（id は1回だけ）。JS の行は JS の組み立て文字列から消してはいけない。')
    print('# text: その id のボタンの文字を変えない（計算中の鍵が文字で閉じるボタンを見分ける）。textwrite: JS が文字を書き換えるので、中に子の要素を置かない。')
    print('# disabled: JS が押せない状態を切り替える。代わりに作るボタンも、元が押せない間は押せない見た目・動きにする。')
    for kind, k, src, h, w in rows:
        print(f'{kind}\t{k}\t{src}\t{h}\t{",".join(w)}')
