'use strict';
// Extra Orbit Visualizer modes and transitions, built entirely on the
// public plugin API (window.orbitViz.registerMode / registerTransition
// -- see orbit_visualizer.js's own registry comments for the contracts).
// Nothing in here touches the visualizer's internals: this file is the
// proof that the plugin architecture is enough to add a whole second
// set of effects, and the template for adding more. Drop the <script>
// tag in index.html to get the built-ins only.
//
// Modes:       Halftone, Lava, Terrain, Rain, Lissajous, Ripples, Cube, VHS, Win95, J Division,
//              Spectrogram, Stained glass, Fireworks, Screensaver, Slit-scan, Skyline, Globe
// Transitions: Melt, Dissolve, Iris, Shatter, Wave, Spin, Zoom blur, RGB split, VHS, Win95,
//              Blinds, Flip tiles, CRT off, Droplet, Blur, Slide, Flash
(function () {
  const viz = window.orbitViz;
  if (!viz || typeof viz.registerMode !== 'function') return;

  // ── shared helpers ────────────────────────────────────────────────
  // deterministic 0..1 "random" for anything that must hold still frame
  // to frame but differ per column/block/run
  const hash = (n) => { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  // 0..1 loudness over the useful part of the spectrum / just the bass bins
  function energyOf(freq) {
    const n = Math.max(1, Math.floor(freq.length * 0.7)); let s = 0;
    for (let i = 0; i < n; i++) s += freq[i];
    return s / (n * 255);
  }
  function bassOf(freq) {
    const n = Math.max(1, Math.floor(freq.length * 0.06)); let s = 0;
    for (let i = 0; i < n; i++) s += freq[i];
    return s / (n * 255);
  }
  // luminance 0..1 of the sampled video frame at a canvas position
  function lumAt(vf, x, y, W, H) {
    const px = Math.min(vf.w - 1, Math.max(0, (x / W * vf.w) | 0));
    const py = Math.min(vf.h - 1, Math.max(0, (y / H * vf.h) | 0));
    const o = (py * vf.w + px) * 4, d = vf.imageData.data;
    return (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) / 255;
  }
  // a plugin-owned offscreen canvas, resized on demand
  function offscreen() {
    const c = document.createElement('canvas'); const ctx = c.getContext('2d');
    return (w, h) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return { c, ctx }; };
  }
  // fading the previous frame instead of clearing it is what gives the
  // trail/phosphor look several of these use
  function fadeFrame(vctx, W, H, alpha) { vctx.fillStyle = `rgba(0,0,0,${alpha})`; vctx.fillRect(0, 0, W, H); }

  // ══════════════════════════════════════════════════════════════════
  //  MODES
  // ══════════════════════════════════════════════════════════════════

  // Halftone: the video as a grid of dots, dot size from brightness,
  // the whole grid breathing with the bass. Newsprint on acid.
  viz.registerMode({
    id: 'halftone', label: 'Halftone',
    draw(ctx) {
      const { vctx, VW, VH, hueBase, freqData, videoFrame, vizUserScale, vizRot } = ctx;
      vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
      const cell = Math.max(6, (VW / 64) * vizUserScale);
      const bass = bassOf(freqData), swell = 1 + bass * 0.5;
      const cols = Math.ceil(VW / cell) + 1, rows = Math.ceil(VH / cell) + 1;
      for (let j = 0; j < rows; j++) {
        // alternate rows offset half a cell, like a real halftone screen
        const ox = (j % 2) * cell * 0.5;
        for (let i = 0; i < cols; i++) {
          const x = i * cell + ox, y = j * cell;
          let lum;
          if (videoFrame) lum = lumAt(videoFrame, x, y, VW, VH);
          else lum = 0.5 + 0.5 * Math.sin(i * 0.35 + vizRot * 3) * Math.cos(j * 0.3 - vizRot * 2);
          const r = cell * 0.62 * (0.08 + lum * 0.92) * swell;
          if (r < 0.4) continue;
          const hue = (hueBase + (x / VW) * 90 + lum * 60) % 360;
          vctx.fillStyle = `hsl(${hue | 0},95%,${(45 + lum * 30) | 0}%)`;
          vctx.beginPath(); vctx.arc(x, y, r, 0, Math.PI * 2); vctx.fill();
        }
      }
    },
  });

  // Lava: metaballs. Blurred blobs pushed through a hard contrast curve
  // merge and split like a lava lamp; the bass makes them swell.
  (function () {
    const blobs = []; const small = offscreen();
    viz.registerMode({
      id: 'lava', label: 'Lava',
      init() { blobs.length = 0; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, speed, vizUserScale } = ctx;
        const SW = Math.max(32, VW >> 2), SH = Math.max(18, VH >> 2);
        const { c, ctx: sctx } = small(SW, SH);
        if (!blobs.length) for (let i = 0; i < 8; i++) blobs.push({
          x: Math.random() * SW, y: Math.random() * SH,
          vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, r: 0.6 + Math.random() * 0.6,
        });
        const bass = bassOf(freqData), energy = energyOf(freqData);
        sctx.fillStyle = '#000'; sctx.fillRect(0, 0, SW, SH);
        sctx.globalCompositeOperation = 'lighter';
        const base = Math.min(SW, SH) * 0.16 * vizUserScale;
        for (const b of blobs) {
          b.x += b.vx * speed * (1 + energy); b.y += b.vy * speed * (1 + energy);
          if (b.x < 0 || b.x > SW) b.vx *= -1; if (b.y < 0 || b.y > SH) b.vy *= -1;
          const r = base * b.r * (1 + bass * 0.7);
          const g = sctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
          g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          sctx.fillStyle = g; sctx.beginPath(); sctx.arc(b.x, b.y, r, 0, Math.PI * 2); sctx.fill();
        }
        sctx.globalCompositeOperation = 'source-over';
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        vctx.save();
        vctx.filter = `blur(${Math.max(2, VW / 160)}px) contrast(30)`;
        vctx.drawImage(c, 0, 0, VW, VH);
        vctx.restore();
        // colour the white blobs: multiply keeps the black background black
        vctx.globalCompositeOperation = 'multiply';
        const grad = vctx.createLinearGradient(0, 0, VW, VH);
        grad.addColorStop(0, `hsl(${hueBase | 0},100%,55%)`);
        grad.addColorStop(1, `hsl(${(hueBase + 90) | 0},100%,50%)`);
        vctx.fillStyle = grad; vctx.fillRect(0, 0, VW, VH);
        vctx.globalCompositeOperation = 'source-over';
      },
    });
  })();

  // Terrain: the spectrum as a wireframe landscape scrolling toward
  // you, newest row nearest, a sun on the horizon. Outrun tape cover.
  (function () {
    const COLS = 48, ROWS = 40; let rowsBuf = [];
    viz.registerMode({
      id: 'terrain', label: 'Terrain',
      init() { rowsBuf = []; },
      draw(ctx) {
        const { vctx, VW, VH, cx, hueBase, freqData, vizUserScale, vizRot } = ctx;
        const row = new Float32Array(COLS);
        const maxBin = Math.floor(freqData.length * 0.7);
        for (let i = 0; i < COLS; i++) {
          // mirrored so the loud low end sits in the middle of the valley
          const k = Math.abs(i - COLS / 2) / (COLS / 2);
          row[i] = freqData[Math.floor(k * maxBin)] / 255;
        }
        rowsBuf.unshift(row); if (rowsBuf.length > ROWS) rowsBuf.pop();
        vctx.fillStyle = '#04030a'; vctx.fillRect(0, 0, VW, VH);
        const horizon = VH * 0.38;
        // sun
        const sunR = Math.min(VW, VH) * 0.16 * vizUserScale;
        const sg = vctx.createLinearGradient(0, horizon - sunR, 0, horizon + sunR * 0.2);
        sg.addColorStop(0, `hsl(${(hueBase + 40) | 0},100%,70%)`); sg.addColorStop(1, `hsl(${(hueBase + 320) | 0},100%,55%)`);
        vctx.fillStyle = sg; vctx.beginPath(); vctx.arc(cx, horizon - sunR * 0.1, sunR, 0, Math.PI * 2); vctx.fill();
        vctx.fillStyle = '#04030a';
        for (let i = 0; i < 6; i++) vctx.fillRect(0, horizon - sunR * 0.05 - i * sunR * 0.16, VW, sunR * 0.04 + i * sunR * 0.01);
        // far to near so the near rows occlude the far ones
        for (let r = rowsBuf.length - 1; r >= 0; r--) {
          const zf = (r + 0.5) / ROWS;                    // 0 near .. 1 far
          const depth = Math.pow(1 - zf, 1.7);
          const y0 = horizon + (VH - horizon) * depth * 1.05;
          const spread = VW * (0.22 + 1.5 * depth) * vizUserScale;
          const amp = VH * 0.32 * depth * (0.6 + 0.4 * vizUserScale);
          vctx.beginPath();
          for (let i = 0; i < COLS; i++) {
            const x = cx + (i / (COLS - 1) - 0.5) * spread;
            const y = y0 - rowsBuf[r][i] * amp;
            if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
          }
          vctx.lineTo(cx + 0.5 * spread, VH + 2); vctx.lineTo(cx - 0.5 * spread, VH + 2); vctx.closePath();
          vctx.fillStyle = '#04030a'; vctx.fill();
          const hue = (hueBase + 200 + zf * 120 + vizRot * 10) % 360;
          vctx.strokeStyle = `hsla(${hue | 0},100%,${(45 + 35 * (1 - zf)) | 0}%,${(0.25 + 0.75 * (1 - zf)).toFixed(2)})`;
          vctx.lineWidth = 1 + 1.5 * (1 - zf);
          vctx.stroke();
        }
      },
    });
  })();

  // Rain: falling glyph columns, each glyph lit by the video behind it,
  // so the picture shows through as code. Louder music, faster rain.
  (function () {
    const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789Z:・=*+-<>¦|ç';
    let drops = [], lastFs = 0;
    viz.registerMode({
      id: 'rain', label: 'Rain',
      init() { drops = []; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, vizUserScale, speed } = ctx;
        const fs = Math.max(9, Math.round((VW / 70) * vizUserScale));
        const cols = Math.ceil(VW / fs);
        if (drops.length !== cols || fs !== lastFs) {
          drops = Array.from({ length: cols }, (_, i) => ({ y: -Math.random() * 40, v: 0.4 + Math.random() * 0.8, len: 8 + (hash(i * 7.1) * 18 | 0) }));
          lastFs = fs;
        }
        const energy = energyOf(freqData);
        fadeFrame(vctx, VW, VH, 0.18);
        vctx.font = `${fs}px monospace`; vctx.textBaseline = 'top';
        const hue = (hueBase * 0.4 + 110) % 360;
        for (let i = 0; i < cols; i++) {
          const d = drops[i];
          d.y += d.v * speed * (0.5 + energy * 2.5);
          const headRow = Math.floor(d.y), x = i * fs;
          for (let k = 0; k < d.len; k++) {
            const row = headRow - k, y = row * fs;
            if (y < -fs || y > VH) continue;
            const lum = videoFrame ? lumAt(videoFrame, x + fs / 2, y + fs / 2, VW, VH) : 0.6;
            const bright = (1 - k / d.len) * (0.25 + lum * 0.9);
            vctx.fillStyle = k === 0 ? `hsla(${hue | 0},40%,${(75 + lum * 25) | 0}%,1)` : `hsla(${hue | 0},100%,${(25 + 40 * bright) | 0}%,${bright.toFixed(2)})`;
            vctx.fillText(GLYPHS[(hash(i * 31.7 + row * 3.3) * GLYPHS.length) | 0], x, y);
          }
          if ((headRow - d.len) * fs > VH) { d.y = -Math.random() * 30; d.v = 0.4 + Math.random() * 0.8; }
        }
      },
    });
  })();

  // Lissajous: the waveform plotted against a delayed copy of itself,
  // an XY oscilloscope with phosphor persistence, plus a parametric
  // figure whose ratio drifts with the music.
  viz.registerMode({
    id: 'lissajous', label: 'Lissajous',
    draw(ctx) {
      const { vctx, VW, VH, cx, cy, hueBase, waveData, freqData, vizRot, vizUserScale } = ctx;
      fadeFrame(vctx, VW, VH, 0.14);
      const n = waveData.length, R = Math.min(VW, VH) * 0.42 * vizUserScale;
      const energy = energyOf(freqData), bass = bassOf(freqData);
      const lag = Math.floor(n * (0.12 + 0.12 * (0.5 + 0.5 * Math.sin(vizRot * 0.7))));
      vctx.lineWidth = 1.6; vctx.lineJoin = 'round';
      vctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = cx + (waveData[i] / 128 - 1) * R * (1 + energy * 0.4);
        const y = cy + (waveData[(i + lag) % n] / 128 - 1) * R * (1 + energy * 0.4);
        if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
      }
      vctx.strokeStyle = `hsla(${(hueBase + 120) | 0},100%,65%,0.9)`; vctx.stroke();
      // the figure: a:b ratio steps with the bass, phase spins with speed
      const a = 2 + Math.round(bass * 3), b = 3, phase = vizRot * 0.9;
      vctx.beginPath();
      for (let i = 0; i <= 400; i++) {
        const th = (i / 400) * Math.PI * 2;
        const x = cx + Math.sin(a * th + phase) * R * 0.8, y = cy + Math.sin(b * th) * R * 0.8;
        if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
      }
      vctx.strokeStyle = `hsla(${hueBase | 0},100%,60%,${(0.35 + energy * 0.5).toFixed(2)})`; vctx.lineWidth = 1; vctx.stroke();
    },
  });

  // Ripples, as a 33⅓: a black LP turning at record speed, its grooves
  // lit band by band by the spectrum, a beat sending a bright ripple
  // out across them from the label to the rim. The label carries the
  // track's title and spins with the disc; a tonearm tracks inward
  // with the track's own progress. The bass rocks the platter.
  (function () {
    let rings = [], avg = 0, cooldown = 0, angle = 0, lastNow = 0;
    const player = () => document.querySelector('#global-player video:not(.swap-video)');
    viz.registerMode({
      id: 'ripples', label: 'Vinyl 33',
      init() { rings = []; avg = 0; cooldown = 0; angle = 0; lastNow = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, speed, vizUserScale } = ctx;
        const now = performance.now();
        if (lastNow) angle += ((now - lastNow) / 1000) * (2 * Math.PI * 33.333 / 60) * speed;   // 33⅓ rpm, Speed scales it
        lastNow = now;
        const energy = energyOf(freqData), bass = bassOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        avg = avg * 0.94 + energy * 0.06; cooldown = Math.max(0, cooldown - 1);
        if (energy > avg * 1.2 + 0.04 && cooldown === 0) { rings.push({ r: 0, w: 1 + energy * 3 }); cooldown = 8; }
        vctx.fillStyle = '#0a0a0c'; vctx.fillRect(0, 0, VW, VH);
        const R = Math.min(VW, VH) * 0.46 * vizUserScale * (1 + bass * 0.015), RL = R * 0.36, RH = R * 0.018;
        vctx.save();
        vctx.translate(cx, cy);
        // the platter: near-black, a whisper of a sheen that turns with it
        vctx.beginPath(); vctx.arc(0, 0, R, 0, Math.PI * 2);
        const disc = vctx.createRadialGradient(0, 0, RL, 0, 0, R);
        disc.addColorStop(0, '#16161a'); disc.addColorStop(1, '#0c0c0f');
        vctx.fillStyle = disc; vctx.fill();
        vctx.save(); vctx.clip();
        vctx.rotate(angle);
        const sheen = vctx.createLinearGradient(-R, -R, R, R);
        sheen.addColorStop(0.42, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.07)'); sheen.addColorStop(0.58, 'rgba(255,255,255,0)');
        vctx.fillStyle = sheen; vctx.fillRect(-R, -R, R * 2, R * 2);
        vctx.restore();
        // the grooves: one ring per band, lit by its loudness
        const n = Math.max(24, Math.floor((R - RL) / Math.max(2, R * 0.012)));
        vctx.lineWidth = 1;
        for (let i = 0; i < n; i++) {
          const f = i / (n - 1), r = R - f * (R - RL) * 0.98;
          const v = freqData[Math.floor(f * maxBin)] / 255;          // outer grooves = low end
          vctx.beginPath(); vctx.arc(0, 0, r, 0, Math.PI * 2);
          vctx.strokeStyle = v > 0.04 ? `hsla(${(hueBase + f * 60) | 0},70%,${(25 + v * 55) | 0}%,${(0.12 + v * 0.6).toFixed(2)})` : 'rgba(255,255,255,0.06)';
          vctx.stroke();
        }
        // the ripples: a beat's ring runs out across the grooves
        vctx.lineCap = 'round';
        for (let i = rings.length - 1; i >= 0; i--) {
          const g = rings[i]; g.r += (R * 0.012) * speed;
          const r = RL + g.r; if (r > R) { rings.splice(i, 1); continue; }
          const life = 1 - g.r / (R - RL);
          vctx.beginPath(); vctx.arc(0, 0, r, 0, Math.PI * 2);
          vctx.strokeStyle = `hsla(${hueBase | 0},100%,80%,${(life * 0.9).toFixed(2)})`; vctx.lineWidth = g.w * life + 0.5; vctx.stroke();
        }
        // the label, spinning with the disc
        vctx.save(); vctx.rotate(angle);
        vctx.beginPath(); vctx.arc(0, 0, RL, 0, Math.PI * 2);
        vctx.fillStyle = `hsl(${hueBase | 0},60%,${(38 + bass * 12) | 0}%)`; vctx.fill();
        vctx.lineWidth = Math.max(1, RL * 0.02); vctx.strokeStyle = 'rgba(0,0,0,0.5)'; vctx.stroke();
        vctx.beginPath(); vctx.arc(0, 0, RL * 0.82, 0, Math.PI * 2); vctx.strokeStyle = 'rgba(255,255,255,0.25)'; vctx.lineWidth = 1; vctx.stroke();
        const fs = Math.max(8, RL * 0.13);
        vctx.fillStyle = 'rgba(255,255,255,0.9)'; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
        vctx.font = `bold ${fs}px serif`; vctx.fillText('WEED RECORDS', 0, -RL * 0.45);
        const titleEl = document.querySelector('#global-player .player-title');
        let title = (titleEl ? titleEl.textContent : '').trim().replace(/\.(mp4|m4v|mkv|webm|mov|avi|mp3|m4a|flac|ogg|wav)$/i, '');
        vctx.font = `${fs * 0.85}px sans-serif`;
        while (title.length > 3 && vctx.measureText(title).width > RL * 1.5) title = title.slice(0, -2) + '…';
        vctx.fillText(title || '—', 0, -RL * 0.2);
        vctx.font = `${fs * 0.7}px sans-serif`; vctx.fillText('SIDE A', 0, RL * 0.32);
        vctx.font = `bold ${fs * 0.8}px sans-serif`; vctx.fillText('33⅓ RPM', 0, RL * 0.55);
        vctx.textAlign = 'left';
        vctx.restore();
        // the spindle hole
        vctx.beginPath(); vctx.arc(0, 0, RH, 0, Math.PI * 2); vctx.fillStyle = '#0a0a0c'; vctx.fill();
        vctx.restore();
        // the tonearm, from a pivot off the top-right of the platter,
        // its needle riding inward with the track
        const v = player();
        const progress = v && v.duration > 0 ? Math.min(1, v.currentTime / v.duration) : ((now / 240000) % 1);
        const rNeedle = R * 0.97 - progress * (R * 0.97 - RL * 1.05);
        const px = cx + R * 0.95, py = cy - R * 1.0;                  // pivot
        // the needle sits on the disc at radius rNeedle, at arm's reach
        // from the pivot: the arm's length is the pivot's distance to
        // the spindle, so the two circles meet where the needle goes
        const armLen = Math.hypot(px - cx, py - cy);
        const t = Math.atan2(cy - py, cx - px);
        const cosA = Math.max(-1, Math.min(1, (2 * armLen * armLen - rNeedle * rNeedle) / (2 * armLen * armLen)));
        const a = t + Math.acos(cosA);
        const nx = px + Math.cos(a) * armLen, ny = py + Math.sin(a) * armLen;
        vctx.lineCap = 'round';
        vctx.beginPath(); vctx.arc(px, py, R * 0.08, 0, Math.PI * 2); vctx.fillStyle = '#2a2a30'; vctx.fill();
        vctx.strokeStyle = '#8a8a92'; vctx.lineWidth = Math.max(3, R * 0.02); vctx.beginPath(); vctx.moveTo(px, py); vctx.lineTo(nx, ny); vctx.stroke();
        vctx.strokeStyle = '#c8c8d0'; vctx.lineWidth = Math.max(1.5, R * 0.008); vctx.beginPath(); vctx.moveTo(px, py); vctx.lineTo(nx, ny); vctx.stroke();
        vctx.beginPath(); vctx.arc(nx, ny, R * 0.035, 0, Math.PI * 2); vctx.fillStyle = '#d9d9e0'; vctx.fill();
        vctx.beginPath(); vctx.arc(nx, ny, R * 0.012, 0, Math.PI * 2); vctx.fillStyle = `hsl(${hueBase | 0},90%,60%)`; vctx.fill();
      },
    });
  })();

  // Cube: a wireframe cube tumbling in perspective, each edge's weight
  // and glow riding its own frequency band, a smaller one nested inside
  // that swells with the bass.
  (function () {
    const V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    function project(p, rx, ry, rz, size, cx, cy) {
      let [x, y, z] = p;
      let c = Math.cos(rx), s = Math.sin(rx); [y, z] = [y * c - z * s, y * s + z * c];
      c = Math.cos(ry); s = Math.sin(ry); [x, z] = [x * c + z * s, -x * s + z * c];
      c = Math.cos(rz); s = Math.sin(rz); [x, y] = [x * c - y * s, x * s + y * c];
      const d = 4 / (4 + z);
      return [cx + x * size * d, cy + y * size * d, d];
    }
    viz.registerMode({
      id: 'cube', label: 'Cube',
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale } = ctx;
        fadeFrame(vctx, VW, VH, 0.25);
        const bass = bassOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        const size = Math.min(VW, VH) * 0.22 * vizUserScale;
        vctx.lineCap = 'round';
        for (const [scale, spin, alpha] of [[1, 1, 1], [0.45 + bass * 0.4, -1.6, 0.7]]) {
          const pts = V.map(p => project(p, vizRot * 0.7 * spin, vizRot * spin, vizRot * 0.3 * spin, size * scale, cx, cy));
          E.forEach(([a, b], i) => {
            const v = freqData[Math.floor((i / E.length) * maxBin)] / 255;
            const depth = (pts[a][2] + pts[b][2]) / 2;
            vctx.beginPath(); vctx.moveTo(pts[a][0], pts[a][1]); vctx.lineTo(pts[b][0], pts[b][1]);
            vctx.strokeStyle = `hsla(${(hueBase + i * 30) | 0},100%,${(50 + v * 35) | 0}%,${(alpha * (0.35 + depth * 0.5)).toFixed(2)})`;
            vctx.lineWidth = (1 + v * 7) * depth * scale;
            vctx.stroke();
          });
        }
      },
    });
  })();

  // J Division: Unknown Pleasures. Stacked white traces on black, each
  // one a pulse of the spectrum shaped by a bell so it's busy in the
  // middle and flat at the sides, each trace blacking out whatever sits
  // behind it. New traces arrive at the bottom and the stack climbs.
  (function () {
    const N = 160, ROWS = 80;
    let rows = [], frameNo = 0;
    function makeRow(freqData, energy) {
      const r = new Float32Array(N), maxBin = Math.floor(freqData.length * 0.6);
      for (let i = 0; i < N; i++) {
        const x = i / (N - 1), d = (x - 0.5) / 0.17;
        const bell = Math.exp(-d * d);
        const k = Math.abs(x - 0.5) * 2;                       // loud low end in the middle
        const spec = freqData[Math.floor(k * k * maxBin)] / 255;
        const jag = (Math.random() - 0.5) * (0.25 + energy * 0.6);
        r[i] = bell * (0.2 + spec * 1.3 + jag) + (Math.random() - 0.5) * 0.03;
      }
      // a light smoothing so the jaggedness reads as a signal, not sand
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = (r[Math.max(0, i - 1)] + r[i] * 2 + r[Math.min(N - 1, i + 1)]) / 4;
      return out;
    }
    viz.registerMode({
      id: 'joydivision', label: 'J Division',
      init() { rows = []; frameNo = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, freqData, speed, vizUserScale } = ctx;
        const energy = energyOf(freqData);
        frameNo++;
        // the stack climbs at the Speed slider's pace
        const every = Math.max(1, Math.round(3 / speed));
        if (frameNo % every === 0) { rows.push(makeRow(freqData, energy)); if (rows.length > ROWS) rows.shift(); }
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        const plotW = Math.min(VW * 0.9, VH * 0.95) * vizUserScale;
        const plotH = plotW * 0.78, top = (VH - plotH) / 2, left = cx - plotW / 2;
        const spacing = plotH / ROWS, amp = spacing * 9 * (1 + energy * 0.5);
        vctx.lineWidth = Math.max(1, VW / 900); vctx.lineJoin = 'round';
        vctx.strokeStyle = '#f2f2f2';
        // oldest at the top, drawn first; every newer trace below fills
        // black under itself and covers what's behind
        const start = ROWS - rows.length;
        for (let i = 0; i < rows.length; i++) {
          const y0 = top + (start + i) * spacing, r = rows[i];
          vctx.beginPath();
          for (let j = 0; j < N; j++) {
            const x = left + (j / (N - 1)) * plotW, y = y0 - Math.max(0, r[j]) * amp;
            if (j === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
          }
          vctx.lineTo(left + plotW, VH + 2); vctx.lineTo(left, VH + 2); vctx.closePath();
          vctx.fillStyle = '#000'; vctx.fill();
          vctx.beginPath();
          for (let j = 0; j < N; j++) {
            const x = left + (j / (N - 1)) * plotW, y = y0 - Math.max(0, r[j]) * amp;
            if (j === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
          }
          vctx.stroke();
        }
      },
    });
  })();

  // ══════════════════════════════════════════════════════════════════
  //  TRANSITIONS
  // ══════════════════════════════════════════════════════════════════

  // Melt: the old picture runs down the screen in columns, each on its
  // own delay, the way the Doom screen melt did it.
  viz.registerTransition({
    id: 'melt', label: 'Melt',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const cw = Math.max(3, W / 110), n = Math.ceil(W / cw), scw = oldW / n;
      for (let i = 0; i < n; i++) {
        const delay = 0.22 * (0.5 + 0.5 * Math.sin(i * 0.33 + seed)) + 0.16 * hash(i * 9.7 + seed);
        const dy = Math.max(0, (t * 1.45 - delay)) * H * 1.1;
        if (dy >= H) continue;
        vctx.drawImage(old, i * scw, 0, scw, oldH, i * cw, dy, cw, H);
      }
    },
  });

  // Dissolve: the old picture goes block by block in a random order,
  // each block flaring white for an instant as it goes.
  viz.registerTransition({
    id: 'dissolve', label: 'Dissolve',
    draw({ vctx, old, W, H, t, seed, scratch }) {
      const sc = scratch();
      sc.drawImage(old, 0, 0, W, H);
      const cols = 32, rows = 18, bw = W / cols, bh = H / rows, FLARE = 0.07;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const th = hash(i * 12.9898 + j * 78.233 + seed) * (1 - FLARE);
        if (th < t) sc.clearRect(i * bw, j * bh, bw + 0.5, bh + 0.5);
        else if (th < t + FLARE) {
          sc.fillStyle = `rgba(255,255,255,${(0.7 * (1 - (th - t) / FLARE)).toFixed(2)})`;
          sc.fillRect(i * bw, j * bh, bw + 0.5, bh + 0.5);
        }
      }
      vctx.drawImage(sc.canvas, 0, 0);
    },
  });

  // Iris: a soft-edged circle opens from the middle, the new picture
  // inside it, the old outside.
  viz.registerTransition({
    id: 'iris', label: 'Iris',
    draw({ vctx, old, W, H, t, scratch }) {
      const sc = scratch();
      sc.drawImage(old, 0, 0, W, H);
      const maxR = Math.hypot(W, H) / 2, edge = maxR * 0.12, r = t * (maxR + edge);
      sc.globalCompositeOperation = 'destination-out';
      const g = sc.createRadialGradient(W / 2, H / 2, Math.max(0, r - edge), W / 2, H / 2, Math.max(0.01, r));
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      sc.fillStyle = g; sc.fillRect(0, 0, W, H);
      vctx.drawImage(sc.canvas, 0, 0);
    },
  });

  // Shatter: the old picture breaks into vertical shards that drop out
  // of frame, each tumbling at its own speed.
  viz.registerTransition({
    id: 'shatter', label: 'Shatter',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const n = 14, sw = W / n, ssw = oldW / n, tt = t * t;
      for (let i = 0; i < n; i++) {
        const fall = tt * H * (1.1 + hash(i * 3.7 + seed) * 1.6);
        const rot = (hash(i * 5.1 + seed) - 0.5) * 0.9 * t;
        vctx.save();
        vctx.globalAlpha = 1 - tt;
        vctx.translate(i * sw + sw / 2, H / 2 + fall);
        vctx.rotate(rot);
        vctx.drawImage(old, i * ssw, 0, ssw, oldH, -sw / 2, -H / 2, sw, H);
        vctx.restore();
      }
    },
  });

  // Wave: the old picture ripples sideways in a sine wave that grows
  // until it tears apart.
  viz.registerTransition({
    id: 'wave', label: 'Wave',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const bh = Math.max(2, H / 120), n = Math.ceil(H / bh), sbh = oldH / n, amp = W * 0.3 * t * t;
      vctx.globalAlpha = 1 - t * t;
      for (let i = 0; i < n; i++) {
        const dx = Math.sin((i / n) * Math.PI * 6 + seed + t * 14) * amp;
        vctx.drawImage(old, 0, i * sbh, oldW, sbh, dx, i * bh, W, bh);
      }
    },
  });

  // Spin: the old picture whirls down the drain, shrinking and cycling
  // through the spectrum on the way.
  viz.registerTransition({
    id: 'spin', label: 'Spin',
    draw({ vctx, old, W, H, t }) {
      const k = Math.pow(1 - t, 1.3);
      vctx.globalAlpha = 1 - t * t * t;
      vctx.translate(W / 2, H / 2);
      vctx.rotate(t * Math.PI * 3);
      vctx.scale(k, k);
      vctx.filter = `hue-rotate(${(t * 240) | 0}deg) saturate(${(1 + t * 2).toFixed(2)})`;
      vctx.drawImage(old, -W / 2, -H / 2, W, H);
    },
  });

  // Zoom blur: the old picture streaks outward from the centre, a stack
  // of ever-larger ghost copies adding up to a radial blur.
  viz.registerTransition({
    id: 'zoomblur', label: 'Zoom blur',
    draw({ vctx, old, W, H, t }) {
      const COPIES = 7;
      vctx.globalCompositeOperation = 'lighter';
      vctx.translate(W / 2, H / 2);
      for (let i = 0; i < COPIES; i++) {
        const k = 1 + t * 2.4 * (i / (COPIES - 1)) + t * 0.2;
        vctx.save();
        vctx.globalAlpha = (1 - t) * (0.9 / COPIES) * (1.3 - i / COPIES);
        vctx.scale(k, k);
        vctx.drawImage(old, -W / 2, -H / 2, W, H);
        vctx.restore();
      }
    },
  });

  // RGB split: the old picture comes apart into its red, green and
  // blue layers, each drifting off a different way. Where they still
  // overlap the colours add back to the original.
  (function () {
    const layers = [offscreen(), offscreen(), offscreen()];
    const COLORS = ['#f00', '#0f0', '#00f'], ANGLES = [0, 2.1, 4.2];
    viz.registerTransition({
      id: 'rgbsplit', label: 'RGB split',
      draw({ vctx, old, W, H, t, seed }) {
        const dist = Math.hypot(W, H) * 0.35 * t * t;
        vctx.globalCompositeOperation = 'lighter';
        vctx.globalAlpha = 1 - t * t;
        for (let i = 0; i < 3; i++) {
          const { c, ctx: lc } = layers[i](W, H);
          lc.globalCompositeOperation = 'source-over';
          lc.clearRect(0, 0, W, H);
          lc.drawImage(old, 0, 0, W, H);
          lc.globalCompositeOperation = 'multiply';
          lc.fillStyle = COLORS[i]; lc.fillRect(0, 0, W, H);
          const a = ANGLES[i] + seed;
          vctx.drawImage(c, Math.cos(a) * dist, Math.sin(a) * dist);
        }
      },
    });
  })();

  // ══════════════════════════════════════════════════════════════════
  //  VHS -- bad tracking, static, and the blue screen of a tape deck
  // ══════════════════════════════════════════════════════════════════
  const VHS_BLUE = '#0018c8';
  const staticCanvas = offscreen();
  // fresh grey static every call, drawn up to size with no smoothing
  function drawStatic(vctx, W, H, alpha) {
    if (alpha <= 0) return;
    const { c, ctx } = staticCanvas(160, 90);
    const img = ctx.createImageData(160, 90), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    vctx.save();
    vctx.globalAlpha = alpha; vctx.imageSmoothingEnabled = false;
    vctx.drawImage(c, 0, 0, W, H);
    vctx.restore();
  }
  // the deck's on-screen display: mode top-left, counter bottom-left
  function vhsOsd(vctx, W, H, mode, seconds, blink) {
    const fs = Math.max(12, H / 16);
    vctx.save();
    vctx.font = `bold ${fs}px monospace`; vctx.textBaseline = 'top';
    vctx.fillStyle = '#fff'; vctx.shadowColor = '#000'; vctx.shadowBlur = fs * 0.3; vctx.shadowOffsetX = fs * 0.08; vctx.shadowOffsetY = fs * 0.08;
    if (!blink || Math.floor(seconds * 2) % 2 === 0) vctx.fillText(mode, fs, fs);
    const s = Math.max(0, Math.floor(seconds));
    const pad = (n) => String(n).padStart(2, '0');
    vctx.fillText(`SP ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`, fs, H - fs * 2);
    vctx.restore();
  }
  const scanlines = (() => {
    let pat = null;
    return (vctx) => {
      if (!pat) { const c = document.createElement('canvas'); c.width = 1; c.height = 3; const x = c.getContext('2d'); x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(0, 2, 1, 1); pat = vctx.createPattern(c, 'repeat'); }
      return pat;
    };
  })();
  // Tracking bands. A band is a horizontal strip of the picture that has
  // come loose: pushed sideways as a whole (off), sheared top-to-bottom
  // by an amount that swings over time (shear × sin(phase) -- the
  // perspective wobble as it moves), vertically stretched (the strip
  // shows a compressed slice of the source), washed out, and edged with
  // a line of pure noise. Thin ones and thick ones, per the reference.
  // Mostly lines, not slabs: thin strips a few scanlines tall, the odd
  // fatter one. They sit roughly where they are -- a slow drift and a
  // small up-and-down tremble around a home row -- rather than rolling
  // through the frame.
  function makeBand(W, H, rnd) {
    const thick = rnd() < 0.2;
    return {
      y: rnd() * H, y0: 0, h: H * (thick ? 0.035 + rnd() * 0.045 : 0.006 + rnd() * 0.02),
      vy: H * (rnd() - 0.5) * 0.0012, tremble: H * (0.002 + rnd() * 0.008), tphase: rnd() * 6.28,
      off: (rnd() - 0.5) * W * 0.45, shear: (rnd() - 0.5) * W * 0.5, phase: rnd() * 6.28, dphase: 0.05 + rnd() * 0.15,
      stretch: 1.2 + rnd() * 1.8, ttl: 120 + rnd() * 400,
    };
  }
  const chromaA = offscreen(), chromaB = offscreen();
  // magenta and green copies of a picture, for the colour fringing
  function chromaCopies(src, sw, sh) {
    const out = [];
    for (const [holder, color] of [[chromaA, '#f0f'], [chromaB, '#0f0']]) {
      const { c, ctx } = holder(sw, sh);
      ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, sw, sh); ctx.drawImage(src, 0, 0, sw, sh);
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = color; ctx.fillRect(0, 0, sw, sh);
      out.push(c);
    }
    return out;
  }
  function drawTracking(vctx, src, sw, sh, W, H, bands, jitter, frameNo, seed) {
    const n = 96, dh = H / n, ssh = sh / n;
    const [mag, grn] = chromaCopies(src, sw, sh);
    const { c: snow } = staticCanvas(160, 90);
    for (let i = 0; i < n; i++) {
      const y = i * dh;
      let band = null;
      for (const b of bands) if (y >= b.y && y < b.y + b.h) { band = b; break; }
      const j = (hash(i * 7.3 + frameNo * 1.7 + seed) - 0.5) * jitter;
      if (!band) { vctx.drawImage(src, 0, i * ssh, sw, ssh, j, y, W, dh); continue; }
      const u = (y - band.y) / band.h;                                 // 0 top .. 1 bottom of the band
      const edge = u < 0.08 || u > 0.92;
      if (edge) {                                                       // the loose strip's torn edges: noise
        vctx.drawImage(snow, 0, (i * 3) % 88, 160, 2, 0, y, W, dh);
        continue;
      }
      const dx = band.off + band.shear * (u - 0.5) * 2 * Math.sin(band.phase) + j * 4;
      // vertical stretch: this strip shows a compressed run of the source
      const sy = band.y + band.h * (0.5 + (u - 0.5) / band.stretch);
      const srcY = Math.max(0, Math.min(sh - ssh, sy / H * sh));
      vctx.drawImage(src, 0, srcY, sw, ssh, dx, y, W, dh);
      vctx.save();
      vctx.globalCompositeOperation = 'lighter'; vctx.globalAlpha = 0.55;
      const fr = W * 0.02 + Math.abs(band.shear) * 0.15;
      vctx.drawImage(mag, 0, srcY, sw, ssh, dx + fr, y, W, dh);
      vctx.drawImage(grn, 0, srcY, sw, ssh, dx - fr, y, W, dh);
      vctx.restore();
      vctx.fillStyle = `rgba(255,255,255,${(0.12 + 0.18 * (1 - Math.abs(u - 0.5) * 2)).toFixed(2)})`; vctx.fillRect(0, y, W, dh);
    }
  }

  // VHS mode: the video through a worn tape -- loose tracking bands,
  // colour fringing, scanlines, static that thickens with the music,
  // and now and then the deck loses the picture to blue.
  (function () {
    const frame = offscreen();
    let seconds = 0, lastNow = 0, blueUntil = 0, avg = 0, bands = [], frameNo = 0;
    viz.registerMode({
      id: 'vhs', label: 'VHS',
      init() { seconds = 0; lastNow = 0; blueUntil = 0; avg = 0; bands = []; frameNo = 0; },
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, vizRot } = ctx;
        const now = performance.now(); frameNo++;
        if (lastNow) seconds += (now - lastNow) / 1000; lastNow = now;
        const energy = energyOf(freqData), bass = bassOf(freqData);
        avg = avg * 0.95 + energy * 0.05;
        // a hard hit can knock the picture out for a moment
        if (bass > 0.6 && energy > avg * 1.4 && now > blueUntil + 4000 && Math.random() < 0.06) blueUntil = now + 250 + Math.random() * 350;
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        if (!videoFrame || now < blueUntil) {
          vctx.fillStyle = VHS_BLUE; vctx.fillRect(0, 0, VW, VH);
          drawStatic(vctx, VW, VH, 0.05);
          vhsOsd(vctx, VW, VH, videoFrame ? '▶ PLAY' : '■ STOP', seconds, !videoFrame);
          return;
        }
        // bands come and go; the music decides how many are loose at once
        const want = 2 + Math.round(energy * 4 + bass * 2);
        if (bands.length < Math.min(7, want) && Math.random() < 0.08) { const b = makeBand(VW, VH, Math.random); b.y0 = b.y; bands.push(b); }
        for (const b of bands) { b.y0 += b.vy * speed; b.tphase += 0.2 * speed; b.y = b.y0 + Math.sin(b.tphase) * b.tremble; b.phase += b.dphase * speed; b.ttl -= 1; }
        bands = bands.filter(b => b.ttl > 0 && b.y + b.h > 0 && b.y < VH);
        const { w, h, imageData } = videoFrame;
        const { c: fc, ctx: fctx } = frame(w, h);
        fctx.putImageData(imageData, 0, 0);
        const wobble = Math.sin(vizRot * 6) * VH * 0.004 * (1 + energy * 3);
        vctx.save();
        vctx.translate(0, wobble);
        drawTracking(vctx, fc, w, h, VW, VH, bands, VW * 0.01 * (1 + energy * 3), frameNo, 0);
        // a little colour bleed everywhere, not just in the bands
        const [mag, grn] = chromaCopies(fc, w, h);
        const bleed = Math.max(2, VW * 0.005 * (1 + energy));
        vctx.globalCompositeOperation = 'lighter'; vctx.globalAlpha = 0.22;
        vctx.drawImage(mag, bleed, 0, VW, VH); vctx.drawImage(grn, -bleed, 0, VW, VH);
        vctx.restore();
        drawStatic(vctx, VW, VH, 0.05 + 0.25 * energy);
        vctx.fillStyle = scanlines(vctx); vctx.fillRect(0, 0, VW, VH);
        vhsOsd(vctx, VW, VH, '▶ PLAY', seconds, false);
      },
    });
  })();

  // VHS transition: the outgoing picture comes apart in tracking bands
  // and drowns in static, the deck drops to blue with STOP, then PLAY
  // comes back up on the new picture through a last wash of snow.
  viz.registerTransition({
    id: 'vhs', label: 'VHS',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const frameNo = Math.floor(t * 40);
      if (t < 0.6) {
        const k = t / 0.6;
        // bands fixed by the seed, rolling down and fattening as it goes
        const bands = [];
        for (let i = 0; i < 8; i++) {
          const r = (m) => hash(seed + i * 13.7 + m);
          const thick = i % 4 === 0;
          bands.push({
            y: r(1) * H + Math.sin(t * 25 + r(6) * 6.28) * H * 0.01 + k * H * 0.06 * (r(7) - 0.5),
            h: H * (thick ? 0.03 + 0.06 * k : 0.006 + 0.025 * k),
            off: (r(2) - 0.5) * W * (0.2 + 0.7 * k), shear: (r(3) - 0.5) * W * (0.3 + 0.6 * k), phase: r(4) * 6.28 + t * 18,
            stretch: 1.2 + r(5) * 2,
          });
        }
        drawTracking(vctx, old, oldW, oldH, W, H, bands, W * 0.03 * k, frameNo, seed);
        drawStatic(vctx, W, H, 0.08 + 0.6 * k * k);
        vctx.fillStyle = scanlines(vctx); vctx.fillRect(0, 0, W, H);
      } else if (t < 0.82) {
        vctx.fillStyle = VHS_BLUE; vctx.fillRect(0, 0, W, H);
        drawStatic(vctx, W, H, 0.06);
        vhsOsd(vctx, W, H, '■ STOP', 0, false);
      } else {
        const k = (t - 0.82) / 0.18;
        drawStatic(vctx, W, H, 0.7 * (1 - k));
        vhsOsd(vctx, W, H, '▶ PLAY', 0, false);
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════
  //  Win95 -- a lived-in desktop, Windows Media Player, and the trails
  //  a hung window leaves when you drag it
  // ══════════════════════════════════════════════════════════════════
  const W95 = { face: '#c0c0c0', light: '#ffffff', shade: '#808080', dark: '#000000', title1: '#000080', title2: '#1084d0', bsod: '#0000aa' };
  // a raised 3D box, the one shape every Win95 control is made of
  function bevel(ctx, x, y, w, h, sunken) {
    ctx.fillStyle = W95.face; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = sunken ? W95.shade : W95.light; ctx.fillRect(x, y, w - 1, 1); ctx.fillRect(x, y, 1, h - 1);
    ctx.fillStyle = sunken ? W95.light : W95.shade; ctx.fillRect(x + 1, y + h - 2, w - 2, 1); ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
    if (!sunken) { ctx.fillStyle = W95.dark; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h); }
  }
  function titleBar(ctx, x, y, w, h, text, fs, inactive) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, inactive ? '#808080' : W95.title1); g.addColorStop(1, inactive ? '#b5b5b5' : W95.title2);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = inactive ? '#d4d4d4' : '#fff'; ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, x + fs * 0.5, y + h / 2);
    const b = h - 4; let bx = x + w - 2 - b;
    for (const glyph of ['×', '□', '_']) {
      bevel(ctx, bx, y + 2, b, b);
      ctx.fillStyle = '#000'; ctx.font = `bold ${fs * 0.9}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(glyph, bx + b / 2, y + 2 + b / 2 - (glyph === '_' ? b * 0.15 : 0));
      ctx.textAlign = 'left';
      bx -= b + (glyph === '×' ? 2 : 0);
    }
  }
  function menuBar(ctx, x, y, w, fs, items) {
    ctx.fillStyle = W95.face; ctx.fillRect(x, y, w, fs * 1.5);
    ctx.fillStyle = '#000'; ctx.font = `${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let mx = x + fs * 0.6;
    for (const it of items) { ctx.fillText(it, mx, y + fs * 0.75); mx += ctx.measureText(it).width + fs * 1.1; }
    return y + fs * 1.5;
  }
  // a whole window: frame, title, optional menu; returns the client rect
  function win95Window(ctx, x, y, w, h, title, fs, menu, inactive) {
    bevel(ctx, x, y, w, h);
    titleBar(ctx, x + 3, y + 3, w - 6, fs * 1.5, title, fs, inactive);
    let cy = y + 3 + fs * 1.5;
    if (menu) cy = menuBar(ctx, x + 3, cy, w - 6, fs, menu);
    return { x: x + 3, y: cy, w: w - 6, h: y + h - 3 - cy };
  }
  // small desktop icons drawn from primitives -- no image assets
  function drawIcon(ctx, kind, x, y, s) {
    switch (kind) {
      case 'folder':
        ctx.fillStyle = '#e8c53a'; ctx.fillRect(x, y + s * 0.2, s, s * 0.7); ctx.fillRect(x, y + s * 0.08, s * 0.45, s * 0.15);
        ctx.fillStyle = '#fff3a0'; ctx.fillRect(x + s * 0.05, y + s * 0.3, s * 0.9, s * 0.05); break;
      case 'doc':
        ctx.fillStyle = '#fff'; ctx.fillRect(x + s * 0.15, y, s * 0.7, s);
        ctx.fillStyle = '#888'; ctx.fillRect(x + s * 0.15, y, s * 0.7, 1); ctx.fillRect(x + s * 0.15, y, 1, s); ctx.fillRect(x + s * 0.84, y, 1, s); ctx.fillRect(x + s * 0.15, y + s - 1, s * 0.7, 1);
        ctx.fillStyle = '#446'; for (let i = 0; i < 4; i++) ctx.fillRect(x + s * 0.25, y + s * (0.25 + i * 0.16), s * 0.5, s * 0.05); break;
      case 'exe':
        bevel(ctx, x, y + s * 0.1, s, s * 0.8); ctx.fillStyle = W95.title1; ctx.fillRect(x + 2, y + s * 0.1 + 2, s - 4, s * 0.18); break;
      case 'computer':
        ctx.fillStyle = '#d9d0b8'; ctx.fillRect(x, y, s, s * 0.75); ctx.fillStyle = '#000'; ctx.fillRect(x + s * 0.12, y + s * 0.1, s * 0.76, s * 0.5);
        ctx.fillStyle = '#4a8'; ctx.fillRect(x + s * 0.18, y + s * 0.16, s * 0.64, s * 0.38); ctx.fillStyle = '#d9d0b8'; ctx.fillRect(x + s * 0.3, y + s * 0.78, s * 0.4, s * 0.2); break;
      case 'bin':
        ctx.fillStyle = '#9fb7c8'; ctx.beginPath(); ctx.moveTo(x + s * 0.15, y + s * 0.2); ctx.lineTo(x + s * 0.85, y + s * 0.2); ctx.lineTo(x + s * 0.75, y + s); ctx.lineTo(x + s * 0.25, y + s); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#6f8fa3'; ctx.fillRect(x + s * 0.1, y + s * 0.12, s * 0.8, s * 0.1); ctx.fillStyle = '#fff'; ctx.fillRect(x + s * 0.4, y + s * 0.35, s * 0.2, s * 0.35); break;
      case 'ie':
        ctx.fillStyle = '#2a6fd6'; ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.45, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${s * 0.7}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('e', x + s / 2, y + s * 0.55); ctx.textAlign = 'left'; break;
      case 'network':
        ctx.fillStyle = '#d9d0b8'; ctx.fillRect(x, y + s * 0.3, s * 0.45, s * 0.4); ctx.fillRect(x + s * 0.55, y, s * 0.45, s * 0.4);
        ctx.fillStyle = '#000'; ctx.fillRect(x + s * 0.05, y + s * 0.35, s * 0.35, s * 0.25); ctx.fillRect(x + s * 0.6, y + s * 0.05, s * 0.35, s * 0.25);
        ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x + s * 0.22, y + s * 0.75); ctx.lineTo(x + s * 0.22, y + s * 0.9); ctx.lineTo(x + s * 0.78, y + s * 0.9); ctx.lineTo(x + s * 0.78, y + s * 0.45); ctx.stroke(); break;
    }
  }
  const DESKTOP_ICONS = [
    ['My Computer', 'computer'], ['Network Neighborhood', 'network'], ['Recycle Bin', 'bin'], ['My Documents', 'folder'],
    ['The Internet', 'ie'], ['New Folder (2)', 'folder'], ['resume_final_v3.doc', 'doc'], ['party mix.m3u', 'doc'],
    ['DOOM', 'exe'], ['setup.exe', 'exe'], ['untitled.txt', 'doc'], ['taxes 1996', 'folder'], ['weed.txt', 'doc'], ['WINZIP', 'exe'],
  ];
  // the whole static backdrop -- wallpaper, icons, the other windows
  // someone left open -- painted once per canvas size and reused
  const desktopCache = offscreen(); let desktopKey = '';
  function desktop(W, H, fs) {
    const key = W + 'x' + H + ':' + fs;
    const { c, ctx } = desktopCache(W, H);
    if (desktopKey === key) return c;
    desktopKey = key;
    // Clouds.bmp, more or less: blue sky, soft white blobs
    const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#2f6fc9'); sky.addColorStop(1, '#8fc1ef');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    const small = document.createElement('canvas'); small.width = 64; small.height = 36; const sc = small.getContext('2d');
    for (let i = 0; i < 40; i++) {
      const r = 3 + hash(i * 3.1) * 9;
      sc.fillStyle = `rgba(255,255,255,${(0.35 + hash(i * 5.3) * 0.5).toFixed(2)})`;
      sc.beginPath(); sc.ellipse(hash(i * 1.7) * 64, hash(i * 2.9) * 36, r * 1.6, r, 0, 0, Math.PI * 2); sc.fill();
    }
    ctx.save(); ctx.filter = `blur(${Math.max(4, W / 90)}px)`; ctx.globalAlpha = 0.85; ctx.drawImage(small, 0, 0, W, H); ctx.restore();
    // desktop icons down the left, two columns -- painted before the
    // windows, which sit on top of them like they would on a real desktop
    const s = fs * 2.2, colW = fs * 9.5;
    DESKTOP_ICONS.forEach(([name, kind], i) => {
      const col = Math.floor(i / 7), row = i % 7;
      const ix = fs * 1.4 + col * colW, iy = fs * 1 + row * (H - fs * 4) / 7;
      drawIcon(ctx, kind, ix, iy, s);
      // the font is set per label: an icon (the 'e') changes it
      ctx.font = `${fs * 0.85}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      let label = name;
      while (label.length > 3 && ctx.measureText(label).width > colW - fs * 0.8) label = label.slice(0, -2).replace(/…$/, '') + '…';
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(label, ix + s / 2 + 1, iy + s + fs * 0.35 + 1);
      ctx.fillStyle = '#fff'; ctx.fillText(label, ix + s / 2, iy + s + fs * 0.35);
    });
    ctx.textAlign = 'left';
    // the windows left open underneath, oldest first
    const nb = win95Window(ctx, W * 0.42, H * 0.06, W * 0.5, H * 0.5, 'untitled - Notepad', fs, ['File', 'Edit', 'Search', 'Help'], true);
    ctx.fillStyle = '#fff'; ctx.fillRect(nb.x, nb.y, nb.w, nb.h);
    ctx.fillStyle = '#000'; ctx.font = `${fs}px monospace`; ctx.textBaseline = 'top';
    ['party tonight -- do NOT let dave touch the playlist', '', 'todo:', '  - defrag', '  - burn the mix to a cd-r for the car',
     '  - fix the tracking on the vcr (again)', '  - return doom to jeremy', '', 'dear diary: the bass hit and explorer.exe', 'crashed. twice. i regret nothing.'].forEach((l, i) => ctx.fillText(l, nb.x + fs * 0.4, nb.y + fs * 0.3 + i * fs * 1.3));
    const ex = win95Window(ctx, W * 0.04, H * 0.34, W * 0.42, H * 0.44, 'Exploring - C:\\WINDOWS\\Desktop', fs, ['File', 'Edit', 'View', 'Tools', 'Help'], true);
    bevel(ctx, ex.x, ex.y, ex.w, fs * 1.8); ctx.fillStyle = '#000'; ctx.font = `${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.fillText('Address  C:\\WINDOWS\\Desktop', ex.x + fs * 0.5, ex.y + fs * 0.9);
    ctx.fillStyle = '#fff'; ctx.fillRect(ex.x, ex.y + fs * 1.8, ex.w, ex.h - fs * 1.8);
    ctx.fillStyle = '#000'; ctx.font = `${fs * 0.9}px sans-serif`;
    DESKTOP_ICONS.slice(5).forEach(([name, kind], i) => { const yy = ex.y + fs * 2.2 + i * fs * 1.35; drawIcon(ctx, kind, ex.x + fs * 0.4, yy, fs * 0.9); ctx.fillText(name, ex.x + fs * 1.7, yy + fs * 0.45); });
    const dos = win95Window(ctx, W * 0.5, H * 0.5, W * 0.46, H * 0.34, 'MS-DOS Prompt', fs, null, true);
    ctx.fillStyle = '#000'; ctx.fillRect(dos.x, dos.y, dos.w, dos.h);
    ctx.fillStyle = '#c0c0c0'; ctx.font = `${fs}px monospace`; ctx.textBaseline = 'top';
    ['Microsoft(R) Windows 95', '   (C)Copyright Microsoft Corp 1981-1996.', '', 'C:\\WINDOWS>cd ..', 'C:\\>dir /w *.avi', ' WEED.AVI      PARTY~1.AVI   TRACKING.AVI',
     '         3 file(s)    412,208,344 bytes', 'C:\\>weed.avi', 'Bad command or file name', 'C:\\>_'].forEach((l, i) => ctx.fillText(l, dos.x + fs * 0.3, dos.y + fs * 0.2 + i * fs * 1.25));
    ctx.textAlign = 'left';
    return c;
  }
  function startBar(ctx, W, H, fs, tasks) {
    const bh = fs * 2.2, y = H - bh;
    bevel(ctx, -2, y, W + 4, bh + 2);
    const sw = fs * 4.2, sx = 2, sy = y + 3, sh = bh - 6;
    bevel(ctx, sx, sy, sw, sh);
    const px = sx + fs * 0.4, py = sy + sh / 2 - fs * 0.45, ps = fs * 0.42;
    for (const [i, col] of ['#f00', '#0a0', '#00f', '#ff0'].entries()) ctx.fillStyle = col, ctx.fillRect(px + (i % 2) * (ps + 1), py + Math.floor(i / 2) * (ps + 1), ps, ps);
    ctx.fillStyle = '#000'; ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText('Start', px + ps * 2 + fs * 0.4, sy + sh / 2);
    // the clock well, with a speaker beside it
    const d = new Date(); let hr = d.getHours(); const ampm = hr >= 12 ? 'PM' : 'AM'; hr = hr % 12 || 12;
    const clock = `${hr}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
    ctx.font = `${fs * 0.9}px sans-serif`;
    const cw = ctx.measureText(clock).width + fs * 2.4;
    bevel(ctx, W - cw - 4, sy, cw, sh, true);
    ctx.fillStyle = '#000'; ctx.textAlign = 'right'; ctx.fillText(clock, W - fs * 0.6, sy + sh / 2); ctx.textAlign = 'left';
    ctx.fillStyle = '#555'; ctx.fillRect(W - cw + fs * 0.3, sy + sh / 2 - fs * 0.2, fs * 0.3, fs * 0.4);
    ctx.beginPath(); ctx.moveTo(W - cw + fs * 0.6, sy + sh / 2 - fs * 0.2); ctx.lineTo(W - cw + fs * 0.95, sy + sh / 2 - fs * 0.5); ctx.lineTo(W - cw + fs * 0.95, sy + sh / 2 + fs * 0.5); ctx.lineTo(W - cw + fs * 0.6, sy + sh / 2 + fs * 0.2); ctx.closePath(); ctx.fill();
    // one task button per open window, the active one pressed in
    const avail = W - cw - 8 - (sx + sw + 6), tw = Math.min(fs * 11, avail / tasks.length - 3);
    ctx.font = `${fs * 0.9}px sans-serif`;
    tasks.forEach(([label, active], i) => {
      const tx = sx + sw + 6 + i * (tw + 3);
      bevel(ctx, tx, sy, tw, sh, active);
      if (active) { ctx.fillStyle = '#dcdcdc'; ctx.fillRect(tx + 2, sy + 2, tw - 4, sh - 4); }
      ctx.fillStyle = '#000'; ctx.font = `${active ? 'bold ' : ''}${fs * 0.9}px sans-serif`;
      ctx.save(); ctx.beginPath(); ctx.rect(tx + 2, sy, tw - 6, sh); ctx.clip(); ctx.fillText(label, tx + fs * 0.5, sy + sh / 2); ctx.restore();
    });
  }
  function errorDialog(ctx, x, y, w, fs, title, lines) {
    const th = fs * 1.5, lh = fs * 1.35, h = th + 8 + lines.length * lh + fs * 3;
    bevel(ctx, x, y, w, h);
    titleBar(ctx, x + 3, y + 3, w - 6, th, title, fs);
    ctx.fillStyle = '#c00'; ctx.beginPath(); ctx.arc(x + fs * 1.6, y + th + fs * 1.6, fs * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = fs * 0.18; ctx.beginPath();
    ctx.moveTo(x + fs * 1.15, y + th + fs * 1.15); ctx.lineTo(x + fs * 2.05, y + th + fs * 2.05); ctx.moveTo(x + fs * 2.05, y + th + fs * 1.15); ctx.lineTo(x + fs * 1.15, y + th + fs * 2.05); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = `${fs}px sans-serif`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, x + fs * 3, y + th + 8 + i * lh));
    const bw = fs * 5, bx = x + w / 2 - bw / 2, by = y + h - fs * 2.4;
    bevel(ctx, bx, by, bw, fs * 1.8);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('OK', bx + bw / 2, by + fs * 0.9); ctx.textAlign = 'left';
    return h;
  }
  // Windows Media Player, the old one: menu, picture, seek bar,
  // transport buttons, status line with the clock
  function mediaPlayer(ctx, x, y, ww, fs, frameCanvas, seconds) {
    const vw = ww - 8, vh = Math.round(vw * 0.5625);
    const wh = 3 + fs * 1.5 + fs * 1.5 + 2 + vh + fs * 1.2 + fs * 2.4 + fs * 1.5 + 3;
    const cl = win95Window(ctx, x, y, ww, wh, 'weed.avi - Windows Media Player', fs, ['File', 'View', 'Play', 'Favorites', 'Go', 'Help']);
    const vx = cl.x + 1, vy = cl.y + 2;
    ctx.fillStyle = '#000'; ctx.fillRect(vx, vy, vw, vh);
    if (frameCanvas) ctx.drawImage(frameCanvas, vx, vy, vw, vh);
    // seek bar
    const total = 223, pos = seconds % total, sy = vy + vh + fs * 0.4;
    bevel(ctx, vx + fs * 0.5, sy, vw - fs, fs * 0.5, true);
    bevel(ctx, vx + fs * 0.5 + (vw - fs * 1.6) * (pos / total), sy - fs * 0.25, fs * 0.6, fs);
    // transport row: ▶ ‖ ■ | ⏮ ◀◀ ▶▶ ⏭ | speaker + volume
    const by = sy + fs * 1.1, bs = fs * 1.7; let bx = vx + fs * 0.5;
    ctx.fillStyle = '#000'; ctx.font = `${fs * 0.85}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const g of ['▶', '❚❚', '■', '', '⏮', '◀◀', '▶▶', '⏭']) {
      if (g === '') { ctx.fillStyle = W95.shade; ctx.fillRect(bx + fs * 0.3, by + 2, 1, bs - 4); ctx.fillStyle = W95.light; ctx.fillRect(bx + fs * 0.3 + 1, by + 2, 1, bs - 4); bx += fs * 0.8; continue; }
      bevel(ctx, bx, by, bs, bs, g === '▶');
      ctx.fillStyle = '#000'; ctx.fillText(g, bx + bs / 2, by + bs / 2);
      bx += bs + 2;
    }
    const volX = vx + vw - fs * 6.5;
    ctx.fillStyle = '#000'; ctx.fillRect(volX, by + bs * 0.35, fs * 0.35, bs * 0.3);
    ctx.beginPath(); ctx.moveTo(volX + fs * 0.35, by + bs * 0.35); ctx.lineTo(volX + fs * 0.8, by + bs * 0.05); ctx.lineTo(volX + fs * 0.8, by + bs * 0.95); ctx.lineTo(volX + fs * 0.35, by + bs * 0.65); ctx.closePath(); ctx.fill();
    bevel(ctx, volX + fs * 1.2, by + bs / 2 - 2, fs * 4.8, 4, true);
    bevel(ctx, volX + fs * 1.2 + fs * 3.4, by + bs / 2 - fs * 0.5, fs * 0.6, fs);
    // status bar
    const st = by + bs + fs * 0.4;
    bevel(ctx, cl.x, st, cl.w * 0.55, fs * 1.3, true); bevel(ctx, cl.x + cl.w * 0.55 + 2, st, cl.w * 0.45 - 2, fs * 1.3, true);
    const pad = (n) => String(n).padStart(2, '0');
    ctx.fillStyle = '#000'; ctx.font = `${fs * 0.9}px sans-serif`; ctx.textAlign = 'left';
    ctx.fillText('Playing', cl.x + fs * 0.5, st + fs * 0.65);
    ctx.textAlign = 'right'; ctx.fillText(`${pad(Math.floor(pos / 60))}:${pad(Math.floor(pos) % 60)} / 03:43`, cl.x + cl.w - fs * 0.5, st + fs * 0.65); ctx.textAlign = 'left';
    return wh;
  }
  const W95_TASKS = [['Exploring - C:\\WINDOWS\\Desktop', false], ['untitled - Notepad', false], ['MS-DOS Prompt', false], ['weed.avi - Windows Media...', true]];

  // Win95 mode: the video plays in Windows Media Player, drifting over a
  // desktop someone actually used -- Clouds wallpaper, a pile of files,
  // Notepad, Explorer and a DOS prompt left open. When the bass hits,
  // the desktop stops repainting and the player smears the way a hung
  // window did under a drag; big hits throw an illegal-operation box.
  (function () {
    const frame = offscreen();
    let win = null, dialogs = [], avg = 0, cooldown = 0, seconds = 0, lastNow = 0;
    let avgBass = 0, smearUntil = 0, lastRepaint = 0, frameNo = 0;
    // Clippy. Drops in a few seconds after the mode opens and then every
    // half minute or so, offers help nobody asked for, hangs around for
    // eight seconds, slides off. Eyebrows ride the bass.
    const CLIPPY_LINES = [
      ['It looks like you\'re trying to VJ.', 'Would you like help?'],
      ['It looks like you\'re dropping the bass.', 'Would you like me to call someone?'],
      ['It looks like you\'re writing a setlist.', 'Would you like to use the Setlist Wizard?'],
      ['I see the Reactivity slider is at 3.', 'That\'s a bold choice.'],
      ['It looks like this song has no video.', 'Have you tried Video Swap?'],
      ['Tip: pressing the lit mode button', 'turns the effects off.'],
      ['It looks like it\'s 2 AM.', 'Would you like help going to bed?'],
    ];
    let clippy = null, clippyNext = 0, clippyCount = 0;
    function drawClippy(ctx, x, y, s, blink, browLift, t) {
      // a paperclip: two nested loops in grey wire, eyes and eyebrows
      ctx.save();
      ctx.translate(x, y);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const wire = (w, col) => { ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath();
        ctx.moveTo(-s * 0.32, s * 0.5); ctx.lineTo(-s * 0.32, -s * 0.55); ctx.arc(0, -s * 0.55, s * 0.32, Math.PI, 0);
        ctx.lineTo(s * 0.32, s * 0.7); ctx.arc(0.02 * s, s * 0.7, s * 0.3, 0, Math.PI);
        ctx.lineTo(-s * 0.28, -s * 0.2); ctx.arc(0, -s * 0.2, s * 0.28, Math.PI, 0);
        ctx.lineTo(s * 0.28, s * 0.35);
        ctx.stroke(); };
      wire(s * 0.13, '#6f6f7c'); wire(s * 0.08, '#d5d5e0'); wire(s * 0.03, '#ffffff');
      // eyes
      for (const ex of [-s * 0.13, s * 0.13]) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = s * 0.02;
        ctx.beginPath(); ctx.ellipse(ex, -s * 0.55, s * 0.11, blink ? s * 0.015 : s * 0.15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (!blink) { ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(ex + Math.sin(t) * s * 0.03, -s * 0.52, s * 0.05, s * 0.07, 0, 0, Math.PI * 2); ctx.fill(); }
        // eyebrow
        ctx.strokeStyle = '#000'; ctx.lineWidth = s * 0.05; ctx.beginPath();
        ctx.moveTo(ex - s * 0.1, -s * 0.75 - browLift); ctx.quadraticCurveTo(ex, -s * 0.85 - browLift * 1.4, ex + s * 0.1, -s * 0.75 - browLift);
        ctx.stroke();
      }
      ctx.restore();
    }
    function drawBubble(ctx, x, y, w, fs, lines, tailX, tailY) {
      const lh = fs * 1.35, h = lines.length * lh + fs * 1.2 + fs * 3.9;
      ctx.save();
      ctx.fillStyle = '#ffffcc'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, fs * 0.5); ctx.fill(); ctx.stroke();
      // the tail
      ctx.beginPath(); ctx.moveTo(x + w - fs * 2.4, y + h); ctx.lineTo(tailX, tailY); ctx.lineTo(x + w - fs * 1.2, y + h); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x + w - fs * 2.4, y + h); ctx.lineTo(tailX, tailY); ctx.lineTo(x + w - fs * 1.2, y + h); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = `${fs}px sans-serif`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, x + fs * 0.8, y + fs * 0.6 + i * lh));
      const oy = y + fs * 0.6 + lines.length * lh + fs * 0.4;
      [['●', 'Get help with VJing'], ['○', 'Just do it myself'], ['○', 'Don\'t show me this tip again']].forEach(([b, l], i) => {
        ctx.fillStyle = i === 0 ? '#000' : '#333'; ctx.fillText(b + '  ' + l, x + fs * 0.8, oy + i * fs * 1.15);
      });
      ctx.restore();
      return h;
    }
    viz.registerMode({
      id: 'win95', label: 'Win95',
      init() { win = null; dialogs = []; avg = 0; cooldown = 0; seconds = 0; lastNow = 0; avgBass = 0; smearUntil = 0; lastRepaint = 0; frameNo = 0; clippy = null; clippyNext = 4; clippyCount = 0; },
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, vizUserScale } = ctx;
        const fs = Math.max(10, Math.round(VH / 40));
        const now = performance.now(); if (lastNow) seconds += (now - lastNow) / 1000; lastNow = now;
        const energy = energyOf(freqData), bass = bassOf(freqData);
        avg = avg * 0.95 + energy * 0.05; cooldown = Math.max(0, cooldown - 1);
        avgBass = avgBass * 0.9 + bass * 0.1; frameNo++;
        const ww = Math.round(Math.min(VW * 0.9, VW * 0.42 * vizUserScale));
        const wh = 3 + fs * 3 + 2 + Math.round((ww - 8) * 0.5625) + fs * 5.1 + 3;
        const barH = fs * 2.2;
        if (!win) win = { x: VW * 0.25, y: VH * 0.15, vx: 1.1, vy: 0.9 };
        win.x += win.vx * speed * (1 + energy * 2); win.y += win.vy * speed * (1 + energy * 2);
        if (win.x < 0 || win.x + ww > VW) { win.vx *= -1; win.x = Math.max(0, Math.min(VW - ww, win.x)); }
        if (win.y < 0 || win.y + wh > VH - barH) { win.vy *= -1; win.y = Math.max(0, Math.min(VH - barH - wh, win.y)); }
        // The desktop stops repainting for a moment on a kick -- a bass
        // *transient*, judged against its own running average, not an
        // absolute level (real music sits above any fixed bass threshold
        // most of the time, which left the desktop never repainting and
        // the whole picture buried under smeared window frames). Each
        // hit buys ~12 frames of smear; never more than 40 frames go by
        // without a full repaint, whatever the music does.
        if (bass > avgBass * 1.35 + 0.06 && frameNo > smearUntil) smearUntil = frameNo + 12;
        const smearing = frameNo < smearUntil && frameNo - lastRepaint < 40;
        if (!smearing) { vctx.drawImage(desktop(VW, VH, fs), 0, 0); lastRepaint = frameNo; }
        let fc = null;
        if (videoFrame) { const f = frame(videoFrame.w, videoFrame.h); f.ctx.putImageData(videoFrame.imageData, 0, 0); fc = f.c; }
        mediaPlayer(vctx, Math.round(win.x), Math.round(win.y), ww, fs, fc, seconds);
        if (energy > avg * 1.3 + 0.05 && cooldown === 0 && dialogs.length < 5) {
          dialogs.push({ x: Math.random() * (VW - fs * 22), y: Math.random() * (VH - fs * 12), ttl: 110 });
          cooldown = 25;
        }
        for (let i = dialogs.length - 1; i >= 0; i--) {
          const d = dialogs[i]; if (--d.ttl <= 0) { dialogs.splice(i, 1); continue; }
          errorDialog(vctx, d.x, d.y, fs * 22, fs, 'Mplayer2', ['This program has performed an illegal', 'operation and will be shut down.', '', 'If the problem persists, contact the', 'program vendor.']);
        }
        // Clippy: in from the right, a bubble above, out again
        if (!clippy && seconds >= clippyNext) {
          clippy = { t0: seconds, lines: CLIPPY_LINES[clippyCount++ % CLIPPY_LINES.length], blinkAt: seconds + 1 + Math.random() * 3 };
          clippyNext = seconds + 8 + 25 + Math.random() * 20;
        }
        if (clippy) {
          const age = seconds - clippy.t0, IN = 0.5, STAY = 8, OUT = 0.5;
          if (age > IN + STAY + OUT) clippy = null;
          else {
            const k = age < IN ? age / IN : age > IN + STAY ? 1 - (age - IN - STAY) / OUT : 1;
            const ease = k * k * (3 - 2 * k);
            const size = Math.max(40, VH * 0.16);
            const cxp = VW - size * 0.9 + (1 - ease) * size * 2, cyp = VH - barH - size * 0.75 + Math.sin(seconds * 2) * size * 0.03;
            const blink = seconds > clippy.blinkAt && seconds < clippy.blinkAt + 0.15;
            if (seconds > clippy.blinkAt + 0.15) clippy.blinkAt = seconds + 2 + Math.random() * 3;
            if (ease > 0.95) {
              const bw = Math.min(VW * 0.5, fs * 22), bx = cxp - size * 0.6 - bw, by = cyp - size * 1.9;
              drawBubble(vctx, bx, by, bw, fs, clippy.lines, cxp - size * 0.3, cyp - size * 0.7);
            }
            drawClippy(vctx, cxp, cyp, size, blink, bass * size * 0.12, seconds * 1.7);
          }
        }
        startBar(vctx, VW, VH, fs, W95_TASKS);
      },
    });
  })();

  // Win95 transition: the outgoing picture is a hung window being
  // dragged, leaving a stack of itself behind, until the whole machine
  // gives up: blue screen, fatal exception, press any key. Then black,
  // and the new picture fades up.
  viz.registerTransition({
    id: 'win95', label: 'Win95',
    // a crash deserves to be read: three times the Fade slider
    duration: 3,
    draw({ vctx, old, W, H, t, seed }) {
      const fs = Math.max(10, Math.round(H / 30));
      if (t < 0.4) {
        const k = t / 0.4, steps = 14, dxTotal = W * 0.35, dyTotal = H * 0.3;
        for (let i = 0; i <= steps * k; i++) {
          const f = i / steps;
          vctx.drawImage(old, dxTotal * f * (hash(seed) > 0.5 ? 1 : -1), dyTotal * f, W, H);
        }
      } else if (t < 0.85) {
        vctx.fillStyle = W95.bsod; vctx.fillRect(0, 0, W, H);
        const cfs = Math.max(9, Math.round(H / 27));
        vctx.font = `${cfs}px monospace`; vctx.textBaseline = 'top'; vctx.textAlign = 'left';
        const lines = [
          'A fatal exception 0E has occurred at 0028:C0011E36 in VXD VMM(01) +',
          '00010E36. The current application will be terminated.',
          '',
          '*  Press any key to terminate the current application.',
          '*  Press CTRL+ALT+DEL again to restart your computer. You will',
          '   lose any unsaved information in all applications.',
          '',
          '                     Press any key to continue ' + (Math.floor(t * 12) % 2 ? '_' : ' '),
        ];
        const x0 = cfs * 2, y0 = H * 0.3;
        const label = ' Windows ';
        const lw = vctx.measureText(label).width;
        vctx.fillStyle = '#aaa'; vctx.fillRect(W / 2 - lw / 2, y0 - cfs * 2.2, lw, cfs * 1.2);
        vctx.fillStyle = W95.bsod; vctx.fillText(label, W / 2 - lw / 2, y0 - cfs * 2.1);
        vctx.fillStyle = '#fff';
        lines.forEach((l, i) => vctx.fillText(l, x0, y0 + i * cfs * 1.35));
      } else {
        // the reboot: black, then the new picture fades up
        vctx.globalAlpha = 1 - (t - 0.85) / 0.15;
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, W, H);
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════
  //  MORE MODES
  // ══════════════════════════════════════════════════════════════════

  // Spectrogram: a waterfall -- each frame's spectrum is one column,
  // scrolling left, on an inferno-style ramp (black, plum, crimson,
  // orange, cream) with a slow hue drift. Low end at the bottom.
  (function () {
    const strip = offscreen();
    // 256-entry ramp from a few control points, rebuilt when the hue drifts
    const STOPS = [[0, 0, 4], [40, 11, 84], [120, 28, 109], [190, 55, 84], [237, 105, 37], [251, 160, 25], [252, 220, 90], [252, 254, 190]];
    let lut = null, lutHue = -1;
    function ramp(hueShift) {
      const key = Math.round(hueShift / 12);
      if (lut && key === lutHue) return lut;
      lutHue = key; lut = new Uint8ClampedArray(256 * 3);
      const rot = (key * 12) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
      for (let i = 0; i < 256; i++) {
        const f = (i / 255) * (STOPS.length - 1), k = Math.min(STOPS.length - 2, Math.floor(f)), t = f - k;
        let [r, g, b] = [0, 1, 2].map(c => STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * t);
        // a small hue rotation around the grey axis (YIQ-style), so the
        // ramp drifts with the rest of the app without losing its shape
        const Y = 0.299 * r + 0.587 * g + 0.114 * b, I = 0.596 * r - 0.274 * g - 0.322 * b, Q = 0.211 * r - 0.523 * g + 0.312 * b;
        const I2 = I * cr - Q * sr, Q2 = I * sr + Q * cr;
        r = Y + 0.956 * I2 + 0.621 * Q2; g = Y - 0.272 * I2 - 0.647 * Q2; b = Y - 1.106 * I2 + 1.703 * Q2;
        lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
      }
      return lut;
    }
    viz.registerMode({
      id: 'spectrogram', label: 'Spectrogram',
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, speed, vizUserScale } = ctx;
        const SW = 256, SH = 128, { c, ctx: sc } = strip(SW, SH);
        const step = Math.max(1, Math.round(speed));
        sc.drawImage(c, -step, 0);
        const maxBin = Math.floor(freqData.length * 0.7);
        const L = ramp(hueBase * 0.25);
        const col = sc.createImageData(step, SH), d = col.data;
        for (let y = 0; y < SH; y++) {
          const k = 1 - y / (SH - 1);
          const v = freqData[Math.floor(Math.pow(k, 1.6) * maxBin)] / 255;
          const idx = Math.min(255, Math.round(Math.pow(v, 0.8) * 255)) * 3;
          for (let i = 0; i < step; i++) { const o = (y * step + i) * 4; d[o] = L[idx]; d[o + 1] = L[idx + 1]; d[o + 2] = L[idx + 2]; d[o + 3] = 255; }
        }
        sc.putImageData(col, SW - step, 0);
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        vctx.imageSmoothingEnabled = true;
        const w = VW * vizUserScale, h = VH * vizUserScale;
        vctx.drawImage(c, (VW - w) / 2, (VH - h) / 2, w, h);
      },
    });
  })();

  // Stained glass: the picture as a Voronoi mosaic -- a few dozen seeds,
  // each cell filled with the colour under its seed and leaded with a
  // dark edge. The seeds tremble with the bass and drift with Speed.
  (function () {
    let seeds = [];
    const cellsOff = offscreen();
    viz.registerMode({
      id: 'stainedglass', label: 'Stained glass',
      init() { seeds = []; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale, vizRot } = ctx;
        const N = Math.max(12, Math.round(70 / vizUserScale));
        if (seeds.length !== N) seeds = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), dx: (Math.random() - 0.5) * 0.0015, dy: (Math.random() - 0.5) * 0.0015 }));
        const bass = bassOf(freqData);
        for (const p of seeds) {
          p.x = (p.x + p.dx * speed + 1) % 1; p.y = (p.y + p.dy * speed + 1) % 1;
        }
        // nearest-seed on a coarse grid, then upscaled: cheap and it
        // gives the glass its slightly chunky edges
        const GW = 96, GH = 54, { c, ctx: gc } = cellsOff(GW, GH);
        const img = gc.createImageData(GW, GH), d = img.data;
        const jitter = bass * 0.03;
        const sx = seeds.map((p, i) => p.x + Math.sin(vizRot * 3 + i) * jitter), sy = seeds.map((p, i) => p.y + Math.cos(vizRot * 2.3 + i * 1.7) * jitter);
        const cols = seeds.map((p, i) => {
          if (videoFrame) {
            const px = Math.min(videoFrame.w - 1, (sx[i] * videoFrame.w) | 0), py = Math.min(videoFrame.h - 1, (sy[i] * videoFrame.h) | 0);
            const o = (Math.max(0, py) * videoFrame.w + Math.max(0, px)) * 4, vd = videoFrame.imageData.data;
            return [vd[o], vd[o + 1], vd[o + 2]];
          }
          const h = (hueBase + i * 37) % 360, l = 0.45 + 0.2 * Math.sin(i + vizRot);
          const a = l * 255; return [a * (0.6 + 0.4 * Math.cos(h / 57)), a * (0.6 + 0.4 * Math.cos(h / 57 - 2.1)), a * (0.6 + 0.4 * Math.cos(h / 57 - 4.2))];
        });
        const owner = new Int16Array(GW * GH);
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
          const fx = x / GW, fy = y / GH; let best = 0, bd = 9;
          for (let i = 0; i < N; i++) { const ddx = fx - sx[i], ddy = (fy - sy[i]) * 0.5625; const dd = ddx * ddx + ddy * ddy; if (dd < bd) { bd = dd; best = i; } }
          owner[y * GW + x] = best;
          const o = (y * GW + x) * 4, cc = cols[best];
          d[o] = cc[0]; d[o + 1] = cc[1]; d[o + 2] = cc[2]; d[o + 3] = 255;
        }
        // the leading: darken any cell pixel whose neighbour belongs to another seed
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
          const i = y * GW + x;
          if ((x < GW - 1 && owner[i + 1] !== owner[i]) || (y < GH - 1 && owner[i + GW] !== owner[i])) { const o = i * 4; d[o] *= 0.15; d[o + 1] *= 0.15; d[o + 2] *= 0.15; }
        }
        gc.putImageData(img, 0, 0);
        vctx.imageSmoothingEnabled = false;
        vctx.drawImage(c, 0, 0, VW, VH);
        vctx.imageSmoothingEnabled = true;
        // a glow across the glass
        vctx.globalCompositeOperation = 'lighter';
        const g = vctx.createRadialGradient(VW * 0.5, VH * 0.2, 0, VW * 0.5, VH * 0.2, VH);
        g.addColorStop(0, `hsla(${hueBase | 0},80%,70%,${(0.12 + bass * 0.2).toFixed(2)})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        vctx.fillStyle = g; vctx.fillRect(0, 0, VW, VH);
        vctx.globalCompositeOperation = 'source-over';
      },
    });
  })();

  // Fireworks: every beat launches a shell that bursts into a shower
  // of sparks with gravity and trails; the bass sets the size.
  (function () {
    let sparks = [], shells = [], cooldown = 0, prevFreq = null, fluxAvg = 0, bassAvg = 0, sinceLaunch = 0;
    viz.registerMode({
      id: 'fireworks', label: 'Fireworks',
      init() { sparks = []; shells = []; cooldown = 0; prevFreq = null; fluxAvg = 0; bassAvg = 0; sinceLaunch = 0; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, speed, vizUserScale } = ctx;
        const energy = energyOf(freqData), bass = bassOf(freqData);
        // Onsets, not loudness. A level threshold against the running
        // average barely ever fired on real music, whose level hardly
        // moves; what marks a hit is *spectral flux* -- how much louder
        // the bins got since the last frame -- plus a bass jump. Both are
        // judged against their own running averages. A strong onset
        // launches a volley, a big one a bigger volley; between hits a
        // slow trickle keeps the sky busy in proportion to the energy,
        // and nothing longer than two seconds goes by with music playing
        // and no shell at all.
        const maxBin = Math.floor(freqData.length * 0.7);
        let flux = 0;
        if (prevFreq && prevFreq.length === freqData.length) for (let i = 0; i < maxBin; i++) { const d = freqData[i] - prevFreq[i]; if (d > 0) flux += d; }
        flux /= (maxBin * 255);
        prevFreq = Uint8Array.from(freqData);
        fluxAvg = fluxAvg * 0.9 + flux * 0.1; bassAvg = bassAvg * 0.9 + bass * 0.1;
        cooldown = Math.max(0, cooldown - 1); sinceLaunch++;
        const onset = flux > fluxAvg * 1.6 + 0.008 || bass > bassAvg * 1.25 + 0.06;
        const strength = Math.max(flux / (fluxAvg + 0.004), bass / (bassAvg + 0.05));
        let launches = 0;
        if (onset && cooldown === 0) { launches = strength > 3 ? 3 : strength > 2 ? 2 : 1; cooldown = 8; }
        else if (energy > 0.08 && (Math.random() < energy * 0.02 * speed || sinceLaunch > 120)) launches = 1;
        for (let n = 0; n < launches; n++) {
          // launch speed sized so the shell tops out somewhere in the
          // upper half (apex = v² / 2g against the 2.2g shell gravity)
          shells.push({ x: VW * (0.15 + Math.random() * 0.7), y: VH, vy: -(VH * 0.034 + Math.random() * VH * 0.016) * Math.sqrt(vizUserScale), hue: (hueBase + Math.random() * 140) % 360, size: 50 + bass * 140 + (launches > 1 ? 30 : 0) });
          sinceLaunch = 0;
        }
        const g = VH * 0.0006;
        vctx.lineCap = 'round';
        for (let i = shells.length - 1; i >= 0; i--) {
          const sh = shells[i];
          sh.x += (Math.random() - 0.5) * 2; sh.y += sh.vy * speed; sh.vy += g * 2.2 * speed;
          vctx.strokeStyle = `hsl(${sh.hue | 0},60%,85%)`; vctx.lineWidth = 2;
          vctx.beginPath(); vctx.moveTo(sh.x, sh.y); vctx.lineTo(sh.x, sh.y + VH * 0.02); vctx.stroke();
          if (sh.vy >= -g * 6) {
            shells.splice(i, 1);
            const n = Math.round(sh.size);
            for (let k = 0; k < n; k++) {
              const a = (k / n) * Math.PI * 2 + Math.random() * 0.2, v = (0.5 + Math.random()) * VH * 0.008 * Math.sqrt(vizUserScale);
              sparks.push({ x: sh.x, y: sh.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, hue: sh.hue + (Math.random() - 0.5) * 40, life: 1, decay: 0.006 + Math.random() * 0.012 });
            }
          }
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const p = sparks[i];
          p.vx *= 0.985; p.vy = p.vy * 0.985 + g * speed; p.x += p.vx * speed; p.y += p.vy * speed; p.life -= p.decay * speed;
          if (p.life <= 0 || p.y > VH + 10) { sparks.splice(i, 1); continue; }
          vctx.strokeStyle = `hsla(${p.hue | 0},100%,${(55 + p.life * 40) | 0}%,${p.life.toFixed(2)})`; vctx.lineWidth = 1.5 + p.life * 1.5;
          vctx.beginPath(); vctx.moveTo(p.x, p.y); vctx.lineTo(p.x - p.vx * 2, p.y - p.vy * 2); vctx.stroke();
        }
        if (sparks.length > 4000) sparks.splice(0, sparks.length - 4000);
      },
    });
  })();

  // Screensaver: the picture, as the DVD logo, bouncing off the edges.
  // A corner hit flashes the whole screen; the bass bloats the logo.
  (function () {
    const frame = offscreen();
    let box = null, flash = 0, hue = 0;
    viz.registerMode({
      id: 'screensaver', label: 'Screensaver',
      init() { box = null; flash = 0; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
        const bass = bassOf(freqData);
        const w = VW * 0.28 * vizUserScale * (1 + bass * 0.15), h = w * 0.5625;
        if (!box) { box = { x: VW * 0.3, y: VH * 0.3, vx: 2.2, vy: 1.7 }; hue = hueBase; }
        box.x += box.vx * speed; box.y += box.vy * speed;
        let hitX = false, hitY = false;
        if (box.x <= 0 || box.x + w >= VW) { box.vx *= -1; box.x = Math.max(0, Math.min(VW - w, box.x)); hitX = true; hue = (hue + 67) % 360; }
        if (box.y <= 0 || box.y + h >= VH) { box.vy *= -1; box.y = Math.max(0, Math.min(VH - h, box.y)); hitY = true; hue = (hue + 67) % 360; }
        if (hitX && hitY) flash = 1;
        vctx.fillStyle = flash > 0 ? `hsl(${hue | 0},100%,${(flash * 95) | 0}%)` : '#000';
        vctx.fillRect(0, 0, VW, VH);
        flash = Math.max(0, flash - 0.06);
        // the logo: the picture tinted the current colour, in a rounded frame
        vctx.save();
        vctx.beginPath(); vctx.roundRect(box.x, box.y, w, h, w * 0.06); vctx.clip();
        vctx.fillStyle = `hsl(${hue | 0},100%,50%)`; vctx.fillRect(box.x, box.y, w, h);
        if (videoFrame) {
          const { c, ctx: fc } = frame(videoFrame.w, videoFrame.h); fc.putImageData(videoFrame.imageData, 0, 0);
          vctx.globalCompositeOperation = 'multiply'; vctx.drawImage(c, box.x, box.y, w, h);
          vctx.globalCompositeOperation = 'lighter'; vctx.globalAlpha = 0.35; vctx.drawImage(c, box.x, box.y, w, h); vctx.globalAlpha = 1;
        }
        vctx.restore();
        vctx.fillStyle = `hsl(${hue | 0},100%,75%)`; vctx.font = `bold ${Math.round(h * 0.28)}px sans-serif`; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
        vctx.fillText('WEED', box.x + w / 2, box.y + h * 0.5); vctx.textAlign = 'left';
        vctx.font = `${Math.round(h * 0.13)}px sans-serif`; vctx.textAlign = 'center'; vctx.fillText('V I D E O', box.x + w / 2, box.y + h * 0.8); vctx.textAlign = 'left';
      },
    });
  })();

  // Slit-scan: a wave of time rolls through the picture. Rows near the
  // scan line are live; the further a row is from it, the older the
  // frame it shows (up to two seconds back), so anything that moves
  // smears and folds. Old rows are tinted cold and pushed sideways, and
  // the wave itself is drawn as a bright line, so time is visible.
  (function () {
    const HIST = 60; let hist = [], pool = [];
    viz.registerMode({
      id: 'slitscan', label: 'Slit-scan',
      init() { hist = []; pool = []; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, vizRot, vizUserScale, speed } = ctx;
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        if (!videoFrame) { vctx.fillStyle = `hsl(${hueBase | 0},60%,40%)`; vctx.font = `${Math.round(VH / 20)}px monospace`; vctx.textAlign = 'center'; vctx.fillText('— no video playing —', VW / 2, VH / 2); vctx.textAlign = 'left'; return; }
        const { w, h, imageData } = videoFrame;
        let c = pool.pop() || document.createElement('canvas');
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        c.getContext('2d').putImageData(imageData, 0, 0);
        hist.push(c); if (hist.length > HIST) pool.push(hist.shift());
        const energy = energyOf(freqData), bass = bassOf(freqData);
        const rows = 108, rh = VH / rows, srh = h / rows;
        const scan = 0.5 + 0.5 * Math.sin(vizRot * 1.5);          // the wave's position, 0..1 down the frame
        const reach = 0.35 + energy * 0.5;                          // how far from the line the past reaches
        const pw = VW * vizUserScale, px0 = (VW - pw) / 2;
        for (let r = 0; r < rows; r++) {
          const dist = Math.abs(r / (rows - 1) - scan) / reach;      // 0 at the line
          const age = clamp01(dist);
          const idx = Math.round(age * (hist.length - 1));
          const src = hist[hist.length - 1 - idx];
          const dx = Math.sin(r * 0.25 + vizRot * 4) * age * VW * 0.03 * (1 + bass);
          vctx.drawImage(src, 0, r * srh, w, srh, px0 + dx, r * rh, pw, rh + 1);
          if (age > 0.05) { vctx.fillStyle = `hsla(${(hueBase + 200) | 0},80%,50%,${(age * 0.35).toFixed(2)})`; vctx.fillRect(px0, r * rh, pw, rh + 1); }
        }
        // the scan line and its glow
        const y = scan * VH;
        vctx.fillStyle = `hsla(${hueBase | 0},100%,85%,0.9)`; vctx.fillRect(px0, y - 1, pw, 2);
        const g = vctx.createLinearGradient(0, y - VH * 0.06, 0, y + VH * 0.06);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `hsla(${hueBase | 0},100%,80%,0.25)`); g.addColorStop(1, 'rgba(255,255,255,0)');
        vctx.fillStyle = g; vctx.fillRect(px0, y - VH * 0.06, pw, VH * 0.12);
      },
    });
  })();

  // Skyline: the spectrum as a city in isometric view -- one tower per
  // band, windows lit by loudness, the camera drifting round the block.
  viz.registerMode({
    id: 'skyline', label: 'Skyline',
    draw(ctx) {
      const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale } = ctx;
      vctx.fillStyle = '#05030c'; vctx.fillRect(0, 0, VW, VH);
      const N = 12, maxBin = Math.floor(freqData.length * 0.7);
      const cell = Math.min(VW, VH) * 0.075 * vizUserScale, ang = vizRot * 0.4;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const proj = (gx, gy, z) => { const rx = gx * cs - gy * sn, ry = gx * sn + gy * cs; return [cx + rx * cell, cy + ry * cell * 0.5 - z + cell * 2.5]; };
      // draw back to front along the view direction
      const order = [];
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const gx = i - N / 2 + 0.5, gy = j - N / 2 + 0.5; order.push({ i, j, gx, gy, depth: gx * sn + gy * cs }); }
      order.sort((a, b) => a.depth - b.depth);
      for (const t of order) {
        const v = freqData[Math.floor(((t.i * N + t.j) / (N * N)) * maxBin)] / 255;
        const hgt = v * cell * 6 + cell * 0.2, hue = (hueBase + v * 80 + t.i * 4) % 360;
        const [x0, y0] = proj(t.gx - 0.4, t.gy - 0.4, 0), [x1, y1] = proj(t.gx + 0.4, t.gy - 0.4, 0), [x2, y2] = proj(t.gx + 0.4, t.gy + 0.4, 0), [x3, y3] = proj(t.gx - 0.4, t.gy + 0.4, 0);
        const faces = [[[x0, y0], [x1, y1], [x2, y2], [x3, y3]]];
        // top
        vctx.fillStyle = `hsl(${hue | 0},70%,${(35 + v * 45) | 0}%)`;
        vctx.beginPath(); vctx.moveTo(x0, y0 - hgt); vctx.lineTo(x1, y1 - hgt); vctx.lineTo(x2, y2 - hgt); vctx.lineTo(x3, y3 - hgt); vctx.closePath(); vctx.fill();
        // the two visible sides, picked by which way they face
        const sides = [[[x1, y1], [x2, y2]], [[x2, y2], [x3, y3]], [[x3, y3], [x0, y0]], [[x0, y0], [x1, y1]]];
        for (const [[ax, ay], [bx, by]] of sides) {
          const nx = by - ay, ny = ax - bx;               // outward-ish normal in screen space
          if (ny <= 0) continue;                           // faces pointing up-screen are hidden
          vctx.fillStyle = `hsl(${hue | 0},60%,${(nx > 0 ? 18 : 26) + v * 20 | 0}%)`;
          vctx.beginPath(); vctx.moveTo(ax, ay); vctx.lineTo(bx, by); vctx.lineTo(bx, by - hgt); vctx.lineTo(ax, ay - hgt); vctx.closePath(); vctx.fill();
          // windows: a few per floor across the face, lit by loudness,
          // some dark at random so it reads as offices, not a grid
          if (v > 0.1) {
            const floors = Math.floor(hgt / (cell * 0.22)), perFloor = 4;
            for (let f = 1; f < floors; f++) for (let wnd = 0; wnd < perFloor; wnd++) {
              const u = (wnd + 0.5) / perFloor, fy = f / floors;
              if (hash(t.i * 7.1 + t.j * 3.3 + f * 1.7 + wnd * 0.9) > 0.35 + v * 0.6) continue;
              const wx = ax + (bx - ax) * u, wy = ay + (by - ay) * u - hgt * fy;
              vctx.fillStyle = `hsla(${(45 + hash(f + wnd) * 15) | 0},100%,${(65 + v * 25) | 0}%,${(0.5 + v * 0.5).toFixed(2)})`;
              vctx.fillRect(wx - cell * 0.045, wy - cell * 0.06, cell * 0.09, cell * 0.08);
            }
          }
        }
        void faces;
      }
    },
  });

  // Globe: the Earth, spinning, lit from the front. The coastlines come
  // from Natural Earth's 110m land set (web/land.json, simplified to a
  // few thousand points), painted once into an equirectangular map;
  // every frame the visible disc is ray-cast back onto that map, so the
  // far side is properly hidden. Land is split into eight regions by
  // where it is (the Americas, Greenland, Europe, Africa, Asia,
  // Australia and Antarctica), each with a band of the spectrum: it
  // glows with it, its coast shivers with the waveform, and the whole
  // globe swells on the bass. A faint graticule rides on top. Until the
  // file arrives (or if it can't), a coarse hand-drawn set stands in.
  (function () {
    const COARSE = [
      [[-168, 66], [-140, 70], [-95, 80], [-70, 62], [-55, 47], [-75, 40], [-81, 31], [-80, 25], [-97, 26], [-105, 20], [-90, 15], [-77, 8], [-84, 10], [-105, 23], [-115, 30], [-125, 40], [-125, 49], [-135, 58], [-150, 60], [-165, 60]],
      [[-55, 60], [-45, 60], [-20, 70], [-25, 80], [-60, 82], [-70, 76], [-60, 66]],
      [[-77, 8], [-60, 10], [-50, 0], [-35, -5], [-40, -20], [-50, -30], [-60, -40], [-68, -52], [-72, -45], [-72, -30], [-80, -10], [-80, 0]],
      [[-10, 36], [-8, 44], [0, 48], [10, 55], [20, 60], [30, 70], [60, 72], [90, 75], [120, 72], [150, 70], [180, 68], [175, 62], [160, 55], [140, 45], [120, 35], [120, 22], [108, 10], [100, 5], [95, 15], [88, 22], [78, 8], [72, 20], [58, 25], [50, 15], [42, 13], [35, 30], [28, 37], [22, 37], [15, 40], [0, 40]],
      [[-17, 15], [-10, 32], [10, 37], [30, 31], [43, 12], [51, 12], [40, -5], [35, -25], [25, -34], [15, -30], [12, -15], [9, 0], [-5, 5]],
      [[114, -22], [128, -14], [137, -12], [142, -11], [153, -27], [148, -38], [140, -37], [130, -32], [115, -34]],
      [[-180, -68], [-120, -70], [-60, -66], [0, -69], [60, -66], [120, -66], [180, -68], [180, -90], [-180, -90]],
    ];
    let polys = COARSE, loaded = false, map = null;
    function loadLand() {
      if (loaded) return; loaded = true;
      fetch('land.json').then(r => (r.ok ? r.json() : null)).then(data => {
        if (Array.isArray(data) && data.length) { polys = data; map = null; }
      }).catch(() => { /* the coarse set stays */ });
    }
    // which band a piece of land belongs to, by where it is
    function regionOf(lon, lat) {
      if (lat < -60) return 7;                                   // Antarctica
      if (lon < -30) {
        if (lat > 59 && lon > -75) return 2;                     // Greenland
        return lat > 12 ? 1 : 3;                                 // North / South America
      }
      if (lon > 110 && lat < -10) return 6;                      // Australia, New Zealand
      if (lon < 60 && lat > 35) return 4;                        // Europe
      if (lon < 34 || (lon < 52 && lat < 12)) return lat > -40 ? 5 : 7;   // Africa
      return 8;                                                  // Asia, Arabia, the islands
    }
    const MW = 720, MH = 360;
    function landMap() {
      if (map) return map;
      const c = document.createElement('canvas'); c.width = MW; c.height = MH; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, MW, MH);
      g.fillStyle = '#fff';
      for (const pts of polys) {
        g.beginPath();
        pts.forEach(([lon, lat], i) => { const x = (lon + 180) / 360 * MW, y = (90 - lat) / 180 * MH; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
        g.closePath(); g.fill();
      }
      map = g.getImageData(0, 0, MW, MH).data;
      return map;
    }
    const disc = offscreen();
    viz.registerMode({
      id: 'globe', label: 'Globe',
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale } = ctx;
        loadLand();
        const M = landMap();
        const bass = bassOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        const band = new Array(9).fill(0);
        for (let id = 1; id <= 8; id++) band[id] = freqData[Math.floor(((id - 0.5) / 8) * maxBin)] / 255;
        vctx.fillStyle = '#02030a'; vctx.fillRect(0, 0, VW, VH);
        const R = Math.min(VW, VH) * 0.4 * vizUserScale * (1 + bass * 0.08);
        const N = 200, { c, ctx: dc } = disc(N, N);
        const img = dc.createImageData(N, N), d = img.data;
        const tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt), spin = vizRot * 0.6;
        const hue0 = hueBase;
        for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
          const nx = (px + 0.5) / N * 2 - 1, ny = 1 - (py + 0.5) / N * 2;
          const rr = nx * nx + ny * ny; if (rr > 1) continue;
          const nz = Math.sqrt(1 - rr);
          // undo the tilt, then the spin, to find where on the map this point is
          // screen-right is east: the sphere's x runs the other way from
          // the screen's (it was mirrored, Florida west of California)
          const y = ny * ct + nz * st, z = -ny * st + nz * ct, x = -nx;
          const lat = Math.asin(Math.max(-1, Math.min(1, y))), lon = Math.atan2(z, x) - spin;
          const u = ((lon / (Math.PI * 2)) % 1 + 1.5) % 1, v = 0.5 - lat / Math.PI;
          const mi = ((Math.min(MH - 1, (v * MH) | 0)) * MW + Math.min(MW - 1, (u * MW) | 0)) * 4;
          const id = M[mi] > 127 ? regionOf(lon * 180 / Math.PI - Math.floor((lon / (2 * Math.PI)) + 0.5) * 360, lat * 180 / Math.PI) : 0;
          const light = 0.35 + 0.65 * Math.max(0, nx * -0.4 + ny * 0.3 + nz * 0.85);   // lit from upper-left-front
          const o = (py * N + px) * 4;
          if (id) {
            const e = band[id], h = (hue0 + id * 38) % 360;
            // a green-to-hot land colour: quiet land is mossy, loud land glows its hue
            const [r, g, b] = hslToRgb(e > 0.15 ? h : 110, 0.55 + e * 0.45, (0.28 + e * 0.45) * light);
            d[o] = r; d[o + 1] = g; d[o + 2] = b;
          } else {
            // the sea stays sea-coloured whatever the app's hue is doing
            const [r, g, b] = hslToRgb(215, 0.7, 0.16 * light + 0.04);
            d[o] = r; d[o + 1] = g; d[o + 2] = b;
          }
          d[o + 3] = 255;
        }
        dc.putImageData(img, 0, 0);
        vctx.save();
        vctx.beginPath(); vctx.arc(cx, cy, R, 0, Math.PI * 2); vctx.clip();
        vctx.imageSmoothingEnabled = true;
        vctx.drawImage(c, cx - R, cy - R, R * 2, R * 2);
        vctx.restore();
        // atmosphere rim and a faint graticule
        vctx.strokeStyle = 'hsla(200,90%,70%,0.55)'; vctx.lineWidth = Math.max(1.5, R * 0.012);
        vctx.beginPath(); vctx.arc(cx, cy, R, 0, Math.PI * 2); vctx.stroke();
        vctx.strokeStyle = 'rgba(255,255,255,0.12)'; vctx.lineWidth = 1;
        const P = (lat, lon) => { const x = -Math.cos(lat) * Math.cos(lon + spin), y = Math.sin(lat), z = Math.cos(lat) * Math.sin(lon + spin); return [x, y * ct - z * st, y * st + z * ct]; };
        const ring = pts => { vctx.beginPath(); let on = false; for (const [x, y, z] of pts) { if (z < 0) { on = false; continue; } const sx = cx + x * R, sy = cy - y * R; if (!on) { vctx.moveTo(sx, sy); on = true; } else vctx.lineTo(sx, sy); } vctx.stroke(); };
        for (let i = 1; i < 6; i++) ring(Array.from({ length: 49 }, (_, k) => P((i / 6 - 0.5) * Math.PI, (k / 48) * Math.PI * 2)));
        for (let j = 0; j < 8; j++) ring(Array.from({ length: 49 }, (_, k) => P((k / 48 - 0.5) * Math.PI, (j / 8) * Math.PI * 2)));
        // the coastlines as an oscilloscope trace: the waveform runs
        // along every shore, each point pushed off the coast along its
        // normal by the sample under it, so the borders shiver with the
        // sound the way Mirror's centre line does
        const wave = ctx.waveData, wn = wave.length, energy = energyOf(freqData);
        const amp = R * 0.07 * (0.5 + energy * 2);      // a good shiver: several percent of the globe at a normal level
        vctx.lineWidth = Math.max(1, R * 0.006); vctx.lineJoin = 'round';
        const D = Math.PI / 180;
        let k = 0;
        const strokeRun = (id) => { const e = band[id], h = (hue0 + id * 38) % 360; vctx.strokeStyle = `hsla(${h | 0},100%,${(70 + e * 25) | 0}%,${(0.55 + e * 0.45).toFixed(2)})`; vctx.shadowColor = `hsla(${h | 0},100%,70%,0.8)`; vctx.shadowBlur = R * 0.02 * (1 + e * 2); vctx.stroke(); };
        for (const pts of polys) {
          if (pts.length < 4) continue;
          // long edges (the coarse set, or a straight run of coast) get
          // extra points so the trace has room to wiggle
          const path = [], reg = [];
          for (let i = 0; i < pts.length; i++) {
            const [lon0, lat0] = pts[i], [lon1, lat1] = pts[(i + 1) % pts.length];
            const steps = Math.max(1, Math.min(8, Math.round(Math.hypot(lon1 - lon0, lat1 - lat0) / 2.5)));
            for (let sIdx = 0; sIdx < steps; sIdx++) { const f = sIdx / steps; const lon = lon0 + (lon1 - lon0) * f, lat = lat0 + (lat1 - lat0) * f; path.push(P(lat * D, lon * D)); reg.push(regionOf(lon, lat)); }
          }
          let on = false, cur = -1;
          for (let i = 0; i < path.length; i++) {
            const [x, y, z] = path[i], id = reg[i];
            if (z < 0.02 || id === 7) { if (on) strokeRun(cur); on = false; k += 5; continue; }
            if (on && id !== cur) { strokeRun(cur); on = false; }
            const px = cx + x * R, py = cy - y * R;
            const [nx0, ny0] = path[(i + 1) % path.length], [nx1, ny1] = path[(i - 1 + path.length) % path.length];
            let tx = nx0 - nx1, ty = -(ny0 - ny1); const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
            const disp = (wave[(k += 5) % wn] / 128 - 1) * amp;
            const qx = px + ty * disp, qy = py - tx * disp;
            if (!on) { vctx.beginPath(); vctx.moveTo(qx, qy); on = true; cur = id; } else vctx.lineTo(qx, qy);
          }
          if (on) strokeRun(cur);
        }
        vctx.shadowBlur = 0;
      },
    });
  })();
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2;
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  // ══════════════════════════════════════════════════════════════════
  //  MORE TRANSITIONS
  // ══════════════════════════════════════════════════════════════════

  // Blinds: venetian slats of the old picture tilt away, top to bottom
  // with a slight lag down the window.
  viz.registerTransition({
    id: 'blinds', label: 'Blinds',
    draw({ vctx, old, oldW, oldH, W, H, t }) {
      const n = 12, sh = H / n, ssh = oldH / n;
      for (let i = 0; i < n; i++) {
        const k = clamp01(t * 1.4 - (i / n) * 0.4);
        const open = Math.cos(k * Math.PI / 2);             // 1 flat .. 0 edge-on
        if (open <= 0.02) continue;
        vctx.save();
        vctx.translate(0, i * sh + sh / 2); vctx.scale(1, open); vctx.translate(0, -sh / 2);
        vctx.globalAlpha = 0.4 + 0.6 * open;
        vctx.drawImage(old, 0, i * ssh, oldW, ssh, 0, 0, W, sh);
        vctx.restore();
      }
    },
  });

  // Flip tiles: a grid of tiles, each spinning on its own axis to show
  // the new picture behind, in a wave from one corner.
  viz.registerTransition({
    id: 'fliptiles', label: 'Flip tiles',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const cols = 8, rows = 5, tw = W / cols, th = H / rows, sw = oldW / cols, sh = oldH / rows;
      const fromLeft = hash(seed) > 0.5;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const d = ((fromLeft ? c : cols - 1 - c) + r) / (cols + rows - 2);
        const k = clamp01((t - d * 0.5) / 0.5);
        const sx = Math.cos(k * Math.PI);                    // 1 .. -1
        if (sx <= 0) continue;                               // past edge-on: the new picture
        vctx.save();
        vctx.translate(c * tw + tw / 2, r * th + th / 2); vctx.scale(sx, 1);
        vctx.globalAlpha = 0.5 + 0.5 * sx;
        vctx.drawImage(old, c * sw, r * sh, sw, sh, -tw / 2, -th / 2, tw, th);
        vctx.restore();
      }
    },
  });

  // CRT off: the old picture collapses to a bright horizontal line,
  // the line shrinks to a dot, the dot fades. Then the new picture.
  viz.registerTransition({
    id: 'crtoff', label: 'CRT off',
    draw({ vctx, old, W, H, t }) {
      vctx.fillStyle = '#000';
      if (t < 0.45) {
        const k = t / 0.45, h = H * Math.pow(1 - k, 3) + 3;
        vctx.fillRect(0, 0, W, H);
        vctx.save(); vctx.translate(0, H / 2); vctx.scale(1, h / H); vctx.translate(0, -H / 2);
        vctx.filter = `brightness(${(1 + k * 2).toFixed(2)})`;
        vctx.drawImage(old, 0, 0, W, H);
        vctx.restore();
      } else if (t < 0.8) {
        const k = (t - 0.45) / 0.35, w = W * Math.pow(1 - k, 2) + 4;
        vctx.fillRect(0, 0, W, H);
        vctx.fillStyle = '#fff'; vctx.fillRect((W - w) / 2, H / 2 - 1.5, w, 3);
      } else {
        const k = (t - 0.8) / 0.2;
        vctx.globalAlpha = 1 - k; vctx.fillRect(0, 0, W, H); vctx.globalAlpha = 1;
        vctx.fillStyle = `rgba(255,255,255,${(1 - k).toFixed(2)})`; vctx.beginPath(); vctx.arc(W / 2, H / 2, 3 + k * 6, 0, Math.PI * 2); vctx.fill();
      }
    },
  });

  // Droplet: a ring of distortion spreads from the centre through the
  // old picture -- concentric bands pushed in and out like a water
  // surface -- and the picture drains away behind it.
  viz.registerTransition({
    id: 'droplet', label: 'Droplet',
    draw({ vctx, old, W, H, t }) {
      const rings = 28, maxR = Math.hypot(W, H) / 2, cx = W / 2, cy = H / 2;
      const front = t * maxR * 1.2;
      vctx.globalAlpha = 1 - t * t;
      for (let i = rings - 1; i >= 0; i--) {
        const r0 = (i / rings) * maxR, r1 = ((i + 1) / rings) * maxR;
        const d = (r0 - front) / (maxR * 0.25);
        const disp = Math.exp(-d * d) * Math.sin(d * 6) * 0.12;   // a wave packet around the front
        const sc = 1 + disp;
        vctx.save();
        vctx.beginPath(); vctx.arc(cx, cy, r1, 0, Math.PI * 2); if (i > 0) { vctx.arc(cx, cy, r0, 0, Math.PI * 2, true); } vctx.clip();
        vctx.translate(cx, cy); vctx.scale(sc, sc); vctx.translate(-cx, -cy);
        vctx.drawImage(old, 0, 0, W, H);
        vctx.restore();
      }
    },
  });

  // Blur: the old picture goes soft and washes out.
  viz.registerTransition({
    id: 'blur', label: 'Blur',
    draw({ vctx, old, W, H, t }) {
      vctx.globalAlpha = 1 - t * t;
      vctx.filter = `blur(${(t * Math.max(8, W / 60)).toFixed(1)}px) brightness(${(1 + t * 0.6).toFixed(2)})`;
      const k = 1 + t * 0.08;
      vctx.translate(W / 2, H / 2); vctx.scale(k, k);
      vctx.drawImage(old, -W / 2, -H / 2, W, H);
    },
  });

  // Slide: the old picture slides off one side, the direction picked per run.
  viz.registerTransition({
    id: 'slide', label: 'Slide',
    draw({ vctx, old, W, H, t, seed }) {
      const dir = Math.floor(hash(seed) * 4), e = 1 - Math.pow(1 - t, 3);
      const dx = dir === 0 ? -W * e : dir === 1 ? W * e : 0, dy = dir === 2 ? -H * e : dir === 3 ? H * e : 0;
      vctx.drawImage(old, dx, dy, W, H);
    },
  });

  // Flash: a hard white cut -- the old picture blows out to white, the
  // new one fades up from it.
  viz.registerTransition({
    id: 'flash', label: 'Flash',
    draw({ vctx, old, W, H, t }) {
      if (t < 0.3) {
        vctx.drawImage(old, 0, 0, W, H);
        vctx.globalAlpha = t / 0.3; vctx.fillStyle = '#fff'; vctx.fillRect(0, 0, W, H);
      } else {
        vctx.globalAlpha = 1 - (t - 0.3) / 0.7; vctx.fillStyle = '#fff'; vctx.fillRect(0, 0, W, H);
      }
    },
  });

  // ── 3D: a small painter's-algorithm toolkit and what's built on it ──
  // Canvas 2D has no perspective, so a textured face is drawn as a run
  // of thin vertical strips, each an affine parallelogram between two
  // projected strip edges; at 40-60 strips the seams and the per-strip
  // affine error are invisible. Points are [x, y, z] with the camera on
  // +z looking at the origin; a face is four 3D corners TL TR BR BL and
  // the source rectangle of the texture that goes on it. Faces are
  // culled by the winding of their projected corners and sorted far to
  // near before drawing.
  (function () {
    const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
    const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
    const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    // f: focal length, D: camera distance; scale = f / (D - z)
    function project(p, cam) { const sc = cam.f / Math.max(1, cam.D - p[2]); return [cam.cx + p[0] * sc, cam.cy + p[1] * sc]; }
    function visible(P) {   // TL TR BR BL projected, clockwise on screen (y down) = facing us
      const [a, b, , d] = P;
      return (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]) > 0;
    }
    function drawFace(vctx, img, sx, sy, sw, sh, F, cam, strips, shade) {
      const [TL, TR, BR, BL] = F;
      const P = F.map(p => project(p, cam));
      if (!visible(P)) return false;
      const n = Math.max(6, strips | 0), ssw = sw / n;
      vctx.save();
      for (let i = 0; i < n; i++) {
        const u0 = i / n, u1 = (i + 1) / n;
        const A = project(lerp3(TL, TR, u0), cam), B = project(lerp3(TL, TR, u1), cam), C = project(lerp3(BL, BR, u0), cam);
        // affine map of this strip's source rect onto A (top-left), B (top-right), C (bottom-left)
        const a = (B[0] - A[0]) / ssw, b = (B[1] - A[1]) / ssw, c = (C[0] - A[0]) / sh, d = (C[1] - A[1]) / sh;
        vctx.setTransform(a, b, c, d, A[0], A[1]);
        vctx.drawImage(img, sx + i * ssw, sy, ssw + 0.5, sh, 0, 0, ssw + 1.2, sh);   // the +1.2 overlap hides seams
      }
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      if (shade > 0) {   // a face turning away goes dark
        vctx.globalAlpha = Math.min(0.85, shade); vctx.fillStyle = '#000';
        vctx.beginPath(); vctx.moveTo(P[0][0], P[0][1]); for (let k = 1; k < 4; k++) vctx.lineTo(P[k][0], P[k][1]); vctx.closePath(); vctx.fill();
      }
      vctx.restore();
      return true;
    }
    // faces: [{ img, sx, sy, sw, sh, pts, shade }], drawn far to near
    function drawFaces(vctx, faces, cam, strips) {
      faces.map(f => ({ f, z: (f.pts[0][2] + f.pts[1][2] + f.pts[2][2] + f.pts[3][2]) / 4 }))
        .sort((p, q) => p.z - q.z)
        .forEach(({ f }) => drawFace(vctx, f.img, f.sx, f.sy, f.sw, f.sh, f.pts, cam, strips, f.shade || 0));
    }
    // a box face by name, for a box of half-extents hw hh hd, before rotation
    function boxFace(name, hw, hh, hd) {
      switch (name) {
        case 'front': return [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]];
        case 'right': return [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]];
        case 'back': return [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]];
        case 'left': return [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]];
      }
    }
    // how much a face has turned from facing the camera, 0..1, from its rotated normal
    const turned = (angle) => clamp01(1 - Math.cos(angle));
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // a copy of what's on the canvas right now -- for a transition, that's
    // the new picture (the mode already painted it under us)
    const snapOff = offscreen();
    function snapshot(vctx, W, H) {
      const { c, ctx } = snapOff(W, H);
      ctx.clearRect(0, 0, W, H); ctx.drawImage(vctx.canvas, 0, 0);
      return c;
    }
    function backdrop(vctx, W, H, hueBase) {
      const g = vctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `hsl(${hueBase | 0},35%,7%)`); g.addColorStop(1, '#000');
      vctx.fillStyle = g; vctx.fillRect(0, 0, W, H);
    }
    // the picture for a mode: the video frame as a canvas, or, with no
    // video, the spectrum as coloured bars so there's still something on
    // the faces
    const texOff = offscreen();
    let texFrame = null;
    function texture(videoFrame, freqData, hueBase) {
      if (videoFrame) {
        const { c, ctx } = texOff(videoFrame.w, videoFrame.h);
        if (texFrame !== videoFrame) { texFrame = videoFrame; ctx.putImageData(videoFrame.imageData, 0, 0); }
        return c;
      }
      texFrame = null;
      const { c, ctx: x } = texOff(256, 144);
      const maxBin = Math.floor(freqData.length * 0.7), n = 32;
      x.fillStyle = '#101018'; x.fillRect(0, 0, 256, 144);
      for (let i = 0; i < n; i++) {
        const v = freqData[Math.floor((i / n) * maxBin)] / 255;
        x.fillStyle = `hsl(${(hueBase + i * 9) | 0},90%,${(35 + v * 40) | 0}%)`;
        x.fillRect(i * 8, 144 - v * 130, 7, v * 130);
      }
      return c;
    }

    // ── Desktop cube (transition): Compiz. The old picture on the front
    // face, the new one on the side, the cube turns a quarter and zooms
    // out a little on the way, over a dark sky.
    viz.registerTransition({
      id: 'desktopcube', label: 'Desktop cube',
      draw({ vctx, old, oldW, oldH, W, H, t, seed, hueBase }) {
        const fresh = snapshot(vctx, W, H);
        const dir = hash(seed) > 0.5 ? 1 : -1;
        const k = ease(t), th = -dir * k * Math.PI / 2, zoom = 1 - 0.28 * Math.sin(Math.PI * t);
        const hw = W / 2, hh = H / 2, hd = W / 2;
        const cam = { cx: W / 2, cy: H / 2, D: W * 1.6, f: W * 1.6 - hd };
        const side = dir > 0 ? 'right' : 'left';
        const faces = [
          { img: old, sx: 0, sy: 0, sw: oldW, sh: oldH, pts: boxFace('front', hw, hh, hd).map(p => rotY(p, th).map(v => v * zoom)), shade: turned(th) * 0.7 },
          { img: fresh, sx: 0, sy: 0, sw: W, sh: H, pts: boxFace(side, hw, hh, hd).map(p => rotY(p, th).map(v => v * zoom)), shade: turned(th + dir * Math.PI / 2) * 0.7 },
        ];
        backdrop(vctx, W, H, hueBase);
        drawFaces(vctx, faces, cam, 48);
      },
    });

    // ── Carousel (transition): the pictures are two neighbouring faces
    // of a six-sided drum; it turns a sixth of the way round.
    viz.registerTransition({
      id: 'carousel', label: 'Carousel',
      draw({ vctx, old, oldW, oldH, W, H, t, seed, hueBase }) {
        const fresh = snapshot(vctx, W, H);
        const dir = hash(seed + 1) > 0.5 ? 1 : -1;
        const step = Math.PI / 3, k = ease(t), th = -dir * k * step, zoom = 1 - 0.18 * Math.sin(Math.PI * t);
        const hw = W / 2, hh = H / 2, r = hw / Math.tan(step / 2);          // face centre distance from the axis
        const cam = { cx: W / 2, cy: H / 2, D: W * 1.9, f: W * 1.9 - r };
        const face = (angle, img, sw, sh, shadeAngle) => ({
          img, sx: 0, sy: 0, sw, sh, shade: turned(shadeAngle) * 0.8,
          pts: [[-hw, -hh, r], [hw, -hh, r], [hw, hh, r], [-hw, hh, r]].map(p => rotY(p, angle).map(v => v * zoom)),
        });
        backdrop(vctx, W, H, hueBase);
        const faces = [face(th, old, oldW, oldH, th), face(th + dir * step, fresh, W, H, th + dir * step)];
        // the drum's other faces, dark, so it reads as a solid thing
        for (let i = 2; i < 6; i++) faces.push({ ...face(th + dir * step * i, old, oldW, oldH, Math.PI), shade: 0.92 });
        drawFaces(vctx, faces, cam, 40);
      },
    });

    // ── Doors (transition): the old picture splits down the middle and
    // both halves swing away into the screen on their outer edges.
    viz.registerTransition({
      id: 'doors', label: 'Doors',
      draw({ vctx, old, oldW, oldH, W, H, t }) {
        const k = ease(t), a = k * Math.PI * 0.55;
        const hw = W / 2, hh = H / 2;
        const cam = { cx: W / 2, cy: H / 2, D: W * 1.5, f: W * 1.5 };
        // each door hinges on its outer edge (x = ±hw): rotate its points
        // about that edge, the free edge swinging away to -z
        const hinged = (sign) => [[0, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [0, hh, 0]].map(p => {
          const q = rotY([p[0] - hw, p[1], p[2]], sign * a);     // rotate about the door's outer edge
          return [sign * (q[0] + hw), q[1], q[2]];
        });
        const R = hinged(1), L = hinged(-1);
        // texture: the left door shows the left half of the old picture, mirrored back into place
        const faces = [
          { img: old, sx: oldW / 2, sy: 0, sw: oldW / 2, sh: oldH, pts: [R[0], R[1], R[2], R[3]], shade: turned(a) * 0.8 },
          { img: old, sx: 0, sy: 0, sw: oldW / 2, sh: oldH, pts: [L[1], L[0], L[3], L[2]], shade: turned(a) * 0.8 },
        ];
        vctx.fillStyle = `rgba(0,0,0,${(0.5 * Math.sin(Math.PI * t)).toFixed(2)})`; vctx.fillRect(0, 0, W, H);   // the room behind, dimmed mid-swing
        drawFaces(vctx, faces, cam, 32);
      },
    });

    // ── Desktop cube (mode): the video on all four sides of a cube that
    // turns with the music, tilted so the top shows, over its own
    // reflection in a dark floor. Speed drives the turn, the bass gives
    // it a shove and swells it, Zoom sizes it.
    (function () {
      let spin = 0, kick = 0, last = 0;
      viz.registerMode({
        id: 'desktopcube', label: 'Desktop cube',
        draw(ctx) {
          const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
          const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
          const bass = bassOf(freqData);
          kick = Math.max(kick * 0.9, bass > 0.6 ? bass : 0);
          spin += dt * (0.35 * speed + kick * 1.5);
          const img = texture(videoFrame, freqData, hueBase), iw = img.width, ih = img.height;
          const size = Math.min(VW, VH) * 0.42 * vizUserScale * (1 + bass * 0.08);
          const hw = size, hh = size * 0.6, hd = size;
          const cam = { cx: VW / 2, cy: VH / 2 - hh * 0.25, D: size * 6, f: size * 6 - size * 1.7 };
          const tilt = -0.32;   // negative: the top tips toward us (y runs down on screen)
          const place = (p, mirror) => { let q = rotY(p, spin); q = rotX(q, tilt); return mirror ? [q[0], 2 * (hh * 1.05) - q[1] + hh * 0.3, q[2]] : q; };
          backdrop(vctx, VW, VH, hueBase);
          const names = ['front', 'right', 'back', 'left'];
          const build = (mirror) => names.map((n, i) => {
            const angle = spin + i * Math.PI / 2;
            return { img, sx: 0, sy: 0, sw: iw, sh: ih, pts: boxFace(n, hw, hh, hd).map(p => place(p, mirror)), shade: turned(angle) * 0.75 + (mirror ? 0.45 : 0) };
          });
          // the reflection first, then a fade over it, then the cube
          drawFaces(vctx, build(true), cam, 28);
          const g = vctx.createLinearGradient(0, VH * 0.55, 0, VH);
          g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,1)');
          vctx.fillStyle = g; vctx.fillRect(0, VH * 0.5, VW, VH * 0.5);
          drawFaces(vctx, build(false), cam, 40);
          // the top face: a plain lit lid so the tilt reads
          const top = [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]].map(p => project(place(p, false), cam));
          if (visible(top)) {
            vctx.fillStyle = `hsla(${hueBase | 0},60%,${(30 + bass * 30) | 0}%,0.9)`;
            vctx.beginPath(); vctx.moveTo(top[0][0], top[0][1]); for (let k = 1; k < 4; k++) vctx.lineTo(top[k][0], top[k][1]); vctx.closePath(); vctx.fill();
          }
        },
      });
    })();

    // ── Coverflow (mode): the last few seconds of the picture as a row
    // of cards, the one in the middle facing you, the rest angled away
    // either side, sliding along with the beat, reflected in the floor.
    (function () {
      const N = 9, cards = [];
      let lastSnap = 0, pos = 0, kick = 0, last = 0;
      viz.registerMode({
        id: 'coverflow', label: 'Coverflow',
        draw(ctx) {
          const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
          const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
          const bass = bassOf(freqData);
          kick = Math.max(kick * 0.88, bass > 0.6 ? bass : 0);
          pos += dt * (0.25 * speed + kick * 1.2);
          const src = texture(videoFrame, freqData, hueBase);
          if (now - lastSnap > 450 || !cards.length) {   // a new card every so often, oldest one recycled
            lastSnap = now;
            const card = cards.length < N ? offscreen() : cards.shift();
            card(256, 144).ctx.drawImage(src, 0, 0, 256, 144);
            cards.push(card);
          }
          backdrop(vctx, VW, VH, hueBase);
          const cw = VW * 0.34 * vizUserScale, ch = cw * 9 / 16, gap = cw * 0.36;
          const cam = { cx: VW / 2, cy: VH / 2 - ch * 0.1, D: VW * 1.6, f: VW * 1.6 };
          const centre = pos % cards.length;   // which card is in the middle, fractional
          const faces = [], mirrors = [];
          cards.forEach((card, i) => {
            const cc = card(256, 144).c;
            let off = i - centre; off = ((off + cards.length / 2) % cards.length + cards.length) % cards.length - cards.length / 2;
            const side = Math.sign(off), d = Math.abs(off);
            const angle = -side * Math.min(1, d * 1.6) * 1.05;
            const x = side * (Math.min(1, d * 1.6) * gap * 1.6 + Math.max(0, d - 0.6) * gap * 0.9);
            const z = -Math.min(1, d * 1.6) * cw * 0.7;
            const pts = [[-cw / 2, -ch / 2, 0], [cw / 2, -ch / 2, 0], [cw / 2, ch / 2, 0], [-cw / 2, ch / 2, 0]]
              .map(p => rotY(p, angle)).map(p => [p[0] + x, p[1], p[2] + z]);
            faces.push({ img: cc, sx: 0, sy: 0, sw: 256, sh: 144, pts, shade: Math.min(1, d) * 0.5 });
            mirrors.push({ img: cc, sx: 0, sy: 0, sw: 256, sh: 144, pts: [pts[3], pts[2], pts[1], pts[0]].map(p => [p[0], ch + (ch - p[1]) + ch * 0.06, p[2]]), shade: 0.6 + Math.min(1, d) * 0.3 });
          });
          drawFaces(vctx, mirrors, cam, 20);
          const g = vctx.createLinearGradient(0, cam.cy + ch * 0.55, 0, VH);
          g.addColorStop(0, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,1)');
          vctx.fillStyle = g; vctx.fillRect(0, cam.cy + ch * 0.5, VW, VH);
          drawFaces(vctx, faces, cam, 36);
        },
      });
    })();
  })();

})();
