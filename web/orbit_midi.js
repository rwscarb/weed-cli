// Orbit Visualizer: hardware control over Web MIDI (Chrome/Edge/Firefox;
// needs https or localhost, which the UI already is). Pads pick modes and
// fire actions, knobs turn the sliders. Everything goes through
// orbitViz.control()/trigger(), i.e. the same setters the on-screen
// controls use, so the thumbs and labels follow along and it all
// persists like any other change.
//
// Bindings are a table of {id, label, kind: 'note'|'cc', key} rows. A key
// is "<channel>:<number>" -- '*' for any channel. The defaults match an
// AKAI MPK mini's factory program (pads on channel 10: bank A notes
// 36-43, bank B 44-51; knobs K1-K8 on channel 1 as CC 70-77), but every
// row has a Learn button: click it, touch the pad/knob, done. The table
// lives in localStorage, same as the visualizer's own settings.
//
// Knobs are read as absolute 0..127 (the MPK's default). A knob set to
// relative/increment mode in Akai's editor will look like it jumps
// between two values -- switch it back to absolute.
//
// Note-off (0x8n, or 0x9n with velocity 0) is ignored: pads are
// triggers, not holds.
window.orbitMidi = (function () {
  const STORAGE_KEY = 'weed.orbit.midi';
  const DEFAULTS = [
    // pads, bank A (MPK mini: channel 10, notes 36-43)
    { id: 'pad1', label: 'Pad 1', kind: 'note', key: '*:36', action: 'mode:tunnel' },
    { id: 'pad2', label: 'Pad 2', kind: 'note', key: '*:37', action: 'mode:bars' },
    { id: 'pad3', label: 'Pad 3', kind: 'note', key: '*:38', action: 'mode:mirror' },
    { id: 'pad4', label: 'Pad 4', kind: 'note', key: '*:39', action: 'mode:scope' },
    { id: 'pad5', label: 'Pad 5', kind: 'note', key: '*:40', action: 'mode:spiral' },
    { id: 'pad6', label: 'Pad 6', kind: 'note', key: '*:41', action: 'mode:pixels' },
    { id: 'pad7', label: 'Pad 7', kind: 'note', key: '*:42', action: 'mode:ascii' },
    { id: 'pad8', label: 'Pad 8', kind: 'note', key: '*:43', action: 'mode:plasma' },
    // pads, bank B (notes 44-51)
    { id: 'padB1', label: 'Pad 9 (B1)', kind: 'note', key: '*:44', action: 'mode:kaleido' },
    { id: 'padB2', label: 'Pad 10 (B2)', kind: 'note', key: '*:45', action: 'mode:particles' },
    { id: 'padB3', label: 'Pad 11 (B3)', kind: 'note', key: '*:46', action: 'mode:freefall' },
    { id: 'padB4', label: 'Pad 12 (B4)', kind: 'note', key: '*:47', action: 'video' },
    { id: 'padB5', label: 'Pad 13 (B5)', kind: 'note', key: '*:48', action: 'flash' },
    { id: 'padB6', label: 'Pad 14 (B6)', kind: 'note', key: '*:49', action: 'transition:next' },
    { id: 'padB7', label: 'Pad 15 (B7)', kind: 'note', key: '*:50', action: 'next' },
    { id: 'padB8', label: 'Pad 16 (B8)', kind: 'note', key: '*:51', action: 'resetNav' },
    // knobs K1-K8 (CC 70-77)
    { id: 'k1', label: 'K1', kind: 'cc', key: '*:70', param: 'speed' },
    { id: 'k2', label: 'K2', kind: 'cc', key: '*:71', param: 'reactivity' },
    { id: 'k3', label: 'K3', kind: 'cc', key: '*:72', param: 'zoom' },
    { id: 'k4', label: 'K4', kind: 'cc', key: '*:73', param: 'transitionMs' },
    { id: 'k5', label: 'K5', kind: 'cc', key: '*:74', param: 'asciiBrightness' },
    { id: 'k6', label: 'K6', kind: 'cc', key: '*:75', param: 'asciiStride' },
    { id: 'k7', label: 'K7', kind: 'cc', key: '*:76', param: 'asciiBgAlpha' },
    { id: 'k8', label: 'K8', kind: 'cc', key: '*:77', param: 'delay' },
  ];
  const ACTION_LABELS = {
    video: 'video only (toggle)', flash: 'fire transition', 'transition:next': 'next transition style',
    next: 'next mode', prev: 'previous mode', resetNav: 'reset zoom/pan',
  };
  const PARAM_LABELS = {
    speed: 'Speed', reactivity: 'React', zoom: 'Zoom', transitionMs: 'Fade length',
    asciiBrightness: 'ASCII brightness', asciiStride: 'ASCII resolution', asciiBgAlpha: 'ASCII background',
    buildingWidth: 'Freefall size', buildingHeight: 'Freefall bloom', buildingCount: 'Freefall count',
    delay: 'Audio delay',
  };

  let bindings = load();
  let access = null;          // MIDIAccess once granted
  let status = 'idle';        // idle | unsupported | denied | connected
  let learning = null;        // binding id waiting for the next message
  let last = '';              // last message, for the readout
  const inputsWired = new WeakSet();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) {
        // saved rows override defaults by id; unknown ids are dropped,
        // new defaults appear -- so a bindings table from an older build
        // stays usable
        return DEFAULTS.map(d => {
          const s = saved.find(x => x && x.id === d.id);
          return s && typeof s.key === 'string' ? { ...d, key: s.key } : { ...d };
        });
      }
    } catch (e) { /* fall through to defaults */ }
    return DEFAULTS.map(d => ({ ...d }));
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings.map(b => ({ id: b.id, key: b.key })))); } catch (e) { /* quota/private */ }
  }

  function describe(b) {
    return b.kind === 'note' ? (ACTION_LABELS[b.action] || ('mode: ' + b.action.slice(5)))
                             : (PARAM_LABELS[b.param] || b.param);
  }
  function keyLabel(key) {
    if (!key) return '—';
    const [ch, n] = key.split(':');
    return (ch === '*' ? '' : 'ch' + (parseInt(ch, 10) + 1) + ' ') + n;
  }

  function find(kind, ch, n) {
    return bindings.find(b => b.kind === kind && (b.key === `${ch}:${n}` || b.key === `*:${n}`));
  }

  function onMessage(e) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const type = d[0] & 0xF0, ch = d[0] & 0x0F, n = d[1], v = d.length > 2 ? d[2] : 0;
    let kind = null;
    if (type === 0x90 && v > 0) kind = 'note';
    else if (type === 0xB0) kind = 'cc';
    else return;   // note-off, aftertouch, pitch bend, clock: ignored
    last = `${kind === 'note' ? 'note' : 'CC'} ${n} ch${ch + 1} = ${v}`;
    if (learning) {
      const b = bindings.find(x => x.id === learning);
      if (b && b.kind === kind) {
        b.key = `${ch}:${n}`;
        learning = null;
        save();
        render();
        return;
      }
      // wrong kind for what's being learned (a knob for a pad slot):
      // keep waiting, but show it in the readout
      render();
      return;
    }
    const b = find(kind, ch, n);
    render();
    if (!b || !window.orbitViz) return;
    if (kind === 'note') window.orbitViz.trigger(b.action);
    else if (b.param === 'delay') window.dispatchEvent(new CustomEvent('weed:orbit-delay', { detail: Math.round(v / 127 * 10000) }));
    else window.orbitViz.control(b.param, v / 127);
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
    access.inputs.forEach(i => { if (i.state === 'connected') names.push(i.name || 'MIDI input'); });
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
    render();
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
      row.className = 'midi-row' + (learning === b.id ? ' learning' : '');
      const lbl = document.createElement('span'); lbl.className = 'midi-label'; lbl.textContent = b.label;
      const what = document.createElement('span'); what.className = 'midi-what'; what.textContent = describe(b);
      const key = document.createElement('span'); key.className = 'midi-key';
      key.textContent = learning === b.id ? (b.kind === 'note' ? 'hit a pad…' : 'turn a knob…') : keyLabel(b.key);
      const learn = document.createElement('button');
      learn.type = 'button'; learn.className = 'icon-btn'; learn.textContent = learning === b.id ? 'cancel' : 'learn';
      learn.title = b.kind === 'note' ? 'click, then hit the pad/key to use for this' : 'click, then turn the knob to use for this';
      learn.onclick = () => { learning = learning === b.id ? null : b.id; if (learning && !access) connect(); render(); };
      row.append(lbl, what, key, learn);
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
