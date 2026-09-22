/* ==========================================================================
   diag/app.js  ·  gränssnittet för diagnosen
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
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' kB';
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  };
  const fmtN = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };
  const pct = function (x) { return (x * 100).toFixed(1).replace('.', ',') + ' %'; };

  /* --- motorn -------------------------------------------------------------- */
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
        if (d.type === 'error') job.reject(new Error(d.message));
        else job.resolve(d);
      };
      worker.onerror = function () { if (!ok) useDirect(src); };
      worker.postMessage({ cmd: 'ping', id: 0 });
      setTimeout(function () { if (!ok) useDirect(src); }, 4000);
    } catch (e) { useDirect(src); }
  }

  function useDirect(src) {
    if (direct) return;
    try {
      worker = null;
      direct = new Function(src + '\nreturn { runDiagnosis: runDiagnosis };')();
      $('engineState').textContent = 'motor · redo (förgrund)';
      logLine('Webbläsaren tillåter ingen bakgrundstråd här — analysen körs i förgrunden ' +
              'och fönstret står stilla en stund.', 'warn');
    } catch (e) {
      $('engineState').textContent = 'motor · fel';
      $('engineState').className = 'tag bad';
      logLine('Motorn kunde inte startas: ' + (e && e.message), 'err');
    }
  }

  function ask(payload, onLog, onProg) {
    if (direct) {
      const hooks = { log: onLog || function () {}, prog: onProg || function () {} };
      return new Promise(function (r) { setTimeout(r, 40); }).then(async function () {
        return { result: await direct.runDiagnosis(payload.file, payload.opts, payload.configText, hooks) };
      });
    }
    const id = ++reqId;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject, onLog: onLog, onProg: onProg });
      worker.postMessage(Object.assign({ cmd: 'diagnose', id: id }, payload));
    });
  }

  /* --- tillstånd ---------------------------------------------------------- */
  const files = [];
  let active = null;
  let cfgFile = null, cfgText = null;
  let busy = false;

  function logLine(text, cls) {
    const box = $('log');
    const t = new Date();
    const ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    const line = el('div');
    line.appendChild(el('span', 'ts', ts + '  '));
    line.appendChild(el('span', cls || '', text));
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* --- filhantering ------------------------------------------------------- */
  function addFiles(fl) {
    for (const file of fl) {
      const low = file.name.toLowerCase();
      if (!(low.endsWith('.ifc') || low.endsWith('.ifczip'))) continue;
      files.push({ file: file, result: null, err: null, state: 'väntar' });
    }
    if (!active && files.length) active = files[0];
    render();
  }

  async function setConfig(file) {
    cfgFile = file;
    try {
      cfgText = await file.text();
      const probe = JSON.parse(cfgText.replace(/^﻿/, ''));
      const n = Array.isArray(probe) ? (probe[0] && probe[0].Name) : probe.Name;
      logLine('Läste inställningar' + (n ? ': ' + n : '') + '.', 'ok');
    } catch (e) {
      cfgText = null;
      logLine('Kunde inte läsa inställningsfilen: ' + e.message, 'err');
    }
    render();
  }

  function render() {
    const list = $('fileList');
    list.innerHTML = '';
    let tot = 0;
    for (const f of files) {
      tot += f.file.size;
      const box = el('div', 'file');
      if (f === active) box.style.borderColor = 'var(--mint)';
      const r1 = el('div', 'row1');
      const nm = el('div', 'nm', f.file.name);
      nm.style.cursor = 'pointer';
      nm.addEventListener('click', function () { active = f; render(); showReport(); });
      r1.appendChild(nm);
      r1.appendChild(el('div', 'sz', fmtB(f.file.size)));
      r1.appendChild(el('div', 'state ' + (f.result ? 'ok' : (f.err ? 'err' : '')), f.err ? 'fel' : f.state));
      const x = el('button', 'x', '×');
      x.addEventListener('click', function () {
        const i = files.indexOf(f); if (i >= 0) files.splice(i, 1);
        if (active === f) active = files[0] || null;
        render(); showReport();
      });
      r1.appendChild(x);
      box.appendChild(r1);
      if (f.err) {
        const e = el('div', 'meta');
        e.innerHTML = '<span style="color:var(--danger)">' + f.err + '</span>';
        box.appendChild(e);
      }
      if (f.prog !== undefined && f.prog < 1) {
        const bar = el('div', 'bar'); const i = el('i');
        i.style.width = Math.round(f.prog * 100) + '%'; bar.appendChild(i); box.appendChild(bar);
      }
      list.appendChild(box);
    }
    $('fileSum').textContent = files.length ? files.length + ' filer · ' + fmtB(tot) : '';

    const cl = $('cfgList');
    cl.innerHTML = '';
    if (cfgFile) {
      const box = el('div', 'file');
      const r1 = el('div', 'row1');
      r1.appendChild(el('div', 'nm', cfgFile.name));
      r1.appendChild(el('div', 'state ' + (cfgText ? 'ok' : 'err'), cfgText ? 'inläst' : 'fel'));
      const x = el('button', 'x', '×');
      x.addEventListener('click', function () { cfgFile = null; cfgText = null; render(); });
      r1.appendChild(x);
      box.appendChild(r1);
      cl.appendChild(box);
    }

    $('runBtn').disabled = busy || !files.length;
    $('runBtn').textContent = busy ? 'Analyserar…' : 'Analysera';
  }

  /* --- körning ------------------------------------------------------------ */
  async function runAll() {
    if (busy) return;
    busy = true; render();
    for (const f of files) {
      if (f.result) continue;
      f.state = 'analyserar'; f.prog = 0; f.err = null; render();
      $('phase').textContent = f.file.name;
      try {
        const res = await ask({ file: f.file, opts: baseOptions(), configText: cfgText },
          function (t) { logLine('  ' + t, /VARNING/.test(t) ? 'warn' : ''); },
          function (phase, frac) {
            f.prog = frac; render();
            $('bar').style.width = Math.round(frac * 100) + '%';
            $('phase').textContent = f.file.name + ' · ' + phase;
          });
        f.result = res.result; f.state = 'klar'; f.prog = 1;
        active = f;
        const s = f.result.summary;
        logLine(f.file.name + ': ' + fmtB(f.result.report.bytes) + ', ' +
                f.result.findings.length + ' fynd — ' + fmtB(s.lossless) +
                ' går att ta bort utan att tappa något.', 'ok');
        if (f.result.configError) logLine('Inställningsfilen: ' + f.result.configError, 'err');
      } catch (e) {
        f.err = e.message; f.state = 'fel'; f.prog = 1;
        logLine(f.file.name + ': ' + e.message, 'err');
      }
      render();
    }
    $('bar').style.width = '100%';
    $('phase').textContent = 'klart';
    busy = false; render(); showReport();
  }

  /* --- rapporten ---------------------------------------------------------- */
  function showReport() {
    const has = active && active.result;
    for (const id of ['sumCard', 'findCard', 'tblCard']) $(id).style.display = has ? '' : 'none';
    $('cfgCard').style.display = (has && active.result.config) ? '' : 'none';
    if (!has) return;
    const R = active.result, rep = R.report, d = R.diag, s = R.summary;
    const ca = (R.sampled || rep.sampled) ? '≈' : '';

    $('sumFor').textContent = active.file.name;
    const meta = $('modelMeta');
    meta.innerHTML = '';
    const mAdd = function (k, v) { const e = el('span'); e.innerHTML = k + ' <b style="color:var(--text);font-weight:400">' + v + '</b>'; meta.appendChild(e); };
    mAdd('storlek', fmtB(rep.bytes));
    mAdd('schema', rep.schema || '?');
    mAdd('enhet', rep.unit.label);
    mAdd('instanser', ca + fmtN(rep.instances));
    mAdd('byggdelar', ca + fmtN(d.products));
    if (rep.tool) mAdd('exporterad med', String(rep.tool).slice(0, 40));
    if (R.degraded) mAdd('obs', 'förenklad diagnos — filen är för stor för full genomgång');
    else if (R.sampled || rep.sampled) mAdd('obs', 'siffrorna är uppräknade ur ett urval av filen');

    const g = $('sumGrid');
    g.innerHTML = '';
    const sbox = function (k, v, cls, d2) {
      const b = el('div', 'sumbox');
      b.appendChild(el('div', 'k', k));
      b.appendChild(el('div', 'v ' + (cls || ''), v));
      b.appendChild(el('div', 'd', d2));
      g.appendChild(b);
    };
    sbox('utan att tappa något', fmtB(s.lossless), '',
         'Dubbletter, decimalbrus och geometri som kunde varit extrusioner. Modellen är likadan efteråt.');
    sbox('sällan använd metadata', fmtB(s.meta), 'warn',
         'Revit-parametrar, mängder, 2D-linjer, lådor. Försvinner ur IFC:n men finns kvar i Revit.');
    sbox('kräver ett beslut', fmtB(s.lossy), 'bad',
         'Rum, rumsavgränsningar, standard-Pset, mesh-upplösning. Någon kan behöva det — stäm av.');
    if (s.rework) {
      const b = el('div', 'warnbox');
      b.style.gridColumn = '1 / -1';
      b.innerHTML = '<b>' + fmtB(s.rework) + '</b> ligger dessutom i geometri som är tyngre än den ' +
        'behöver vara. Den siffran räknas inte in ovan, för den försvinner inte med en kryssruta — ' +
        'den kräver att något görs om i modellen. Se fynden nedan.';
      g.appendChild(b);
    }

    const zip = R.findings.find(function (f) { return f.id === 'zip'; });
    if (zip) {
      $('zipBox').style.display = '';
      $('zipBox').innerHTML = zip.klar
        ? '<b>Zippat redan.</b> ' + zip.orsak
        : '<b>Snabbaste vinsten:</b> spara som zippad IFC. Det skulle ta filen från ' +
          fmtB(rep.bytes) + ' till ungefär ' + fmtB(rep.bytes * 0.13) +
          ' utan att en enda rad information försvinner — och det ovanpå allt annat nedan.';
    } else $('zipBox').style.display = 'none';

    /* fynden */
    const box = $('findings');
    box.innerHTML = '';
    const maxB = Math.max.apply(null, R.findings.map(function (f) { return f.bytes; }).concat([1]));
    let i = 0;
    for (const f of R.findings) {
      if (f.id === 'zip') continue;
      const c = el('div', 'finding' + (i < 3 ? ' top' : ''));
      i++;
      c.appendChild(el('h3', null, f.titel));
      const w = el('div', 'weight');
      if (f.bytes > 0) {
        w.appendChild(el('div', 'mb', fmtB(f.bytes)));
        w.appendChild(el('div', 'pc', pct(f.share) + ' av filen'));
        if (f.kraverModellarbete) w.appendChild(el('div', 'pc', '· ingen kryssruta tar bort detta'));
      } else {
        w.appendChild(el('div', 'pc', 'ingen direkt vikt — men påverkar hela exporten'));
      }
      c.appendChild(w);
      if (f.bytes > 0) {
        const tr = el('div', 'track'); const ii = el('i');
        ii.style.width = Math.max(2, Math.round(f.bytes / maxB * 100)) + '%';
        tr.appendChild(ii); c.appendChild(tr);
      }
      const dl = el('dl');
      const row = function (k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); };
      row('vad', f.vad);
      row('varför', f.orsak);
      row('gör så här', f.atgard);
      c.appendChild(dl);

      if (f.installning && REVIT_SETTINGS[f.installning]) {
        const meta2 = REVIT_SETTINGS[f.installning];
        const cur = R.config ? R.config.known.find(function (x) { return x.key === f.installning; }) : null;
        const sr = el('div', 'setting');
        sr.appendChild(el('span', 'tab', meta2.tab));
        sr.appendChild(el('span', 'lbl', meta2.label));
        if (cur) {
          const v = cur.value;
          const isBool = typeof v === 'boolean';
          const shown = isBool ? (v ? 'PÅ' : 'AV') : String(v);
          const good = f.börVara === undefined ? null : (v === f.börVara);
          const n = el('span', 'now ' + (good === true ? 'ok' : (isBool && v ? 'on' : 'off')),
                       'din inställning: ' + shown);
          sr.appendChild(n);
          if (f.börVara !== undefined && good === false) {
            sr.appendChild(el('span', 'now on', '→ bör vara ' +
              (typeof f.börVara === 'boolean' ? (f.börVara ? 'PÅ' : 'AV') : f.börVara)));
          }
        } else {
          sr.appendChild(el('span', 'now off', 'ladda in din uppsättning för att se värdet'));
        }
        c.appendChild(sr);
      }

      const tags = el('div', 'tagrow');
      const tg = function (t, cls) { tags.appendChild(el('span', 'tag2 ' + cls, t)); };
      if (f.forlust === 'ingen') tg('förlustfritt', 'ok');
      else if (f.forlust === 'metadata') tg('tappar metadata', 'meta');
      else tg('kräver beslut', 'loss');
      if (f.installning === null) tg('ingen exportinställning styr detta', '');
      c.appendChild(tags);
      box.appendChild(c);
    }

    /* tabeller */
    const ct = $('classTbl');
    ct.innerHTML = '<tr><th>byggdelsklass</th><th class="num">objekt</th><th class="num">geometri</th>' +
                   '<th class="num">byte/objekt</th><th>form</th><th class="wbar"></th></tr>';
    const maxC = d.classes.length ? d.classes[0].bytes : 1;
    for (const c of d.classes.slice(0, 22)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'name', c.cls));
      tr.appendChild(el('td', 'num', fmtN(c.products)));
      tr.appendChild(el('td', 'num', fmtB(c.bytes)));
      tr.appendChild(el('td', 'num', fmtB(c.perProduct)));
      const forms = Object.keys(c.forms).sort(function (a, b) { return c.forms[b] - c.forms[a]; });
      tr.appendChild(el('td', null, forms.slice(0, 2).join(', ')));
      const td = el('td', 'wbar');
      const b2 = el('div', 'bar2'); const ii = el('i');
      ii.style.width = Math.max(2, Math.round(c.bytes / maxC * 100)) + '%';
      b2.appendChild(ii); td.appendChild(b2); tr.appendChild(td);
      ct.appendChild(tr);
    }

    const pt = $('psetTbl');
    pt.innerHTML = '<tr><th>uppsättning</th><th>sort</th><th class="num">antal</th><th class="num">byte</th><th class="wbar"></th></tr>';
    const maxP = d.psets.length ? d.psets[0].bytes : 1;
    for (const p of d.psets.slice(0, 20)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'name', p.name));
      tr.appendChild(el('td', null, isRevitPset(p.name) ? 'Revit' : p.kind));
      tr.appendChild(el('td', 'num', fmtN(p.count)));
      tr.appendChild(el('td', 'num', fmtB(p.bytes)));
      const td = el('td', 'wbar');
      const b2 = el('div', 'bar2'); const ii = el('i');
      ii.style.width = Math.max(2, Math.round(p.bytes / maxP * 100)) + '%';
      b2.appendChild(ii); td.appendChild(b2); tr.appendChild(td);
      pt.appendChild(tr);
    }

    const ft = $('formTbl');
    ft.innerHTML = '<tr><th>representationsform</th><th class="num">representationer</th><th class="num">byte</th><th class="num">andel</th></tr>';
    const totForm = d.forms.reduce(function (a, b) { return a + b.bytes; }, 0) || 1;
    for (const f2 of d.forms.slice(0, 12)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'name', f2.rtype));
      tr.appendChild(el('td', 'num', fmtN(f2.reps)));
      tr.appendChild(el('td', 'num', fmtB(f2.bytes)));
      tr.appendChild(el('td', 'num', pct(f2.bytes / totForm)));
      ft.appendChild(tr);
    }

    /* inställningarna */
    if (R.config) {
      $('cfgName').textContent = R.config.name || '';
      const body = $('cfgBody');
      body.innerHTML = '';
      const flagged = {};
      for (const f of R.findings) if (f.installning && f.börVara !== undefined) flagged[f.installning] = f.börVara;
      const tabs = {};
      for (const k of R.config.known) {
        (tabs[k.tab] = tabs[k.tab] || []).push(k);
      }
      for (const tab of ['General', 'Additional Content', 'Property Sets', 'Level of Detail', 'Advanced']) {
        if (!tabs[tab]) continue;
        body.appendChild(el('div', 'cfgtab', tab));
        for (const k of tabs[tab]) {
          const isBool = typeof k.value === 'boolean';
          let shown = String(k.value);
          if (isBool) shown = k.value ? 'PÅ' : 'AV';
          if (k.key === 'IFCFileType') shown = FILE_TYPES[k.value] || shown;
          if (k.key === 'SpaceBoundaries') shown = SPACE_BOUNDARY_LEVELS[k.value] || shown;
          const bad = (k.key in flagged) && k.value !== flagged[k.key];
          const r = el('div', 'cfgrow' + (bad ? ' flag' : ''));
          const lab = el('div', null, k.label + (bad ? '  ← se fyndet ovan' : ''));
          r.appendChild(lab);
          r.appendChild(el('div', 'val ' + (isBool ? (k.value ? 'on' : 'off') : 'neutral'), shown));
          body.appendChild(r);
        }
      }
    }
  }

  function reportText() {
    if (!active || !active.result) return '';
    const R = active.result, rep = R.report, s = R.summary;
    const L = ['IFC Diagnos — BIM Engine', new Date().toLocaleString('sv-SE'), '',
               'Fil: ' + active.file.name,
               'Storlek: ' + fmtB(rep.bytes) + '   schema ' + rep.schema + '   enhet ' + rep.unit.label,
               'Exporterad med: ' + (rep.tool || 'okänt'), ''];
    L.push('Möjlig besparing:');
    L.push('  utan att tappa något:      ' + fmtB(s.lossless));
    L.push('  sällan använd metadata:    ' + fmtB(s.meta));
    L.push('  kräver ett beslut:         ' + fmtB(s.lossy));
    L.push('');
    L.push('FYND');
    for (const f of R.findings) {
      L.push('');
      L.push('* ' + f.titel + (f.bytes ? '  (' + fmtB(f.bytes) + ', ' + pct(f.share) + ')' : ''));
      L.push('  Vad:     ' + f.vad);
      L.push('  Varför:  ' + f.orsak);
      L.push('  Åtgärd:  ' + f.atgard);
      if (f.installning && REVIT_SETTINGS[f.installning]) {
        const m = REVIT_SETTINGS[f.installning];
        const cur = R.config ? R.config.known.find(function (x) { return x.key === f.installning; }) : null;
        L.push('  Inställning: [' + m.tab + '] ' + m.label +
               (cur ? '  (din: ' + cur.value + ')' : ''));
      }
    }
    L.push('');
    L.push('TYNGSTA BYGGDELSKLASSERNA');
    for (const c of R.diag.classes.slice(0, 12)) {
      L.push('  ' + c.cls.padEnd(30) + fmtN(c.products).padStart(8) + ' st   ' +
             fmtB(c.bytes).padStart(10) + '   ' + fmtB(c.perProduct) + '/objekt');
    }
    return L.join('\n');
  }

  /* --- händelser ---------------------------------------------------------- */
  function bindDrop(zone, input, handler) {
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { handler(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (e) {
      zone.addEventListener(e, function (ev) { ev.preventDefault(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (e) {
      zone.addEventListener(e, function (ev) { ev.preventDefault(); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files) handler(ev.dataTransfer.files);
    });
  }

  function bind() {
    bindDrop($('drop'), $('fileInput'), addFiles);
    bindDrop($('dropCfg'), $('cfgInput'), function (fl) { if (fl && fl[0]) setConfig(fl[0]); });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
    $('runBtn').addEventListener('click', runAll);
    $('copyRep').addEventListener('click', function () {
      navigator.clipboard.writeText(reportText()).then(
        function () { logLine('Rapporten kopierad — klistra in den i mejlet till modellören.', 'ok'); },
        function () { logLine('Kunde inte kopiera.', 'err'); });
    });
  }

  startWorker();
  bind();
  render();
  logLine('Redo. Dra in en IFC och gärna din exportuppsättning från Revit.', 'ok');
})();
