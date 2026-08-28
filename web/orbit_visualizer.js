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
  const STEP_HUES = [0.33, 0.50, 0.62, 0.83, 0.10, 0.23];
  const VIZ_MODES = ['tunnel', 'bars', 'mirror', 'scope', 'spiral', 'pixels', 'ascii'];

  let state = null;

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
    const idleNote = document.getElementById('idleNote');
    const asciiControls = document.getElementById('asciiControls');
    const asciiResSlider = document.getElementById('asciiResSlider');
    const asciiResVal = document.getElementById('asciiResVal');
    const asciiBriSlider = document.getElementById('asciiBriSlider');
    const asciiBriVal = document.getElementById('asciiBriVal');
    const vizModesEl = document.getElementById('vizModes');
    const vizSection = document.getElementById('vizSection');
    const vizFsBtn = document.getElementById('vizFsBtn');

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
      videoFrame: null,
      VW: 0, VH: 0,
      vizPanX: 0, vizPanY: 0, vizUserScale: 1.0, vizRot: 0,
      // PIXELS mode's own rotation/pulse state -- separate from vizRot
      // above (shared by tunnel/scope/spiral at a fixed rate) since this
      // ring's whole point is spinning *faster when the audio is more
      // energetic*, not the same constant rate every other mode uses.
      pixelsRingRot: 0, pixelsPulse: 0,
      vizMode: 'ascii',
      // ASCII's own controls -- resolution (STRIDE, coarser = fewer/
      // bigger characters) and color mode (the video's real per-cell
      // color vs. the rotating neon palette added for "often quite
      // dark" real footage). Defaults match the initial-active states
      // set on the buttons/slider in index.html -- full resolution
      // (stride 1), natural color.
      asciiStride: 1,
      asciiColorMode: 'natural',
      // Multiplies the per-pixel luminance ASCII uses for both glyph
      // density (which RAMP character gets picked) and color intensity
      // (alpha in NATURAL, lightness/alpha in NEON) -- the direct
      // answer to "often quite dark". >1 also lets genuinely dark source
      // footage clear the bright<0.03 skip threshold and actually
      // render instead of leaving blank cells.
      asciiBrightness: 1.8,
      panning: false, lastX: 0, lastY: 0,
      listeners: [],
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

    function resetVizNav() { s.vizPanX = 0; s.vizPanY = 0; s.vizUserScale = 1.0; }

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
      s.vizUserScale = Math.min(Math.max(0.15, s.vizUserScale * (e.deltaY > 0 ? 0.93 : 1.07)), 8.0);
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
      if (!VIZ_MODES.includes(mode)) return;
      s.vizMode = mode;
      document.querySelectorAll('[data-viz]').forEach(b => b.classList.toggle('lit', b.dataset.viz === mode));
      resetVizNav();
      asciiControls.style.display = mode === 'ascii' ? 'flex' : 'none';
    }
    on(vizModesEl, 'click', function (e) {
      const btn = e.target.closest('[data-viz]'); if (!btn) return;
      setVizMode(btn.dataset.viz);
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

    // ASCII color mode -- NATURAL (the video's own per-cell color) vs
    // NEON (the rotating HSL palette for dim/desaturated real footage).
    document.querySelectorAll('#asciiControls [data-color]').forEach(btn => {
      on(btn, 'click', () => {
        s.asciiColorMode = btn.dataset.color;
        document.querySelectorAll('#asciiControls [data-color]').forEach(b => b.classList.toggle('lit', b === btn));
      });
    });

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

    // Draw loop -- same seven modes, same math, as the standalone page
    // this was ported from, just reading state pushed directly via
    // pushAudio/pushVideoFrame below instead of a postMessage listener.
    function drawViz() {
      if (!s.running) return;
      requestAnimationFrame(drawViz);
      if (!s.VW || !s.VH) return;

      // slow independent color drift -- a steady drift gives the same
      // "the whole thing slowly shifts hue" feel without needing a
      // sequencer to derive it from
      s.c60Hue = (performance.now() / 20000) % 1;
      s.vizRot += 0.006;

      const cx = s.VW / 2 + s.vizPanX, cy = s.VH / 2 + s.vizPanY;
      const maxBin = Math.floor(s.freqData.length * 0.70);
      const hueBase = s.c60Hue * 360;

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
          s.pixelsRingRot += 0.004 + energy * 0.05;

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
          const RAMP = ' .:-=+*#%@';
          const STRIDE = s.asciiStride;
          const cols = Math.floor(s.videoFrame.w / STRIDE);
          const rows = Math.floor(s.videoFrame.h / STRIDE);
          const fit = fitFrameToCanvas(s.videoFrame.w, s.videoFrame.h);
          const cellW = (fit.w * s.vizUserScale) / cols;
          const cellH = (fit.h * s.vizUserScale) / rows;
          const ox = cx - (fit.w * s.vizUserScale) / 2;
          const oy = cy - (fit.h * s.vizUserScale) / 2;
          const px = s.videoFrame.imageData.data;
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
      }
    }
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

    on(document, 'fullscreenchange', () => {
      resizeVizCanvas();
      if (vizFsBtn) vizFsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
    });
    on(document, 'keydown', function (e) {
      if (e.code === 'KeyF') toggleVizFullscreen();
      if (document.fullscreenElement && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        const idx = VIZ_MODES.indexOf(s.vizMode);
        setVizMode(VIZ_MODES[(idx + (e.code === 'ArrowRight' ? 1 : -1) + VIZ_MODES.length) % VIZ_MODES.length]);
      }
      // 1-7 jump straight to a mode, in the same left-to-right order the
      // mode buttons themselves render in -- not gated to fullscreen
      // like arrow-key cycling above, since these are absolute jumps.
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
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
    state = null;
  }

  return {
    init,
    teardown,
    pushAudio: (freq, wave) => { if (state) state.pushAudio(freq, wave); },
    pushVideoFrame: (w, h, data) => { if (state) state.pushVideoFrame(w, h, data); },
    toggleFullscreen: () => { if (state) state.toggleVizFullscreen(); },
  };
})();
