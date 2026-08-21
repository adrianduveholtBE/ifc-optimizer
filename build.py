#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Bygger en enda fristaende HTML-fil av src/.

  python build.py            -> dist/IFC Optimizer v1.html
  python build.py --install  -> kopierar aven till OneDrive-mappen

Motorn (src/engine/*.js i namnordning) bakas in i ett script-block som
laddas som webbarbetare via Blob-URL. Ingenting hamtas fran natet utom
Google Fonts, och da faller typsnitten tillbaka pa systemets.
"""
import io, os, re, sys, glob, shutil, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
DIST = os.path.join(ROOT, 'dist')
NAME = 'IFC Optimizer v1.html'
# Dit --install kopierar. Kan pekas om med IFC_OPT_INSTALL_DIR.
INSTALL_DIR = os.environ.get('IFC_OPT_INSTALL_DIR') or os.path.join(
    os.path.expanduser('~'), 'OneDrive - bimengine.se', 'BIM ENGINE - General',
    'BIM EngineAi', '000 - Under Utveckling', '005 - IFC Optimizer')

def read(p):
    return io.open(p, encoding='utf-8').read()

def main():
    engine_files = sorted(glob.glob(os.path.join(SRC, 'engine', '*.js')))
    if not engine_files:
        raise SystemExit('hittar inga motorfiler')
    parts = []
    for p in engine_files:
        parts.append('/* ===== %s ===== */' % os.path.basename(p))
        parts.append(read(p))
    engine = '\n'.join(parts)

    options = read(os.path.join(SRC, 'engine', '05-options.js'))
    css = read(os.path.join(SRC, 'ui', 'app.css'))
    app = read(os.path.join(SRC, 'ui', 'app.js'))
    logo = read(os.path.join(SRC, 'ui', 'logo.txt')).strip()
    html = read(os.path.join(SRC, 'ui', 'index.html'))

    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    for marker, payload in (('/*@CSS*/', css), ('/*@LOGO*/', logo),
                            ('/*@ENGINE*/', engine), ('/*@OPTIONS*/', options),
                            ('/*@APP*/', app)):
        if marker not in html:
            raise SystemExit('markoren %s finns inte i index.html' % marker)
        html = html.replace(marker, payload)
    html = html.replace('</title>', '</title>\n<!-- byggd %s ur %s -->' % (stamp, ROOT))

    # ett script-block far inte innehalla </script>
    if re.search(r'</\s*script', engine, re.I) or re.search(r'</\s*script', app, re.I):
        raise SystemExit('koden innehaller </script> vilket bryter inbakningen')

    if not os.path.isdir(DIST):
        os.makedirs(DIST)
    out = os.path.join(DIST, NAME)
    io.open(out, 'w', encoding='utf-8', newline='\n').write(html)
    print('%s  (%.1f kB, motor %d filer / %.1f kB)'
          % (out, os.path.getsize(out) / 1024.0, len(engine_files), len(engine) / 1024.0))

    if '--install' in sys.argv:
        if not os.path.isdir(INSTALL_DIR):
            os.makedirs(INSTALL_DIR)
        dst = os.path.join(INSTALL_DIR, NAME)
        shutil.copyfile(out, dst)
        print('kopierad till %s' % dst)

if __name__ == '__main__':
    main()
