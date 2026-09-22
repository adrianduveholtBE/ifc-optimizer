#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Bygger fristaende HTML-filer av src/.

  python build.py            -> index.html (IFC Optimizer)
                                diagnos/index.html (IFC Diagnos)
  python build.py --install  -> kopierar dessutom bada till mappen i
                                install-dir.txt

Bada sidorna delar samma motor (src/engine/*.js i namnordning), som bakas in
i ett script-block och laddas som webbarbetare via Blob-URL. Ingenting hamtas
fran natet utom Google Fonts, och da faller typsnitten tillbaka pa systemets.
"""
import io, os, re, sys, glob, shutil, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
OUT_NAME = 'index.html'
INSTALL_NAME = 'IFC Optimizer v1.html'
DIAG_OUT = os.path.join('diagnos', 'index.html')
DIAG_INSTALL_NAME = 'IFC Diagnos v1.html'
NL = chr(10)


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
    engine = NL.join(parts)

    # delas med granssnittet: installningar + kunskapen om Revits export
    shared = (read(os.path.join(SRC, 'engine', '05-options.js')) + NL
              + read(os.path.join(SRC, 'engine', '06-revit.js')))
    logo = read(os.path.join(SRC, 'ui', 'logo.txt')).strip()
    base_css = read(os.path.join(SRC, 'ui', 'app.css'))
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

    if re.search(r'</\s*script', engine, re.I):
        raise SystemExit('motorn innehaller </script> vilket bryter inbakningen')

    def bake(html, css, app, out_path):
        if re.search(r'</\s*script', app, re.I):
            raise SystemExit('%s innehaller </script>' % out_path)
        for marker, payload in (('/*@CSS*/', css), ('/*@LOGO*/', logo),
                                ('/*@ENGINE*/', engine), ('/*@OPTIONS*/', shared),
                                ('/*@APP*/', app)):
            if marker not in html:
                raise SystemExit('markoren %s saknas i %s' % (marker, out_path))
            html = html.replace(marker, payload)
        html = html.replace('</title>',
                            '</title>' + NL + '<!-- byggd %s ur %s -->' % (stamp, ROOT))
        d = os.path.dirname(out_path)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        io.open(out_path, 'w', encoding='utf-8', newline=NL).write(html)
        print('%-28s %7.1f kB' % (os.path.relpath(out_path, ROOT), os.path.getsize(out_path) / 1024.0))
        return out_path

    out = bake(read(os.path.join(SRC, 'ui', 'index.html')), base_css,
               read(os.path.join(SRC, 'ui', 'app.js')),
               os.path.join(ROOT, OUT_NAME))
    diag = bake(read(os.path.join(SRC, 'diag', 'index.html')),
                base_css + NL + read(os.path.join(SRC, 'diag', 'extra.css')),
                read(os.path.join(SRC, 'diag', 'app.js')),
                os.path.join(ROOT, DIAG_OUT))
    print('motor: %d filer / %.1f kB' % (len(engine_files), len(engine) / 1024.0))

    if '--install' in sys.argv:
        target = install_dir()
        if not target:
            print('--install: satt IFC_OPT_INSTALL_DIR eller skapa install-dir.txt '
                  'med sokvagen dit filerna ska kopieras')
            return
        if not os.path.isdir(target):
            os.makedirs(target)
        for src_path, name in ((out, INSTALL_NAME), (diag, DIAG_INSTALL_NAME)):
            dst = os.path.join(target, name)
            shutil.copyfile(src_path, dst)
            print('kopierad till %s' % dst)


if __name__ == '__main__':
    main()
