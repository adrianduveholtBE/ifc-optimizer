/* ==========================================================================
   90-worker.js  ·  meddelandehantering
   --------------------------------------------------------------------------
   Filen skickas hit som File/Blob, inte som färdiglästa byte. Det är den som
   avgör om vi kan läsa in allt eller måste strömma.
   ========================================================================== */

function useStreaming(file, o) {
  if (o && o.forceStream) return true;
  const limit = ((o && o.streamThresholdMB) || 600) * 1048576;
  return file.size > limit;
}

/* Skala om en rapport som räknats fram ur ett urval av filen. */
function scaleReport(rep, factor, wholeBytes) {
  const s = function (v) { return Math.round(v * factor); };
  rep.sampled = true;
  rep.sampleBytes = rep.bytes;
  rep.bytes = wholeBytes;
  rep.dataBytes = s(rep.dataBytes);
  rep.instances = s(rep.instances);
  rep.roots = s(rep.roots);
  for (const c of rep.cats) { c.bytes = s(c.bytes); c.count = s(c.count); }
  for (const t of rep.topTypes) { t.bytes = s(t.bytes); t.count = s(t.count); }
  for (const t of rep.elements) { t.bytes = s(t.bytes); t.count = s(t.count); }
  for (const k in rep.est) rep.est[k] = s(rep.est[k]);
  if (rep.round) {
    rep.round.saving = s(rep.round.saving);
    rep.round.values = s(rep.round.values);
    rep.round.longValues = s(rep.round.longValues);
  }
  return rep;
}

async function readForAnalysis(file, o, log) {
  const limit = ((o && o.sampleMB) || 96) * 1048576;
  if (file.size <= limit) {
    return { bytes: new Uint8Array(await file.arrayBuffer()), factor: 1 };
  }
  log('Filen är ' + fmtBytes(file.size) + ' — analysen görs på de första ' +
      fmtBytes(limit) + ' och räknas upp.');
  const slice = new Uint8Array(await file.slice(0, limit).arrayBuffer());
  return { bytes: slice, factor: file.size / limit };
}

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
      const r = await readForAnalysis(msg.file, msg.opts, hooks.log);
      const a = await analyseFile(r.bytes, msg.opts, hooks);
      const rep = r.factor === 1 ? a.report : scaleReport(a.report, r.factor, msg.file.size);
      rep.willStream = useStreaming(msg.file, msg.opts);
      post('analysed', { report: rep });
    } else if (msg.cmd === 'optimize') {
      if (useStreaming(msg.file, msg.opts)) {
        const r = await streamOptimize(msg.file, msg.opts, hooks);
        post('done', { report: r.report, blob: r.blob, ext: r.ext });
      } else {
        const u8 = new Uint8Array(await msg.file.arrayBuffer());
        const r = await optimizeFile(u8, msg.opts, hooks, null);
        post('done', {
          report: r.report,
          blob: new Blob(r.blocks, { type: 'application/octet-stream' }),
          ext: r.ext
        });
      }
    } else if (msg.cmd === 'ping') {
      post('pong', { version: '1.1' });
    }
  } catch (e) {
    post('error', { message: (e && e.message) ? e.message : String(e), stack: e && e.stack ? String(e.stack) : '' });
  }
};
}
