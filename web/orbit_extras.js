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
  // horizontal slices of a picture pushed sideways by noise, worst in a
  // tracking band that rolls down the screen; the band also washes out
  function drawTracking(vctx, src, sw, sh, W, H, amp, bandY, bandH, frame, seed) {
    const n = 72, dh = H / n, ssh = sh / n;
    for (let i = 0; i < n; i++) {
      const y = i * dh;
      const inBand = Math.max(0, 1 - Math.abs(y - bandY) / bandH);
      const r = hash(i * 7.3 + frame * 1.7 + seed);
      const dx = (r - 0.5) * amp * (0.15 + 2.5 * inBand * inBand);
      vctx.drawImage(src, 0, i * ssh, sw, ssh, dx, y, W, dh);
      if (inBand > 0.3) { vctx.fillStyle = `rgba(230,230,230,${(0.35 * inBand).toFixed(2)})`; vctx.fillRect(0, y, W, dh); }
    }
  }
  const scanlines = (() => {
    let pat = null;
    return (vctx) => {
      if (!pat) { const c = document.createElement('canvas'); c.width = 1; c.height = 3; const x = c.getContext('2d'); x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(0, 2, 1, 1); pat = vctx.createPattern(c, 'repeat'); }
      return pat;
    };
  })();

  // VHS mode: the video through a worn tape -- chroma smear, scanlines,
  // a tracking band that rolls through, static that thickens with the
  // music, and now and then the deck loses the picture to blue.
  (function () {
    const frame = offscreen(), chroma = offscreen();
    let seconds = 0, lastNow = 0, blueUntil = 0, avg = 0;
    viz.registerMode({
      id: 'vhs', label: 'VHS',
      init() { seconds = 0; lastNow = 0; blueUntil = 0; avg = 0; },
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, vizRot } = ctx;
        const now = performance.now();
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
        const { w, h, imageData } = videoFrame;
        const { c: fc, ctx: fctx } = frame(w, h);
        fctx.putImageData(imageData, 0, 0);
        // colour bleeding sideways: a red-tinted copy pushed right, a
        // blue-tinted one left, added over the picture
        const { c: cc, ctx: cctx } = chroma(w, h);
        const bleed = Math.max(2, VW * 0.006 * (1 + energy));
        const wobble = Math.sin(vizRot * 6) * VH * 0.004 * (1 + energy * 3);
        const frameNo = Math.floor(now / 40);
        const bandY = ((now / (9000 / speed)) % 1.3) * VH * 1.3 - VH * 0.15;
        vctx.save();
        vctx.translate(0, wobble);
        drawTracking(vctx, fc, w, h, VW, VH, VW * 0.03 * (1 + energy * 3), bandY, VH * 0.06, frameNo, 0);
        vctx.globalCompositeOperation = 'lighter'; vctx.globalAlpha = 0.35;
        for (const [color, dx] of [['#f00', bleed], ['#00f', -bleed]]) {
          cctx.globalCompositeOperation = 'source-over'; cctx.drawImage(fc, 0, 0);
          cctx.globalCompositeOperation = 'multiply'; cctx.fillStyle = color; cctx.fillRect(0, 0, w, h);
          vctx.drawImage(cc, dx, 0, VW, VH);
        }
        vctx.restore();
        // the band itself carries a stripe of pure static
        drawStatic(vctx, VW, VH, 0.06 + 0.25 * energy);
        vctx.save(); vctx.beginPath(); vctx.rect(0, bandY - VH * 0.02, VW, VH * 0.035); vctx.clip(); drawStatic(vctx, VW, VH, 0.8); vctx.restore();
        vctx.fillStyle = scanlines(vctx); vctx.fillRect(0, 0, VW, VH);
        vhsOsd(vctx, VW, VH, '▶ PLAY', seconds, false);
      },
    });
  })();

  // VHS transition: the outgoing picture loses tracking and drowns in
  // static, the deck drops to blue with STOP, then PLAY comes back up
  // on the new picture through a last wash of snow.
  viz.registerTransition({
    id: 'vhs', label: 'VHS',
    draw({ vctx, old, oldW, oldH, W, H, t, seed }) {
      const frameNo = Math.floor(t * 40);
      if (t < 0.6) {
        const k = t / 0.6;
        const bandY = H * (0.1 + 0.9 * k);
        drawTracking(vctx, old, oldW, oldH, W, H, W * 0.5 * k * k + W * 0.02, bandY, H * (0.08 + 0.2 * k), frameNo, seed);
        drawStatic(vctx, W, H, 0.1 + 0.6 * k * k);
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
  //  Win95 -- teal desktop, a media player window, and the trails a
  //  hung window leaves when you drag it
  // ══════════════════════════════════════════════════════════════════
  const W95 = { desk: '#008080', face: '#c0c0c0', light: '#ffffff', shade: '#808080', dark: '#000000', title1: '#000080', title2: '#1084d0', bsod: '#0000aa' };
  // a raised 3D box, the one shape every Win95 control is made of
  function bevel(ctx, x, y, w, h) {
    ctx.fillStyle = W95.face; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = W95.light; ctx.fillRect(x, y, w - 1, 1); ctx.fillRect(x, y, 1, h - 1);
    ctx.fillStyle = W95.shade; ctx.fillRect(x + 1, y + h - 2, w - 2, 1); ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
    ctx.fillStyle = W95.dark; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
  }
  function titleBar(ctx, x, y, w, h, text, fs) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, W95.title1); g.addColorStop(1, W95.title2);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.fillText(text, x + fs * 0.5, y + h / 2);
    // _ □ ×
    const b = h - 4; let bx = x + w - 2 - b;
    for (const glyph of ['×', '□', '_']) {
      bevel(ctx, bx, y + 2, b, b);
      ctx.fillStyle = '#000'; ctx.font = `bold ${fs * 0.9}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(glyph, bx + b / 2, y + 2 + b / 2 - (glyph === '_' ? b * 0.15 : 0));
      ctx.textAlign = 'left';
      bx -= b + (glyph === '×' ? 2 : 0);
    }
  }
  function startBar(ctx, W, H, fs) {
    const bh = fs * 2.2, y = H - bh;
    bevel(ctx, -2, y, W + 4, bh + 2);
    const sw = fs * 4.2, sx = 2, sy = y + 3, sh = bh - 6;
    bevel(ctx, sx, sy, sw, sh);
    // the flag: four coloured panes
    const px = sx + fs * 0.4, py = sy + sh / 2 - fs * 0.45, ps = fs * 0.42;
    for (const [i, col] of ['#f00', '#0a0', '#00f', '#ff0'].entries()) ctx.fillStyle = col, ctx.fillRect(px + (i % 2) * (ps + 1), py + Math.floor(i / 2) * (ps + 1), ps, ps);
    ctx.fillStyle = '#000'; ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = 'middle'; ctx.fillText('Start', px + ps * 2 + fs * 0.4, sy + sh / 2);
    // the clock well
    const d = new Date(); let hr = d.getHours(); const ampm = hr >= 12 ? 'PM' : 'AM'; hr = hr % 12 || 12;
    const clock = `${hr}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
    ctx.font = `${fs * 0.9}px sans-serif`;
    const cw = ctx.measureText(clock).width + fs;
    ctx.fillStyle = W95.shade; ctx.fillRect(W - cw - 4, sy, cw, sh);
    ctx.fillStyle = W95.light; ctx.fillRect(W - cw - 3, sy + 1, cw - 1, sh - 1);
    ctx.fillStyle = W95.face; ctx.fillRect(W - cw - 3, sy + 1, cw - 2, sh - 2);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(clock, W - cw / 2 - 4, sy + sh / 2); ctx.textAlign = 'left';
  }
  function errorDialog(ctx, x, y, w, fs, title, lines) {
    const th = fs * 1.5, lh = fs * 1.35, h = th + 8 + lines.length * lh + fs * 3;
    bevel(ctx, x, y, w, h);
    titleBar(ctx, x + 3, y + 3, w - 6, th, title, fs);
    // the red-circle X icon
    ctx.fillStyle = '#c00'; ctx.beginPath(); ctx.arc(x + fs * 1.6, y + th + fs * 1.6, fs * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = fs * 0.18; ctx.beginPath();
    ctx.moveTo(x + fs * 1.15, y + th + fs * 1.15); ctx.lineTo(x + fs * 2.05, y + th + fs * 2.05); ctx.moveTo(x + fs * 2.05, y + th + fs * 1.15); ctx.lineTo(x + fs * 1.15, y + th + fs * 2.05); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = `${fs}px sans-serif`; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + fs * 3, y + th + 8 + i * lh));
    const bw = fs * 5, bx = x + w / 2 - bw / 2, by = y + h - fs * 2.4;
    bevel(ctx, bx, by, bw, fs * 1.8);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('OK', bx + bw / 2, by + fs * 0.9); ctx.textAlign = 'left';
    return h;
  }

  // Win95 mode: the video plays in a Media Player window bouncing
  // around a teal desktop. When the bass hits, the desktop stops
  // repainting and the window smears the way a hung one did under a
  // drag; big hits throw an illegal-operation box.
  (function () {
    const frame = offscreen();
    let win = null, dialogs = [], avg = 0, cooldown = 0;
    viz.registerMode({
      id: 'win95', label: 'Win95',
      init() { win = null; dialogs = []; avg = 0; cooldown = 0; },
      draw(ctx) {
        const { vctx, VW, VH, freqData, videoFrame, speed, vizUserScale } = ctx;
        const fs = Math.max(10, Math.round(VH / 34));
        const energy = energyOf(freqData), bass = bassOf(freqData);
        avg = avg * 0.95 + energy * 0.05; cooldown = Math.max(0, cooldown - 1);
        const ww = Math.min(VW * 0.9, VW * 0.5 * vizUserScale), wh = ww * 0.62 + fs * 2;
        if (!win) win = { x: VW * 0.2, y: VH * 0.1, vx: 1.4, vy: 1.1 };
        win.x += win.vx * speed * (1 + energy * 2); win.y += win.vy * speed * (1 + energy * 2);
        const barH = fs * 2.2;
        if (win.x < 0 || win.x + ww > VW) { win.vx *= -1; win.x = Math.max(0, Math.min(VW - ww, win.x)); }
        if (win.y < 0 || win.y + wh > VH - barH) { win.vy *= -1; win.y = Math.max(0, Math.min(VH - barH - wh, win.y)); }
        // the desktop only repaints when the machine is keeping up
        if (bass < 0.45) {
          vctx.fillStyle = W95.desk; vctx.fillRect(0, 0, VW, VH);
          // two desktop icons
          vctx.font = `${fs * 0.85}px sans-serif`; vctx.textAlign = 'center'; vctx.textBaseline = 'top';
          for (const [i, [name, col]] of [['My Computer', '#d9d9d9'], ['Recycle Bin', '#9ad']].entries()) {
            const ix = fs * 2.6, iy = fs * 1.5 + i * fs * 5;
            vctx.fillStyle = col; vctx.fillRect(ix - fs, iy, fs * 2, fs * 1.6);
            vctx.fillStyle = '#000'; vctx.fillRect(ix - fs * 0.7, iy + fs * 0.25, fs * 1.4, fs * 0.9);
            vctx.fillStyle = '#fff'; vctx.fillText(name, ix, iy + fs * 1.9);
          }
          vctx.textAlign = 'left';
        }
        // the window
        bevel(vctx, win.x, win.y, ww, wh);
        titleBar(vctx, win.x + 3, win.y + 3, ww - 6, fs * 1.5, 'weed.avi - Media Player', fs);
        const vx = win.x + 4, vy = win.y + fs * 1.5 + 6, vw = ww - 8, vh = wh - fs * 1.5 - 10;
        vctx.fillStyle = '#000'; vctx.fillRect(vx, vy, vw, vh);
        if (videoFrame) {
          const { c, ctx: fctx } = frame(videoFrame.w, videoFrame.h);
          fctx.putImageData(videoFrame.imageData, 0, 0);
          vctx.drawImage(c, vx, vy, vw, vh);
        }
        // illegal operations, on the hits
        if (energy > avg * 1.3 + 0.05 && cooldown === 0 && dialogs.length < 5) {
          dialogs.push({ x: Math.random() * (VW - fs * 22), y: Math.random() * (VH - fs * 12), ttl: 110 });
          cooldown = 25;
        }
        for (let i = dialogs.length - 1; i >= 0; i--) {
          const d = dialogs[i]; if (--d.ttl <= 0) { dialogs.splice(i, 1); continue; }
          errorDialog(vctx, d.x, d.y, fs * 22, fs, 'weed.exe', ['This program has performed an illegal', 'operation and will be shut down.', '', 'If the problem persists, contact the', 'program vendor.']);
        }
        startBar(vctx, VW, VH, fs);
      },
    });
  })();

  // Win95 transition: the outgoing picture is a hung window being
  // dragged, leaving a stack of itself behind, until the whole machine
  // gives up: blue screen, fatal exception, press any key. It reboots
  // into the new picture.
  viz.registerTransition({
    id: 'win95', label: 'Win95',
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
        vctx.font = `${cfs}px monospace`; vctx.textBaseline = 'top';
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
        vctx.globalAlpha = 1;
        vctx.fillStyle = '#ccc'; vctx.font = `${fs}px monospace`; vctx.textBaseline = 'top';
        vctx.fillText('Starting Windows 95...', fs, fs);
      }
    },
  });
})();
