'use strict';
// Extra Orbit Visualizer modes and transitions, built entirely on the
// public plugin API (window.orbitViz.registerMode / registerTransition
// -- see orbit_visualizer.js's own registry comments for the contracts).
// Nothing in here touches the visualizer's internals: this file is the
// proof that the plugin architecture is enough to add a whole second
// set of effects, and the template for adding more. Drop the <script>
// tag in index.html to get the built-ins only.
//
// Modes:       Halftone, Lava, Terrain, Rain, Lissajous, Ripples, Cube, VHS, Win95
// Transitions: Melt, Dissolve, Iris, Shatter, Wave, Spin, Zoom blur, RGB split, VHS, Win95
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

  // Ripples: every beat drops a ring in the pond; rings expand, thin
  // out and fade, a pulsing core in the middle riding the bass.
  (function () {
    let rings = [], avg = 0, cooldown = 0;
    viz.registerMode({
      id: 'ripples', label: 'Ripples',
      init() { rings = []; avg = 0; cooldown = 0; },
      draw(ctx) {
        const { vctx, VW, VH, cx, cy, hueBase, freqData, speed, vizUserScale, vizRot } = ctx;
        const energy = energyOf(freqData), bass = bassOf(freqData);
        avg = avg * 0.94 + energy * 0.06;
        cooldown = Math.max(0, cooldown - 1);
        // a beat: noticeably louder than the recent average, not too soon after the last
        if (energy > avg * 1.25 + 0.04 && cooldown === 0) { rings.push({ r: 0, hue: (hueBase + rings.length * 37) % 360, w: 2 + energy * 8 }); cooldown = 8; }
        fadeFrame(vctx, VW, VH, 0.22);
        const maxR = Math.hypot(VW, VH) * 0.55;
        vctx.lineCap = 'round';
        for (let i = rings.length - 1; i >= 0; i--) {
          const g = rings[i]; g.r += (2.5 + g.r * 0.02) * speed * vizUserScale;
          const life = 1 - g.r / maxR; if (life <= 0) { rings.splice(i, 1); continue; }
          vctx.beginPath(); vctx.arc(cx, cy, g.r, 0, Math.PI * 2);
          vctx.strokeStyle = `hsla(${g.hue | 0},100%,60%,${life.toFixed(2)})`; vctx.lineWidth = g.w * life + 0.5; vctx.stroke();
        }
        // the core: a ring of spokes sized by the bass
        const core = Math.min(VW, VH) * 0.06 * vizUserScale * (1 + bass * 1.5);
        vctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const th = (i / 64) * Math.PI * 2 + vizRot;
          const v = freqData[Math.floor((i / 64) * freqData.length * 0.5)] / 255;
          const r = core * (1 + v * 0.8);
          const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
          if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
        }
        vctx.closePath();
        vctx.fillStyle = `hsla(${(hueBase + 180) | 0},100%,60%,0.5)`; vctx.fill();
        vctx.strokeStyle = `hsl(${(hueBase + 180) | 0},100%,80%)`; vctx.lineWidth = 2; vctx.stroke();
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
    // desktop icons down the left, two columns
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
    viz.registerMode({
      id: 'win95', label: 'Win95',
      init() { win = null; dialogs = []; avg = 0; cooldown = 0; seconds = 0; lastNow = 0; },
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, vizUserScale } = ctx;
        const fs = Math.max(10, Math.round(VH / 40));
        const now = performance.now(); if (lastNow) seconds += (now - lastNow) / 1000; lastNow = now;
        const energy = energyOf(freqData), bass = bassOf(freqData);
        avg = avg * 0.95 + energy * 0.05; cooldown = Math.max(0, cooldown - 1);
        const ww = Math.round(Math.min(VW * 0.9, VW * 0.42 * vizUserScale));
        const wh = 3 + fs * 3 + 2 + Math.round((ww - 8) * 0.5625) + fs * 5.1 + 3;
        const barH = fs * 2.2;
        if (!win) win = { x: VW * 0.25, y: VH * 0.15, vx: 1.1, vy: 0.9 };
        win.x += win.vx * speed * (1 + energy * 2); win.y += win.vy * speed * (1 + energy * 2);
        if (win.x < 0 || win.x + ww > VW) { win.vx *= -1; win.x = Math.max(0, Math.min(VW - ww, win.x)); }
        if (win.y < 0 || win.y + wh > VH - barH) { win.vy *= -1; win.y = Math.max(0, Math.min(VH - barH - wh, win.y)); }
        // the desktop only repaints when the machine is keeping up
        if (bass < 0.45) vctx.drawImage(desktop(VW, VH, fs), 0, 0);
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
})();
