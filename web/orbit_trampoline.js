'use strict';
// Trampoline: an Orbit Visualizer mode (plugin API only -- see
// orbit_visualizer.js's registry comments). Dusk on a farm, and the
// cows and the frogs have got hold of the trampolines. Each animal
// listens to its own slice of the spectrum, which decides how high it
// goes, and every kick sends them all up higher (and someone shouts
// about it). Cows do flips off the big ones, frogs kick their legs out
// and snap flies out of the air with their tongues, and the cow and the
// frog sharing the big one in the middle double-bounce each other. The
// video plays on a sheet hung on the side of the barn, fireflies come
// out with the highs, and every so often a cow bounces so hard it goes
// right over the moon. J makes everybody jump; M sends a cow moonward.
(function () {
  const viz = window.orbitViz;
  if (!viz || typeof viz.registerMode !== 'function') return;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const TAU = Math.PI * 2;
  const hash = (n) => { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); };
  function band(freq, lo, hi) {
    const a = Math.floor(freq.length * lo), b = Math.max(a + 1, Math.floor(freq.length * hi)); let s = 0;
    for (let i = a; i < b; i++) s += freq[i];
    return s / ((b - a) * 255);
  }

  // heights are in units of S (the scene's size), gravity in S per frame²
  // at Speed 1. Back-row trampolines scale everything on them down.
  const G = 0.0009, CONTACT = 9, MAX_H = 0.42, MOON_EVERY = 24, FLIES = 5, FIREFLIES = 26;
  // [x as a fraction of the half-width, row, radius in S, pad colour, animals as [kind, offset]]
  const TRAMPS = [
    [-0.16, 0, 0.12, '#2a7de1', [['frog', 0]]],
    [0.3, 0, 0.12, '#f2c230', [['cow', 0]]],
    [0.76, 0, 0.12, '#9a4fd6', [['frog', 0]]],
    [-0.62, 1, 0.17, '#e23a3a', [['cow', 0]]],
    [0.02, 1, 0.21, '#2fb36a', [['cow', -0.36], ['frog', 0.4]]],
    [0.63, 1, 0.17, '#f07b2a', [['frog', 0]]],
  ];
  const SHOUTS = { cow: ['MOO!', 'MOOO!', 'M0O!!'], frog: ['RIBBIT', 'CROAK!', 'RIBBIT!'] };
  let st = null, vid = null, keyHandlers = null, lastDraw = 0;

  function fresh() {
    const s = {
      t: 0, lastRot: null, lastT: 0, floor: 0, ceil: 0, armed: true, kickCool: 0, beats: 0,
      tramps: [], animals: [], bubbles: [], flies: [], fireflies: [], stars: [], moonshot: null, vidRGB: [230, 210, 170],
    };
    TRAMPS.forEach(([fx, row, r, pad, who], ti) => {
      const tr = { fx, row, r, pad, dip: 0, wob: 0, idx: ti };
      s.tramps.push(tr);
      who.forEach(([kind, off], ai) => {
        const i = s.animals.length;
        s.animals.push({
          kind, tr, off, lo: (i % 7) / 7 * 0.6, hi: ((i % 7) + 1) / 7 * 0.6, e: 0.3,
          state: 'air', h: 0.05 + hash(i * 3.3) * 0.25, vh: 0, ct: 0, depth: 0.5, boost: 0, extra: 0,
          rot: 0, spin: 0, face: hash(i * 7.7) < 0.5 ? -1 : 1, tongue: null, moonPending: false,
        });
      });
    });
    for (let i = 0; i < FLIES; i++) s.flies.push(fly(i));
    for (let i = 0; i < FIREFLIES; i++) s.fireflies.push({ x: hash(i * 5.1), y: hash(i * 9.7), ph: hash(i * 1.9) * TAU, sp: 0.5 + hash(i * 4.2) });
    for (let i = 0; i < 70; i++) s.stars.push({ x: hash(i * 12.9 + 1), y: hash(i * 78.2 + 3), r: 0.4 + hash(i * 4.4) * 1.1, ph: hash(i * 2.3) * TAU });
    return s;
  }
  function fly(i) {
    return { x: (Math.random() - 0.5) * 1.6, y: -0.15 - Math.random() * 0.3, ph: Math.random() * TAU, sp: 0.6 + Math.random() * 0.8, gone: 0, seed: i + Math.random() * 100 };
  }

  // where things are this frame, in canvas pixels
  function layout(VW, VH, cx, cy, S) {
    const W = Math.min(VW, S * 1.9) / 2, Y0 = cy - S * 0.02;
    for (const tr of st.tramps) {
      tr.x = cx + tr.fx * W;
      tr.R = tr.r * S;
      tr.gy = Y0 + (tr.row ? 0.43 : 0.15) * S;   // where its feet meet the grass
      tr.matY = tr.gy - tr.R * 0.42;
      tr.hs = tr.r / 0.19;                        // this trampoline's share of full size
    }
    return { W, Y0 };
  }

  function say(text, x, y, size) { if (st.bubbles.length < 8) st.bubbles.push({ text, x, y, size, life: 0 }); }

  function launch(a) {
    const kick = a.boost, shared = a.extra;
    let target = 0.04 + a.e * 0.2 + kick * 0.12 + shared + Math.random() * 0.04;
    target = Math.min(MAX_H, target);
    a.state = 'air'; a.boost = 0; a.extra = 0;
    if (a.moonPending && a.kind === 'cow' && !st.moonshot) {
      a.moonPending = false; a.moonshot = true; st.moonshot = { a, phase: 'up', p: 0 };
      a.vh = Math.sqrt(2 * G * 3); a.spin = 0.05 * a.face;
      return;
    }
    a.vh = Math.sqrt(2 * G * target);
    const air = 2 * a.vh / G;
    a.spin = 0;
    if (a.kind === 'cow' && target > 0.26) a.spin = (TAU / air) * a.face * (target > 0.38 ? 2 : 1);   // a flip, or two
    else if (a.kind === 'frog' && target > 0.24) a.spin = -(TAU / air) * a.face;
  }

  function step(k, kicked, dt, ease, freq) {
    const S = st.S;
    // a kick: everyone gets more spring in the next bounce, and somebody says so
    if (kicked) {
      for (const a of st.animals) a.boost = 1;
      if (st.beats % 2 === 0) {
        const a = st.animals[(hash(st.beats * 1.7) * st.animals.length) | 0];
        if (!a.moonshot) {
          const p = animalPos(a);
          say(SHOUTS[a.kind][st.beats % 3], p.x + a.face * p.u * 0.6, p.y - p.u * 1.1, p.u * 0.42);
        }
      }
      if (st.beats % MOON_EVERY === MOON_EVERY / 2) moonCow();
    }
    for (const tr of st.tramps) { tr.wob *= Math.pow(0.9, k); }
    for (const a of st.animals) {
      a.e += (band(freq, a.lo, a.hi) - a.e) * ease(0.15);
      a.boost = Math.max(0, a.boost - 0.012 * k);
      if (a.state === 'moon') continue;
      if (a.state === 'contact') {
        a.ct += k;
        if (a.ct >= CONTACT) launch(a);
        continue;
      }
      a.vh -= G * k;
      a.h += a.vh * k;
      a.rot += a.spin * k;
      // gone up past the top of the screen on the way to the moon
      if (a.moonshot && a.vh > 0 && st.moonshot && st.moonshot.phase === 'up' && a.tr.matY - a.h * S * a.tr.hs < -S * 0.25) {
        a.state = 'moon'; st.moonshot.phase = 'over'; st.moonshot.p = 0;
      }
      if (a.h <= 0 && a.vh < 0) {
        const impact = -a.vh;
        a.h = 0; a.state = 'contact'; a.ct = 0; a.rot = 0; a.spin = 0;
        a.depth = clamp(impact / Math.sqrt(2 * G * MAX_H), 0.3, a.moonshot ? 1.6 : 1);
        a.tr.wob = Math.max(a.tr.wob, a.depth);
        if (a.moonshot) {
          a.moonshot = false; st.moonshot = null; a.boost = 0;
          const p = animalPos(a);
          say('BOING!', p.x, p.y - p.u * 1.2, p.u * 0.55);
        }
        // landing on a shared trampoline throws whoever's already sunk into it
        for (const b of st.animals) if (b !== a && b.tr === a.tr && b.state === 'contact') b.extra = Math.min(0.2, a.depth * 0.18);
        if (a.kind === 'frog' && Math.random() < 0.15) a.face = -a.face;
        if (a.kind === 'cow' && Math.random() < 0.08) a.face = -a.face;
      }
      // frogs near the top of a hop go for the nearest fly
      if (a.kind === 'frog' && !a.tongue && Math.abs(a.vh) < G * 6 && a.h > 0.08) {
        const p = animalPos(a);
        let best = null, bd = S * 0.32 * a.tr.hs;
        for (const f of st.flies) {
          if (f.gone > 0) continue;
          const d = Math.hypot(f.px - p.x, f.py - (p.y - p.u * 0.45));
          if (d < bd) { bd = d; best = f; }
        }
        if (best) { a.tongue = { f: best, t: 0 }; a.face = best.px > p.x ? 1 : -1; }
      }
      if (a.tongue) {
        a.tongue.t += k;
        if (a.tongue.t > 7 && a.tongue.f.gone === 0) a.tongue.f.gone = 1;   // got it
        if (a.tongue.t > 14) a.tongue = null;
      }
    }
    if (st.moonshot && st.moonshot.phase === 'over') {
      st.moonshot.p += k / 170;
      if (st.moonshot.p >= 1) {
        // and back down again, from well above the top of the screen
        const a = st.moonshot.a;
        st.moonshot.phase = 'down';
        a.state = 'air'; a.vh = 0; a.h = (a.tr.matY + S * 0.3) / (S * a.tr.hs); a.spin = 0.12 * a.face;
      }
    }
    for (const f of st.flies) {
      f.ph += 0.05 * f.sp * k;
      if (f.gone > 0) {
        f.gone += k;
        if (f.gone > 400) Object.assign(f, fly(f.seed | 0));
      }
    }
    for (let i = st.bubbles.length - 1; i >= 0; i--) {
      const b = st.bubbles[i]; b.life += k; b.y -= 0.15 * k;
      if (b.life > 70) st.bubbles.splice(i, 1);
    }
  }

  function moonCow() {
    if (st.moonshot) return;
    const cows = st.animals.filter((a) => a.kind === 'cow' && !a.moonPending);
    if (cows.length) cows[(Math.random() * cows.length) | 0].moonPending = true;
  }

  // feet position and body size of an animal, in canvas pixels
  function animalPos(a) {
    const tr = a.tr, dip = a.state === 'contact' ? Math.sin(Math.PI * clamp(a.ct / CONTACT, 0, 1)) * a.depth : 0;
    const u = tr.R * (a.kind === 'cow' ? 0.82 : 0.62) * (tr.r > 0.2 ? 0.85 : 1);
    return { x: tr.x + a.off * tr.R, y: tr.matY + dip * tr.R * 0.22 - a.h * st.S * tr.hs, u, dip };
  }

  // ── the animals, drawn standing on (0, 0) ──────────────────────────
  function drawCow(g, u, a, dip, sil) {
    const air = a.state === 'air', up = air && a.vh > 0;
    const C = sil ? { w: '#1a1426', b: '#1a1426', p: '#1a1426', h: '#1a1426', hoof: '#1a1426' }
      : { w: '#f6f2ea', b: '#1d1a1a', p: '#f2a1a8', h: '#e8dcc0', hoof: '#3a2e28' };
    g.scale(a.face, 1);
    g.scale(1 + dip * 0.18, 1 - dip * 0.24);
    const by = -u * 0.62, splay = air ? (up ? 0.5 : 0.25) : 0;
    // legs, splayed out in the air
    for (const [lx, back] of [[-0.32, 1], [-0.18, 0], [0.2, 1], [0.34, 0]]) {
      g.save(); g.translate(lx * u, by + u * 0.18); g.rotate((lx < 0 ? 1 : -1) * splay * (back ? 1.2 : 0.8));
      g.fillStyle = back ? (sil ? C.w : '#ddd6ca') : C.w;
      g.fillRect(-u * 0.055, 0, u * 0.11, u * 0.44);
      g.fillStyle = C.hoof; g.fillRect(-u * 0.06, u * 0.38, u * 0.12, u * 0.08);
      g.restore();
    }
    // the tail, flapping
    g.strokeStyle = C.w; g.lineWidth = Math.max(1, u * 0.035); g.lineCap = 'round';
    const tw = Math.sin(st.t * 40 + a.off * 9) * 0.3 + (air ? -0.6 : 0);
    g.beginPath(); g.moveTo(-u * 0.48, by - u * 0.12);
    g.quadraticCurveTo(-u * 0.7, by - u * 0.05 + tw * u * 0.3, -u * 0.66, by + u * 0.25 + tw * u * 0.2); g.stroke();
    g.beginPath(); g.arc(-u * 0.66, by + u * 0.27 + tw * u * 0.2, u * 0.05, 0, TAU); g.fillStyle = C.b; g.fill();
    // the body, and its patches
    g.beginPath(); g.ellipse(0, by, u * 0.5, u * 0.27, 0, 0, TAU); g.fillStyle = C.w; g.fill();
    if (!sil) {
      g.save(); g.beginPath(); g.ellipse(0, by, u * 0.5, u * 0.27, 0, 0, TAU); g.clip();
      g.fillStyle = C.b;
      for (const [px, py, pr] of [[-0.28, -0.12, 0.17], [0.1, 0.05, 0.13], [-0.05, -0.22, 0.09], [0.32, -0.15, 0.08]]) {
        g.beginPath(); g.ellipse(px * u, by + py * u, pr * u, pr * u * 0.8, px * 3, 0, TAU); g.fill();
      }
      g.restore();
      g.beginPath(); g.ellipse(-u * 0.26, by + u * 0.25, u * 0.1, u * 0.06, 0, 0, TAU); g.fillStyle = C.p; g.fill();   // the udder
    }
    // the head, with its bell
    const hx = u * 0.5, hy = by - u * 0.2;
    g.fillStyle = C.h;
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(hx + s * u * 0.08, hy - u * 0.14); g.quadraticCurveTo(hx + s * u * 0.2, hy - u * 0.3, hx + s * u * 0.14, hy - u * 0.34); g.lineTo(hx + s * u * 0.1, hy - u * 0.16); g.fill(); }
    g.fillStyle = C.w;
    g.beginPath(); g.ellipse(hx - u * 0.15, hy - u * 0.08, u * 0.1, u * 0.045, -0.5, 0, TAU); g.fill();   // the ear
    g.beginPath(); g.ellipse(hx, hy, u * 0.15, u * 0.19, 0.25, 0, TAU); g.fill();
    if (!sil) {
      g.fillStyle = C.b; g.beginPath(); g.ellipse(hx - u * 0.04, hy - u * 0.08, u * 0.07, u * 0.08, 0, 0, TAU); g.fill();
    }
    g.beginPath(); g.ellipse(hx + u * 0.07, hy + u * 0.13, u * 0.13, u * 0.09, 0.2, 0, TAU); g.fillStyle = C.p; g.fill();
    if (!sil) {
      g.fillStyle = '#9b4b56';
      g.beginPath(); g.arc(hx + u * 0.04, hy + u * 0.12, u * 0.018, 0, TAU); g.arc(hx + u * 0.12, hy + u * 0.14, u * 0.018, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx + u * 0.05, hy - u * 0.04, u * 0.045, 0, TAU); g.fill();
      g.fillStyle = '#111'; g.beginPath(); g.arc(hx + u * 0.065, hy - u * 0.035, u * 0.025, 0, TAU); g.fill();
      g.fillStyle = '#d4a52a'; g.beginPath(); g.moveTo(hx - u * 0.06, hy + u * 0.2); g.lineTo(hx + u * 0.02, hy + u * 0.2);
      g.lineTo(hx + u * 0.04, hy + u * 0.32); g.lineTo(hx - u * 0.08, hy + u * 0.32); g.closePath(); g.fill();
    }
  }

  function drawFrog(g, u, a, dip, bass) {
    const air = a.state === 'air', up = air && a.vh > 0.0005;
    g.scale(1 + dip * 0.22, 1 - dip * 0.3);
    const body = '#4caf3a', dark = '#2e7d23', belly = '#c9e58a';
    // hind legs: kicked out long on the way up, folded under otherwise
    g.fillStyle = dark;
    for (const s of [-1, 1]) {
      if (up) {
        g.save(); g.translate(s * u * 0.22, -u * 0.18); g.rotate(s * 0.35);
        g.fillRect(-u * 0.06, 0, u * 0.12, u * 0.42);
        g.beginPath(); g.moveTo(-u * 0.12, u * 0.46); g.lineTo(0, u * 0.36); g.lineTo(u * 0.12, u * 0.46); g.lineTo(0, u * 0.5); g.closePath(); g.fill();
        g.restore();
      } else {
        g.beginPath(); g.ellipse(s * u * 0.3, -u * 0.13, u * 0.17, u * 0.12, s * 0.3, 0, TAU); g.fill();
        g.beginPath(); g.ellipse(s * u * 0.4, -u * 0.02, u * 0.13, u * 0.035, 0, 0, TAU); g.fill();
      }
    }
    // the body
    g.beginPath(); g.ellipse(0, -u * 0.32, u * 0.36, u * 0.28, 0, 0, TAU); g.fillStyle = body; g.fill();
    g.beginPath(); g.ellipse(0, -u * 0.25, u * 0.22, u * 0.17, 0, 0, TAU); g.fillStyle = belly; g.fill();
    g.fillStyle = dark;
    for (const [sx, sy, sr] of [[-0.2, -0.45, 0.04], [0.24, -0.42, 0.035], [-0.27, -0.28, 0.03]]) { g.beginPath(); g.arc(sx * u, sy * u, sr * u, 0, TAU); g.fill(); }
    // little arms, up in the air on the way up
    g.strokeStyle = body; g.lineWidth = u * 0.07; g.lineCap = 'round';
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * u * 0.2, -u * 0.25);
      if (air) g.lineTo(s * u * 0.42, -u * (up ? 0.62 : 0.45)); else g.lineTo(s * u * 0.18, -u * 0.04);
      g.stroke();
    }
    // the throat sac, puffing with the bass
    const sac = 0.06 + bass * 0.12;
    g.beginPath(); g.ellipse(0, -u * 0.36, u * sac * 1.2, u * sac, 0, 0, TAU); g.fillStyle = 'rgba(240,240,190,0.85)'; g.fill();
    // the eyes, on top
    for (const s of [-1, 1]) {
      g.beginPath(); g.arc(s * u * 0.17, -u * 0.58, u * 0.11, 0, TAU); g.fillStyle = body; g.fill();
      g.beginPath(); g.arc(s * u * 0.17, -u * 0.6, u * 0.075, 0, TAU); g.fillStyle = '#f7f3c2'; g.fill();
      g.beginPath(); g.ellipse(s * u * 0.17 + a.face * u * 0.02, -u * 0.6, u * 0.045, u * 0.03, 0, 0, TAU); g.fillStyle = '#111'; g.fill();
    }
    // the grin
    g.strokeStyle = '#1d4d16'; g.lineWidth = Math.max(1, u * 0.025);
    g.beginPath(); g.arc(0, -u * 0.5, u * 0.2, 0.25 * Math.PI, 0.75 * Math.PI); g.stroke();
  }

  // ── a trampoline: back half, then whoever's on it, then the front ───
  function trampBack(g, tr) {
    const { x, matY, R, gy } = tr, ry = R * 0.3, legH = gy - matY;
    // its shadow on the grass, and the legs
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(x, gy, R * 1.05, ry * 1.05, 0, 0, TAU); g.fill();
    g.strokeStyle = '#8f98a3'; g.lineWidth = Math.max(1, R * 0.035);
    for (let i = 0; i < 6; i++) {
      const an = i * Math.PI / 3 + Math.PI / 6, lx = x + Math.cos(an) * R * 0.97, ly = matY + Math.sin(an) * ry;
      g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx, ly + legH * (0.85 + Math.sin(an) * 0.15)); g.stroke();
    }
    // the mat, dipping where someone's landed
    const wob = Math.sin(st.t * 160 + tr.idx) * tr.wob * 0.05;
    g.beginPath(); g.ellipse(x, matY, R * 0.86, ry * 0.86 * (1 + wob), 0, 0, TAU); g.fillStyle = '#121214'; g.fill();
    const dip = tr.dip;
    if (dip > 0.01) {
      const dg = g.createRadialGradient(x, matY + dip * R * 0.16, 0, x, matY + dip * R * 0.16, R * 0.8);
      dg.addColorStop(0, `rgba(0,0,0,${(0.6 * Math.min(1, dip)).toFixed(2)})`); dg.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.beginPath(); g.ellipse(x, matY, R * 0.86, ry * 0.86, 0, 0, TAU); g.clip();
      g.fillStyle = dg; g.fillRect(x - R, matY - ry, R * 2, ry * 2 + R * 0.2); g.restore();
    }
    // a faint sheen on the mat, and the springs round its edge
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = Math.max(1, R * 0.01);
    g.beginPath(); g.ellipse(x, matY + dip * R * 0.06, R * 0.6, ry * 0.5, 0, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
    g.strokeStyle = '#b8c0c8'; g.lineWidth = Math.max(1, R * 0.012);
    for (let i = 0; i < 28; i++) {
      const an = i / 28 * TAU, c = Math.cos(an), s = Math.sin(an);
      g.beginPath(); g.moveTo(x + c * R * 0.86, matY + s * ry * 0.86); g.lineTo(x + c * R * 0.95, matY + s * ry * 0.95); g.stroke();
    }
    padArc(g, tr, Math.PI, TAU);
  }
  function padArc(g, tr, a0, a1) {
    const { x, matY, R } = tr, ry = R * 0.3;
    g.lineWidth = Math.max(2, R * 0.09); g.lineCap = 'butt';
    g.strokeStyle = tr.pad; g.beginPath(); g.ellipse(x, matY, R, ry, 0, a0, a1); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = Math.max(1, R * 0.02);
    g.beginPath(); g.ellipse(x, matY - R * 0.025, R, ry, 0, a0, a1); g.stroke();
  }

  function drawAnimal(g, a, bass) {
    if (a.state === 'moon') return;
    const p = animalPos(a), tr = a.tr;
    // its shadow on the mat, shrinking the higher it goes
    const hh = a.h * tr.hs, sc = 1 / (1 + hh * 4);
    g.fillStyle = `rgba(0,0,0,${(0.45 * sc).toFixed(2)})`;
    g.beginPath(); g.ellipse(p.x, tr.matY + p.dip * tr.R * 0.22, p.u * 0.45 * sc, p.u * 0.1 * sc, 0, 0, TAU); g.fill();
    // the frog's tongue, out to the fly
    if (a.tongue) {
      const f = a.tongue.f, tt = a.tongue.t, reach = tt < 7 ? tt / 7 : 1 - (tt - 7) / 7;
      const mx = p.x, my = p.y - p.u * 0.42;
      g.strokeStyle = '#e8577a'; g.lineWidth = Math.max(1, p.u * 0.05); g.lineCap = 'round';
      g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + (f.px - mx) * reach, my + (f.py - my) * reach); g.stroke();
    }
    g.save(); g.translate(p.x, p.y);
    if (a.rot) { g.translate(0, -p.u * 0.4); g.rotate(a.rot); g.translate(0, p.u * 0.4); }
    if (a.kind === 'cow') drawCow(g, p.u, a, p.dip, false); else drawFrog(g, p.u, a, p.dip, bass);
    g.restore();
  }

  function drawBarn(g, x, base, w, videoFrame, light) {
    const h = w * 0.72, roofH = w * 0.38, top = base - h;
    // the wall and the gable
    g.fillStyle = '#7d1f1a';
    g.beginPath(); g.moveTo(x, base); g.lineTo(x, top); g.lineTo(x + w * 0.18, top - roofH * 0.55); g.lineTo(x + w / 2, top - roofH);
    g.lineTo(x + w * 0.82, top - roofH * 0.55); g.lineTo(x + w, top); g.lineTo(x + w, base); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = Math.max(1, w * 0.006);
    for (let i = 1; i < 14; i++) { g.beginPath(); g.moveTo(x + w * i / 14, base); g.lineTo(x + w * i / 14, top - roofH * (1 - Math.abs(i / 14 - 0.5) * 2) * 0.9); g.stroke(); }
    // the roof edge, the white trim, the hay door
    g.strokeStyle = '#3a2a24'; g.lineWidth = Math.max(2, w * 0.03); g.lineJoin = 'round';
    g.beginPath(); g.moveTo(x - w * 0.03, top + w * 0.02); g.lineTo(x + w * 0.18, top - roofH * 0.55); g.lineTo(x + w / 2, top - roofH);
    g.lineTo(x + w * 0.82, top - roofH * 0.55); g.lineTo(x + w * 1.03, top + w * 0.02); g.stroke();
    g.strokeStyle = '#e9e1d2'; g.lineWidth = Math.max(1, w * 0.012);
    g.strokeRect(x + w * 0.4, top - roofH * 0.62, w * 0.2, roofH * 0.42);
    g.beginPath(); g.moveTo(x + w * 0.4, top - roofH * 0.62); g.lineTo(x + w * 0.6, top - roofH * 0.2); g.moveTo(x + w * 0.6, top - roofH * 0.62); g.lineTo(x + w * 0.4, top - roofH * 0.2); g.stroke();
    // the sheet, pegged up, with the video on it
    const sx = x + w * 0.1, sy = top + h * 0.1, sw = w * 0.8, sh = h * 0.62;
    g.fillStyle = '#e8e4da'; g.fillRect(sx, sy, sw, sh);
    if (videoFrame) {
      if (!vid || vid.c.width !== videoFrame.w || vid.c.height !== videoFrame.h) {
        const c = document.createElement('canvas'); c.width = videoFrame.w; c.height = videoFrame.h;
        vid = { c, g: c.getContext('2d') };
      }
      vid.g.putImageData(videoFrame.imageData, 0, 0);
      const d = videoFrame.imageData.data; let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      if (n) { const v = st.vidRGB; v[0] += (r / n - v[0]) * 0.1; v[1] += (gg / n - v[1]) * 0.1; v[2] += (b / n - v[2]) * 0.1; }
      const sc = Math.min(sw / videoFrame.w, sh / videoFrame.h), dw = videoFrame.w * sc, dh = videoFrame.h * sc;
      g.drawImage(vid.c, sx + (sw - dw) / 2, sy + (sh - dh) / 2, dw, dh);
    } else {
      const v = st.vidRGB; v[0] += (235 - v[0]) * 0.05; v[1] += (225 - v[1]) * 0.05; v[2] += (200 - v[2]) * 0.05;
      g.fillStyle = `rgba(255,250,230,${(0.25 + light * 0.2).toFixed(2)})`; g.fillRect(sx, sy, sw, sh);
    }
    // the sheet's sag and folds, and the pegs
    const fold = g.createLinearGradient(sx, 0, sx + sw, 0);
    for (let i = 0; i <= 6; i++) fold.addColorStop(i / 6, `rgba(0,0,0,${i % 2 ? 0.1 : 0})`);
    g.fillStyle = fold; g.fillRect(sx, sy, sw, sh);
    g.fillStyle = '#c9a36a';
    for (let i = 0; i < 4; i++) g.fillRect(sx + sw * (0.03 + i * 0.315) , sy - w * 0.02, w * 0.02, w * 0.045);
    // the big door under it
    g.fillStyle = '#5e1612'; g.fillRect(x + w * 0.3, top + h * 0.78, w * 0.4, h * 0.22);
    g.strokeStyle = '#e9e1d2'; g.lineWidth = Math.max(1, w * 0.01); g.strokeRect(x + w * 0.3, top + h * 0.78, w * 0.4, h * 0.22);
  }

  function drawMoon(g, mx, my, mr, highs) {
    const gl = g.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 3);
    gl.addColorStop(0, `rgba(255,245,200,${(0.25 + highs * 0.2).toFixed(2)})`); gl.addColorStop(1, 'rgba(255,245,200,0)');
    g.fillStyle = gl; g.fillRect(mx - mr * 3, my - mr * 3, mr * 6, mr * 6);
    g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fillStyle = '#fbf3cf'; g.fill();
    g.fillStyle = 'rgba(190,175,130,0.45)';
    for (const [ox, oy, r] of [[-0.3, -0.2, 0.22], [0.25, 0.15, 0.18], [0.05, -0.45, 0.1], [-0.15, 0.4, 0.12]]) { g.beginPath(); g.arc(mx + ox * mr, my + oy * mr, r * mr, 0, TAU); g.fill(); }
  }

  function drawBubble(g, b) {
    const a = b.life < 8 ? b.life / 8 : clamp(1 - (b.life - 45) / 25, 0, 1), pop = 1 + Math.max(0, 1 - b.life / 8) * 0.4;
    g.save(); g.globalAlpha = a; g.translate(b.x, b.y); g.scale(pop, pop);
    g.font = `bold ${Math.max(8, b.size) | 0}px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = g.measureText(b.text).width + b.size * 0.8, h = b.size * 1.5;
    g.fillStyle = '#fffdf4'; g.strokeStyle = '#222'; g.lineWidth = Math.max(1, b.size * 0.08);
    g.beginPath(); g.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-b.size * 0.2, h * 0.42); g.lineTo(-b.size * 0.5, h * 0.9); g.lineTo(b.size * 0.15, h * 0.45); g.closePath(); g.fill();
    g.fillStyle = '#222'; g.fillText(b.text, 0, b.size * 0.04);
    g.restore();
  }

  viz.registerMode({
    id: 'trampoline', label: 'Trampoline',
    init() {
      st = fresh();
      // J: everybody jump. M: a cow goes over the moon. Only while this is the one drawing.
      keyHandlers = {
        down: (e) => {
          if (!st || performance.now() - lastDraw > 300 || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
          const a = document.activeElement;
          if (a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable)) return;
          if (e.code === 'KeyJ') for (const an of st.animals) an.boost = 1.6;
          else if (e.code === 'KeyM') moonCow();
        },
      };
      document.addEventListener('keydown', keyHandlers.down);
    },
    teardown() {
      if (keyHandlers) document.removeEventListener('keydown', keyHandlers.down);
      keyHandlers = null; st = null; vid = null;
    },
    draw(ctx) {
      const { vctx: g, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale, videoFrame } = ctx;
      if (!st) st = fresh();
      lastDraw = performance.now();
      if (st.lastRot == null) st.lastRot = vizRot;
      const dRot = clamp(vizRot - st.lastRot, 0, 0.5); st.lastRot = vizRot;
      const k = Math.min(dRot / 0.006, 4);   // frames' worth of time at the current Speed
      st.t += dRot;
      const bass = band(freqData, 0, 0.06), mids = band(freqData, 0.06, 0.35), highs = band(freqData, 0.35, 0.7);
      // the kick, judged against this track's own recent floor and ceiling (as Deep Sea does)
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

      const S = Math.min(VW, VH) * vizUserScale, M = Math.min(VW, VH);
      st.S = S;
      const { W, Y0 } = layout(VW, VH, cx, cy, S);
      const mx = clamp(cx + W * 0.62, M * 0.1, VW - M * 0.1), my = Math.max(M * 0.1, Y0 - S * 0.4), mr = S * 0.065;
      // the flies buzz about over the trampolines (screen space, so the frogs can reach them)
      for (const f of st.flies) {
        f.px = cx + f.x * W + Math.sin(f.ph * 1.3 + f.seed) * S * 0.05;
        f.py = Y0 + (0.25 + f.y) * S + Math.sin(f.ph * 2.1 + f.seed * 2) * S * 0.03;
      }
      step(k, kicked, dt, ease, freqData);
      for (const tr of st.tramps) {
        let d = 0;
        for (const a of st.animals) if (a.tr === tr && a.state === 'contact') d = Math.max(d, Math.sin(Math.PI * clamp(a.ct / CONTACT, 0, 1)) * a.depth);
        tr.dip = d;
      }
      const [vr, vg, vb] = st.vidRGB.map((v) => v | 0);

      // ── the sky at dusk, and the stars coming out ──
      const hz = (20 + Math.sin(hueBase / 360 * TAU) * 12 + 360) % 360;
      const sky = g.createLinearGradient(0, 0, 0, Y0);
      sky.addColorStop(0, '#0d0c2a'); sky.addColorStop(0.55, `hsl(${(hz + 260) % 360 | 0},45%,24%)`);
      sky.addColorStop(0.85, `hsl(${(hz + 330) % 360 | 0},60%,48%)`); sky.addColorStop(1, `hsl(${hz | 0},85%,62%)`);
      g.fillStyle = sky; g.fillRect(0, 0, VW, Y0 + 1);
      for (const s of st.stars) {
        const y = s.y * Y0 * 0.7, a = clamp((0.3 + 0.25 * Math.sin(st.t * 20 + s.ph) + highs * 0.6) * (1 - s.y * 0.8), 0, 1);
        g.fillStyle = `rgba(255,250,230,${a.toFixed(2)})`; g.fillRect(s.x * VW, y, s.r * M * 0.003, s.r * M * 0.003);
      }
      drawMoon(g, mx, my, mr, highs);
      // the cow going over the moon
      if (st.moonshot && st.moonshot.phase === 'over') {
        const p = st.moonshot.p, a = st.moonshot.a, dir = a.face;
        const ox = mx + (p - 0.5) * mr * 7 * dir, oy = my - Math.sin(p * Math.PI) * mr * 0.9 + mr * 0.55;
        g.save(); g.translate(ox, oy); g.rotate((p - 0.5) * 1.2 * dir);
        drawCow(g, mr * 0.9, { state: 'air', vh: 1, face: dir, off: 0 }, 0, true);
        g.restore();
      }
      // distant hills
      g.fillStyle = '#1f2a3a';
      g.beginPath(); g.moveTo(0, Y0);
      for (let x = 0; x <= VW; x += VW / 24) g.lineTo(x, Y0 - (Math.sin(x / VW * 7 + 1) * 0.5 + 0.6) * S * 0.05);
      g.lineTo(VW, Y0); g.closePath(); g.fill();

      // ── the field ──
      const grass = g.createLinearGradient(0, Y0, 0, VH);
      grass.addColorStop(0, '#30522a'); grass.addColorStop(1, '#13240f');
      g.fillStyle = grass; g.fillRect(0, Y0, VW, VH - Y0);
      // grass tufts, swaying with the mids (before the barn, so it stands in front of them)
      g.strokeStyle = '#4a7a36'; g.lineWidth = Math.max(1, M * 0.002);
      for (let i = 0; i < 90; i++) {
        const gx = hash(i * 3.7) * VW, gy = Y0 + Math.pow(hash(i * 8.1), 0.7) * (VH - Y0), sz = (0.4 + (gy - Y0) / (VH - Y0)) * S * 0.025;
        const sw = Math.sin(st.t * 25 + i) * (0.2 + mids * 0.6);
        g.beginPath();
        for (const o of [-0.4, 0, 0.4]) { g.moveTo(gx + o * sz * 0.3, gy); g.quadraticCurveTo(gx + o * sz * 0.5, gy - sz * 0.6, gx + (o + sw) * sz * 0.6, gy - sz); }
        g.stroke();
      }
      // the barn, and the light off its sheet
      const bw = Math.min(S * 0.46, W * 0.56), bx = cx - W * 0.72 - bw / 2, bBase = Y0 + S * 0.08;
      const spill = g.createRadialGradient(bx + bw / 2, bBase, 0, bx + bw / 2, bBase, bw * 1.3);
      spill.addColorStop(0, `rgba(${vr},${vg},${vb},0.28)`); spill.addColorStop(1, `rgba(${vr},${vg},${vb},0)`);
      drawBarn(g, bx, bBase, bw, videoFrame, mids);
      g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = spill;
      g.fillRect(bx - bw, bBase - bw * 0.1, bw * 3, bw * 1.4); g.restore();
      // the fence along the back of the field
      g.strokeStyle = '#3b2a1e'; g.lineWidth = Math.max(1, S * 0.006);
      const fy = Y0 + S * 0.045;
      g.beginPath(); g.moveTo(bx + bw, fy - S * 0.03); g.lineTo(VW, fy - S * 0.03); g.moveTo(bx + bw, fy - S * 0.012); g.lineTo(VW, fy - S * 0.012); g.stroke();
      g.fillStyle = '#3b2a1e';
      for (let x = bx + bw + S * 0.04; x < VW; x += S * 0.11) g.fillRect(x, fy - S * 0.045, S * 0.012, S * 0.05);
      // ── the trampolines, back row first, each with whoever's on it ──
      const order = st.tramps.slice().sort((a, b) => a.gy - b.gy);
      for (const tr of order) {
        trampBack(g, tr);
        for (const a of st.animals) if (a.tr === tr) drawAnimal(g, a, bass);
        padArc(g, tr, 0, Math.PI);
      }

      // the flies, the fireflies, what everyone's shouting
      for (const f of st.flies) {
        if (f.gone > 0) continue;
        const wing = Math.sin(st.t * 900 + f.seed) * 0.5 + 0.5, fs = S * 0.006;
        g.fillStyle = 'rgba(220,230,255,0.5)';
        g.beginPath(); g.ellipse(f.px - fs, f.py - fs * (1 + wing), fs * 1.2, fs * 0.6, -0.5, 0, TAU); g.ellipse(f.px + fs, f.py - fs * (1 + wing), fs * 1.2, fs * 0.6, 0.5, 0, TAU); g.fill();
        g.fillStyle = '#111'; g.beginPath(); g.arc(f.px, f.py, fs, 0, TAU); g.fill();
      }
      for (const ff of st.fireflies) {
        const x = (ff.x + Math.sin(st.t * 3 * ff.sp + ff.ph) * 0.04) * VW, y = Y0 + (ff.y * 0.9 - 0.15) * (VH - Y0) + Math.cos(st.t * 4 * ff.sp + ff.ph) * S * 0.03;
        const a = clamp(Math.sin(st.t * 30 * ff.sp + ff.ph) * 0.5 + highs * 1.4 - 0.1, 0, 1);
        if (a < 0.03) continue;
        const r = M * 0.012;
        const fg = g.createRadialGradient(x, y, 0, x, y, r);
        fg.addColorStop(0, `rgba(230,255,120,${a.toFixed(2)})`); fg.addColorStop(1, 'rgba(230,255,120,0)');
        g.fillStyle = fg; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (const b of st.bubbles) drawBubble(g, b);

      // and dusk closing in round the edges
      const vgn = g.createRadialGradient(VW / 2, VH / 2, M * 0.35, VW / 2, VH / 2, Math.hypot(VW, VH) * 0.62);
      vgn.addColorStop(0, 'rgba(0,0,0,0)'); vgn.addColorStop(1, 'rgba(0,0,10,0.55)');
      g.fillStyle = vgn; g.fillRect(0, 0, VW, VH);
    },
  });
})();
