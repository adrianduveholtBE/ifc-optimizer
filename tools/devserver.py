#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Utvecklingsserver for IFC Optimizer.

  GET  /...              filer ur projektmappen
  GET  /big/<namn>       filer ur en extern testmapp (stora IFC-modeller)
  POST /__out/<namn>     skriver resultatet till test/out/<namn>

Startas av .claude/launch.json pa port 8127.
"""
import io, os, sys, json, posixpath
try:
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
except ImportError:
    from BaseHTTPServer import HTTPServer as ThreadingHTTPServer
    from SimpleHTTPServer import SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, 'test', 'out')
BIGDIR = os.environ.get('IFC_BIG_DIR') or os.path.join(os.path.expanduser('~'), 'Dokument')
PORT = int(os.environ.get('PORT', '8127'))

class H(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        try:
            from urllib.parse import unquote
        except ImportError:
            from urllib import unquote
        p = unquote(path.split('?', 1)[0].split('#', 1)[0])
        if p.startswith('/big/'):
            name = posixpath.basename(p[5:])
            return os.path.join(BIGDIR, name)
        rel = p.lstrip('/')
        return os.path.join(ROOT, rel.replace('/', os.sep))

    def do_POST(self):
        p = self.path.split('?', 1)[0]
        if not p.startswith('/__out/'):
            self.send_error(404); return
        name = posixpath.basename(p[7:]) or 'out.bin'
        n = int(self.headers.get('Content-Length', '0'))
        data = self.rfile.read(n)
        if not os.path.isdir(OUTDIR):
            os.makedirs(OUTDIR)
        with open(os.path.join(OUTDIR, name), 'wb') as fh:
            fh.write(data)
        body = json.dumps({'ok': True, 'bytes': len(data), 'name': name}).encode('ascii')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.command, self.path.split('?')[0]))

if __name__ == '__main__':
    print('IFC Optimizer devserver -> http://localhost:%d  (rot: %s)' % (PORT, ROOT))
    print('stora filer via /big/<namn> ur %s' % BIGDIR)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
