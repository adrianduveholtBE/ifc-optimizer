/* ==========================================================================
   app.js  ·  gränssnittet
   ========================================================================== */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const el = function (tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  const fmtB = function (n) {
    if (n === null || n === undefined) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' kB';
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  };
  const fmtN = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };

  /* --- motorn: webbarbetare om det går, annars huvudtråden -----------------
     Öppnad direkt från disk (file://) vägrar en del webbläsare skapa en
     arbetare ur en Blob-URL. Vi gör därför ett ping-test och faller tillbaka
     på att köra motorn i huvudtråden i stället för att stå handfallna.     */
  let worker = null, reqId = 0, direct = null;
  const pending = new Map();

  function startWorker() {
    const src = $('engineSrc').textContent;
    let ok = false;
    if (/[?&]forgrund/.test(location.search)) { useDirect(src); return; }
    try {
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = function (ev) {
        const d = ev.data || {};
        if (d.type === 'pong') { ok = true; $('engineState').textContent = 'motor · redo (lokalt)'; return; }
        const job = pending.get(d.id);
        if (!job) return;
        if (d.type === 'log') { job.onLog && job.onLog(d.text); return; }
        if (d.type === 'progress') { job.onProg && job.onProg(d.phase, d.frac); return; }
        pending.delete(d.id);
        if (d.type === 'error') job.reject(new Error(d.message + (d.stack ? '\n' + d.stack : '')));
        else job.resolve(d);
      };
      worker.onerror = function () { if (!ok) useDirect(src); };
      worker.postMessage({ cmd: 'ping', id: 0 });
      setTimeout(function () { if (!ok) useDirect(src); }, 4000);
      $('engineState').textContent = 'motor · startar';
    } catch (e) {
      useDirect(src);
    }
  }

  function useDirect(src) {
    if (direct) return;
    try {
      worker = null;
      direct = new Function(src + '\nreturn { analyseFile: analyseFile, optimizeFile: optimizeFile,' +
        ' streamOptimize: streamOptimize, readForAnalysis: readForAnalysis,' +
        ' scaleReport: scaleReport, useStreaming: useStreaming };')();
      $('engineState').textContent = 'motor · redo (förgrund)';
      logLine('Webbläsaren tillåter ingen bakgrundstråd här — motorn körs i förgrunden. ' +
              'Gränssnittet står stilla medan en stor fil arbetas igenom.', 'warn');
    } catch (e) {
      $('engineState').textContent = 'motor · fel';
      $('engineState').className = 'tag bad';
      logLine('Motorn kunde inte startas: ' + (e && e.message), 'err');
    }
  }

  function ask(cmd, payload, onLog, onProg) {
    if (direct) {
      const hooks = { log: onLog || function () {}, prog: onProg || function () {} };
      const file = payload.file, o = payload.opts;
      /* låt webbläsaren måla klart innan huvudtråden låses */
      return new Promise(function (res) { setTimeout(res, 40); }).then(async function () {
        if (cmd === 'analyse') {
          const r = await direct.readForAnalysis(file, o, hooks.log);
          const a = await direct.analyseFile(r.bytes, o, hooks);
          const rep = r.factor === 1 ? a.report : direct.scaleReport(a.report, r.factor, file.size);
          rep.willStream = direct.useStreaming(file, o);
          return { report: rep };
        }
        if (direct.useStreaming(file, o)) {
          const r = await direct.streamOptimize(file, o, hooks);
          return { report: r.report, blob: r.blob, ext: r.ext };
        }
        const u8 = new Uint8Array(await file.arrayBuffer());
        const r = await direct.optimizeFile(u8, o, hooks, null);
        return { report: r.report, blob: new Blob(r.blocks, { type: 'application/octet-stream' }), ext: r.ext };
      });
    }
    const id = ++reqId;
    const msg = Object.assign({ cmd: cmd, id: id }, payload);
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject, onLog: onLog, onProg: onProg });
      worker.postMessage(msg);
    });
  }

  /* --- tillstånd ---------------------------------------------------------- */
  const files = [];            // { file, id, state, report, result, node }
  let preset = 'medel';
  let opts = null;
  let custom = false;
  let busy = false;
  let queue = Promise.resolve();

  const LEVELS = {
    latt: 'Rör inte informationen. Avrundar bara flyttal, slår ihop identiska ' +
          'objekt, städar bort föräldralöst skräp och numrerar om. Modellen är ' +
          'exakt densamma efteråt.',
    medel: 'För samordning och granskning. Tar bort egenskaper, mängder, typobjekt, ' +
           'material, 2D-linjer och lager. Geometrin är kvar helt oförändrad — ' +
           'koplanära ytor slås ihop förlustfritt. Färger behålls.',
    aggressiv: 'Minsta möjliga fil. Tar dessutom bort färger, rum, öppningar och ' +
               'rutnät, svetsar ihop hörn och sparar som .ifczip.'
  };

  /* option-specifikationen driver både kryssrutorna och besparingssiffrorna */
  const SPEC = [
    { grp: 'Säkert — ingen information försvinner' },
    { k: 'roundCoords', t: 'Avrunda flyttal', d: 'Revit skriver ofta 15 decimaler i millimetermodeller. Detta är den enskilt största lättvinsten.', est: 'rounding' },
    { k: 'dedup', t: 'Slå ihop identiska objekt', d: 'Punkter, riktningar, profiler, placeringar och hela geometrigrenar som är exakt lika blir en enda instans.' },
    { k: 'gc', t: 'Städa bort föräldralöst', d: 'Objekt som ingenting pekar på — vanligt skräp från exporten.' },
    { k: 'renumber', t: 'Numrera om instanser', d: 'Ger korta instansnummer i den nya filen.' },
    { k: 'unifyOwnerHistory', t: 'En gemensam ägarhistorik', d: 'Alla objekt pekar på samma IfcOwnerHistory.' },
    { grp: 'Information som ofta inte behövs i en samordningsmodell' },
    { k: 'dropPsets', t: 'Egenskaper (Pset)', d: 'All parameterinformation. Behåll om modellen ska mängdas eller kravgranskas.', est: 'psets' },
    { k: 'dropQuantities', t: 'Mängder (BaseQuantities)', est: 'quantities' },
    { k: 'dropTypes', t: 'Typobjekt', d: 'IfcWallType m.fl. samt kopplingen objekt–typ.', est: 'typeObjects' },
    { k: 'dropMaterials', t: 'Material', d: 'Materiallager och materialkopplingar. Färg som kommer från material kan försvinna.', est: 'materials' },
    { k: 'dropStyles', t: 'Färger och stilar', d: 'Modellen blir grå i visaren.', est: 'styles', risk: true },
    { k: 'dropLayers', t: 'Presentationslager', d: 'IfcPresentationLayerAssignment (CAD-lagernamn).' },
    { k: 'dropClassifications', t: 'Klassificering och dokument', d: 'CoClass/BSAB-referenser, dokumentlänkar.' },
    { k: 'dropConnectivity', t: 'Anslutningsrelationer', d: 'IfcRelConnects* — vem som möter vem. Används sällan nedströms.' },
    { k: 'drop2D', t: '2D och annotation', d: 'Axel-, footprint- och annotationsrepresentationer samt IfcAnnotation.', est: 'drawing' },
    { k: 'dropGrids', t: 'Rutnät', d: 'IfcGrid med axlar.' },
    { k: 'dropSpaces', t: 'Rum och zoner', d: 'Innehållet i rummen flyttas upp till våningsplanet så inget tappas.', est: 'spaces', risk: true },
    { k: 'dropSpaceBoundaries', t: 'Rumsavgränsningar', d: 'IfcRelSpaceBoundary — kan vara mycket stort i arkitektmodeller.' },
    { k: 'dropOpenings', t: 'Öppningar', d: 'IfcOpeningElement. Varning: visare som själva klipper hål i väggen slutar göra det.', est: 'openings', risk: true },
    { grp: 'Geometri' },
    { k: 'mergeCoplanar', t: 'Slå ihop koplanära ytor', d: 'Trianglar i samma plan blir en yta. Förlustfritt — varje skal areakontrolleras och lämnas orört om något inte stämmer.' },
    { k: 'weld', t: 'Svetsa ihop hörn (IFC4-mesh)', d: 'Kvantiserar punktlistor och tar bort urartade trianglar.' },
    { k: 'boxify', t: 'Ersätt geometri med lådor', d: 'Varje mesh/BREP byts mot sin omslutande låda. Modellen blir klossar — bara för volymstudier.', risk: true },
    { grp: 'Utdata' },
    { k: 'zip', t: 'Spara som .ifczip', d: 'Zippad IFC. Störst effekt av allt, men alla program läser inte ifczip.' },
    { k: 'verify', t: 'Kontrollera resultatet', d: 'Läser om den skrivna filen och verifierar att varje referens pekar rätt.' },
    { k: 'forceStream', t: 'Tvinga snabbläge', d: 'Strömmar filen igenom: bara avrundning och ifczip, men klarar hur stora filer som helst. Används automatiskt över gränsen ovan.' }
  ];

  function setPreset(p) {
    preset = p;
    const tol = opts ? opts.tolMm : 0.01;
    const rc = opts ? opts.roundCoords : true;
    const dc = opts ? opts.dropClasses : [];
    opts = presetOptions(p);
    opts.tolMm = tol; opts.roundCoords = rc; opts.dropClasses = dc;
    custom = false;
    render();
  }

  function estFor(key) {
    let sum = 0, any = false;
    for (const f of files) {
      if (!f.report || !f.report.est) continue;
      const v = f.report.est[key];
      if (typeof v === 'number') { sum += v; any = true; }
    }
    return any ? sum : null;
  }

  /* --- rendering ---------------------------------------------------------- */
  function render() {
    renderPresets();
    renderOpts();
    renderFiles();
    renderAnalysis();
    $('runBtn').disabled = busy || files.length === 0;
    $('runBtn').textContent = busy ? 'Arbetar…' : (files.length > 1 ? 'Optimera ' + files.length + ' filer' : 'Optimera');
  }

  function renderPresets() {
    const btns = $('presetSeg').querySelectorAll('button');
    for (const b of btns) b.classList.toggle('on', !custom && b.dataset.p === preset);
    $('levelNote').innerHTML = custom
      ? '<b>Anpassad</b> — du har ändrat inställningarna själv.'
      : '<b>' + $('presetSeg').querySelector('[data-p="' + preset + '"]').textContent + '</b> — ' + LEVELS[preset];
    const tb = $('tolSeg').querySelectorAll('button');
    for (const b of tb) {
      const t = parseFloat(b.dataset.t);
      b.classList.toggle('on', (t === 0 && !opts.roundCoords) || (opts.roundCoords && Math.abs(t - opts.tolMm) < 1e-9));
    }
    let dec = null;
    for (const f of files) if (f.report) { dec = f.report.coordDec; break; }
    $('tolNote').textContent = !opts.roundCoords
      ? 'Flyttalen skrivs precis som de kom in.'
      : 'Koordinater avrundas till ' + String(opts.tolMm).replace('.', ',') + ' mm' +
        (dec !== null ? ' (' + dec + ' decimaler i modellens enhet)' : '') +
        '. Det är 100–10 000 gånger finare än byggtoleransen.';
  }

  function renderOpts() {
    const box = $('opts');
    box.innerHTML = '';
    for (const s of SPEC) {
      if (s.grp) { box.appendChild(el('div', 'grp', s.grp)); continue; }
      const row = el('div', 'opt' + (s.risk ? ' risk' : ''));
      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!opts[s.k];
      cb.addEventListener('change', function () {
        opts[s.k] = cb.checked;
        if (s.k === 'roundCoords') { renderPresets(); }
        custom = true;
        render();
      });
      const txt = el('div', 'txt');
      txt.appendChild(el('span', null, s.t));
      if (s.d) txt.appendChild(el('small', null, s.d));
      row.appendChild(cb); row.appendChild(txt);
      if (s.est) {
        const v = estFor(s.est);
        if (v) row.appendChild(el('div', 'est', '≈ ' + fmtB(v)));
      }
      box.appendChild(row);
    }
  }

  function renderFiles() {
    const list = $('fileList');
    list.innerHTML = '';
    let tot = 0;
    for (const f of files) {
      tot += f.file.size;
      const box = el('div', 'file');
      const r1 = el('div', 'row1');
      r1.appendChild(el('div', 'nm', f.file.name));
      r1.appendChild(el('div', 'sz', fmtB(f.file.size)));
      const st = el('div', 'state ' + (f.state === 'klar' ? 'ok' : (f.state === 'fel' ? 'err' : '')), f.state);
      r1.appendChild(st);
      const x = el('button', 'x', '×');
      x.title = 'ta bort';
      x.addEventListener('click', function () {
        const i = files.indexOf(f);
        if (i >= 0) files.splice(i, 1);
        render();
      });
      r1.appendChild(x);
      box.appendChild(r1);
      if (f.report) {
        const meta = el('div', 'meta');
        const add = function (k, v) {
          const s = el('span'); s.innerHTML = k + ' <b>' + v + '</b>'; meta.appendChild(s);
        };
        const ca = f.report.sampled ? '≈' : '';
        add('schema', f.report.schema || '?');
        add('enhet', f.report.unit.label);
        add('instanser', ca + fmtN(f.report.instances));
        add('objekt', ca + fmtN(f.report.roots));
        if (f.report.tool) add('från', String(f.report.tool).slice(0, 34));
        if (f.report.willStream) add('läge', 'snabbläge');
        box.appendChild(meta);
      }
      if (f.err) {
        const e = el('div', 'meta');
        e.innerHTML = '<span style="color:var(--danger)">' + f.err + '</span>';
        box.appendChild(e);
      }
      if (f.prog !== undefined && f.prog < 1) {
        const bar = el('div', 'bar'); const i = el('i');
        i.style.width = Math.round(f.prog * 100) + '%';
        bar.appendChild(i); box.appendChild(bar);
      }
      list.appendChild(box);
    }
    $('fileSum').textContent = files.length ? files.length + ' filer · ' + fmtB(tot) : '';
    const big = files.some(function (f) { return f.file.size > (opts.streamThresholdMB || 600) * 1048576; });
    $('fileHint').style.display = big ? '' : 'none';
    $('fileHint').innerHTML = 'En eller flera filer är för stora för att hållas i minnet med hela ' +
      'referensgrafen och körs därför i <b>snabbläge</b>: filen strömmas igenom, flyttalen avrundas och ' +
      'resultatet kan zippas. Dubbletter, strippning och geometrihantering kräver hela modellen i minnet ' +
      'och görs inte. Instansnumren rörs inte, så referenserna kan inte gå sönder.';
  }

  function renderAnalysis() {
    const rep = files.find(function (f) { return f.report; });
    if (!rep) { $('analysisCard').style.display = 'none'; return; }
    const r = rep.report;
    $('analysisCard').style.display = '';
    $('analysisFor').textContent = rep.file.name;

    const cats = $('cats');
    cats.innerHTML = '';
    const max = r.cats.length ? r.cats[0].bytes : 1;
    for (const c of r.cats.slice(0, 11)) {
      const row = el('div', 'catrow');
      row.appendChild(el('div', 'lbl', c.label));
      const tr = el('div', 'track');
      const i = el('i');
      i.style.width = Math.max(1, Math.round(c.bytes / max * 100)) + '%';
      if (c.bytes / r.bytes < 0.02) i.className = 'dim';
      tr.appendChild(i);
      row.appendChild(tr);
      row.appendChild(el('div', 'val', fmtB(c.bytes) + '  ' + (100 * c.bytes / r.bytes).toFixed(1).replace('.', ',') + '%'));
      cats.appendChild(row);
    }
    if (r.round && r.round.longValues) {
      const row = el('div', 'catrow');
      row.appendChild(el('div', 'lbl', 'varav onödiga decimaler'));
      const tr = el('div', 'track');
      const i = el('i');
      i.style.width = Math.max(1, Math.round(r.round.saving / max * 100)) + '%';
      tr.appendChild(i); row.appendChild(tr);
      row.appendChild(el('div', 'val', fmtB(r.round.saving) + '  kan bort'));
      cats.appendChild(row);
    }

    const tt = $('typeTbl');
    tt.innerHTML = '<tr><th>IFC-klass</th><th class="num">antal</th><th class="num">byte</th><th class="num">andel</th></tr>';
    for (const t of r.topTypes.slice(0, 18)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'name', t.name));
      tr.appendChild(el('td', 'num', fmtN(t.count)));
      tr.appendChild(el('td', 'num', fmtB(t.bytes)));
      tr.appendChild(el('td', 'num', (100 * t.bytes / r.bytes).toFixed(1).replace('.', ',') + '%'));
      tt.appendChild(tr);
    }

    const et = $('elemTbl');
    et.innerHTML = '<tr><th>byggdelsklass</th><th class="num">antal</th><th class="num">byte</th></tr>';
    for (const t of r.elements.slice(0, 24)) {
      const tr = el('tr');
      const td = el('td', 'name');
      const lab = el('label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = opts.dropClasses.indexOf(t.name) >= 0;
      cb.addEventListener('change', function () {
        const i = opts.dropClasses.indexOf(t.name);
        if (cb.checked && i < 0) opts.dropClasses.push(t.name);
        if (!cb.checked && i >= 0) opts.dropClasses.splice(i, 1);
        custom = true;
      });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, t.name));
      td.appendChild(lab);
      tr.appendChild(td);
      tr.appendChild(el('td', 'num', fmtN(t.count)));
      tr.appendChild(el('td', 'num', fmtB(t.bytes)));
      et.appendChild(tr);
    }
  }

  /* --- logg --------------------------------------------------------------- */
  function logLine(text, cls) {
    const box = $('log');
    const t = new Date();
    const ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    const line = el('div');
    const s = el('span', 'ts', ts + '  ');
    line.appendChild(s);
    const b = el('span', cls || '', text);
    line.appendChild(b);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* --- analys av tillagda filer ------------------------------------------- */
  function addFiles(fl) {
    for (const file of fl) {
      const low = file.name.toLowerCase();
      if (!(low.endsWith('.ifc') || low.endsWith('.ifczip') || low.endsWith('.ifcxml'))) continue;
      if (low.endsWith('.ifcxml')) { logLine('ifcXML stöds inte: ' + file.name, 'err'); continue; }
      const f = { file: file, state: 'väntar', report: null, result: null, err: null, prog: 1 };
      files.push(f);
      queue = queue.then(function () { return analyse(f); });
    }
    render();
  }

  async function analyse(f) {
    f.state = 'analyserar'; f.prog = 0; render();
    try {
      const res = await ask('analyse', { file: f.file, opts: Object.assign({}, opts) },
        function (t) { logLine('  ' + t, /VARNING/.test(t) ? 'warn' : ''); },
        function (phase, frac) { f.prog = frac; renderFiles(); });
      f.report = res.report;
      f.state = 'analyserad';
      f.prog = 1;
      const ca = f.report.sampled ? '≈' : '';
      logLine(f.file.name + ': ' + ca + fmtN(f.report.instances) + ' instanser, ' + f.report.schema +
              ', ' + f.report.unit.label + ' — ' + ca + fmtB(f.report.round.saving) + ' i onödiga decimaler.');
      if (f.report.willStream) {
        logLine('  ' + f.file.name + ' körs i snabbläge (strömmande): avrundning och ifczip, ' +
                'men inga dubbletter, ingen strippning och ingen geometrihantering.', 'warn');
      }
    } catch (e) {
      f.state = 'fel'; f.err = e.message; f.prog = 1;
      logLine(f.file.name + ': ' + e.message, 'err');
    }
    render();
  }

  /* --- körning ------------------------------------------------------------ */
  async function runAll() {
    if (busy) return;
    busy = true; render();
    $('resultCard').style.display = '';
    $('results').innerHTML = '';
    let totB = 0, totA = 0;
    for (const f of files) {
      f.result = null;
      if (f.state === 'fel') continue;
      f.state = 'optimerar'; f.prog = 0; render();
      $('phase').textContent = f.file.name;
      try {
        const o = Object.assign({}, opts, { name: f.file.name });
        const res = await ask('optimize', { file: f.file, opts: o },
          function (t) { logLine('  ' + t, /VARNING/.test(t) ? 'warn' : ''); },
          function (phase, frac) {
            f.prog = frac; renderFiles();
            $('bar').style.width = Math.round(frac * 100) + '%';
            $('phase').textContent = f.file.name + ' · ' + phase;
          });
        f.result = res;
        f.state = 'klar'; f.prog = 1;
        totB += res.report.sizeBefore; totA += res.report.sizeAfter;
        showResult(f);
        logLine(f.file.name + ': ' + fmtB(res.report.sizeBefore) + ' → ' + fmtB(res.report.sizeAfter) +
                ' (' + (100 - 100 * res.report.sizeAfter / res.report.sizeBefore).toFixed(1).replace('.', ',') + ' % mindre)', 'ok');
      } catch (e) {
        f.state = 'fel'; f.err = e.message;
        logLine(f.file.name + ': ' + e.message, 'err');
      }
      render();
    }
    $('bar').style.width = '100%';
    $('phase').textContent = 'klart';
    $('resSum').textContent = totB ? fmtB(totB) + ' → ' + fmtB(totA) + '  (' +
      (100 - 100 * totA / totB).toFixed(1).replace('.', ',') + ' % mindre)' : '';
    busy = false; render();
  }

  function outName(f) {
    const n = f.file.name.replace(/\.(ifc|ifczip)$/i, '');
    return n + (opts.suffix || '_optimerad') + f.result.ext;
  }

  function showResult(f) {
    const r = f.result.report;
    const box = el('div', 'res');
    const top = el('div', 'top');
    top.appendChild(el('div', 'nm', f.file.name));
    top.appendChild(el('div', 'pct', (100 - 100 * r.sizeAfter / r.sizeBefore).toFixed(1).replace('.', ',') + ' %'));
    box.appendChild(top);
    box.appendChild(el('div', 'sizes', fmtB(r.sizeBefore) + '  →  ' + fmtB(r.sizeAfter) +
      (r.zip ? '  (zippad)' : '')));

    const bb = el('div', 'bigbar');
    const a = el('i', 'after'); a.style.width = (100 * r.sizeAfter / r.sizeBefore) + '%';
    const g = el('i', 'gone'); g.style.width = (100 - 100 * r.sizeAfter / r.sizeBefore) + '%';
    bb.appendChild(a); bb.appendChild(g);
    box.appendChild(bb);

    const facts = el('div', 'facts');
    const add = function (k, v) { const s = el('span'); s.innerHTML = k + ' <b>' + v + '</b>'; facts.appendChild(s); };
    if (r.streamed) {
      add('läge', 'snabbläge (strömmande)');
      add('instanser', fmtN(r.instancesBefore));
      add('avrundade tal', fmtN(r.roundedValues || 0));
    } else {
      add('instanser', fmtN(r.instancesBefore) + ' → ' + fmtN(r.instancesAfter));
      add('dubbletter', fmtN(r.merged));
    }
    if (r.geom && r.geom.facesBefore) add('ytor', fmtN(r.geom.facesBefore) + ' → ' + fmtN(r.geom.facesAfter));
    if (r.geom && r.geom.shellsSkipped) add('skal orörda', fmtN(r.geom.shellsSkipped));
    if (r.weld && r.weld.lists) add('svetsade hörn', fmtN(r.weld.before) + ' → ' + fmtN(r.weld.after));
    if (r.box && r.box.replaced) add('lådor', fmtN(r.box.replaced));
    add('tid', (r.totalMs / 1000).toFixed(1).replace('.', ',') + ' s');
    box.appendChild(facts);

    const vb = el('div', 'vbadge' + ((r.verify && r.verify.ok && !r.dangling) ? '' : ' bad'));
    vb.textContent = r.dangling ? 'BRUTNA REFERENSER: ' + r.dangling
      : (r.verify ? (r.verify.ok ? (r.verify.note ? 'oförändrade instansnummer — referenserna kan inte ha brutits'
                                                 : 'kontrollerad — inga brutna referenser')
                                : 'kontroll: ' + r.verify.problems.join('; '))
                  : 'kontroll ej körd');
    const vrow = el('div', 'facts');
    vrow.appendChild(vb);
    if (r.inputDangling) {
      const w = el('div', 'vbadge bad');
      w.textContent = fmtN(r.inputDangling) + ' brutna referenser fanns i originalet';
      vrow.appendChild(w);
    }
    box.appendChild(vrow);

    if (r.removed && r.removed.length) {
      const d = el('details', 'more');
      d.appendChild(el('summary', null, 'Vad togs bort?'));
      const t = el('table', 'tbl');
      t.innerHTML = '<tr><th>klass</th><th class="num">antal</th></tr>';
      for (const x of r.removed) {
        const tr = el('tr');
        tr.appendChild(el('td', 'name', x.name));
        tr.appendChild(el('td', 'num', fmtN(x.count)));
        t.appendChild(tr);
      }
      d.appendChild(t);
      box.appendChild(d);
    }

    const row = el('div', 'btnrow');
    const dl = el('button', 'btn sm', 'Ladda ner ' + outName(f));
    dl.addEventListener('click', function () { download(f); });
    row.appendChild(dl);
    box.appendChild(row);
    $('results').appendChild(box);
  }

  function download(f) {
    const url = URL.createObjectURL(f.result.blob);
    const a = document.createElement('a');
    a.href = url; a.download = outName(f);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function reportText() {
    const rows = ['IFC Optimizer 1.0 — BIM Engine', new Date().toLocaleString('sv-SE'), ''];
    rows.push('Nivå: ' + (custom ? 'anpassad' : preset));
    rows.push('Koordinatprecision: ' + (opts.roundCoords ? opts.tolMm + ' mm' : 'av'));
    rows.push('');
    for (const f of files) {
      if (!f.result) continue;
      const r = f.result.report;
      rows.push(f.file.name);
      rows.push('  ' + fmtB(r.sizeBefore) + ' -> ' + fmtB(r.sizeAfter) + '  (' +
        (100 - 100 * r.sizeAfter / r.sizeBefore).toFixed(1) + ' % mindre)');
      rows.push('  instanser ' + r.instancesBefore + ' -> ' + r.instancesAfter +
        ', dubbletter ' + r.merged);
      if (r.geom && r.geom.facesBefore) rows.push('  ytor ' + r.geom.facesBefore + ' -> ' + r.geom.facesAfter +
        ' (' + r.geom.shellsSkipped + ' skal orörda)');
      rows.push('  kontroll: ' + (r.verify ? (r.verify.ok ? 'OK' : r.verify.problems.join('; ')) : 'ej körd'));
      const top = (r.removed || []).slice(0, 8).map(function (x) { return x.name + ' x' + x.count; });
      if (top.length) rows.push('  borttaget: ' + top.join(', '));
      rows.push('');
    }
    return rows.join('\n');
  }

  /* --- händelser ---------------------------------------------------------- */
  function bind() {
    const drop = $('drop'), input = $('fileInput');
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

    $('presetSeg').addEventListener('click', function (ev) {
      const b = ev.target.closest('button');
      if (b) setPreset(b.dataset.p);
    });
    $('tolSeg').addEventListener('click', function (ev) {
      const b = ev.target.closest('button');
      if (!b) return;
      const t = parseFloat(b.dataset.t);
      if (t === 0) opts.roundCoords = false;
      else { opts.roundCoords = true; opts.tolMm = t; }
      render();
    });
    $('runBtn').addEventListener('click', runAll);
    $('dlAll').addEventListener('click', function () {
      let d = 0;
      for (const f of files) {
        if (!f.result) continue;
        setTimeout(function (g) { return function () { download(g); }; }(f), d);
        d += 400;
      }
    });
    $('copyRep').addEventListener('click', function () {
      const t = reportText();
      navigator.clipboard.writeText(t).then(function () {
        logLine('Rapporten kopierad.', 'ok');
      }, function () {
        logLine('Kunde inte kopiera — markera i loggen i stället.', 'err');
      });
    });
  }

  /* --- start -------------------------------------------------------------- */
  opts = presetOptions('medel');
  startWorker();
  bind();
  render();
  logLine('Redo. Allt arbete sker lokalt — inga filer laddas upp någonstans.', 'ok');
  if (typeof CompressionStream === 'undefined') {
    logLine('Webbläsaren saknar CompressionStream — .ifczip blir okomprimerad.', 'warn');
  }
})();
