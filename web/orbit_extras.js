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
//              Spectrogram, Stained glass, Fireworks, Screensaver, Slit-scan, Skyline, Globe,
//              Aurora, Flow, Life, Tree, Warp, Cymatics, Orrery, Doom95, Hackers, Dancing baby,
//              Synthwave, Fire, Lawnmower Man
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

    // ── Starfield (mode): the classic warp. A few hundred stars fly
    // past, streaking with their speed; Speed sets the cruise, the bass
    // punches the throttle, the hue drifts, and Zoom pulls the field in
    // and out. Pure lines, so it's cheap at any size.
    (function () {
      const N = 420, stars = [];
      let last = 0, kick = 0;
      const spawn = (st, far) => { st.x = (Math.random() - 0.5) * 2; st.y = (Math.random() - 0.5) * 2; st.z = far ? 1 : Math.random(); st.pz = st.z; };
      for (let i = 0; i < N; i++) { const st = {}; spawn(st, false); stars.push(st); }
      viz.registerMode({
        id: 'starfield', label: 'Starfield',
        draw(ctx) {
          const { vctx, VW, VH, cx, cy, hueBase, freqData, speed, vizUserScale } = ctx;
          const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
          const bass = bassOf(freqData), energy = energyOf(freqData);
          kick = Math.max(kick * 0.9, bass > 0.55 ? bass : 0);
          const v = dt * (0.25 * speed + kick * 1.4 + energy * 0.3);
          fadeFrame(vctx, VW, VH, 0.35 + Math.min(0.4, v * 4));
          const f = Math.min(VW, VH) * 0.9 * vizUserScale;
          vctx.lineCap = 'round';
          for (const st of stars) {
            st.pz = st.z; st.z -= v;
            if (st.z <= 0.02) { spawn(st, true); continue; }
            const s1 = f / st.z, s0 = f / st.pz;
            const x1 = cx + st.x * s1, y1 = cy + st.y * s1, x0 = cx + st.x * s0, y0 = cy + st.y * s0;
            if (x1 < -20 || x1 > VW + 20 || y1 < -20 || y1 > VH + 20) { spawn(st, true); continue; }
            const near = 1 - st.z;
            vctx.strokeStyle = `hsla(${(hueBase + near * 60) | 0},${(40 + near * 50) | 0}%,${(55 + near * 40) | 0}%,${(0.25 + near * 0.75).toFixed(2)})`;
            vctx.lineWidth = 0.6 + near * 2.6;
            vctx.beginPath(); vctx.moveTo(x0, y0); vctx.lineTo(x1, y1); vctx.stroke();
          }
        },
      });
    })();

    // ── Spectrum 3D (mode): the spectrum as a landscape. Each frame's
    // bands become the nearest row of bars and older rows recede into
    // the distance, drawn as flat-shaded boxes far to near with a low
    // camera, the whole thing swaying gently. Bass lifts the camera.
    (function () {
      const BANDS = 28, ROWS = 22, rows = [];
      let last = 0, sway = 0, lift = 0;
      viz.registerMode({
        id: 'spectrum3d', label: 'Spectrum 3D',
        draw(ctx) {
          const { vctx, VW, VH, hueBase, freqData, speed, vizUserScale } = ctx;
          const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
          const bass = bassOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
          const row = new Float32Array(BANDS);
          for (let b = 0; b < BANDS; b++) { const k = b / (BANDS - 1); row[b] = freqData[Math.floor(k * k * maxBin)] / 255; }
          rows.unshift(row); if (rows.length > ROWS) rows.pop();
          sway += dt * 0.35 * speed; lift = lift * 0.9 + bass * 0.1;
          vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
          const unit = Math.min(VW, VH) * 0.075 * vizUserScale;      // one cell
          // camera camD in front of the nearest row and camY above the
          // ground, looking at a horizon 40% down the screen; rows run
          // away to -z, so distance = camD - z grows with the row
          const camY = -unit * (4.5 + lift * 2.5), camD = unit * 6, f = unit * 7, horizon = VH * 0.4;
          const ang = Math.sin(sway) * 0.35;
          const proj = (x, y, z) => {            // rotate about Y, then perspective
            const xr = x * Math.cos(ang) + z * Math.sin(ang), zr = -x * Math.sin(ang) + z * Math.cos(ang);
            const sc = f / Math.max(unit * 0.5, camD - zr);
            return [VW / 2 + xr * sc, horizon + (y - camY) * sc, sc];
          };
          const poly = (pts, col) => { vctx.fillStyle = col; vctx.beginPath(); vctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]); vctx.closePath(); vctx.fill(); };
          for (let r = rows.length - 1; r >= 0; r--) {
            const data = rows[r], z = -r * unit * 1.1, depth = 1 - r / ROWS;
            const order = ang >= 0 ? [...Array(BANDS).keys()] : [...Array(BANDS).keys()].reverse();   // far side of the row first
            for (const b of order) {
              const v = data[b], h = (0.08 + v * 3.2) * unit;
              const x0 = (b - BANDS / 2) * unit, x1 = x0 + unit * 0.86;
              const hue = (hueBase + b * 6 + r * 3) | 0, L = 28 + v * 35;
              const top = [proj(x0, -h, z), proj(x1, -h, z), proj(x1, -h, z - unit * 0.86), proj(x0, -h, z - unit * 0.86)];
              const front = [proj(x0, 0, z), proj(x1, 0, z), proj(x1, -h, z), proj(x0, -h, z)];
              const sideX = ang >= 0 ? x1 : x0;
              const side = [proj(sideX, 0, z), proj(sideX, 0, z - unit * 0.86), proj(sideX, -h, z - unit * 0.86), proj(sideX, -h, z)];
              poly(side, `hsla(${hue},80%,${(L * 0.55 * depth + 8) | 0}%,${(0.35 + depth * 0.65).toFixed(2)})`);
              poly(front, `hsla(${hue},85%,${(L * 0.8 * depth + 10) | 0}%,${(0.35 + depth * 0.65).toFixed(2)})`);
              poly(top, `hsla(${hue},90%,${(L * 1.2 * depth + 18) | 0}%,${(0.4 + depth * 0.6).toFixed(2)})`);
            }
          }
        },
      });
    })();
  })();


  // ── Brain (mode): a glass brain. Two hemispheres of wrinkled shell
  // contours turn slowly and each swells and bounces on the beat, the
  // left on the bass, the right on the top end. Inside, a couple of
  // dozen neurons: a soma with branching dendrites, and an axon reaching
  // another cell. Each neuron listens to one band of the spectrum; a
  // jump in that band fires it -- light runs in from the dendrite tips
  // to the soma, then down the axon to the next cell, which fires in
  // turn. Ryan: "a 3d brain with hemispheres and neurons firing to the
  // music ... the hemispheres could bounce/grow-shrink to the beat".
  (function () {
    let seed = 1234;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    // ── the shape, after the textbook side view: a rounded cerebrum
    // with a big frontal lobe, a distinct temporal lobe tucked under the
    // lateral fissure, a ridged cerebellum under the back and a
    // brainstem angling down. A mesh is rings of points, the same count
    // per ring so neighbouring rings tie into quads; fn(phi, th) gives
    // the point and its fold (-1 sulcus .. +1 gyrus) for the shading.
    // Gyri are random walks over the surface, drawn as wandering lines.
    // x is width (the fissure at 0), y down, z forward.
    function makeMesh(rings, per, fn, opts) {
      const pts = [];
      for (let r = 1; r < rings; r++) for (let i = 0; i < per; i++) { const q = fn(Math.PI * r / rings, (opts.closed ? 2 * Math.PI : Math.PI) * (i + 0.5) / per); q.u = r / rings; pts.push(q); }
      const curves = [];
      for (let c = 0; c < (opts.gyri || 0); c++) {
        let phi = 0.25 + rnd() * 2.6, th = (opts.closed ? 2 * Math.PI : Math.PI) * (0.05 + rnd() * 0.9), ang = rnd() * Math.PI * 2;
        const pts2 = [];
        for (let k = 0, n = 6 + Math.floor(rnd() * 8); k < n; k++) {
          const q = fn(phi, th); pts2.push({ x: q.x * 1.012, y: q.y * 1.012, z: q.z * 1.012, u: phi / Math.PI });
          ang += (rnd() - 0.5) * 2.4; phi += Math.cos(ang) * 0.085; th += Math.sin(ang) * 0.085 / Math.max(0.35, Math.sin(phi));
          if (phi < 0.2 || phi > 2.9) break;
          if (!opts.closed && (th < 0.05 || th > Math.PI - 0.05)) break;
        }
        if (pts2.length > 3) curves.push({ pts: pts2, P: new Array(pts2.length) });
      }
      return { pts, rings: rings - 1, per, closed: !!opts.closed, every: opts.every || 0, dim: opts.dim || 1, curves, P: new Array(pts.length) };
    }
    const fold = (phi, th) => Math.sin(9 * phi + 3 * Math.sin(4 * th)) * Math.sin(7 * th + 2 * Math.sin(3 * phi)) * 0.7 + Math.sin(17 * th + 5 * phi + 2 * Math.sin(6 * th)) * 0.3;
    const full = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.8);
    // the cerebrum: a fullish superellipsoid, the frontal lobe round and
    // deep, the top domed, the occipital lobe sloping down at the back,
    // and the underside cut away above the temporal lobe
    const cerebrum = (side) => makeMesh(26, 44, (phi, th) => {
      const sp = Math.sin(phi);
      let x = full(sp * Math.sin(th)), y = full(-Math.cos(phi)), z = full(sp * Math.cos(th));
      x *= 0.5; y *= 0.58; z *= 0.92;
      const front = clamp01((z - 0.35) / 0.6);
      x *= 1 - front * front * 0.22; y += front * front * 0.12;             // frontal lobe: rounder, lower at the tip
      const back = clamp01((-z - 0.35) / 0.6);
      y += back * back * 0.16;                                              // occipital: the back slopes down
      if (y > 0.1 && z > -0.3) y = 0.1 + (y - 0.1) * 0.25 + clamp01((z + 0.3) / 0.4) * 0.02;   // the lateral fissure: flat above the temporal lobe
      else if (y > 0.28) y = 0.28 + (y - 0.28) * 0.6;
      const wr = fold(phi, th), k = 1 + wr * 0.05;
      return { x: side * x * k, y: y * k, z: z * k, wr };
    }, { gyri: 90 });
    // the temporal lobe: a thumb under the fissure, tip forward
    const temporal = (side) => makeMesh(14, 22, (phi, th) => {
      const sp = Math.sin(phi), zl = Math.cos(phi);                          // phi runs tip (front) to back
      const taper = 1 - clamp01(zl) * 0.35;
      const wr = fold(phi * 2, th * 1.5), k = 1 + wr * 0.045;
      return { x: side * (0.3 + 0.19 * sp * Math.cos(th) * taper) * k, y: (0.3 + 0.16 * sp * Math.sin(th) * taper) * k, z: (0.12 + 0.5 * zl) * k, wr };
    }, { closed: true, gyri: 24 });
    // the cerebellum: under the back, ridged in horizontal folia
    const cerebellum = (side) => makeMesh(18, 26, (phi, th) => {
      const sp = Math.sin(phi), wr = Math.sin(18 * phi) * 0.9, k = 1 + wr * 0.04;
      return { x: side * 0.18 + side * 0.22 * sp * Math.sin(th) * k, y: 0.36 + 0.17 * -Math.cos(phi) * k, z: -0.56 + 0.26 * sp * Math.cos(th) * k, wr };
    }, { closed: true, every: 1 });
    // the brainstem: a tube down from the middle, leaning back
    const brainstem = makeMesh(10, 18, (phi, th) => {
      const t = phi / Math.PI, r = 0.11 - t * 0.03;
      return { x: r * Math.cos(th), y: 0.28 + t * 0.6, z: -0.22 - t * 0.16 + r * Math.sin(th), wr: 0 };
    }, { closed: true, every: 3 });
    const hemis = [
      { side: -1, meshes: [cerebrum(-1), temporal(-1), cerebellum(-1)], env: 0, avg: 0.2, peak: 0.3, scale: 1, pulse: 0 },
      { side: 1, meshes: [cerebrum(1), temporal(1), cerebellum(1)], env: 0, avg: 0.2, peak: 0.3, scale: 1, pulse: 0 },
    ];
    // ── the corpus callosum: a dense bridge of fibres arching over the
    // midline from one hemisphere to the other, each ending in a little
    // terminal tuft. A firing cell sends pulses across a few of them and
    // a pulse arriving fires a cell on the far side.
    const FIBRES = 56, fibres = [];
    for (let i = 0; i < FIBRES; i++) {
      const z = -0.42 + (i / (FIBRES - 1)) * 0.82 + (rnd() - 0.5) * 0.03, arch = -0.02 - 0.16 * (1 - Math.pow(z / 0.45, 2));
      const yl = arch + (rnd() - 0.5) * 0.12, yr = arch + (rnd() - 0.5) * 0.12, xl = 0.2 + rnd() * 0.22, xr = 0.2 + rnd() * 0.22;
      const A = [-xl, yl + 0.08, z + (rnd() - 0.5) * 0.06], M = [0, arch, z], B = [xr, yr + 0.08, z + (rnd() - 0.5) * 0.06];
      const pts = [];
      for (let k = 0; k <= 9; k++) { const t = k / 9, u = 1 - t; pts.push([u * u * A[0] + 2 * u * t * M[0] + t * t * B[0], u * u * A[1] + 2 * u * t * (M[1] - 0.1) + t * t * B[1], u * u * A[2] + 2 * u * t * M[2] + t * t * B[2]]); }
      const tuft = (P, dir) => [0, 1].map(() => { const d = [dir + (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.6], l = Math.hypot(d[0], d[1], d[2]) || 1; return [P[0] + d[0] / l * 0.07, P[1] + d[1] / l * 0.07, P[2] + d[2] / l * 0.07]; });
      fibres.push({ pts, tuftA: tuft(A, -1), tuftB: tuft(B, 1), P: new Array(pts.length), pulse: -1, dir: 1, t0: 0 });
    }
    const CROSS_MS = 700;
    function crossFrom(side, now) {
      for (let k = 0; k < 3; k++) { const f = fibres[Math.floor(rnd() * FIBRES)]; if (f.pulse < 0) { f.pulse = 0; f.dir = side; f.t0 = now; } }
    }
    // ── neurons
    const N = 22, neurons = [];
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const jitter = (d, a) => norm([d[0] + (rnd() - 0.5) * a, d[1] + (rnd() - 0.5) * a, d[2] + (rnd() - 0.5) * a]);
    function grow(segs, from, dir, len, level, maxLevel, order) {
      const to = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len];
      segs.push({ a: from, b: to, level, order });
      if (level >= maxLevel) return;
      const kids = level === 0 ? 3 : (rnd() < 0.7 ? 2 : 1);
      for (let i = 0; i < kids; i++) grow(segs, to, jitter(dir, 1.6), len * (0.55 + rnd() * 0.2), level + 1, maxLevel, order);
    }
    for (let i = 0; i < N; i++) {
      // the soma somewhere in either hemisphere, off the fissure
      const side = i % 2 ? 1 : -1, a = rnd() * Math.PI * 2, u = 0.3 + Math.cbrt(rnd()) * 0.42;
      const soma = [side * (0.1 + Math.abs(Math.cos(a)) * u * 0.34), -0.12 + Math.sin(a) * u * 0.3, (rnd() - 0.5) * 1.3 * u];
      const dend = [];
      const arms = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < arms; k++) grow(dend, soma, norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), 0.11 + rnd() * 0.06, 0, 3, k);
      neurons.push({ soma, dend, band: i / N, avg: 0.2, fire: -1, t: 0, refr: 0, target: -1, axon: [] });
    }
    // axons: each cell reaches a partner some way off, with a wobble and
    // a few terminal twigs at the far end
    for (let i = 0; i < N; i++) {
      const n = neurons[i]; let best = -1, bd = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const m = neurons[j], d = Math.hypot(m.soma[0] - n.soma[0], m.soma[1] - n.soma[1], m.soma[2] - n.soma[2]);
        const score = d * (0.6 + rnd());               // not always the nearest
        if (best < 0 || score < bd) { best = j; bd = score; }
      }
      n.target = best;
      const m = neurons[best], steps = 6, path = [n.soma];
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, w = Math.sin(t * Math.PI) * 0.12;
        path.push([n.soma[0] + (m.soma[0] - n.soma[0]) * t + (rnd() - 0.5) * w, n.soma[1] + (m.soma[1] - n.soma[1]) * t + (rnd() - 0.5) * w, n.soma[2] + (m.soma[2] - n.soma[2]) * t + (rnd() - 0.5) * w]);
      }
      path[steps] = m.soma;
      n.axon = path;
    }
    const FIRE_MS = 900;                   // one firing, dendrite tips to the far synapse
    function fire(n, now) { if (n.fire >= 0 || now < n.refr) return; n.fire = now; n.refr = now + FIRE_MS * 2.5; crossFrom(n.soma[0] < 0 ? -1 : 1, now); }
    let last = 0, yaw = 0, tick = 0, spont = 0;
    viz.registerMode({
      id: 'brain', label: 'Brain',
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, speed, reactivity, vizUserScale } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
        tick += dt; yaw += dt * speed * (0.1 + 0.4 * Math.pow(Math.cos(yaw), 2));   // slowest side-on, the textbook view
        const react = 0.5 + reactivity * 0.5;
        const maxBin = Math.max(2, Math.floor(freqData.length * 0.7));
        const bandAt = (k, w) => { const c = Math.floor(k * k * (maxBin - 1)); let s = 0, n = 0; for (let i = Math.max(0, c - w); i <= Math.min(maxBin - 1, c + w); i++) { s += freqData[i]; n++; } return s / (n * 255); };
        // the hemispheres: the left rides the bass, the right the mids.
        // Each hit is measured against the band's own recent floor and
        // peak, so a beat reads as a full punch whatever the level, and
        // an envelope with a quick release lets it drop between hits.
        const feed = [bassOf(freqData), bandAt(0.45, 6)];
        for (let h = 0; h < 2; h++) {
          const H = hemis[h], v = feed[h];
          H.avg += (v - H.avg) * (v < H.avg ? 0.02 : 0.005);
          H.peak = Math.max(v, H.peak * Math.pow(0.5, dt));
          const hit = clamp01((v - H.avg) / (H.peak - H.avg + 0.04)) * clamp01((v - 0.03) / 0.1);
          H.env = Math.max(hit, H.env * Math.pow(0.01, dt));
          H.pulse = clamp01(H.env * react);
          H.scale += ((1 + H.pulse * 0.18) - H.scale) * Math.min(1, dt * 45);
        }
        // the neurons: each on its own band, plus the odd spontaneous one so a quiet brain still thinks
        for (const n of neurons) {
          const v = bandAt(0.08 + n.band * 0.9, 2), onset = v / (n.avg + 0.05);
          n.avg = n.avg * 0.9 + v * 0.1;
          if (onset > 1.6 * (1.3 - Math.min(1, react) * 0.3) && v > 0.06) fire(n, now);
        }
        spont += dt; if (spont > 2.5) { spont = 0; fire(neurons[Math.floor(rnd() * N)], now); }
        for (const n of neurons) {
          if (n.fire < 0) continue;
          n.t = (now - n.fire) / FIRE_MS;
          if (n.t >= 0.85 && !n.handed) { n.handed = true; if (rnd() < 0.5) fire(neurons[n.target], now); }   // the synapse: not every pulse gets through
          if (n.t >= 1) { n.fire = -1; n.handed = false; }
        }
        for (const f of fibres) {
          if (f.pulse < 0) continue;
          f.pulse = (now - f.t0) / CROSS_MS;
          if (f.pulse >= 1) {
            f.pulse = -1;
            const far = f.dir < 0 ? 1 : -1, pool = neurons.filter(n => Math.sign(n.soma[0]) === far);
            if (pool.length && rnd() < 0.15) { const n = pool[Math.floor(rnd() * pool.length)]; if (n.fire < 0 && now >= n.refr) { n.fire = now; n.refr = now + FIRE_MS * 2.5; } }
          }
        }
        // camera: yaw about Y, a gentle nod about X, perspective
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        const R = Math.min(VW, VH) * 0.42 * vizUserScale, f = 3.2;
        const cyw = Math.cos(yaw), syw = Math.sin(yaw), tilt = 0.28 + Math.sin(tick * 0.3) * 0.14, ct = Math.cos(tilt), st = -Math.sin(tilt);   // looking down from a little above the front
        const proj = (x, y, z) => {
          const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
          const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
          const sc = f / (f - z2);
          const px = x1 * sc * R, py = y2 * sc * R;
          return [cx + px, cy + py, z2, sc];
        };
        const cellHue = 48;   // the shell now runs the whole wheel, so the cells hold one warm gold
        // shells: each mesh as faintly filled quads lit by their fold
        // (gyri bright, sulci dark) with some rings drawn as contours;
        // the back half faint so the neurons read through it
        // technicolor: every ring its own hue, the rainbow sliding up the
        // rings and back down (Ryan: "cycle technicolor changing as it
        // travels up and down the concentric rings"), the beat lighting it
        const sweep = Math.sin(tick * 0.45 * speed) * 620;
        const ringHue = (u) => (hueBase + u * 420 + sweep + 3600) % 360;
        const place = (mesh, tx, ty, sc) => {
          for (let i = 0; i < mesh.pts.length; i++) { const p = mesh.pts[i]; mesh.P[i] = proj(tx + p.x * sc, ty + p.y * sc, p.z * sc); }
          for (const c of mesh.curves) for (let i = 0; i < c.pts.length; i++) { const p = c.pts[i]; c.P[i] = proj(tx + p.x * sc, ty + p.y * sc, p.z * sc); }
        };
        for (const H of hemis) {
          const gap = 0.07 + H.pulse * 0.07, bounce = H.pulse * 0.06;
          for (const m of H.meshes) place(m, H.side * gap, -bounce, H.scale);
        }
        const stemPulse = (hemis[0].pulse + hemis[1].pulse) / 2;
        place(brainstem, 0, -stemPulse * 0.06, 1 + stemPulse * 0.05);
        const drawMesh = (m, front, pulse) => {
          const P = m.P, per = m.per, cols = m.closed ? per : per - 1;
          for (let r = 0; r < m.rings - 1; r++) {
            for (let i = 0; i < cols; i++) {
              const i1 = (i + 1) % per;
              const a = P[r * per + i], b = P[r * per + i1], c = P[(r + 1) * per + i1], d = P[(r + 1) * per + i];
              const zc = (a[2] + c[2]) / 2;
              if ((zc >= 0) !== front) continue;
              const depth = clamp01((zc + 1.1) / 2.2), wr = (m.pts[r * per + i].wr + m.pts[(r + 1) * per + i1].wr) / 2;
              const lum = 16 + depth * 22 + wr * 16 + pulse * 16, hue = ringHue(m.pts[r * per + i].u) | 0;
              vctx.fillStyle = `hsla(${hue},85%,${lum | 0}%,${((front ? 0.07 + depth * 0.13 : 0.05 + depth * 0.07) * m.dim).toFixed(2)})`;
              vctx.beginPath(); vctx.moveTo(a[0], a[1]); vctx.lineTo(b[0], b[1]); vctx.lineTo(c[0], c[1]); vctx.lineTo(d[0], d[1]); vctx.closePath(); vctx.fill();
              if (m.every && r % m.every === 0) {
                vctx.strokeStyle = `hsla(${hue},90%,${(lum + 22) | 0}%,${((front ? 0.3 + depth * 0.45 : 0.06 + depth * 0.1) * m.dim).toFixed(2)})`;
                vctx.lineWidth = 0.6 + depth * 1.1;
                vctx.beginPath(); vctx.moveTo(a[0], a[1]); vctx.lineTo(b[0], b[1]); vctx.stroke();
              }
            }
          }
        };
        const drawGyri = (m, front, pulse) => {
          for (const c of m.curves) {
            const P = c.P;
            for (let i = 1; i < P.length; i++) {
              const zc = (P[i - 1][2] + P[i][2]) / 2;
              if ((zc >= 0) !== front) continue;
              const depth = clamp01((zc + 1.1) / 2.2), hue = ringHue(c.pts[i].u) | 0;
              vctx.strokeStyle = `hsla(${hue},95%,${(48 + depth * 25 + pulse * 15) | 0}%,${((front ? 0.35 + depth * 0.5 : 0.08 + depth * 0.1) * m.dim).toFixed(2)})`;
              vctx.lineWidth = (1 + depth * 1.4) * P[i][3];
              vctx.beginPath(); vctx.moveTo(P[i - 1][0], P[i - 1][1]); vctx.lineTo(P[i][0], P[i][1]); vctx.stroke();
            }
          }
        };
        const drawShell = (front) => {
          drawMesh(brainstem, front, stemPulse);
          for (const H of hemis) for (const m of H.meshes) { drawMesh(m, front, H.pulse); drawGyri(m, front, H.pulse); }
        };
        // the callosum: fibres arching across, pulses running along them
        const drawCallosum = () => {
          vctx.lineCap = 'round';
          for (const f of fibres) {
            for (let i = 0; i < f.pts.length; i++) { const p = f.pts[i]; f.P[i] = proj(p[0], p[1], p[2]); }
            const P = f.P, n = P.length - 1;
            const head = f.pulse < 0 ? -1 : (f.dir < 0 ? f.pulse : 1 - f.pulse);   // from the left end (0) or the right end (1)
            for (let i = 1; i <= n; i++) {
              const depth = clamp01((P[i][2] + 1.1) / 2.2), at = (i - 0.5) / n;
              const glow = head < 0 ? 0 : clamp01(1 - Math.abs(head - at) / 0.2);
              if (glow > 0.02) { vctx.strokeStyle = `hsla(${cellHue | 0},100%,75%,${(glow * 0.45).toFixed(2)})`; vctx.lineWidth = (3 + glow * 5) * P[i][3]; vctx.beginPath(); vctx.moveTo(P[i - 1][0], P[i - 1][1]); vctx.lineTo(P[i][0], P[i][1]); vctx.stroke(); }
              vctx.strokeStyle = `hsla(${cellHue | 0},70%,${(38 + depth * 15 + glow * 45) | 0}%,${(0.22 + depth * 0.3 + glow * 0.4).toFixed(2)})`;
              vctx.lineWidth = (0.8 + glow * 1.2) * P[i][3];
              vctx.beginPath(); vctx.moveTo(P[i - 1][0], P[i - 1][1]); vctx.lineTo(P[i][0], P[i][1]); vctx.stroke();
            }
            for (const [end, tuft] of [[P[0], f.tuftA], [P[n], f.tuftB]]) {
              const depth = clamp01((end[2] + 1.1) / 2.2);
              vctx.strokeStyle = `hsla(${cellHue | 0},70%,${(40 + depth * 15) | 0}%,${(0.25 + depth * 0.3).toFixed(2)})`; vctx.lineWidth = 0.7 * end[3];
              for (const t of tuft) { const T = proj(t[0], t[1], t[2]); vctx.beginPath(); vctx.moveTo(end[0], end[1]); vctx.lineTo(T[0], T[1]); vctx.stroke(); }
            }
          }
        };
        drawShell(false);
        drawCallosum();
        // neurons: resting dendrites and axons dim; a firing cell lights up
        // from the tips inward, flares at the soma, then sends a pulse down
        // the axon
        vctx.lineCap = 'round';
        const line = (A, B, col, w) => { vctx.strokeStyle = col; vctx.lineWidth = w; vctx.beginPath(); vctx.moveTo(A[0], A[1]); vctx.lineTo(B[0], B[1]); vctx.stroke(); };
        for (const n of neurons) {
          const t = n.fire < 0 ? -1 : n.t;
          for (const sg of n.dend) {
            const A = proj(sg.a[0], sg.a[1], sg.a[2]), B = proj(sg.b[0], sg.b[1], sg.b[2]);
            const depth = clamp01((B[2] + 1.1) / 2.2);
            // the wave: level 3 (tips) lights first, level 0 last, all in by t = 0.35
            const when = (3 - sg.level) / 3 * 0.3, glow = t < 0 ? 0 : clamp01(1 - Math.abs(t - when - 0.05) / 0.22);
            if (glow > 0.02) line(A, B, `hsla(${cellHue | 0},100%,70%,${(glow * 0.35).toFixed(2)})`, (2.5 + glow * 5) * B[3]);
            line(A, B, `hsla(${cellHue | 0},${(50 + glow * 50) | 0}%,${(35 + depth * 20 + glow * 45) | 0}%,${(0.35 + depth * 0.4 + glow * 0.25).toFixed(2)})`, (0.5 + (3 - sg.level) * 0.35 + glow * 1.2) * B[3]);
          }
          const P = [];
          for (const p of n.axon) P.push(proj(p[0], p[1], p[2]));
          const head = t < 0.35 ? -1 : (t - 0.35) / 0.5;      // 0..1 along the axon while the pulse runs
          for (let i = 1; i < P.length; i++) {
            const depth = clamp01((P[i][2] + 1.1) / 2.2), at = (i - 0.5) / (P.length - 1);
            const glow = head < 0 ? 0 : clamp01(1 - Math.abs(head - at) / 0.22);
            if (glow > 0.02) line(P[i - 1], P[i], `hsla(${cellHue | 0},100%,75%,${(glow * 0.4).toFixed(2)})`, (3 + glow * 6) * P[i][3]);
            line(P[i - 1], P[i], `hsla(${cellHue | 0},70%,${(40 + depth * 15 + glow * 45) | 0}%,${(0.3 + depth * 0.35 + glow * 0.3).toFixed(2)})`, (1.3 + glow * 1.5) * P[i][3]);
          }
          const S = proj(n.soma[0], n.soma[1], n.soma[2]), depth = clamp01((S[2] + 1.1) / 2.2);
          const flare = t < 0 ? 0 : clamp01(1 - Math.abs(t - 0.38) / 0.3);
          const r = (4 + flare * 7) * S[3] * vizUserScale;
          if (flare > 0.02) {
            const g = vctx.createRadialGradient(S[0], S[1], 0, S[0], S[1], r * 3);
            g.addColorStop(0, `hsla(${cellHue | 0},100%,80%,${(flare * 0.7).toFixed(2)})`); g.addColorStop(1, `hsla(${cellHue | 0},100%,60%,0)`);
            vctx.fillStyle = g; vctx.beginPath(); vctx.arc(S[0], S[1], r * 3, 0, Math.PI * 2); vctx.fill();
          }
          vctx.fillStyle = `hsla(${cellHue | 0},80%,${(45 + depth * 20 + flare * 35) | 0}%,${(0.6 + depth * 0.4).toFixed(2)})`;
          vctx.beginPath(); vctx.arc(S[0], S[1], r, 0, Math.PI * 2); vctx.fill();
        }
        drawShell(true);
      },
    });
  })();


  // ── Arcade (mode): Space Invaders on an 8-bit console. Everything is
  // drawn on a 256-pixel-wide screen and blown up with no smoothing, so
  // the pixels are fat. The formation marches a step on every beat, the
  // eleven columns light up with eleven bands of the spectrum, and the
  // cannon slides under whichever band jumps and shoots it; a hit
  // invader bursts into pixels and scores. The picture, when there is
  // one, plays behind it posterised to a console palette under
  // scanlines. Ryan: "another visualization themed on 8bit console/
  // arcade games".
  (function () {
    const PW = 256;
    const bits = (rows) => rows.map(r => r.split('').map(c => c === '1'));
    const SPRITES = {
      squid: [bits(['00011000', '00111100', '01111110', '11011011', '11111111', '00100100', '01011010', '10100101']),
              bits(['00011000', '00111100', '01111110', '11011011', '11111111', '01011010', '10000001', '01000010'])],
      crab: [bits(['00100000100', '00010001000', '00111111100', '01101110110', '11111111111', '10111111101', '10100000101', '00011011000']),
             bits(['00100000100', '10010001001', '10111111101', '11101110111', '11111111111', '01111111110', '00100000100', '01000000010'])],
      octo: [bits(['000011110000', '011111111110', '111111111111', '111001100111', '111111111111', '000110011000', '001101101100', '110000000011']),
             bits(['000011110000', '011111111110', '111111111111', '111001100111', '111111111111', '001110011100', '011001100110', '001100001100'])],
      cannon: bits(['0000001000000', '0000011100000', '0000011100000', '0111111111110', '1111111111111', '1111111111111', '1111111111111', '1111111111111']),
      boom: bits(['0001000010000', '0100100100010', '0010000001000', '1000000000001', '0010000001000', '0100100100010', '0001000010000', '0000000000000']),
    };
    const FONT = {
      '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111',
      A: '010101111101101', C: '111100100100111', E: '111100111100111', G: '111100101101111', H: '101101111101101', I: '111010010010111', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '111101101101111', P: '111101111100100', R: '111101111110101', S: '111100111001111', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101101111101', '-': '000000111000000', '<': '001010100010001', '>': '100010001010100',
    };
    const text = (g, str, x, y, color) => { g.fillStyle = color; for (const ch of str) { const f = FONT[ch]; if (f) for (let i = 0; i < 15; i++) if (f[i] === '1') g.fillRect(x + (i % 3), y + ((i / 3) | 0), 1, 1); x += 4; } };
    const sprite = (g, sp, x, y, color) => { g.fillStyle = color; for (let r = 0; r < sp.length; r++) for (let c = 0; c < sp[r].length; c++) if (sp[r][c]) g.fillRect(x + c, y + r, 1, 1); };
    const ROW_COLORS = ['#fc5454', '#fcfc54', '#54fc54', '#54fcfc', '#fc54fc'];
    const ROWS = 5, COLS = 11, CELL_W = 16, CELL_H = 12, KIND = ['squid', 'crab', 'crab', 'octo', 'octo'], SCORE = [30, 20, 20, 10, 10];
    const screen = offscreen();
    // state
    const inv = [];                     // { r, c, alive, boom, respawn }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) inv.push({ r, c, alive: true, boom: 0, respawn: 0 });
    let fx = 0, fy = 0, dir = 1, frame = 0, lastStep = 0, cannonX = 0, cannonTarget = 0, lastShot = 0, score = 0, hi = 0, quiet = 0, wave = 1, last = 0;
    const shots = [], bombs = [], sparks = [];
    const bandAvg = new Float32Array(COLS).fill(0.2);
    let bassAvg = 0.2, stepPulse = 0, beatPulse = 0, lastRespawn = 0;
    const ufo = { alive: false, x: 0, dir: 1, boom: 0 };
    let bunkers = null, bunkerKey = '';
    const PAL = [];                     // a 3-level-per-channel console palette for the picture behind
    for (let i = 0; i < 27; i++) PAL.push([(i % 3) * 110, (((i / 3) | 0) % 3) * 110, ((i / 9) | 0) * 110]);
    viz.registerMode({
      id: 'arcade', label: 'Arcade',
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, reactivity } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
        const PH = Math.max(120, Math.min(200, Math.round(PW * VH / VW)));
        const { c: sc, ctx: g } = screen(PW, PH);
        const react = 0.5 + reactivity * 0.5;
        // ── the sound: eleven bands for the columns, the bass for the march
        const maxBin = Math.max(2, Math.floor(freqData.length * 0.7));
        const level = new Float32Array(COLS), onset = new Float32Array(COLS);
        for (let b = 0; b < COLS; b++) {
          const k0 = Math.pow(b / COLS, 1.7), k1 = Math.pow((b + 1) / COLS, 1.7);
          const i0 = Math.floor(k0 * maxBin), i1 = Math.max(i0 + 1, Math.floor(k1 * maxBin));
          let sum = 0; for (let i = i0; i < i1; i++) sum += freqData[i];
          level[b] = sum / ((i1 - i0) * 255);
          onset[b] = level[b] / (bandAvg[b] + 0.05);
          bandAvg[b] = bandAvg[b] * 0.9 + level[b] * 0.1;
        }
        const bass = bassOf(freqData), energy = energyOf(freqData);
        const beat = bass / (bassAvg + 0.05) > 1.3 * (1.3 - Math.min(1, react) * 0.3) && bass > 0.08;
        bassAvg = bassAvg * 0.95 + bass * 0.05;
        quiet = energy < 0.02 ? quiet + dt : 0;
        // ── the formation marches: a step on the beat, or on its own clock
        if (beat) beatPulse = 1;
        beatPulse *= Math.pow(0.02, dt);
        const stepEvery = 1.1 / speed;
        if ((beat && now - lastStep > 260) || now - lastStep > stepEvery * 1000) {
          lastStep = now; frame ^= 1; stepPulse = 1;
          const span = COLS * CELL_W;
          fx += dir * 4;
          if (fx < 4 || fx + span > PW - 4) { dir = -dir; fx = Math.max(4, Math.min(PW - 4 - span, fx)); fy += 2; }
          if (fy > PH * 0.42) { fy = 0; wave++; }
          if (beat && bass > 0.5 && Math.random() < 0.5) {   // a heavy hit: an invader drops a bomb
            const live = inv.filter(i => i.alive); if (live.length) { const i = live[Math.floor(Math.random() * live.length)]; bombs.push({ x: fx + i.c * CELL_W + 6, y: fy + 18 + i.r * CELL_H + 8, t: 0 }); }
          }
        }
        stepPulse *= Math.pow(0.02, dt);
        if (!inv.some(i => i.alive || i.boom > 0)) { wave++; fy = 0; for (const i of inv) i.alive = true; lastRespawn = now; }
        else if (now - lastRespawn > 7000) { lastRespawn = now; const dead = inv.filter(i => !i.alive && i.boom <= 0); if (dead.length) dead[Math.floor(Math.random() * dead.length)].alive = true; }
        const bassOnset = bass / (bassAvg + 0.05);
        if (!ufo.alive && ufo.boom <= 0 && bassOnset > 2.2 * (1.3 - Math.min(1, react) * 0.3) && bass > 0.35) { ufo.alive = true; ufo.dir = Math.random() < 0.5 ? 1 : -1; ufo.x = ufo.dir > 0 ? -16 : PW; }
        // ── the cannon: it moves with the music and fires on a clock.
        // Position rides the spectrum's centre of weight across the
        // columns, jumping to a band that hits; then it snaps under the
        // nearest live column so the shots land. Fire is regular, about
        // three a second, quicker as the music gets louder (Ryan:
        // "shooting should be rather regular, while the motion of the
        // player could be to the music").
        let wsum = 0, lsum = 0, jump = -1, jumpV = 1.5;
        for (let b = 0; b < COLS; b++) { const w = level[b] * level[b]; wsum += w * b; lsum += w; if (onset[b] > jumpV && level[b] > 0.12) { jump = b; jumpV = onset[b]; } }
        const musicCol = jump >= 0 ? jump : (lsum > 0 ? wsum / lsum : COLS / 2);
        let aim = -1, aimD = 99;
        for (let b = 0; b < COLS; b++) if (inv.some(i => i.c === b && i.alive && i.boom <= 0) && Math.abs(b - musicCol) < aimD) { aim = b; aimD = Math.abs(b - musicCol); }
        if (ufo.alive) cannonTarget = ufo.x + 2;
        else if (aim >= 0) cannonTarget = fx + aim * CELL_W + 2;
        cannonX = Math.max(0, Math.min(PW - 13, cannonX + (cannonTarget - cannonX) * Math.min(1, dt * (12 + 30 * react * energy))));
        const fireEvery = 340 - Math.min(1, energy * 1.5) * 190;
        if (now - lastShot > fireEvery) { lastShot = now; shots.push({ x: (cannonX | 0) + 6, y: PH - 25 }); }
        // ── the picture behind, posterised, dim, and a starfield when there is none
        g.imageSmoothingEnabled = false;
        g.fillStyle = '#000'; g.fillRect(0, 0, PW, PH);
        if (videoFrame) {
          const img = g.createImageData(PW, PH), d = img.data, vf = videoFrame, vd = vf.imageData.data, lumStep = 45 + Math.min(1, energy * 1.5 + beatPulse * 0.5) * 50;
          for (let y = 0; y < PH; y++) {
            const sy = Math.min(vf.h - 1, (y / PH * vf.h) | 0);
            for (let x = 0; x < PW; x++) {
              const sx = Math.min(vf.w - 1, (x / PW * vf.w) | 0), o = (sy * vf.w + sx) * 4, q = (y * PW + x) * 4;
              d[q] = Math.round(vd[o] / 127) * lumStep; d[q + 1] = Math.round(vd[o + 1] / 127) * lumStep; d[q + 2] = Math.round(vd[o + 2] / 127) * lumStep; d[q + 3] = 255;
            }
          }
          g.putImageData(img, 0, 0);
        } else {
          g.fillStyle = '#888';
          for (let i = 0; i < 40; i++) { const sx = (hash(i * 7.1) * PW) | 0, sy = ((hash(i * 3.3) * PH + now * 0.01 * speed * (1 + (i % 3))) % PH) | 0; g.fillRect(sx, sy, 1, 1); }
        }
        // ── HUD
        text(g, 'SCORE<1>', 4, 3, '#fff'); text(g, String(score).padStart(6, '0'), 4, 10, '#54fc54');
        text(g, 'HI-SCORE', PW / 2 - 16, 3, '#fff'); text(g, String(hi).padStart(6, '0'), PW / 2 - 16, 10, '#fc5454');
        text(g, 'WAVE ' + wave, PW - 36, 3, '#fff');
        if (Math.floor(now / 500) % 2) text(g, '1UP', PW - 36, 10, '#fcfc54');
        // ── bunkers: four green shields, eaten by bombs and shots
        const bkey = PH + ':' + wave;
        if (bunkerKey !== bkey) {
          bunkerKey = bkey; bunkers = [];
          for (let b = 0; b < 4; b++) { const bx = 28 + b * 60, by = PH - 44, cells = []; for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) if (!(y > 6 && x > 5 && x < 14) && !(y < 2 && (x < 2 || x > 17))) cells.push([bx + x, by + y]); bunkers.push({ cells }); }
        }
        g.fillStyle = beatPulse > 0.5 ? '#a8ffa8' : '#54fc54'; for (const b of bunkers) for (const [x, y] of b.cells) g.fillRect(x, y, 1, 1);
        if (ufo.alive) {
          ufo.x += ufo.dir * 70 * dt;
          if (ufo.x < -18 || ufo.x > PW + 2) ufo.alive = false;
          const ux = ufo.x | 0, blink = Math.floor(now / 120) % 2;
          g.fillStyle = '#fc5454'; g.fillRect(ux + 5, 14, 6, 1); g.fillRect(ux + 2, 15, 12, 1); g.fillRect(ux, 16, 16, 2); g.fillRect(ux + 2, 18, 12, 1);
          g.fillStyle = blink ? '#fcfc54' : '#fff'; g.fillRect(ux + 3, 16, 1, 1); g.fillRect(ux + 7, 16, 1, 1); g.fillRect(ux + 11, 16, 1, 1);
        } else if (ufo.boom > 0) { ufo.boom -= dt; text(g, '100', (ufo.x | 0) + 2, 14, '#fc5454'); }
        // ── invaders: brightness from their column's band, a lift on the level
        for (const i of inv) {
          const x = fx + i.c * CELL_W, y = fy + 18 + i.r * CELL_H - Math.round(level[i.c] * 6 * react);
          if (i.boom > 0) { i.boom -= dt; sprite(g, SPRITES.boom, x, y, '#fff'); if (i.boom <= 0) i.respawn = now + 4000; continue; }
          if (!i.alive) { if (now >= i.respawn) i.alive = true; else continue; }
          const l = level[i.c], flash = onset[i.c] > 1.5 && l > 0.1, col = flash ? '#fff' : ROW_COLORS[i.r];
          g.globalAlpha = flash ? 1 : 0.4 + 0.6 * Math.min(1, l * 1.8 * react);
          sprite(g, SPRITES[KIND[i.r]][frame], x, y, col);
          g.globalAlpha = 1;
        }
        // ── shots and bombs
        for (let k = shots.length - 1; k >= 0; k--) {
          const sh = shots[k]; sh.y -= 5;
          if (ufo.alive && sh.y <= 22 && sh.x >= ufo.x && sh.x < ufo.x + 16) { ufo.alive = false; ufo.boom = 0.4; score += 100 * wave; hi = Math.max(hi, score); shots.splice(k, 1); for (let n = 0; n < 14; n++) sparks.push({ x: ufo.x + 8, y: 18, vx: (Math.random() - 0.5) * 80, vy: (Math.random() - 0.5) * 80, t: 0.5, col: '#fc5454' }); continue; }
          g.fillStyle = '#fff'; g.fillRect(sh.x, sh.y, 1, 4);
          let hit = null;
          for (const i of inv) { if (!i.alive || i.boom > 0) continue; const x = fx + i.c * CELL_W, y = fy + 18 + i.r * CELL_H; if (sh.x >= x && sh.x < x + 12 && sh.y <= y + 8 && sh.y + 4 >= y && (!hit || i.r > hit.r)) hit = i; }
          if (hit) { hit.alive = false; hit.boom = 0.3; score += SCORE[hit.r] * wave; hi = Math.max(hi, score); shots.splice(k, 1); for (let n = 0; n < 8; n++) sparks.push({ x: sh.x, y: sh.y, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, t: 0.4, col: ROW_COLORS[hit.r] }); continue; }
          if (sh.y < 0) shots.splice(k, 1);
        }
        for (let k = bombs.length - 1; k >= 0; k--) {
          const b = bombs[k]; b.y += 1.5; b.t += dt;
          g.fillStyle = '#fcfc54'; g.fillRect(b.x + (Math.floor(now / 80) % 2), b.y, 1, 3);
          let gone = b.y > PH;
          for (const bk of bunkers) { const n = bk.cells.findIndex(([x, y]) => Math.abs(x - b.x) <= 1 && Math.abs(y - b.y) <= 1); if (n >= 0) { for (let m = 0; m < 6; m++) { const j = bk.cells.findIndex(([x, y]) => Math.abs(x - b.x) <= 2 && Math.abs(y - b.y) <= 2); if (j >= 0) bk.cells.splice(j, 1); } gone = true; break; } }
          if (gone) bombs.splice(k, 1);
        }
        for (let k = sparks.length - 1; k >= 0; k--) { const p = sparks[k]; p.t -= dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.t <= 0) { sparks.splice(k, 1); continue; } g.fillStyle = p.col; g.fillRect(p.x | 0, p.y | 0, 1, 1); }
        // ── the cannon and the ground
        sprite(g, SPRITES.cannon, cannonX | 0, PH - 21, '#54fc54');
        g.fillStyle = '#54fc54'; g.fillRect(0, PH - 11, PW, 1);
        for (let n = 0; n < 3; n++) sprite(g, SPRITES.cannon, 4 + n * 16, PH - 9, '#54fc54');
        if (quiet > 2 && Math.floor(now / 600) % 2) text(g, 'INSERT COIN', PW / 2 - 22, PH / 2, '#fff');
        // ── blow it up, fat pixels, under scanlines, with a nudge on the step
        vctx.imageSmoothingEnabled = false;
        const jog = Math.round(Math.max(stepPulse, beatPulse) * 2 * react) * (VW / PW);
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        vctx.drawImage(sc, 0, 0, PW, PH, jog, 0, VW, VH);
        vctx.fillStyle = scanlines(vctx); vctx.fillRect(0, 0, VW, VH);
        vctx.imageSmoothingEnabled = true;
      },
    });
  })();

  // ── Aurora (mode): northern lights over a ridge line. Five curtains,
  // each listening to its own slice of the spectrum -- the lowest
  // curtain to the bass, the highest to the treble -- so how tall each
  // one reaches is how loud its band is. The folds ripple sideways with
  // Speed, stars twinkle behind, and a bass hit lifts the whole sky.
  (function () {
    const CURTAINS = 5, strips = [];
    for (let c = 0; c < CURTAINS; c++) strips.push(offscreen());
    let stars = null, ridge = null, glow = 0;
    viz.registerMode({
      id: 'aurora', label: 'Aurora',
      init() { glow = 0; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, vizRot, vizUserScale } = ctx;
        if (!stars) {
          stars = Array.from({ length: 170 }, (_, i) => ({ x: hash(i * 3.1), y: hash(i * 7.7) * 0.8, s: 0.6 + hash(i * 1.3) * 1.4, p: hash(i * 5.9) * 6.28 }));
          ridge = Array.from({ length: 81 }, (_, i) => 0.8 + 0.06 * Math.sin(i * 0.23) + 0.04 * Math.sin(i * 0.61 + 1) + 0.025 * hash(i * 2.7));
        }
        const bass = bassOf(freqData);
        glow = Math.max(glow * 0.93, bass);
        const sky = vctx.createLinearGradient(0, 0, 0, VH);
        sky.addColorStop(0, '#01020a');
        sky.addColorStop(1, `hsl(${(hueBase + 220) % 360 | 0},50%,${(5 + glow * 9) | 0}%)`);
        vctx.fillStyle = sky; vctx.fillRect(0, 0, VW, VH);
        for (const st of stars) {
          const tw = 0.5 + 0.5 * Math.sin(vizRot * 5 + st.p);
          vctx.fillStyle = `rgba(255,255,255,${(0.15 + tw * 0.6).toFixed(2)})`;
          vctx.fillRect(st.x * VW, st.y * VH, st.s, st.s);
        }
        // each curtain is one vertical gradient strip, stretched column by
        // column -- far cheaper than a gradient per column
        const maxBin = Math.floor(freqData.length * 0.7), STEP = Math.max(3, (VW / 180) | 0);
        vctx.globalCompositeOperation = 'lighter';
        for (let c = CURTAINS - 1; c >= 0; c--) {
          const lo = Math.floor(Math.pow(c / CURTAINS, 1.6) * maxBin);
          const hi = Math.max(lo + 1, Math.floor(Math.pow((c + 1) / CURTAINS, 1.6) * maxBin));
          let lvl = 0; for (let i = lo; i < hi; i++) lvl += freqData[i]; lvl /= (hi - lo) * 255;
          const hue = (hueBase + 110 + c * 32) % 360;
          const { c: sc, ctx: sx } = strips[c](1, 64);
          const g = sx.createLinearGradient(0, 0, 0, 64);
          g.addColorStop(0, `hsla(${(hue + 60) % 360 | 0},100%,60%,0)`);
          g.addColorStop(0.55, `hsla(${(hue + 30) % 360 | 0},100%,55%,0.35)`);
          g.addColorStop(0.9, `hsla(${hue | 0},100%,70%,0.9)`);
          g.addColorStop(1, `hsla(${hue | 0},100%,85%,0)`);
          sx.clearRect(0, 0, 1, 64); sx.fillStyle = g; sx.fillRect(0, 0, 1, 64);
          const base = VH * (0.62 - c * 0.075), ph = c * 1.9;
          const height = VH * (0.1 + lvl * 0.55) * vizUserScale;
          for (let x = 0; x < VW; x += STEP) {
            const u = x / VW;
            const fold = Math.sin(u * 6 + vizRot * 1.1 + ph) * 0.55 + Math.sin(u * 15 - vizRot * 1.9 + ph * 2) * 0.3 + Math.sin(u * 2.3 + vizRot * 0.4) * 0.15;
            const hem = base + fold * VH * 0.07;
            const rays = 0.5 + 0.5 * Math.sin(u * 41 + vizRot * 2.6 + ph) * Math.sin(u * 13 - vizRot * 0.9);
            vctx.globalAlpha = clamp01((0.2 + 0.8 * rays) * (0.3 + lvl * 1.1) * (0.8 + glow * 0.4));
            const h = height * (0.7 + 0.3 * rays);
            vctx.drawImage(sc, x, hem - h, STEP + 1, h * 1.08);
          }
        }
        vctx.globalAlpha = 1; vctx.globalCompositeOperation = 'source-over';
        vctx.fillStyle = '#010104';
        vctx.beginPath(); vctx.moveTo(0, VH);
        for (let i = 0; i < ridge.length; i++) vctx.lineTo((i / (ridge.length - 1)) * VW, ridge[i] * VH);
        vctx.lineTo(VW, VH); vctx.closePath(); vctx.fill();
      },
    });
  })();

  // ── Flow (mode): a couple of thousand particles riding an invisible
  // current and leaving silk trails. The current is a few slow sine
  // fields added together; the bass twists it harder, the overall
  // energy sweeps the particles along faster. Colour follows heading.
  (function () {
    const N = 1800, BUCKETS = 12;
    let pts = [], lastW = 0, lastH = 0;
    viz.registerMode({
      id: 'flow', label: 'Flow',
      init() { pts = []; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, vizRot, speed, vizUserScale } = ctx;
        const spawn = (p) => { p.x = Math.random() * VW; p.y = Math.random() * VH; p.life = 60 + Math.random() * 180; };
        if (pts.length !== N || VW !== lastW || VH !== lastH) {
          pts = Array.from({ length: N }, () => { const p = {}; spawn(p); return p; });
          lastW = VW; lastH = VH;
          vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        }
        const bass = bassOf(freqData), energy = energyOf(freqData);
        fadeFrame(vctx, VW, VH, 0.05);
        const S = Math.min(VW, VH), k = 3.2 / (S * vizUserScale), t = vizRot * 0.35;
        const twist = 1.3 + bass * 3, step = S * 0.0022 * speed * (0.6 + energy * 3.5);
        const paths = Array.from({ length: BUCKETS }, () => new Path2D());
        for (const p of pts) {
          const u = p.x * k, v = p.y * k;
          const a = (Math.sin(u * 1.1 + t) + Math.cos(v * 1.3 - t * 0.8) + Math.sin((u - v) * 0.7 + t * 0.5)) * twist;
          const nx = p.x + Math.cos(a) * step, ny = p.y + Math.sin(a) * step;
          const b = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * BUCKETS | 0;
          paths[b].moveTo(p.x, p.y); paths[b].lineTo(nx, ny);
          p.x = nx; p.y = ny; p.life -= 1;
          if (p.life <= 0 || nx < 0 || nx > VW || ny < 0 || ny > VH) spawn(p);
        }
        vctx.lineWidth = Math.max(1, S / 500); vctx.lineCap = 'round';
        for (let b = 0; b < BUCKETS; b++) {
          vctx.strokeStyle = `hsla(${(hueBase + b * (140 / BUCKETS)) % 360 | 0},95%,${(55 + energy * 25) | 0}%,0.55)`;
          vctx.stroke(paths[b]);
        }
      },
    });
  })();

  // ── Life (mode): Conway's Game of Life, played to the music. The
  // board steps faster when it's loud, and every onset drops gliders
  // across it -- one per loud band, low bands on the left, high on the
  // right. Newborn cells flash white-hot and cool as they age; dead
  // ones leave an ember. With video playing, the bright parts of the
  // picture keep seeding the board, so it slowly takes on the scene.
  (function () {
    const GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    const grid = offscreen();
    let GW = 0, GH = 0, cur = null, nxt = null, age = null, ember = null;
    let acc = 0, steps = 0, bassAvg = 0, cooldown = 0;
    function reset(w, h) {
      GW = w; GH = h; cur = new Uint8Array(w * h); nxt = new Uint8Array(w * h);
      age = new Uint16Array(w * h); ember = new Float32Array(w * h);
      for (let i = 0; i < cur.length; i++) cur[i] = Math.random() < 0.18 ? 1 : 0;
    }
    function glider(x0, y0) {
      const fx = Math.random() < 0.5, fy = Math.random() < 0.5;
      for (const [gx, gy] of GLIDER) {
        const x = (x0 + (fx ? 2 - gx : gx) + GW) % GW, y = (y0 + (fy ? 2 - gy : gy) + GH) % GH;
        cur[y * GW + x] = 1;
      }
    }
    function step() {
      for (let y = 0; y < GH; y++) {
        const ym = ((y - 1 + GH) % GH) * GW, y0 = y * GW, yp = ((y + 1) % GH) * GW;
        for (let x = 0; x < GW; x++) {
          const xm = (x - 1 + GW) % GW, xp = (x + 1) % GW;
          const n = cur[ym + xm] + cur[ym + x] + cur[ym + xp] + cur[y0 + xm] + cur[y0 + xp] + cur[yp + xm] + cur[yp + x] + cur[yp + xp];
          const i = y0 + x, alive = cur[i] ? (n === 2 || n === 3) : n === 3;
          nxt[i] = alive ? 1 : 0;
          if (alive) age[i] = cur[i] ? Math.min(65535, age[i] + 1) : 0;
          else if (cur[i]) ember[i] = 1;
        }
      }
      const t = cur; cur = nxt; nxt = t; steps++;
    }
    viz.registerMode({
      id: 'life', label: 'Life',
      init() { GW = 0; acc = 0; steps = 0; bassAvg = 0; cooldown = 0; },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
        const w = Math.max(40, Math.round(160 / vizUserScale)), h = Math.max(20, Math.round(w * VH / VW));
        if (w !== GW || h !== GH) reset(w, h);
        const bass = bassOf(freqData), energy = energyOf(freqData);
        bassAvg = bassAvg * 0.92 + bass * 0.08; cooldown = Math.max(0, cooldown - 1);
        if (cooldown === 0 && bass > bassAvg * 1.2 + 0.05) {
          cooldown = 10;
          const BANDS = 8, maxBin = Math.floor(freqData.length * 0.7);
          for (let b = 0; b < BANDS; b++) {
            const lvl = freqData[Math.floor(Math.pow((b + 0.5) / BANDS, 1.5) * maxBin)] / 255;
            if (lvl > 0.45) glider(Math.floor(((b + Math.random()) / BANDS) * GW), Math.floor(Math.random() * GH));
          }
        }
        acc += speed * (0.2 + energy * 0.9);
        let n = 0;
        while (acc >= 1 && n < 4) { acc -= 1; n++; step(); }
        let pop = 0; for (let i = 0; i < cur.length; i++) pop += cur[i];
        if (pop < cur.length * 0.015) {
          // the board died out: a fresh patch of soup somewhere
          const px = (Math.random() * GW) | 0, py = (Math.random() * GH) | 0, r = Math.max(4, GW / 12 | 0);
          for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (Math.random() < 0.35) cur[((py + y + GH) % GH) * GW + ((px + x + GW) % GW)] = 1;
        }
        if (videoFrame && n && steps % 6 === 0) {
          for (let k = 0; k < GW * GH * 0.02; k++) {
            const x = (Math.random() * GW) | 0, y = (Math.random() * GH) | 0;
            if (lumAt(videoFrame, (x + 0.5) * VW / GW, (y + 0.5) * VH / GH, VW, VH) > 0.7) cur[y * GW + x] = 1;
          }
        }
        // age -> colour, white-hot at birth cooling to the drifting hue
        const hsl = (hh, ss, ll) => {
          const a = ss * Math.min(ll, 1 - ll), f = (m) => { const kk = (m + hh / 30) % 12; return ll - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); };
          return [f(0) * 255, f(8) * 255, f(4) * 255];
        };
        const LUT = []; for (let a = 0; a < 32; a++) LUT.push(hsl((hueBase + a * 4) % 360, 0.9, 0.9 - Math.min(a, 24) * 0.014));
        const EMB = hsl((hueBase + 200) % 360, 0.8, 0.35);
        const { c, ctx: gc } = grid(GW, GH);
        const img = gc.createImageData(GW, GH), d = img.data;
        for (let i = 0; i < cur.length; i++) {
          const o = i * 4;
          if (cur[i]) { const col = LUT[Math.min(31, age[i])]; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; }
          else { const e = ember[i]; if (e > 0.02) { d[o] = EMB[0] * e; d[o + 1] = EMB[1] * e; d[o + 2] = EMB[2] * e; ember[i] = e * 0.9; } else ember[i] = 0; }
          d[o + 3] = 255;
        }
        gc.putImageData(img, 0, 0);
        vctx.imageSmoothingEnabled = false;
        vctx.drawImage(c, 0, 0, VW, VH);
        vctx.imageSmoothingEnabled = true;
        // a fine grid over the cells, so they read as cells
        const cw = VW / GW, ch = VH / GH;
        if (cw >= 5) {
          vctx.strokeStyle = 'rgba(0,0,0,0.45)'; vctx.lineWidth = 1; vctx.beginPath();
          for (let x = 1; x < GW; x++) { vctx.moveTo(x * cw, 0); vctx.lineTo(x * cw, VH); }
          for (let y = 1; y < GH; y++) { vctx.moveTo(0, y * ch); vctx.lineTo(VW, y * ch); }
          vctx.stroke();
        }
      },
    });
  })();

  // ── Tree (mode): a fractal tree that grows to the music. Each level
  // of branching listens to its own band -- the trunk to the bass, the
  // twigs to the treble -- which sets how wide that level spreads; the
  // crown sways in a wind that follows the energy. Beats shake glowing
  // blossoms loose from the tips, and they drift down to the ground.
  (function () {
    const DEPTH = 10;
    let petals = [], bassAvg = 0, cooldown = 0;
    viz.registerMode({
      id: 'tree', label: 'Tree',
      init() { petals = []; bassAvg = 0; cooldown = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, speed, vizUserScale } = ctx;
        const bass = bassOf(freqData), energy = energyOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        const band = [];
        for (let d = 0; d < DEPTH; d++) band.push(freqData[Math.floor(Math.pow((d + 0.5) / DEPTH, 1.4) * maxBin)] / 255);
        const bg = vctx.createLinearGradient(0, 0, 0, VH);
        bg.addColorStop(0, '#03020a'); bg.addColorStop(1, `hsl(${(hueBase + 260) % 360 | 0},40%,8%)`);
        vctx.fillStyle = bg; vctx.fillRect(0, 0, VW, VH);
        const groundY = cy + VH * 0.44;
        const gg = vctx.createRadialGradient(cx, groundY, 0, cx, groundY, VW * 0.4);
        gg.addColorStop(0, `hsla(${(hueBase + 300) % 360 | 0},80%,50%,${(0.15 + bass * 0.25).toFixed(2)})`); gg.addColorStop(1, 'rgba(0,0,0,0)');
        vctx.fillStyle = gg; vctx.fillRect(0, groundY - VH * 0.2, VW, VH * 0.4);
        // collect every branch into one path per depth, tips separately
        const paths = Array.from({ length: DEPTH }, () => new Path2D()), tips = [];
        const wind = Math.sin(vizRot * 1.3) * (0.04 + energy * 0.12) + Math.sin(vizRot * 3.1) * 0.02;
        const grow = (x, y, ang, len, d, id) => {
          const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
          paths[d].moveTo(x, y); paths[d].lineTo(x2, y2);
          if (d === DEPTH - 1) { tips.push([x2, y2]); return; }
          const spread = 0.22 + band[d] * 0.55, j = hash(id * 1.37);
          const sway = wind * (d + 1) * 0.35;
          grow(x2, y2, ang - spread * (0.8 + 0.4 * j) + sway, len * (0.7 + 0.08 * hash(id * 2.9)), d + 1, id * 2);
          grow(x2, y2, ang + spread * (0.8 + 0.4 * (1 - j)) + sway, len * (0.7 + 0.08 * hash(id * 4.3)), d + 1, id * 2 + 1);
        };
        grow(cx, groundY, -Math.PI / 2 + wind * 0.3, VH * 0.2 * vizUserScale * (0.9 + bass * 0.2), 0, 1);
        vctx.lineCap = 'round';
        for (let d = 0; d < DEPTH; d++) {
          const k = d / (DEPTH - 1);
          vctx.lineWidth = Math.max(1, (VH / 60) * vizUserScale * Math.pow(0.68, d));
          vctx.strokeStyle = `hsl(${(hueBase + 20 + k * 120) % 360 | 0},${(30 + k * 60) | 0}%,${(20 + k * 45 + band[d] * 20) | 0}%)`;
          vctx.stroke(paths[d]);
        }
        // blossoms at the tips, glowing with the treble
        const treble = band[DEPTH - 1], r = Math.max(1.5, VH / 260) * (1 + treble * 1.5);
        vctx.globalCompositeOperation = 'lighter';
        vctx.fillStyle = `hsla(${(hueBase + 320) % 360 | 0},100%,70%,${(0.25 + treble * 0.6).toFixed(2)})`;
        vctx.beginPath();
        for (const [x, y] of tips) { vctx.moveTo(x + r, y); vctx.arc(x, y, r, 0, Math.PI * 2); }
        vctx.fill();
        bassAvg = bassAvg * 0.92 + bass * 0.08; cooldown = Math.max(0, cooldown - 1);
        if (cooldown === 0 && bass > bassAvg * 1.2 + 0.05) {
          cooldown = 8;
          for (let n = 0; n < 12 + bass * 30; n++) {
            const [x, y] = tips[(Math.random() * tips.length) | 0];
            petals.push({ x, y, vx: (Math.random() - 0.5) * 1.5, vy: -Math.random(), life: 1, hue: (hueBase + 300 + Math.random() * 60) % 360, ph: Math.random() * 6.28 });
          }
        }
        for (let i = petals.length - 1; i >= 0; i--) {
          const p = petals[i];
          p.vy = Math.min(p.vy + 0.04 * speed, 1.6); p.x += (p.vx + Math.sin(vizRot * 4 + p.ph) * 0.8 + wind * 20) * speed; p.y += p.vy * speed;
          if (p.y >= groundY) { p.y = groundY; p.vx = 0; p.vy = 0; p.life -= 0.02 * speed; } else p.life -= 0.003 * speed;
          if (p.life <= 0) { petals.splice(i, 1); continue; }
          vctx.fillStyle = `hsla(${p.hue | 0},100%,70%,${p.life.toFixed(2)})`;
          vctx.beginPath(); vctx.arc(p.x, p.y, r * 1.2, 0, Math.PI * 2); vctx.fill();
        }
        if (petals.length > 800) petals.splice(0, petals.length - 800);
        vctx.globalCompositeOperation = 'source-over';
      },
    });
  })();

  // ── Warp (mode): two warp drives at once. The stars are TNG-style
  // warp streaks, blue-white and stretched by how fast you're going.
  // As the music gets louder the 2001 Star Gate opens around them: two
  // walls of light above and below a thin horizontal slot, rushing past
  // toward the camera, each lane of the walls lit by its own band of
  // the spectrum. A big bass hit "engages" -- the streaks snap long and
  // a warp flash bursts from the vanishing point; smaller kicks give
  // the streaks a shorter jolt. Between hits the drive follows how loud
  // the track is *for itself*, so a loud passage of a quiet recording
  // still goes to warp speed.
  (function () {
    const N = 360, BANDS = 16, stars = [], gate = offscreen();
    let last = 0, travel = 0, open = 0.2, flash = 0, stretch = 0, drive = 0;
    let floor = 0, ceil = 0, hold = 0, armed = true, peakWin = 0, energyLong = 0.15, kickCool = 0, flashCool = 0;
    const spawn = (st, far) => {
      const a = Math.random() * Math.PI * 2, r = 0.04 + Math.random() * 1.2;
      st.x = Math.cos(a) * r; st.y = Math.sin(a) * r; st.z = far ? 1 : 0.05 + Math.random() * 0.95;
      st.tint = Math.random() < 0.85 ? 215 : (Math.random() < 0.5 ? 0 : 30);   // mostly blue-white, the odd warm one
    };
    for (let i = 0; i < N; i++) { const st = {}; spawn(st, false); stars.push(st); }
    viz.registerMode({
      id: 'warp', label: 'Warp',
      init() {
        last = 0; open = 0.2; flash = 0; stretch = 0; drive = 0;
        floor = 0; ceil = 0; hold = 0; armed = true; peakWin = 0; energyLong = 0.15; kickCool = 0; flashCool = 0;
      },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, kickRaw, speed, reactivity, vizUserScale } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
        const bass = bassOf(freqData), energy = energyOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        // the kick drum alone (~20-150Hz at a 2048 FFT; bassOf spans up to
        // ~1.3kHz, where bass lines, vocals and guitars bury the kick),
        // taken before the React slider's scaling so React can't pin it
        // at full and hide the beat -- React tunes the thresholds below
        const kick = kickRaw;
        const react = 0.5 + reactivity * 0.5, ease = (tau) => 1 - Math.exp(-dt / tau);
        const bands = new Float32Array(BANDS);
        for (let b = 0; b < BANDS; b++) bands[b] = freqData[Math.floor(Math.pow((b + 0.5) / BANDS, 1.6) * maxBin)] / 255;
        // engage: track the bass's own floor and ceiling, and call it a kick
        // when it climbs most of the way from one to the other -- relative
        // to this track's swing, so it works whether the bass sits low or
        // high (a fixed "30% over average" can't be reached once it sits
        // high). Every kick jolts the streaks; a kick that reaches the
        // loudest bass in a while also fires the flash.
        kickCool = Math.max(0, kickCool - dt); flashCool = Math.max(0, flashCool - dt); peakWin = Math.max(0, peakWin - dt);
        floor += (kick - floor) * ease(kick < floor ? 0.12 : 0.8);
        ceil = kick > ceil ? kick : ceil + (kick - ceil) * ease(1.2);
        hold = kick > hold ? kick : hold + (kick - hold) * ease(3);
        const swing = ceil - floor, pos = (kick - floor) / Math.max(swing, 0.035 / react);
        if (pos < 0.45) armed = true;
        if (armed && kickCool === 0 && pos > 0.7 - 0.1 * (react - 1) && swing > 0.012 / react) {
          armed = false; kickCool = 0.12; peakWin = 0.2;
          stretch = Math.max(stretch, 0.5 + 0.5 * clamp01(swing * react * 5));
        }
        // the flash is judged at the kick's peak, a moment after its onset:
        // one of the hardest kicks lately, or just a big one
        if (peakWin > 0 && flashCool === 0 && (kick >= hold - 0.05 / react || swing * react > 0.15)) {
          flash = Math.max(flash, 0.6 + 0.4 * clamp01(swing * react * 5)); stretch = 1;
          flashCool = 0.8 / react; peakWin = 0;
        }
        flash = Math.max(0, flash - dt * 1.6); stretch = Math.max(0, stretch - dt * 1.2);
        // drive: loudness relative to the track's own recent average, quick
        // to spool up and slower to drop out of warp
        energyLong += (energy - energyLong) * ease(6);
        const driveTo = clamp01(((energy / Math.max(0.03, energyLong)) - 0.95) * 2.5 * react + energy * react * 0.5);
        drive += (driveTo - drive) * ease(driveTo > drive ? 0.25 : 0.9);
        open += (Math.max(0.2, clamp01((energy - 0.1) * 3 * react), drive) - open) * Math.min(1, dt * 1.5);
        travel += dt * speed * (0.8 + energy * 4 + drive * 4 + stretch * 4);

        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);

        // the Star Gate, per pixel on a small buffer then blown up soft.
        // Each row above/below the slot is a slice of a floor/ceiling
        // plane: depth from its distance to the slot, lanes across it.
        const GW = 200, GH = Math.max(60, Math.round(GW * VH / VW));
        const { c, ctx: gc } = gate(GW, GH);
        const img = gc.createImageData(GW, GH), d = img.data;
        const mid = GH / 2, slot = GH * 0.035, K = GH * 0.5;
        for (let j = 0; j < GH; j++) {
          const dy = j + 0.5 - mid, ady = Math.abs(dy);
          if (ady < slot) continue;
          const z = K / ady;                                   // 1 at the screen edge, growing toward the slot
          const fog = 1 / (1 + (z / 4.5) * (z / 4.5));         // far lanes melt into the slot's glow (and stay clear of moire)
          const top = dy < 0, uo = top ? 17.3 : 0, v = z * 1.4 + travel * 3 + (top ? 5.1 : 0);
          for (let i = 0; i < GW; i++) {
            const u = ((i + 0.5) / GW - 0.5) * z * 5 + uo;
            const lane = Math.floor(u * 1.5);
            const lvl = bands[((lane % BANDS) + BANDS) % BANDS];
            const s1 = 0.5 + 0.5 * Math.sin(u * 9 + Math.sin(v * 0.6 + lane) * 1.6);
            const streak = s1 * s1 * s1 * s1 * s1 * s1;
            const cells = 0.5 + 0.5 * Math.sin(v * 2.2 + lane * 1.7);
            const val = Math.min(1, streak * (0.35 + 0.65 * cells) * (0.25 + lvl * 1.3) * fog * open * 2.1);
            if (val < 0.01) continue;
            const h6 = (((hueBase + lane * 47 + v * 5) % 360 + 360) % 360) / 60, sat = 0.9 - streak * 0.45;
            const f = (n) => { const k = (n + h6) % 6; return val * (1 - sat * Math.max(0, Math.min(k, 4 - k, 1))); };
            const o = (j * GW + i) * 4;
            d[o] = f(5) * 255; d[o + 1] = f(3) * 255; d[o + 2] = f(1) * 255; d[o + 3] = 255;
          }
        }
        gc.putImageData(img, 0, 0);
        const gw = VW * vizUserScale, gh = VH * vizUserScale;
        vctx.globalCompositeOperation = 'lighter';
        vctx.imageSmoothingEnabled = true;
        vctx.drawImage(c, cx - gw / 2, cy - gh / 2, gw, gh);
        // the slot itself: a thin line of white light where both walls meet
        const sg = vctx.createLinearGradient(0, cy - VH * 0.06, 0, cy + VH * 0.06);
        sg.addColorStop(0, 'rgba(0,0,0,0)');
        sg.addColorStop(0.5, `hsla(${(hueBase + 200) % 360 | 0},60%,88%,${(0.25 + open * 0.55).toFixed(2)})`);
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        vctx.fillStyle = sg; vctx.fillRect(0, cy - VH * 0.06, VW, VH * 0.12);

        // the warp streaks: each star drawn from where it was a moment
        // ago to where it is now, so speed is literally streak length
        const f0 = Math.min(VW, VH) * 0.5 * vizUserScale;
        const v = dt * speed * (0.25 + energy * 0.8 + drive * 1.4 + stretch * 2.2);
        const tail = 5 + drive * 6 + stretch * 12;
        vctx.lineCap = 'round';
        for (const st of stars) {
          st.z -= v;
          if (st.z <= 0.03) { spawn(st, true); continue; }
          const z0 = Math.min(1.2, st.z + v * tail);
          const x1 = cx + st.x / st.z * f0, y1 = cy + st.y / st.z * f0;
          const x0 = cx + st.x / z0 * f0, y0 = cy + st.y / z0 * f0;
          if (x1 < -50 || x1 > VW + 50 || y1 < -50 || y1 > VH + 50) { spawn(st, true); continue; }
          const near = 1 - st.z;
          vctx.strokeStyle = `hsla(${st.tint},${st.tint === 215 ? 70 : 90}%,${(70 + near * 28) | 0}%,${(0.2 + near * 0.8).toFixed(2)})`;
          vctx.lineWidth = 0.5 + near * 2.5;
          vctx.beginPath(); vctx.moveTo(x0, y0); vctx.lineTo(x1, y1); vctx.stroke();
        }

        // the warp flash: a burst from the vanishing point with a long
        // horizontal flare through it
        if (flash > 0) {
          const R = Math.hypot(VW, VH) * (0.15 + (1 - flash) * 0.6);
          const g = vctx.createRadialGradient(cx, cy, 0, cx, cy, R);
          g.addColorStop(0, `rgba(255,255,255,${(flash * 0.95).toFixed(2)})`);
          g.addColorStop(0.25, `hsla(210,100%,75%,${(flash * 0.5).toFixed(2)})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          vctx.fillStyle = g; vctx.fillRect(0, 0, VW, VH);
          vctx.save();
          vctx.translate(cx, cy); vctx.scale(1, 0.03);
          const fl = vctx.createRadialGradient(0, 0, 0, 0, 0, VW * 0.6);
          fl.addColorStop(0, `rgba(255,255,255,${flash.toFixed(2)})`); fl.addColorStop(1, 'rgba(120,170,255,0)');
          vctx.fillStyle = fl; vctx.beginPath(); vctx.arc(0, 0, VW * 0.6, 0, Math.PI * 2); vctx.fill();
          vctx.restore();
        }
        vctx.globalCompositeOperation = 'source-over';
      },
    });
  })();

  // ── Cymatics (mode): sand on a vibrating Chladni plate. The plate
  // rings in one of its standing-wave modes -- which one follows where
  // the music sits in the spectrum, simple figures for bass-heavy
  // passages and intricate ones for bright ones -- and the sand shakes
  // off the parts that move and piles up on the nodal lines that don't.
  // A bass hit retunes the plate, so the sand scatters and walks to the
  // new figure; louder music shakes it harder.
  (function () {
    const N = 5000, px = new Float32Array(N), py = new Float32Array(N), field = offscreen(), FW = 72, RINGS = 12;
    // (n, m) plate modes, roughly simple -> intricate
    const PAIRS = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [2, 5], [1, 5], [3, 5], [4, 5], [2, 7], [3, 7], [5, 6], [4, 7], [5, 7], [6, 7], [5, 8], [7, 8]];
    let cur = 0, prev = 0, mix = 1, last = 0, bassAvg = 0, cooldown = 0, idle = 0, centroidAvg = 0.1;
    const chladni = (n, m, u, v) => Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * v) - Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * v);
    // how hard the plate moves at (u, v), morphing from the old mode to the new one
    const amp = (u, v) => {
      const [n1, m1] = PAIRS[cur];
      if (mix >= 1) return Math.abs(chladni(n1, m1, u, v));
      const [n0, m0] = PAIRS[prev];
      return Math.abs(chladni(n0, m0, u, v) * (1 - mix) + chladni(n1, m1, u, v) * mix);
    };
    const scatter = () => { for (let i = 0; i < N; i++) { px[i] = Math.random(); py[i] = Math.random(); } };
    const hsl = (h, s, l) => {
      const a = s * Math.min(l, 1 - l), f = (k0) => { const k = (k0 + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
      return [f(0) * 255, f(8) * 255, f(4) * 255];
    };
    scatter();
    viz.registerMode({
      id: 'cymatics', label: 'Cymatics',
      init() { scatter(); cur = prev = 0; mix = 1; last = 0; bassAvg = 0; cooldown = 0; idle = 0; centroidAvg = 0.1; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, speed, vizUserScale } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
        const bass = bassOf(freqData), energy = energyOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        let sw = 0, sum = 0;
        for (let i = 1; i < maxBin; i++) { sw += freqData[i] * i; sum += freqData[i]; }
        centroidAvg += ((sum ? sw / sum / maxBin : 0) - centroidAvg) * Math.min(1, dt * 2);
        // retune on a bass hit (or after a long quiet stretch) to the
        // plate mode that matches the spectrum's centre of mass
        bassAvg = bassAvg * 0.95 + bass * 0.05; cooldown = Math.max(0, cooldown - dt); idle += dt * speed;
        if (cooldown === 0 && (bass > bassAvg * 1.25 + 0.06 || idle > 10)) {
          let next = Math.min(PAIRS.length - 1, Math.floor(clamp01(centroidAvg * 2.5) * PAIRS.length));
          if (next === cur) next = cur === PAIRS.length - 1 || (cur > 0 && Math.random() < 0.5) ? cur - 1 : cur + 1;
          prev = cur; cur = next; mix = 0; cooldown = 2.5; idle = 0;
        }
        mix = Math.min(1, mix + dt * 1.5);
        // shake: every grain takes a random step sized by how much the
        // plate moves under it, so grains wander off antinodes and come
        // to rest where the plate is still -- plus a little drift down
        // the vibration's slope, which is what sharpens the lines. Speed
        // is scaled 3x here so the slider's 1x lands on lively motion
        // (it used to take Speed 3 to get the sand walking)
        const shake = (0.012 + energy * 0.05) * speed * 3 * Math.min(3, dt * 60), E = 0.004, pull = shake * 0.01 / E;
        for (let i = 0; i < N; i++) {
          const x = px[i], y = py[i], a0 = amp(x, y), a = a0 + 0.004;
          const gx = amp(x + E, y) - a0, gy = amp(x, y + E) - a0;
          let u = x + (Math.random() - 0.5) * a * shake - gx * pull, v = y + (Math.random() - 0.5) * a * shake - gy * pull;
          if (u < 0) u = -u; else if (u > 1) u = 2 - u;
          if (v < 0) v = -v; else if (v > 1) v = 2 - v;
          px[i] = u; py[i] = v;
        }

        vctx.fillStyle = '#050507'; vctx.fillRect(0, 0, VW, VH);
        const L = Math.min(VW, VH) * 0.88 * vizUserScale;
        vctx.save();
        vctx.translate(cx, cy); vctx.rotate(vizRot * 0.1);
        // the plate: still parts in one colour, vibrating parts glowing
        // in the opposite one, brighter the louder it plays
        const { c, ctx: fc } = field(FW, FW);
        const img = fc.createImageData(FW, FW), d = img.data;
        const still = hsl((hueBase + 250) % 360, 0.7, 0.12), hot = hsl((hueBase + 70) % 360, 0.95, 0.5), vibe = 0.25 + energy * 0.6;
        for (let j = 0; j < FW; j++) for (let i = 0; i < FW; i++) {
          const k = Math.min(1, amp((i + 0.5) / FW, (j + 0.5) / FW) * 0.5) * vibe, o = (j * FW + i) * 4;
          d[o] = still[0] + (hot[0] - still[0]) * k; d[o + 1] = still[1] + (hot[1] - still[1]) * k; d[o + 2] = still[2] + (hot[2] - still[2]) * k; d[o + 3] = 255;
        }
        fc.putImageData(img, 0, 0);
        vctx.imageSmoothingEnabled = true;
        vctx.drawImage(c, -L / 2, -L / 2, L, L);
        vctx.strokeStyle = `hsl(${(hueBase + 200) % 360 | 0},60%,${45 + bass * 30 | 0}%)`;
        vctx.lineWidth = Math.max(2, L / 160);
        vctx.strokeRect(-L / 2, -L / 2, L, L);
        // the sand, in rainbow rings from the centre out: one path per
        // ring, each ring lit by its own band -- bass in the middle,
        // treble at the corners
        const r = Math.max(1, L / 300), rings = Array.from({ length: RINGS }, () => new Path2D());
        for (let i = 0; i < N; i++) {
          const k = Math.min(RINGS - 1, (Math.hypot(px[i] - 0.5, py[i] - 0.5) * 1.414 * RINGS) | 0);
          rings[k].rect(-L / 2 + px[i] * L - r / 2, -L / 2 + py[i] * L - r / 2, r, r);
        }
        vctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < RINGS; k++) {
          const lvl = freqData[Math.floor(Math.pow((k + 0.5) / RINGS, 1.5) * maxBin)] / 255, hue = (hueBase + k * 300 / RINGS) % 360 | 0;
          // a soft halo under the grains, then the grains themselves
          vctx.save();
          vctx.shadowColor = `hsla(${hue},100%,60%,${(0.4 + lvl * 0.6).toFixed(2)})`; vctx.shadowBlur = r * (2 + lvl * 6);
          vctx.fillStyle = `hsl(${hue},${(75 + lvl * 25) | 0}%,${(50 + lvl * 30) | 0}%)`;
          vctx.fill(rings[k]);
          vctx.restore();
        }
        vctx.globalCompositeOperation = 'source-over';
        vctx.restore();
      },
    });
  })();

  // Orrery: a little solar system seen at a tilt. Each planet is one
  // band of the spectrum -- bass close in, treble far out -- swelling
  // and glowing with its band and trailing a plume of smoke behind
  // it and a fine trail of glitter, a pinch more on every beat. Orbits are a softened Kepler (inner planets lap the outer
  // ones: ~6s a lap closest in, ~40s farthest out at Speed 1) off
  // their own clock, orbitT: it gains what vizRot does (0.006 x Speed
  // a frame) up to 1x, but Speed squared above that, so the slider's
  // 3x top end spins the planets 9x -- a real whirl -- without
  // touching the shared slider's range. An accumulator, so Speed
  // changes never jump. Hence the big multipliers, too. No two orbits
  // share a plane: each is inclined (inc, radians) about its own node
  // line (node), so they cross over one another in real 3D, and a
  // planet's depth is where that puts it, not just which half of the
  // ellipse it's on. At the centre, in place of a sun, a black hole:
  // a lensed accretion disc whose bands are the spectrum, breathing
  // with the bass; a beat sends a bright pulse falling inward through
  // the disc until the hole swallows it and the photon ring flashes,
  // and a bass hit blasts an ejection wave back out across the system.
  // Planets behind the hole pass behind it. Out past the last planet,
  // Milliways, the Restaurant at the End of the Universe, makes its own
  // slow lap on a steeply inclined orbit: a Space Quest style red saucer
  // with blue spokes lit by the treble, under a giant 3D yellow M that
  // spins on its mast, kicked faster and flaring on every beat.
  (function () {
    // smoke puffs are one soft blob per 10-degree hue bucket, drawn once
    // and stamped with drawImage -- a radial gradient per puff, a
    // thousand puffs a frame, would be far too slow
    const puffSprites = new Map();
    function puffSprite(hue) {
      const key = Math.round(hue / 10) % 36;
      let c = puffSprites.get(key);
      if (!c) {
        c = document.createElement('canvas'); c.width = c.height = 64;
        const g2 = c.getContext('2d'), g = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, `hsla(${key * 10},35%,72%,1)`); g.addColorStop(0.45, `hsla(${key * 10},30%,55%,0.45)`); g.addColorStop(1, `hsla(${key * 10},25%,40%,0)`);
        g2.fillStyle = g; g2.fillRect(0, 0, 64, 64);
        puffSprites.set(key, c);
      }
      return c;
    }
    const PLANETS = [
      { r: 0.16, size: 0.010, hue: 20,  inc: 0.30, node: 0.4 },
      { r: 0.24, size: 0.016, hue: 45,  inc: 0.12, node: 2.1 },
      { r: 0.33, size: 0.018, hue: 200, inc: 0.05, node: 4.0, moon: true },
      { r: 0.42, size: 0.013, hue: 5,   inc: 0.22, node: 5.3 },
      { r: 0.56, size: 0.034, hue: 30,  inc: 0.16, node: 1.2, moon: true },
      { r: 0.70, size: 0.028, hue: 50,  inc: 0.35, node: 3.3, ring: true },
      { r: 0.83, size: 0.021, hue: 180, inc: 0.09, node: 0.9 },
      { r: 0.95, size: 0.020, hue: 225, inc: 0.27, node: 4.7 },
      // Milliways, the Restaurant at the End of the Universe, out past
      // the last planet where the view of the end of everything (the
      // hole) is best -- on an orbit tipped steeply out of the plane, so
      // it loops up over and down under the rest of the system
      { r: 0.98, size: 0.032, hue: 0, inc: 0.5, node: 1.0, restaurant: true },
    ];
    let flares = [], prevFreq = null, fluxAvg = 0, cooldown = 0, orbitT = 0, smoke = [], lastPos = [], glitter = [], swallow = 0, waves = [], bassAvg = 0, bassCool = 0, prevBass = 0, bassRiseAvg = 0, signSpin = 0, signVel = 0;
    viz.registerMode({
      id: 'orrery', label: 'Orrery',
      // it's all on black, so Rotate should just turn it, not zoom it too
      rotationCover: false,
      init() { flares = []; prevFreq = null; fluxAvg = 0; cooldown = 0; orbitT = 0; smoke = []; lastPos = []; glitter = []; swallow = 0; waves = []; bassAvg = 0; bassCool = 0; prevBass = 0; bassRiseAvg = 0; signSpin = 0; signVel = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, speed, vizUserScale } = ctx;
        orbitT += 0.006 * speed * Math.max(1, speed);
        const energy = energyOf(freqData), bass = bassOf(freqData);
        const maxBin = Math.floor(freqData.length * 0.7);
        const R = Math.min(VW * 0.46, VH * 0.9) * vizUserScale;
        const tilt = 0.34 + 0.08 * Math.sin(vizRot * 0.3);   // the camera slowly nods
        // with rotationCover off, a Rotate leaves the canvas corners outside
        // this frame's (rotated) coordinates -- so fade in screen space,
        // or they'd keep stale pixels forever
        vctx.save(); vctx.setTransform(1, 0, 0, 1, 0, 0);
        fadeFrame(vctx, VW, VH, 0.35);
        vctx.restore();
        // background stars, fixed per position so they hold still, spread
        // over the square the canvas sweeps when rotated so the corners
        // aren't bare either
        const D = Math.hypot(VW, VH);
        for (let i = 0; i < 320; i++) {
          const tw = 0.4 + 0.6 * Math.abs(Math.sin(vizRot * 4 + i));
          vctx.fillStyle = `rgba(255,255,255,${(hash(i * 3.1) * 0.5 * tw).toFixed(2)})`;
          vctx.fillRect(VW / 2 + (hash(i * 7.7) - 0.5) * D, VH / 2 + (hash(i * 1.3) - 0.5) * D, 1.5, 1.5);
        }
        // onsets (spectral flux against its own running average) launch flares
        let flux = 0;
        if (prevFreq && prevFreq.length === freqData.length) for (let i = 0; i < maxBin; i++) { const d = freqData[i] - prevFreq[i]; if (d > 0) flux += d; }
        flux /= (maxBin * 255); prevFreq = Uint8Array.from(freqData);
        fluxAvg = fluxAvg * 0.9 + flux * 0.1; cooldown = Math.max(0, cooldown - 1);
        let burst = false;
        if (cooldown === 0 && flux > fluxAvg * 1.7 + 0.01) { flares.push({ t: 0, hue: (hueBase + 30) % 360 }); cooldown = 12; burst = true; }
        // bass hits blast an ejection wave out of the hole. A kick shows up
        // far more reliably as how fast the bass bins *rise* frame to frame
        // than as their level, which real mixes keep nearly flat -- so
        // either a rise well above the usual rise, or the level poking
        // modestly over its own running average, counts. Harder hits make
        // hotter, brighter waves.
        const rise = Math.max(0, bass - prevBass); prevBass = bass;
        bassRiseAvg = bassRiseAvg * 0.95 + rise * 0.05; bassAvg = bassAvg * 0.92 + bass * 0.08;
        bassCool = Math.max(0, bassCool - 1);
        if (bassCool === 0 && bass > 0.05 && (rise > bassRiseAvg * 4 + 0.02 || bass > bassAvg * 1.1 + 0.03)) {
          waves.push({ t: 0, power: clamp01(Math.max(rise * 8, (bass - bassAvg) * 5)) }); bassCool = 10;
        }
        // a point at angle a along planet p's orbit, in 3D: the orbit's own
        // circle tipped by inc about its node line, then seen by a camera
        // raised so the reference plane squashes to `tilt`. depth is +1
        // nearest the camera, -1 straight behind the sun.
        const lift = Math.sqrt(1 - tilt * tilt);
        const project = (p, a) => {
          const ca = Math.cos(a), sa = Math.sin(a), cn = Math.cos(p.node), sn = Math.sin(p.node), ci = Math.cos(p.inc);
          const x = cn * ca - sn * sa * ci, y = sn * ca + cn * sa * ci, z = sa * Math.sin(p.inc);
          return { x: cx + x * p.r * R, y: cy + (y * tilt - z * lift) * p.r * R, depth: y * lift + z * tilt };
        };
        const trace = (p, a0, a1, steps) => {
          vctx.beginPath();
          for (let k = 0; k <= steps; k++) { const q = project(p, a0 + (a1 - a0) * k / steps); if (k) vctx.lineTo(q.x, q.y); else vctx.moveTo(q.x, q.y); }
        };
        // orbit guides
        vctx.lineWidth = 1;
        for (const p of PLANETS) {
          vctx.strokeStyle = `hsla(${(hueBase + p.hue) % 360 | 0},40%,60%,0.12)`;
          trace(p, 0, Math.PI * 2, 96); vctx.stroke();
        }
        // the black hole's scale and its beat pulses. A beat starts a pulse
        // at the disc's rim that runs inward through the bands (position
        // 1 - t^2.2 of the way out, so it drifts then plunges); reaching
        // the inner edge, it's swallowed and the photon ring flashes.
        const sr = R * (0.06 + bass * 0.015);
        swallow = Math.max(0, swallow - 0.04 * speed);
        const pulses = [];
        for (let i = flares.length - 1; i >= 0; i--) {
          const f = flares[i]; f.t += 0.012 * speed;
          if (f.t >= 1) { flares.splice(i, 1); swallow = 1; continue; }
          pulses.push(1 - Math.pow(f.t, 2.2));
        }
        // ejection waves: the infall run backwards. A wave bursts out of
        // the photon ring and decelerates (radius eases out as
        // 1 - (1-t)^2.5) to just past the outermost orbit. Close in, the
        // same lensing as the disc bends it up into a near-circle round
        // the hole; as it gets clear it flattens down into the orbital
        // plane. It cools as it goes -- white-hot to deep red -- thins,
        // fades, and is Doppler-beamed brighter on the left like the disc.
        // Drawn in halves (drawWaves) so the far half goes behind the
        // hole and disc and the near half in front.
        const waveNow = [];
        for (let i = waves.length - 1; i >= 0; i--) {
          const w = waves[i]; w.t += 0.013 * speed;
          if (w.t >= 1) { waves.splice(i, 1); continue; }
          const r = sr * 1.1 + (R * 1.1 - sr * 1.1) * (1 - Math.pow(1 - w.t, 2.5));
          const near = clamp01(1 - (r - sr) / (R * 0.5));
          waveNow.push({ r, t: w.t, power: w.power, ry: r * (tilt + (1 - tilt) * Math.pow(near, 1.6) * 0.9) });
        }
        const drawWaves = (front) => {
          const a0 = front ? 0 : Math.PI, a1 = front ? Math.PI : Math.PI * 2;
          vctx.globalCompositeOperation = 'lighter';
          for (const w of waveNow) {
            const life = Math.pow(1 - w.t, 1.5), a = life * (0.35 + w.power * 0.5) * (front ? 1 : 0.7);
            const hue = 42 - w.t * 34, L = 88 - w.t * 40;
            const beam = vctx.createLinearGradient(cx - w.r, cy, cx + w.r, cy);
            beam.addColorStop(0, `hsla(${hue | 0},100%,${L | 0}%,${clamp01(a * 1.4).toFixed(2)})`);
            beam.addColorStop(1, `hsla(${(hue - 12) | 0},100%,${(L - 20) | 0}%,${(a * 0.45).toFixed(2)})`);
            // a wide soft shock front under a thin bright leading edge
            vctx.strokeStyle = beam;
            vctx.globalAlpha = 0.35; vctx.lineWidth = sr * (0.5 * (1 - w.t) + 0.15);
            vctx.beginPath(); vctx.ellipse(cx, cy, w.r, w.ry, 0, a0, a1); vctx.stroke();
            vctx.globalAlpha = 1; vctx.lineWidth = Math.max(1, sr * (0.12 * (1 - w.t) + 0.03));
            vctx.beginPath(); vctx.ellipse(cx, cy, w.r, w.ry, 0, a0, a1); vctx.stroke();
          }
          vctx.globalCompositeOperation = 'source-over';
        };
        // place every planet (and its moon) first, so depth order can be sorted
        const bodies = PLANETS.map((p, i) => {
          const band = freqData[Math.floor(Math.pow((i + 0.5) / PLANETS.length, 1.6) * maxBin)] / 255;
          const a = hash(i + 1) * Math.PI * 2 + orbitT * 3 * Math.pow(p.r / 0.16, -1.1);
          const q = project(p, a), persp = 1 + q.depth * 0.18;
          return { p, i, a, band, depth: q.depth, x: q.x, y: q.y, s: p.size * R * persp * (1 + band * 0.7) };
        });
        const hue = (b) => (hueBase + b.p.hue) % 360 | 0;
        // the ring system: a flat, banded disc seen nearly edge-on, not a
        // hoop -- filled annuli (inner and outer edge, in planet radii,
        // plus how dense and how bright each band is), with a dark gap
        // between the two main bands like Saturn's Cassini Division. Each
        // half is filled separately so the far half goes behind the
        // planet and the near half in front of it; the band's own level
        // makes the rings shimmer.
        const RING_BANDS = [[1.25, 1.45, 0.22, 48], [1.47, 1.72, 0.55, 62], [1.72, 1.98, 0.8, 74], [2.07, 2.36, 0.6, 66], [2.40, 2.46, 0.35, 58]];
        const drawRing = (b, front) => {
          const s = b.s, h = hue(b), flat = 0.14 + tilt * 0.3, rot = -0.3;
          const a0 = front ? 0 : Math.PI, a1 = front ? Math.PI : Math.PI * 2;
          for (const [ri, ro, dens, lit] of RING_BANDS) {
            vctx.beginPath();
            vctx.ellipse(b.x, b.y, s * ro, s * ro * flat, rot, a0, a1);
            vctx.ellipse(b.x, b.y, s * ri, s * ri * flat, rot, a1, a0, true);
            vctx.closePath();
            vctx.fillStyle = `hsla(${(h + 15) % 360},${front ? 38 : 30}%,${(lit - (front ? 0 : 12) + b.band * 12) | 0}%,${(dens * (front ? 0.9 : 0.7)).toFixed(2)})`;
            vctx.fill();
          }
          // a hairline at the outer edge catches the light
          vctx.strokeStyle = `hsla(${(h + 15) % 360},50%,85%,${front ? 0.5 : 0.25})`; vctx.lineWidth = Math.max(0.5, s * 0.03);
          vctx.beginPath(); vctx.ellipse(b.x, b.y, s * 2.46, s * 2.46 * flat, rot, a0, a1); vctx.stroke();
        };
        // Milliways, done the way Space Quest drew its burger joint in
        // space: a red saucer, tipped over, with blue spokes round the rim
        // whose tip lights flicker with the treble, and on a blue mast a
        // giant yellow M, outlined red and extruded in blue off a blue
        // backing plate, that flares on every beat
        const M_SHAPE = [[0, 1], [0, 0], [0.22, 0], [0.5, 0.42], [0.78, 0], [1, 0], [1, 1], [0.78, 1], [0.78, 0.38], [0.5, 0.78], [0.22, 0.38], [0.22, 1]];
        const drawRestaurant = (b) => {
          const s = b.s, lvl = b.band, rot = -0.35, rx = s * 1.5, ry = rx * (0.3 + tilt * 0.5);
          const cr = Math.cos(rot), sr2 = Math.sin(rot);
          const onDisc = (a, k) => ({ x: b.x + (Math.cos(a) * rx * cr - Math.sin(a) * ry * sr2) * k, y: b.y + (Math.cos(a) * rx * sr2 + Math.sin(a) * ry * cr) * k });
          const SPOKES = 8, spokeW = Math.max(0.8, s * 0.08);
          const spoke = (k, front) => {
            const a = Math.PI * 2 * k / SPOKES + 0.2;
            if ((Math.sin(a) >= 0) !== front) return;
            const p0 = onDisc(a, 1), p1 = onDisc(a, 1.45);
            vctx.strokeStyle = 'hsl(215,70%,55%)'; vctx.lineWidth = spokeW;
            vctx.beginPath(); vctx.moveTo(p0.x, p0.y); vctx.lineTo(p1.x, p1.y); vctx.stroke();
            const lit = freqData[Math.floor((0.55 + 0.4 * k / SPOKES) * maxBin)] / 255;
            vctx.fillStyle = `hsla(${190 + lit * 30 | 0},100%,${(60 + lit * 30) | 0}%,${(0.4 + lit * 0.6).toFixed(2)})`;
            vctx.beginPath(); vctx.arc(p1.x, p1.y, Math.max(1, s * 0.1 * (0.7 + lit)), 0, Math.PI * 2); vctx.fill();
          };
          for (let k = 0; k < SPOKES; k++) spoke(k, false);
          // the saucer: a darker rim under the red top face
          vctx.fillStyle = 'hsl(355,70%,26%)';
          vctx.beginPath(); vctx.ellipse(b.x, b.y + s * 0.22, rx, ry, rot, 0, Math.PI * 2); vctx.fill();
          const tg = vctx.createRadialGradient(b.x - rx * 0.3, b.y - ry * 0.4, s * 0.1, b.x, b.y, rx);
          tg.addColorStop(0, `hsl(5,90%,${(68 + lvl * 15) | 0}%)`); tg.addColorStop(1, 'hsl(355,80%,42%)');
          vctx.fillStyle = tg;
          vctx.beginPath(); vctx.ellipse(b.x, b.y, rx, ry, rot, 0, Math.PI * 2); vctx.fill();
          // concentric grooves on the deck
          vctx.strokeStyle = 'hsla(355,70%,30%,0.6)'; vctx.lineWidth = Math.max(0.5, s * 0.04);
          for (const k of [0.45, 0.72]) { vctx.beginPath(); vctx.ellipse(b.x, b.y, rx * k, ry * k, rot, 0, Math.PI * 2); vctx.stroke(); }
          for (let k = 0; k < SPOKES; k++) spoke(k, true);
          // the mast, leaning back up off the deck to the sign
          const mx = b.x + s * 0.9, my = b.y - s * 2.3;
          vctx.strokeStyle = 'hsl(215,65%,50%)'; vctx.lineWidth = Math.max(1, s * 0.14);
          vctx.beginPath(); vctx.moveTo(b.x, b.y); vctx.lineTo(mx, my); vctx.stroke();
          // the sign turns on its mast like a rooftop sign: a steady spin
          // that each beat kicks faster, easing back after. Its frame is the
          // turn seen from a little above -- width shrinks by cos, and the
          // far edge dips by sin -- plus a lean. The M is symmetric, so from
          // behind it still reads right. The blue extrusion and backing
          // plate sit along the sign's normal, so they swing from one side
          // to the other as it turns, and edge-on it's just the slab's side.
          const base = 0.03 * speed;
          signVel = base + (signVel - base) * 0.93 + (burst ? 0.22 : 0); signSpin += signVel;
          const W = s * 2.2, H = s * 1.9, flare = burst ? 1 : lvl;
          const cs = Math.cos(signSpin), sn = Math.sin(signSpin), edge = Math.abs(cs) < 0.08 ? 0.08 * Math.sign(cs || 1) : cs;
          const EX = 5, ex = s * 0.09, nx = sn * ex, ny = ex * 0.45;
          vctx.save();
          vctx.translate(mx, my - H * 0.55);
          const frame = (ox, oy) => { vctx.setTransform(base0); vctx.translate(ox, oy); vctx.transform(edge, sn * 0.22, 0.12, 1, 0, 0); };
          const base0 = vctx.getTransform();
          const path = () => {
            vctx.beginPath();
            M_SHAPE.forEach(([px, py], i) => { const x = (px - 0.5) * W, y = (py - 0.5) * H; if (i) vctx.lineTo(x, y); else vctx.moveTo(x, y); });
            vctx.closePath();
          };
          frame(nx * (EX + 1), ny * (EX + 1));
          vctx.fillStyle = 'hsla(225,70%,45%,0.9)';
          vctx.beginPath(); vctx.moveTo(-W * 0.72, -H * 0.38); vctx.lineTo(W * 0.72, -H * 0.58); vctx.lineTo(W * 0.8, H * 0.28); vctx.lineTo(-W * 0.65, H * 0.52); vctx.closePath(); vctx.fill();
          for (let k = EX; k >= 1; k--) { frame(nx * k, ny * k); path(); vctx.fillStyle = `hsl(220,75%,${(28 + k * 3) | 0}%)`; vctx.fill(); }
          frame(0, 0);
          vctx.shadowColor = `hsla(50,100%,60%,${(0.3 + flare * 0.7).toFixed(2)})`; vctx.shadowBlur = s * (0.5 + flare * 2);
          const fg = vctx.createLinearGradient(-W / 2, -H / 2, W / 2, H / 2);
          // it catches the light as it comes round to face the camera
          const shine = Math.abs(cs) * 10;
          fg.addColorStop(0, `hsl(55,100%,${Math.min(97, 72 + shine + flare * 15) | 0}%)`); fg.addColorStop(1, `hsl(42,100%,${(44 + shine + flare * 20) | 0}%)`);
          path(); vctx.fillStyle = fg; vctx.fill();
          vctx.shadowBlur = 0;
          vctx.strokeStyle = 'hsl(355,85%,50%)'; vctx.lineWidth = Math.max(0.8, s * 0.1); vctx.lineJoin = 'round'; vctx.stroke();
          vctx.restore();
        };
        const drawBody = (b) => {
          if (b.p.restaurant) { drawRestaurant(b); return; }
          const h = hue(b), s = b.s;
          if (b.p.ring) drawRing(b, false);
          // lit from the sun: the highlight sits on the sun-facing side
          const lx = b.x + (cx - b.x) / (b.p.r * R) * s * 0.5, ly = b.y + (cy - b.y) / (b.p.r * R) * s * 0.5;
          const g = vctx.createRadialGradient(lx, ly, s * 0.1, b.x, b.y, s);
          g.addColorStop(0, `hsl(${h},80%,${(70 + b.band * 25) | 0}%)`); g.addColorStop(1, `hsl(${h},70%,${(12 + b.band * 20) | 0}%)`);
          vctx.save();
          vctx.shadowColor = `hsla(${h},100%,60%,${(b.band * 0.9).toFixed(2)})`; vctx.shadowBlur = s * 2 * b.band;
          vctx.fillStyle = g; vctx.beginPath(); vctx.arc(b.x, b.y, s, 0, Math.PI * 2); vctx.fill();
          vctx.restore();
          if (b.p.ring) drawRing(b, true);
          if (b.p.moon) {
            const ma = orbitT * 8 + b.i, md = s * 2.4;
            vctx.fillStyle = `hsla(${h},15%,${(65 + b.band * 30) | 0}%,0.9)`;
            vctx.beginPath(); vctx.arc(b.x + Math.cos(ma) * md, b.y + Math.sin(ma) * md * tilt, Math.max(1.2, s * 0.28), 0, Math.PI * 2); vctx.fill();
          }
        };
        // smoke trails: each planet sheds puffs where it's been, filled in
        // along the path since last frame so a fast planet leaves a
        // continuous plume rather than a dotted one. Puffs stay put in
        // the sky, drift and curl a little, swell and thin out; a loud
        // band sheds thicker, brighter smoke. Each keeps the depth it was
        // shed at, so smoke behind the sun is hidden by it too.
        for (const b of bodies) {
          const prev = lastPos[b.i];
          const dist = prev ? Math.hypot(b.x - prev.x, b.y - prev.y) : 0;
          const n = prev && dist < R ? Math.min(8, 1 + Math.floor(dist / Math.max(1, b.s * 0.5))) : 1;
          for (let k = 0; k < n; k++) {
            const t = n > 1 ? (k + 1) / n : 1;
            const x = prev && dist < R ? prev.x + (b.x - prev.x) * t : b.x, y = prev && dist < R ? prev.y + (b.y - prev.y) * t : b.y;
            smoke.push({
              x, y, depth: b.depth, hue: hue(b), seed: Math.random() * 100,
              vx: (Math.random() - 0.5) * b.s * 0.04, vy: (Math.random() - 0.5) * b.s * 0.04 - b.s * 0.01,
              size: b.s * (0.7 + b.band * 0.5), grow: b.s * (0.007 + Math.random() * 0.007),
              life: 1, decay: 0.005 + Math.random() * 0.003, alpha: 0.10 + b.band * 0.22,
            });
          }
          lastPos[b.i] = { x: b.x, y: b.y };
          // glitter: a light sprinkle that thickens a little with the band,
          // and a small pinch tossed out on every beat. Nearly still at
          // birth, so it stays strung out along the planet's path
          const flakes = (Math.random() < 0.25 + b.band * 0.5 ? 1 : 0) + Math.floor(b.band * b.band * 2) + (burst ? 5 + Math.floor(b.band * 8) : 0);
          for (let k = 0; k < flakes; k++) {
            const ang = Math.random() * Math.PI * 2, v = (burst ? 0.3 + Math.random() * 0.7 : Math.random() * 0.12) * b.s * 0.12;
            glitter.push({
              x: b.x + (Math.random() - 0.5) * b.s, y: b.y + (Math.random() - 0.5) * b.s, depth: b.depth,
              vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, hue: Math.random() < 0.5 ? hue(b) : (hueBase + Math.random() * 360) % 360,
              size: Math.max(1, R * (0.0014 + Math.random() * 0.002)), phase: Math.random() * 6.3, spin: 0.06 + Math.random() * 0.14,
              life: 1, decay: 0.0025 + Math.random() * 0.0017,
            });
          }
        }
        const pace = Math.sqrt(speed);
        for (let i = smoke.length - 1; i >= 0; i--) {
          const q = smoke[i];
          q.life -= q.decay * pace;
          if (q.life <= 0) { smoke.splice(i, 1); continue; }
          q.x += (q.vx + Math.sin(q.seed + q.life * 6) * q.grow * 0.5) * pace; q.y += q.vy * pace; q.size += q.grow * pace;
        }
        if (smoke.length > 4000) smoke.splice(0, smoke.length - 4000);
        // no gravity: flakes coast to a stop and hang where they were shed,
        // so the trail holds its shape along the orbit for ~4-6s while it
        // fades. They keep tumbling in place -- the tumble is what makes
        // them twinkle.
        for (let i = glitter.length - 1; i >= 0; i--) {
          const q = glitter[i];
          q.life -= q.decay * pace;
          if (q.life <= 0) { glitter.splice(i, 1); continue; }
          q.vx *= 0.94; q.vy *= 0.94;
          q.x += q.vx * pace; q.y += q.vy * pace; q.phase += q.spin * pace;
        }
        if (glitter.length > 6000) glitter.splice(0, glitter.length - 6000);
        // each flake is a tiny square whose brightness tracks how square-on
        // its tumble has it to the camera; the ones that catch the light
        // just right throw a four-point glint
        const drawGlitter = (front) => {
          vctx.globalCompositeOperation = 'lighter';
          for (const q of glitter) {
            if ((q.depth >= 0) !== front) continue;
            const face = Math.abs(Math.sin(q.phase)), flash = Math.pow(face, 12), a = Math.pow(q.life, 1.3) * (0.1 + face * 0.45);
            const w = q.size * (0.35 + face * 0.65);
            vctx.fillStyle = `hsla(${q.hue | 0},85%,${(55 + flash * 30) | 0}%,${a.toFixed(2)})`;
            vctx.fillRect(q.x - w / 2, q.y - q.size / 2, w, q.size);
            if (flash > 0.85 && q.life > 0.3) {
              const g = q.size * (1.5 + flash * 2);
              vctx.strokeStyle = `hsla(${q.hue | 0},100%,90%,${(flash * q.life * 0.45).toFixed(2)})`; vctx.lineWidth = Math.max(0.6, q.size * 0.2);
              vctx.beginPath(); vctx.moveTo(q.x - g, q.y); vctx.lineTo(q.x + g, q.y); vctx.moveTo(q.x, q.y - g); vctx.lineTo(q.x, q.y + g); vctx.stroke();
            }
          }
          vctx.globalCompositeOperation = 'source-over';
        };
        const drawSmoke = (front) => {
          for (const q of smoke) {
            if ((q.depth >= 0) !== front) continue;
            vctx.globalAlpha = q.alpha * q.life;
            vctx.drawImage(puffSprite(q.hue), q.x - q.size, q.y - q.size, q.size * 2, q.size * 2);
          }
          vctx.globalAlpha = 1;
        };
        bodies.sort((a, b) => a.depth - b.depth);
        drawSmoke(false); drawGlitter(false);
        for (const b of bodies) if (b.depth < 0) drawBody(b);
        // the black hole, after the classic lensed-disc renders: an
        // accretion disc seen nearly edge-on, whose far side light bends
        // up over the top of the hole as a big arch and whose underside
        // bends round below it as a smaller arc, round a black shadow
        // edged by a hairline photon ring. The near side of the flat disc
        // is drawn last, cutting across the front of the shadow.
        //
        // The disc is BANDS thin streaks, inner to outer, and each is one
        // slice of the spectrum -- bass at the hot inner edge, treble at
        // the rim -- glowing with its loudness, plus whatever beat pulse
        // is passing through it. Along each band, brightness clumps drift
        // round (inner bands faster, like a real disc), and the left,
        // approaching side is Doppler-beamed brighter than the right.
        const BANDS = 26, SEG = 16, rin = sr * 1.55, rout = sr * 4.6, flatK = 1.3;
        const bandW = (rout - rin) / (BANDS - 1), flatE = 0.07 + tilt * 0.15;
        const band = [];
        for (let k = 0; k < BANDS; k++) {
          const f = k / (BANDS - 1);
          const lvl = freqData[Math.floor(Math.pow(f, 1.5) * maxBin * 0.85)] / 255;
          let boost = 0;
          for (const pp of pulses) boost += Math.exp(-Math.pow((f - pp) * BANDS / 1.8, 2));
          const B = clamp01((0.22 + lvl * 0.55 + boost * 0.7 + (1 - f) * 0.2) * (0.55 + 0.45 * hash(k * 12.9 + 1)));
          band.push({ f, r: rin + bandW * k, B, spin: orbitT * 6 / (1 + f * 3) + k * 1.7, hue: 10 + (1 - f) * 18 + B * 8 });
        }
        // one band as SEG arc pieces between angles a0..a1 of an ellipse
        const strokeBand = (b, rx, ry, a0, a1, gain, width) => {
          vctx.lineWidth = width;
          for (let g = 0; g < SEG; g++) {
            const s0 = a0 + (a1 - a0) * g / SEG, s1 = a0 + (a1 - a0) * (g + 1) / SEG, mid = (s0 + s1) / 2;
            const m = (0.65 + 0.35 * Math.sin(mid * 2 + b.spin)) * (1 - 0.35 * Math.cos(mid)) * gain;
            // dim and deep orange by default, only the hottest bits go
            // yellow-white -- this is drawn 'lighter' onto a frame that
            // only fades 35%, so it stacks up fast
            const v = b.B * m, L = Math.min(78, 22 + v * 45);
            vctx.strokeStyle = `hsla(${b.hue | 0},100%,${L | 0}%,${clamp01(v * 0.42).toFixed(2)})`;
            vctx.beginPath(); vctx.ellipse(cx, cy, rx, ry, 0, s0, s1); vctx.stroke();
          }
        };
        // a soft warm haze first -- kept faint on purpose: fadeFrame only
        // takes away 35% a frame, so a faint layer redrawn every frame
        // builds up to nearly 3x its own alpha
        const gr = sr * (7 + energy * 3), ga = 0.10 + energy * 0.12;
        const glow = vctx.createRadialGradient(cx, cy, sr, cx, cy, gr);
        for (const [at, k] of [[0, 1], [0.12, 0.62], [0.28, 0.32], [0.5, 0.12], [0.75, 0.03], [1, 0]]) glow.addColorStop(at, `hsla(24,90%,55%,${(ga * k).toFixed(3)})`);
        vctx.fillStyle = glow; vctx.beginPath(); vctx.arc(cx, cy, gr, 0, Math.PI * 2); vctx.fill();
        drawWaves(false);
        vctx.globalCompositeOperation = 'lighter';
        // far half of the flat disc, then the lensed arch over the top
        // (inner bands nearly circular, outer ones flattening out into
        // the disc), then the lensed underside, a smaller ring hugging
        // the bottom of the shadow
        for (const b of band) strokeBand(b, b.r * flatK, b.r * flatK * flatE, Math.PI, Math.PI * 2, 0.6, Math.max(1, bandW * 0.3));
        for (const b of band) strokeBand(b, b.r, b.r * (0.92 - b.f * 0.5), Math.PI, Math.PI * 2, 1, bandW * 0.7);
        for (const b of band) { const rl = sr * (1.12 + b.f * 0.55); strokeBand(b, rl, rl * 0.8, 0, Math.PI, 1.1, Math.max(1, bandW * 0.55)); }
        vctx.globalCompositeOperation = 'source-over';
        // the shadow
        vctx.fillStyle = '#000'; vctx.beginPath(); vctx.arc(cx, cy, sr, 0, Math.PI * 2); vctx.fill();
        // the photon ring: a hairline of light hugging the shadow, beamed
        // bright on the approaching side, flaring as each pulse is swallowed
        const pr = sr * (1.04 + swallow * 0.04);
        const photon = vctx.createLinearGradient(cx - pr, cy, cx + pr, cy);
        photon.addColorStop(0, `hsla(40,90%,85%,${(0.6 + swallow * 0.4).toFixed(2)})`);
        photon.addColorStop(1, `hsla(20,95%,55%,${(0.25 + swallow * 0.45).toFixed(2)})`);
        vctx.save();
        vctx.shadowColor = `hsla(35,95%,70%,${(0.4 + swallow * 0.6).toFixed(2)})`; vctx.shadowBlur = sr * (0.15 + swallow * 0.6);
        vctx.strokeStyle = photon; vctx.lineWidth = Math.max(1, sr * (0.03 + swallow * 0.05));
        vctx.beginPath(); vctx.arc(cx, cy, pr, 0, Math.PI * 2); vctx.stroke();
        vctx.restore();
        // the near half of the flat disc, across the front of the shadow
        vctx.globalCompositeOperation = 'lighter';
        for (const b of band) strokeBand(b, b.r * flatK, b.r * flatK * flatE, 0, Math.PI, 1.4, Math.max(1, bandW * 0.35));
        vctx.globalCompositeOperation = 'source-over';
        drawWaves(true);
        drawSmoke(true); drawGlitter(true);
        for (const b of bodies) if (b.depth >= 0) drawBody(b);
      },
    });
  })();

  // Doom95: the Win95 port of Doom, as a visualizer. A raycaster drawn
  // at the original's 320-pixel width and scaled up blocky walks itself
  // through a maze dug fresh each time the dialog opens -- brown brick,
  // computer panels whose screens are a live spectrum analyser, and
  // monitors showing the video. The shotgun fires on every bass hit
  // (muzzle flash, recoil, the whole sector lights up), and anything
  // in the crosshair column when it does goes down. The halls are
  // haunted: cacodemons drift and spit fireballs, imps stalk and throw
  // them, pinky demons charge in to bite, lost souls hang about until
  // you come near and then fly straight at you. Some brick is a secret
  // door that rises into the ceiling as the walker goes for it -- two
  // are shortcuts, two hide a sealed room with a powerup in it -- and
  // pairs of teleporter pads glow on the floor; step on one and you come
  // out of its twin in a burst of green. The status bar is the music:
  // HEALTH is loudness, ARMOR the bass, AMMO counts the beats down and
  // picks up another box when it runs dry, and the face looks around,
  // winces on the big hits and hits taken, grins at a kill. Now and then a pickup
  // message and the gold bonus flash. Zoom narrows the field of view;
  // Speed and the music's energy set the walking pace. Pair it with the
  // Melt transition.
  (function () {
    const RW = 320, BAR = 32, TEX = 64, N = 21, ZOOM_HOME = 0.39;
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const pack = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    const byte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
    const noise = (x, y, k) => hash(x * 12.9898 + y * 78.233 + k * 37.719);
    function hslPack(h, s, l) {
      h = (((h % 360) + 360) % 360) / 360;
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
      return pack(byte(f(h + 1 / 3) * 255), byte(f(h) * 255), byte(f(h - 1 / 3) * 255));
    }
    function shadePx(c, L) {
      const r = (c & 255) * L, g = ((c >> 8) & 255) * L, b = ((c >> 16) & 255) * L;
      return (0xff000000 | (byte(b) << 16) | (byte(g) << 8) | byte(r)) >>> 0;
    }
    function makeTex(fn) {
      const t = new Uint32Array(TEX * TEX);
      for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) t[y * TEX + x] = fn(x, y);
      return t;
    }

    // ── a 3x5 bitmap font: the status bar and messages stay crisp
    // pixels at 320 wide, where canvas text would smear
    const GLYPHS = {
      A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
      E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
      I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
      M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
      Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
      U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
      Y: '101101010010010', Z: '111001010100111',
      0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
      4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010',
      8: '111101111101111', 9: '111101111001110',
      '%': '101001010100101', '!': '010010010000010', '.': '000000000000010', ',': '000000000010100',
      "'": '010010000000000', '-': '000000111000000', '?': '110001010000010', '/': '001001010100100',
      ':': '000010000010000',
    };
    function text(g, str, x, y, sc, col, shadow) {
      for (const pass of shadow ? [shadow, col] : [col]) {
        const o = pass === col ? 0 : sc;
        g.fillStyle = pass;
        let cx = x;
        for (const ch of str.toUpperCase()) {
          const bits = GLYPHS[ch];
          if (bits) for (let i = 0; i < 15; i++) if (bits[i] === '1') g.fillRect(cx + (i % 3) * sc + o, y + ((i / 3) | 0) * sc + o, sc, sc);
          cx += 4 * sc;
        }
      }
    }
    const textW = (str, sc) => str.length * 4 * sc - sc;

    // ── textures ─────────────────────────────────────────────────────
    const STONE = makeTex((x, y) => {
      const row = y >> 3, sx = x + (row & 1) * 8, bx = sx & 15, by = y & 7;
      if (by === 7 || bx === 15) return pack(46, 34, 22);
      const n = noise(x, y, 1) * 30 - 15 + hash((sx >> 4) * 7.1 + row * 3.3) * 24 - 12;
      const hi = by === 0 || bx === 0 ? 22 : 0;
      return pack(byte(112 + n + hi), byte(80 + n * 0.8 + hi), byte(52 + n * 0.6 + hi * 0.6));
    });
    const TECH = makeTex((x, y) => {
      const n = noise(x, y, 2) * 16 - 8;
      if (x >= 10 && x < 54 && y >= 8 && y < 40) return pack(8, 12, 8);
      if (x >= 9 && x <= 54 && y >= 7 && y <= 40) return pack(38, 38, 42);
      if (x >= 10 && x < 54 && y >= 45 && y < 50) return pack(24, 24, 26);
      if ((x === 4 || x === 59) && (y === 4 || y === 59)) return pack(190, 190, 176);
      if (x === 0 || y === 0) return pack(150, 150, 156);
      if (x === 63 || y === 63) return pack(48, 48, 52);
      if (y === 55) return pack(60, 60, 64);
      return pack(byte(92 + n), byte(94 + n), byte(100 + n));
    });
    const techTex = new Uint32Array(TEX * TEX);
    const BAR_GREEN = pack(40, 220, 60), BAR_YELLOW = pack(230, 210, 40), BAR_RED = pack(230, 40, 30), LED_OFF = pack(40, 40, 40);
    function paintTech(freq, hue, t) {
      techTex.set(TECH);
      const bins = 11, maxBin = Math.max(1, Math.floor(freq.length * 0.6));
      for (let b = 0; b < bins; b++) {
        const h = Math.round((freq[Math.floor((b / bins) * maxBin)] / 255) * 30);
        for (let k = 0; k < h; k++) {
          const col = k > 23 ? BAR_RED : k > 15 ? BAR_YELLOW : BAR_GREEN, o = (38 - k) * TEX + 11 + b * 4;
          techTex[o] = techTex[o + 1] = techTex[o + 2] = col;
        }
      }
      for (let i = 0; i < 6; i++) {
        const col = hash(i * 9.1 + Math.floor(t * 4 + i * 0.37)) > 0.5 ? hslPack(hue + i * 50, 1, 0.55) : LED_OFF;
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 4; dx++) techTex[(46 + dy) * TEX + 12 + i * 7 + dx] = col;
      }
    }
    const MONITOR = pack(70, 70, 78), MONITOR_HI = pack(130, 130, 140), MONITOR_LO = pack(34, 34, 40);
    const FLOOR = makeTex((x, y) => {
      const tx = x & 31, ty = y & 31, n = noise(x, y, 3) * 18 - 9;
      if (tx === 0 || ty === 0) return pack(40, 38, 34);
      if (tx === 1 || ty === 1) return pack(byte(120 + n), byte(112 + n), byte(98 + n));
      return pack(byte(88 + n), byte(82 + n), byte(72 + n));
    });
    const CEIL = makeTex((x, y) => {
      const n = noise(x, y, 4) * 14 - 7;
      if ((x & 15) === 0 || (y & 15) === 0) return pack(34, 34, 36);
      return pack(byte(62 + n), byte(62 + n), byte(66 + n));
    });

    // ── sprites: every monster frame and pickup is drawn once with
    // ordinary canvas calls, then read back as pixels for the billboard loop
    function spriteOf(w, h, paint) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); paint(g);
      const d = g.getImageData(0, 0, w, h).data;
      return { w, h, px: new Uint32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) };
    }
    function fireGlow(g, x, y, r) {
      const fb = g.createRadialGradient(x, y, 0, x, y, r);
      fb.addColorStop(0, '#fff8c0'); fb.addColorStop(0.45, '#ff9020'); fb.addColorStop(1, 'rgba(255,60,0,0)');
      g.fillStyle = fb; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    function paintCaco(g, open) {
      g.fillStyle = '#e0c080';
      g.beginPath(); g.moveTo(8, 8); g.lineTo(5, 1); g.lineTo(12, 6); g.fill();
      g.beginPath(); g.moveTo(24, 8); g.lineTo(27, 1); g.lineTo(20, 6); g.fill();
      const body = g.createRadialGradient(12, 12, 2, 16, 17, 15);
      body.addColorStop(0, '#ff7060'); body.addColorStop(0.6, '#d02818'); body.addColorStop(1, '#601008');
      g.fillStyle = body; g.beginPath(); g.arc(16, 17, 14, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f0f0d0'; g.beginPath(); g.arc(16, 12, 5.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#30c030'; g.beginPath(); g.arc(16, 12, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000'; g.beginPath(); g.arc(16, 12, 2, 0, Math.PI * 2); g.fill();
      const mh = open ? 7 : 5;
      g.fillStyle = '#300'; g.beginPath(); g.ellipse(16, 24, 9, mh, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3050d0'; g.beginPath(); g.ellipse(16, 25, 5, mh / 2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      for (let i = 0; i < 5; i++) { g.fillRect(9 + i * 3, 24 - mh + 1, 2, 2); g.fillRect(10 + i * 3, 24 + mh - 3, 2, 2); }
      if (open) fireGlow(g, 16, 25, 5);
    }
    function paintImp(g, step, attack) {
      const l = step ? 3 : -1;
      g.fillStyle = '#5e4024'; g.fillRect(10 + l, 30, 5, 16); g.fillRect(18 - l, 30, 5, 16);
      g.fillStyle = '#3a2814'; g.fillRect(9 + l, 45, 7, 3); g.fillRect(17 - l, 45, 7, 3);
      g.fillStyle = '#8a6038'; g.fillRect(9, 14, 15, 18);
      g.fillStyle = '#a87850'; g.fillRect(11, 16, 11, 7);
      g.fillStyle = '#6a4828'; g.fillRect(9, 28, 15, 4);
      g.fillStyle = '#e8e0d0'; for (const [x, y] of [[8, 13], [23, 13], [12, 19], [19, 19], [15, 24]]) g.fillRect(x, y, 2, 2);
      g.fillStyle = '#8a6038';
      if (attack) { g.fillRect(22, 4, 4, 12); g.fillRect(5, 16, 4, 12); fireGlow(g, 24, 4, 5); }
      else {
        g.fillRect(5, 16, 4, 13); g.fillRect(24, 16, 4, 13);
        g.fillStyle = '#e8e0d0'; for (const x of [5, 8, 24, 27]) g.fillRect(x, 29, 1, 2);
      }
      g.fillStyle = '#7a5230'; g.fillRect(11, 4, 11, 11);
      g.fillStyle = '#e8e0d0'; g.fillRect(10, 2, 2, 4); g.fillRect(21, 2, 2, 4);
      g.fillStyle = '#ff3010'; g.fillRect(13, 8, 2, 2); g.fillRect(18, 8, 2, 2);
      g.fillStyle = '#300'; g.fillRect(13, 12, 7, 2);
      g.fillStyle = '#fff'; for (const x of [14, 16, 18]) g.fillRect(x, 12, 1, 1);
    }
    function paintDemon(g, step, bite) {
      const l = step ? 2 : -2;
      g.fillStyle = '#9a4a5a'; g.fillRect(8 + l, 22, 6, 8); g.fillRect(26 - l, 22, 6, 8);
      g.fillStyle = '#6a2a38'; g.fillRect(7 + l, 29, 8, 3); g.fillRect(25 - l, 29, 8, 3);
      const body = g.createRadialGradient(16, 9, 2, 20, 14, 17);
      body.addColorStop(0, '#f4a8b8'); body.addColorStop(0.7, '#d06878'); body.addColorStop(1, '#80303e');
      g.fillStyle = body; g.beginPath(); g.ellipse(20, 14, 16, 10, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#b05868'; g.fillRect(2, 12, 5, 10); g.fillRect(33, 12, 5, 10);
      g.fillStyle = '#e0d0b0'; g.fillRect(11, 2, 2, 4); g.fillRect(27, 2, 2, 4);
      g.fillStyle = '#ffe040'; g.fillRect(14, 7, 3, 2); g.fillRect(23, 7, 3, 2);
      const jh = bite ? 10 : 5;
      g.fillStyle = '#400'; g.fillRect(12, 12, 16, jh);
      g.fillStyle = '#fff'; for (let i = 0; i < 6; i++) { g.fillRect(13 + i * 3, 12, 1, 2); g.fillRect(13 + i * 3, 12 + jh - 2, 1, 2); }
    }
    function paintSoul(g, flick) {
      for (let i = 0; i < 14; i++) {
        const x = 4 + hash(i * 3.7 + flick * 11) * 24, h = 8 + hash(i * 5.1 + flick * 7) * 14;
        const fl = g.createLinearGradient(x, 26, x, 18 - h);
        fl.addColorStop(0, '#ff6010'); fl.addColorStop(0.6, '#ffc040'); fl.addColorStop(1, 'rgba(255,240,160,0)');
        g.fillStyle = fl; g.beginPath(); g.moveTo(x - 3, 26); g.lineTo(x, 18 - h); g.lineTo(x + 3, 26); g.fill();
      }
      g.fillStyle = '#e8e0c8'; g.beginPath(); g.arc(16, 17, 8, 0, Math.PI * 2); g.fill(); g.fillRect(11, 21, 10, 7);
      g.fillStyle = '#000'; g.fillRect(11, 15, 4, 4); g.fillRect(17, 15, 4, 4); g.fillRect(15, 21, 2, 2);
      g.fillStyle = '#ff4020'; g.fillRect(12, 16, 2, 2); g.fillRect(18, 16, 2, 2);
      g.fillStyle = '#000'; for (let i = 0; i < 5; i++) g.fillRect(11 + i * 2, 25, 1, 3);
    }
    let SPR = null;
    function makeSprites() {
      return {
        caco: [spriteOf(32, 32, (g) => paintCaco(g, false)), spriteOf(32, 32, (g) => paintCaco(g, true))],
        imp: [0, 1].map((s) => spriteOf(32, 48, (g) => paintImp(g, s, false))).concat([spriteOf(32, 48, (g) => paintImp(g, 0, true))]),
        demon: [0, 1].map((s) => spriteOf(40, 32, (g) => paintDemon(g, s, false))).concat([spriteOf(40, 32, (g) => paintDemon(g, 0, true))]),
        soul: [0, 1].map((f) => spriteOf(32, 32, (g) => paintSoul(g, f))),
        fireball: spriteOf(16, 16, (g) => fireGlow(g, 8, 8, 8)),
        sphere: spriteOf(16, 16, (g) => {
          const b = g.createRadialGradient(6, 6, 1, 8, 8, 8);
          b.addColorStop(0, '#e0f0ff'); b.addColorStop(0.4, '#6090ff'); b.addColorStop(0.85, '#1030b0'); b.addColorStop(1, 'rgba(16,48,176,0)');
          g.fillStyle = b; g.fillRect(0, 0, 16, 16);
        }),
        medikit: spriteOf(16, 12, (g) => {
          g.fillStyle = '#606060'; g.fillRect(0, 0, 16, 12); g.fillStyle = '#e8e8e8'; g.fillRect(1, 1, 14, 10);
          g.fillStyle = '#d01010'; g.fillRect(6, 2, 4, 8); g.fillRect(4, 4, 8, 4);
        }),
      };
    }
    // world size (w, h), how high off the floor (z) and how each kind moves:
    // chase is how hard it steers at you once you're within 7 cells,
    // shoots its average seconds between fireballs
    const TYPES = {
      caco: { w: 0.75, h: 0.75, z: 0.2, bob: 0.06, speed: 0.35, chase: 0.2, shoots: 6, weight: 3 },
      imp: { w: 0.55, h: 0.82, z: 0, speed: 0.7, chase: 0.6, shoots: 3.5, weight: 4 },
      demon: { w: 0.8, h: 0.64, z: 0, speed: 1.2, chase: 1, bites: true, weight: 2 },
      soul: { w: 0.42, h: 0.42, z: 0.3, bob: 0.08, speed: 0.4, chase: 0, charges: true, bright: true, weight: 2 },
    };
    const MOBS = 11, TYPE_IDS = Object.keys(TYPES), TYPE_SUM = TYPE_IDS.reduce((a, k) => a + TYPES[k].weight, 0);
    function frameOf(e) {
      const f = SPR[e.type];
      if (e.type === 'soul') return f[((st.t * 8) | 0) & 1];
      if (e.type === 'caco') return f[e.attackT > 0 ? 1 : 0];
      return f[e.attackT > 0 ? 2 : (e.anim | 0) & 1];
    }

    // ── the maze ─────────────────────────────────────────────────────
    // 0 open, 1 brick, 2 computer panel, 3 monitor, 4 secret door (brick
    // that rises into the ceiling), 5 held back for a secret room while
    // the maze is dug
    let map = null, doorO = null, doorT = null, doorAt = null, portalOf = null, secretOf = null;
    let doors = [], portals = [], secrets = [];
    const rnd = (n) => (Math.random() * n) | 0;
    function dig() {
      map = new Uint8Array(N * N).fill(1);
      doorO = new Float32Array(N * N); doorT = new Float32Array(N * N); doorAt = new Float32Array(N * N);
      portalOf = new Int16Array(N * N).fill(-1); secretOf = new Uint8Array(N * N);
      doors = []; portals = []; secrets = [];
      // fence off two 5x5 blocks -- a 3x3 room and its walls -- so the
      // digger goes round them
      for (let tries = 0; tries < 40 && secrets.length < 2; tries++) {
        const x = 3 + 2 * rnd(7), y = 3 + 2 * rnd(7);
        let free = true;
        for (let j = -1; j <= 3; j++) for (let k = -1; k <= 3; k++) if (map[(y + j) * N + x + k] !== 1) free = false;
        if (!free) continue;
        for (let j = -1; j <= 3; j++) for (let k = -1; k <= 3; k++) map[(y + j) * N + x + k] = 5;
        secrets.push([x, y]);
      }
      const stack = [[1, 1]]; map[N + 1] = 0;
      while (stack.length) {
        const [x, y] = stack[stack.length - 1];
        const opts = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          return nx > 0 && ny > 0 && nx < N - 1 && ny < N - 1 && map[ny * N + nx] === 1 && map[(y + dy / 2) * N + x + dx / 2] === 1;
        });
        if (!opts.length) { stack.pop(); continue; }
        const [dx, dy] = opts[rnd(opts.length)];
        map[(y + dy / 2) * N + x + dx / 2] = 0; map[(y + dy) * N + x + dx] = 0;
        stack.push([x + dx, y + dy]);
      }
      // a perfect maze is all dead ends -- knock through for loops, and
      // clear a few rooms for the monsters to roam
      for (let i = 0; i < 60; i++) {
        const x = 1 + rnd(N - 2), y = 1 + rnd(N - 2);
        if ((x & 1) !== (y & 1) && map[y * N + x] === 1) map[y * N + x] = 0;
      }
      for (let i = 0; i < 4; i++) {
        const x = 1 + 2 * rnd((N - 5) / 2), y = 1 + 2 * rnd((N - 5) / 2);
        for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) if (map[(y + j) * N + x + k] !== 5) map[(y + j) * N + x + k] = 0;
      }
      // open the secret rooms, each behind one secret door onto a corridor
      secrets.forEach(([x, y], n) => {
        for (let j = -1; j <= 3; j++) for (let k = -1; k <= 3; k++) {
          const i = (y + j) * N + x + k, inner = j >= 0 && j < 3 && k >= 0 && k < 3;
          map[i] = inner ? 0 : 1; if (inner) secretOf[i] = n + 1;
        }
        const ways = [];
        for (let k = 0; k < 3; k++) ways.push([x + k, y - 1, 0, -1], [x + k, y + 3, 0, 1], [x - 1, y + k, -1, 0], [x + 3, y + k, 1, 0]);
        const ok = ways.filter(([wx, wy, dx, dy]) => map[(wy + dy) * N + wx + dx] === 0 && !secretOf[(wy + dy) * N + wx + dx]);
        if (ok.length) { const [wx, wy] = ok[rnd(ok.length)]; map[wy * N + wx] = 4; doors.push(wy * N + wx); }
      });
      // and a couple of secret shortcuts: brick with a corridor either side
      const cands = [];
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const i = y * N + x; if (map[i] !== 1 || secretOf[i - 1] || secretOf[i + 1] || secretOf[i - N] || secretOf[i + N]) continue;
        const h = map[i - 1] === 0 && map[i + 1] === 0 && map[i - N] !== 0 && map[i + N] !== 0;
        const v = map[i - N] === 0 && map[i + N] === 0 && map[i - 1] !== 0 && map[i + 1] !== 0;
        if (h || v) cands.push(i);
      }
      for (let k = 0; k < 2 && cands.length; k++) { const i = cands.splice(rnd(cands.length), 1)[0]; map[i] = 4; doors.push(i); }
      for (let i = 0; i < N * N; i++) if (map[i] === 1) { const r = Math.random(); map[i] = r < 0.05 ? 2 : r < 0.4 ? 3 : 1; }
      // a wall at the end of a long straight run -- one you walk towards
      // -- is nearly always a screen
      const isWall = (i) => map[i] >= 1 && map[i] <= 3;
      for (let i = 0; i < N * N; i++) {
        if (!isWall(i)) continue;
        for (let k = 0; k < 4; k++) {
          let run = 0, cx = (i % N) + DX[k], cy = ((i / N) | 0) + DY[k];
          while (inMap(cx, cy) && map[cy * N + cx] === 0) { run++; cx += DX[k]; cy += DY[k]; }
          if (run >= 3 && Math.random() < 0.75) { map[i] = 3; break; }
        }
      }
      // halls of video: a few straight stretches lined with screens on both sides
      const halls = [];
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const so = dx ? N : 1; let len = 0;
        for (;;) {
          const c = (y + dy * len) * N + x + dx * len;
          if (x + dx * len >= N - 1 || y + dy * len >= N - 1 || map[c] !== 0 || secretOf[c] || !isWall(c - so) || !isWall(c + so)) break;
          len++;
        }
        if (len >= 3) halls.push([x, y, dx, dy, len]);
      }
      for (let h = 0; h < 4 && halls.length; h++) {
        const [x, y, dx, dy, len] = halls.splice(rnd(halls.length), 1)[0], so = dx ? N : 1;
        for (let k = 0; k < len; k++) { const c = (y + dy * k) * N + x + dx * k; map[c - so] = 3; map[c + so] = 3; }
      }
      // two pairs of teleporters, well apart
      const open = [];
      for (let i = 0; i < N * N; i++) if (map[i] === 0 && !secretOf[i]) open.push(i);
      for (let p = 0; p < 2; p++) {
        for (let tries = 0; tries < 80; tries++) {
          const a = open[rnd(open.length)], b = open[rnd(open.length)];
          if (a === b || portalOf[a] >= 0 || portalOf[b] >= 0 || Math.hypot((a % N) - (b % N), ((a / N) | 0) - ((b / N) | 0)) < 7) continue;
          portalOf[a] = b; portalOf[b] = a; portals.push(a, b); break;
        }
      }
    }
    const inMap = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
    // somewhere a monster (or a fireball) can be: a secret door only once it's all the way up
    const isOpen = (x, y) => inMap(x, y) && (map[y * N + x] === 0 || (map[y * N + x] === 4 && doorO[y * N + x] > 0.95));
    // somewhere the walker can head for: it opens secret doors on its way
    const walkable = (x, y) => inMap(x, y) && (map[y * N + x] === 0 || map[y * N + x] === 4);
    function openDoor(i) { if (doorT[i] !== 1) { doorT[i] = 1; doorAt[i] = st.t + 3; } }

    // ── state ────────────────────────────────────────────────────────
    const MESSAGES = [
      ['PICKED UP A SHOTGUN.', null], ['PICKED UP A STIMPACK.', null], ['PICKED UP A MEDIKIT.', null],
      ['PICKED UP AN ARMOR BONUS.', null], ['PICKED UP A HEALTH BONUS.', null], ['SUPERCHARGE!', null],
      ['PICKED UP THE BLUE KEYCARD.', 'key0'], ['PICKED UP THE YELLOW KEYCARD.', 'key1'], ['PICKED UP THE RED KEYCARD.', 'key2'],
      ['YOU GOT THE ROCKET LAUNCHER!', 'arm5'], ['YOU GOT THE PLASMA GUN!', 'arm6'], ['YOU GOT THE BFG9000! OH, YES.', 'arm7'],
    ];
    const KEY_COLS = ['#2040ff', '#e0d020', '#e02020'];
    let st = null;
    let lo = null, img = null, buf = null, zbuf = null, doorZ = null, doorBot = null, barCanvas = null;
    function reset() {
      dig();
      let cx = 1, cy = 1;
      for (let i = 0; i < 400; i++) {
        const x = 1 + rnd(N - 2), y = 1 + rnd(N - 2), c = y * N + x;
        if (map[c] === 0 && portalOf[c] < 0 && !secretOf[c]) { cx = x; cy = y; break; }
      }
      let d = 0; while (d < 3 && !walkable(cx + DX[d], cy + DY[d])) d++;
      st = {
        // one cell at a time: in through one edge, out through another
        walk: { cx, cy, din: d, dout: d, s: 0.5 },
        cam: { x: cx + 0.5, y: cy + 0.5, a: d * Math.PI / 2 },
        mobs: [], shots: [], respawn: [], lastNow: 0, t: 0, bobPh: 0,
        items: secrets.map(([x, y], n) => ({ x: x + 1.5, y: y + 1.5, kind: n === 0 ? 'sphere' : 'medikit' })),
        found: new Set(), tele: 0, teleCool: 0, visits: new Uint16Array(N * N),
        avgBass: 0, avgE: 0, fireCool: 0, flash: 0, recoil: 0, pain: 0, bonus: 0,
        grin: 0, ouch: 0, look: 0, lookAt: 0, ammo: 50, kills: 0,
        owned: new Set(['arm2', 'arm3']),
        msg: `E1M${1 + rnd(9)}: ENTERING.`, msgT: 3, nextMsg: 10 + Math.random() * 10,
      };
      for (let i = 0; i < MOBS; i++) spawnMob();
    }
    function spawnMob() {
      const { cam, mobs } = st;
      let r = Math.random() * TYPE_SUM, type = TYPE_IDS[0];
      for (const k of TYPE_IDS) { r -= TYPES[k].weight; if (r <= 0) { type = k; break; } }
      for (let tries = 0; tries < 60; tries++) {
        const x = 1 + rnd(N - 2), y = 1 + rnd(N - 2);
        if (!isOpen(x, y) || Math.hypot(x + 0.5 - cam.x, y + 0.5 - cam.y) < 4) continue;
        const a = Math.random() * Math.PI * 2;
        mobs.push({ type, x: x + 0.5, y: y + 0.5, vx: Math.cos(a), vy: Math.sin(a), ph: Math.random() * 6, anim: 0,
          dying: 0, hurt: 0, attackT: 0, biteCool: 0, shootAt: 2 + Math.random() * 4 });
        return;
      }
    }
    function hurtPlayer() { st.pain = 1; st.ouch = 0.6; }
    function pickDir(cx, cy, d) {
      const back = (d + 2) % 4, open = [], wts = [];
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (k === back || !walkable(nx, ny)) continue;
        const i = ny * N + nx;
        // secret doors and teleporters are irresistible, and it would
        // rather explore than retrace its steps
        open.push(k); wts.push((map[i] === 4 || portalOf[i] >= 0 ? 4 : k === d ? 2.5 : 1) / (1 + st.visits[i] * 2));
      }
      if (!open.length) return back;
      let r = Math.random() * wts.reduce((a, b) => a + b, 0);
      for (let i = 0; i < open.length; i++) { r -= wts[i]; if (r <= 0) return open[i]; }
      return open[0];
    }
    // where the walker is s (0..1) of the way through its cell. Straight
    // through is a line; a turn cuts the corner on a quarter circle
    // about the cell's inside corner, heading along the tangent, so the
    // view always looks down the corridor instead of stopping to stare
    // at a wall; a dead end walks in, about-faces, walks back out.
    function place(w, cam) {
      const ix = DX[w.din], iy = DY[w.din], ox = DX[w.dout], oy = DY[w.dout], Cx = w.cx + 0.5, Cy = w.cy + 0.5, s = w.s;
      if (w.din === w.dout) { cam.x = Cx + ix * (s - 0.5); cam.y = Cy + iy * (s - 0.5); cam.a = w.din * Math.PI / 2; return true; }
      if ((w.din + 2) % 4 === w.dout) {
        if (s < 0.3) { const k = 1 - s / 0.3; cam.x = Cx - ix * 0.5 * k; cam.y = Cy - iy * 0.5 * k; cam.a = w.din * Math.PI / 2; return true; }
        if (s < 0.7) { const k = (s - 0.3) / 0.4; cam.x = Cx; cam.y = Cy; cam.a = w.din * Math.PI / 2 + Math.PI * k * k * (3 - 2 * k); return false; }
        const k = (s - 0.7) / 0.3; cam.x = Cx + ox * 0.5 * k; cam.y = Cy + oy * 0.5 * k; cam.a = w.dout * Math.PI / 2; return true;
      }
      const Ox = Cx - ix * 0.5 + ox * 0.5, Oy = Cy - iy * 0.5 + oy * 0.5, th = s * Math.PI / 2, c = Math.cos(th), sn = Math.sin(th);
      cam.x = Ox + 0.5 * (-ox * c + ix * sn); cam.y = Oy + 0.5 * (-oy * c + iy * sn);
      cam.a = Math.atan2(oy * sn + iy * c, ox * sn + ix * c);
      return true;
    }
    function showMsg(m) { st.msg = m[0]; st.msgT = 3; st.bonus = 1; if (m[1]) st.owned.add(m[1]); }

    // project a world point: [screen x, depth] -- depth <= 0 is behind
    function project(px, py, cam, dirX, dirY, plX, plY) {
      const sx = px - cam.x, sy = py - cam.y, inv = 1 / (plX * dirY - dirX * plY);
      const tx = inv * (dirY * sx - dirX * sy), ty = inv * (-plY * sx + plX * sy);
      return [(RW / 2) * (1 + tx / ty), ty];
    }

    function drawBarBg() {
      barCanvas = document.createElement('canvas'); barCanvas.width = RW; barCanvas.height = BAR;
      const g = barCanvas.getContext('2d'), id = g.createImageData(RW, BAR), p = new Uint32Array(id.data.buffer);
      for (let y = 0; y < BAR; y++) for (let x = 0; x < RW; x++) { const n = noise(x, y, 5) * 26 - 13; p[y * RW + x] = pack(byte(92 + n), byte(88 + n), byte(78 + n)); }
      g.putImageData(id, 0, 0);
      g.fillStyle = '#2c2a24'; g.fillRect(0, 0, RW, 1);
      for (const [x0, x1] of [[2, 47], [49, 103], [105, 138], [143, 177], [179, 235], [237, 249], [251, 318]]) {
        g.fillStyle = '#3a372f'; g.fillRect(x0, 2, x1 - x0, 1); g.fillRect(x0, 2, 1, BAR - 4);
        g.fillStyle = '#9a9484'; g.fillRect(x0, BAR - 2, x1 - x0, 1); g.fillRect(x1, 2, 1, BAR - 3);
      }
      for (const [label, cx] of [['AMMO', 24], ['HEALTH', 76], ['ARMS', 121], ['ARMOR', 207]]) text(g, label, cx - textW(label, 1) / 2, 25, 1, '#d8d8d8', '#302c24');
    }
    function drawFace(g, cx, top, health) {
      const look = st.look * 2, pain = st.ouch > 0, grin = st.grin > 0;
      g.fillStyle = '#5a3a1a'; g.fillRect(cx - 11, top, 22, 7);
      g.fillStyle = '#c89060'; g.fillRect(cx - 10, top + 4, 20, 19); g.fillRect(cx - 8, top + 23, 16, 5);
      g.fillStyle = '#9a6840'; g.fillRect(cx - 10, top + 4, 2, 19); g.fillRect(cx + 8, top + 4, 2, 19); g.fillRect(cx - 1, top + 14, 2, 5);
      g.fillStyle = '#5a3a1a'; g.fillRect(cx - 8, top + (pain ? 10 : 9), 6, 2); g.fillRect(cx + 2, top + (pain ? 10 : 9), 6, 2);
      g.fillStyle = '#fff'; g.fillRect(cx - 8, top + 12, 5, pain ? 1 : 3); g.fillRect(cx + 3, top + 12, 5, pain ? 1 : 3);
      g.fillStyle = '#203050'; g.fillRect(cx - 7 + look, top + 12, 2, pain ? 1 : 2); g.fillRect(cx + 4 + look, top + 12, 2, pain ? 1 : 2);
      if (grin) { g.fillStyle = '#4a2010'; g.fillRect(cx - 7, top + 20, 14, 4); g.fillStyle = '#fff'; g.fillRect(cx - 6, top + 21, 12, 2); }
      else if (pain) { g.fillStyle = '#300'; g.fillRect(cx - 3, top + 19, 6, 5); }
      else { g.fillStyle = '#6a3020'; g.fillRect(cx - 4, top + 22, 8, 1); }
      if (health < 60) {
        g.fillStyle = '#a00'; g.fillRect(cx - 9, top + 6, 3, 2); g.fillRect(cx + 5, top + 17, 2, 4);
        if (health < 35) { g.fillRect(cx - 6, top + 17, 2, 5); g.fillRect(cx + 1, top + 4, 4, 2); }
      }
    }

    viz.registerMode({
      id: 'doom95', label: 'Doom95',
      init() { reset(); },
      draw(ctx) {
        const { vctx, VW, VH, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
        if (!st) reset();
        if (!SPR) SPR = makeSprites();
        if (!barCanvas) drawBarBg();
        const now = performance.now(), dt = st.lastNow ? Math.min(0.1, (now - st.lastNow) / 1000) : 0.016;
        st.lastNow = now; st.t += dt;

        // ── audio ──
        const energy = energyOf(freqData), bass = bassOf(freqData);
        st.avgBass = st.avgBass * 0.9 + bass * 0.1; st.avgE = st.avgE * 0.94 + energy * 0.06;
        st.fireCool -= dt; st.flash = Math.max(0, st.flash - dt * 6); st.recoil = Math.max(0, st.recoil - dt * 4);
        st.pain = Math.max(0, st.pain - dt * 2.5); st.bonus = Math.max(0, st.bonus - dt * 2); st.tele = Math.max(0, st.tele - dt * 1.8);
        st.grin -= dt; st.ouch -= dt; st.msgT -= dt;
        if (st.t > st.lookAt) { st.look = rnd(3) - 1; st.lookAt = st.t + 0.8 + Math.random() * 1.2; }
        if (st.t > st.nextMsg) { showMsg(MESSAGES[rnd(MESSAGES.length)]); st.nextMsg = st.t + 12 + Math.random() * 14; }

        // ── walk ──
        const w = st.walk, cam = st.cam, pace = speed * (0.7 + energy * 1.6);
        const len = w.din === w.dout ? 1 : (w.din + 2) % 4 === w.dout ? 1.6 : Math.PI / 4;
        let prevS = w.s;
        w.s += (dt * 2.2 * pace) / len;
        // a secret door in the way goes up as the walker comes for it; it
        // waits short of the door until there's headroom
        const next = (w.cy + DY[w.dout]) * N + w.cx + DX[w.dout];
        let blocked = false;
        if (map[next] === 4) { openDoor(next); if (doorO[next] < 0.95) { blocked = w.s > 0.55; w.s = Math.min(w.s, Math.max(prevS, 0.55)); } }
        if (w.s >= 1) {
          w.cx += DX[w.dout]; w.cy += DY[w.dout]; w.din = w.dout; w.s = Math.min(0.5, w.s - 1); prevS = 0;
          const ci = w.cy * N + w.cx, sid = secretOf[ci];
          st.visits[ci]++;
          w.dout = pickDir(w.cx, w.cy, w.din);
          // about to turn: whatever wall ends the way ahead becomes a
          // screen before it swings into view
          if (w.dout !== w.din) {
            let x = w.cx, y = w.cy;
            do { x += DX[w.dout]; y += DY[w.dout]; } while (map[y * N + x] === 0);
            if (map[y * N + x] === 1 || map[y * N + x] === 2) map[y * N + x] = 3;
          }
          if ((sid && !st.found.has(sid)) || (map[ci] === 4 && !st.found.has(-ci))) {
            st.found.add(sid || -ci); showMsg(['A SECRET IS REVEALED!', null]);
          }
        }
        // a teleporter pad: out of its twin, facing any way that's open
        const here = w.cy * N + w.cx;
        if (prevS < 0.5 && w.s >= 0.5 && portalOf[here] >= 0 && st.t > st.teleCool) {
          const to = portalOf[here];
          w.cx = to % N; w.cy = (to / N) | 0; w.s = 0.5;
          const ways = [0, 1, 2, 3].filter((k) => walkable(w.cx + DX[k], w.cy + DY[k]));
          w.din = w.dout = ways.length ? ways[rnd(ways.length)] : w.din;
          st.tele = 1; st.teleCool = st.t + 1.5;
        }
        const walking = place(w, cam) && !blocked;
        if (walking) st.bobPh += dt * 9 * pace;

        // ── doors: up at 1.5 cells a second, back down once nobody's under them ──
        for (const i of doors) {
          const tgt = doorT[i], o = doorO[i];
          doorO[i] = o + Math.sign(tgt - o) * Math.min(Math.abs(tgt - o), dt * 1.5);
          if (tgt === 1 && doorO[i] >= 1 && st.t > doorAt[i]) {
            const busy = here === i || next === i || Math.hypot(cam.x - (i % N) - 0.5, cam.y - ((i / N) | 0) - 0.5) < 1.4 ||
              st.mobs.some((e) => Math.floor(e.y) * N + Math.floor(e.x) === i);
            if (!busy) doorT[i] = 0;
          }
        }

        // Zoom's 1x is a wide 0.39x of Doom's own field of view -- the
        // halls read better with more of the walls in frame -- and the
        // slider zooms in and out from there
        const planeLen = (0.66 / Math.max(0.2, Math.min(3, vizUserScale * ZOOM_HOME))) * (1 + st.tele * st.tele * 1.2);
        const dirX = Math.cos(cam.a), dirY = Math.sin(cam.a), plX = -dirY * planeLen, plY = dirX * planeLen;
        const F = RW / 2 / planeLen;

        // ── render size: 320 wide, the window's own aspect ──
        const RH = Math.max(120, Math.min(480, Math.round((RW * VH) / VW))), viewH = RH - BAR;
        if (!lo) lo = offscreen();
        const { c: can, ctx: g } = lo(RW, RH);
        if (!img || img.height !== viewH) {
          img = g.createImageData(RW, viewH); buf = new Uint32Array(img.data.buffer);
          zbuf = new Float32Array(RW); doorZ = new Float32Array(RW); doorBot = new Float32Array(RW);
        }

        // ── monsters: wander, close in, attack, die, come back ──
        const visible = (x, y) => { const [sx, d] = project(x, y, cam, dirX, dirY, plX, plY); return d > 0.3 && sx >= 0 && sx < RW && d < zbuf[sx | 0]; };
        for (let i = st.mobs.length - 1; i >= 0; i--) {
          const e = st.mobs[i], T = TYPES[e.type];
          e.ph += dt * 2; e.hurt = Math.max(0, e.hurt - dt * 5); e.attackT -= dt; e.biteCool -= dt;
          if (e.dying) { e.dying += dt * 1.6; if (e.dying >= 1) { st.mobs.splice(i, 1); st.respawn.push(st.t + 3 + Math.random() * 4); } continue; }
          const dx = cam.x - e.x, dy = cam.y - e.y, dist = Math.hypot(dx, dy) || 1;
          if (Math.random() < dt * 0.3) { const a = Math.random() * Math.PI * 2; e.vx = Math.cos(a); e.vy = Math.sin(a); }
          let vx = e.vx, vy = e.vy, sp = T.speed;
          if (T.charges && dist < 5) { vx = dx / dist; vy = dy / dist; sp = 2.6; }
          else if (T.chase && dist < 7) {
            vx = vx * (1 - T.chase) + (dx / dist) * T.chase; vy = vy * (1 - T.chase) + (dy / dist) * T.chase;
            const m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m;
          }
          if (dist < 0.6) {
            sp = 0;
            if (T.charges) { hurtPlayer(); e.dying = 0.001; continue; }
            if (T.bites && e.biteCool <= 0) { hurtPlayer(); e.attackT = 0.35; e.biteCool = 1.2; }
          }
          const step = sp * dt * speed;
          const nx = e.x + vx * step, ny = e.y + vy * step;
          if (isOpen(Math.floor(nx + Math.sign(vx) * 0.3), Math.floor(e.y))) e.x = nx; else e.vx = -e.vx;
          if (isOpen(Math.floor(e.x), Math.floor(ny + Math.sign(vy) * 0.3))) e.y = ny; else e.vy = -e.vy;
          e.anim += step * 6;
          if (T.shoots && st.t > e.shootAt) {
            if (dist < 8 && dist > 1.2 && visible(e.x, e.y)) {
              st.shots.push({ x: e.x, y: e.y, vx: (dx / dist) * 3, vy: (dy / dist) * 3, z: T.z + T.h * 0.55, life: 4 });
              e.attackT = 0.4; e.shootAt = st.t + T.shoots * (0.6 + Math.random() * 0.8);
            } else e.shootAt = st.t + 0.5;
          }
        }
        st.respawn = st.respawn.filter((at) => (at < st.t ? (spawnMob(), false) : true));
        while (st.mobs.length + st.respawn.length < MOBS) st.respawn.push(st.t + 2 + Math.random() * 4);
        for (let i = st.shots.length - 1; i >= 0; i--) {
          const b = st.shots[i], k = dt * Math.max(0.6, speed);
          b.x += b.vx * k; b.y += b.vy * k; b.life -= dt;
          if (b.life <= 0 || !isOpen(Math.floor(b.x), Math.floor(b.y))) { st.shots.splice(i, 1); continue; }
          if (Math.hypot(b.x - cam.x, b.y - cam.y) < 0.35) { hurtPlayer(); st.shots.splice(i, 1); }
        }
        for (let i = st.items.length - 1; i >= 0; i--) {
          const it = st.items[i];
          if (Math.hypot(it.x - cam.x, it.y - cam.y) < 0.7) {
            showMsg(it.kind === 'sphere' ? ['SUPERCHARGE!', null] : ['PICKED UP A MEDIKIT.', null]); st.items.splice(i, 1);
          }
        }

        // ── fire on a kick ──
        if (bass > st.avgBass * 1.35 + 0.06 && st.fireCool <= 0) {
          st.fireCool = 0.22; st.flash = 1; st.recoil = 1;
          if (--st.ammo <= 0) { st.ammo = 50; showMsg(['PICKED UP A BOX OF SHELLS.', null]); }
          let best = null, bestD = 1e9;
          for (const e of st.mobs) {
            if (e.dying) continue;
            const [sx, d] = project(e.x, e.y, cam, dirX, dirY, plX, plY);
            if (d < 0.3 || d > 10 || d >= zbuf[RW >> 1] || Math.abs(sx - RW / 2) > ((F * TYPES[e.type].w) / d) * 0.5 + 20) continue;
            if (d < bestD) { best = e; bestD = d; }
          }
          if (best) { best.dying = 0.001; best.hurt = 1; st.kills++; st.grin = 1.2; }
          if (bass > st.avgBass * 1.8 + 0.15) hurtPlayer();
        }

        const light = 0.72 + st.avgE * 0.35 + st.flash * 0.45;
        const shade = (d) => { const L = Math.max(0.08, Math.min(1.5, light * (1.25 - d * 0.1))); return Math.round(L * 16) / 16; };
        const bobX = walking ? Math.cos(st.bobPh * 0.5) * 7 : 0, bobY = walking ? Math.abs(Math.sin(st.bobPh * 0.5)) * 5 : 0;
        const hor = viewH / 2 + bobY * 0.4 + st.recoil * 3;
        paintTech(freqData, hueBase, st.t);
        // the teleporters' own palette, dark to white-hot, in the viz hue
        const gate = new Uint32Array(64);
        for (let k = 0; k < 64; k++) gate[k] = hslPack(hueBase + 150 + k * 2, 1, 0.12 + (k / 63) * 0.7);
        const gateL = 0.8 + bass * 0.7;

        // ── floor and ceiling, one row at a time ──
        const rX0 = dirX - plX, rY0 = dirY - plY, rX1 = dirX + plX, rY1 = dirY + plY;
        const lamp = 0.55 + bass * 0.9 + st.flash * 0.5;
        for (let y = 0; y < viewH; y++) {
          const p = y - hor + 0.5, floor = p > 0, rowD = (0.5 * F) / Math.max(0.5, Math.abs(p));
          let fx = cam.x + rowD * rX0, fy = cam.y + rowD * rY0;
          const sx = (rowD * (rX1 - rX0)) / RW, sy = (rowD * (rY1 - rY0)) / RW, L = shade(rowD), row = y * RW;
          for (let x = 0; x < RW; x++) {
            const ix = Math.floor(fx), iy = Math.floor(fy), tx = ((fx - ix) * TEX) | 0, ty = ((fy - iy) * TEX) | 0;
            if (floor) {
              if (ix >= 0 && iy >= 0 && ix < N && iy < N && portalOf[iy * N + ix] >= 0) {
                // a teleporter pad: rings spiralling in, a steel rim
                const lx = fx - ix - 0.5, ly = fy - iy - 0.5, r = Math.hypot(lx, ly);
                if (r < 0.4) {
                  const ring = 0.5 + 0.5 * Math.sin(r * 40 - st.t * 8 + Math.atan2(ly, lx) * 3);
                  buf[row + x] = shadePx(gate[(ring * (1 - r * 1.5) * 63) | 0], gateL);
                } else buf[row + x] = shadePx(r < 0.46 ? MONITOR_HI : FLOOR[ty * TEX + tx], L);
              } else buf[row + x] = shadePx(FLOOR[ty * TEX + tx], L);
            } else if (tx >= 24 && tx < 40 && ty >= 24 && ty < 40) buf[row + x] = shadePx(pack(255, 236, 190), Math.min(1.3, lamp * (tx === 24 || ty === 24 || tx === 39 || ty === 39 ? 0.6 : 1)));
            else buf[row + x] = shadePx(CEIL[ty * TEX + tx], L);
            fx += sx; fy += sy;
          }
        }

        // ── walls: a DDA ray per column. A secret door part-way up is
        // remembered and the ray carries on under it; the door is drawn
        // over whatever the ray found behind ──
        let vpx = null;
        if (videoFrame) { const d = videoFrame.imageData.data; vpx = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2); }
        for (let x = 0; x < RW; x++) {
          const camX = (2 * x) / RW - 1, rdx = dirX + plX * camX, rdy = dirY + plY * camX;
          let mx = Math.floor(cam.x), my = Math.floor(cam.y);
          const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx), ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
          const stepX = rdx < 0 ? -1 : 1, stepY = rdy < 0 ? -1 : 1;
          let sdx = rdx < 0 ? (cam.x - mx) * ddx : (mx + 1 - cam.x) * ddx;
          let sdy = rdy < 0 ? (cam.y - my) * ddy : (my + 1 - cam.y) * ddy;
          let side = 0, hit = 1, dPerp = 0, dSide = 0, dO = 0;
          for (let guard = 0; guard < 64; guard++) {
            if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
            if (mx < 0 || my < 0 || mx >= N || my >= N) { hit = 1; break; }
            hit = map[my * N + mx];
            if (hit === 4) {
              const o = doorO[my * N + mx];
              if (o <= 0.001) break;
              if (o < 0.999 && !dPerp) { dPerp = side === 0 ? sdx - ddx : sdy - ddy; dSide = side; dO = o; }
              hit = 0;
            }
            if (hit) break;
          }
          const perp = Math.max(0.01, side === 0 ? sdx - ddx : sdy - ddy);
          zbuf[x] = perp;
          let u = side === 0 ? cam.y + perp * rdy : cam.x + perp * rdx; u -= Math.floor(u);
          if ((side === 0 && rdx < 0) || (side === 1 && rdy > 0)) u = 1 - u;
          const lh = F / perp, top = hor - lh / 2, y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(viewH, Math.ceil(hor + lh / 2));
          const L = shade(perp) * (side ? 0.8 : 1), tx = Math.min(TEX - 1, (u * TEX) | 0);
          for (let y = y0; y < y1; y++) {
            const v = (y - top) / lh, ty = Math.min(TEX - 1, (v * TEX) | 0);
            let c;
            if (hit === 2) c = techTex[ty * TEX + tx];
            else if (hit === 3) {
              if (u < 0.08 || u > 0.92 || v < 0.1 || v > 0.9) c = u < 0.04 || v < 0.05 ? MONITOR_HI : u > 0.96 || v > 0.95 ? MONITOR_LO : MONITOR;
              else if (vpx) {
                const px = Math.min(videoFrame.w - 1, (((u - 0.08) / 0.84) * videoFrame.w) | 0), py = Math.min(videoFrame.h - 1, (((v - 0.1) / 0.8) * videoFrame.h) | 0);
                c = vpx[py * videoFrame.w + px] | 0xff000000;
              } else { const n = (Math.random() * 200) | 0; c = pack(n, n, n); }
            } else c = STONE[ty * TEX + tx];
            // the screens glow: they only dim half as much with distance
            buf[y * RW + x] = shadePx(c, hit === 2 || hit === 3 ? Math.max(L, 0.5 + L * 0.5) : L);
          }
          doorZ[x] = Infinity; doorBot[x] = 0;
          if (dPerp) {
            const pp = Math.max(0.01, dPerp);
            let du = dSide === 0 ? cam.y + pp * rdy : cam.x + pp * rdx; du -= Math.floor(du);
            if ((dSide === 0 && rdx < 0) || (dSide === 1 && rdy > 0)) du = 1 - du;
            const dlh = F / pp, dtop = hor - dlh / 2, dbot = dtop + dlh * (1 - dO);
            const Ld = shade(pp) * (dSide ? 0.8 : 1), dtx = Math.min(TEX - 1, (du * TEX) | 0);
            for (let y = Math.max(0, Math.ceil(dtop)), ye = Math.min(viewH, Math.ceil(dbot)); y < ye; y++) {
              buf[y * RW + x] = shadePx(STONE[Math.min(TEX - 1, (((y - dtop) / dlh + dO) * TEX) | 0) * TEX + dtx], Ld);
            }
            doorZ[x] = pp; doorBot[x] = dbot;
          }
        }

        // ── sprites, far to near, clipped against walls and half-open doors ──
        const spr = [];
        for (const e of st.mobs) {
          const T = TYPES[e.type], k = 1 - e.dying * 0.75;
          spr.push({ x: e.x, y: e.y, w: T.w, h: T.h * k, z: T.z * k + (T.bob ? Math.sin(e.ph) * T.bob : 0), s: frameOf(e),
            L: T.bright ? 1.1 : null, dim: 1 - e.dying * 0.6, hurt: e.hurt });
        }
        for (const b of st.shots) spr.push({ x: b.x, y: b.y, w: 0.3, h: 0.3, z: b.z - 0.15, s: SPR.fireball, L: 1.2 });
        for (const it of st.items) {
          spr.push(it.kind === 'sphere'
            ? { x: it.x, y: it.y, w: 0.36, h: 0.36, z: 0.2 + Math.sin(st.t * 3) * 0.05, s: SPR.sphere, L: 1.1 + bass * 0.4 }
            : { x: it.x, y: it.y, w: 0.4, h: 0.3, z: 0, s: SPR.medikit });
        }
        for (const p of portals) spr.push({ x: (p % N) + 0.5, y: ((p / N) | 0) + 0.5, w: 0.8, h: 1, z: 0, glow: true });
        for (const o of spr) { const [sx, d] = project(o.x, o.y, cam, dirX, dirY, plX, plY); o.sx = sx; o.d = d; }
        spr.sort((a, b) => b.d - a.d);
        for (const o of spr) {
          const d = o.d; if (d < 0.2) continue;
          const pw = (F * o.w) / d, ph = (F * o.h) / d, left = o.sx - pw / 2, topY = hor - (F * (o.z + o.h - 0.5)) / d;
          const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(RW, Math.ceil(left + pw));
          const y0 = Math.max(0, Math.ceil(topY)), y1 = Math.min(viewH, Math.ceil(topY + ph));
          const L = o.L || shade(d) * (o.dim || 1);
          for (let x = x0; x < x1; x++) {
            if (d >= zbuf[x]) continue;
            const u = (x - left) / pw, behindDoor = d > doorZ[x], db = doorBot[x];
            // the teleporter's shimmer: light streaming up off the pad,
            // added over what's behind it rather than covering it
            const streak = o.glow ? (1 - (2 * u - 1) ** 2) * (0.35 + 0.65 * hash(Math.floor(u * 14) + 0.5)) : 0;
            for (let y = y0; y < y1; y++) {
              if (behindDoor && y < db) continue;
              const v = (y - topY) / ph;
              if (o.glow) {
                const k = streak * v * v * (0.5 + 0.5 * Math.sin(v * 24 + st.t * 9 + u * 5)) * gateL * 0.7;
                if (k < 0.02) continue;
                const c = gate[40 + ((k * 23) | 0) % 24], bc = buf[y * RW + x];
                buf[y * RW + x] = (0xff000000 | (byte(((bc >> 16) & 255) + ((c >> 16) & 255) * k) << 16) |
                  (byte(((bc >> 8) & 255) + ((c >> 8) & 255) * k) << 8) | byte((bc & 255) + (c & 255) * k)) >>> 0;
                continue;
              }
              const s = o.s, col = s.px[Math.min(s.h - 1, (v * s.h) | 0) * s.w + Math.min(s.w - 1, (u * s.w) | 0)];
              if (col >>> 24 < 128) continue;
              buf[y * RW + x] = shadePx(col, o.hurt > 0.5 ? 2.2 : L);
            }
          }
        }
        g.putImageData(img, 0, 0);

        // ── the shotgun ──
        const wx = Math.round(RW / 2 + bobX), wy = Math.round(viewH - 46 + bobY + st.recoil * 9);
        if (st.flash > 0.45) {
          g.fillStyle = `rgba(255,170,30,${(st.flash * 0.8).toFixed(2)})`; g.beginPath(); g.arc(wx, wy - 4, 14 * st.flash, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#fff4a0'; g.beginPath(); g.arc(wx, wy - 2, 7 * st.flash, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = '#242424'; g.fillRect(wx - 6, wy, 12, 48);
        g.fillStyle = '#505050'; g.fillRect(wx - 5, wy, 4, 48); g.fillRect(wx + 1, wy, 4, 48);
        g.fillStyle = '#8a8a8a'; g.fillRect(wx - 4, wy + 2, 1, 46); g.fillRect(wx + 2, wy + 2, 1, 46);
        g.fillStyle = '#000'; g.fillRect(wx - 4, wy, 2, 2); g.fillRect(wx + 2, wy, 2, 2);
        // the pump: a long wooden forestock running from partway up the
        // barrels down off the bottom of the view, flaring as it nears you
        g.fillStyle = '#5a3a1e'; g.fillRect(wx - 8, wy + 12, 16, 12); g.fillRect(wx - 10, wy + 24, 20, 30);
        g.fillStyle = '#7a5230'; g.fillRect(wx - 7, wy + 13, 3, 11); g.fillRect(wx - 9, wy + 24, 3, 30);
        g.fillStyle = '#3e2812'; for (let i = 0; i < 8; i++) g.fillRect(wx - (i < 3 ? 7 : 9), wy + 16 + i * 4, i < 3 ? 14 : 18, 1);
        g.fillStyle = '#b07050'; g.fillRect(wx - 14, wy + 32, 6, 16); g.fillRect(wx + 8, wy + 32, 6, 16);
        g.fillStyle = '#8a5038'; for (const k of [35, 39, 43]) { g.fillRect(wx - 14, wy + k, 6, 1); g.fillRect(wx + 8, wy + k, 6, 1); }

        // ── palette flashes: red for pain, gold for a pickup, green telefog ──
        if (st.pain > 0) { g.fillStyle = `rgba(255,0,0,${(st.pain * 0.35).toFixed(3)})`; g.fillRect(0, 0, RW, viewH); }
        if (st.tele > 0) { g.fillStyle = `rgba(60,255,110,${(st.tele * 0.5).toFixed(3)})`; g.fillRect(0, 0, RW, viewH); }
        if (st.bonus > 0) { g.fillStyle = `rgba(215,186,69,${(st.bonus * 0.25).toFixed(3)})`; g.fillRect(0, 0, RW, viewH); }
        if (st.msgT > 0) text(g, st.msg, 2, 2, 1, '#e02020', '#300');

        // ── status bar ──
        const health = Math.min(200, Math.round(15 + st.avgE * 230)), armor = Math.min(200, Math.round(st.avgBass * 200));
        g.drawImage(barCanvas, 0, viewH);
        const by = viewH + 4, big = (s, right) => text(g, s, right - textW(s, 3), by, 3, '#c81010', '#380000');
        big(String(st.ammo), 45); big(health + '%', 102); big(armor + '%', 234);
        [2, 3, 4, 5, 6, 7].forEach((n, i) => text(g, String(n), 110 + (i % 3) * 10, viewH + 5 + ((i / 3) | 0) * 9, 1, st.owned.has('arm' + n) ? '#f0d020' : '#606060'));
        KEY_COLS.forEach((col, i) => { if (st.owned.has('key' + i)) { g.fillStyle = col; g.fillRect(240, viewH + 4 + i * 9, 7, 6); } });
        [['BULL', 50, 200], ['SHEL', st.ammo, 50], ['RCKT', st.owned.has('arm5') ? 20 : 0, 50], ['CELL', st.owned.has('arm6') ? 120 : 0, 300]]
          .forEach(([k, n, max], i) => { const yy = viewH + 4 + i * 6; text(g, k, 254, yy, 1, '#d8d8d8'); text(g, `${n}/${max}`, 316 - textW(`${n}/${max}`, 1), yy, 1, '#f0d020'); });
        drawFace(g, 160, viewH + 2, health);

        // ── scale it up, square pixels ──
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        vctx.save(); vctx.imageSmoothingEnabled = false;
        vctx.drawImage(can, 0, 0, VW, VH);
        vctx.restore();
      },
    });
  })();

  // ── Hackers (mode): the Gibson's filesystem, the way the 1995 film
  // flew through it -- a city of dark glass towers, every face crawling
  // with glowing hex, file names and permission bits, the camera
  // skimming down the canyons between them, climbing over the rooftops
  // to bank across into another street, then diving back down. Each
  // tower listens to one band of the spectrum: its edges and text
  // brighten with it and a tide of light rises up its face; the bass
  // punches the throttle. The playing video shows through as a mask on
  // the text. The camera only ever looks straight down the street, so
  // every front face is a flat on-screen rectangle (plain fillText, no
  // texture mapping); turns are faked with a sideways glide, a bank
  // (the whole frame rotated) and a pitch (the horizon shifted), which
  // on screen reads exactly like the real thing.
  (function () {
    const PX = 2.6, PZ = 1.6;          // lot pitch across / along the streets
    const FAR = 30, NEAR = 0.12;
    const CYCLE = 44;                  // world units of travel per low-climb-cross-dive cycle
    const ROW = 0.1, GLYPH = 0.074;    // text row height / font size, world units
    const PCB_LANE = 0.11, PCB_W = 0.011;   // floor trace pitch / width, world units
    const PCB_BANDS = [0, 0.6, 0.8, 1, 1.3, 1.7, 2.2, 3, 4, 5.5, 8, 12, 18, FAR];   // depth bands the floor is stroked in
    const PALETTE = [190, 195, 205, 215, 185, 300, 320, 28, 130];   // mostly cyan/blue, a few neon accents
    const PATHS = ['/', '/usr', '/usr/garbage', '/etc/passwd', '/sys/kernel', '/root', '/var/spool', '/dev/null',
      '/bin/gibson', '/home/plague', '/tmp/.da_vinci', '/proc/ellingson', '/lib/worm', '/opt/crash_override'];
    const WORDS = ['GARBAGE', 'rwxr-x---', 'ROOT', 'KERNEL', 'DA VINCI', 'WORM', 'CORE', '.plan', 'GIBSON', 'ELLINGSON', 'ACCESS', 'SUPERUSER'];
    const HEX = '0123456789ABCDEF';
    // a fixed pool of lines every face draws its text from, so nothing
    // gets built per frame
    const POOL = [];
    for (let i = 0; i < 256; i++) {
      let s = '';
      while (s.length < 44) {
        const r = hash(i * 13.7 + s.length * 1.3);
        if (r < 0.62) { for (let k = 0; k < 4; k++) s += HEX[(hash(i * 7.9 + s.length * 3.1 + k) * 16) | 0]; s += ' '; }
        else if (r < 0.8) s += (hash(i + s.length) < 0.5 ? '0101 1101 ' : '1110 0010 ');
        else s += WORDS[(hash(i * 3.3 + s.length) * WORDS.length) | 0] + ' ';
      }
      POOL.push(s);
    }
    // The text atlas: every pool line pre-rendered once per palette
    // colour into an offscreen canvas, one line per row at the same
    // row pitch the faces use. fillText is by far the most expensive
    // thing this mode does (each distinct size a face lands on is a
    // fresh glyph rasterisation), so every face whose text is at most a
    // little bigger than the atlas's own is drawn as a scaled copy of a
    // strip of it; only the few near ones still get real fillText.
    const ATLAS_ROWS = 128, ATLAS_CHARS = 32, ATLAS_FS = 14, ATLAS_MAX = 18;
    const HOT = POOL.map((_, i) => hash(i * 1.9 + 0.4) > 0.9);   // the odd row lit white-hot
    const atlases = new Map();
    function atlasFor(hue) {
      let at = atlases.get(hue);
      if (at) return at;
      const c = document.createElement('canvas'), g = c.getContext('2d');
      const font = `${ATLAS_FS}px "Courier New", monospace`;
      g.font = font;
      const cw = g.measureText('0').width, rowH = ATLAS_FS * ROW / GLYPH;
      c.width = Math.ceil(cw * ATLAS_CHARS) + 2; c.height = Math.ceil(rowH * ATLAS_ROWS);
      g.font = font; g.textBaseline = 'top';
      for (let i = 0; i < ATLAS_ROWS; i++) {
        g.fillStyle = HOT[i] ? 'rgb(235,250,255)' : `hsl(${hue},100%,72%)`;
        g.fillText(POOL[i].slice(0, ATLAS_CHARS), 0, i * rowH + rowH * 0.15);
      }
      at = { c, cw, rowH };
      atlases.set(hue, at);
      return at;
    }
    const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
    const lane = (k) => Math.round((hash(k * 5.17 + 0.3) - 0.5) * 6);     // which street each cycle flies down
    // the camera's place for a given distance travelled: fly low down
    // one street, climb above every roof, glide across to the next
    // street, dive back in
    function camAt(z) {
      const c = Math.floor(z / CYCLE), u = z / CYCLE - c;
      const up = smooth(0.3, 0.45, u) * (1 - smooth(0.72, 0.88, u));
      const across = smooth(0.46, 0.7, u);
      return {
        x: (lane(c) + (lane(c + 1) - lane(c)) * across) * PX + PX / 2,
        y: 0.45 + up * 5.4,
        up, c: across > 0.5 ? c + 1 : c,
      };
    }
    function towerAt(i, j) {
      const s = i * 91.7 + j * 17.3;
      if (hash(s) < 0.12) return null;                                   // an empty lot
      const hw = 0.5 + hash(s + 1) * 0.15, d = 0.95 + hash(s + 2) * 0.25, t = hash(s + 3);
      return {
        x0: i * PX - hw, x1: i * PX + hw, z0: j * PZ, z1: j * PZ + d,
        h: 0.5 + t * t * 4.2, hue: PALETTE[(hash(s + 4) * PALETTE.length) | 0],
        band: hash(s + 5), line: (hash(s + 6) * 256) | 0, scroll: 0.6 + hash(s + 7) * 2.2,
      };
    }

    let last = 0, dist = 0, kick = 0, t = 0, pcbT = 0, shout = 0, lastShout = -1e9, roll = 0, prevX = null;
    viz.registerMode({
      id: 'hackers', label: 'Hackers',
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, videoFrame, speed, vizUserScale } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
        const bass = bassOf(freqData), energy = energyOf(freqData), maxBin = Math.floor(freqData.length * 0.7);
        kick = Math.max(kick * 0.9, bass > 0.5 ? bass : 0);
        dist += dt * (1.6 * speed + kick * 3 + energy * 0.8); t += dt;
        pcbT += dt * speed * (0.8 + energy * 0.8);   // the current creeps, a little faster when it's loud
        const cam = camAt(dist), camZ = dist;
        // bank into the glide, from how fast the camera is moving sideways
        if (prevX === null) prevX = cam.x;
        const vx = (cam.x - prevX) / Math.max(1e-3, dt); prevX = cam.x;
        roll += (Math.max(-0.4, Math.min(0.4, -vx * 0.06)) - roll) * Math.min(1, dt * 3);
        const drift = 18 * Math.sin(hueBase * Math.PI / 180);
        const f = Math.min(VW, VH) * 0.85 * vizUserScale;
        const hy = cy - cam.up * VH * 0.22 + VH * 0.04;               // pitching down over the roofs lifts the horizon

        // sky: near black, a cold glow at the horizon
        vctx.setTransform(1, 0, 0, 1, 0, 0);
        vctx.fillStyle = '#01030a'; vctx.fillRect(0, 0, VW, VH);
        vctx.save();
        vctx.translate(cx, cy); vctx.rotate(roll); vctx.translate(-cx, -cy);
        const R = Math.hypot(VW, VH);                                  // oversize, so a banked frame has no bare corners
        const g = vctx.createLinearGradient(0, hy - VH * 0.3, 0, hy + VH * 0.05);
        g.addColorStop(0, 'rgba(0,40,80,0)'); g.addColorStop(1, `hsla(${(200 + drift) | 0},90%,22%,${(0.5 + energy * 0.4).toFixed(2)})`);
        vctx.fillStyle = g; vctx.fillRect(cx - R, hy - VH * 0.3, R * 2, VH * 0.35);
        const gg = vctx.createLinearGradient(0, hy + VH * 0.05, 0, hy + VH * 0.2);
        gg.addColorStop(0, `hsla(${(200 + drift) | 0},90%,22%,${(0.5 + energy * 0.4).toFixed(2)})`); gg.addColorStop(1, '#010806');
        vctx.fillStyle = gg; vctx.fillRect(cx - R, hy + VH * 0.05, R * 2, VH * 0.15);
        vctx.fillStyle = '#010806'; vctx.fillRect(cx - R, hy + VH * 0.2, R * 2, R);

        const P = (x, y, z) => { const dz = z - camZ; return [cx + (x - cam.x) * f / dz, hy - (y - cam.y) * f / dz]; };
        const fogOf = (dz) => Math.pow(clamp01(1 - dz / FAR), 1.3);

        // the floor: a circuit board. Every street carries a bus of
        // parallel traces; now and then an outer one peels off at 45° to
        // a pad at a tower's foot (the towers are the chips), and short
        // cross traces with a via at each end fill the gaps between the
        // rows. Pulses of current creep along all of them. Everything is
        // bucketed by depth band (for width and fog) and by brightness,
        // so the whole board costs a few dozen strokes, not thousands.
        const ci = Math.round((cam.x - PX / 2) / PX), j0 = Math.floor(camZ / PZ), jN = j0 + Math.ceil(FAR / PZ);
        const zMin = camZ + NEAR * 3, bucket = PCB_BANDS.map(() => [[], [], [], [], []]), pads = PCB_BANDS.map(() => [[], []]);
        const addSeg = (x0, z0, x1, z1, lvl) => {
          for (let b = 0; b < PCB_BANDS.length - 1; b++) {
            const lo = camZ + PCB_BANDS[b], hi = camZ + PCB_BANDS[b + 1];
            if (z0 === z1) { if (z0 >= lo && z0 < hi && z0 >= zMin) bucket[b][lvl].push(x0, z0, x1, z1); continue; }
            const ta = (Math.max(lo, zMin) - z0) / (z1 - z0), tb = (hi - z0) / (z1 - z0);
            const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(1, Math.max(ta, tb));
            if (t1 > t0) bucket[b][lvl].push(x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0, x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1);
          }
        };
        const addPad = (x, z, lit) => {
          const dz = z - camZ; if (dz < NEAR * 3 || dz > 16) return;
          for (let b = 0; b < PCB_BANDS.length - 1; b++) if (dz < PCB_BANDS[b + 1]) { pads[b][lit ? 1 : 0].push(x, z); return; }
        };
        // a polyline of [x, z] points, and a pulse whose head is `head`
        // along it: the tail is three slices fading out behind the head,
        // plus a wide halo over all of it
        const addPoly = (pts) => { for (let k = 1; k < pts.length; k++) addSeg(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], 0); };
        const addPulse = (pts, head, tail) => {
          let acc = 0;
          for (let k = 1; k < pts.length; k++) {
            const [ax, az] = pts[k - 1], [bx, bz] = pts[k], len = Math.hypot(bx - ax, bz - az);
            for (let q = 0; q < 3; q++) {
              const s0 = Math.max(acc, head - tail + q * tail / 3), s1 = Math.min(acc + len, head - tail + (q + 1) * tail / 3);
              if (s1 <= s0) continue;
              const u0 = (s0 - acc) / len, u1 = (s1 - acc) / len;
              addSeg(ax + (bx - ax) * u0, az + (bz - az) * u0, ax + (bx - ax) * u1, az + (bz - az) * u1, q + 1);
              addSeg(ax + (bx - ax) * u0, az + (bz - az) * u0, ax + (bx - ax) * u1, az + (bz - az) * u1, 4);
            }
            acc += len;
          }
        };
        const frac = (v) => v - Math.floor(v);
        for (let i = ci - 6; i <= ci + 6; i++) {
          const xs = i * PX + PX / 2, nL = 4 + ((hash(i * 2.9) * 3) | 0), xo = (nL - 1) / 2 * PCB_LANE;
          // the bus: long straight lanes, pulses running either way
          for (let k = 0; k < nL; k++) {
            const x = xs + (k - (nL - 1) / 2) * PCB_LANE, hs = hash(i * 7.3 + k * 1.9);
            addSeg(x, zMin, x, camZ + FAR, 0);
            const dir = hs < 0.5 ? 1 : -1, sp = 3.5 + hash(hs * 91) * 4, ph = frac(dir * pcbT * (0.5 + hs * 0.5) / sp + hs) * sp;
            for (let n = Math.floor((camZ - ph) / sp); n * sp + ph < camZ + 22; n++) {
              const zh = n * sp + ph; addPulse([[x, zh - dir * 0.7], [x, zh]], 0.7, 0.7);
            }
          }
          for (let j = j0 - 1; j <= jN; j++) {
            // stubs out to the chips on either side
            for (const s of [-1, 1]) {
              const hs = hash(i * 13.1 + j * 3.7 + s * 0.77);
              if (hs > 0.55) continue;
              const x0 = xs + s * xo, za = j * PZ + 0.1 + hash(hs * 51) * PZ * 0.5, x1 = xs + s * (xo + 0.28);
              const pts = [[x0, za], [x1, za + 0.28], [x1, za + 0.28 + 0.12 + hash(hs * 7) * 0.25]];
              addPoly(pts);
              const L = 0.28 * Math.SQRT2 + (pts[2][1] - pts[1][1]), head = frac(pcbT * 0.18 + hs * 5) * (L + 1.2);
              if (head < L + 0.45) addPulse(pts, head, 0.45);
              addPad(pts[2][0], pts[2][1], head > L - 0.05 && head < L + 0.45);
            }
            // a cross trace through the gap between this row and the next
            const hc = hash(i * 5.3 + j * 11.9);
            if (hc < 0.45) {
              const zc = (j + 1) * PZ - 0.08 - hc * 0.3, xa = xs + xo + 0.2, xb = xs + PX - xo - 0.2, L = xb - xa;
              const pts = hc < 0.22 ? [[xa, zc], [xb, zc]] : [[xb, zc], [xa, zc]];
              addPoly(pts); addPad(xa, zc, false); addPad(xb, zc, false);
              const head = frac(pcbT * 0.12 + hc * 9) * (L + 1.5);
              if (head < L + 0.6) addPulse(pts, head, 0.6);
            }
          }
        }
        const glow = 0.55 + energy * 0.45;
        vctx.lineCap = 'butt';
        for (let b = 0; b < PCB_BANDS.length - 1; b++) {
          const mid = (PCB_BANDS[b] + PCB_BANDS[b + 1]) / 2, fog = fogOf(mid), w = Math.max(0.7, Math.min(VH * 0.006, PCB_W * f / mid));
          if (fog <= 0.01) continue;
          const stroke = (lvl, style, lw) => {
            const segs = bucket[b][lvl]; if (!segs.length) return;
            vctx.beginPath();
            for (let k = 0; k < segs.length; k += 4) {
              const [ax, ay] = P(segs[k], 0, segs[k + 1]), [bx, by] = P(segs[k + 2], 0, segs[k + 3]);
              vctx.moveTo(ax, ay); vctx.lineTo(bx, by);
            }
            vctx.strokeStyle = style; vctx.lineWidth = lw; vctx.stroke();
          };
          stroke(0, `hsla(${(168 + drift) | 0},55%,${22 + energy * 8 | 0}%,${(fog * 0.75).toFixed(3)})`, w);
          // pads and vias: a copper ring, foreshortened onto the floor
          const ring = (list, style, fill) => {
            if (!list.length) return;
            vctx.beginPath();
            for (let k = 0; k < list.length; k += 2) {
              const dz = list[k + 1] - camZ, [px, py] = P(list[k], 0, list[k + 1]);
              const rx = 0.035 * f / dz, ry = rx * Math.min(1, Math.max(0.08, cam.y / dz));
              if (rx < 0.8) continue;
              vctx.moveTo(px + rx, py); vctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
            }
            if (fill) { vctx.fillStyle = style; vctx.fill(); } else { vctx.strokeStyle = style; vctx.lineWidth = Math.max(0.7, w * 0.8); vctx.stroke(); }
          };
          vctx.fillStyle = '#010806';
          ring(pads[b][0], `hsla(${(168 + drift) | 0},55%,26%,${(fog * 0.8).toFixed(3)})`, false);
          ring(pads[b][1], `hsla(${(168 + drift) | 0},55%,26%,${(fog * 0.8).toFixed(3)})`, false);
          vctx.globalCompositeOperation = 'lighter';
          const hot = (a) => `hsla(${(185 + drift) | 0},100%,${60 + a * 30 | 0}%,${(fog * glow * a).toFixed(3)})`;
          stroke(4, hot(0.14), w * 3.5);
          stroke(1, hot(0.3), w * 1.4); stroke(2, hot(0.6), w * 1.6); stroke(3, hot(1), w * 1.8);
          ring(pads[b][1], hot(0.9), true);
          vctx.globalCompositeOperation = 'source-over';
        }

        // the towers in view, far to near
        const towers = [];
        for (let j = j0 - 1; j <= jN; j++) for (let i = ci - 5; i <= ci + 6; i++) {
          const tw = towerAt(i, j); if (!tw || tw.z1 - camZ < NEAR) continue;
          const mx = Math.max(0, Math.max(tw.x0 - cam.x, cam.x - tw.x1));
          tw.key = Math.hypot(mx, Math.max(0, tw.z0 - camZ)); towers.push(tw);
        }
        towers.sort((a, b) => b.key - a.key);
        vctx.textBaseline = 'top';
        const quad = (pts, fill, stroke, lw) => {
          vctx.beginPath(); vctx.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) vctx.lineTo(pts[k][0], pts[k][1]); vctx.closePath();
          vctx.fillStyle = fill; vctx.fill(); if (stroke) { vctx.strokeStyle = stroke; vctx.lineWidth = lw; vctx.stroke(); }
        };
        for (const tw of towers) {
          const zA = Math.max(tw.z0, camZ + NEAR), dzA = zA - camZ, fog = fogOf(Math.max(dzA, tw.z0 - camZ));
          if (fog <= 0.01) continue;
          const v = freqData[Math.floor(tw.band * maxBin)] / 255, hue = (tw.hue + drift + 360) % 360;
          const edge = `hsla(${hue | 0},100%,${(50 + v * 35) | 0}%,${(fog * (0.55 + v * 0.45)).toFixed(3)})`;
          const body = `hsla(${hue | 0},70%,${(4 + v * 6) | 0}%,${(0.35 + fog * 0.55).toFixed(3)})`;
          const lw = Math.max(1, f / Math.max(dzA, 0.5) * 0.012);
          // side faces: whichever one faces the street the camera's in,
          // with dashed data lines running along them
          for (const x of [tw.x0, tw.x1]) {
            if ((x === tw.x0 && cam.x >= tw.x0) || (x === tw.x1 && cam.x <= tw.x1)) continue;
            quad([P(x, 0, zA), P(x, 0, tw.z1), P(x, tw.h, tw.z1), P(x, tw.h, zA)], body, edge, lw);
            if (dzA < 14) {
              vctx.strokeStyle = `hsla(${hue | 0},100%,${(55 + v * 30) | 0}%,${(fog * (0.35 + v * 0.5)).toFixed(3)})`;
              vctx.lineWidth = Math.max(1, lw * 0.8);
              vctx.beginPath();
              const rows = Math.floor(tw.h / (ROW * 1.5)), sc = t * tw.scroll * 0.4;
              for (let r = 1; r < rows; r++) {
                const y = r * ROW * 1.5;
                for (let s = 0; s < 4; s++) {
                  if (hash(tw.line + r * 3.7 + s + Math.floor(sc + r * 0.3)) < 0.45) continue;
                  const za = tw.z0 + (tw.z1 - tw.z0) * (s + 0.1) / 4, zb = tw.z0 + (tw.z1 - tw.z0) * (s + 0.8) / 4;
                  if (zb <= camZ + NEAR) continue;
                  const [ax, ay] = P(x, y, Math.max(za, camZ + NEAR)), [bx, by] = P(x, y, zb);
                  vctx.moveTo(ax, ay); vctx.lineTo(bx, by);
                }
              }
              vctx.stroke();
            }
          }
          // the roof, when the camera's above it
          if (cam.y > tw.h) quad([P(tw.x0, tw.h, zA), P(tw.x1, tw.h, zA), P(tw.x1, tw.h, tw.z1), P(tw.x0, tw.h, tw.z1)], body, edge, lw);
          // the front face: a flat rectangle facing the camera, full of text
          if (tw.z0 - camZ <= NEAR) continue;
          const dz = tw.z0 - camZ, k = f / dz;
          const [sx0, sy0] = P(tw.x0, tw.h, tw.z0), [sx1, sy1] = P(tw.x1, 0, tw.z0);
          if (sx1 < -R || sx0 > VW + R || sy0 > VH + R || sy1 < -R) continue;
          vctx.fillStyle = body; vctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
          // a tide of light rising up the face with its band
          const tide = (sy1 - sy0) * v;
          const tg = vctx.createLinearGradient(0, sy1, 0, sy1 - tide - 1);
          tg.addColorStop(0, `hsla(${hue | 0},100%,45%,${(fog * 0.35).toFixed(3)})`); tg.addColorStop(1, `hsla(${hue | 0},100%,45%,0)`);
          vctx.fillStyle = tg; vctx.fillRect(sx0, sy1 - tide, sx1 - sx0, tide);
          vctx.strokeStyle = edge; vctx.lineWidth = lw; vctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
          const rowPx = ROW * k, fs = Math.round(GLYPH * k);
          if (fs < 4) {
            // too far for glyphs: a few bright scan rows stand in for them
            if (rowPx > 0.8) {
              vctx.fillStyle = `hsla(${hue | 0},100%,70%,${(fog * (0.25 + v * 0.4)).toFixed(3)})`;
              for (let y = sy0 + rowPx; y < sy1 - rowPx; y += rowPx * 2) vctx.fillRect(sx0 + (sx1 - sx0) * 0.08, y, (sx1 - sx0) * 0.84, Math.max(0.6, rowPx * 0.5));
            }
            continue;
          }
          const chars = Math.min(ATLAS_CHARS, Math.max(1, Math.floor((sx1 - sx0 - fs) / (fs * 0.6))));
          const sc = t * tw.scroll, base = Math.floor(sc), off = (sc - base) * rowPx;
          const nRows = Math.floor((sy1 - sy0) / rowPx);
          const rTop = Math.max(0, Math.floor((0 - sy0) / rowPx) - 1), rBot = Math.min(nRows, Math.ceil((VH - sy0) / rowPx) + 1);
          const alpha = fog * (0.45 + v * 0.55);
          if (fs <= ATLAS_MAX) {
            // small and mid-size faces: one scaled copy out of the
            // pre-rendered atlas (two when the rows wrap round it)
            // instead of a fillText per row -- flying high puts hundreds
            // of these faces on screen at once
            const rA = Math.max(rTop, Math.ceil(off / rowPx - 0.05)), rB = Math.min(rBot - 1, Math.floor((sy1 - sy0 - rowPx * 0.25 - fs + off) / rowPx));
            if (rB < rA) continue;
            const at = atlasFor(tw.hue), sk = rowPx / at.rowH, sw = chars * at.cw;
            let a = alpha;
            if (videoFrame) a *= 0.35 + lumAt(videoFrame, Math.max(0, Math.min(VW - 1, (sx0 + sx1) / 2)), Math.max(0, Math.min(VH - 1, (sy0 + sy1) / 2)), VW, VH) * 1.1;
            vctx.globalAlpha = Math.min(1, a);
            let q = (tw.line + rA + base) & (ATLAS_ROWS - 1), r = rA;
            while (r <= rB) {
              const n = Math.min(rB - r + 1, ATLAS_ROWS - q);
              vctx.drawImage(at.c, 0, q * at.rowH, sw, n * at.rowH, sx0 + fs * 0.5, sy0 + r * rowPx - off, sw * sk, n * rowPx);
              r += n; q = 0;
            }
            vctx.globalAlpha = 1;
            continue;
          }
          vctx.font = `${fs}px "Courier New", monospace`;
          for (let r = rTop; r < rBot; r++) {
            const y = sy0 + r * rowPx - off + rowPx * 0.15;
            if (y < sy0 + rowPx * 0.1 || y + fs > sy1 - rowPx * 0.1) continue;
            const idx = (tw.line + r + base) & (ATLAS_ROWS - 1);
            let a = alpha;
            if (videoFrame) a *= 0.35 + lumAt(videoFrame, Math.max(0, Math.min(VW - 1, (sx0 + sx1) / 2)), Math.max(0, Math.min(VH - 1, y)), VW, VH) * 1.1;
            vctx.fillStyle = HOT[idx] ? `rgba(235,250,255,${Math.min(1, a * 1.2).toFixed(3)})` : `hsla(${tw.hue},100%,72%,${Math.min(1, a).toFixed(3)})`;
            vctx.fillText(POOL[idx].slice(0, chars), sx0 + fs * 0.5, y);
          }
        }
        vctx.restore();

        // HUD: where in the filesystem we are, and -- on a big enough
        // hit, not too often -- the film's battle cry
        const hs = Math.max(10, Math.round(Math.min(VW, VH) * 0.026));
        vctx.font = `${hs}px "Courier New", monospace`; vctx.textBaseline = 'top';
        const path = PATHS[((cam.c % PATHS.length) + PATHS.length) % PATHS.length];
        const cursor = Math.floor(t * 2) % 2 ? '_' : ' ';
        vctx.fillStyle = 'rgba(120,230,255,0.85)';
        vctx.fillText(`GIBSON:${path}$ ls -la${cursor}`, hs, hs);
        vctx.fillStyle = 'rgba(120,230,255,0.5)';
        vctx.fillText(`SECTOR 0x${((camZ * 64) >>> 0).toString(16).toUpperCase().padStart(6, '0')}  ALT ${cam.y.toFixed(2)}`, hs, VH - hs * 2);
        if (kick > 0.72 && t - lastShout > 12) { shout = 1; lastShout = t; }
        if (shout > 0) {
          shout = Math.max(0, shout - dt * 0.7);
          const bs = Math.round(Math.min(VW, VH) * 0.075);
          vctx.font = `bold ${bs}px "Courier New", monospace`; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
          const a = Math.min(1, shout * 2) * (Math.floor(t * 12) % 2 ? 1 : 0.7);
          vctx.fillStyle = `rgba(255,60,200,${(a * 0.35).toFixed(3)})`; vctx.fillText('HACK THE PLANET', VW / 2 + bs * 0.06, VH / 2 + bs * 0.04);
          vctx.fillStyle = `rgba(200,255,255,${a.toFixed(3)})`; vctx.fillText('HACK THE PLANET', VW / 2, VH / 2);
          vctx.textAlign = 'start';
        }
      },
    });
  })();

  // Dancing baby: the 1996 Character Studio demo ("Baby Cha-Cha",
  // sk_baby.max) that became Ally McBeal's hallucination -- a shaded
  // toddler in a cloth nappy doing the cha-cha on a disco floor, the
  // camera swinging round it. Like the original's Biped rig, the dance is
  // footstep-driven: each foot has a list of footsteps -- a rock step on
  // 2 and 3, then the cha-cha-cha triple step on 4-&-1 that carries the
  // baby a little way sideways, back again the next bar -- and the legs
  // reach them by IK, the hips settling over whichever foot has the
  // weight. The routine runs twelve bars: two of the plain basic, two
  // with the hand flipping over the head (the move Girard's first
  // prototype already had), a bar of air guitar, a bar throwing both
  // hands down at the floor as it bends over, a bar bent over shaking
  // the shoulders (Lurye's additions), another bar of throws, two
  // with the hips circling and both hands flipping, and two of jazz
  // hands. The beat comes from bass onsets (intervals folded into one
  // beat's range, so kicks on 1 and 3 still read as the beat), and each
  // onset pulls the step back into line, so the feet land on the kick. The louder it gets, the more backup babies join, in a
  // ring orbiting the first; the floor tiles are the video, the lit ones
  // changing on every beat, and a mirror ball spins overhead in a
  // pin-spot that changes colour on the beat, thousands of mirrors
  // throwing specks over the floor and walls, beams showing in the smoke.
  (function () {
    const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const lerp = (a, b, k) => a + (b - a) * k;
    const lerpV = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
    const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
    const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
    const rotZ = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };
    const smooth = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
    // a limb hanging straight down, swung forward by `swing`, out to the side by `out`
    const limbDir = (side, swing, out) => norm([side * Math.sin(out), -Math.cos(out) * Math.cos(swing), Math.cos(out) * Math.sin(swing)]);
    // a limb's second segment: the first one's direction bent by `bend` towards `toward`
    function bendDir(d, bend, toward) {
      let p = add(toward, mul(d, -dot(toward, d)));
      p = Math.hypot(p[0], p[1], p[2]) < 1e-3 ? [0, 1, 0] : norm(p);
      return norm(add(mul(d, Math.cos(bend)), mul(p, Math.sin(bend))));
    }
    // two-bone IK: the knee that joins hip to ankle, bending towards `pole`
    const L1 = 0.17, L2 = 0.16;
    function ik(hip, ank, pole) {
      let d = sub(ank, hip), len = Math.hypot(d[0], d[1], d[2]);
      const maxL = (L1 + L2) * 0.999;
      if (len > maxL) { ank = add(hip, mul(d, maxL / len)); d = sub(ank, hip); len = maxL; }
      const dir = mul(d, 1 / len);
      const a = (L1 * L1 - L2 * L2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const p = norm(add(pole, mul(dir, -dot(pole, dir))));
      return { knee: add(add(hip, mul(dir, a)), mul(p, h)), ank };
    }
    const PACI = [198, 62, 70], SKIN = [18, 62, 70], DARK = [15, 40, 12], HAIR = [30, 45, 40], METAL = [210, 8, 72], PIN = [200, 65, 76];

    // ── the nappy: a cloth mesh round the hips, built once in pelvis
    // space. Folds in the radius (and so in the normals, which is what
    // makes them read), gathers at the waistband, a front panel wrapped
    // over the sides and pinned, and leg holes cut high at the sides.
    // Drawn as small back-face-culled panels sorted with the body, so no
    // part of it can vanish behind a belly or a thigh the way one big
    // shape does.
    const DIAPER = [], PINS = [], NT = 24, NV = 4, FLAP = Math.PI / 4;
    (function () {
      const pt = (th, v, layer) => {
        const yb = -0.1 + 0.08 * Math.pow(Math.sin(th), 2), top = 0.085;
        const fold = 1 + 0.03 * Math.sin(th * 9 + 1.3) * (0.3 + v) + 0.016 * Math.sin(th * 22) * Math.max(0, 1 - v * 3.5);
        const bulge = 1 + 0.08 * Math.sin(Math.PI * Math.min(1, v * 1.3));      // puffy through the middle
        const rx = 0.14 * (1 - 0.16 * v * v) * fold * bulge * layer, rz = 0.122 * (1 - 0.5 * v * v) * fold * bulge * layer;
        return [Math.sin(th) * rx, top + (yb - top) * v, Math.cos(th) * rz];
      };
      const STEP = 2 * Math.PI / NT;
      for (let j = 0; j < NV; j++) for (let i = 0; i < NT; i++) {
        const t0 = -Math.PI + i * STEP, t1 = t0 + STEP, v0 = j / NV, v1 = (j + 1) / NV;
        const tm = (t0 + t1) / 2, vm = (v0 + v1) / 2, front = Math.abs(tm) < FLAP, L = front ? 1.035 : 1;
        const e = 1e-3, n0 = cross(sub(pt(tm + e, vm, L), pt(tm - e, vm, L)), sub(pt(tm, vm + e, L), pt(tm, vm - e, L)));
        let n = norm(n0); if (n[0] * Math.sin(tm) + n[2] * Math.cos(tm) < 0) n = mul(n, -1);
        DIAPER.push({ q: [pt(t0, v0, L), pt(t1, v0, L), pt(t1, v1, L), pt(t0, v1, L)], n, band: j === 0, hem: j === NV - 1 });
      }
      // closing it: a crotch panel from the front's bottom edge to the
      // back's, sagging a little between the legs (the thighs fill the
      // leg holes either side of it), and a turned-over rim from the
      // waistband in to the body, so bent over, from behind or from above,
      // there's never a view into the hollow
      const quad = (q, up, extra) => {
        let n = norm(cross(sub(q[1], q[0]), sub(q[3], q[0])));
        if ((n[1] > 0) !== up) n = mul(n, -1);
        DIAPER.push(Object.assign({ q, n }, extra));
      };
      const CROTCH = 2;                                                     // columns either side of centre
      for (let i = NT / 2 - CROTCH; i < NT / 2 + CROTCH; i++) {
        const t0 = -Math.PI + i * STEP, t1 = t0 + STEP;
        const f0 = pt(t0, 1, 1.035), f1 = pt(t1, 1, 1.035), b0 = pt(Math.PI - t0, 1, 1), b1 = pt(Math.PI - t1, 1, 1);
        const m0 = add(mul(add(f0, b0), 0.5), [0, -0.012, 0]), m1 = add(mul(add(f1, b1), 0.5), [0, -0.012, 0]);
        quad([f0, f1, m1, m0], false, {});
        quad([m0, m1, b1, b0], false, {});
      }
      for (let i = 0; i < NT; i++) {
        const t0 = -Math.PI + i * STEP, t1 = t0 + STEP, L = Math.abs(t0 + STEP / 2) < FLAP ? 1.035 : 1;
        const inner = (t) => [Math.sin(t) * 0.098, 0.08, Math.cos(t) * 0.09];
        quad([pt(t0, 0, L), pt(t1, 0, L), inner(t1), inner(t0)], true, { band: true });
      }
      // the front panel's edges: a short wall where it overlaps the sides
      for (const sg of [-1, 1]) {
        const th = sg * FLAP, n = mul([Math.cos(th), 0, -Math.sin(th)], sg);
        for (let j = 0; j < NV; j++) {
          const v0 = j / NV, v1 = (j + 1) / NV;
          DIAPER.push({ q: [pt(th, v0, 1), pt(th, v0, 1.035), pt(th, v1, 1.035), pt(th, v1, 1)], n, wall: true });
        }
        // a nappy pin where the flap meets the side: bar and plastic head
        PINS.push({ c: 1, a: pt(th, 0.12, 1.06), b: pt(th, 0.42, 1.06), r: 0.0065, col: METAL });
        PINS.push({ a: pt(th, 0.1, 1.07), r: 0.014, col: PIN });
      }
    })();

    // ── the footsteps ──
    // Bars alternate: an even bar rocks forward on the +x foot and
    // triple-steps G towards +x, an odd bar rocks back on the -x foot and
    // triple-steps home. Bars that don't step keep the feet where they are.
    const W = 0.15, G = 0.12, HIPW = 0.065;
    // stepping bars come in even/odd pairs, so the traveller always starts a pair at home
    const ROUTINE = ['basic', 'basic', 'flip', 'flip', 'guitar', 'throw', 'shake', 'throw', 'circle', 'circle', 'jazz', 'jazz'];
    const PLANTED = { guitar: 1, throw: 1, shake: 1 };
    const typeOf = (n) => ROUTINE[((n % ROUTINE.length) + ROUTINE.length) % ROUTINE.length];
    function footEvents(side, n) {
      const k = typeOf(n);
      if (PLANTED[k]) return [];
      const s = n & 1 ? -1 : 1, c0 = s > 0 ? 0 : G, c1 = s > 0 ? G : 0, t0 = n * 4;
      if (side === s) return [
        { t: t0 + 1, x: c0 + s * W / 2, z: s * 0.11, dur: 0.5 },             // 2: rock
        { t: t0 + 2, x: c0 + s * W / 2, z: 0, dur: 0.5 },                    // 3: recover
        { t: t0 + 3, x: c0 + s * (W / 2 + G * 0.5), z: 0, dur: 0.4 },        // 4: cha
        { t: t0 + 4, x: c1 + s * W / 2, z: 0, dur: 0.35 },                   // 1: cha
      ];
      return [{ t: t0 + 3.5, x: c1 - s * W / 2, z: 0, dur: 0.35 }];         // &: cha (closing)
    }
    function footAt(side, b) {
      const n = Math.floor(b / 4);
      const ev = footEvents(side, n - 1).concat(footEvents(side, n), footEvents(side, n + 1));
      let base = { x: side * W / 2, z: 0, t: -1e9 }, next = null;
      for (const e of ev) { if (e.t <= b) base = e; else { next = e; break; } }
      if (next && next.t - b < next.dur) {
        const k = smooth(0, 1, 1 - (next.t - b) / next.dur);
        return { x: lerp(base.x, next.x, k), z: lerp(base.z, next.z, k), y: Math.sin(Math.PI * k) * 0.04, air: true, land: -1e9 };
      }
      return { x: base.x, z: base.z, y: 0, air: false, land: base.t };
    }
    // which foot has the weight, -1..1, eased over the last third of a beat
    function weightAt(b) {
      let w = 0;
      for (let k = 0; k < 6; k++) {
        const bb = b - k * 0.06, l = footAt(1, bb), r = footAt(-1, bb);
        w += l.air && !r.air ? -1 : r.air && !l.air ? 1 : l.land > r.land ? 1 : r.land > l.land ? -1 : 0;
      }
      return w / 6;
    }

    // ── the upper body, per section of the routine ──
    // a hand: which way the palm faces (in the body's frame, x towards the
    // midline, so one value suits either hand), how far the fingers fan
    // out, how far they curl (0 flat, ~1.6 a fist), and a roll about the wrist
    const HAND = (palm, spread, curl, roll = 0) => ({ palm, spread, curl, roll });
    const lerpH = (a, b, k) => HAND(lerpV(a.palm, b.palm, k), lerp(a.spread, b.spread, k), lerp(a.curl, b.curl, k), lerp(a.roll, b.roll, k));
    const RELAXED = HAND([1, 0.1, 0.3], 0.35, 0.45), FIST = HAND([0, 0, 1], 0, 1.6);
    const ARM = (swing, out, elbow, toward, hand = RELAXED) => ({ swing, out, elbow, toward, hand });
    const lerpA = (a, b, k) => ARM(lerp(a.swing, b.swing, k), lerp(a.out, b.out, k), lerp(a.elbow, b.elbow, k), lerpV(a.toward, b.toward, k), lerpH(a.hand, b.hand, k));
    const basicArm = (side, b) => ARM(0.3 + side * Math.sin(Math.PI * b) * 0.45, 0.3, 1.4, [0, 0.4, 1]);
    // the hand flip: the arm swings up, the forearm folds over the top of
    // the head, and it comes back down, over `p` 0..1
    function flipArm(side, p, base) {
      const up = Math.pow(Math.sin(Math.PI * clamp01(p)), 0.5);
      const over = smooth(0.3, 0.5, p) * (1 - smooth(0.62, 0.8, p));        // only while the arm is up
      return ARM(lerp(base.swing, 3.0, up), lerp(base.out, 0.5, Math.min(1, up * 1.5)), lerp(base.elbow, 0.2, up) + over * 0.6, lerpV(base.toward, [-side, 0.4, 0.15], over),
        lerpH(base.hand, HAND([1, -0.6, 0], 0.7, 0.2), up));                 // the palm turns down over the head
    }
    function section(type, b) {
      const n = Math.floor(b / 4), u = b - n * 4, s = n & 1 ? -1 : 1, sw = Math.sin(Math.PI * b), ai = (side) => side > 0 ? 0 : 1;
      const P = { arms: [basicArm(1, b), basicArm(-1, b)], bend: 0.04, lean: 0, twist: 0, shimmy: 0, dip: 0.012 * Math.abs(sw), circle: 0, headYaw: -sw * 0.2, headTilt: 0, hipBack: 0 };
      if (type === 'flip' || type === 'circle') {
        const p = (u - 0.6) / 2;
        P.arms[ai(s)] = flipArm(s, p, P.arms[ai(s)]);
        // leaning away from the raised arm, so the hand clears the head
        P.lean = s * 0.14 * Math.sin(Math.PI * clamp01(p));
      }
      if (type === 'circle') { const p2 = (u - 2.2) / 1.7; P.arms[ai(-s)] = flipArm(-s, p2, P.arms[ai(-s)]); P.lean -= s * 0.14 * Math.sin(Math.PI * clamp01(p2)); P.circle = 1; }
      if (type === 'guitar') {
        // fretting out to the side, strumming at the belly on the eighths, nodding along
        const strum = Math.sin(Math.PI * 4 * b);
        P.arms = [ARM(0.55, 1.15, 0.45, [0, 0.5, 1], HAND([0, -0.4, 1], 0.1, 1.15)), ARM(0.45 + strum * 0.22, 0.05, 1.85, [1, 0.1, 0.6], HAND([1, 0, 0], 0.05, 1.0, strum * 0.3))];
        P.bend = -0.12; P.twist = 0.3; P.dip = 0.035 + 0.025 * Math.abs(sw); P.headYaw = 0.35; P.headTilt = 0.15 + 0.15 * Math.abs(sw);
      }
      if (type === 'jazz') {
        // jazz hands: arms flung out to the sides, forearms up, palms to the
        // front and fingers splayed, the hands trembling at the wrist four
        // times a beat, the arms popping a little wider on every beat,
        // shoulders shimmying with them, the feet still doing the cha-cha
        const tremble = Math.sin(Math.PI * 8 * b), pop = Math.pow(1 - (b - Math.floor(b)), 3);
        P.arms = [1, -1].map((side) => ARM(0.3, 1.4 + pop * 0.12, 0.85, [0, 1, 0.2], HAND([0, 0.15, 1], 1, 0.02, tremble * 0.45)));
        P.shimmy = tremble * 0.05; P.bend = -0.05; P.headTilt = -0.12; P.headYaw = Math.sin(Math.PI * b / 2) * 0.3;
      }
      if (type === 'shake') {
        // still thrown forward, head hanging so you see the top of it, the
        // arms dangling loose from the shoulders and swinging, a beat
        // behind, as the shoulders shake twice a beat
        const sh = Math.sin(Math.PI * 4 * b), lag = Math.sin(Math.PI * 4 * b - 1.2);
        P.bend = 1.7; P.hipBack = 0.06; P.shimmy = sh * 0.38; P.dip = 0.015; P.headTilt = 0.55 + sh * 0.08; P.headYaw = -sh * 0.12;
        P.arms = [1, -1].map((side) => ARM(1.55 + side * lag * 0.25, 0.16 + Math.abs(lag) * 0.08, 0.35, [0, 0.4, 1], HAND([1, 0, -0.3], 0.3, 0.5, lag * 0.3)));
      }
      if (type === 'throw') {
        // every two beats: fists pulled up beside the ears, then the body
        // thrown forward, landing on the beat -- the arms flung past the
        // vertical and settling back to dangle, the head dropping after the
        // body so it hangs, relaxed, top of the head to the camera -- held a
        // moment, and drawn back up for the next one. The bar's last throw
        // lands on the downbeat of the shimmy bar and carries straight into it.
        const ph = b / 2 - Math.floor(b / 2);
        const down = ph < 0.2 ? 1 : ph < 0.7 ? 1 - smooth(0.2, 0.7, ph) : smooth(0.84, 1, ph);
        const settle = ph < 0.5 ? smooth(0, 0.18, ph) : 0;                   // the fling overshoots, then hangs
        const slump = ph < 0.5 ? smooth(0, 0.12, ph) * 0.3 + 0.7 : 1;        // the head follows the body down
        const upA = ARM(0.75, 1.0, 2.1, [0, 1, 0], FIST);
        const dnA = ARM(lerp(1.95, 1.55, settle), lerp(0.3, 0.16, settle), lerp(0.05, 0.35, settle), [0, 0.4, 1], HAND([1, 0, -0.3], lerp(0.7, 0.3, settle), lerp(0.15, 0.5, settle)));
        P.arms = [lerpA(upA, dnA, down), lerpA(upA, dnA, down)];
        P.bend = lerp(0.05, 1.7, down); P.hipBack = 0.06 * down; P.dip = lerp(0.03, 0.015, down); P.headTilt = lerp(-0.1, 0.55, down) * (down > 0.5 ? slump : 1); P.headYaw = 0;
      }
      return P;
    }
    const KEYS = ['bend', 'lean', 'twist', 'shimmy', 'dip', 'circle', 'headYaw', 'headTilt', 'hipBack'];
    function params(b) {
      const n = Math.floor(b / 4), k = smooth(3.5, 4, b - n * 4), A = section(typeOf(n), b);
      if (k <= 0) return A;
      const B = section(typeOf(n + 1), b), o = {};
      o.arms = A.arms.map((a, i) => lerpA(a, B.arms[i], k));
      for (const key of KEYS) o[key] = lerp(A[key], B[key], k);
      return o;
    }

    // a hand at the wrist: a palm and four two-jointed fingers fanning
    // out from its knuckles, curling towards the palm, and a thumb on the
    // side that faces the midline when the palm faces front
    const FINGERS = [[-0.35, -0.018, 0.034], [-0.12, -0.006, 0.04], [0.12, 0.006, 0.038], [0.36, 0.018, 0.031]];
    function hand(out, wr, fore, side, H, upper) {
      const u = fore, ph = upper([-side * H.palm[0], H.palm[1], H.palm[2]]);
      let n = add(ph, mul(u, -dot(ph, u)));
      n = Math.hypot(n[0], n[1], n[2]) < 1e-3 ? upper([-side, 0, 0]) : norm(n);
      if (H.roll) n = norm(add(mul(n, Math.cos(H.roll)), mul(cross(u, n), Math.sin(H.roll))));
      const v = cross(u, n), c = H.curl;
      out.push({ a: add(wr, mul(u, 0.03)), r: 0.034, col: SKIN, bias: 0.03 });
      for (const [fan, off, len] of FINGERS) {
        const base = add(add(wr, mul(u, 0.054)), mul(v, off * (1 + H.spread * 0.25)));
        const d = norm(add(u, mul(v, fan * H.spread)));
        const d1 = norm(add(mul(d, Math.cos(c * 0.55)), mul(n, Math.sin(c * 0.55))));
        const d2 = norm(add(mul(d, Math.cos(c * 1.2)), mul(n, Math.sin(c * 1.2))));
        const k = add(base, mul(d1, len * 0.55));
        out.push({ c: 1, a: base, b: k, r: 0.0093, col: SKIN, bias: 0.035 });
        out.push({ c: 1, a: k, b: add(k, mul(d2, len * 0.45)), r: 0.0083, col: SKIN, bias: 0.035 });
      }
      const ts = mul(v, -side), tb = add(add(wr, mul(u, 0.022)), mul(ts, 0.024));
      const td = norm(add(add(mul(ts, 0.75 * (0.4 + H.spread * 0.6)), mul(u, 0.6)), mul(n, 0.2 + c * 0.35)));
      const tk = add(tb, mul(td, 0.023));
      out.push({ c: 1, a: tb, b: tk, r: 0.0106, col: SKIN, bias: 0.035 });
      out.push({ c: 1, a: tk, b: add(tk, mul(norm(add(td, mul(n, c * 0.5))), 0.019)), r: 0.0094, col: SKIN, bias: 0.035 });
    }

    // the baby at beat `b` (continuous), as spheres, capsules and cloth
    // panels in its own space: y up, facing +z, feet on y=0, about 0.9 tall
    function pose(b) {
      const P = params(b), out = [], cb = Math.PI * b;
      const feet = [footAt(1, b), footAt(-1, b)], ws = weightAt(b);
      const hipTwist = ws * 0.22 + P.twist + P.circle * Math.sin(cb) * 0.15;
      const px = (feet[0].x + feet[1].x) / 2 + ws * 0.035 + P.circle * Math.cos(cb) * 0.04;
      const pz = (feet[0].z + feet[1].z) * 0.25 + P.circle * Math.sin(cb) * 0.035 - P.hipBack;   // folding over, the hips go back over the heels
      const hips = [1, -1].map((side) => add([px, 0, pz], rotY([side * HIPW, 0, 0], hipTwist)));
      const anks = feet.map((f) => [f.x, 0.04 + f.y, f.z]);
      // the pelvis as high as the standing leg(s) reach, nearly straight (the Cuban motion)
      let py = Infinity;
      for (let i = 0; i < 2; i++) {
        if (feet[i].air && !feet[1 - i].air) continue;
        const dx = hips[i][0] - anks[i][0], dz = hips[i][2] - anks[i][2];
        py = Math.min(py, anks[i][1] + Math.sqrt(Math.max(0, (0.965 * (L1 + L2)) ** 2 - dx * dx - dz * dz)));
      }
      py -= P.dip;
      const pelvis = [px, py, pz];
      for (let i = 0; i < 2; i++) {
        const side = i ? -1 : 1, hip = add(hips[i], [0, py, 0]);
        const { knee, ank } = ik(hip, anks[i], rotY(norm([side * 0.25, 0, 1]), hipTwist));
        const toe = add(ank, rotY([0, -0.005, 0.075], hipTwist * 0.4 + side * 0.15));
        out.push({ c: 1, a: add(hip, mul(norm(sub(knee, hip)), 0.03)), b: knee, r: 0.058, col: SKIN });
        out.push({ c: 1, a: knee, b: ank, r: 0.047, col: SKIN });
        out.push({ c: 1, a: ank, b: toe, r: 0.036, col: SKIN });
      }
      // torso: leaning off the weighted hip, the shoulders countering the hips a little
      const lean = -ws * 0.06 + P.lean, bend = P.bend, yawU = hipTwist * 0.6 + P.shimmy;
      // the pelvis tips with half the bend, the torso bends from the waist
      const tilt = bend * (0.5 + 0.2 * clamp01(bend - 0.9)), tipP = (p) => rotY(rotX(p, tilt), hipTwist);
      const upper = (p) => rotY(rotX(rotZ(p, lean), bend), yawU);
      const waist = add(pelvis, tipP([0, 0.07, 0])), chest = add(waist, upper([0, 0.15, 0]));
      out.push({ c: 1, a: waist, b: chest, r: 0.1, col: SKIN });
      out.push({ a: add(waist, upper([0, 0.06, 0.012])), r: 0.108, col: SKIN });
      for (let i = 0; i < 2; i++) {
        const side = i ? -1 : 1, A = P.arms[i];
        const sho = add(chest, upper([side * 0.1, 0.02, 0]));
        const up = upper(limbDir(side, A.swing, A.out)), el = add(sho, mul(up, 0.14));
        const fore = bendDir(up, A.elbow, upper(norm(A.toward))), wr = add(el, mul(fore, 0.13));
        out.push({ c: 1, a: sho, b: el, r: 0.04, col: SKIN });
        out.push({ c: 1, a: el, b: wr, r: 0.035, col: SKIN });
        hand(out, wr, fore, side, A.hand, upper);
      }
      // the big head
      const head = add(chest, upper(rotX([0, 0.16, 0.015], P.headTilt * 0.75)));
      const H = (p) => add(head, upper(rotX(rotY(p, P.headYaw), P.headTilt)));
      out.push({ a: head, r: 0.138, col: SKIN });
      out.push({ a: H([0.135, 0, -0.01]), r: 0.032, col: SKIN });
      out.push({ a: H([-0.135, 0, -0.01]), r: 0.032, col: SKIN });
      out.push({ a: H([0, 0.13, 0.02]), r: 0.026, col: HAIR });
      out.push({ a: H([0.047, 0.02, 0.121]), r: 0.019, col: DARK, eye: 1 });
      out.push({ a: H([-0.047, 0.02, 0.121]), r: 0.019, col: DARK, eye: 1 });
      // a pacifier: the shield across the lips, the button, and the ring
      // handle hanging from it, swinging with the dance
      out.push({ c: 1, a: H([-0.032, -0.056, 0.134]), b: H([0.032, -0.056, 0.134]), r: 0.019, col: PACI, bias: 0.01 });
      out.push({ a: H([0, -0.056, 0.152]), r: 0.012, col: [40, 30, 92], bias: 0.015 });
      const sway = Math.sin(cb) * 0.45 + P.shimmy * 0.8, RINGR = 0.019;
      let prev = null;
      for (let k = 0; k <= 10; k++) {
        const t = k / 10 * Math.PI * 2, y = -RINGR + RINGR * Math.cos(t), x = RINGR * Math.sin(t);
        const q = H([x, -0.056 + y * Math.cos(sway), 0.158 + y * Math.sin(sway) * -1]);
        if (prev) out.push({ c: 1, a: prev, b: q, r: 0.0042, col: PACI, bias: 0.02 });
        prev = q;
      }
      out.push({ a: H([0, -0.012, 0.137]), r: 0.017, col: SKIN });
      // the nappy rides the pelvis
      const dF = (p) => add(pelvis, tipP(p)), dD = tipP;
      for (const m of DIAPER) out.push({ q: m.q.map(dF), n: dD(m.n), band: m.band, hem: m.hem, wall: m.wall, bias: 0.03 });
      for (const m of PINS) out.push(m.c ? { c: 1, a: dF(m.a), b: dF(m.b), r: m.r, col: m.col, bias: 0.04 } : { a: dF(m.a), r: m.r, col: m.col, bias: 0.04 });
      return { prims: out, root: [px, pz] };
    }
    const RING = 6, LIGHT = norm([-0.45, 0.55, 0.7]);
    // ── the disco ball: a mirror-tiled sphere hanging over the star,
    // spinning, with a pin-spot (the key light) trained on it from high
    // out front, changing colour with the music -- every tile the spot
    // hits bounces it back out as a speck of light, so thousands of
    // specks sweep across the floor and the walls as it turns, and the
    // smoke drifting through the room catches the beams ──
    const BALL = [0, 1.32, 0], BALLR = 0.12, BLAT = 18, BLON = 36, KEY = norm([-0.5, 0.4, 0.8]);
    const ballPt = (la, lo, spin) => {
      const th = -Math.PI / 2 + la * Math.PI / BLAT, ph = lo * 2 * Math.PI / BLON + spin;
      return [Math.cos(th) * Math.sin(ph), Math.sin(th), Math.cos(th) * Math.cos(ph)];
    };
    // the mirrors that throw specks: far finer than the drawn tiles, spread
    // evenly over the sphere (a Fibonacci lattice), in hue buckets so each
    // bucket's specks go down as one path
    const SN = 4000, SB = 6, SX = new Float32Array(SN), SY = new Float32Array(SN), SZ = new Float32Array(SN);
    for (let k = 0; k < SN; k++) {
      const y = 1 - 2 * (k + 0.5) / SN, rr = Math.sqrt(1 - y * y), a = k * Math.PI * (3 - Math.sqrt(5));
      SX[k] = Math.cos(a) * rr; SY[k] = y; SZ[k] = Math.sin(a) * rr;
    }
    // smoke: slow puffs hanging low over the floor, rolling about
    const PUFFS = [];
    for (let k = 0; k < 16; k++) PUFFS.push({ x: (hash(k * 4.7 + 1) - 0.5) * 4, z: (hash(k * 9.1 + 2) - 0.5) * 4, y: 0.15 + hash(k * 2.3 + 3) * 1.3, r: 0.6 + hash(k * 6.1 + 4) * 0.7, ph: hash(k * 1.9 + 5) * 6.3 });
    let last = 0, t = 0, beat = 0, period = 0.5, prevBass = 0, fluxAvg = 0.02, cool = 0, lastOnset = -1e9;
    let ivals = [], flash = 0, orbit = 0, ringRot = 0, shout = 0, lastShout = -1e9, level = 0, crowd = 0, crowdBar = 0, spin = 0;
    let keyHue = 200, keyTarget = 200, pivX = 0, pivZ = 0;
    const joined = new Float32Array(RING);
    viz.registerMode({
      id: 'dancingbaby', label: 'Dancing baby',
      // Rotate swings the camera round the star's vertical axis, the way
      // the ring and the lights go round it, instead of rolling the picture
      ownsRotation: true,
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, videoFrame, speed, vizUserScale, vizUserRot = 0 } = ctx;
        const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now; t += dt;
        const bass = bassOf(freqData), energy = energyOf(freqData);

        // ── beat tracking ──
        const flux = Math.max(0, bass - prevBass); prevBass = bass;
        fluxAvg += (flux - fluxAvg) * 0.05; cool -= dt;
        if (cool <= 0 && flux > fluxAvg * 2.2 + 0.02 && bass > 0.2) {
          cool = 0.22;
          let iv = t - lastOnset;
          if (iv < 2.5) {
            while (iv > 0.8) iv /= 2;
            while (iv < 0.35) iv *= 2;
            ivals.push(iv); if (ivals.length > 9) ivals.shift();
            if (ivals.length >= 3) { const s = ivals.slice().sort((a, b) => a - b); period += (s[s.length >> 1] - period) * 0.5; }
          }
          lastOnset = t;
          beat -= (beat - Math.round(beat)) * 0.5;
          flash = 1;
          // the key light jumps to a new colour on the beat, further on a harder hit
          keyTarget += 50 + hash(lastOnset * 13.1) * 70 + bass * 60;
          if (bass > 0.6 && t - lastShout > 14) { shout = 1; lastShout = t; }
        }
        if (t - lastOnset > 4) period += (0.5 - period) * Math.min(1, dt * 0.5);   // silence: drift back to ~120 bpm
        beat += dt / period * speed;
        const beatIdx = Math.floor(beat);
        flash = Math.max(0, flash - dt * 3);
        orbit += dt * 0.22 * speed; spin += dt * 0.5 * speed;
        keyHue += (keyTarget - keyHue) * Math.min(1, dt * 8);
        const kh = ((keyHue % 360) + 360) % 360, kSat = 70 + energy * 30 | 0;
        const keyCol = (l, a, dh = 0) => `hsla(${(kh + dh + 360) % 360 | 0},${kSat}%,${l | 0}%,${a.toFixed(3)})`; ringRot += dt * 0.35 * speed * (0.6 + level);
        // the backup crowd follows the loudness over the last few seconds, not
        // the instant, and gains or loses at most one dancer a bar (with a
        // little hysteresis), each walking in or out at full size over a beat or two
        level += (energy - level) * Math.min(1, dt / 4);
        if (Math.floor(beat / 4) !== crowdBar) {
          crowdBar = Math.floor(beat / 4);
          const want = clamp01((level - 0.12) / 0.4) * RING;
          if (want > crowd + 0.7) crowd++; else if (want < crowd - 0.7) crowd--;
        }
        for (let k = 0; k < RING; k++) joined[k] = clamp01(joined[k] + (k < crowd ? 1 : -1) * dt * 0.6);

        // ── camera: swinging round the baby, looking a little down ──
        // the pivot is the star's own vertical axis, following it as the
        // triple steps carry it sideways (eased, so the hip sway doesn't jiggle the view)
        const { prims: body, root } = pose(beat);
        pivX += (root[0] - pivX) * Math.min(1, dt * 3); pivZ += (root[1] - pivZ) * Math.min(1, dt * 3);
        const cam = Math.sin(orbit) * 0.95 + vizUserRot, pitch = 0.2 + Math.sin(orbit * 0.7) * 0.06;
        const cc = Math.cos(cam), cs = Math.sin(cam), pc = Math.cos(pitch), ps = Math.sin(pitch);
        const D = 3.2, f = Math.min(VW, VH) * 1.55 * vizUserScale, oy = cy + VH * 0.02;
        const toCam = (p) => {
          const px = p[0] - pivX, pz = p[2] - pivZ, x = px * cc + pz * cs, z = -px * cs + pz * cc, y = p[1] - 0.45;
          return [x, y * pc - z * ps, y * ps + z * pc];
        };
        const proj = (p) => { const q = toCam(p), d = Math.max(0.2, D - q[2]); return [cx + q[0] * f / d, oy - q[1] * f / d, d]; };

        // ── backdrop: late-90s gradient, a spotlight that kicks with the beat ──
        const bg = vctx.createLinearGradient(0, 0, 0, VH);
        bg.addColorStop(0, `hsl(${(hueBase + 250) % 360 | 0},55%,12%)`);
        bg.addColorStop(1, `hsl(${(hueBase + 190) % 360 | 0},60%,22%)`);
        vctx.fillStyle = bg; vctx.fillRect(0, 0, VW, VH);
        const sp = proj([pivX, 0.5, pivZ]), sr = Math.min(VW, VH) * 0.5;
        const sg = vctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], sr);
        sg.addColorStop(0, `rgba(255,240,210,${(0.18 + flash * 0.18).toFixed(3)})`); sg.addColorStop(1, 'rgba(255,240,210,0)');
        vctx.fillStyle = sg; vctx.fillRect(0, 0, VW, VH);

        // the pin-spot's beam, from off-screen up to the ball, in the key's colour
        const ballC = proj(BALL), specA = 0.5 + flash * 0.4, src = add(BALL, mul(KEY, 2.5));
        if (D - toCam(src)[2] > 0.3) {
          const sc = proj(src), br = BALLR * f / ballC[2], dx = ballC[0] - sc[0], dy = ballC[1] - sc[1], dl = Math.hypot(dx, dy) || 1;
          const nx = -dy / dl, ny = dx / dl, bg2 = vctx.createLinearGradient(sc[0], sc[1], ballC[0], ballC[1]);
          bg2.addColorStop(0, keyCol(85, 0)); bg2.addColorStop(1, keyCol(85, 0.28 + flash * 0.15));
          vctx.fillStyle = bg2; vctx.beginPath();
          vctx.moveTo(sc[0] + nx * br * 0.3, sc[1] + ny * br * 0.3); vctx.lineTo(ballC[0] + nx * br * 1.1, ballC[1] + ny * br * 1.1);
          vctx.lineTo(ballC[0] - nx * br * 1.1, ballC[1] - ny * br * 1.1); vctx.lineTo(sc[0] - nx * br * 0.3, sc[1] - ny * br * 0.3);
          vctx.closePath(); vctx.fill();
        }
        // the ball's specks: the spot mirrored off every mirror it hits,
        // landing on the wall (drawn now) or on the floor (drawn over the
        // tiles, below); a few of the rays kept to show as beams in the smoke
        const floorSp = [], rays = [], wr = Math.min(VW, VH) * 0.011, cs0 = Math.cos(spin), sn0 = Math.sin(spin);
        for (let b = 0; b < SB; b++) floorSp.push([]);
        const wallSp = floorSp.map(() => []);
        for (let k = 0; k < SN; k++) {
          const nx = SX[k] * cs0 + SZ[k] * sn0, ny = SY[k], nz = -SX[k] * sn0 + SZ[k] * cs0;
          const kn = KEY[0] * nx + KEY[1] * ny + KEY[2] * nz;
          if (kn < 0.05) continue;
          const d = [2 * kn * nx - KEY[0], 2 * kn * ny - KEY[1], 2 * kn * nz - KEY[2]], bk = k % SB;
          if (d[1] < -0.12) {
            const tt = -BALL[1] / d[1], hit = [d[0] * tt, 0, d[2] * tt];
            if (hit[0] * hit[0] + hit[2] * hit[2] < 3.24) { floorSp[bk].push(hit); if (k % 53 === 0) rays.push(hit); }
            continue;
          }
          // the room's wall: a cylinder round the floor
          const hr = Math.hypot(d[0], d[2]);
          if (hr < 0.2) continue;
          const w = add(BALL, mul(d, 3.2 / hr));
          if (w[1] < 0 || w[1] > 4 || D - toCam(w)[2] < 0.8) continue;
          const pw = proj(w), r = wr * 3.2 / pw[2];
          if (pw[0] < -r || pw[0] > VW + r || pw[1] < -r || pw[1] > VH + r) continue;
          wallSp[bk].push([pw[0], pw[1], r]);
          if (k % 53 === 0) rays.push(w);
        }
        const speckCol = (b, a) => keyCol(84 + b * 2, a, (b - SB / 2) * 7);
        for (let b = 0; b < SB; b++) {
          vctx.fillStyle = speckCol(b, Math.min(1, specA * 1.1)); vctx.beginPath();
          for (const [x, y, r] of wallSp[b]) { vctx.moveTo(x + r, y); vctx.arc(x, y, r, 0, Math.PI * 2); }
          vctx.fill();
        }

        // ── the floor: a disco disc, textured with the video when there is one ──
        const T = 0.3, N = 6, RMAX = 1.85, vd = videoFrame && videoFrame.imageData.data;
        const tiles = [];
        for (let j = -N; j < N; j++) for (let i = -N; i < N; i++) {
          const mx = (i + 0.5) * T, mz = (j + 0.5) * T;
          if (Math.hypot(mx, mz) > RMAX) continue;
          tiles.push({ i, j, d: toCam([mx, 0, mz])[2] });
        }
        tiles.sort((a, b) => a.d - b.d);
        for (const { i, j } of tiles) {
          const q = [[i * T, 0, j * T], [(i + 1) * T, 0, j * T], [(i + 1) * T, 0, (j + 1) * T], [i * T, 0, (j + 1) * T]].map(proj);
          const lit = hash(i * 7.1 + j * 13.7 + beatIdx * 3.3) > 0.62;
          const glow = lit ? 0.35 + flash * 0.5 : 0;
          if (vd) {
            const px = Math.min(videoFrame.w - 1, ((i + N + 0.5) / (2 * N) * videoFrame.w) | 0);
            const py = Math.min(videoFrame.h - 1, ((j + N + 0.5) / (2 * N) * videoFrame.h) | 0), o = (py * videoFrame.w + px) * 4;
            const m = (c) => Math.min(255, (c * (0.55 + glow) + glow * 120) | 0);
            vctx.fillStyle = `rgb(${m(vd[o])},${m(vd[o + 1])},${m(vd[o + 2])})`;
          } else {
            const hue = (hueBase + hash(i * 3.7 + j * 5.3) * 360) % 360;
            vctx.fillStyle = `hsl(${hue | 0},${lit ? 90 : 45}%,${(lit ? 45 + flash * 25 : 12 + ((i + j) & 1) * 6) | 0}%)`;
          }
          vctx.beginPath(); vctx.moveTo(q[0][0], q[0][1]);
          for (let k = 1; k < 4; k++) vctx.lineTo(q[k][0], q[k][1]);
          vctx.closePath(); vctx.fill();
          vctx.strokeStyle = 'rgba(0,0,0,0.35)'; vctx.lineWidth = 1; vctx.stroke();
        }
        // the specks on the floor, flattened by the view
        const fr = 0.016 * f, fy = 0.2 + ps * 0.9;
        for (let b = 0; b < SB; b++) {
          vctx.fillStyle = speckCol(b, Math.min(1, specA * 1.3)); vctx.beginPath();
          for (const hit of floorSp[b]) {
            const c = proj(hit), rr = Math.max(0.8, fr / c[2]);
            vctx.moveTo(c[0] + rr, c[1]); vctx.ellipse(c[0], c[1], rr, rr * fy, 0, 0, Math.PI * 2);
          }
          vctx.fill();
        }

        // ── the babies: the star at the centre, backup dancers in an orbiting ring ──
        const dancers = [{ x: 0, z: 0, yaw: 0, s: 1 }];
        for (let k = 0; k < RING; k++) {
          if (joined[k] <= 0) continue;
          const a = ringRot + k * Math.PI * 2 / RING, e = smooth(0, 1, joined[k]), r = 1.25 + (1 - e) * 0.8;
          dancers.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: a, s: 0.55, alpha: e });
        }
        const prims = [];
        const dirOf = (d) => { const x = d[0] * cc + d[2] * cs, z = -d[0] * cs + d[2] * cc; return [x, d[1] * pc - z * ps, d[1] * ps + z * pc]; };
        const scr = (q) => { const d = Math.max(0.2, D - q[2]); return [cx + q[0] * f / d, oy - q[1] * f / d, d]; };
        for (const dn of dancers) {
          const world = (p) => { const r = rotY(mul(p, dn.s), dn.yaw); return [r[0] + dn.x, r[1], r[2] + dn.z]; };
          // shadow on the floor first, flattened by the view
          const rw = world([root[0], 0, root[1]]), c = proj(rw), e = proj([rw[0] + 0.2 * dn.s, 0, rw[2]]);
          const rr = Math.max(1, Math.hypot(e[0] - c[0], e[1] - c[1]) * 1.1);
          const al = dn.alpha === undefined ? 1 : dn.alpha;
          vctx.fillStyle = `rgba(0,0,0,${(0.35 * al).toFixed(3)})`;
          vctx.beginPath(); vctx.ellipse(c[0], c[1], rr, rr * (0.2 + ps * 0.9), 0, 0, Math.PI * 2); vctx.fill();
          for (const pr of body) {
            const bias = (pr.bias || 0) * dn.s;
            if (pr.q) {
              const cq = pr.q.map((p) => toCam(world(p))), nc = dirOf(rotY(pr.n, dn.yaw));
              const m = mul(add(cq[0], cq[2]), 0.5);
              // a panel facing away is the inside of the far side, seen over the waistband: shaded, and not pulled forward
              const inside = dot(nc, [-m[0], -m[1], D - m[2]]) <= 0;
              if (inside && pr.wall) continue;
              const pts = cq.map(scr);
              prims.push({ al, pts, pr, inside, lit: inside ? 0 : Math.max(0, dot(nc, LIGHT)), d: (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4 - (inside ? 0 : bias) });
              continue;
            }
            const a = proj(world(pr.a)), b = pr.c ? proj(world(pr.b)) : null;
            prims.push({ al, a, b, r: pr.r * dn.s, col: pr.col, eye: pr.eye, d: (b ? (a[2] + b[2]) / 2 : a[2]) - bias });
          }
        }
        prims.sort((p, q) => q.d - p.d);
        const hsl = (c, dl, al = 1) => `hsla(${c[0]},${c[1]}%,${Math.max(0, Math.min(100, c[2] + dl))}%,${al})`;
        vctx.lineCap = 'round'; vctx.lineJoin = 'round';
        for (const p of prims) {
          vctx.globalAlpha = p.al;
          if (p.pts) {
            // cloth: soft cotton shading, a seam line at the hem, stitching under the waistband
            const q = p.pts, L = Math.round(58 + p.lit * 38 + (p.pr.band ? 2 : 0) - (p.pr.wall ? 16 : 0) - (p.inside ? 12 : 0));
            const col = `hsl(42,${p.pr.band ? 18 : 24}%,${L}%)`;
            vctx.fillStyle = col; vctx.strokeStyle = col; vctx.lineWidth = 1;
            vctx.beginPath(); vctx.moveTo(q[0][0], q[0][1]);
            for (let k = 1; k < 4; k++) vctx.lineTo(q[k][0], q[k][1]);
            vctx.closePath(); vctx.fill(); vctx.stroke();
            const lw = Math.max(0.6, 0.005 * f / p.d);
            if (p.inside) continue;
            if (p.pr.hem) {
              vctx.strokeStyle = `hsla(40,25%,${L - 24}%,0.8)`; vctx.lineWidth = lw * 1.4;
              vctx.beginPath(); vctx.moveTo(q[3][0], q[3][1]); vctx.lineTo(q[2][0], q[2][1]); vctx.stroke();
            } else if (p.pr.band) {
              const y0 = 0.35, a = [lerp(q[0][0], q[3][0], y0), lerp(q[0][1], q[3][1], y0)], b = [lerp(q[1][0], q[2][0], y0), lerp(q[1][1], q[2][1], y0)];
              vctx.strokeStyle = `hsla(40,25%,${L - 20}%,0.7)`; vctx.lineWidth = lw * 0.7; vctx.setLineDash([lw * 2, lw * 2]);
              vctx.beginPath(); vctx.moveTo(a[0], a[1]); vctx.lineTo(b[0], b[1]); vctx.stroke(); vctx.setLineDash([]);
            }
            continue;
          }
          const R = p.r * f / p.a[2];
          if (R < 0.3) continue;
          if (p.b) {
            // capsule: a dark rim, the body, then a highlight toward the light (up and left)
            const w = 2 * p.r * f / ((p.a[2] + p.b[2]) / 2);
            vctx.strokeStyle = hsl(p.col, -22); vctx.lineWidth = w;
            vctx.beginPath(); vctx.moveTo(p.a[0], p.a[1]); vctx.lineTo(p.b[0], p.b[1]); vctx.stroke();
            vctx.strokeStyle = hsl(p.col, 0); vctx.lineWidth = w * 0.74;
            vctx.beginPath(); vctx.moveTo(p.a[0] - w * 0.06, p.a[1] - w * 0.06); vctx.lineTo(p.b[0] - w * 0.06, p.b[1] - w * 0.06); vctx.stroke();
            vctx.strokeStyle = hsl(p.col, 14, 0.8); vctx.lineWidth = w * 0.26;
            vctx.beginPath(); vctx.moveTo(p.a[0] - w * 0.18, p.a[1] - w * 0.2); vctx.lineTo(p.b[0] - w * 0.18, p.b[1] - w * 0.2); vctx.stroke();
          } else {
            const [x, y] = p.a;
            const g = vctx.createRadialGradient(x - R * 0.35, y - R * 0.4, R * 0.08, x, y, R);
            g.addColorStop(0, hsl(p.col, p.eye ? 40 : 18)); g.addColorStop(p.eye ? 0.3 : 0.55, hsl(p.col, 0)); g.addColorStop(1, hsl(p.col, -24));
            vctx.fillStyle = g; vctx.beginPath(); vctx.arc(x, y, R, 0, Math.PI * 2); vctx.fill();
          }
        }
        vctx.lineJoin = 'miter'; vctx.globalAlpha = 1;

        // ── smoke: soft puffs rolling slowly through the room, lit by the key
        // light (brighter on the beat), with the ball's beams showing through it
        for (const pf of PUFFS) {
          const w = [pf.x + Math.sin(t * 0.07 + pf.ph) * 0.5, pf.y + Math.sin(t * 0.11 + pf.ph * 2) * 0.12, pf.z + Math.cos(t * 0.05 + pf.ph) * 0.5];
          if (D - toCam(w)[2] < 0.6) continue;
          const c = proj(w), r = pf.r * f / c[2], a = 0.09 + flash * 0.04 + level * 0.06;
          const g = vctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
          g.addColorStop(0, keyCol(72, a, -20 + pf.ph * 6)); g.addColorStop(0.5, keyCol(65, a * 0.5, -20 + pf.ph * 6)); g.addColorStop(1, keyCol(60, 0));
          vctx.fillStyle = g; vctx.fillRect(c[0] - r, c[1] - r, 2 * r, 2 * r);
        }
        vctx.strokeStyle = keyCol(85, 0.09 + flash * 0.06); vctx.lineWidth = Math.max(0.7, 0.004 * f / ballC[2]); vctx.beginPath();
        for (const w of rays) { const c = proj(w); vctx.moveTo(ballC[0], ballC[1]); vctx.lineTo(c[0], c[1]); }
        vctx.stroke();

        // ── the disco ball: its chain up out of frame, then the front-facing
        // mirror tiles, each catching the light (and some flashing on the beat)
        const top = proj(add(BALL, [0, BALLR, 0]));
        vctx.strokeStyle = 'rgba(170,170,180,0.7)'; vctx.lineWidth = Math.max(1, 0.006 * f / top[2]);
        vctx.beginPath(); vctx.moveTo(top[0], top[1]); vctx.lineTo(top[0] + (top[0] - ballC[0]) * 40, top[1] + (top[1] - ballC[1]) * 40); vctx.stroke();
        const glints = [];
        vctx.lineWidth = 0.6;
        for (let la = 0; la < BLAT; la++) for (let lo = 0; lo < BLON; lo++) {
          const n = ballPt(la + 0.5, lo + 0.5, spin), nc = dirOf(n), m = toCam(add(BALL, mul(n, BALLR)));
          if (dot(nc, [-m[0], -m[1], D - m[2]]) <= 0) continue;
          const q = [[la, lo], [la, lo + 1], [la + 1, lo + 1], [la + 1, lo]].map(([a, o]) => proj(add(BALL, mul(ballPt(a, o, spin), BALLR))));
          // a mirror: bright where it bounces the key light to the camera
          const view = norm([-m[0], -m[1], D - m[2]]), refl = sub(mul(nc, 2 * dot(nc, view)), view);
          const spec = Math.pow(Math.max(0, dot(refl, dirOf(KEY))), 12) + Math.max(0, dot(n, KEY)) * 0.35;
          const pop = hash(la * 31.1 + lo * 7.7 + beatIdx * 5.3) > 0.9 ? flash : 0;
          const L = Math.min(96, 30 + Math.max(0, nc[1]) * 18 + hash(la * 5.1 + lo * 9.7) * 16 + spec * 55 + pop * 50);
          // tinted by the key light where it's catching it
          vctx.fillStyle = spec > 0.2 ? `hsl(${kh | 0},${Math.min(90, 15 + spec * 60 + pop * 40) | 0}%,${L | 0}%)` : `hsl(${(hueBase + 200 + hash(la + lo * 3.1) * 40) % 360 | 0},${12 + pop * 60 | 0}%,${L | 0}%)`;
          vctx.strokeStyle = 'rgba(20,20,30,0.6)';
          vctx.beginPath(); vctx.moveTo(q[0][0], q[0][1]);
          for (let k = 1; k < 4; k++) vctx.lineTo(q[k][0], q[k][1]);
          vctx.closePath(); vctx.fill(); vctx.stroke();
          if (spec > 0.8 || pop > 0.5) glints.push([(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, Math.max(spec, pop)]);
        }
        // four-pointed sparkles on the brightest tiles
        const gr = BALLR * f / ballC[2];
        vctx.fillStyle = 'rgba(255,255,255,0.9)';
        glints.sort((p, q) => q[2] - p[2]);
        for (const [x, y, k] of glints.slice(0, 4)) {
          const a = gr * (0.25 + k * 0.3), b = a * 0.12;
          vctx.beginPath();
          vctx.moveTo(x, y - a); vctx.lineTo(x + b, y - b); vctx.lineTo(x + a, y); vctx.lineTo(x + b, y + b);
          vctx.lineTo(x, y + a); vctx.lineTo(x - b, y + b); vctx.lineTo(x - a, y); vctx.lineTo(x - b, y - b);
          vctx.closePath(); vctx.fill();
        }

        // ── now and then, on a big hit: the song's hook in WordArt ──
        if (shout > 0) {
          shout = Math.max(0, shout - dt * 0.45);
          const words = 'OOGA CHAKA', bs = Math.round(Math.min(VW, VH) * 0.1);
          vctx.save();
          vctx.font = `italic 900 ${bs}px Impact, "Arial Black", sans-serif`; vctx.textBaseline = 'middle';
          const tw = vctx.measureText(words).width;
          let x = VW / 2 - tw / 2;
          const y0 = VH * 0.16, a = Math.min(1, shout * 3);
          for (let k = 0; k < words.length; k++) {
            const ch = words[k], cw = vctx.measureText(ch).width;
            const y = y0 - Math.abs(Math.sin((beat + k * 0.12) * Math.PI)) * bs * 0.25;
            for (let e = 5; e > 0; e--) {                                  // the extrusion
              vctx.fillStyle = `rgba(40,0,70,${(a * 0.9).toFixed(3)})`; vctx.fillText(ch, x + e * bs * 0.02, y + e * bs * 0.02);
            }
            const g = vctx.createLinearGradient(0, y - bs / 2, 0, y + bs / 2);
            g.addColorStop(0, `hsla(${(hueBase + k * 36) % 360 | 0},100%,70%,${a})`);
            g.addColorStop(1, `hsla(${(hueBase + k * 36 + 120) % 360 | 0},100%,50%,${a})`);
            vctx.fillStyle = g; vctx.fillText(ch, x, y);
            x += cw;
          }
          vctx.restore();
        }
        vctx.lineCap = 'butt';
      },
    });
  })();

  // ── Synthwave (mode): an outrun sunset. A striped sun sinks behind two
  // ranges of wireframe mountains whose peaks are the spectrum (bass on
  // the outside, treble toward the sun, mirrored), over a neon grid that
  // scrolls toward the camera at Speed, laid over a mirror floor that
  // reflects the whole sky and ripples with the waveform. Each kick sends a bright rung
  // racing down the grid and widens the gaps in the sun; the video, when
  // there is one, shows through the sun's face. Palms sway on the edges.
  (function () {
    const RIDGE = 48, sunBuf = offscreen(), vidBuf = offscreen(), skyBuf = offscreen();
    let stars = null, far = null, near = null, lastRot = 0, bassAvg = 0, kick = 0, rungs = [];
    function palm(vctx, x, baseY, h, lean, sway, dir) {
      const topX = x + lean * h, topY = baseY - h;
      vctx.strokeStyle = '#07010c'; vctx.fillStyle = '#07010c'; vctx.lineCap = 'round';
      for (let i = 0; i < 12; i++) {                        // a trunk that tapers
        const t0 = i / 12, t1 = (i + 1) / 12, bend = (t) => lean * h * t * t;
        vctx.lineWidth = h * (0.05 - t0 * 0.03);
        vctx.beginPath();
        vctx.moveTo(x + bend(t0), baseY - h * t0); vctx.lineTo(x + bend(t1), baseY - h * t1); vctx.stroke();
      }
      // the crown: fronds that arch up and droop, each a spine carrying two
      // dense rows of tapered leaflets that hang toward the ground, all
      // filled as one silhouette so the crown reads solid, not as sticks
      const leaves = new Path2D(), spines = new Path2D();
      const FRONDS = [-172, -148, -122, -96, -70, -44, -18, 8, 168, 194, 28];
      for (let n = 0; n < FRONDS.length; n++) {
        const a = (FRONDS[n] * dir + (dir < 0 ? 180 : 0)) * Math.PI / 180 + sway * (0.7 + 0.3 * Math.sin(n * 1.7));
        const len = h * (0.36 + 0.1 * hash(n * 5.3 + dir));
        const ux = Math.cos(a), uy = Math.sin(a), up = uy < 0 ? -uy : 0;
        const x1 = topX + ux * len * 0.5, y1 = topY + uy * len * 0.5 - len * (0.18 + up * 0.2);
        const x2 = topX + ux * len, y2 = topY + uy * len * 0.55 + len * (0.28 - up * 0.1);
        spines.moveTo(topX, topY); spines.quadraticCurveTo(x1, y1, x2, y2);
        const LEAFLETS = 24;
        for (let k = 1; k <= LEAFLETS; k++) {
          const t = 0.06 + 0.94 * k / LEAFLETS, u = 1 - t;
          const px = u * u * topX + 2 * u * t * x1 + t * t * x2, py = u * u * topY + 2 * u * t * y1 + t * t * y2;
          let tx = 2 * u * (x1 - topX) + 2 * t * (x2 - x1), ty = 2 * u * (y1 - topY) + 2 * t * (y2 - y1);
          const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
          const L = len * (0.07 + 0.2 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.8));
          const w = len * 0.02 * (1 - t * 0.5);
          for (const side of [-1, 1]) {
            // out from the spine, swept forward along it, pulled down by gravity
            let dx = -ty * side + tx * 0.45, dy = tx * side + ty * 0.45 + 0.9;
            const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
            const bx = px - tx * w, by = py - ty * w;
            leaves.moveTo(bx, by);
            leaves.quadraticCurveTo(px + dx * L * 0.5 + tx * w * 2, py + dy * L * 0.5 + ty * w * 2 - L * 0.08, px + dx * L, py + dy * L);
            leaves.quadraticCurveTo(px + dx * L * 0.45, py + dy * L * 0.45 + L * 0.06, px + tx * w, py + ty * w);
            leaves.closePath();
          }
        }
      }
      vctx.fill(leaves);
      vctx.lineWidth = Math.max(1, h * 0.008); vctx.stroke(spines);
      for (let c = 0; c < 4; c++) {                          // coconuts tucked under the crown
        vctx.beginPath(); vctx.arc(topX + (c - 1.5) * h * 0.022, topY + h * (0.02 + (c % 2) * 0.015), h * 0.018, 0, Math.PI * 2); vctx.fill();
      }
    }
    viz.registerMode({
      id: 'synthwave', label: 'Synthwave',
      init() { far = near = null; rungs = []; kick = 0; bassAvg = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale, videoFrame } = ctx;
        if (!stars) stars = Array.from({ length: 120 }, (_, i) => ({ x: hash(i * 4.3), y: hash(i * 9.1), s: 0.6 + hash(i * 2.2) * 1.3, p: hash(i * 6.7) * 6.28 }));
        if (!far) { far = new Float32Array(RIDGE); near = new Float32Array(RIDGE); lastRot = vizRot; }
        const dRot = Math.max(0, Math.min(0.5, vizRot - lastRot)); lastRot = vizRot;
        const bass = bassOf(freqData), energy = energyOf(freqData);
        // a kick is the bass jumping clear of its recent level -- an absolute
        // margin, since a ratio never fires on bass-heavy mixes that sit high
        bassAvg += (bass - bassAvg) * 0.12;
        if (bass - bassAvg > 0.05 && kick < 0.5) { kick = 1; rungs.push(40); }
        kick *= 0.9;
        const S = Math.min(VW, VH), zoom = vizUserScale;
        const yH = cy + VH * 0.04, H1 = hueBase + 300, H2 = hueBase + 190;

        // ── sky, sun and mountains, drawn into a buffer so the floor can mirror them ──
        const { c: skc, ctx: g } = skyBuf(VW, VH);
        g.clearRect(0, 0, VW, VH);
        const sky = g.createLinearGradient(0, 0, 0, yH);
        sky.addColorStop(0, '#05010f');
        sky.addColorStop(0.6, `hsl(${(H1 - 40) % 360 | 0},60%,10%)`);
        sky.addColorStop(1, `hsl(${H1 % 360 | 0},80%,${(24 + kick * 10) | 0}%)`);
        g.fillStyle = sky; g.fillRect(0, 0, VW, VH);
        for (const st of stars) {
          const sy = st.y * yH * 0.8; if (sy > yH) continue;
          const tw = 0.5 + 0.5 * Math.sin(vizRot * 4 + st.p);
          g.fillStyle = `rgba(255,230,255,${(0.1 + tw * 0.6 * (1 - sy / yH)).toFixed(2)})`;
          g.fillRect(st.x * VW, sy, st.s, st.s);
        }

        // ── the sun: gradient disc, video through its face, bands cut out of its lower half ──
        const R = S * 0.26 * zoom, sunY = yH - R * 0.35;
        const sz = Math.ceil(R * 2) + 2, { c: sc, ctx: sx } = sunBuf(sz, sz);
        sx.globalCompositeOperation = 'source-over'; sx.clearRect(0, 0, sz, sz);
        const sg = sx.createLinearGradient(0, 0, 0, sz);
        sg.addColorStop(0, `hsl(${(hueBase + 50) % 360 | 0},100%,65%)`);
        sg.addColorStop(0.55, `hsl(${(hueBase + 15) % 360 | 0},100%,58%)`);
        sg.addColorStop(1, `hsl(${(hueBase + 320) % 360 | 0},100%,55%)`);
        sx.fillStyle = sg; sx.beginPath(); sx.arc(sz / 2, sz / 2, R, 0, Math.PI * 2); sx.fill();
        if (videoFrame) {
          const { c: vc, ctx: vx } = vidBuf(videoFrame.w, videoFrame.h);
          vx.putImageData(videoFrame.imageData, 0, 0);
          // fit to the part of the sun above the horizon (the rest sinks behind it)
          const a = videoFrame.w / videoFrame.h, dh = Math.min(sz, sz / 2 + (yH - sunY)), dw = dh * a;
          // luminosity: the sun keeps its gradient's colours but takes its light
          // and shade from the picture, so the video reads clearly without
          // losing the sun; a little of the gradient screened back on top
          // stops dark scenes from blacking the sun out
          sx.globalCompositeOperation = 'luminosity';
          sx.drawImage(vc, (sz - dw) / 2, 0, dw, dh);
          sx.globalAlpha = 0.3; sx.globalCompositeOperation = 'screen';
          sx.fillStyle = sg; sx.fillRect(0, 0, sz, sz);
          sx.globalAlpha = 1; sx.globalCompositeOperation = 'destination-in';
          sx.beginPath(); sx.arc(sz / 2, sz / 2, R, 0, Math.PI * 2); sx.fill();
        }
        sx.globalCompositeOperation = 'destination-out';
        const drift = (vizRot * 0.6) % 1;
        for (let b = 0; b < 8; b++) {
          const t = (b + drift) / 8, y = sz / 2 + t * R;
          sx.fillRect(0, y, sz, R * (0.012 + t * 0.07) * (1 + kick * 0.8));
        }
        sx.globalCompositeOperation = 'source-over';
        g.save();
        g.shadowColor = `hsl(${(hueBase + 330) % 360 | 0},100%,60%)`; g.shadowBlur = R * (0.35 + energy * 0.5);
        g.drawImage(sc, cx - sz / 2, sunY - sz / 2);
        g.restore();

        // ── mountains: the spectrum, mirrored about the sun ──
        const maxBin = Math.floor(freqData.length * 0.7);
        for (let i = 0; i < RIDGE; i++) {
          const lo = Math.floor(Math.pow(i / RIDGE, 1.7) * maxBin), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / RIDGE, 1.7) * maxBin));
          let v = 0; for (let k = lo; k < hi; k++) v += freqData[k]; v /= (hi - lo) * 255;
          far[i] = Math.max(far[i] * 0.97, v);
          near[i] += (v - near[i]) * 0.25;
        }
        const range = (lvl, amp, rough, fill, stroke, lw) => {
          const pts = [];
          for (let j = 0; j <= RIDGE * 2; j++) {
            const i = Math.abs(RIDGE - j), idx = RIDGE - 1 - Math.min(RIDGE - 1, i);   // bass at the edges
            const edge = Math.min(1, i / RIDGE * 1.4);             // valley where the sun sets
            const h = (lvl[idx] * 0.8 + 0.12 + rough * hash(j * 3.7 + amp)) * amp * edge * zoom;
            pts.push([cx + (j - RIDGE) / RIDGE * VW * 0.62 * zoom, yH - h]);
          }
          g.beginPath(); g.moveTo(pts[0][0], yH);
          for (const [x, y] of pts) g.lineTo(x, y);
          g.lineTo(pts[pts.length - 1][0], yH); g.closePath();
          g.fillStyle = fill; g.fill();
          g.strokeStyle = stroke; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke();
          g.beginPath();                                          // wireframe ribs down to the base
          for (let j = 0; j < pts.length; j += 2) { g.moveTo(pts[j][0], pts[j][1]); g.lineTo(cx + (pts[j][0] - cx) * 0.85, yH); }
          g.globalAlpha = 0.35; g.stroke(); g.globalAlpha = 1;
        };
        const g1 = `hsl(${H2 % 360 | 0},100%,60%)`, g2 = `hsl(${H1 % 360 | 0},100%,62%)`;
        range(far, S * 0.3, 0.25, '#0b0320', g1, Math.max(1, S / 700));
        range(near, S * 0.17, 0.35, '#10021a', g2, Math.max(1, S / 500));

        vctx.drawImage(skc, 0, 0);

        // ── the grid floor ──
        const fl = vctx.createLinearGradient(0, yH, 0, VH);
        fl.addColorStop(0, `hsl(${H1 % 360 | 0},70%,14%)`); fl.addColorStop(1, '#020006');
        vctx.fillStyle = fl; vctx.fillRect(0, yH, VW, VH - yH);
        const f = VH * 0.9, camH = 1, spacing = 1 / zoom, zFar = 40;
        const zNear = camH * f / Math.max(1, VH - yH);
        const scroll = (vizRot * 5) % spacing;
        // the low camera squashes the floor, so the lengthwise lines run closer than the rungs
        const xs = spacing * 0.35, zb = zNear * 0.5, spanX = (VW / 2 + Math.abs(cx - VW / 2)) * zb / f + xs;
        // the floor is a mirror: the sky above the horizon, flipped under it
        // strip by strip, each strip pushed sideways by the waveform (like
        // Mirror's trace through its middle) so the reflection ripples with
        // the music -- harder toward the camera, calm at the horizon
        const Hf = VH - yH, STRIP = Math.max(2, Math.ceil(Hf / 140)), WL = ctx.waveData.length;
        for (let y0 = 0; y0 < Hf; y0 += STRIP) {
          const sy = yH - y0 - STRIP; if (sy < 0) break;
          const d = y0 / Hf, w = WL ? ctx.waveData[Math.min(WL - 1, (d * WL) | 0)] / 128 - 1 : 0;
          const dx = (w * S * 0.08 + Math.sin(y0 / (S * 0.012) - vizRot * 9) * S * 0.004 * (1 + energy * 3)) * d;
          vctx.globalAlpha = 0.85 * (1 - d * 0.55);
          vctx.drawImage(skc, 0, sy, VW, STRIP, dx, yH + y0, VW, STRIP + 1);
        }
        vctx.globalAlpha = 1;
        const gridCol = (a) => `hsla(${H1 % 360 | 0},100%,${(55 + energy * 20 + kick * 15) | 0}%,${a.toFixed(3)})`;
        vctx.lineWidth = Math.max(1, S / 600);
        for (let z = zNear - scroll + spacing; z < zFar; z += spacing) {
          const y = yH + camH * f / z, a = clamp01(1 - z / zFar) * (0.3 + energy * 0.25 + kick * 0.35);
          vctx.strokeStyle = gridCol(a); vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(VW, y); vctx.stroke();
        }
        vctx.strokeStyle = gridCol(0.3 + kick * 0.4); vctx.beginPath();
        for (let X = -Math.ceil(spanX / xs) * xs; X <= spanX; X += xs) {
          vctx.moveTo(cx + X * f / zb, yH + camH * f / zb); vctx.lineTo(cx + X * f / zFar, yH + camH * f / zFar);
        }
        vctx.stroke();
        // Mirror's waveform trace, laid down the middle of the road: evenly
        // spaced in depth (so it bunches up toward the horizon like the rungs
        // do), each sample swinging it left or right of the centre line
        if (WL) {
          const zTop = Math.min(zFar, 24), zBot = zNear * 0.9, amp = xs * 7 * (1 + kick * 0.5);
          vctx.save();
          vctx.beginPath();
          for (let i = 0; i < WL; i++) {
            const t = i / (WL - 1), z = zTop + (zBot - zTop) * t;
            const X = (ctx.waveData[i] / 128 - 1) * amp;
            const x = cx + X * f / z, y = yH + camH * f / z;
            i === 0 ? vctx.moveTo(x, y) : vctx.lineTo(x, y);
          }
          vctx.lineJoin = 'round';
          vctx.shadowColor = g1; vctx.shadowBlur = S * 0.015;
          vctx.strokeStyle = `hsla(${H2 % 360 | 0},100%,70%,0.9)`; vctx.lineWidth = Math.max(1.5, S / 300); vctx.stroke();
          vctx.shadowBlur = 0;
          vctx.strokeStyle = `hsla(${H2 % 360 | 0},60%,92%,0.9)`; vctx.lineWidth = Math.max(1, S / 900); vctx.stroke();
          vctx.restore();
        }
        // kicks: bright rungs racing toward the camera
        vctx.save(); vctx.shadowColor = g2; vctx.shadowBlur = S * 0.02; vctx.lineWidth = Math.max(2, S / 250);
        rungs = rungs.filter(z => z > zNear * 0.8);
        for (let r = 0; r < rungs.length; r++) {
          rungs[r] -= dRot * 110;
          const z = rungs[r], y = yH + camH * f / Math.max(zNear * 0.8, z);
          vctx.strokeStyle = `hsla(${(H1 + 20) % 360 | 0},100%,80%,${clamp01(1.2 - z / zFar).toFixed(3)})`;
          vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(VW, y); vctx.stroke();
        }
        vctx.restore();
        // haze over the horizon line
        const hz = vctx.createLinearGradient(0, yH - S * 0.03, 0, yH + S * 0.05);
        hz.addColorStop(0, `hsla(${H1 % 360 | 0},100%,70%,0)`);
        hz.addColorStop(0.4, `hsla(${H1 % 360 | 0},100%,75%,${(0.35 + kick * 0.3).toFixed(3)})`);
        hz.addColorStop(1, `hsla(${H1 % 360 | 0},100%,70%,0)`);
        vctx.fillStyle = hz; vctx.fillRect(0, yH - S * 0.03, VW, S * 0.08);

        // ── palms on the edges ──
        const sway = Math.sin(vizRot * 2) * 0.08 + bass * 0.18;
        palm(vctx, VW * 0.07, VH * 1.02, VH * 0.62 * zoom, 0.18, sway, 1);
        palm(vctx, VW * 0.93, VH * 1.02, VH * 0.5 * zoom, -0.22, sway * 0.8, -1);
        vctx.lineCap = 'butt'; vctx.lineJoin = 'miter';
      },
    });
  })();

  // ── Fire (mode): the old demoscene fire effect, played to the music.
  // A grid of heat where every cell takes the heat of the cells below
  // it, minus a little. Along the bottom is a row of burners, each
  // feeding its own flickering tongue, and they're the spectrum: bass on
  // the left, treble on the right, each burner's flame as tall as its
  // band is loud. The heat rises through a turbulent sway that grows
  // with height, so the tongues lick and curl and narrow to points,
  // leaning in a gusting wind. The louder it gets the less the heat decays and
  // the higher the whole fire climbs. A kick flares the fuel
  // bed and throws a shower of sparks up out of the flames. The palette
  // runs black, through the drifting hue, to white-hot, and the video
  // plays behind it all, dimmed, with each flame shading it.
  (function () {
    const grid = offscreen(), shade = offscreen();
    let GW = 0, GH = 0, heat = null, next = null, sparks = [];
    let acc = 0, bassAvg = 0, cooldown = 0, flare = 0, gust = 0, lutHue = -1, LUT = null, tongues = [], clock = 0;
    // the backdrop is the player's real <video> at full resolution, not
    // the tiny sampled frame the modes get -- the borrowed footage when
    // a video swap is loaded, the track's own picture otherwise
    function picture() {
      const sv = document.querySelector('#global-player video.swap-video');
      if (sv && sv.getAttribute('src') && sv.readyState >= 2 && sv.videoWidth) return sv;
      const v = document.querySelector('#global-player video:not(.swap-video)');
      return v && v.readyState >= 2 && v.videoWidth ? v : null;
    }
    function reset(w, h) { GW = w; GH = h; heat = new Float32Array(w * h); next = new Float32Array(w * h); makeTongues(); }
    // heat 0..1 -> rgb, 256 steps: black, a deep ember of the hue, the
    // hue at full, a yellower shift of it, then white
    function buildLut(h0) {
      LUT = new Uint8ClampedArray(256 * 3);
      const hsl = (hh, ss, ll) => {
        const a = ss * Math.min(ll, 1 - ll), f = (m) => { const k = (m + hh / 30) % 12; return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
        return [f(0) * 255, f(8) * 255, f(4) * 255];
      };
      for (let i = 0; i < 256; i++) {
        const t = clamp01((i / 255 - 0.1) / 0.9);   // black below a threshold, so each flame has an edge
        const c = hsl((h0 + t * 55) % 360, 1, Math.min(1, t * 0.6 + t * t * 0.38));
        LUT[i * 3] = c[0]; LUT[i * 3 + 1] = c[1]; LUT[i * 3 + 2] = c[2];
      }
      lutHue = h0;
    }
    // the burners along the bottom: each one feeds its own tongue of
    // flame, flickering, wandering a little, and fed by the band under it
    function makeTongues() {
      const n = Math.max(8, Math.round(GW / 7));
      tongues = Array.from({ length: n }, (_, k) => ({
        x: (k + 0.2 + Math.random() * 0.6) / n, w: 2 + Math.random() * 2.5,
        ph: Math.random() * 100, f: 5 + Math.random() * 6, jit: 0, amp: 0.5,
      }));
    }
    function step(freqData, energy, react, wind) {
      clock += 1 / 60;
      const maxBin = Math.floor(freqData.length * 0.7);
      const bandAt = (fx) => freqData[Math.min(maxBin - 1, Math.floor(Math.pow(fx, 1.7) * maxBin))] / 255;
      // fuel: the bottom two rows, a bump per burner, how tall its band
      // is loud -- bass on the left, treble on the right
      for (const t of tongues) {
        t.x += Math.sin(clock * 0.35 + t.ph) * 0.0006; t.x -= Math.floor(t.x);
        t.jit = t.jit * 0.7 + (Math.random() - 0.5) * 0.3;
        const target = (0.45 + clamp01(bandAt(t.x) * react) * 0.4 + flare * 0.2) * (0.8 + 0.2 * Math.sin(clock * t.f + t.ph) + t.jit);
        t.amp += (target - t.amp) * 0.35;   // eased, so a kick swells the flames instead of stamping a stripe up them
      }
      const base = (GH - 2) * GW;
      for (let x = 0; x < GW; x++) {
        let v = 0.25 + Math.random() * 0.15;   // a glowing bed the tongues rise out of
        for (const t of tongues) {
          let dx = x - t.x * GW; if (dx > GW / 2) dx -= GW; else if (dx < -GW / 2) dx += GW;   // wraps, like the propagation
          const q = dx / t.w; if (q > -3 && q < 3) v += t.amp * Math.exp(-q * q);
        }
        v = Math.min(0.95, v); heat[base + x] = v; heat[base + GW + x] = v;
      }
      // loud: the heat decays slower, so the flames stand taller. It's
      // subtracted, not scaled, so a tongue's thin edges die first and
      // it narrows to a point
      const decay = (1.05 / GH) * (1.3 - clamp01(energy * react * 1.8) * 0.55);
      const lerpAt = (row, fx) => {
        const i0 = Math.floor(fx), f = fx - i0;
        const a = ((i0 % GW) + GW) % GW, b = a === GW - 1 ? 0 : a + 1;
        return heat[row + a] + (heat[row + b] - heat[row + a]) * f;
      };
      const turb = 0.55 + energy * react * 0.6;
      for (let y = 0; y < GH - 2; y++) {
        const row = y * GW, b1 = (y + 1) * GW, b2 = (y + 2) * GW;
        const rise = 1 - y / GH;                       // 0 at the base, 1 at the top
        for (let x = 0; x < GW; x++) {
          // heat rises through a turbulent sideways sway that grows with
          // height, so the tongues lick and curl; the wind leans them all
          const sway = wind * (0.4 + rise * 1.4)
            + turb * rise * (Math.sin(y * 0.23 - clock * 5.5 + x * 0.17) + 0.6 * Math.sin(y * 0.11 + clock * 3.1 - x * 0.09))
            + (Math.random() - 0.5) * 0.3;
          const sx = x + sway;
          const v = lerpAt(b1, sx) * 0.52 + (lerpAt(b1, sx - 1) + lerpAt(b1, sx + 1)) * 0.19 + lerpAt(b2, sx) * 0.1
            - decay * (0.6 + Math.random() * 0.8);
          next[row + x] = v > 0 ? v : 0;
        }
      }
      for (let i = (GH - 2) * GW; i < GH * GW; i++) next[i] = heat[i];
      const t = heat; heat = next; next = t;
    }
    viz.registerMode({
      id: 'fire', label: 'Fire',
      init() { GW = 0; sparks = []; clock = 0; acc = 0; bassAvg = 0; cooldown = 0; flare = 0; gust = 0; lutHue = -1; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, speed, reactivity, vizRot, vizUserScale } = ctx;
        const w = 200, h = Math.max(30, Math.round(w * VH / VW * 1.3));   // rows a little denser than columns: the flames stretch taller
        if (w !== GW || h !== GH) reset(w, h);
        const bass = bassOf(freqData), energy = energyOf(freqData), react = 0.5 + reactivity * 0.5;
        bassAvg = bassAvg * 0.92 + bass * 0.08; cooldown = Math.max(0, cooldown - 1);
        flare *= 0.85;
        const S = Math.min(VW, VH);
        if (cooldown === 0 && bass > bassAvg * (1.35 - Math.min(1, react) * 0.15) + 0.05) {
          cooldown = 8; flare = 1;
          // sparks from where the fire's hottest along the bottom third
          const n = 12 + (bass * 40) | 0;
          for (let i = 0; i < n; i++) {
            const x = Math.random() * VW;
            sparks.push({ x, y: VH * (0.75 + Math.random() * 0.25), vx: (Math.random() - 0.5) * S * 0.004, vy: -S * (0.006 + Math.random() * 0.012) * (0.6 + bass), life: 1, fade: 0.008 + Math.random() * 0.015 });
          }
          if (sparks.length > 600) sparks.splice(0, sparks.length - 600);
        }
        // the wind: a slow sway plus gusts on the energy
        gust = gust * 0.97 + (Math.random() - 0.5) * energy * 0.2;
        const wind = Math.max(-0.6, Math.min(0.6, Math.sin(vizRot * 0.7) * 0.25 + gust));
        acc += speed * 2;
        let n = 0;
        while (acc >= 1 && n < 6) { acc -= 1; n++; step(freqData, energy, react, wind); }
        const h0 = Math.round(hueBase) % 360;
        if (h0 !== lutHue) buildLut(h0);
        const { c, ctx: gc } = grid(GW, GH), { c: mc, ctx: mx } = shade(GW, GH);
        const img = gc.createImageData(GW, GH), d = img.data, sh = mx.createImageData(GW, GH), m = sh.data;
        for (let i = 0; i < heat.length; i++) {
          const li = Math.min(255, heat[i] * 255 | 0) * 3, o = i * 4;
          d[o] = LUT[li]; d[o + 1] = LUT[li + 1]; d[o + 2] = LUT[li + 2]; d[o + 3] = 255;
          m[o + 3] = Math.min(190, Math.max(0, heat[i] - 0.1) * 560);    // black, as opaque as the flame is hot, no wider than it shows
        }
        gc.putImageData(img, 0, 0); mx.putImageData(sh, 0, 0);
        // the video behind the flames: filling the frame, dimmed so the
        // fire reads over it -- darkest at the bottom, where the flames are
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, VW, VH);
        const v = picture();
        if (v) {
          const k = Math.max(VW / v.videoWidth, VH / v.videoHeight) * vizUserScale, dw = v.videoWidth * k, dh = v.videoHeight * k;
          vctx.drawImage(v, cx - dw / 2, cy - dh / 2, dw, dh);
          const dim = vctx.createLinearGradient(0, 0, 0, VH);
          dim.addColorStop(0, 'rgba(0,0,0,0.25)'); dim.addColorStop(1, `rgba(0,0,0,${(0.55 - flare * 0.15).toFixed(3)})`);
          vctx.fillStyle = dim; vctx.fillRect(0, 0, VW, VH);
        }
        // the fire: first a soft shadow of it darkens the video behind
        // each flame, so a bright picture doesn't wash the flames out,
        // then the flames are added on top -- their black lets the video
        // through. The speckled fuel rows stay just off the bottom edge
        vctx.imageSmoothingEnabled = true;
        if (v) vctx.drawImage(mc, 0, 0, GW, GH - 3, 0, 0, VW, VH);
        vctx.save(); vctx.globalCompositeOperation = 'lighter';
        vctx.drawImage(c, 0, 0, GW, GH - 3, 0, 0, VW, VH);
        vctx.restore();
        // the glow over the top of it on a flare
        if (flare > 0.05) {
          const g = vctx.createLinearGradient(0, VH, 0, VH * 0.3);
          g.addColorStop(0, `hsla(${(h0 + 30) % 360},100%,60%,${(flare * 0.25).toFixed(3)})`);
          g.addColorStop(1, `hsla(${(h0 + 30) % 360},100%,60%,0)`);
          vctx.fillStyle = g; vctx.fillRect(0, 0, VW, VH);
        }
        // sparks: rising, drifting on the wind, cooling as they go
        vctx.save(); vctx.globalCompositeOperation = 'lighter';
        const r = Math.max(1, S / 400);
        sparks = sparks.filter(p => p.life > 0 && p.y > -10);
        for (const p of sparks) {
          p.vx += wind * S * 0.0004 + (Math.random() - 0.5) * S * 0.0006; p.vy *= 0.99;
          p.x += p.vx * speed; p.y += p.vy * speed; p.life -= p.fade * speed;
          vctx.fillStyle = `hsla(${(h0 + 20 + p.life * 35) % 360 | 0},100%,${(50 + p.life * 40) | 0}%,${clamp01(p.life).toFixed(3)})`;
          vctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        }
        vctx.restore();
      },
    });
  })();

  // ── Lawnmower Man (mode): Jobe's cyberspace, the way the 1992 film
  // drew it on an SGI. The camera flies down a twisting wireframe tunnel
  // whose rings bulge with the spectrum, its panels a dim neon
  // checkerboard, past spinning wireframe shards. Hanging in the middle
  // is Jobe's low-poly head: a flat-shaded icosphere that keeps morphing
  // between a head, a ball, a crystal and a spiked star, every vertex
  // pushed out by its own band, the playing video lighting its faces.
  // Each kick flashes the tunnel and bursts the head outward; a big hit
  // puts "I AM GOD HERE" up in chrome. Rotate swings the head round its
  // own axis rather than rolling the picture (ownsRotation).
  (function () {
    const RINGS = 26, SIDES = 16, SP = 1.1, FAR = RINGS * SP, R0 = 4, ZF = 6.2, SHARDS = 9;
    const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
    const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
    const norm = (p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; };
    const smooth = (v) => v * v * (3 - 2 * v);
    // an icosahedron subdivided once: 42 vertices, 80 faces -- the
    // polygon budget of a 1992 Reality Engine head
    const ico = (function () {
      const t = (1 + Math.sqrt(5)) / 2;
      let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
      let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
      const mid = new Map();
      const midpoint = (a, b) => {
        const k = a < b ? a + ',' + b : b + ',' + a;
        if (!mid.has(k)) { const p = V[a], q = V[b]; V.push(norm([p[0] + q[0], p[1] + q[1], p[2] + q[2]])); mid.set(k, V.length - 1); }
        return mid.get(k);
      };
      F = F.flatMap(([a, b, c]) => { const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
      return { V, F };
    })();
    // the four shapes the head morphs between, as a radius per vertex
    // direction: a head (taller than wide, a brow, a nose, a chin), a
    // ball, an octahedral crystal, a spiked star
    const SHAPES = [
      (d) => Math.hypot(d[0] * 0.82, d[1] * 1.18, d[2] * 0.95) + (d[2] > 0.6 && Math.abs(d[0]) < 0.35 && d[1] < 0.1 && d[1] > -0.5 ? 0.28 : 0)
        + (d[1] > 0.25 && d[1] < 0.6 && d[2] > 0.5 ? 0.1 : 0) - (d[1] < -0.85 ? 0.12 : 0),
      () => 1,
      (d) => 1.3 / (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2])),
      (d, i) => hash(i * 7.1 + 2) > 0.55 ? 1.6 : 0.8,
    ];
    const BINS = ico.V.map((_, i) => hash(i * 3.17 + 0.5));   // which part of the spectrum moves each vertex
    const PHRASE = 'I AM GOD HERE';
    let amps = null, lastRot = null, dist = 0, bassAvg = 0, kick = 0, flash = 0, burst = 0, god = 0, lastGod = -1e9, shards = null, scan = null;
    // the tunnel's centre line wanders, so the flight banks and climbs
    const path = (w) => [Math.sin(w * 0.11) * 2.4 + Math.sin(w * 0.047) * 1.6, Math.cos(w * 0.083) * 1.5];
    function newShard(z) {
      return { x: (Math.random() - 0.5) * R0 * 1.3, y: (Math.random() - 0.5) * R0 * 1.3, z, s: 0.25 + Math.random() * 0.35, a: Math.random() * 6.28, sp: 0.5 + Math.random() * 2, h: Math.random() * 360 };
    }
    viz.registerMode({
      id: 'lawnmowerman', label: 'Lawnmower Man', ownsRotation: true,
      init() { amps = null; lastRot = null; kick = flash = burst = god = 0; shards = null; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, videoFrame, vizRot, vizUserScale, vizUserRot } = ctx;
        if (!amps) amps = new Float32Array(ico.V.length);
        if (lastRot === null) lastRot = vizRot;
        const dRot = Math.max(0, Math.min(0.5, vizRot - lastRot)); lastRot = vizRot;
        const bass = bassOf(freqData), energy = energyOf(freqData), maxBin = Math.max(1, Math.floor(freqData.length * 0.7));
        bassAvg += (bass - bassAvg) * 0.12;
        if (bass - bassAvg > 0.05 && kick < 0.5) { kick = 1; flash = 1; burst = 1; }
        kick *= 0.9; flash *= 0.86; burst *= 0.9;
        const now = performance.now();
        if (kick > 0.95 && energy > 0.45 && now - lastGod > 9000) { god = 1; lastGod = now; }
        god = Math.max(0, god - 0.008);
        dist += dRot * (14 + energy * 10 + kick * 12);
        const S = Math.min(VW, VH), f = S * 0.9 * vizUserScale, t = vizRot;
        const H = (hueBase + t * 40) % 360;
        const camP = path(dist);

        vctx.setTransform(1, 0, 0, 1, 0, 0);
        vctx.fillStyle = '#020008'; vctx.fillRect(0, 0, VW, VH);
        const P = (x, y, z) => [cx + x * f / z, cy + y * f / z];

        // ── the tunnel ──
        const k0 = Math.floor(dist / SP) + 1, rings = [];
        for (let k = 0; k < RINGS; k++) {
          const kw = k0 + k, z = kw * SP - dist; if (z < 0.25) continue;
          const c = path(kw * SP), ox = c[0] - camP[0], oy = c[1] - camP[1], tw = kw * 0.09 + t * 0.4, pts = [];
          for (let m = 0; m < SIDES; m++) {
            const b = Math.min(m, SIDES - m) / (SIDES / 2);   // mirrored: bass at the top, treble at the bottom
            const v = freqData[Math.min(freqData.length - 1, (b * maxBin * 0.6) | 0)] / 255;
            const a = m / SIDES * Math.PI * 2 + tw, r = R0 * (1 + v * 0.35 * (1 - z / FAR));
            pts.push(P(ox + Math.cos(a) * r, oy + Math.sin(a) * r, z));
          }
          rings.push({ kw, z, pts });
        }
        // the checkerboard panels, far to near
        for (let n = rings.length - 1; n > 0; n--) {
          const A = rings[n], B = rings[n - 1], fog = Math.pow(clamp01(1 - A.z / FAR), 1.4);
          for (let m = 0; m < SIDES; m++) {
            if ((m + A.kw) % 2) continue;
            const m1 = (m + 1) % SIDES;
            vctx.fillStyle = `hsla(${(H + 200 + m * 6) % 360 | 0},90%,${(14 + flash * 25) | 0}%,${(fog * (0.55 + energy * 0.3)).toFixed(3)})`;
            vctx.beginPath(); vctx.moveTo(A.pts[m][0], A.pts[m][1]); vctx.lineTo(A.pts[m1][0], A.pts[m1][1]);
            vctx.lineTo(B.pts[m1][0], B.pts[m1][1]); vctx.lineTo(B.pts[m][0], B.pts[m][1]); vctx.closePath(); vctx.fill();
          }
        }
        // the wireframe on top: a wide faint pass then a thin bright one, for glow
        vctx.save(); vctx.globalCompositeOperation = 'lighter'; vctx.lineJoin = 'round';
        for (const [lw, la] of [[S / 160, 0.18], [Math.max(1, S / 700), 0.9]]) {
          vctx.lineWidth = lw;
          for (let n = rings.length - 1; n >= 0; n--) {
            const A = rings[n], B = rings[n - 1], fog = Math.pow(clamp01(1 - A.z / FAR), 1.2);
            vctx.strokeStyle = `hsla(${(H + 300 + A.kw * 9) % 360 | 0},100%,${(55 + flash * 35) | 0}%,${(fog * la).toFixed(3)})`;
            vctx.beginPath();
            vctx.moveTo(A.pts[0][0], A.pts[0][1]); for (let m = 1; m <= SIDES; m++) vctx.lineTo(A.pts[m % SIDES][0], A.pts[m % SIDES][1]);
            if (B) for (let m = 0; m < SIDES; m++) { vctx.moveTo(A.pts[m][0], A.pts[m][1]); vctx.lineTo(B.pts[m][0], B.pts[m][1]); }
            vctx.stroke();
          }
        }

        // ── shards: wireframe octahedra drifting past ──
        if (!shards) shards = Array.from({ length: SHARDS }, (_, i) => newShard(2 + i * FAR / SHARDS));
        const OCT = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        const OCT_E = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]];
        for (const sh of shards) {
          sh.z -= dRot * (14 + energy * 10 + kick * 12); sh.a += dRot * sh.sp * 3;
          if (sh.z < 0.4) Object.assign(sh, newShard(FAR));
          const fog = clamp01(1 - sh.z / FAR), pts = OCT.map(p => {
            const q = rotX(rotY(p, sh.a), sh.a * 0.7);
            return P(sh.x + q[0] * sh.s, sh.y + q[1] * sh.s * 1.5, sh.z + q[2] * sh.s);
          });
          vctx.strokeStyle = `hsla(${(sh.h + H) % 360 | 0},100%,65%,${(fog * 0.9).toFixed(3)})`; vctx.lineWidth = Math.max(1, S / 600);
          vctx.beginPath(); for (const [a, b] of OCT_E) { vctx.moveTo(pts[a][0], pts[a][1]); vctx.lineTo(pts[b][0], pts[b][1]); } vctx.stroke();
        }

        // ── the head ──
        // an aura behind it, swelling with the music
        const hp = P(0, 0, ZF), hr = 1.75 * f / ZF;
        const au = vctx.createRadialGradient(hp[0], hp[1], hr * 0.3, hp[0], hp[1], hr * (1.6 + energy + burst * 0.6));
        au.addColorStop(0, `hsla(${(H + 40) % 360 | 0},100%,60%,${(0.25 + energy * 0.35).toFixed(3)})`); au.addColorStop(1, 'hsla(0,0%,0%,0)');
        vctx.fillStyle = au; vctx.fillRect(0, 0, VW, VH);
        vctx.restore();

        const ph = t * 0.12, si = Math.floor(ph), u = smooth(clamp01((ph - si) * 2.5 - 1.5));   // hold a shape, then morph
        const sA = SHAPES[si % SHAPES.length], sB = SHAPES[(si + 1) % SHAPES.length];
        const yaw = t * 0.9 + vizUserRot, pitch = Math.sin(t * 0.35) * 0.35;
        const W = ico.V.map((d, i) => {
          const v = freqData[Math.min(freqData.length - 1, (BINS[i] * maxBin) | 0)] / 255;
          amps[i] += (v - amps[i]) * 0.3;
          let r = sA(d, i) * (1 - u) + sB(d, i) * u;
          r *= 1 + amps[i] * 0.45 + burst * 0.3 + 0.05 * Math.sin(t * 6 + d[0] * 4 + d[1] * 3);
          const q = rotX(rotY([d[0] * r, d[1] * r, d[2] * r], yaw), pitch);
          return [q[0] * 1.6, q[1] * 1.6, q[2] * 1.6 + ZF];
        });
        const L = norm([-0.4, -0.6, -0.7]), faces = [];
        for (let n = 0; n < ico.F.length; n++) {
          const [a, b, c] = ico.F[n], A = W[a], B = W[b], C = W[c];
          const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
          const nn = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
          const mz = (A[2] + B[2] + C[2]) / 3;
          if (nn[0] * (A[0] + B[0] + C[0]) + nn[1] * (A[1] + B[1] + C[1]) + nn[2] * (A[2] + B[2] + C[2]) >= 0) continue;   // facing away
          faces.push({ n, z: mz, light: Math.max(0, nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2]), p: [P(A[0], A[1], A[2]), P(B[0], B[1], B[2]), P(C[0], C[1], C[2])] });
        }
        faces.sort((p, q) => q.z - p.z);
        vctx.lineJoin = 'round';
        for (const fc of faces) {
          const [p0, p1, p2] = fc.p;
          let lum = 0;
          if (videoFrame) lum = lumAt(videoFrame, (p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, VW, VH);
          const hue = (H + 260 + fc.n * 4.5 + fc.light * 80) % 360;
          vctx.fillStyle = `hsl(${hue | 0},100%,${(12 + fc.light * 42 + lum * 30 + flash * 10) | 0}%)`;
          vctx.strokeStyle = `hsl(${(hue + 150) % 360 | 0},100%,${(60 + burst * 30) | 0}%)`;
          vctx.lineWidth = Math.max(1, S / 500);
          vctx.beginPath(); vctx.moveTo(p0[0], p0[1]); vctx.lineTo(p1[0], p1[1]); vctx.lineTo(p2[0], p2[1]); vctx.closePath();
          vctx.fill(); vctx.stroke();
        }

        // ── I AM GOD HERE ──
        if (god > 0) {
          const a = clamp01(god * 3) * clamp01(god * 1.2), fs = S * 0.085 * (1 + (1 - god) * 0.25);
          vctx.save();
          vctx.font = `900 ${fs | 0}px Impact, "Arial Black", sans-serif`; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
          const ty = cy + S * 0.36, gr = vctx.createLinearGradient(0, ty - fs / 2, 0, ty + fs / 2);
          gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.45, `hsl(${(H + 180) % 360 | 0},100%,70%)`);
          gr.addColorStop(0.5, '#1a0630'); gr.addColorStop(1, `hsl(${(H + 300) % 360 | 0},100%,65%)`);   // a chrome horizon line
          vctx.globalAlpha = a;
          vctx.lineWidth = fs * 0.08; vctx.strokeStyle = `hsl(${(H + 300) % 360 | 0},100%,55%)`;
          vctx.strokeText(PHRASE, cx, ty);
          vctx.fillStyle = gr; vctx.fillText(PHRASE, cx, ty);
          vctx.restore();
        }

        // ── scanlines, for the CRT it was shown on ──
        if (!scan || scan.ctx !== vctx) {
          const c = document.createElement('canvas'); c.width = 1; c.height = 3;
          const g = c.getContext('2d'); g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, 2, 1, 1);
          scan = { ctx: vctx, pat: vctx.createPattern(c, 'repeat') };
        }
        vctx.fillStyle = scan.pat; vctx.fillRect(0, 0, VW, VH);
      },
    });
  })();

})();
