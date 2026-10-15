'use strict';
// Deep Sea: an Orbit Visualizer mode (plugin API only -- see
// orbit_visualizer.js's registry comments). Hanging in dark water among
// glassy jellyfish lit in neon-tetra blue and red. Each jelly listens to
// its own slice of the spectrum, which lights its rim and gonads, and
// every kick makes the jellies squeeze and shoot upward, oral arms and
// tentacles trailing after them. A school of neon tetras wheels through
// the scene and scatters on the kicks, a manta glides past in the gloom,
// kelp sways over a sea floor dotted with anemones that open up with the
// bass, marine snow sparkles with the highs, kicks loose strings of
// bubbles, and the video ripples on the surface overhead.
(function () {
  const viz = window.orbitViz;
  if (!viz || typeof viz.registerMode !== 'function') return;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const TAU = Math.PI * 2;
  function band(freq, lo, hi) {
    const a = Math.floor(freq.length * lo), b = Math.max(a + 1, Math.floor(freq.length * hi)); let s = 0;
    for (let i = a; i < b; i++) s += freq[i];
    return s / ((b - a) * 255);
  }

  const JELLIES = 8, SNOW = 200, SEGS = 14, FISH = 38, KELP = 11, FLOOR = 0.9;
  // neon tetra: an electric blue-green stripe over a red belly. Each jelly
  // gets one of these as its glass/rim colour and the other for its gonads.
  const NEON = [[198, 352], [186, 348], [210, 0], [352, 196], [175, 330], [290, 190]];
  let st = null, vid = null;

  // a jelly lives at (x, y) in 0..1 screen units, z 0.35 (far) .. 1 (near).
  // Tentacles and oral arms are chains of points that follow the bell with drag.
  function jelly(i, spawnBelow) {
    const z = 0.35 + Math.random() * 0.65, pal = NEON[i % NEON.length];
    const j = {
      x: 0.08 + Math.random() * 0.84, y: spawnBelow ? 1.1 + Math.random() * 0.2 : 0.12 + Math.random() * 0.7,
      vx: 0, vy: 0, z, size: 0.05 + Math.random() * 0.035,
      hue: pal[0], hue2: pal[1], band: (i % JELLIES) / JELLIES, phase: Math.random() * TAU,
      squeeze: 0, glow: 0, flash: 0, flashHue: pal[0], tails: [], home: 0.15 + Math.random() * 0.45,
    };
    // marginal tentacles round the rim, then four frilly oral arms from the middle
    const rim = 10 + ((Math.random() * 6) | 0);
    for (let k = 0; k < rim + 4; k++) {
      const arm = k >= rim;
      const pts = [];
      for (let s = 0; s < SEGS; s++) pts.push({ x: j.x, y: j.y + s * 0.01 });
      j.tails.push({ pts, arm, th: arm ? 0 : (k / (rim - 1)) * Math.PI, off: arm ? ((k - rim) / 3 - 0.5) * 0.35 : 0, len: arm ? 0.5 + Math.random() * 0.2 : 0.9 + Math.random() * 0.6 });
    }
    return j;
  }
  function fish() {
    return {
      x: 0.3 + Math.random() * 0.4, y: 0.35 + Math.random() * 0.3, vx: (Math.random() - 0.5) * 0.002, vy: 0,
      z: 0.65 + Math.random() * 0.35, ox: (Math.random() - 0.5) * 0.26, oy: (Math.random() - 0.5) * 0.13,
      ph: Math.random() * TAU, size: 0.85 + Math.random() * 0.3,
    };
  }
  function fresh() {
    const s = { lastRot: null, lastT: 0, floor: 0, ceil: 0, armed: true, kickCool: 0, beats: 0, jellies: [], snow: [], bubbles: [], fish: [], t: 0, manta: null, mantaWait: 200, panic: 0, panicCool: 0 };
    for (let i = 0; i < JELLIES; i++) s.jellies.push(jelly(i, false));
    for (let i = 0; i < SNOW; i++) s.snow.push({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, tw: Math.random() * TAU });
    for (let i = 0; i < FISH; i++) s.fish.push(fish());
    s.kelp = [];
    for (let i = 0; i < KELP; i++) s.kelp.push({ x: (i + Math.random() * 0.6) / KELP, h: 0.22 + Math.random() * 0.3, ph: Math.random() * TAU, far: i % 2 === 0 });
    s.anemones = [0.12, 0.37, 0.61, 0.86].map((x, i) => ({ x: x + (Math.random() - 0.5) * 0.05, hue: NEON[i * 2 % NEON.length][i % 2], ph: Math.random() * TAU }));
    return s;
  }

  // shortest way round the colour wheel from hue a to hue b
  const lerpHue = (a, b, f) => { const d = ((b - a + 540) % 360) - 180; return (a + d * f + 360) % 360 | 0; };
  // the hues a beat can light a jelly up in
  const FLASH = [195, 350, 300, 160, 50, 265, 0, 180, 320, 120];

  // the sea floor's height (0..1 of the screen) at x
  const floorY = (x) => FLOOR + Math.sin(x * 7.1) * 0.018 + Math.sin(x * 17.3 + 2) * 0.008;

  // ── a jelly ──────────────────────────────────────────────────────────
  // Real jellies are mostly clear: what you see is the edge of the glass
  // (brighter where you look through more of it), the rim, the four
  // gonads and the radial canals, and a highlight. All drawn additively,
  // so the water and everything behind shows through.
  function drawJelly(g, j, W, H, S, t) {
    const px = j.x * W, py = j.y * H, r = j.size * S * j.z;
    // on a beat it flashes bright in a new colour, then fades back to its own
    const fl = j.flash, lit = Math.min(1.4, 0.3 + j.glow * 0.7 + fl * 0.9), a = Math.min(1, 0.45 + j.z * 0.55 + fl * 0.3);
    const c1 = lerpHue(j.hue, j.flashHue, fl), c2 = lerpHue(j.hue2, (j.flashHue + 150) % 360, fl);
    const sq = j.squeeze, bw = r * (1 + sq * 0.22), bh = r * (0.9 - sq * 0.32), rimH = bw * 0.24;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round'; g.lineJoin = 'round';

    // oral arms: wide translucent ribbons with frilly bright edges
    for (const tl of j.tails) {
      if (!tl.arm) continue;
      const p = tl.pts;
      g.beginPath(); g.moveTo(p[0].x * W, p[0].y * H);
      for (let s = 1; s < p.length; s++) g.lineTo(p[s].x * W, p[s].y * H);
      g.strokeStyle = `hsla(${c2},100%,60%,${(0.07 * a).toFixed(3)})`; g.lineWidth = r * 0.22; g.stroke();
      g.beginPath();
      for (let s = 0; s < p.length - 1; s++) {
        const dx = (p[s + 1].x - p[s].x) * W, dy = (p[s + 1].y - p[s].y) * H, d = Math.hypot(dx, dy) || 1;
        const w = r * 0.09 * (1 - s / p.length) * Math.sin(s * 2.3 + t * 2 + j.phase);
        const x = p[s].x * W - dy / d * w, y = p[s].y * H + dx / d * w;
        if (s) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = `hsla(${c2},100%,${60 + lit * 20 | 0}%,${(0.35 * a).toFixed(2)})`; g.lineWidth = Math.max(0.8, r * 0.025); g.stroke();
    }
    // marginal tentacles: fine threads, tipped with tiny lights
    g.lineWidth = Math.max(0.6, r * 0.012);
    g.strokeStyle = `hsla(${c1},100%,75%,${(0.28 * a).toFixed(2)})`;
    g.beginPath();
    for (const tl of j.tails) {
      if (tl.arm) continue;
      const p = tl.pts;
      g.moveTo(p[0].x * W, p[0].y * H);
      for (let s = 1; s < p.length - 1; s++) g.quadraticCurveTo(p[s].x * W, p[s].y * H, (p[s].x + p[s + 1].x) / 2 * W, (p[s].y + p[s + 1].y) / 2 * H);
    }
    g.stroke();
    g.fillStyle = `hsla(${c1},100%,80%,${(0.5 * a * lit).toFixed(2)})`;
    for (const tl of j.tails) {
      if (tl.arm) continue;
      const e = tl.pts[tl.pts.length - 1];
      g.beginPath(); g.arc(e.x * W, e.y * H, Math.max(0.8, r * 0.025), 0, TAU); g.fill();
    }

    // glow in the water round it
    const halo = g.createRadialGradient(px, py - bh * 0.4, 0, px, py - bh * 0.4, r * 3);
    halo.addColorStop(0, `hsla(${c1},100%,55%,${((0.14 * lit + fl * 0.3) * j.z).toFixed(3)})`);
    halo.addColorStop(1, `hsla(${c1},100%,50%,0)`);
    g.fillStyle = halo; g.fillRect(px - r * 3, py - bh * 0.4 - r * 3, r * 6, r * 6);

    // the bell: a dome whose edge wobbles as it swims
    const dome = new Path2D();
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const th = Math.PI * i / N, wob = 1 + Math.sin(th * 4 + t * 2.2 + j.phase) * 0.025;
      const x = px - Math.cos(th) * bw * wob, y = py - Math.pow(Math.sin(th), 0.75) * bh * wob;
      if (i) dome.lineTo(x, y); else dome.moveTo(x, y);
    }
    dome.ellipse(px, py, bw, rimH, 0, 0, Math.PI);   // round the front of the rim and back up
    // glass: almost clear in the middle, thicker (brighter) towards the edges
    const glass = g.createRadialGradient(px, py - bh * 0.35, 0, px, py - bh * 0.35, bw * 1.05);
    glass.addColorStop(0, `hsla(${c1},100%,70%,${(0.03 * a + fl * 0.12).toFixed(3)})`);
    glass.addColorStop(0.65, `hsla(${c1},100%,62%,${(0.11 * a + fl * 0.18).toFixed(3)})`);
    glass.addColorStop(1, `hsla(${c1},100%,58%,${(0.42 * a + fl * 0.3).toFixed(3)})`);
    g.fillStyle = glass; g.fill(dome);
    // the inner layer of the bell, a second, fainter dome inside the first
    g.beginPath(); g.ellipse(px, py - bh * 0.05, bw * 0.78, bh * 0.78, 0, Math.PI, 0);
    g.fillStyle = `hsla(${c1},100%,60%,${(0.05 * a).toFixed(3)})`; g.fill();
    // radial canals from the top down to the rim
    g.beginPath();
    for (let i = 1; i < 8; i++) {
      const th = Math.PI * i / 8, ex = px - Math.cos(th) * bw * 0.96, ey = py + Math.sin(th) * rimH * 0.6;
      g.moveTo(px, py - bh * 0.92); g.quadraticCurveTo(px - Math.cos(th) * bw * 0.8, py - bh * 0.7, ex, ey);
    }
    g.strokeStyle = `hsla(${c1},100%,80%,${(0.13 * a).toFixed(2)})`; g.lineWidth = Math.max(0.6, r * 0.012); g.stroke();
    // edge of the glass, with a soft second pass for bloom
    g.strokeStyle = `hsla(${c1},100%,62%,${(0.18 * a).toFixed(2)})`; g.lineWidth = Math.max(2, r * 0.09); g.stroke(dome);
    g.strokeStyle = `hsla(${c1},100%,${72 + lit * 20 | 0}%,${(0.55 * a).toFixed(2)})`; g.lineWidth = Math.max(0.8, r * 0.022); g.stroke(dome);
    // the back half of the rim, seen through the bell
    g.beginPath(); g.ellipse(px, py, bw, rimH, 0, Math.PI, TAU);
    g.strokeStyle = `hsla(${c1},100%,75%,${(0.25 * a).toFixed(2)})`; g.stroke();
    // the four gonads, horseshoes of neon in the middle of the bell
    for (let k = 0; k < 4; k++) {
      const an = k * Math.PI / 2 + t * 0.25 + j.phase;
      const gx = px + Math.cos(an) * bw * 0.28, gy = py - bh * 0.38 + Math.sin(an) * bh * 0.13;
      g.beginPath(); g.ellipse(gx, gy, r * 0.17, r * 0.09, an, 0.3, TAU - 0.3);
      g.strokeStyle = `hsla(${c2},100%,58%,${(0.25 * a * lit).toFixed(2)})`; g.lineWidth = r * 0.09; g.stroke();
      g.strokeStyle = `hsla(${c2},100%,${70 + lit * 20 | 0}%,${(0.6 * a * lit).toFixed(2)})`; g.lineWidth = Math.max(0.8, r * 0.03); g.stroke();
    }
    // lights twinkling round the rim on its band
    g.fillStyle = `hsla(${c1},100%,88%,${(0.8 * a * j.glow).toFixed(2)})`;
    for (let k = 0; k < 16; k++) {
      const th = k / 16 * TAU + t * 0.2;
      g.beginPath(); g.arc(px + Math.cos(th) * bw, py + Math.sin(th) * rimH, Math.max(0.6, r * 0.022), 0, TAU); g.fill();
    }
    // a highlight on the glass
    g.beginPath(); g.ellipse(px - bw * 0.35, py - bh * 0.62, bw * 0.28, bh * 0.12, -0.5, Math.PI * 1.05, Math.PI * 1.85);
    g.strokeStyle = `rgba(255,255,255,${(0.35 * a).toFixed(2)})`; g.lineWidth = Math.max(1, r * 0.035); g.stroke();
    g.restore();
  }

  // ── a neon tetra ─────────────────────────────────────────────────────
  // a translucent silvery body, the electric blue stripe from eye to
  // adipose fin, the red belly behind it, a flicking tail
  function drawFish(g, f, W, H, S, t) {
    const x = f.x * W, y = f.y * H, L = S * 0.05 * f.z * f.size;
    const ang = Math.atan2(f.vy * H, f.vx * W);
    const flick = Math.sin(t * 9 + f.ph) * 0.35;
    g.save(); g.translate(x, y); g.rotate(ang);
    if (Math.cos(ang) < 0) g.scale(1, -1);   // keep the stripe on its back when it swims left
    const a = 0.55 + f.z * 0.45;
    // tail
    g.beginPath(); g.moveTo(-L * 0.42, 0);
    g.lineTo(-L * 0.68, -L * 0.17 + flick * L * 0.12); g.lineTo(-L * 0.6, flick * L * 0.08); g.lineTo(-L * 0.68, L * 0.17 + flick * L * 0.12); g.closePath();
    g.fillStyle = `rgba(200,220,235,${(0.3 * a).toFixed(2)})`; g.fill();
    // body
    g.beginPath(); g.moveTo(L * 0.5, 0);
    g.bezierCurveTo(L * 0.35, -L * 0.17, -L * 0.2, -L * 0.15, -L * 0.45, 0);
    g.bezierCurveTo(-L * 0.2, L * 0.15, L * 0.35, L * 0.17, L * 0.5, 0);
    g.fillStyle = `rgba(190,205,220,${(0.42 * a).toFixed(2)})`; g.fill();
    // red belly, back half
    g.beginPath(); g.moveTo(L * 0.05, L * 0.02);
    g.bezierCurveTo(-L * 0.15, L * 0.12, -L * 0.35, L * 0.08, -L * 0.44, L * 0.01);
    g.lineTo(-L * 0.4, -L * 0.01); g.lineTo(L * 0.05, -L * 0.01); g.closePath();
    g.fillStyle = `rgba(255,30,60,${(0.85 * a).toFixed(2)})`; g.fill();
    // the stripe, with a glow
    g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    g.beginPath(); g.moveTo(L * 0.32, -L * 0.04); g.quadraticCurveTo(0, -L * 0.07, -L * 0.36, -L * 0.03);
    g.strokeStyle = `rgba(0,190,255,${(0.35 * a).toFixed(2)})`; g.lineWidth = L * 0.12; g.stroke();
    g.strokeStyle = `rgba(120,240,255,${(0.95 * a).toFixed(2)})`; g.lineWidth = Math.max(0.8, L * 0.045); g.stroke();
    g.globalCompositeOperation = 'source-over';
    // eye
    g.beginPath(); g.arc(L * 0.36, -L * 0.01, L * 0.05, 0, TAU); g.fillStyle = '#05070c'; g.fill();
    g.strokeStyle = `rgba(160,230,255,${(0.6 * a).toFixed(2)})`; g.lineWidth = Math.max(0.5, L * 0.015); g.stroke();
    g.restore();
  }

  viz.registerMode({
    id: 'deepsea', label: 'Deep Sea',
    init() { st = fresh(); },
    teardown() { st = null; vid = null; },
    draw(ctx) {
      const { vctx: g, VW, VH, hueBase, freqData, vizRot, vizUserScale, videoFrame } = ctx;
      if (!st) st = fresh();
      if (st.lastRot == null) st.lastRot = vizRot;
      const dRot = clamp(vizRot - st.lastRot, 0, 0.5); st.lastRot = vizRot;
      const k = Math.min(dRot / 0.006, 4);   // frames' worth of time at the current Speed (capped, so a stall can't fling things)
      st.t += dRot;
      const t = st.t * 6;
      const bass = band(freqData, 0, 0.06), mids = band(freqData, 0.06, 0.35), highs = band(freqData, 0.35, 0.7);
      // the kick: the kick drum's own band, taken before the React slider's
      // scaling (so React can't pin it at full and hide the beat), judged
      // against this track's own recent floor and ceiling the way Warp
      // does -- a fixed "this much over average" misses most kicks once
      // the bass sits high
      const now = performance.now(), dt = st.lastT ? Math.min(0.1, (now - st.lastT) / 1000) : 0.016; st.lastT = now;
      const ease = (tau) => 1 - Math.exp(-dt / tau), react = 0.5 + (ctx.reactivity || 1) * 0.5, kr = ctx.kickRaw || 0;
      st.kickCool = Math.max(0, st.kickCool - dt);
      st.floor += (kr - st.floor) * ease(kr < st.floor ? 0.12 : 0.8);
      st.ceil = kr > st.ceil ? kr : st.ceil + (kr - st.ceil) * ease(1.2);
      const swing = st.ceil - st.floor, pos = (kr - st.floor) / Math.max(swing, 0.035 / react);
      if (pos < 0.45) st.armed = true;
      let kicked = false;
      if (st.armed && st.kickCool === 0 && pos > 0.7 - 0.1 * (react - 1) && swing > 0.012 / react) {
        st.armed = false; st.kickCool = 0.12; kicked = true; st.beats++;
      }
      const hit = clamp(swing * react * 4, 0.4, 1);   // how hard this one landed
      const S = Math.min(VW, VH) * vizUserScale, M = Math.min(VW, VH);
      // the water keeps to deep blues, drifting a little with the shared hue
      const WH = 212 + Math.sin(hueBase / 360 * TAU) * 14;

      // ── the water: dark at depth, a little lighter towards the surface ──
      const sea = g.createLinearGradient(0, 0, 0, VH);
      sea.addColorStop(0, `hsl(${WH - 15 | 0},75%,15%)`);
      sea.addColorStop(0.45, `hsl(${WH | 0},80%,6%)`);
      sea.addColorStop(1, `hsl(${WH + 15 | 0},85%,2.5%)`);
      g.fillStyle = sea; g.fillRect(0, 0, VW, VH);

      // ── the surface overhead: the video, rippling, light falling from it ──
      const surfH = VH * 0.22;
      if (videoFrame) {
        if (!vid || vid.c.width !== videoFrame.w || vid.c.height !== videoFrame.h) {
          const c = document.createElement('canvas'); c.width = videoFrame.w; c.height = videoFrame.h;
          vid = { c, g: c.getContext('2d') };
        }
        vid.g.putImageData(videoFrame.imageData, 0, 0);
        const strips = 40, sh = surfH / strips;
        for (let i = 0; i < strips; i++) {
          const f = i / strips, wob = Math.sin(t * 0.8 + i * 0.45) * VW * 0.01 * (1 + bass * 2);
          g.globalAlpha = (1 - f) * 0.5;
          g.drawImage(vid.c, 0, f * vid.c.height, vid.c.width, vid.c.height / strips, wob - VW * 0.02, i * sh, VW * 1.04, sh + 1);
        }
        g.globalAlpha = 1;
      }
      // god rays, swaying, brighter on the mids
      g.save(); g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const x = VW * (0.1 + i * 0.16) + Math.sin(t * 0.15 + i * 2.1) * VW * 0.06, w = VW * (0.04 + (i % 3) * 0.02);
        const ray = g.createLinearGradient(0, 0, 0, VH * 0.9);
        ray.addColorStop(0, `hsla(${WH - 25 | 0},80%,70%,${(0.05 + mids * 0.08).toFixed(3)})`);
        ray.addColorStop(1, `hsla(${WH - 25 | 0},80%,70%,0)`);
        g.fillStyle = ray;
        g.beginPath(); g.moveTo(x - w * 0.5, 0); g.lineTo(x + w * 0.5, 0); g.lineTo(x + w * 2.5 - VW * 0.08, VH * 0.9); g.lineTo(x - w * 1.5 - VW * 0.08, VH * 0.9); g.fill();
      }
      g.restore();

      // ── now and then a manta glides past, far off in the gloom ──
      if (!st.manta && (st.mantaWait -= k) <= 0) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        st.manta = { x: dir > 0 ? -0.3 : 1.3, y: 0.3 + Math.random() * 0.3, dir, ph: 0 };
      }
      if (st.manta) {
        const m = st.manta; m.x += m.dir * 0.0012 * k; m.ph += 0.035 * k;
        const mx = m.x * VW, my = (m.y + Math.sin(m.ph * 0.5) * 0.02) * VH, span = M * 0.28, fl = Math.sin(m.ph) * span * 0.12;
        g.save(); g.translate(mx, my); g.scale(m.dir, 1);
        g.beginPath();
        g.moveTo(span * 0.18, 0);
        g.quadraticCurveTo(span * 0.05, -span * 0.12 - fl, -span * 0.08, -span * 0.5 - fl);
        g.quadraticCurveTo(-span * 0.12, -span * 0.15, -span * 0.22, 0);
        g.quadraticCurveTo(-span * 0.12, span * 0.15, -span * 0.08, span * 0.5 + fl);
        g.quadraticCurveTo(span * 0.05, span * 0.12 + fl, span * 0.18, 0);
        g.fillStyle = `hsla(${WH | 0},45%,5%,0.7)`; g.fill();
        const belly = g.createRadialGradient(span * 0.02, 0, 0, span * 0.02, 0, span * 0.2);
        belly.addColorStop(0, `hsla(${WH - 10 | 0},30%,22%,0.5)`); belly.addColorStop(1, `hsla(${WH | 0},30%,10%,0)`);
        g.fillStyle = belly; g.fill();
        // the two cephalic fins curling forward either side of the mouth
        g.fillStyle = `hsla(${WH | 0},45%,5%,0.7)`;
        for (const sd of [-1, 1]) { g.beginPath(); g.ellipse(span * 0.2, sd * span * 0.05, span * 0.06, span * 0.018, sd * 0.4, 0, TAU); g.fill(); }
        g.beginPath(); g.moveTo(-span * 0.2, 0); g.quadraticCurveTo(-span * 0.4, Math.sin(m.ph * 1.3) * span * 0.03, -span * 0.6, 0);
        g.strokeStyle = `hsla(${WH | 0},50%,4%,0.75)`; g.lineWidth = Math.max(1, span * 0.012); g.stroke();
        g.restore();
        if (m.x < -0.4 || m.x > 1.4) { st.manta = null; st.mantaWait = 600 + Math.random() * 900; }
      }

      // ── the sea floor: kelp swaying over sand and rocks, anemones ──
      const sway = (kx, f) => Math.sin(t * 0.35 + kx * 5 + f * 2.2) * 0.045 * f + Math.sin(t * 0.9 + kx * 11) * 0.01 * f;
      const drawKelp = (far) => {
        for (const kp of st.kelp) {
          if (kp.far !== far) continue;
          const bx = kp.x * VW, by = floorY(kp.x) * VH + 4, n = 10;
          const pts = [];
          for (let i = 0; i <= n; i++) { const f = i / n; pts.push([bx + sway(kp.x, f) * VW, by - f * kp.h * VH]); }
          g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < n; i++) g.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
          g.strokeStyle = far ? `hsla(${WH - 40 | 0},45%,8%,1)` : 'hsla(150,45%,12%,1)';
          g.lineWidth = Math.max(1, M * (far ? 0.006 : 0.009)); g.stroke();
          g.fillStyle = far ? `hsla(${WH - 40 | 0},45%,9%,1)` : 'hsla(140,50%,14%,1)';
          for (let i = 2; i < n; i++) {
            const side = i % 2 ? 1 : -1, [lx, ly] = pts[i], ls = M * (far ? 0.022 : 0.032) * (1 - i / n * 0.4);
            g.beginPath(); g.ellipse(lx + side * ls * 0.6, ly, ls * 0.75, ls * 0.25, side * -0.5 + sway(kp.x, i / n) * 3, 0, TAU); g.fill();
          }
        }
      };
      drawKelp(true);
      g.beginPath(); g.moveTo(0, VH);
      for (let i = 0; i <= 48; i++) { const x = i / 48; g.lineTo(x * VW, floorY(x) * VH); }
      g.lineTo(VW, VH); g.closePath();
      const sand = g.createLinearGradient(0, FLOOR * VH - 20, 0, VH);
      sand.addColorStop(0, `hsl(${WH - 10 | 0},35%,9%)`); sand.addColorStop(1, `hsl(${WH | 0},40%,3%)`);
      g.fillStyle = sand; g.fill();
      for (let i = 0; i < 7; i++) {
        const rx = ((i * 0.618 + 0.07) % 1) * VW, ry = floorY(rx / VW) * VH, rr = M * (0.025 + (i % 3) * 0.015);
        g.beginPath(); g.ellipse(rx, ry + rr * 0.2, rr * 1.4, rr * 0.75, 0, Math.PI, TAU);
        g.fillStyle = `hsl(${WH - 5 | 0},25%,${6 + (i % 3)}%)`; g.fill();
      }
      g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
      for (const an of st.anemones) {
        const ax = an.x * VW, ay = floorY(an.x) * VH, open = 0.55 + bass * 0.6 + Math.sin(t * 0.6 + an.ph) * 0.08, al = M * 0.05 * open;
        for (let i = 0; i < 18; i++) {
          const th = -Math.PI + (i + 0.5) / 18 * Math.PI, wav = Math.sin(t * 1.5 + i * 0.8 + an.ph) * 0.18;
          const ex = ax + Math.cos(th + wav) * al, ey = ay + Math.sin(th + wav) * al * 0.9;
          g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo(ax + Math.cos(th) * al * 0.5, ay + Math.sin(th) * al * 0.6, ex, ey);
          g.strokeStyle = `hsla(${an.hue},100%,55%,0.35)`; g.lineWidth = Math.max(1, M * 0.004); g.stroke();
          g.beginPath(); g.arc(ex, ey, Math.max(0.8, M * 0.0035), 0, TAU);
          g.fillStyle = `hsla(${an.hue},100%,75%,${(0.4 + bass * 0.6).toFixed(2)})`; g.fill();
        }
      }
      g.restore();

      // ── marine snow, drifting, twinkling with the highs ──
      for (const p of st.snow) {
        p.y += 0.00025 * p.z * k; p.x += Math.sin(t * 0.3 + p.tw) * 0.0002 * k;
        if (p.y > 1.02) { p.y = -0.02; p.x = Math.random(); }
        const tw = 0.5 + 0.5 * Math.sin(t * 2 + p.tw * 5);
        g.fillStyle = `hsla(${WH - 40 | 0},60%,85%,${(0.1 + p.z * 0.22 + highs * tw * 0.6).toFixed(2)})`;
        const sz = Math.max(0.7, S * 0.0022 * p.z * (1 + highs * tw * 1.5));
        g.fillRect(p.x * VW, p.y * VH, sz, sz);
      }

      // ── the school of tetras: each one keeps its own place in a loose
      // shoal that follows a wandering point, and they burst apart on a kick ──
      const tx = 0.5 + Math.sin(t * 0.07) * 0.32 + Math.sin(t * 0.19) * 0.08, ty = 0.5 + Math.sin(t * 0.11 + 1) * 0.2;
      // a kick startles them into a burst that eases off over a few frames;
      // then they ignore kicks until they've regrouped, so a run of beats
      // doesn't keep jerking the shoal about
      st.panicCool -= k;
      if (kicked && st.panicCool <= 0) { st.panic = 0.6 + bass * 0.8; st.panicCool = 150; }
      st.panic *= Math.pow(0.88, k);
      let sx = 0, sy = 0;
      for (const f of st.fish) { sx += f.x; sy += f.y; }
      sx /= FISH; sy /= FISH;
      for (const f of st.fish) {
        let ax = (tx + f.ox - f.x) * 0.0006, ay = (ty + f.oy - f.y) * 0.0006;
        for (const o of st.fish) {
          if (o === f) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 0.0009 && d2 > 0) { ax += dx / d2 * 0.0000025; ay += dy / d2 * 0.0000025; }
        }
        if (st.panic > 0.02) {
          const dx = f.x - sx, dy = f.y - sy, d = Math.hypot(dx, dy) || 1;
          ax += dx / d * 0.0012 * st.panic; ay += dy / d * 0.0012 * st.panic;
        }
        f.vx += ax * k; f.vy += ay * k;
        const sp = Math.hypot(f.vx, f.vy), max = 0.006;
        if (sp > max) { f.vx *= max / sp; f.vy *= max / sp; }
        if (sp < 0.0008) f.vx += (f.vx >= 0 ? 0.0002 : -0.0002) * k;
        f.vx *= Math.pow(0.985, k); f.vy *= Math.pow(0.985, k);
        f.x += f.vx * k; f.y += f.vy * k * 0.8;
        f.y = clamp(f.y, 0.1, FLOOR - 0.05);
      }

      // ── bubbles from the floor on every kick ──
      if (kicked && st.bubbles.length < 160) {
        const x0 = 0.1 + Math.random() * 0.8;
        for (let i = 0; i < 6 + ((bass * 10) | 0); i++) st.bubbles.push({ x: x0 + (Math.random() - 0.5) * 0.04, y: floorY(x0) + i * 0.025, r: 0.003 + Math.random() * 0.007, ph: Math.random() * TAU });
      }

      // ── the jellies (far ones first), with the shoal swimming among them ──
      st.jellies.sort((a, b) => a.z - b.z);
      let fishDrawn = false;
      for (let i = 0; i < st.jellies.length; i++) {
        const j = st.jellies[i];
        if (!fishDrawn && j.z > 0.75) { for (const f of st.fish) drawFish(g, f, VW, VH, S, t); fishDrawn = true; }
        const e = band(freqData, j.band * 0.6, j.band * 0.6 + 0.08);
        j.glow += (e - j.glow) * 0.2;
        // a slow pulse of its own, and a hard one on every kick
        const own = Math.max(0, Math.sin(t * 0.9 + j.phase));
        const target = Math.max(own * 0.35, kicked ? 0.7 + hit * 0.3 : 0);
        if (kicked) { j.flash = hit; j.flashHue = FLASH[(st.beats + i * 3) % FLASH.length]; }
        j.flash *= Math.pow(0.93, k);
        if (target > j.squeeze) { j.vy -= (target - j.squeeze) * 0.0035 * (0.6 + j.z * 0.4); j.squeeze = target; }
        j.squeeze *= Math.pow(0.9, k);
        j.vx += (Math.sin(t * 0.2 + j.phase * 3) * 0.00004) * k;
        j.vy += 0.00008 * k;   // sinking back slowly between strokes
        j.vy += (j.home - j.y) * 0.0008 * k;   // ...but keeping to its own depth, so it never drifts off for good
        // give each other a little room rather than bunching up
        for (const o of st.jellies) {
          if (o === j) continue;
          const dx = j.x - o.x, dy = j.y - o.y;
          if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.2) { j.vx += (dx >= 0 ? 1 : -1) * 0.00003 * k; j.vy += (dy >= 0 ? 1 : -1) * 0.00002 * k; }
        }
        const drag = Math.pow(0.95, k);
        j.vx *= drag; j.vy *= drag;
        j.x += j.vx * k; j.y += j.vy * k * j.z;
        if (j.x < 0.05) j.vx += 0.0002 * k; if (j.x > 0.95) j.vx -= 0.0002 * k;
        if (j.y < -0.25 || j.y > 1.4) { st.jellies[i] = jelly((Math.random() * NEON.length) | 0, true); continue; }
        if (!Number.isFinite(j.x + j.y)) { st.jellies[i] = jelly(i, false); continue; }
        // tentacles hang from the rim, arms from the middle; each link trails the one before it
        const r = j.size * j.z * vizUserScale * M, bw = r * (1 + j.squeeze * 0.22), rimH = bw * 0.24;
        for (const tl of j.tails) {
          const p0 = tl.pts[0];
          p0.x = j.x + (tl.arm ? tl.off * bw : -Math.cos(tl.th) * bw * 0.97) / VW;
          p0.y = j.y + (tl.arm ? 0 : Math.sin(tl.th) * rimH) / VH;
          const L = r * 0.32 * tl.len;
          for (let s = 1; s < tl.pts.length; s++) {
            const a = tl.pts[s - 1], p = tl.pts[s];
            // hang down from the link above, swaying, and trail behind the bell
            p.y += 0.003 * k;
            p.x += (a.x - p.x) * 0.1 * k + Math.sin(t * 1.3 - s * 0.5 + j.phase + tl.th * 3 + tl.off * 9) * 0.0004 * k;
            const dx = (p.x - a.x) * VW, dy = (p.y - a.y) * VH, d = Math.hypot(dx, dy) || 1;
            p.x = a.x + dx / d * L / VW; p.y = a.y + dy / d * L / VH;
          }
        }
        drawJelly(g, j, VW, VH, S, t);
      }
      if (!fishDrawn) for (const f of st.fish) drawFish(g, f, VW, VH, S, t);

      drawKelp(false);

      g.lineWidth = Math.max(1, S * 0.0015);
      for (let i = st.bubbles.length - 1; i >= 0; i--) {
        const b = st.bubbles[i];
        b.y -= (0.004 + b.r * 0.6) * k; b.ph += 0.15 * k;
        if (b.y < -0.05) { st.bubbles.splice(i, 1); continue; }
        const bx = (b.x + Math.sin(b.ph) * 0.004) * VW, by = b.y * VH, br = b.r * S;
        g.beginPath(); g.arc(bx, by, br, 0, TAU);
        g.strokeStyle = `hsla(${WH - 30 | 0},70%,85%,0.5)`; g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.beginPath(); g.arc(bx - br * 0.35, by - br * 0.35, br * 0.25, 0, TAU); g.fill();
      }

      // a vignette, the dark closing in from the edges
      const vg = g.createRadialGradient(VW / 2, VH / 2, M * 0.3, VW / 2, VH / 2, Math.hypot(VW, VH) * 0.6);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,8,0.65)');
      g.fillStyle = vg; g.fillRect(0, 0, VW, VH);
    },
  });
})();
