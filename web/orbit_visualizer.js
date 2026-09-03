'use strict';
// Ported from the standalone orbit_visualizer.html this used to be --
// it's no longer a separate document loaded into an <iframe> (see
// index.html's #orbit-egg-dialog, now inline markup instead of an
// iframe wrapper). The iframe boundary was the whole reason the old
// version talked to vue-app.js over postMessage at all: Web Audio nodes
// and an HTMLVideoElement can't cross a frame boundary, only plain
// structured-clonable data can (see the old feed's own comments). Now
// that this runs in the same document/realm as vue-app.js, that's just
// unnecessary indirection -- pushAudio/pushVideoFrame below are called
// directly, no postMessage, no serialization.
//
// Wrapped in this IIFE (not a `type="module"` script) so its own
// top-level `const`/`let` declarations can't collide with vue-app.js's
// -- classic <script> tags sharing one page share ONE top-level lexical
// scope, unlike modules, and this file used to be free to name things
// however it liked since it had that whole scope to itself.
//
// index.html's v-if destroys and recreates the dialog's DOM every time
// the visualizer opens/closes (same as a fresh iframe navigation used
// to give it for free) -- init()/teardown() below replicate that reset
// explicitly: init() re-queries every DOM element and re-attaches every
// listener from scratch, and teardown() removes anything that would
// otherwise survive the DOM being torn down (document-level listeners,
// the ResizeObserver, the requestAnimationFrame draw loop) so repeated
// open/close cycles don't stack zombie copies of any of that.
window.orbitViz = (function () {
  // Named character ramps for ASCII mode, ordered sparse→dense so darker
  // areas of the frame map to early characters and bright areas to late ones.
  // Non-Latin scripts aren't perfectly luminance-ordered by font metrics, but
  // the visual variety is the point -- they read unmistakably as that script.
  const ASCII_RAMPS = {
    classic:  ' .:-=+*#%@',
    blocks:   ' ░▒▓█',
    french:   ' .,·;:!éèêàâùûçœæ§',
    japanese: ' ゛ーカキクケコサシスセソアイウエオ電波光影闇',
    korean:   ' ㆍㄱㄴㄷㄹㅂㅅ가나다라바사아차',
    chinese:  ' 一丨乙亠人入八刀力口土女大小山川木火水日月目石禾竹糸羊虫行衣',
    symbols:  ' ·◦○◎●◆★✦⊕',
  };

  const STEP_HUES = [0.33, 0.50, 0.62, 0.83, 0.10, 0.23];
  const VIZ_MODES = ['tunnel', 'bars', 'mirror', 'scope', 'spiral', 'pixels', 'ascii', 'plasma', 'kaleido', 'particles', 'freefall'];
  // freefall is the 11th mode -- one past what Shift+1-9,0 alone can
  // reach (see the keydown handler below), so it's click/arrow-cycle
  // only. Not worth inventing a second modifier combo just for one
  // mode when both of those already work fine.
  // small, fixed-resolution grid for PLASMA's per-cell math -- computing
  // a real plasma formula at full canvas resolution (VW*VH, easily a few
  // million pixels once devicePixelRatio is in play) every frame would
  // be far too slow; a small grid drawn with image smoothing on when
  // it's scaled up (see the plasma branch below) is what actually gives
  // it a soft, flowing look anyway, not the sharp detail a full-res
  // computation would buy.
  const PLASMA_W = 64, PLASMA_H = 36;

  // ── Plugin registry ────────────────────────────────────────────────
  // Lets code outside this file add its own visualization modes without
  // editing it at all. A plugin is a plain object:
  //   { id, label?, draw(ctx), init(ctx)?, teardown()? }
  // - id: a unique string, not one of the built-in VIZ_MODES above and
  //   not another registered plugin's id -- this becomes the data-viz
  //   value its button carries and what setVizMode/keyboard cycling
  //   compare against, same as a built-in mode's own name.
  // - label: button text (defaults to id).
  // - draw(ctx): called once per animation frame while this is the
  //   active mode. ctx is built fresh every frame by makeFrameContext()
  //   inside init() below -- see its own comment for exactly what it
  //   carries (canvas context, dimensions, audio data, the shared hue/
  //   rotation/zoom state the Speed/Reactivity/Zoom sliders already
  //   drive, ...).
  // - init(ctx)?: called once, right when the visualizer dialog opens
  //   (not lazily on first draw, unlike how several built-in modes set
  //   up their own persistent state) -- ctx here additionally carries
  //   `container` (the dialog's own #vizSection) and `canvas` (the real
  //   <canvas id="vizCanvas">). There's no declarative way to add extra
  //   controls (sliders, buttons, ...) -- this is the escape hatch: a
  //   plugin that wants its own UI creates real DOM elements here and
  //   removes them in teardown().
  // - teardown()?: called once when the dialog closes, or the plugin is
  //   unregistered while it's open -- undo whatever init() set up.
  //
  // Every call into a plugin's own draw/init/teardown is wrapped in
  // try/catch (see callPlugin inside init() below): third-party code is
  // far more likely to have bugs than this file's own already-debugged
  // built-ins, and an uncaught throw inside drawViz's
  // requestAnimationFrame loop fails *silently* -- no crash, no console
  // output by default, the loop just quietly stops running forever
  // (exactly the class of bug ASCII's own background-draw regression
  // test elsewhere in this codebase exists to catch in this file's own
  // code). A broken plugin should only ever break itself -- logged once,
  // switched back to a built-in mode -- not take the whole visualizer
  // down with it.
  const pluginModes = new Map();

  function registerMode(def) {
    if (!def || typeof def.id !== 'string' || !def.id || typeof def.draw !== 'function') {
      throw new Error('orbitViz.registerMode(def) requires at least {id: string, draw: function}');
    }
    if (VIZ_MODES.includes(def.id) || pluginModes.has(def.id)) {
      throw new Error(`orbitViz.registerMode: a mode called ${JSON.stringify(def.id)} already exists`);
    }
    const mode = {
      id: def.id,
      label: def.label || def.id,
      draw: def.draw,
      init: typeof def.init === 'function' ? def.init : null,
      teardown: typeof def.teardown === 'function' ? def.teardown : null,
      broken: false,
    };
    pluginModes.set(mode.id, mode);
    // the dialog is already open (state exists) -- mount it live
    // instead of making the caller reopen the visualizer to see it
    if (state) state.mountPlugin(mode);
    return () => unregisterMode(mode.id);
  }

  function unregisterMode(id) {
    const mode = pluginModes.get(id);
    if (!mode) return false;
    if (state) state.unmountPlugin(mode);
    pluginModes.delete(id);
    return true;
  }

  function listModes() {
    return [
      ...VIZ_MODES.map(id => ({ id, label: id, builtin: true })),
      ...Array.from(pluginModes.values()).map(m => ({ id: m.id, label: m.label, builtin: false })),
    ];
  }

  let state = null;
  // true while something else (vue-app.js's stream code, while the tab
  // is hidden and rAF is frozen) is calling step() to drive frames, so
  // drawViz must not also schedule itself. Module-level rather than on
  // `s` so it survives a teardown/init cycle and a fresh init starts in
  // the right mode.
  let externalClock = false;

  function init() {
    // defensive, not expected in normal use -- vue-app.js's
    // easterEggVisible watch always teardown()s before the next init()
    // could ever run, but a stray double-call shouldn't stack listeners
    if (state) teardown();

    const vizCanvas = document.getElementById('vizCanvas');
    const vctx = vizCanvas.getContext('2d');
    const vizOff = document.createElement('canvas');
    const voffCtx = vizOff.getContext('2d');
    const vpixOff = document.createElement('canvas');
    const vpixOffCtx = vpixOff.getContext('2d');
    const plasmaOff = document.createElement('canvas');
    plasmaOff.width = PLASMA_W; plasmaOff.height = PLASMA_H;
    const plasmaOffCtx = plasmaOff.getContext('2d');
    const idleNote = document.getElementById('idleNote');
    const asciiControls = document.getElementById('asciiControls');
    const asciiResSlider = document.getElementById('asciiResSlider');
    const asciiResVal = document.getElementById('asciiResVal');
    const asciiBriSlider = document.getElementById('asciiBriSlider');
    const asciiBriVal = document.getElementById('asciiBriVal');
    const asciiBgSlider = document.getElementById('asciiBgSlider');
    const asciiBgVal = document.getElementById('asciiBgVal');
    const asciiRampSelect = document.getElementById('asciiRampSelect');
    const speedSlider = document.getElementById('speedSlider');
    const speedVal = document.getElementById('speedVal');
    const reactivitySlider = document.getElementById('reactivitySlider');
    const reactivityVal = document.getElementById('reactivityVal');
    const zoomSlider = document.getElementById('zoomSlider');
    const zoomVal = document.getElementById('zoomVal');
    const freefallControls = document.getElementById('freefallControls');
    const buildingWidthSlider = document.getElementById('buildingWidthSlider');
    const buildingWidthVal = document.getElementById('buildingWidthVal');
    const buildingHeightSlider = document.getElementById('buildingHeightSlider');
    const buildingHeightVal = document.getElementById('buildingHeightVal');
    const buildingCountSlider = document.getElementById('buildingCountSlider');
    const buildingCountVal = document.getElementById('buildingCountVal');
    const vizModesEl = document.getElementById('vizModes');
    const vizModeSelect = document.getElementById('vizModeSelect');
    const vizSection = document.getElementById('vizSection');
    const vizFsBtn = document.getElementById('vizFsBtn');
    const transitionSelect = document.getElementById('transitionSelect');
    const transitionSlider = document.getElementById('transitionSlider');
    const transitionVal = document.getElementById('transitionVal');

    // Every value that changes over the life of one open/close cycle
    // lives on this one object -- drawViz and every handler below close
    // over it via `s`, so there's a single source of truth per init()
    // instead of a mix of closures each holding their own copy.
    const s = {
      running: true,
      c60Hue: STEP_HUES[0],
      freqData: new Uint8Array(1024),
      waveData: new Uint8Array(2048),
      hasSignal: false,
      // true while the dialog is hidden but kept alive for the network
      // stream (vue-app.js's easterEggVisible watch): drawing continues,
      // the document-level keyboard handler below stands down so the
      // app's own hotkeys don't steer an invisible visualizer
      backgrounded: false,
      rafPending: false,   // a drawViz rAF is already queued -- see scheduleDraw
      videoFrame: null,
      VW: 0, VH: 0,
      vizPanX: 0, vizPanY: 0, vizUserScale: 1.0, vizRot: 0,
      // PIXELS mode's own rotation/pulse state -- separate from vizRot
      // above (shared by tunnel/scope/spiral at a fixed rate) since this
      // ring's whole point is spinning *faster when the audio is more
      // energetic*, not the same constant rate every other mode uses.
      pixelsRingRot: 0, pixelsPulse: 0,
      vizMode: 'ascii',
      // true = effects off; the canvas shows the plain video instead
      // (drawPlainVideo). Toggled by clicking the lit mode button again.
      // vizMode itself is kept, so the next click brings that mode back.
      vizOff: false,
      // ASCII's own controls -- resolution (STRIDE, coarser = fewer/
      // bigger characters) and color mode (the video's real per-cell
      // color vs. the rotating neon palette added for "often quite
      // dark" real footage). Defaults match the initial-active states
      // set on the buttons/slider in index.html -- full resolution
      // (stride 1), natural color.
      asciiStride: 1,
      asciiRampKey: 'classic',
      asciiColorMode: 'natural',
      // Multiplies the per-pixel luminance ASCII uses for both glyph
      // density (which RAMP character gets picked) and color intensity
      // (alpha in NATURAL, lightness/alpha in NEON) -- the direct
      // answer to "often quite dark". >1 also lets genuinely dark source
      // footage clear the bright<0.03 skip threshold and actually
      // render instead of leaving blank cells.
      asciiBrightness: 1.8,
      asciiBgAlpha: 0.25,
      // PLASMA's own clock -- an accumulator like vizRot, not read
      // straight off performance.now() (see its branch in drawViz for
      // why that matters once the Speed slider is multiplying it: a
      // multiplier applied to raw wall-clock time jumps the pattern the
      // instant the slider moves, since it rescales the *entire*
      // elapsed time, not just the rate going forward -- an accumulator
      // only ever changes its own future rate).
      plasmaT: 0,
      // PARTICLES' own swarm, FREEFALL's own building ring -- null until
      // that mode's first frame lazily populates it (see their branches
      // in drawViz), same "declared here, filled in on demand" shape
      // videoFrame above already uses.
      particles: null,
      buildings: null,
      // FREEFALL's own dimension sliders (labeled Size/Bloom/Count in
      // index.html -- these names still say "building" from when this
      // mode drew buildings instead of recursive flowers). 1.0 means no
      // change from the un-tuned default, applied at draw time rather
      // than baked into each flower's own stored halfW/heightScale, so
      // moving a slider retunes every flower on screen immediately
      // instead of only newly-spawned ones. buildingWidthScale scales
      // each flower's overall radius (baseSize); buildingHeightScale
      // controls how tightly each recursive level shrinks relative to
      // its parent (bloomFactor -- see drawFlowerPetals' own call site).
      // buildingCount is the one exception to "draw-time multiplier" --
      // it directly resizes s.buildings (see its own maintenance check
      // in the freefall branch), since "how many" isn't a per-flower
      // scale the way size/bloom are.
      buildingWidthScale: 1.0,
      buildingHeightScale: 1.0,
      buildingCount: 40,
      // Global tuning knobs (the Speed/Reactivity/Zoom sliders) -- 1.0
      // is a pure pass-through matching this file's original,
      // unmodified behavior, so leaving every slider untouched looks
      // exactly like it always did. Speed multiplies every mode's own
      // per-frame animation increment (vizRot, plasma's t, etc. -- see
      // each branch); Reactivity scales freqData/waveData themselves
      // right where pushAudio receives them, so every mode's own v/
      // energy/bass math gets amplified or damped without each branch
      // needing its own copy of that multiply; Zoom is just another way
      // to set vizUserScale, the same value scroll-to-zoom already
      // controls.
      speed: 1.0,
      reactivity: 1.0,
      // how the last frame of the previous mode/track gives way to the
      // next one (see snapshotForTransition/drawTransition), and over
      // how long. `trans` is the in-flight one, or null.
      transition: 'burn',
      transitionMs: 1200,
      trans: null,
      panning: false, lastX: 0, lastY: 0,
      listeners: [],
      // plugin mode id -> its dynamically-created <button>, so
      // unmountPlugin (below) can find and remove exactly the one it
      // added -- plugin buttons don't exist in index.html at all, only
      // the 11 built-in ones do
      pluginButtons: new Map(),
    };
    state = s;

    // tracked so teardown() can remove exactly what init() added --
    // matters most for document/window listeners, which outlive this
    // dialog's own DOM and would otherwise pile up across every
    // open/close cycle
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      s.listeners.push([target, type, fn, opts]);
    }

    // ── plugin wiring -- see the registerMode/pluginModes comment at
    // the top of this file for the full contract these implement ──────
    function callPlugin(mode, hookName, ctx) {
      const fn = mode[hookName];
      if (!fn) return;
      try {
        fn(ctx);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[orbit visualizer] plugin "${mode.id}" threw in ${hookName}():`, err);
        mode.broken = true;
        if (s.vizMode === mode.id) setVizMode('tunnel');
      }
    }
    // Rebuilt fresh every frame (cheap -- a handful of property reads,
    // not a deep clone) rather than handing a plugin the real internal
    // `s` object directly: this is the one deliberately-stable, narrow
    // surface plugins can rely on even as this file's own internals
    // keep changing around it (new fields have been added to `s` in
    // nearly every recent change to this file -- a plugin depending on
    // its exact shape would break constantly).
    function makeFrameContext() {
      return {
        vctx, VW: s.VW, VH: s.VH,
        cx: s.VW / 2 + s.vizPanX, cy: s.VH / 2 + s.vizPanY,
        hueBase: s.c60Hue * 360, vizRot: s.vizRot, vizUserScale: s.vizUserScale,
        freqData: s.freqData, waveData: s.waveData, videoFrame: s.videoFrame,
        speed: s.speed, reactivity: s.reactivity,
      };
    }
    function mountPlugin(mode) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viz-mode-btn';
      btn.dataset.viz = mode.id;
      btn.textContent = mode.label;
      vizModesEl.appendChild(btn);
      s.pluginButtons.set(mode.id, btn);
      callPlugin(mode, 'init', { container: vizSection, canvas: vizCanvas, vctx });
    }
    function unmountPlugin(mode) {
      callPlugin(mode, 'teardown', undefined);
      const btn = s.pluginButtons.get(mode.id);
      if (btn) { btn.remove(); s.pluginButtons.delete(mode.id); }
      if (s.vizMode === mode.id) setVizMode('tunnel');
    }
    s.mountPlugin = mountPlugin;
    s.unmountPlugin = unmountPlugin;
    s.callPlugin = callPlugin;
    // any plugin registered from an earlier dialog session (or before
    // the visualizer was ever opened at all) needs its button re-created
    // now -- index.html's v-if destroyed the previous dialog's whole DOM
    // on close, plugin buttons included, but pluginModes itself is
    // module-level state that outlives any single open/close cycle
    for (const mode of pluginModes.values()) mountPlugin(mode);

    // shared by the Zoom slider's own 'input' event, scroll-to-zoom, and
    // the double-click reset below, so all three ways of changing it
    // move the slider thumb and clamp identically instead of scroll and
    // the slider quietly drifting out of sync with each other.
    //
    // #zoomSlider's own step is "any" (index.html), not a fixed
    // increment like the ASCII sliders use -- a real bug this avoided:
    // Chromium silently snaps a range input's .value to the nearest
    // step *whenever it's set programmatically*, not just via user drag,
    // so a wheel-zoomed value like 1.07 assigned to a step="0.05" slider
    // silently became 1.05 the instant it was read back, while this
    // function's own label (zoomVal, built from the true s.vizUserScale)
    // kept saying 1.07x -- the slider thumb and its own label
    // disagreeing about the current zoom. Zoom changes continuously via
    // scroll, unlike Speed/Reactivity (drag-only), so there's no fixed
    // increment that would ever make sense to snap to here anyway.
    function setZoom(v) {
      s.vizUserScale = Math.min(8.0, Math.max(0.15, v));
      zoomSlider.value = s.vizUserScale;
      zoomVal.textContent = s.vizUserScale.toFixed(2) + 'x';
    }
    on(zoomSlider, 'input', () => setZoom(parseFloat(zoomSlider.value)));
    setZoom(s.vizUserScale);

    function resetVizNav() { s.vizPanX = 0; s.vizPanY = 0; setZoom(1.0); }

    function resizeVizCanvas() {
      s.VW = Math.round(vizCanvas.offsetWidth * devicePixelRatio);
      s.VH = Math.round(vizCanvas.offsetHeight * devicePixelRatio);
      vizCanvas.width = s.VW; vizCanvas.height = s.VH;
      vizOff.width = s.VW; vizOff.height = s.VH;
    }
    resizeVizCanvas();
    const resizeObserver = new ResizeObserver(resizeVizCanvas);
    resizeObserver.observe(vizCanvas);
    s.resizeObserver = resizeObserver;

    // Viz pan/zoom
    on(vizCanvas, 'wheel', e => {
      e.preventDefault();
      setZoom(s.vizUserScale * (e.deltaY > 0 ? 0.93 : 1.07));
    }, { passive: false });
    on(vizCanvas, 'mousedown', e => {
      if (e.button !== 0) return;
      s.panning = true; s.lastX = e.clientX; s.lastY = e.clientY;
      vizCanvas.style.cursor = 'grabbing';
    });
    on(vizCanvas, 'dblclick', () => resetVizNav());
    on(document, 'mousemove', e => {
      if (!s.panning) return;
      s.vizPanX += (e.clientX - s.lastX) * devicePixelRatio;
      s.vizPanY += (e.clientY - s.lastY) * devicePixelRatio;
      s.lastX = e.clientX; s.lastY = e.clientY;
    });
    on(document, 'mouseup', () => { if (!s.panning) return; s.panning = false; vizCanvas.style.cursor = 'grab'; });

    // Viz mode switching -- one shared setter for the three ways a mode
    // change can happen (clicking a button, arrow-key cycling, and the
    // number-key jump below), instead of three copies of the same
    // lit-class/resetVizNav/asciiControls-visibility bookkeeping
    // drifting out of sync with each other.
    function setVizMode(mode) {
      if (!VIZ_MODES.includes(mode) && !pluginModes.has(mode)) return;
      // grab the outgoing picture *before* the switch -- the transition
      // draws it over the new mode until it's gone
      if (mode !== s.vizMode || s.vizOff) snapshotForTransition();
      s.vizMode = mode;
      s.vizOff = false;
      document.querySelectorAll('[data-viz]').forEach(b => b.classList.toggle('active', b.dataset.viz === mode));
      if (vizModeSelect && vizModeSelect.value !== mode) vizModeSelect.value = mode;
      resetVizNav();
      // a class, not inline style.display -- .viz-controls > .preset-row
      // is display:contents on large viewports (see style.css) so these
      // pack together with the mode buttons/global sliders instead of
      // each claiming its own row, and an inline style.display would
      // silently win over that class rule the instant this set it,
      // undoing the packing every time the *active* mode's own controls
      // got shown.
      asciiControls.classList.toggle('mode-controls-hidden', mode !== 'ascii');
      freefallControls.classList.toggle('mode-controls-hidden', mode !== 'freefall');
      // Narrow-viewport spin-wheel mode (see style.css's own max-width:
      // 460px rules for #vizModes) turns this row into a horizontally
      // scroll-snapping strip -- native CSS scroll-snap only reacts to
      // an actual swipe/scroll gesture on its own, so a mode picked any
      // other way (clicking a button that's already scrolled into view,
      // Shift+digit, arrow-key cycling) wouldn't otherwise re-center the
      // wheel on it. scrollIntoView here is a harmless no-op at desktop
      // width, where #vizModes isn't scrollable at all.
      const activeBtn = vizModesEl.querySelector(`[data-viz="${CSS.escape(mode)}"]`);
      if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
    // Effects off: the canvas shows the plain video instead (see
    // drawPlainVideo). No mode button stays lit and the mode-specific
    // control rows hide, but s.vizMode is kept -- clicking any mode, the
    // select, arrow cycling or Shift+digit all go through setVizMode,
    // which switches the effects straight back on.
    function setVizOff() {
      snapshotForTransition();
      s.vizOff = true;
      document.querySelectorAll('[data-viz]').forEach(b => b.classList.remove('active'));
      if (vizModeSelect) vizModeSelect.value = '__video';
      asciiControls.classList.add('mode-controls-hidden');
      freefallControls.classList.add('mode-controls-hidden');
    }
    on(vizModesEl, 'click', function (e) {
      const btn = e.target.closest('[data-viz]'); if (!btn) return;
      // the mode that's already lit: clicking it again turns the effects off
      if (btn.dataset.viz === s.vizMode && !s.vizOff) setVizOff();
      else setVizMode(btn.dataset.viz);
    });
    if (vizModeSelect) on(vizModeSelect, 'change', () => {
      if (vizModeSelect.value === '__video') setVizOff();
      else setVizMode(vizModeSelect.value);
    });

    // ASCII resolution slider -- STRIDE 1-4, i.e. every source pixel
    // down to every 4th one, labeled with the actual resulting
    // character count (a bare "1-4" scale means nothing on its own; the
    // real number people actually asked for is "how many characters is
    // that")
    function updateAsciiResLabel() {
      if (!s.videoFrame) { asciiResVal.textContent = '—'; return; }
      const cols = Math.floor(s.videoFrame.w / s.asciiStride);
      const rows = Math.floor(s.videoFrame.h / s.asciiStride);
      asciiResVal.textContent = (cols * rows).toLocaleString() + ' chars';
    }
    // shared by the slider's own 'input' event and the [ / ] keyboard
    // bindings below, so both ways of changing it move the slider
    // thumb, clamp the same way, and refresh the label identically
    function setAsciiRes(stride) {
      s.asciiStride = Math.min(4, Math.max(1, stride));
      asciiResSlider.value = s.asciiStride;
      updateAsciiResLabel();
    }
    on(asciiResSlider, 'input', () => setAsciiRes(parseInt(asciiResSlider.value, 10)));
    // ASCII is the default active mode, visible from the very first
    // paint -- without this, the label would sit on its static HTML
    // placeholder until either a video frame arrived or the slider
    // moved, instead of correctly reading "—" (no video yet)
    updateAsciiResLabel();

    // ASCII brightness slider -- see asciiBrightness's own comment
    // above for what it actually multiplies. Same sharing reasoning as
    // setAsciiRes: the ↑/↓ keyboard bindings reuse this rather than
    // duplicating the clamp+label logic.
    function setAsciiBrightness(value) {
      s.asciiBrightness = Math.min(3, Math.max(0.3, Math.round(value * 10) / 10));
      asciiBriSlider.value = s.asciiBrightness;
      asciiBriVal.textContent = s.asciiBrightness.toFixed(1) + 'x';
    }
    on(asciiBriSlider, 'input', () => setAsciiBrightness(parseFloat(asciiBriSlider.value)));

    // ASCII background video opacity slider -- controls how strongly the
    // dimmed source frame shows through behind the glyphs (0 = pure black,
    // 1 = fully opaque; default 0.25 matches the old hardcoded value).
    function setAsciiBgAlpha(value) {
      s.asciiBgAlpha = Math.min(1, Math.max(0, Math.round(value * 20) / 20));
      asciiBgSlider.value = s.asciiBgAlpha;
      asciiBgVal.textContent = s.asciiBgAlpha.toFixed(2);
    }
    on(asciiBgSlider, 'input', () => setAsciiBgAlpha(parseFloat(asciiBgSlider.value)));

    // ASCII character set selector
    on(asciiRampSelect, 'change', () => { s.asciiRampKey = asciiRampSelect.value; });

    // ASCII color mode -- NATURAL (the video's own per-cell color) vs
    // NEON (the rotating HSL palette for dim/desaturated real footage).
    document.querySelectorAll('#asciiControls [data-color]').forEach(btn => {
      on(btn, 'click', () => {
        s.asciiColorMode = btn.dataset.color;
        document.querySelectorAll('#asciiControls [data-color]').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Global tuning sliders -- see s.speed/s.reactivity's own comment
    // in the state object above for what each actually does and where.
    // Visible for every mode (unlike ASCII's own RES/BRI row), since
    // both apply everywhere.
    function setSpeed(value) {
      s.speed = Math.min(3, Math.max(0.2, Math.round(value * 10) / 10));
      speedSlider.value = s.speed;
      speedVal.textContent = s.speed.toFixed(1) + 'x';
    }
    on(speedSlider, 'input', () => setSpeed(parseFloat(speedSlider.value)));
    setSpeed(s.speed);

    function setTransition(type) {
      s.transition = type;
      if (transitionSelect && transitionSelect.value !== type) transitionSelect.value = type;
    }
    function setTransitionMs(ms) {
      s.transitionMs = Math.min(5000, Math.max(0, Math.round(ms / 100) * 100));
      if (transitionSlider) transitionSlider.value = s.transitionMs;
      if (transitionVal) transitionVal.textContent = (s.transitionMs / 1000).toFixed(1) + 's';
    }
    if (transitionSelect) on(transitionSelect, 'change', () => setTransition(transitionSelect.value));
    if (transitionSlider) on(transitionSlider, 'input', () => setTransitionMs(parseFloat(transitionSlider.value)));
    setTransitionMs(s.transitionMs);

    function setReactivity(value) {
      s.reactivity = Math.min(3, Math.max(0.2, Math.round(value * 10) / 10));
      reactivitySlider.value = s.reactivity;
      reactivityVal.textContent = s.reactivity.toFixed(1) + 'x';
    }
    on(reactivitySlider, 'input', () => setReactivity(parseFloat(reactivitySlider.value)));
    setReactivity(s.reactivity);

    // FREEFALL's own dimension sliders -- see buildingWidthScale's own
    // comment in the state object for why Width/Height apply at draw
    // time (a live multiplier on every building on screen) while Count
    // actually resizes s.buildings.
    function setBuildingWidth(value) {
      s.buildingWidthScale = Math.min(3, Math.max(0.3, Math.round(value * 10) / 10));
      buildingWidthSlider.value = s.buildingWidthScale;
      buildingWidthVal.textContent = s.buildingWidthScale.toFixed(1) + 'x';
    }
    on(buildingWidthSlider, 'input', () => setBuildingWidth(parseFloat(buildingWidthSlider.value)));
    setBuildingWidth(s.buildingWidthScale);

    function setBuildingHeight(value) {
      s.buildingHeightScale = Math.min(3, Math.max(0.3, Math.round(value * 10) / 10));
      buildingHeightSlider.value = s.buildingHeightScale;
      buildingHeightVal.textContent = s.buildingHeightScale.toFixed(1) + 'x';
    }
    on(buildingHeightSlider, 'input', () => setBuildingHeight(parseFloat(buildingHeightSlider.value)));
    setBuildingHeight(s.buildingHeightScale);

    function setBuildingCount(value) {
      s.buildingCount = Math.min(120, Math.max(5, Math.round(value)));
      buildingCountSlider.value = s.buildingCount;
      buildingCountVal.textContent = String(s.buildingCount);
    }
    on(buildingCountSlider, 'input', () => setBuildingCount(parseFloat(buildingCountSlider.value)));
    setBuildingCount(s.buildingCount);

    // Shared fallback for the two video-based modes (pixels/ascii) when
    // no frame has arrived yet -- see videoFrame's own comment on why
    // that can be true even while a video is genuinely loaded and
    // playing.
    function drawNoVideoMessage(hueBase) {
      vctx.fillStyle = `hsla(${hueBase | 0},40%,55%,0.5)`;
      vctx.font = `${Math.max(10, Math.round(s.VH * 0.04))}px 'Courier New',monospace`;
      vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
      vctx.fillText('— no video playing —', s.VW / 2, s.VH / 2);
      vctx.textAlign = 'left'; vctx.textBaseline = 'alphabetic';
    }

    // PIXELS/ASCII both draw the sampled video frame into the VWxVH
    // canvas, which is almost never the same aspect ratio as the frame
    // itself. Scaling frameW/frameH independently to fill VW/VH
    // separately stretches/squashes it -- this mirrors CSS
    // object-fit:contain instead: scale uniformly so the whole frame
    // fits inside VWxVH, letterboxed rather than distorted.
    function fitFrameToCanvas(frameW, frameH) {
      const frameAspect = frameW / frameH, canvasAspect = s.VW / s.VH;
      return frameAspect > canvasAspect
        ? { w: s.VW, h: s.VW / frameAspect }
        : { w: s.VH * frameAspect, h: s.VH };
    }

    // Effects off (s.vizOff): the plain video, object-fit: contain, at
    // the canvas's own resolution -- drawn straight from the player's
    // <video> element, not the tiny sampled videoFrame PIXELS/ASCII
    // use. Going through this canvas (rather than un-hiding the player
    // behind the dialog) is what keeps the network stream, which
    // captures this canvas, showing the same plain video.
    const playerVideo = document.querySelector('#global-player video');
    function drawPlainVideo(hueBase) {
      vctx.fillStyle = '#000'; vctx.fillRect(0, 0, s.VW, s.VH);
      const v = playerVideo;
      if (!v || v.readyState < 2 || !v.videoWidth) { drawNoVideoMessage(hueBase); return; }
      const fit = fitFrameToCanvas(v.videoWidth, v.videoHeight);
      vctx.drawImage(v, (s.VW - fit.w) / 2, (s.VH - fit.h) / 2, fit.w, fit.h);
    }

    // FREEFALL's recursive flower -- a ring of petals radiating from
    // (x,y), each petal's own tip blooming a smaller ring of petals in
    // turn, depth-limited so the recursion actually terminates. Defined
    // once here (not per-flower-per-frame) and given everything it
    // needs as plain parameters rather than closures, since it's called
    // up to buildingCount times every single frame.
    //
    // depth is deliberately tied to the flower's own on-screen size at
    // the call site (see the freefall branch below), not a fixed
    // constant: a flower still tiny near the vanishing point can't show
    // fine recursive detail anyway, and the *real* cost of this
    // function is exponential in depth (petalCount^depth petals) --
    // only the handful of flowers big enough to actually show it ever
    // pay for the deeper recursion.
    function drawFlowerPetals(x, y, angle, size, depth, hue, sat, light, bloomFactor, energy, rotStep) {
      if (depth <= 0 || size < 1.5) return;
      const petalCount = 5;
      const petalWidth = size * 0.34 * (0.7 + energy * 0.6);
      for (let i = 0; i < petalCount; i++) {
        const pa = angle + (i / petalCount) * Math.PI * 2 + rotStep;
        const tipX = x + Math.cos(pa) * size, tipY = y + Math.sin(pa) * size;
        const perp = pa + Math.PI / 2;
        const midX = x + Math.cos(pa) * size * 0.55, midY = y + Math.sin(pa) * size * 0.55;
        vctx.beginPath();
        vctx.moveTo(x, y);
        vctx.quadraticCurveTo(midX + Math.cos(perp) * petalWidth, midY + Math.sin(perp) * petalWidth, tipX, tipY);
        vctx.quadraticCurveTo(midX - Math.cos(perp) * petalWidth, midY - Math.sin(perp) * petalWidth, x, y);
        vctx.closePath();
        vctx.fillStyle = `hsla(${(hue + i * 8) % 360 | 0},${sat | 0}%,${light | 0}%,0.75)`;
        vctx.fill();
        // recurse: a smaller bloom opens at this petal's own tip, hue
        // drifting and rotation twisting a bit more at each level so
        // the levels read as distinct rather than a single flat pattern
        // stamped on top of itself
        drawFlowerPetals(tipX, tipY, pa, size * bloomFactor, depth - 1,
          (hue + 22) % 360, sat, Math.min(85, light + 6), bloomFactor, energy, rotStep * 1.4 + 0.3);
      }
    }

    // ── transitions between modes / tracks ──────────────────────────
    // A transition is "the last frame of whatever was on screen, drawn
    // over the new picture for transitionMs, leaving in some style".
    // snapshotForTransition() grabs that last frame (setVizMode/setVizOff
    // call it just before switching; vue-app.js's openPlayer calls
    // orbitViz.transition() when a new track starts), and drawViz keeps
    // compositing it over every frame drawScene() paints until it's
    // done. Feedback modes (tunnel, kaleido) read the canvas back the
    // next frame, so the outgoing picture smears into their trails --
    // that's a feature.
    const transOld = document.createElement('canvas');
    const transTmp = document.createElement('canvas');
    const transOldCtx = transOld.getContext('2d');
    const transTmpCtx = transTmp.getContext('2d');
    // low-res working canvases for the per-pixel effect (burn): 160x90
    // is ~14k pixels a frame, nothing, and upscaling them with smoothing
    // on is exactly what gives the burn front its soft edge
    const NOISE_W = 160, NOISE_H = 90;
    const transMask = document.createElement('canvas'); transMask.width = NOISE_W; transMask.height = NOISE_H;
    const transGlow = document.createElement('canvas'); transGlow.width = NOISE_W; transGlow.height = NOISE_H;
    const transMaskCtx = transMask.getContext('2d'), transGlowCtx = transGlow.getContext('2d');
    const maskImg = transMaskCtx.createImageData(NOISE_W, NOISE_H);
    const glowImg = transGlowCtx.createImageData(NOISE_W, NOISE_H);
    // blotchy value noise for the burn front: random per pixel, box-
    // blurred a few times so it burns in islands and fingers, not TV
    // static, then stretched back to 0..1 (blurring squeezes the range)
    const noise = (() => {
      let a = new Float32Array(NOISE_W * NOISE_H);
      for (let i = 0; i < a.length; i++) a[i] = Math.random();
      for (let pass = 0; pass < 3; pass++) {
        const b = new Float32Array(a.length);
        for (let y = 0; y < NOISE_H; y++) {
          for (let x = 0; x < NOISE_W; x++) {
            let sum = 0, n = 0;
            for (let dy = -2; dy <= 2; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                const yy = y + dy, xx = x + dx;
                if (yy < 0 || yy >= NOISE_H || xx < 0 || xx >= NOISE_W) continue;
                sum += a[yy * NOISE_W + xx]; n++;
              }
            }
            b[y * NOISE_W + x] = sum / n;
          }
        }
        a = b;
      }
      let lo = 1, hi = 0;
      for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
      for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / (hi - lo || 1);
      return a;
    })();

    function snapshotForTransition() {
      if (s.transition === 'none' || !s.transitionMs || !s.VW || !s.VH) return;
      if (transOld.width !== s.VW || transOld.height !== s.VH) {
        transOld.width = s.VW; transOld.height = s.VH;
        transTmp.width = s.VW; transTmp.height = s.VH;
      }
      transOldCtx.clearRect(0, 0, s.VW, s.VH);
      transOldCtx.drawImage(vizCanvas, 0, 0);
      s.trans = { t0: performance.now(), type: s.transition, seed: Math.random() * 1000 };
    }
    s.snapshotForTransition = snapshotForTransition;
    // for orbitViz.debugState() -- the transition machinery is closure-
    // private, and "why didn't that transition show" is unanswerable
    // from the outside otherwise
    s.transitionDebug = () => ({
      transition: s.transition, transitionMs: s.transitionMs, trans: s.trans,
      VW: s.VW, VH: s.VH, oldW: transOld.width, oldH: transOld.height,
    });

    // Film burn: the old picture is eaten away along a blotchy front (the
    // noise, thresholded by t), with a white-hot-to-orange ember edge and
    // a dim red afterglow just behind it, the new picture showing through
    // wherever it has burned.
    function drawBurn(t) {
      const W = s.VW, H = s.VH;
      const EDGE = 0.14;                         // width of the glowing front, in noise units
      const front = t * (1 + 2 * EDGE) - EDGE;   // sweeps from below 0 to above 1: every pixel burns
      const m = maskImg.data, g = glowImg.data;
      for (let i = 0; i < noise.length; i++) {
        const d = noise[i] - front;              // > EDGE untouched; 0..EDGE burning; < 0 gone
        let keep = 0, glow = 0;
        if (d > EDGE) keep = 255;
        else if (d > 0) { keep = 255 * (d / EDGE); glow = 1 - d / EDGE; }
        else if (d > -EDGE * 0.6) glow = 0.35 * (1 + d / (EDGE * 0.6));
        const o = i * 4;
        m[o] = m[o + 1] = m[o + 2] = 255; m[o + 3] = keep;
        g[o] = 255;
        g[o + 1] = 90 + 165 * glow * glow;
        g[o + 2] = 20 + 200 * glow * glow * glow;
        g[o + 3] = 255 * Math.min(1, glow * 1.4);
      }
      transMaskCtx.putImageData(maskImg, 0, 0);
      transGlowCtx.putImageData(glowImg, 0, 0);
      transTmpCtx.clearRect(0, 0, W, H);
      transTmpCtx.drawImage(transOld, 0, 0);
      transTmpCtx.globalCompositeOperation = 'destination-in';
      transTmpCtx.drawImage(transMask, 0, 0, W, H);
      transTmpCtx.globalCompositeOperation = 'source-over';
      vctx.drawImage(transTmp, 0, 0);
      vctx.globalCompositeOperation = 'lighter';
      vctx.drawImage(transGlow, 0, 0, W, H);
      vctx.globalCompositeOperation = 'source-over';
    }

    function drawTransition() {
      const tr = s.trans;
      const t = (performance.now() - tr.t0) / s.transitionMs;
      if (t >= 1 || transOld.width !== s.VW || transOld.height !== s.VH) {
        s.trans = null;   // done -- or the canvas was resized mid-way; just drop it
        return;
      }
      const W = s.VW, H = s.VH;
      vctx.save();
      switch (tr.type) {
        case 'crossfade':
          vctx.globalAlpha = 1 - t;
          vctx.drawImage(transOld, 0, 0);
          break;
        case 'burn':
          drawBurn(t);
          break;
        case 'pixelate': {
          // the old picture falls apart into ever-bigger blocks while fading
          const size = 1 + 40 * t;
          const w = Math.max(1, Math.round(W / size)), h = Math.max(1, Math.round(H / size));
          transTmpCtx.clearRect(0, 0, W, H);
          transTmpCtx.drawImage(transOld, 0, 0, w, h);
          vctx.imageSmoothingEnabled = false;
          vctx.globalAlpha = Math.pow(1 - t, 0.6);
          vctx.drawImage(transTmp, 0, 0, w, h, 0, 0, W, H);
          break;
        }
        case 'warp': {
          // the old picture flies into the camera, spinning and hue-
          // cycling, with two ghost copies trailing behind it
          for (let g = 2; g >= 0; g--) {
            const tg = Math.max(0, t - g * 0.08);
            vctx.save();
            vctx.globalAlpha = (1 - t) * (g === 0 ? 0.9 : 0.35);
            vctx.translate(W / 2, H / 2);
            vctx.scale(1 + 2.5 * tg, 1 + 2.5 * tg);
            vctx.rotate(tg * 1.3);
            vctx.filter = `hue-rotate(${(tg * 360 + g * 40) | 0}deg) saturate(${(1 + 2 * tg).toFixed(2)})`;
            vctx.drawImage(transOld, -W / 2, -H / 2);
            vctx.restore();
          }
          break;
        }
        case 'glitch': {
          // horizontal bands of the old picture jitter sideways (less as
          // it fades), with two hue-shifted copies pushed opposite ways
          // for a channel-split look; the jitter re-rolls ~30x a second
          const bands = 16, bh = H / bands, amp = W * 0.25 * (1 - t);
          const frame = Math.floor(t * s.transitionMs / 33);
          for (let i = 0; i < bands; i++) {
            const r = Math.sin(tr.seed + i * 12.9898 + frame * 78.233) * 43758.5453;
            const dx = ((r - Math.floor(r)) - 0.5) * amp;
            vctx.globalAlpha = 1 - t;
            vctx.drawImage(transOld, 0, i * bh, W, bh, dx, i * bh, W, bh);
          }
          vctx.globalCompositeOperation = 'lighter';
          vctx.globalAlpha = 0.35 * (1 - t);
          vctx.filter = 'hue-rotate(120deg)';
          vctx.drawImage(transOld, amp * 0.3, 0);
          vctx.filter = 'hue-rotate(240deg)';
          vctx.drawImage(transOld, -amp * 0.3, 0);
          break;
        }
        case 'wipe': {
          // a soft edge sweeps left to right, the old picture only on its right
          const edge = W * 0.12, x = W * t * (1 + 0.12) - edge * 0.5;
          transTmpCtx.clearRect(0, 0, W, H);
          transTmpCtx.drawImage(transOld, 0, 0);
          transTmpCtx.globalCompositeOperation = 'destination-in';
          const grad = transTmpCtx.createLinearGradient(x - edge, 0, x + edge, 0);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(0,0,0,1)');
          transTmpCtx.fillStyle = grad;
          transTmpCtx.fillRect(0, 0, W, H);
          transTmpCtx.globalCompositeOperation = 'source-over';
          vctx.drawImage(transTmp, 0, 0);
          break;
        }
      }
      vctx.restore();
    }

    // Draw loop -- same seven modes, same math, as the standalone page
    // this was ported from, just reading state pushed directly via
    // pushAudio/pushVideoFrame below instead of a postMessage listener.
    // rafPending is what makes switching clocks safe: flipping back to
    // self-scheduling while a frame is already queued (or step() landing
    // during the last self-scheduled frame) can't stack a second loop.
    function scheduleDraw() {
      if (s.rafPending) return;
      s.rafPending = true;
      requestAnimationFrame(drawViz);
    }
    function drawViz() {
      s.rafPending = false;
      if (!s.running) return;
      if (!externalClock) scheduleDraw();
      if (!s.VW || !s.VH) return;
      drawScene();
      if (s.trans) drawTransition();
    }

    function drawScene() {
      // slow independent color drift -- a steady drift gives the same
      // "the whole thing slowly shifts hue" feel without needing a
      // sequencer to derive it from
      s.c60Hue = (performance.now() / 20000) % 1;
      // shared by tunnel/mirror/scope/spiral/kaleido's own rotation --
      // the Speed slider multiplying this one accumulator is what makes
      // it affect all five at once instead of needing its own copy in
      // each branch
      s.vizRot += 0.006 * s.speed;

      const cx = s.VW / 2 + s.vizPanX, cy = s.VH / 2 + s.vizPanY;
      const maxBin = Math.floor(s.freqData.length * 0.70);
      const hueBase = s.c60Hue * 360;

      if (s.vizOff) { drawPlainVideo(hueBase); return; }

      if (s.vizMode === 'tunnel') {
        voffCtx.clearRect(0, 0, s.VW, s.VH);
        voffCtx.drawImage(vizCanvas, 0, 0);
        vctx.fillStyle = `hsla(${hueBase | 0},70%,8%,0.10)`; vctx.fillRect(0, 0, s.VW, s.VH);
        vctx.save(); vctx.globalAlpha = 0.92;
        vctx.translate(cx, cy);
        vctx.scale(1.024 * s.vizUserScale * 0.004 + 1.018, 1.024 * s.vizUserScale * 0.004 + 1.018);
        vctx.rotate(0.006); vctx.translate(-cx, -cy);
        vctx.drawImage(vizOff, 0, 0); vctx.restore();
        const R_INNER = Math.max(4, Math.min(Math.min(s.VW, s.VH) * 0.08 * s.vizUserScale, Math.min(s.VW, s.VH) * 0.35));
        const R_MAX = R_INNER * 3.5;
        vctx.save(); vctx.translate(cx, cy);
        for (let i = 0; i < 128; i++) {
          const t = i / 128, angle = t * Math.PI * 2 - Math.PI / 2 + s.vizRot * 0.15;
          const v = s.freqData[Math.floor(t * maxBin)] / 255; if (v < 0.015) continue;
          const hue = (hueBase + t * 120 + s.vizRot * 8) % 360;
          vctx.beginPath();
          vctx.moveTo(Math.cos(angle) * R_INNER, Math.sin(angle) * R_INNER);
          vctx.lineTo(Math.cos(angle) * (R_INNER + v * R_MAX), Math.sin(angle) * (R_INNER + v * R_MAX));
          vctx.strokeStyle = `hsla(${hue | 0},100%,${62 + v * 30 | 0}%,${(0.75 + v * 0.25).toFixed(2)})`;
          vctx.lineWidth = 1.6; vctx.stroke();
        }
        vctx.beginPath();
        for (let i = 0; i <= s.waveData.length; i++) {
          const t = i / s.waveData.length, angle = t * Math.PI * 2 - Math.PI / 2 + s.vizRot * 0.15;
          const r = R_INNER + (s.waveData[i % s.waveData.length] / 128 - 1) * R_INNER * 0.55;
          i === 0 ? vctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r) : vctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        vctx.strokeStyle = `hsla(${hueBase | 0},55%,80%,0.28)`; vctx.lineWidth = devicePixelRatio; vctx.stroke();
        vctx.restore();

      } else if (s.vizMode === 'bars') {
        vctx.fillStyle = `hsla(${hueBase | 0},65%,6%,0.14)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const bw = s.VW / maxBin;
        for (let i = 0; i < maxBin; i++) {
          const v = s.freqData[i] / 255; if (v < 0.01) continue;
          const x = i * bw, h = v * s.VH * 0.92;
          const hue = (hueBase + i / maxBin * 120) % 360;
          vctx.fillStyle = `hsla(${hue | 0},88%,${45 + v * 32 | 0}%,${(0.55 + v * 0.4).toFixed(2)})`;
          vctx.fillRect(x, s.VH - h, Math.max(1, bw - 0.5), h);
        }

      } else if (s.vizMode === 'mirror') {
        vctx.fillStyle = `hsla(${(hueBase + 180) | 0},65%,6%,0.12)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const bw = s.VW / maxBin, half = s.VH / 2;
        for (let i = 0; i < maxBin; i++) {
          const v = s.freqData[i] / 255; if (v < 0.01) continue;
          const x = i * bw, h = v * half * 0.95;
          const hue = (hueBase + i / maxBin * 180 + s.vizRot * 20) % 360;
          vctx.fillStyle = `hsla(${hue | 0},90%,${48 + v * 30 | 0}%,${(0.5 + v * 0.45).toFixed(2)})`;
          vctx.fillRect(x, half - h, Math.max(1, bw - 0.5), h * 2);
        }
        vctx.beginPath();
        for (let i = 0; i < s.waveData.length; i++) {
          const x = i / s.waveData.length * s.VW;
          const y = half + (s.waveData[i] / 128 - 1) * half * 0.38;
          i === 0 ? vctx.moveTo(x, y) : vctx.lineTo(x, y);
        }
        vctx.strokeStyle = `hsla(${hueBase | 0},55%,80%,0.35)`; vctx.lineWidth = devicePixelRatio; vctx.stroke();

      } else if (s.vizMode === 'scope') {
        voffCtx.clearRect(0, 0, s.VW, s.VH);
        voffCtx.drawImage(vizCanvas, 0, 0);
        vctx.fillStyle = `hsla(${hueBase | 0},70%,6%,0.10)`; vctx.fillRect(0, 0, s.VW, s.VH);
        vctx.save(); vctx.globalAlpha = 0.90;
        vctx.translate(cx, cy); vctx.scale(1.018, 1.018); vctx.translate(-cx, -cy);
        vctx.drawImage(vizOff, 0, 0); vctx.restore();
        const R = Math.min(s.VW, s.VH) * 0.42 * s.vizUserScale;
        vctx.save(); vctx.translate(cx, cy);
        vctx.beginPath();
        const shift = Math.floor(s.waveData.length / 4);
        for (let i = 0; i < s.waveData.length; i++) {
          const x = (s.waveData[i] / 128 - 1) * R;
          const y = (s.waveData[(i + shift) % s.waveData.length] / 128 - 1) * R;
          i === 0 ? vctx.moveTo(x, y) : vctx.lineTo(x, y);
        }
        vctx.strokeStyle = `hsla(${hueBase | 0},80%,65%,0.70)`; vctx.lineWidth = 1.2; vctx.stroke();
        vctx.restore();

      } else if (s.vizMode === 'spiral') {
        vctx.fillStyle = `hsla(${(hueBase + 60) | 0},70%,7%,0.11)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
        const energy = s.freqData.slice(0, Math.floor(s.freqData.length * 0.55))
                                  .reduce((a, b) => a + b, 0) / (s.freqData.length * 0.55 * 255);
        const breathe = 0.45 + energy * 1.10;
        const rMax = Math.min(s.VW, s.VH) * 0.48 * s.vizUserScale * breathe;
        vctx.save(); vctx.translate(cx, cy);
        for (let i = 0; i < maxBin; i++) {
          const t = i / maxBin;
          const r = Math.sqrt(t) * rMax;
          const angle = i * GOLDEN_ANGLE + s.vizRot;
          const v = s.freqData[i] / 255;
          if (v < 0.01) continue;
          const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
          const size = Math.max(0.8, v * 6 * s.vizUserScale);
          const hue = (hueBase + t * 200 + s.vizRot * 40) % 360;
          vctx.beginPath();
          vctx.arc(x, y, size, 0, Math.PI * 2);
          vctx.fillStyle = `hsla(${hue | 0},90%,${48 + v * 30 | 0}%,${(0.35 + v * 0.60).toFixed(2)})`;
          vctx.fill();
        }
        vctx.restore();

      } else if (s.vizMode === 'pixels') {
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, s.VW, s.VH);
        if (!s.videoFrame) {
          drawNoVideoMessage(hueBase);
        } else {
          // One shared "how energetic is this instant" number driving
          // both the mosaic's own pulse and the ring around it. Bass
          // specifically (~first 12% of bins), not the whole spectrum --
          // full-spectrum energy rarely drops near zero, which smooths
          // this into a slow wobble instead of a real beat-following
          // punch; bass is the part that actually drops out between
          // hits.
          const energy = s.freqData.slice(0, maxBin).reduce((a, b) => a + b, 0) / (maxBin * 255);
          const bassEnd = Math.max(1, Math.floor(maxBin * 0.12));
          const bass = s.freqData.slice(0, bassEnd).reduce((a, b) => a + b, 0) / (bassEnd * 255);
          s.pixelsPulse += (bass - s.pixelsPulse) * 0.25;
          s.pixelsRingRot += (0.004 + energy * 0.05) * s.speed;

          vpixOffCtx.putImageData(s.videoFrame.imageData, 0, 0);
          vctx.imageSmoothingEnabled = false;
          const pulseScale = 1 + s.pixelsPulse * 0.12;
          const fit = fitFrameToCanvas(s.videoFrame.w, s.videoFrame.h);
          const dw = fit.w * s.vizUserScale * pulseScale, dh = fit.h * s.vizUserScale * pulseScale;
          vctx.drawImage(vpixOff, 0, 0, s.videoFrame.w, s.videoFrame.h, cx - dw / 2, cy - dh / 2, dw, dh);
          vctx.imageSmoothingEnabled = true;
          if (s.pixelsPulse > 0.35) {
            vctx.save();
            vctx.globalCompositeOperation = 'overlay';
            vctx.fillStyle = `hsla(${hueBase | 0},90%,60%,${Math.min(0.35, (s.pixelsPulse - 0.35) * 0.6).toFixed(2)})`;
            vctx.fillRect(cx - dw / 2, cy - dh / 2, dw, dh);
            vctx.restore();
          }

          const R = Math.min(s.VW, s.VH) * (0.40 + energy * 0.12) * s.vizUserScale;
          for (let i = 0; i < 48; i++) {
            const t = i / 48;
            const v = s.freqData[Math.floor(t * maxBin)] / 255;
            if (v < 0.08) continue;
            const angle = t * Math.PI * 2 + s.pixelsRingRot;
            const x = cx + Math.cos(angle) * R, y = cy + Math.sin(angle) * R;
            const hue = (hueBase + t * 200) % 360;
            vctx.beginPath();
            vctx.arc(x, y, 2 + v * 10, 0, Math.PI * 2);
            vctx.fillStyle = `hsla(${hue | 0},95%,65%,${(0.25 + v * 0.65).toFixed(2)})`;
            vctx.fill();
          }
        }

      } else if (s.vizMode === 'ascii') {
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, s.VW, s.VH);
        if (!s.videoFrame) {
          drawNoVideoMessage(hueBase);
        } else {
          const RAMP = ASCII_RAMPS[s.asciiRampKey] || ASCII_RAMPS.classic;
          const STRIDE = s.asciiStride;
          const cols = Math.floor(s.videoFrame.w / STRIDE);
          const rows = Math.floor(s.videoFrame.h / STRIDE);
          const fit = fitFrameToCanvas(s.videoFrame.w, s.videoFrame.h);
          const cellW = (fit.w * s.vizUserScale) / cols;
          const cellH = (fit.h * s.vizUserScale) / rows;
          const ox = cx - (fit.w * s.vizUserScale) / 2;
          const oy = cy - (fit.h * s.vizUserScale) / 2;
          const px = s.videoFrame.imageData.data;
          // Real report: a flat black fill behind sparse ASCII glyphs
          // reads as much darker overall than the source video actually
          // is -- most of a character cell is empty space around the
          // glyph's own strokes (more so for sparse RAMP characters like
          // '.'/':'/'-'), so black dominates the visual weight between
          // them regardless of how bright the underlying footage is.
          // Drawing the actual sampled frame here first, dimmed, means
          // that negative space still carries the scene's own color and
          // brightness -- this reads as "this video, in ASCII" instead
          // of "sparse dots over a black void." Dim enough (25%) that
          // the glyphs drawn on top (still at their own full brightness/
          // alpha below) stay the dominant, legible signal.
          vpixOffCtx.putImageData(s.videoFrame.imageData, 0, 0);
          const bgW = fit.w * s.vizUserScale, bgH = fit.h * s.vizUserScale;
          vctx.save();
          vctx.globalAlpha = s.asciiBgAlpha;
          vctx.drawImage(vpixOff, 0, 0, s.videoFrame.w, s.videoFrame.h, ox, oy, bgW, bgH);
          vctx.restore();
          vctx.font = `${Math.max(4, cellH * 1.15).toFixed(1)}px 'Courier New',monospace`;
          vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              const i = ((y * STRIDE) * s.videoFrame.w + (x * STRIDE)) * 4;
              const r = px[i], g = px[i + 1], b = px[i + 2];
              const bright = Math.min(1, (r * 0.299 + g * 0.587 + b * 0.114) / 255 * s.asciiBrightness);
              if (bright < 0.03) continue;
              const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(bright * RAMP.length))];
              const v = s.freqData[Math.floor((x / cols) * maxBin)] / 255;
              if (s.asciiColorMode === 'neon') {
                const hue = (hueBase + (x / cols) * 260 + (y / rows) * 60 + s.vizRot * 30) % 360;
                const light = Math.min(85, 40 + bright * 25 + v * 35);
                const alpha = Math.min(1, 0.55 + bright * 0.25 + v * 0.35);
                vctx.fillStyle = `hsla(${hue | 0},90%,${light | 0}%,${alpha.toFixed(2)})`;
              } else {
                const alpha = Math.min(1, 0.55 + bright * 0.3 + v * 0.25);
                const rb = Math.min(255, r * s.asciiBrightness), gb = Math.min(255, g * s.asciiBrightness), bb = Math.min(255, b * s.asciiBrightness);
                vctx.fillStyle = `rgba(${rb | 0},${gb | 0},${bb | 0},${alpha.toFixed(2)})`;
              }
              vctx.fillText(ch, ox + x * cellW + cellW / 2, oy + y * cellH + cellH / 2);
            }
          }
          vctx.textAlign = 'left'; vctx.textBaseline = 'alphabetic';
        }

      } else if (s.vizMode === 'plasma') {
        // Classic demoscene plasma: four overlapping sine fields (two
        // axis-aligned, one diagonal, one radial from center) summed and
        // normalized to -1..1 -- the interference between them is what
        // gives it that flowing, organic warp instead of looking like
        // plain repeating stripes. Computed on the small PLASMA_W x
        // PLASMA_H grid (see its own comment up top) and smoothed up to
        // full size below.
        const energy = s.freqData.slice(0, maxBin).reduce((a, b) => a + b, 0) / (maxBin * 255);
        const bassEnd = Math.max(1, Math.floor(maxBin * 0.12));
        const bass = s.freqData.slice(0, bassEnd).reduce((a, b) => a + b, 0) / (bassEnd * 255);
        // ~1/60s per frame, same assumption requestAnimationFrame's own
        // ~60fps cadence already makes elsewhere in this file (vizRot's
        // own 0.006-per-frame constant included) -- see plasmaT's own
        // comment in the state object for why this has to be an
        // accumulator, not performance.now() scaled directly.
        s.plasmaT += (1 / 60) * (1 + energy * 1.2) * s.speed;
        const t = s.plasmaT;
        for (let gy = 0; gy < PLASMA_H; gy++) {
          for (let gx = 0; gx < PLASMA_W; gx++) {
            const v = (
              Math.sin(gx * 0.25 + t * 1.3) +
              Math.sin(gy * 0.22 + t * 1.1) +
              Math.sin((gx + gy) * 0.16 + t * 0.9) +
              Math.sin(Math.hypot(gx - PLASMA_W / 2, gy - PLASMA_H / 2) * 0.30 - t * 1.6)
            ) / 4;
            const hue = (hueBase + v * 160 + bass * 90) % 360;
            const light = Math.min(78, 28 + (v * 0.5 + 0.5) * 38 + energy * 12);
            plasmaOffCtx.fillStyle = `hsl(${hue | 0},85%,${light | 0}%)`;
            plasmaOffCtx.fillRect(gx, gy, 1, 1);
          }
        }
        vctx.imageSmoothingEnabled = true;
        vctx.drawImage(plasmaOff, 0, 0, PLASMA_W, PLASMA_H, 0, 0, s.VW, s.VH);

      } else if (s.vizMode === 'kaleido') {
        // One audio-reactive wedge, drawn once, then replicated around a
        // full circle with alternating mirroring (scale(1,-1) every
        // other repetition) -- the same construction a real optical
        // kaleidoscope uses: one asymmetric pattern reflected enough
        // times that the *seams* are what create the symmetry, not the
        // source content itself needing to already be symmetric.
        vctx.fillStyle = `hsla(${hueBase | 0},60%,5%,0.16)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const FOLDS = 8;
        const wedgeAngle = (Math.PI * 2) / FOLDS;
        const R = Math.min(s.VW, s.VH) * 0.48 * s.vizUserScale;
        const bins = 28;
        vctx.save();
        vctx.translate(cx, cy);
        for (let f = 0; f < FOLDS; f++) {
          vctx.save();
          vctx.rotate(f * wedgeAngle + s.vizRot * 0.4);
          if (f % 2 === 1) vctx.scale(1, -1);
          for (let i = 0; i < bins; i++) {
            const t2 = i / bins;
            const angle = t2 * wedgeAngle;
            const v = s.freqData[Math.floor(t2 * maxBin)] / 255;
            if (v < 0.02) continue;
            const r0 = R * 0.12, r1 = r0 + v * R * 0.88;
            const hue = (hueBase + t2 * 260 + f * 15) % 360;
            vctx.beginPath();
            vctx.moveTo(Math.cos(angle) * r0, Math.sin(angle) * r0);
            vctx.lineTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
            vctx.strokeStyle = `hsla(${hue | 0},95%,${55 + v * 30 | 0}%,${(0.6 + v * 0.4).toFixed(2)})`;
            vctx.lineWidth = 1.6;
            vctx.stroke();
          }
          vctx.restore();
        }
        vctx.restore();

      } else if (s.vizMode === 'particles') {
        // A swarm that drifts with a slow random walk, sped up per-
        // particle by whichever frequency bin it's assigned to (so the
        // swarm as a whole visibly surges with the music instead of
        // moving at one constant rate) -- a low-alpha wash instead of a
        // hard clear each frame leaves a comet-tail behind every
        // particle rather than a bare dot.
        if (!s.particles) {
          s.particles = [];
          for (let i = 0; i < 180; i++) {
            s.particles.push({
              x: Math.random() * s.VW, y: Math.random() * s.VH,
              vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6,
              bin: Math.floor(Math.random() * maxBin), size: 1 + Math.random() * 2,
            });
          }
        }
        vctx.fillStyle = `hsla(${hueBase | 0},60%,4%,0.18)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const energy = s.freqData.slice(0, maxBin).reduce((a, b) => a + b, 0) / (maxBin * 255);
        for (const p of s.particles) {
          const v = s.freqData[Math.min(maxBin - 1, p.bin)] / 255;
          const speed = (1 + v * 4 + energy * 2) * s.speed;
          p.x += p.vx * speed; p.y += p.vy * speed;
          p.vx += (Math.random() - 0.5) * 0.05; p.vy += (Math.random() - 0.5) * 0.05;
          // clamp velocity so repeated random-walk jitter can't let a
          // particle's own speed run away unbounded over time
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > 1.2) { p.vx = (p.vx / sp) * 1.2; p.vy = (p.vy / sp) * 1.2; }
          if (p.x < 0) p.x += s.VW; else if (p.x > s.VW) p.x -= s.VW;
          if (p.y < 0) p.y += s.VH; else if (p.y > s.VH) p.y -= s.VH;
          const hue = (hueBase + (p.bin / maxBin) * 260) % 360;
          vctx.beginPath();
          vctx.arc(p.x, p.y, p.size * devicePixelRatio * (1 + v * 2), 0, Math.PI * 2);
          vctx.fillStyle = `hsla(${hue | 0},95%,${55 + v * 30 | 0}%,${(0.5 + v * 0.5).toFixed(2)})`;
          vctx.fill();
        }

      } else if (s.vizMode === 'freefall') {
        // Falling through an endless field of recursive flowers: each
        // one spawns tiny right at the vanishing point (screen center)
        // and grows/moves outward as its own "dist" climbs linearly
        // from 0 to 1 -- perspectiveR below (not dist itself) is what
        // turns that into the actual accelerating, rushing-at-the-end
        // visual growth (see its own comment). The instant one crosses
        // dist=1 (passed completely) it respawns at dist=0 with fresh
        // random size/angle -- an endless supply, never actually
        // "running out." Internal field/function names below still say
        // "building" (halfW, randomBuildingFields, ...) -- this used to
        // draw one per ring slot; the perspective/spawn/respawn
        // machinery that surrounds it didn't need to change at all when
        // the *shape* did, only what happens at the very end of this
        // branch (see drawFlowerPetals above).
        // shared by initial population, respawn-on-passing (below), and
        // the buildingCount slider growing the ring -- one place that
        // knows what a "fresh" building's random fields look like
        function randomBuildingFields() {
          return {
            angle: Math.random() * Math.PI * 2,
            halfW: 0.05 + Math.random() * 0.09,
            heightScale: 0.6 + Math.random() * 1.2,
            hueOff: Math.random() * 70 - 35,
            seed: Math.random() * 1000,
          };
        }
        if (!s.buildings) {
          s.buildings = [];
          for (let i = 0; i < s.buildingCount; i++) {
            s.buildings.push({ dist: Math.random(), ...randomBuildingFields() });  // staggered so they don't all arrive at once
          }
        }
        // buildingCount slider -- grow/shrink the ring to match; a
        // grown building is staggered in (fresh random dist) same as
        // the initial population, not dropped in already mid-flight at
        // dist=0, which would flash it into existence right at screen
        // center instead of spawning where a real one naturally would
        while (s.buildings.length < s.buildingCount) {
          s.buildings.push({ dist: Math.random(), ...randomBuildingFields() });
        }
        if (s.buildings.length > s.buildingCount) s.buildings.length = s.buildingCount;
        vctx.fillStyle = `hsla(${(hueBase + 200) % 360 | 0},55%,4%,1)`; vctx.fillRect(0, 0, s.VW, s.VH);
        const energy = s.freqData.slice(0, maxBin).reduce((a, b) => a + b, 0) / (maxBin * 255);
        const bassEnd = Math.max(1, Math.floor(maxBin * 0.12));
        const bass = s.freqData.slice(0, bassEnd).reduce((a, b) => a + b, 0) / (bassEnd * 255);
        const fallSpeed = (0.0035 + energy * 0.012) * s.speed;
        const maxR = Math.hypot(s.VW, s.VH) * 0.62 * s.vizUserScale;
        // Real (accelerating, not linear/quadratic) perspective: how
        // large something looks, and how far from the center of your
        // view it sits, both grow roughly as 1/remaining-distance as
        // you approach it -- barely changing for a long while, then
        // rushing at you hard in the final instant. The previous
        // dist*dist*maxR version grew smoothly and predictably the
        // whole way through instead, which read as "things gradually
        // getting bigger" rather than "falling toward something" --
        // exactly the reported "perspective is still off," even though
        // the buildings themselves already looked right by then. EPS
        // keeps the denominator from ever hitting exactly zero right as
        // a building respawns at dist=1; smaller EPS = a sharper, more
        // sudden rush in that final stretch.
        const EPS = 0.15;
        const rawMax = 1 / EPS - 1 / (1 + EPS);
        function perspectiveR(dist) {
          const raw = 1 / (1 - dist + EPS) - 1 / (1 + EPS);
          return maxR * (raw / rawMax);
        }
        // farthest (smallest) first, so nearer/larger buildings draw on
        // top -- the usual painter's-algorithm depth ordering any
        // perspective scene needs to look right
        const order = s.buildings.map((_, i) => i).sort((a, b) => s.buildings[a].dist - s.buildings[b].dist);
        for (const idx of order) {
          const b = s.buildings[idx];
          b.dist += fallSpeed;
          if (b.dist > 1) {
            b.dist -= 1;
            Object.assign(b, randomBuildingFields());
          }
          const r = perspectiveR(b.dist);
          const px = cx + Math.cos(b.angle) * r;
          const py = cy + Math.sin(b.angle) * r;
          const hue = (hueBase + b.hueOff + bass * 30) % 360;
          // Atmospheric depth on top of the size/position perspective
          // above: distant flowers read hazier and less saturated (more
          // haze between you and them), close ones crisp and vivid --
          // the baseline is pushed noticeably higher than the old
          // buildings' own version of this used, since a muted, mostly-
          // desaturated palette reads as concrete/glass but not as
          // flower petals.
          const sat = 35 + b.dist * 45;
          const baseLight = 30 + b.dist * 30;

          // (px,py) is this flower's own ground position (radius r,
          // same perspective math as before). baseSize is its overall
          // radius -- buildingWidthScale (the Width slider) multiplies
          // in here, at draw time, so it retunes every flower on screen
          // live rather than only newly-spawned ones (see its own
          // comment in the state object). bloomFactor is how much each
          // recursive level shrinks relative to its parent -- smaller
          // buildingHeightScale (the Height slider) means a *tighter*
          // shrink per level (a denser, more compact bloom); larger
          // means each level stays closer to its parent's size (a
          // fuller, more expansive bloom).
          //
          // depth is tied to baseSize, not a fixed constant: this
          // recursion costs petalCount^depth petal draws, so only the
          // handful of flowers big enough for the extra detail to
          // actually be visible (the close ones, about to rush past)
          // ever pay for the deeper levels -- see drawFlowerPetals'
          // own comment.
          const baseSize = Math.max(2, b.halfW * r * 2 * s.buildingWidthScale);
          const bloomFactor = Math.min(0.75, Math.max(0.35, 0.75 - s.buildingHeightScale * 0.15));
          const depth = baseSize > 46 ? 3 : baseSize > 16 ? 2 : 1;
          // a slow per-flower rotation drift (its own seed, so they're
          // not all spinning in lockstep), scaled by Speed via vizRot so
          // the Speed slider retunes this the same way it retunes every
          // other mode's own rotation
          const rotStep = b.seed * 0.002 + s.vizRot * 0.3;
          drawFlowerPetals(px, py, b.angle, baseSize, depth, hue, sat, baseLight, bloomFactor, energy, rotStep);
        }

      } else {
        // not one of the 11 built-in modes above -- a registered
        // plugin, or nothing (a stale s.vizMode from a plugin that's
        // since unregistered, in which case pluginModes.get returns
        // undefined and this frame just draws nothing rather than
        // erroring)
        const plugin = pluginModes.get(s.vizMode);
        if (plugin && !plugin.broken) callPlugin(plugin, 'draw', makeFrameContext());
      }
    }
    s.drawViz = drawViz;
    s.scheduleDraw = scheduleDraw;
    drawViz();

    // Fullscreen
    function toggleVizFullscreen() {
      if (!document.fullscreenElement) {
        (vizSection.requestFullscreen || vizSection.webkitRequestFullscreen).call(vizSection);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    }
    s.toggleVizFullscreen = toggleVizFullscreen;

    function setBackgrounded(bg) {
      s.backgrounded = !!bg;
      // a fullscreen vizSection that just went visibility:hidden would
      // leave the user staring at a black fullscreen surface
      if (bg && document.fullscreenElement === vizSection) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    }
    s.setBackgrounded = setBackgrounded;

    on(document, 'fullscreenchange', () => {
      resizeVizCanvas();
      if (vizFsBtn) vizFsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
    });
    on(document, 'keydown', function (e) {
      if (s.backgrounded) return;
      if (e.code === 'KeyF') toggleVizFullscreen();
      if (document.fullscreenElement && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        const idx = VIZ_MODES.indexOf(s.vizMode);
        setVizMode(VIZ_MODES[(idx + (e.code === 'ArrowRight' ? 1 : -1) + VIZ_MODES.length) % VIZ_MODES.length]);
      }
      // Shift+1 through Shift+7 jump straight to a mode, in the same
      // left-to-right order the mode buttons themselves render in --
      // not gated to fullscreen like arrow-key cycling above, since
      // these are absolute jumps.
      //
      // This used to be plain top-row digits, then Numpad -- both still
      // collided with something. Plain digits collided with
      // vue-app.js's onGlobalKeydown, which treats bare '1'-'5' as
      // "switch to tab N" with no easterEggVisible guard at all (this
      // dialog is inline in the same document now, not a separate
      // <iframe>, so both listeners see the same keydown -- see this
      // file's own module docstring). Numpad avoided that specific
      // collision but traded it for a much more common one: most
      // laptops have no physical numpad at all, so it was simply
      // unreachable for anyone without one.
      //
      // Shift+Digit avoids both: e.code stays 'Digit1' (works on every
      // keyboard, no numpad needed), but onGlobalKeydown's tabByDigit
      // check is keyed on e.key, not e.code -- and e.key for
      // Shift+Digit1 is '!' (US layout), '2' is '@', etc., none of
      // which are in tabByDigit, so it never fires no matter what this
      // does. No coordination between the two files needed: unshifted
      // digits keep meaning "switch tabs" and shifted ones mean "jump
      // viz mode," on completely disjoint e.key values, everywhere.
      if (e.shiftKey && e.code.startsWith('Digit')) {
        // Digit0 maps to the 10th mode, not "0th" -- there are now 10
        // VIZ_MODES (the original 7 plus Plasma/Kaleido/Particles), one
        // more than the top row's 1-9 alone can reach.
        const raw = parseInt(e.code.slice(5), 10);
        const n = raw === 0 ? 10 : raw;
        if (n >= 1 && n <= VIZ_MODES.length) { e.preventDefault(); setVizMode(VIZ_MODES[n - 1]); }
      }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        setAsciiBrightness(s.asciiBrightness + (e.code === 'ArrowUp' ? 0.1 : -0.1));
      }
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        e.preventDefault();
        setAsciiRes(s.asciiStride + (e.code === 'BracketRight' ? 1 : -1));
      }
    });

    // entry points vue-app.js's own feed loop calls directly every
    // frame -- see startOrbitVizFeed's own comment for why this used to
    // be postMessage and no longer needs to be
    s.pushAudio = function (freq, wave) {
      // Reactivity slider: scaling in place here, once, is what lets
      // every draw branch's own v/energy/bass math (dozens of call
      // sites across ten modes) get amplified or damped without each
      // one needing its own multiply -- skipped entirely at the default
      // 1.0 (the common case) for zero extra cost. Safe to mutate freq/
      // wave directly: they're vue-app.js's own reused AnalyserNode
      // buffers, already about to be overwritten by the next frame's
      // getByteFrequencyData/getByteTimeDomainData call regardless of
      // what happens to them here. waveData is centered at 128
      // (silence sits exactly there), so it's scaled *around* that
      // center rather than from zero -- scaling from zero would just
      // brighten it toward 255 instead of amplifying the actual
      // waveform swing.
      if (s.reactivity !== 1) {
        for (let i = 0; i < freq.length; i++) freq[i] = Math.min(255, freq[i] * s.reactivity);
        for (let i = 0; i < wave.length; i++) wave[i] = Math.min(255, Math.max(0, 128 + (wave[i] - 128) * s.reactivity));
      }
      s.freqData = freq; s.waveData = wave;
      // a message used to arrive every frame regardless of whether the
      // video was actually playing anything -- silence still "arrives,"
      // just all near-zero -- so "a call happened" alone can't tell
      // idle from playing. Real aggregate energy across the spectrum
      // can.
      const energy = freq.reduce((a, b) => a + b, 0);
      if (energy > 400 && !s.hasSignal) { s.hasSignal = true; idleNote.style.display = 'none'; }
      else if (energy <= 100 && s.hasSignal) { s.hasSignal = false; idleNote.style.display = ''; }
    };
    s.pushVideoFrame = function (w, h, data) {
      if (vpixOff.width !== w || vpixOff.height !== h) { vpixOff.width = w; vpixOff.height = h; }
      const isFirstFrame = !s.videoFrame;
      s.videoFrame = { w, h, imageData: new ImageData(data, w, h) };
      if (isFirstFrame) updateAsciiResLabel();
    };
  }

  function teardown() {
    if (!state) return;
    state.running = false;
    if (state.resizeObserver) state.resizeObserver.disconnect();
    for (const [target, type, fn, opts] of state.listeners) target.removeEventListener(type, fn, opts);
    // every registered plugin's own teardown() runs here too -- the DOM
    // (their buttons included) is about to be destroyed wholesale by
    // index.html's v-if regardless, but a plugin may have started its
    // own timers/listeners/state in init() that only it knows how to
    // clean up
    for (const mode of pluginModes.values()) state.callPlugin(mode, 'teardown', undefined);
    state = null;
  }

  return {
    init,
    teardown,
    pushAudio: (freq, wave) => { if (state) state.pushAudio(freq, wave); },
    pushVideoFrame: (w, h, data) => { if (state) state.pushVideoFrame(w, h, data); },
    toggleFullscreen: () => { if (state) state.toggleVizFullscreen(); },
    // background-for-the-stream lifecycle, driven by vue-app.js's
    // easterEggVisible/orbitStreaming watches
    isActive: () => !!state,
    setBackgrounded: (bg) => { if (state) state.setBackgrounded(bg); },
    // hidden-tab clock: with the external clock on, drawViz stops
    // scheduling itself and only runs when step() is called; turning it
    // off re-arms the rAF loop (no-op if a frame is already queued)
    setExternalClock: (on) => {
      externalClock = !!on;
      if (state && !externalClock && state.running) state.scheduleDraw();
    },
    step: () => { if (state && externalClock && state.running) state.drawViz(); },
    // "something else is about to replace the picture" (a new track):
    // run the configured transition from whatever's on the canvas now
    transition: () => { if (state) state.snapshotForTransition(); },
    debugState: () => (state ? state.transitionDebug() : null),
    // the plugin API -- see the pluginModes/registerMode comment near
    // the top of this file for the full contract
    registerMode,
    unregisterMode,
    listModes,
  };
})();
