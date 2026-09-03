// Orbit Visualizer: hardware control over Web MIDI (Chrome/Edge/Firefox;
// needs https or localhost, which the UI already is). Pads pick modes and
// fire actions, knobs turn the sliders -- or sweep through modes and
// transition styles, or fire actions as they cross the middle. Everything
// goes through orbitViz.control()/trigger(), i.e. the same setters the
// on-screen controls use, so the thumbs and labels follow along and it
// all persists like any other change.
//
// A binding row is a *target* (what it does) plus whatever control the
// user learned onto it -- a pad/key (note) or a knob (CC), on any row.
// What a control does to a target depends on the pairing:
//
//   target        pad / key (note on)            knob (CC 0..127)
//   ---------     ---------------------------    -------------------------------
//   action        fires it                       fires it as the value crosses
//                                                the middle going up (64+)
//   selector      steps to the next choice       picks the choice by position:
//   (mode/style)                                 0..127 spread over the list
//   parameter     (nothing)                      sets it: 0..127 -> its range
//
// The defaults match an AKAI MPK mini's factory MIDI program (pads on
// channel 10: bank A notes 36-43, bank B 44-51; knobs K1-K8 as CC 70-77
// on the mk3 -- the IV numbers its knobs differently, so those rows are
// worth one round of Learn). Bindings live in localStorage.
//
// Knobs are read as absolute 0..127 unless a row's "rel" box is ticked:
// then 1..63 counts up and 65..127 counts down (the usual two-complement
// encoding an endless encoder uses in relative mode), applied to the
// row's current value.
//
// Note-off (0x8n, or 0x9n with velocity 0) is ignored: pads are
// triggers, not holds.
window.orbitMidi = (function () {
  const STORAGE_KEY = 'weed.orbit.midi';
  const DEFAULTS = [
    // pads, bank A (MPK mini: channel 10, notes 36-43)
    { id: 'pad1', label: 'Pad 1', target: 'mode:tunnel', key: 'n*:36' },
    { id: 'pad2', label: 'Pad 2', target: 'mode:bars', key: 'n*:37' },
    { id: 'pad3', label: 'Pad 3', target: 'mode:mirror', key: 'n*:38' },
    { id: 'pad4', label: 'Pad 4', target: 'mode:scope', key: 'n*:39' },
    { id: 'pad5', label: 'Pad 5', target: 'mode:spiral', key: 'n*:40' },
    { id: 'pad6', label: 'Pad 6', target: 'mode:pixels', key: 'n*:41' },
    { id: 'pad7', label: 'Pad 7', target: 'mode:ascii', key: 'n*:42' },
    { id: 'pad8', label: 'Pad 8', target: 'mode:plasma', key: 'n*:43' },
    // pads, bank B (notes 44-51)
    { id: 'padB1', label: 'Pad 9 (B1)', target: 'mode:kaleido', key: 'n*:44' },
    { id: 'padB2', label: 'Pad 10 (B2)', target: 'mode:particles', key: 'n*:45' },
    { id: 'padB3', label: 'Pad 11 (B3)', target: 'mode:freefall', key: 'n*:46' },
    { id: 'padB4', label: 'Pad 12 (B4)', target: 'video', key: 'n*:47' },
    { id: 'padB5', label: 'Pad 13 (B5)', target: 'flash', key: 'n*:48' },
    { id: 'padB6', label: 'Pad 14 (B6)', target: 'transition:next', key: 'n*:49' },
    { id: 'padB7', label: 'Pad 15 (B7)', target: 'next', key: 'n*:50' },
    { id: 'padB8', label: 'Pad 16 (B8)', target: 'resetNav', key: 'n*:51' },
    // knobs (mk3 factory CCs; the IV differs -- learn them)
    { id: 'k1', label: 'K1', target: 'param:speed', key: 'c*:70' },
    { id: 'k2', label: 'K2', target: 'param:reactivity', key: 'c*:71' },
    { id: 'k3', label: 'K3', target: 'param:zoom', key: 'c*:72' },
    { id: 'k4', label: 'K4', target: 'param:transitionMs', key: 'c*:73' },
    { id: 'k5', label: 'K5', target: 'param:asciiBrightness', key: 'c*:74' },
    { id: 'k6', label: 'K6', target: 'param:asciiStride', key: 'c*:75' },
    { id: 'k7', label: 'K7', target: 'param:asciiBgAlpha', key: 'c*:76' },
    { id: 'k8', label: 'K8', target: 'param:delay', key: 'c*:77' },
    // unbound rows: things a knob is good at (sweep to choose) and the
    // leftover actions, all one Learn away
    { id: 'selMode', label: 'Mode', target: 'select:mode', key: null },
    { id: 'selFade', label: 'Fade style', target: 'select:transition', key: null },
    { id: 'selChars', label: 'ASCII chars', target: 'select:asciiRamp', key: null },
    { id: 'actColor', label: 'ASCII color', target: 'ascii:color:toggle', key: null },
    { id: 'actPrev', label: 'Prev mode', target: 'prev', key: null },
    { id: 'actFadePrev', label: 'Prev fade', target: 'transition:prev', key: null },
    { id: 'kFreeW', label: 'Freefall size', target: 'param:buildingWidth', key: null },
    { id: 'kFreeH', label: 'Freefall bloom', target: 'param:buildingHeight', key: null },
    { id: 'kFreeN', label: 'Freefall count', target: 'param:buildingCount', key: null },
  ];
  const TARGET_LABELS = {
    video: 'video only (toggle)', flash: 'fire transition', 'transition:next': 'next fade style',
    'transition:prev': 'previous fade style', next: 'next mode', prev: 'previous mode', resetNav: 'reset zoom/pan',
    'select:mode': 'mode (sweep to choose)', 'select:transition': 'fade style (sweep to choose)',
    'select:asciiRamp': 'ASCII character set (sweep to choose)', 'ascii:color:toggle': 'ASCII color: natural / neon',
    'param:speed': 'Speed', 'param:reactivity': 'React', 'param:zoom': 'Zoom', 'param:transitionMs': 'Fade length',
    'param:asciiBrightness': 'ASCII brightness', 'param:asciiStride': 'ASCII resolution',
    'param:asciiBgAlpha': 'ASCII background', 'param:buildingWidth': 'Freefall size',
    'param:buildingHeight': 'Freefall bloom', 'param:buildingCount': 'Freefall count', 'param:delay': 'Audio delay',
  };
  const RELATIVE_CAPABLE = t => t.startsWith('param:') || t.startsWith('select:');

  let bindings = load();
  let access = null;          // MIDIAccess once granted
  let status = 'idle';        // idle | unsupported | denied | connected
  let learning = null;        // binding id waiting for the next message
  let last = '';              // last message, for the readout
  const lastCC = {};          // "ch:cc" -> last value, for the rising-edge math
  const relValue = {};        // binding id -> 0..1 position for relative knobs
  // Auto-detection of relative (endless-encoder) knobs, per CC. An
  // absolute knob sweeps through the middle values as it turns; a
  // relative one only ever says "+n" (1..15) or "-n" (113..127), which
  // read as "jump to min / jump to max" if taken as positions -- the
  // MPK mini IV's encoders do exactly this out of the box. A few
  // messages in a row that all look like steps settle it; one value
  // from the middle of the range un-settles it.
  const ccHistory = {};       // "ch:cc" -> last few values
  const detectedRel = {};     // "ch:cc" -> true/false once decided, undefined while unsure
  const pendingSteps = {};    // "ch:cc" -> steps seen while unsure, applied once it's decided relative
  const isStep = v => (v >= 1 && v <= 15) || (v >= 113 && v <= 127);
  function noteCC(ccKey, v) {
    const h = (ccHistory[ccKey] = (ccHistory[ccKey] || []).concat(v).slice(-6));
    // four step-looking values in a row with at most two distinct
    // values among them: an encoder clicking (1,1,1,1 / 127,127,1,1 /
    // 2,1,1,1). An absolute knob passing through the same region sweeps
    // (127,126,125,124) -- or repeats its end stop once and then sweeps
    // (127,127,126,125) -- which is three or more distinct values and
    // stays absolute.
    if (!isStep(v)) { detectedRel[ccKey] = false; pendingSteps[ccKey] = 0; }
    else if (h.length >= 4 && h.slice(-4).every(isStep) && new Set(h.slice(-4)).size <= 2) detectedRel[ccKey] = true;
  }
  function isRelative(b, ccKey) { return !!b.relative || !!detectedRel[ccKey]; }
  // still unsure about this knob and the value could be a step: don't
  // slam a parameter to min/max on what may be a single encoder click --
  // remember the step and apply it once the next message decides
  function undecided(b, ccKey, v) { return !b.relative && detectedRel[ccKey] === undefined && isStep(v); }
  function stepOf(v) { return v === 0 || v === 64 ? 0 : (v < 64 ? v : v - 128); }
  const inputsWired = new WeakSet();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) {
        // saved rows override defaults by id; unknown ids are dropped,
        // new defaults appear -- so a table from an older build stays
        // usable. Keys saved before the kind prefix existed get one.
        return DEFAULTS.map(d => {
          const s = saved.find(x => x && x.id === d.id);
          if (!s || typeof s.key !== 'string') return { ...d };
          let key = s.key;
          if (!/^[nc]/.test(key)) key = (d.id.startsWith('k') ? 'c' : 'n') + key;
          return { ...d, key, relative: !!s.relative };
        });
      }
    } catch (e) { /* fall through to defaults */ }
    return DEFAULTS.map(d => ({ ...d }));
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(
        bindings.map(b => ({ id: b.id, key: b.key, relative: !!b.relative }))));
    } catch (e) { /* quota/private */ }
  }

  function describe(b) { return TARGET_LABELS[b.target] || (b.target.startsWith('mode:') ? 'mode: ' + b.target.slice(5) : b.target); }
  function keyLabel(key) {
    if (!key) return '—';
    const kind = key[0], rest = key.slice(1);
    const [ch, n] = rest.split(':');
    return (kind === 'n' ? 'note ' : 'CC ') + n + (ch === '*' ? '' : ' ch' + (parseInt(ch, 10) + 1));
  }
  function find(kind, ch, n) {
    return bindings.find(b => b.key === `${kind}${ch}:${n}` || b.key === `${kind}*:${n}`);
  }

  // ── applying a control to a target ──────────────────────────────
  function fire(b, kind, v, ccKey) {
    const viz = window.orbitViz;
    if (!viz) return;
    const t = b.target;
    if (t.startsWith('param:')) {
      if (kind !== 'cc') return;
      applyParam(b, t.slice(6), knobPosition(b, v, ccKey));
    } else if (t.startsWith('select:')) {
      const sel = SELECTORS[t.slice(7)];
      const list = sel.list(viz);
      if (!list.length) return;
      let idx;
      if (kind === 'note') {
        // a pad on a selector steps forward through the list
        const cur = list.indexOf((viz.current() || {})[sel.current]);
        idx = (Math.max(0, cur) + 1) % list.length;
      } else {
        idx = Math.min(list.length - 1, Math.floor(knobPosition(b, v, ccKey) * list.length));
      }
      viz.trigger(sel.action + list[idx]);
    } else {
      // an action: a pad fires it. An absolute knob fires it once as it
      // crosses the middle going up (twist right = press, turn back and
      // press again). A relative encoder fires it on every clockwise
      // click -- and, for the actions that have an opposite, fires that
      // on a counter-clockwise click, so one knob walks both ways.
      if (kind === 'note') viz.trigger(t);
      else if (isRelative(b, ccKey)) {
        const step = stepOf(v);
        if (step > 0) viz.trigger(t);
        else if (step < 0 && OPPOSITE[t]) viz.trigger(OPPOSITE[t]);
      } else {
        const prev = lastCC[ccKey];
        if (prev !== undefined && prev < 64 && v >= 64) viz.trigger(t);
      }
    }
  }
  const OPPOSITE = { next: 'prev', prev: 'next', 'transition:next': 'transition:prev', 'transition:prev': 'transition:next' };
  // the selector-style targets: what they choose among, which field of
  // orbitViz.current() holds the choice, and the trigger prefix that sets it
  const SELECTORS = {
    mode: { list: viz => viz.modes(), current: 'mode', action: 'mode:' },
    transition: { list: viz => viz.transitions(), current: 'transition', action: 'transition:set:' },
    asciiRamp: { list: viz => viz.asciiRamps(), current: 'asciiRamp', action: 'ascii:ramp:' },
  };
  function knobPosition(b, v, ccKey) {
    // absolute: the knob's 0..127 is the position. relative (ticked, or
    // auto-detected): 1..63 is +n steps, 65..127 is -(128-n) steps,
    // nudging a remembered position -- 2% per click, so a full sweep is
    // about 50 clicks, and a fast spin (the encoder sends bigger steps)
    // gets there quicker
    if (!isRelative(b, ccKey)) return v / 127;
    // first nudge starts from where the parameter actually is
    const cur = relValue[b.id] !== undefined ? relValue[b.id]
              : (b.target.startsWith('param:') && b.target !== 'param:delay' ? window.orbitViz.controlPosition(b.target.slice(6)) : 0.5);
    const steps = stepOf(v) + (pendingSteps[ccKey] || 0);
    pendingSteps[ccKey] = 0;
    const next = Math.min(1, Math.max(0, cur + steps / 50));
    relValue[b.id] = next;
    return next;
  }
  function applyParam(b, param, pos) {
    if (param === 'delay') window.dispatchEvent(new CustomEvent('weed:orbit-delay', { detail: Math.round(pos * 10000) }));
    else window.orbitViz.control(param, pos);
  }

  function onMessage(e) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const type = d[0] & 0xF0, ch = d[0] & 0x0F, n = d[1], v = d.length > 2 ? d[2] : 0;
    let kind = null;
    if (type === 0x90 && v > 0) kind = 'note';
    else if (type === 0xB0) kind = 'cc';
    else return;   // note-off, aftertouch, pitch bend, clock: ignored
    const ccKey = `${ch}:${n}`;
    if (kind === 'cc') noteCC(ccKey, v);
    last = `${kind === 'note' ? 'note' : 'CC'} ${n} ch${ch + 1} = ${v}`
         + (kind === 'cc' && detectedRel[ccKey] ? ` (relative: ${stepOf(v) > 0 ? '+' : ''}${stepOf(v)})` : '');
    if (learning) {
      const b = bindings.find(x => x.id === learning);
      if (b) {
        // any control on any row -- see the pairing table up top
        b.key = `${kind === 'note' ? 'n' : 'c'}${ch}:${n}`;
        learning = null;
        save();
      }
      if (kind === 'cc') lastCC[ccKey] = v;
      render();
      return;
    }
    const b = find(kind === 'note' ? 'n' : 'c', ch, n);
    if (b && kind === 'cc' && undecided(b, ccKey, v)) {
      pendingSteps[ccKey] = (pendingSteps[ccKey] || 0) + stepOf(v);
    } else if (b) {
      fire(b, kind, v, ccKey);
    }
    if (kind === 'cc') lastCC[ccKey] = v;
    render();
  }

  function wireInputs() {
    if (!access) return;
    access.inputs.forEach(input => {
      if (inputsWired.has(input)) return;
      inputsWired.add(input);
      input.onmidimessage = onMessage;
    });
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) { status = 'unsupported'; render(); return; }
    if (access) { render(); return; }
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      status = 'connected';
      wireInputs();
      access.onstatechange = () => { wireInputs(); render(); };
    } catch (e) {
      status = 'denied';
    }
    render();
  }

  function deviceNames() {
    if (!access) return [];
    const names = [];
    access.inputs.forEach(i => {
      // ALSA's virtual loopback port is always there and never the controller
      if (i.state === 'connected' && !/midi through/i.test(i.name || '')) names.push(i.name || 'MIDI input');
    });
    return names;
  }

  // ── panel (lives inside the visualizer dialog; re-mounted per open) ──
  let els = null;
  function mount() {
    const panel = document.getElementById('midiPanel');
    if (!panel) return;
    els = {
      panel,
      btn: document.getElementById('vizMidiBtn'),
      status: document.getElementById('midiStatus'),
      list: document.getElementById('midiBindings'),
      connect: document.getElementById('midiConnectBtn'),
      reset: document.getElementById('midiResetBtn'),
      last: document.getElementById('midiLast'),
    };
    if (els.btn) els.btn.onclick = () => {
      panel.classList.toggle('mode-controls-hidden');
      els.btn.classList.toggle('active', !panel.classList.contains('mode-controls-hidden'));
      if (!panel.classList.contains('mode-controls-hidden') && !access) connect();
    };
    if (els.connect) els.connect.onclick = connect;
    if (els.reset) els.reset.onclick = () => { bindings = DEFAULTS.map(d => ({ ...d })); learning = null; save(); render(); };
    if (access) { els.btn && els.btn.classList.add('active'); panel.classList.remove('mode-controls-hidden'); }
    else autoConnect();
    render();
  }

  // Permission already granted on an earlier visit (the browser remembers
  // it per site): connect without waiting for the 🎹 click, so the pads
  // work the moment the visualizer opens. Anything else (never asked,
  // denied, no Permissions API) waits for the click, which is also the
  // user gesture Chrome wants before it will show the prompt.
  function autoConnect() {
    if (!navigator.permissions || !navigator.permissions.query || !navigator.requestMIDIAccess) return;
    navigator.permissions.query({ name: 'midi', sysex: false })
      .then(p => { if (p.state === 'granted') connect(); })
      .catch(() => {});
  }

  function render() {
    if (!els || !document.body.contains(els.panel)) return;
    const names = deviceNames();
    els.status.textContent =
      status === 'unsupported' ? 'this browser has no Web MIDI (Chrome, Edge and Firefox do; Safari does not)'
      : status === 'denied' ? 'MIDI access was refused — allow it in the site permissions and connect again'
      : status === 'connected' ? (names.length ? 'listening to ' + names.join(', ') : 'connected — no MIDI device plugged in')
      : 'not connected';
    els.connect.style.display = status === 'connected' ? 'none' : '';
    els.last.textContent = last ? 'last: ' + last : '';
    els.list.innerHTML = '';
    for (const b of bindings) {
      const row = document.createElement('div');
      row.className = 'midi-row' + (learning === b.id ? ' learning' : '') + (b.key ? '' : ' unbound');
      const lbl = document.createElement('span'); lbl.className = 'midi-label'; lbl.textContent = b.label;
      const what = document.createElement('span'); what.className = 'midi-what'; what.textContent = describe(b);
      const key = document.createElement('span'); key.className = 'midi-key';
      key.textContent = learning === b.id ? 'hit a pad or turn a knob…' : keyLabel(b.key);
      const ctl = document.createElement('span'); ctl.className = 'midi-ctl';
      if (RELATIVE_CAPABLE(b.target)) {
        const rel = document.createElement('label'); rel.className = 'midi-rel';
        const auto = b.key && b.key[0] === 'c' && detectedRel[b.key.slice(1)];
        rel.title = auto ? 'this knob was detected as a relative (endless) encoder; tick to force it regardless'
                         : 'tick if this knob sends relative (endless-encoder) steps rather than a 0-127 position -- normally detected on its own';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!b.relative;
        cb.onchange = () => { b.relative = cb.checked; save(); };
        rel.append(cb, document.createTextNode(auto && !b.relative ? 'rel (auto)' : 'rel'));
        ctl.appendChild(rel);
      }
      const learn = document.createElement('button');
      learn.type = 'button'; learn.className = 'icon-btn'; learn.textContent = learning === b.id ? 'cancel' : 'learn';
      learn.title = 'click, then hit the pad/key or turn the knob to use for this';
      learn.onclick = () => { learning = learning === b.id ? null : b.id; if (learning && !access) connect(); render(); };
      ctl.appendChild(learn);
      if (b.key) {
        const clear = document.createElement('button');
        clear.type = 'button'; clear.className = 'icon-btn'; clear.textContent = '✕'; clear.title = 'unbind';
        clear.onclick = () => { b.key = null; save(); render(); };
        ctl.appendChild(clear);
      }
      row.append(lbl, what, key, ctl);
      els.list.appendChild(row);
    }
  }

  return {
    mount, connect,
    // for tests / debugging
    bindings: () => bindings.map(b => ({ ...b })),
    status: () => status,
    _onMessage: onMessage,
  };
})();
