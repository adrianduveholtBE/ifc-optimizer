#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Bygger en enda fristaende HTML-fil av src/.

  python build.py            -> index.html (samma fil som GitHub Pages visar)
  python build.py --install  -> kopierar dessutom till mappen i install-dir.txt
                                under namnet "IFC Optimizer v1.html"

Byggd fil hamnar i repots rot som index.html sa att Pages kan visa den pa
en ren URL. Det finns alltsa bara en byggd fil att halla reda pa.

Motorn (src/engine/*.js i namnordning) bakas in i ett script-block som
laddas som webbarbetare via Blob-URL. Ingenting hamtas fran natet utom
Google Fonts, och da faller typsnitten tillbaka pa systemets.
"""
import io, os, re, sys, glob, shutil, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
OUT_NAME = 'index.html'
INSTALL_NAME = 'IFC Optimizer v1.html'
def install_dir():
    """Dit --install kopierar: IFC_OPT_INSTALL_DIR, annars raden i
    install-dir.txt (lokal fil, ingar inte i repot)."""
    v = os.environ.get('IFC_OPT_INSTALL_DIR')
    if v:
        return v.strip()
    p = os.path.join(ROOT, 'install-dir.txt')
    if os.path.exists(p):
        return io.open(p, encoding='utf-8').read().strip()
    return None

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

    out = os.path.join(ROOT, OUT_NAME)
    io.open(out, 'w', encoding='utf-8', newline='\n').write(html)
    print('%s  (%.1f kB, motor %d filer / %.1f kB)'
          % (out, os.path.getsize(out) / 1024.0, len(engine_files), len(engine) / 1024.0))

    if '--install' in sys.argv:
        target = install_dir()
        if not target:
            print('--install: satt IFC_OPT_INSTALL_DIR eller skapa install-dir.txt '
                  'med sokvagen dit filen ska kopieras')
            return
        if not os.path.isdir(target):
            os.makedirs(target)
        dst = os.path.join(target, INSTALL_NAME)
        shutil.copyfile(out, dst)
        print('kopierad till %s' % dst)

if __name__ == '__main__':
    main()
