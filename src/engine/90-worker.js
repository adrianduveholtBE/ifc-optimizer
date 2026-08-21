/* ==========================================================================
   90-worker.js  ·  meddelandehantering i webbarbetaren
   ========================================================================== */

/* Körs bara i en riktig webbarbetare. I huvudtråden (reservläget) laddas
   samma kod in med new Function() och då finns document. */
if (typeof document === 'undefined') {
self.onmessage = async function (ev) {
  const msg = ev.data || {};
  const id = msg.id;
  const post = function (type, extra) {
    const o = { type: type, id: id };
    if (extra) for (const k in extra) o[k] = extra[k];
    self.postMessage(o);
  };
  const hooks = {
    log: function (text) { post('log', { text: text }); },
    prog: function (phase, frac) { post('progress', { phase: phase, frac: frac }); }
  };
  try {
    if (msg.cmd === 'analyse') {
      const u8 = new Uint8Array(msg.bytes);
      const r = await analyseFile(u8, msg.opts, hooks);
      post('analysed', { report: r.report });
    } else if (msg.cmd === 'optimize') {
      const u8 = new Uint8Array(msg.bytes);
      const r = await optimizeFile(u8, msg.opts, hooks, null);
      const blob = new Blob(r.blocks, { type: 'application/octet-stream' });
      post('done', { report: r.report, blob: blob, ext: r.ext });
    } else if (msg.cmd === 'ping') {
      post('pong', { version: '1.0' });
    }
  } catch (e) {
    post('error', { message: (e && e.message) ? e.message : String(e), stack: e && e.stack ? String(e.stack) : '' });
  }
};
}
