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
//   selector      steps to the next choice       absolute: picks by position,
//   (mode/style)                                 0..127 spread over the list;
//                                                encoder: one entry per click
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
//
// Plugin modes and transitions (orbitViz.registerMode/registerTransition,
// e.g. orbit_extras.js) each get a row of their own too -- "Halftone",
// "VHS", "Fade: Melt" -- built from the live registries, so a plugin
// registers nothing extra here: adding a mode makes it learnable. Their
// bindings persist by id like the fixed rows, and a row whose plugin
// is gone disappears until it comes back.
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
    { id: 'kRot', label: 'Rotate', target: 'param:rotate', key: null },
    { id: 'actAuto', label: 'Autopilot', target: 'autopilot:toggle', key: null },
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
    'param:rotate': 'Rotate view', 'autopilot:toggle': 'autopilot on/off',
  };
  const RELATIVE_CAPABLE = t => t.startsWith('param:') || t.startsWith('select:');

  // rows for whatever plugins have registered: one per non-built-in
  // mode (target mode:<id>) and per non-built-in transition
  // (transition:set:<id>)
  function pluginRows() {
    const viz = window.orbitViz;
    if (!viz || typeof viz.listModes !== 'function') return [];
    const rows = [];
    for (const m of viz.listModes()) if (!m.builtin) rows.push({ id: 'mode:' + m.id, label: m.label || m.id, target: 'mode:' + m.id, key: null, plugin: true });
    if (typeof viz.listTransitions === 'function') {
      for (const t of viz.listTransitions()) if (!t.builtin) rows.push({ id: 'fade:' + t.id, label: 'Fade: ' + (t.label || t.id), target: 'transition:set:' + t.id, key: null, plugin: true });
    }
    return rows;
  }
  let savedRows = [];         // what localStorage had, kept so a plugin row registered later still finds its key
  // Encoder clicks per entry on a selector row, per row and editable in
  // the panel: the mode sweep wants one click per mode, while the ASCII
  // chars knob at one per click ran through two or three sets on the
  // smallest twist (the MPK's encoders send several messages for it).
  const DEFAULT_CLICKS = { 'select:asciiRamp': 3 };
  function clicksOf(d, saved) {
    if (!d.target.startsWith('select:')) return undefined;
    const n = parseInt(saved, 10);
    return n >= 1 && n <= 12 ? n : (DEFAULT_CLICKS[d.target] || 1);
  }
  // Detent width, in knob values (of 127) either side of a parameter's
  // home -- see knobPosition. 0 turns detents off. Panel setting.
  const DETENT_KEY = 'weed.orbit.midi.detent';
  let detentZone = 4;
  try { const v = parseInt(localStorage.getItem(DETENT_KEY), 10); if (v >= 0 && v <= 12) detentZone = v; } catch (e) { /* private mode */ }
  function setDetent(n) {
    n = parseInt(n, 10);
    if (!(n >= 0 && n <= 12)) return;
    detentZone = n;
    try { localStorage.setItem(DETENT_KEY, String(n)); } catch (e) { /* quota */ }
  }
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

  // a fresh row from its definition plus whatever was saved for that id.
  // Keys saved before the kind prefix existed get one.
  function withSaved(d) {
    const s = savedRows.find(x => x && x.id === d.id);
    if (!s || typeof s.key !== 'string') return { ...d, clicks: clicksOf(d, s && s.clicks) };
    let key = s.key;
    if (!/^[nc]/.test(key)) key = (d.id.startsWith('k') ? 'c' : 'n') + key;
    return { ...d, key, relative: !!s.relative, clicks: clicksOf(d, s.clicks) };
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) savedRows = saved;
    } catch (e) { savedRows = []; }
    // saved rows override defaults by id; unknown ids are dropped, new
    // defaults appear -- so a table from an older build stays usable
    return [...DEFAULTS, ...pluginRows()].map(withSaved);
  }
  // plugins registered (or unregistered) since load(): add their rows,
  // keeping any saved key; drop rows whose plugin is gone
  function syncPluginRows() {
    const want = pluginRows();
    const have = new Set(bindings.map(b => b.id));
    let changed = false;
    for (const r of want) if (!have.has(r.id)) { bindings.push(withSaved(r)); changed = true; }
    const wantIds = new Set(want.map(r => r.id));
    const before = bindings.length;
    bindings = bindings.filter(b => !b.plugin || wantIds.has(b.id));
    return changed || bindings.length !== before;
  }
  function save() {
    try {
      // rows for plugins that aren't loaded right now keep their saved
      // entry, so their key is still there when the plugin comes back
      const live = bindings.map(b => ({ id: b.id, key: b.key, relative: !!b.relative, ...(b.clicks ? { clicks: b.clicks } : {}) }));
      const liveIds = new Set(live.map(b => b.id));
      const dormant = savedRows.filter(x => x && /^(mode|fade):/.test(x.id) && !liveIds.has(x.id) && x.key);
      savedRows = [...live, ...dormant];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRows));
    } catch (e) { /* quota/private */ }
  }

  // ── keymaps as files ─────────────────────────────────────────────
  // The export carries every row's id *and* target, so an import can
  // match by id (the normal case) or, for a row that has since been
  // renamed, by what it does. Plugin rows come along too; one whose
  // plugin isn't loaded here is kept dormant (see save()) until it is.
  const KEYMAP_FORMAT = 'weed.orbit.midi-keymap';
  function exportKeymap() {
    return {
      format: KEYMAP_FORMAT, version: 1, exported: new Date().toISOString(),
      device: deviceNames().join(', ') || null,
      bindings: bindings.map(b => ({ id: b.id, target: b.target, label: b.label, key: b.key, relative: !!b.relative, ...(b.clicks ? { clicks: b.clicks } : {}) })),
      detent: detentZone,
    };
  }
  function downloadKeymap() {
    const data = exportKeymap();
    const stamp = data.exported.slice(0, 19).replace(/[:T]/g, '-');
    const name = `weed-orbit-keymap-${(data.device || 'midi').replace(/[^\w.-]+/g, '_')}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return name;
  }
  // replaces the current bindings with the file's; rows the file doesn't
  // mention are left unbound. Returns how many rows got a key, or throws
  // on something that isn't a keymap.
  function importKeymap(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (!data || data.format !== KEYMAP_FORMAT || !Array.isArray(data.bindings)) throw new Error('not a weed Orbit keymap file');
    const rows = [...DEFAULTS, ...pluginRows()].map(d => ({ ...d, key: null, relative: false, clicks: clicksOf(d) }));
    let bound = 0;
    const dormant = [];
    for (const f of data.bindings) {
      if (!f || typeof f.id !== 'string') continue;
      const key = typeof f.key === 'string' && /^[nc](\*|\d+):\d+$/.test(f.key) ? f.key : null;
      const row = rows.find(r => r.id === f.id) || rows.find(r => f.target && r.target === f.target);
      if (row) { row.key = key; row.relative = !!f.relative; row.clicks = clicksOf(row, f.clicks); if (key) bound++; }
      else if (key && /^(mode|fade):/.test(f.id)) dormant.push({ id: f.id, key, relative: !!f.relative });
    }
    bindings = rows; savedRows = dormant; learning = null;
    if (data.detent !== undefined) setDetent(data.detent);
    save(); render();
    return bound;
  }
  function readKeymapFile(file) {
    if (!file) return;
    file.text().then(text => {
      const n = importKeymap(text);
      last = `imported ${n} binding${n === 1 ? '' : 's'} from ${file.name}`;
      render();
    }).catch(err => { last = 'import failed: ' + (err && err.message || err); render(); });
  }

  function describe(b) {
    if (TARGET_LABELS[b.target]) return TARGET_LABELS[b.target];
    if (b.target.startsWith('mode:')) return 'mode: ' + (b.plugin ? b.label : b.target.slice(5));
    if (b.target.startsWith('transition:set:')) return 'fade style: ' + b.label.replace(/^Fade: /, '');
    return b.target;
  }
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
  function fire(b, kind, v, ccKey, forceRel) {
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
      const cur = list.indexOf((viz.current() || {})[sel.current]);
      if (kind === 'note') {
        // a pad on a selector steps forward through the list
        idx = (Math.max(0, cur) + 1) % list.length;
      } else if (isRelative(b, ccKey)) {
        // an encoder moves one entry per b.clicks clicks (the row's own
        // setting, see clicksOf), clamped at the ends, never skipping
        // one. Clicks accumulate per row, a change of direction resets
        // the count, and a fast spin (bigger steps) still counts its size
        // so it gets down the list quicker.
        const step = stepOf(v), per = b.clicks || 1;
        let acc = selectAcc[b.id] || 0;
        if (acc * step < 0) acc = 0;
        acc += step;
        const move = Math.trunc(acc / per);
        selectAcc[b.id] = acc - move * per;
        if (!move) return;
        idx = Math.max(0, Math.min(list.length - 1, Math.max(0, cur) + move));
        if (idx === cur) return;
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
      else if (forceRel || isRelative(b, ccKey)) {
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
  const selectAcc = {};       // binding id -> encoder clicks accumulated toward the next entry
  // Detents. A parameter's home value (rotation straight, zoom 1x,
  // speed 1x) is hard to land on exactly: a pot's middle is 64/127, not
  // 0.5, and an encoder's 2% clicks from wherever a mouse drag left the
  // value never hit it. So a small dead zone around the home value: a
  // pot within detentZone values of it reads as exactly the detent, and
  // an encoder click that reaches or crosses it stops on it -- the next
  // click moves off again, so passing through costs one click. The
  // panel's "detent" field sets the width; 0 switches this off.
  function detentOf(b) {
    const viz = window.orbitViz;
    if (!detentZone || !b.target.startsWith('param:') || !viz.controlDetent) return null;
    return viz.controlDetent(b.target.slice(6));
  }
  function knobPosition(b, v, ccKey) {
    // absolute: the knob's 0..127 is the position. relative (ticked, or
    // auto-detected): 1..63 is +n steps, 65..127 is -(128-n) steps,
    // nudging a remembered position -- 2% per click, so a full sweep is
    // about 50 clicks, and a fast spin (the encoder sends bigger steps)
    // gets there quicker
    const d = detentOf(b), zone = detentZone / 127;
    if (!isRelative(b, ccKey)) {
      const pos = v / 127;
      return d !== null && Math.abs(pos - d) <= zone + 1e-9 ? d : pos;
    }
    // first nudge starts from where the parameter actually is
    const cur = relValue[b.id] !== undefined ? relValue[b.id]
              : (b.target.startsWith('param:') && b.target !== 'param:delay' ? window.orbitViz.controlPosition(b.target.slice(6)) : 0.5);
    const steps = stepOf(v) + (pendingSteps[ccKey] || 0);
    pendingSteps[ccKey] = 0;
    let next = Math.min(1, Math.max(0, cur + steps / 50));
    if (d !== null && steps !== 0 && Math.abs(cur - d) > 1e-9) {
      const crossed = (cur < d && next >= d) || (cur > d && next <= d);
      if (crossed || Math.abs(next - d) <= zone / 2) next = d;
    }
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
    const isAction = b && !b.target.startsWith('param:') && !b.target.startsWith('select:');
    if (b && kind === 'cc' && undecided(b, ccKey, v) && !isAction) {
      // a parameter: holding a lone step-looking value is what keeps an
      // undecided knob from slamming a slider to an end stop
      pendingSteps[ccKey] = (pendingSteps[ccKey] || 0) + stepOf(v);
    } else if (b) {
      // an action row takes a step-looking value as a click straight
      // away: the worst an absolute knob could do here is fire once,
      // while holding it meant the first two or three clicks did nothing
      fire(b, kind, v, ccKey, isAction && kind === 'cc' && isStep(v) && detectedRel[ccKey] === undefined);
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
      exportBtn: document.getElementById('midiExportBtn'),
      importBtn: document.getElementById('midiImportBtn'),
      importFile: document.getElementById('midiImportFile'),
      detent: document.getElementById('midiDetent'),
      last: document.getElementById('midiLast'),
    };
    if (els.detent) { els.detent.value = detentZone; els.detent.onchange = () => { setDetent(els.detent.value); els.detent.value = detentZone; }; }
    if (els.btn) els.btn.onclick = () => {
      panel.classList.toggle('mode-controls-hidden');
      els.btn.classList.toggle('active', !panel.classList.contains('mode-controls-hidden'));
      if (!panel.classList.contains('mode-controls-hidden') && !access) connect();
    };
    if (els.connect) els.connect.onclick = connect;
    if (els.reset) els.reset.onclick = () => { savedRows = []; bindings = [...DEFAULTS, ...pluginRows()].map(d => ({ ...d, clicks: clicksOf(d) })); learning = null; save(); render(); };
    if (els.exportBtn) els.exportBtn.onclick = () => { const name = downloadKeymap(); last = 'saved ' + name; render(); };
    if (els.importBtn && els.importFile) {
      els.importBtn.onclick = () => { els.importFile.value = ''; els.importFile.click(); };
      els.importFile.onchange = () => readKeymapFile(els.importFile.files && els.importFile.files[0]);
    }
    // The panel is a settings surface, not a status one: it stays folded
    // on every open, connected or not, until the 🎹 click. (It used to
    // unfold itself whenever permission had already been granted, so
    // every visualizer open started with the binding list expanded.)
    panel.classList.add('mode-controls-hidden');
    if (els.btn) els.btn.classList.remove('active');
    if (!access) autoConnect();
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
    syncPluginRows();
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
      if (b.clicks) {
        // selector rows: how many encoder clicks move one entry
        const per = document.createElement('label'); per.className = 'midi-clicks';
        per.title = 'encoder clicks per entry: 1 moves on every click, more makes a small twist do nothing';
        const n = document.createElement('input'); n.type = 'number'; n.min = 1; n.max = 12; n.step = 1; n.value = b.clicks;
        // only a real change resets the count: the browser fires change
        // again when render() pulls a focused field out of the DOM
        n.onchange = () => { const c = clicksOf(b, n.value); n.value = c; if (c !== b.clicks) { b.clicks = c; selectAcc[b.id] = 0; save(); } };
        per.append(n, document.createTextNode('clicks'));
        ctl.appendChild(per);
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
    selectAcc: () => ({ ...selectAcc }),
    status: () => status,
    // orbit_visualizer.js calls this when a plugin mode/transition is
    // registered or removed while the panel is up, so its row appears
    // (or goes) without waiting for the next MIDI message
    refresh: () => render(),
    // keymap files -- the panel's export/import buttons use these
    exportKeymap,
    importKeymap,
    // the detent width (knob values either side of a parameter's home)
    detent: () => detentZone,
    setDetent: (n) => { setDetent(n); if (els && els.detent) els.detent.value = detentZone; },
    _onMessage: onMessage,
  };
})();
