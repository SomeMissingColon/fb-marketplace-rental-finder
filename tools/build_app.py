#!/usr/bin/env python3
"""Assemble the single-file app: the userscript + the analysis port + the dashboard UI.

usage (isolated mode, paths are arguments):
    python3 -I tools/build_app.py SRC_USERSCRIPT ANALYSIS_JS DASHBOARD_TEMPLATE OUT_USERSCRIPT

The dashboard template is split into its <style>, its markup and its script. The script is wrapped in
fbmMountDashboard(document, window, DATA) so it runs inside the userscript against an overlay iframe's document.
"""
import json
import re
import sys


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    src, analysis, template, out = sys.argv[1:]
    s = open(src, encoding='utf-8').read()
    a = open(analysis, encoding='utf-8').read()
    t = open(template, encoding='utf-8').read()

    style = re.search(r'<style>(.*?)</style>', t, re.S)
    body = re.search(r'<body>(.*?)<script>', t, re.S)
    script = re.search(r'<script>(.*)</script>\s*</body>', t, re.S)
    if not (style and body and script):
        sys.exit('template layout not recognised')
    js = script.group(1)
    marker = "const DATA = /*__DATA__*/null;"
    if marker not in js:
        sys.exit('template data marker missing')
    js = js.replace(marker, '', 1)
    # bare globals would resolve to the Facebook page (its URL hash, its size): point them at the overlay iframe
    js = re.sub(r"(?<![.\w'])(innerWidth|innerHeight|matchMedia)\b", r'window.\1', js)
    html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' \
        + style.group(1) + '</style></head><body>' + body.group(1) + '</body></html>'

    a = a.replace("if (typeof module !== 'undefined') module.exports = { fbmAnalyze };", '')
    dash = 'const FBM_DASH_HTML = ' + json.dumps(html, ensure_ascii=False) + ';\n' \
        + 'function fbmMountDashboard(document, window, DATA) {\n\'use strict\';\nconst history = window.history, location = window.location;\n' + js + '\n}\n'

    for mk in ('/*__FBM_ANALYSIS__*/', '/*__FBM_DASHBOARD__*/'):
        if s.count(mk) != 1:
            sys.exit('marker missing in source: ' + mk)
    s = s.replace('/*__FBM_ANALYSIS__*/', a, 1).replace('/*__FBM_DASHBOARD__*/', dash, 1)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(s)
    print('written', out, len(s.splitlines()), 'lines')


if __name__ == '__main__':
    main()
