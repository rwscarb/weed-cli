'use strict';
// Joyride: an Orbit Visualizer mode (plugin API only -- see
// orbit_visualizer.js's registry comments). A ride down a bumpy, hilly
// road from the driver's seat of a future car, as a cartoon bear, on
// acid: checkerboard fields racing by in three layers of terrain,
// melting rainbows, trees and the odd mushroom, things blooming in the
// sky on every kick, and now and then a glance out of the side window.
// The road's own bumps jolt the camera; every kick is a pothole.
// A / D steer (let go and the bear takes the wheel again). The video
// plays in the big rear-view mirror, pink fuzzy dice hanging from it.
(function () {
  const viz = window.orbitViz;
  if (!viz || typeof viz.registerMode !== 'function') return;

  const hash = (n) => { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (v) => v * v * (3 - 2 * v);
  function bassOf(freq) {
    const n = Math.max(1, Math.floor(freq.length * 0.06)); let s = 0;
    for (let i = 0; i < n; i++) s += freq[i];
    return s / (n * 255);
  }
  function energyOf(freq) {
    const n = Math.max(1, Math.floor(freq.length * 0.7)); let s = 0;
    for (let i = 0; i < n; i++) s += freq[i];
    return s / (n * 255);
  }

  // the world, as functions of distance s along the road (camera heights)
  const hill = (s) => Math.sin(s * 0.021) * 2.6 + Math.sin(s * 0.0537 + 1) * 1.2;
  const bump = (s) => Math.sin(s * 1.7) * 0.6 + Math.sin(s * 3.9 + 2) * 0.3 + Math.sin(s * 0.61) * 0.5;
  const curvAt = (s) => (Math.sin(s * 0.011) * 0.7 + Math.sin(s * 0.0037 + 2) * 0.5) * 0.0028;

  const SEG = 1.5, N = 150, ROADW = 2.2, CAM_H = 1, BAND = 4, BANDS = 9, TEXTURE_D = 75;
  let st = null, keyHandlers = null, echo = null, vid = null, lastDraw = 0;

  function fresh() {
    return {
      z: 0, lastRot: null, bassAvg: 0, kick: 0, bob: 0, bobV: 0, playerX: 0, steer: 0, wheel: 0,
      heading: 0, lastKey: -1e9, keys: { left: false, right: false },
      dice: makeDice(), lastT: 0, prevBobV: 0, prevDz: 0, floaters: [],
    };
  }

  // ── sprites ────────────────────────────────────────────────────────
  // a cartoon tree: curvy trunk, three blobs of canopy, a thick outline
  function tree(g, x, y, sz, hue, sway) {
    g.lineWidth = Math.max(1, sz * 0.035); g.strokeStyle = '#1a0b24';
    g.beginPath();
    g.moveTo(x - sz * 0.08, y); g.quadraticCurveTo(x - sz * 0.02 + sway * 0.5, y - sz * 0.5, x + sway - sz * 0.05, y - sz * 0.85);
    g.lineTo(x + sway + sz * 0.05, y - sz * 0.85); g.quadraticCurveTo(x + sz * 0.06 + sway * 0.5, y - sz * 0.5, x + sz * 0.08, y);
    g.closePath(); g.fillStyle = `hsl(${(hue + 200) % 360 | 0},45%,35%)`; g.fill(); g.stroke();
    for (const [bx, by, br] of [[-0.22, -0.95, 0.3], [0.22, -0.98, 0.3], [0, -1.22, 0.36]]) {
      const px = x + sway + bx * sz, py = y + by * sz, r = br * sz;
      const gr = g.createRadialGradient(px - r * 0.3, py - r * 0.35, r * 0.1, px, py, r);
      gr.addColorStop(0, `hsl(${(hue + 40) % 360 | 0},100%,75%)`);
      gr.addColorStop(1, `hsl(${hue % 360 | 0},95%,45%)`);
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fillStyle = gr; g.fill(); g.stroke();
    }
  }
  function mushroom(g, x, y, sz, hue) {
    g.lineWidth = Math.max(1, sz * 0.03); g.strokeStyle = '#1a0b24';
    g.fillStyle = '#f3e6d0';
    g.beginPath(); g.moveTo(x - sz * 0.12, y); g.lineTo(x - sz * 0.09, y - sz * 0.6); g.lineTo(x + sz * 0.09, y - sz * 0.6); g.lineTo(x + sz * 0.12, y); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(x, y - sz * 0.6, sz * 0.5, sz * 0.42, 0, Math.PI, 0); g.closePath();
    g.fillStyle = `hsl(${hue % 360 | 0},100%,55%)`; g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let s = 0; s < 3; s++) { g.beginPath(); g.arc(x + (s - 1) * sz * 0.22, y - sz * (0.75 + (s % 2) * 0.12), sz * 0.06, 0, Math.PI * 2); g.fill(); }
  }
  // ── fur ────────────────────────────────────────────────────────────
  // Fur reads as fur when it's thousands of fine strands that are dark at
  // the root and light at the tip, lying in clumps that share a direction,
  // lit from one side. Strands are batched by colour, so each colour is a
  // single stroke however many strands use it.
  const sprites = new Map();
  function sprite(key, w, h, paint) {
    let c = sprites.get(key);
    if (!c) {
      if (sprites.size > 64) sprites.clear();
      c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
      paint(c.getContext('2d'), c.width, c.height);
      sprites.set(key, c);
    }
    return c;
  }
  // smooth 2D value noise, 0..1 -- what makes neighbouring strands clump
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
    const h = (i, j) => hash(i * 127.1 + j * 311.7);
    const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * xf, b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * xf;
    return a + (b - a) * yf;
  }
  // paint fur into a 2D sprite. roots(k) -> [x, y] or null, flow(x, y) -> angle,
  // light(x, y) -> 0..1, palette dark..light. Drawn in layers, the under-layers
  // short and dark, the top ones long and light, the way real fur shades.
  function paintFur(g, n, roots, flow, light, len, palette, width) {
    const LAYERS = 4, P = palette.length, paths = palette.map(() => new Path2D());
    let k = 0;
    for (let layer = 0; layer < LAYERS; layer++) {
      for (let i = 0; i < n / LAYERS; i++, k++) {
        const r = roots(k * 1.618 + 0.5);
        if (!r) continue;
        const [x, y] = r;
        const clump = (noise(x * 0.06, y * 0.06) - 0.5) * 1.2;
        const a = flow(x, y) + clump + (hash(k * 9.7) - 0.5) * 0.35;
        const l = len * (0.55 + layer * 0.15) * (0.7 + hash(k * 3.1) * 0.6);
        const curl = (noise(x * 0.04 + 9, y * 0.04) - 0.5) * 0.9;
        const lit = clamp(light(x, y) * (0.55 + layer * 0.15) + (hash(k * 5.9) - 0.5) * 0.2, 0, 1);
        const c = Math.min(P - 1, Math.round(lit * (P - 1)));
        const mx = x + Math.cos(a) * l * 0.5, my = y + Math.sin(a) * l * 0.5;
        const tx = mx + Math.cos(a + curl) * l * 0.5, ty = my + Math.sin(a + curl) * l * 0.5;
        paths[Math.max(0, c - 2)].moveTo(x, y); paths[Math.max(0, c - 2)].lineTo(mx, my);   // the root, in shadow
        paths[c].moveTo(mx, my); paths[c].lineTo(tx, ty);                                   // the lit tip
      }
    }
    g.lineCap = 'round'; g.lineWidth = width;
    paths.forEach((p, i) => { g.strokeStyle = palette[i]; g.stroke(p); });
  }
  const BEAR = ['#160b05', '#24130a', '#341c0e', '#462713', '#5a3319', '#6e4022', '#83512d', '#9a6539', '#b27c4b', '#c8955f'];

  // the back of a big bear paw gripping the yoke: fur flowing up from the
  // wrist and fanning over four knuckles, claw tips curling over the top
  function pawSprite() {
    const R = 70;
    return sprite('paw3', R * 3, R * 3, (g, W) => {
      g.translate(W / 2, W / 2);
      g.fillStyle = BEAR[1]; g.beginPath(); g.ellipse(0, 0, R * 0.92, R * 0.82, 0, 0, Math.PI * 2); g.fill();
      const knuck = [0, 1, 2, 3].map(i => [(i - 1.5) * R * 0.42, -R * 0.6 + Math.abs(i - 1.5) * R * 0.1]);
      const inPaw = (k) => {
        const a = hash(k) * Math.PI * 2, q = Math.sqrt(hash(k * 1.7));
        return [Math.cos(a) * q * R * 0.95, Math.sin(a) * q * R * 0.85];
      };
      const flow = (x, y) => {
        // up from the wrist, curving out round the nearest knuckle
        let best = knuck[0], bd = 1e9;
        for (const kp of knuck) { const d = Math.hypot(x - kp[0], y - kp[1]); if (d < bd) { bd = d; best = kp; } }
        const up = Math.atan2(y - R * 1.4, x * 0.6);
        const out = Math.atan2(y - best[1], x - best[0]);
        const w = clamp(1 - bd / (R * 0.35), 0, 1);
        return up + (((out - up + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * w * 0.8;
      };
      const light = (x, y) => {   // a ball lit from above-left
        const nx = x / R, ny = y / R, nz = Math.sqrt(Math.max(0, 1 - nx * nx * 0.8 - ny * ny * 0.8));
        return clamp(0.25 + 0.75 * (nx * -0.4 + ny * -0.6 + nz * 0.7), 0, 1);
      };
      paintFur(g, 7000, inPaw, flow, light, R * 0.32, BEAR, 1.3);
      // the rim: strands sticking past the edge, for a soft silhouette
      paintFur(g, 1600, (k) => { const a = hash(k) * Math.PI * 2; return [Math.cos(a) * R * 0.88, Math.sin(a) * R * 0.78]; },
        (x, y) => Math.atan2(y, x) * 0.7 + flow(x, y) * 0.3, light, R * 0.36, BEAR, 1.2);
      for (const [kx, ky] of knuck) {
        g.fillStyle = '#ece2cf'; g.strokeStyle = '#4a3a28'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(kx - R * 0.07, ky - R * 0.12); g.quadraticCurveTo(kx - R * 0.04, ky - R * 0.38, kx + R * 0.04, ky - R * 0.42);
        g.quadraticCurveTo(kx + R * 0.02, ky - R * 0.2, kx + R * 0.07, ky - R * 0.12); g.closePath(); g.fill(); g.stroke();
      }
      // a few strands lying over the claws' roots
      paintFur(g, 500, (k) => { const kp = knuck[(hash(k) * 4) | 0], a = hash(k * 2.3) * Math.PI * 2; return [kp[0] + Math.cos(a) * R * 0.12, kp[1] + Math.sin(a) * R * 0.08]; },
        flow, light, R * 0.2, BEAR.slice(3), 1.1);
    });
  }
  function bearPaw(g, x, y, r, rot) {
    const c = pawSprite(), k = r / 70;
    g.save(); g.translate(x, y); g.rotate(rot || 0); g.scale(k, k); g.drawImage(c, -c.width / 2, -c.height / 2); g.restore();
  }
  // a forearm, drawn upright in a sprite: a tapered limb of fur lying up
  // towards the paw, rounded by its lighting, ragged at the edges
  function armSprite() {
    const W = 200, H = 380;
    return sprite('arm3', W, H, (g) => {
      const half = (y) => (0.27 + 0.1 * (y / H)) * W;   // narrower at the wrist (top)
      g.fillStyle = BEAR[1];
      g.beginPath(); g.moveTo(W / 2 - half(0) * 0.85, 20); g.lineTo(W / 2 + half(0) * 0.85, 20);
      g.lineTo(W / 2 + half(H) * 0.85, H); g.lineTo(W / 2 - half(H) * 0.85, H); g.closePath(); g.fill();
      const inArm = (k) => {
        const y = 20 + hash(k) * (H - 20), u = (hash(k * 1.9) * 2 - 1);
        return [W / 2 + u * half(y), y];
      };
      const off = (x, y) => (x - W / 2) / half(y);
      const flow = (x, y) => -Math.PI / 2 + off(x, y) * 0.55;
      const light = (x, y) => { const u = off(x, y); return clamp(0.85 - u * u * 0.7 - u * 0.25, 0, 1); };
      paintFur(g, 9000, inArm, flow, light, 34, BEAR, 1.4);
      paintFur(g, 1500, (k) => { const y = 20 + hash(k) * (H - 20), s = hash(k * 1.3) < 0.5 ? -1 : 1; return [W / 2 + s * half(y) * 0.95, y]; },
        (x, y) => -Math.PI / 2 + Math.sign(off(x, y)) * 0.9, light, 30, BEAR, 1.3);
    });
  }
  // the arm from (x0, y0) below to (x1, y1) at the wrist, w wide
  function bearArm(g, x0, y0, x1, y1, w) {
    const c = armSprite(), len = Math.hypot(x1 - x0, y1 - y0), a = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
    g.save(); g.translate(x0, y0); g.rotate(a); g.scale(w / (c.width * 0.6), len / (c.height - 20));
    g.drawImage(c, -c.width / 2, -c.height); g.restore();
  }

  // ── the fuzzy dice: real cubes, swinging on springy cords under gravity ──
  const PIPS = {
    1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };
  // cube faces: outward normal in local axes, and the pip count (opposites add to 7)
  const FACES = [[[1, 0, 0], 3], [[-1, 0, 0], 4], [[0, 1, 0], 5], [[0, -1, 0], 2], [[0, 0, 1], 6], [[0, 0, -1], 1]];
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
  };
  // R is a rotation as three column vectors; turn it by the small rotation vector w
  function rotate(R, w) {
    const ang = v3.len(w);
    if (ang < 1e-9) return R;
    const k = v3.mul(w, 1 / ang), c = Math.cos(ang), s = Math.sin(ang);
    const rot = (v) => v3.add(v3.add(v3.mul(v, c), v3.mul(v3.cross(k, v), s)), v3.mul(k, v3.dot(k, v) * (1 - c)));
    let [x, y] = [rot(R[0]), rot(R[1])];
    x = v3.mul(x, 1 / v3.len(x)); y = v3.sub(y, v3.mul(x, v3.dot(x, y))); y = v3.mul(y, 1 / v3.len(y));
    return [x, y, v3.cross(x, y)];
  }
  const local = (R, v) => v3.add(v3.add(v3.mul(R[0], v[0]), v3.mul(R[1], v[1])), v3.mul(R[2], v[2]));
  const faceAxes = (n) => { const a = Math.abs(n[1]) ? [1, 0, 0] : [0, 1, 0]; return [a, v3.cross(n, a)]; };

  // Each die's fur is a few thousand strands rooted all over its six faces,
  // in its own frame; every frame they're turned with the die and projected,
  // so the shag stands out round whatever silhouette it has right now.
  const STRANDS = 3600;
  function makeFur(seed) {
    const f = { root: new Float32Array(STRANDS * 3), dir: new Float32Array(STRANDS * 3), len: new Float32Array(STRANDS), pip: new Uint8Array(STRANDS) };
    for (let i = 0; i < STRANDS; i++) {
      const k = seed * 1000 + i * 1.618, [n, pips] = FACES[(hash(k) * 6) | 0], [a, b] = faceAxes(n);
      const u = hash(k * 1.37) - 0.5, v = hash(k * 2.11) - 0.5;
      for (let j = 0; j < 3; j++) f.root[i * 3 + j] = n[j] * 0.5 + a[j] * u + b[j] * v;
      // plush lies a little outward at the edges and corners, and clumps
      const ju = (noise(u * 7 + seed, v * 7) - 0.5) * 0.7 + u * 0.5, jv = (noise(u * 7, v * 7 + seed) - 0.5) * 0.7 + v * 0.5;
      const d = [n[0] + a[0] * ju + b[0] * jv, n[1] + a[1] * ju + b[1] * jv, n[2] + a[2] * ju + b[2] * jv], dl = v3.len(d);
      for (let j = 0; j < 3; j++) f.dir[i * 3 + j] = d[j] / dl;
      f.len[i] = 0.09 + hash(k * 3.7) * 0.08;
      f.pip[i] = PIPS[pips].some(([pu, pv]) => Math.hypot(u - pu * 0.27, v - pv * 0.27) < 0.1) ? 1 : 0;
    }
    return f;
  }
  const PINK = ['#5c0d36', '#7d1449', '#9d1d5c', '#bd2c71', '#d64288', '#e85c9d', '#f47bb1', '#fb9ac4', '#ffb9d7', '#ffd6e8'];
  const WHITE = ['#8a7d84', '#a3979d', '#bdb2b7', '#d3cacd', '#e6e0e2', '#f3eef0', '#fbf8f9', '#ffffff', '#ffffff', '#ffffff'];
  const LIGHT = (() => { const l = [0.35, 0.8, -0.5], m = Math.hypot(...l); return l.map(x => x / m); })();

  // the physics, in metres and seconds, in the car's own frame: the knot
  // under the mirror at the origin, y up, z away from us. Each cord is a
  // chain of little masses joined by springy links, so it stretches,
  // bounces and swings on its own; the die hangs off its end, and the
  // two dice knock into each other.
  const DIE = 0.07, CORDS = [0.11, 0.085], LINKS = 7;
  const CAM = [0, -0.16, -0.62];
  function makeDice() {
    return CORDS.map((L, i) => {
      const rope = [];
      for (let j = 0; j <= LINKS; j++) { const p = [(i ? -1 : 1) * (0.02 + 0.025 * j / LINKS), -L * j / LINKS, 0]; rope.push({ p, prev: p.slice() }); }   // the cord loops over the mirror's stem: its two ends a little apart
      const c = [(i ? -1 : 1) * 0.045, -L - DIE / 2, 0];
      return { rope, seg: L / LINKS, p: c, prev: c.slice(), R: rotate([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0.3, i ? -0.6 : 0.5, 0.1]), w: [0, 0, 0], fur: makeFur(i + 1) };
    });
  }
  function stepDice(dice, dt, acc, kick) {
    const move = (o, drag) => {
      const v = v3.mul(v3.sub(o.p, o.prev), drag);
      o.prev = o.p; o.p = v3.add(v3.add(o.p, v), v3.mul(acc, dt * dt));
    };
    for (const d of dice) {
      for (let j = 1; j <= LINKS; j++) move(d.rope[j], 0.985);
      move(d, 0.996);
      if (kick) d.w = v3.add(d.w, [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8]);
    }
    for (let it = 0; it < 10; it++) {
      for (const d of dice) {
        // springy links: only pull, and only part of the way each pass, so the cord stretches and rebounds
        for (let j = 1; j <= LINKS; j++) {
          const a = d.rope[j - 1], b = d.rope[j], ab = v3.sub(b.p, a.p), dist = v3.len(ab);
          if (dist <= d.seg || dist < 1e-9) continue;
          const fix = v3.mul(ab, (dist - d.seg) / dist * 0.5);
          if (j === 1) b.p = v3.sub(b.p, fix);
          else { a.p = v3.add(a.p, v3.mul(fix, 0.5)); b.p = v3.sub(b.p, v3.mul(fix, 0.5)); }
        }
        // springy, but only so far: no link stretches past a fifth over its length
        for (let j = 1; j <= LINKS; j++) {
          const a = d.rope[j - 1], b = d.rope[j], ab = v3.sub(b.p, a.p), dist = v3.len(ab), max = d.seg * 1.2;
          if (dist > max) b.p = v3.add(a.p, v3.mul(ab, max / dist));
        }
        // the die hangs from the cord's end by its top face: heavy, so it moves least
        const end = d.rope[LINKS], ec = v3.sub(d.p, end.p), dist = v3.len(ec), want = DIE / 2;
        if (dist > want && dist > 1e-9) {
          const fix = v3.mul(ec, (dist - want) / dist * 0.6);
          end.p = v3.add(end.p, v3.mul(fix, 0.8)); d.p = v3.sub(d.p, v3.mul(fix, 0.2));
        }
      }
      const [a, b] = dice, ab = v3.sub(b.p, a.p), dist = v3.len(ab), min = DIE * 1.25;
      if (dist < min && dist > 1e-6) {   // fur and all, they bump into each other
        const push = v3.mul(ab, (min - dist) / dist / 2);
        a.p = v3.sub(a.p, push); b.p = v3.add(b.p, push);
      }
    }
    for (const d of dice) {
      // the cord turns the die to hang from it; swinging sets it spinning
      const end = d.rope[LINKS].p, toCord = v3.sub(end, d.p), l = v3.len(toCord);
      const cord = l > 1e-6 ? v3.mul(toCord, 1 / l) : [0, 1, 0];
      const vel = v3.mul(v3.sub(d.p, d.prev), 1 / dt);
      let torque = v3.mul(v3.cross(d.R[1], cord), 45);
      torque = v3.add(torque, v3.mul(v3.cross(cord, vel), 6));
      d.w = v3.mul(v3.add(d.w, v3.mul(torque, dt)), 0.985);
      d.R = rotate(d.R, v3.mul(d.w, dt));
    }
  }
  // one die, its fur and all; proj maps a car-frame point to [x, y, depth]
  function drawDie(g, d, proj, px) {
    const f = d.fur, R = d.R, s = DIE, P = PINK.length;
    const toEye = (p) => v3.sub(p, CAM);
    // strands rooted on faces turned away go first (their tips make the far
    // silhouette), then the body, then the strands facing us
    const back = [PINK.map(() => new Path2D()), WHITE.map(() => new Path2D())];
    const front = [PINK.map(() => new Path2D()), WHITE.map(() => new Path2D())];
    const faceVis = FACES.map(([n]) => v3.dot(local(R, n), toEye(v3.add(d.p, v3.mul(local(R, n), s / 2)))) < 0);
    for (let i = 0; i < STRANDS; i++) {
      const r = [f.root[i * 3], f.root[i * 3 + 1], f.root[i * 3 + 2]], dv = [f.dir[i * 3], f.dir[i * 3 + 1], f.dir[i * 3 + 2]];
      const rw = v3.add(d.p, v3.mul(local(R, r), s)), dw = local(R, dv), l = f.len[i] * s;
      // which face it's rooted on: the largest component of its root
      const ax = Math.abs(r[0]) > Math.abs(r[1]) ? (Math.abs(r[0]) > Math.abs(r[2]) ? 0 : 2) : (Math.abs(r[1]) > Math.abs(r[2]) ? 1 : 2);
      const vis = faceVis[ax * 2 + (r[ax] > 0 ? 0 : 1)];
      const lit = clamp(0.2 + 0.8 * (0.5 + 0.5 * v3.dot(dw, LIGHT)), 0, 1);
      const c = Math.min(P - 1, Math.round(lit * (P - 1)));
      const a = proj(rw), m = proj(v3.add(rw, v3.mul(dw, l * 0.5))), t = proj(v3.add(rw, v3.add(v3.mul(dw, l), [0, -l * 0.15, 0])));
      const set = (vis ? front : back)[f.pip[i]];
      set[Math.max(0, c - 3)].moveTo(a[0], a[1]); set[Math.max(0, c - 3)].lineTo(m[0], m[1]);
      set[c].moveTo(m[0], m[1]); set[c].lineTo(t[0], t[1]);
    }
    const stroke = (sets) => sets.forEach((paths, w) => paths.forEach((p, i) => { g.strokeStyle = (w ? WHITE : PINK)[i]; g.stroke(p); }));
    g.lineCap = 'round'; g.lineWidth = Math.max(0.8, px * 0.022);
    stroke(back);
    // the body: the colour of the pile seen end-on, with the pips' white
    // patches, so the strands facing us read as dense plush, not gaps
    FACES.forEach(([n, pips], fi) => {
      if (!faceVis[fi]) return;
      const nw = local(R, n), [a, b] = faceAxes(n), ua = local(R, a), ub = local(R, b), fc = v3.add(d.p, v3.mul(nw, s * 0.56));
      const at = (i, j) => proj(v3.add(fc, v3.add(v3.mul(ua, i * s), v3.mul(ub, j * s))));
      const lit = clamp(0.5 + 0.5 * v3.dot(nw, LIGHT), 0, 1);
      g.fillStyle = PINK[3 + Math.round(lit * 4)];
      g.beginPath(); [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].forEach(([i, j], q) => { const p = at(i, j); q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
      g.closePath(); g.fill();
      g.fillStyle = WHITE[3 + Math.round(lit * 4)];
      for (const [pu, pv] of PIPS[pips]) {
        g.beginPath();
        for (let q = 0; q < 10; q++) { const ang = q / 10 * Math.PI * 2, p = at(pu * 0.27 + Math.cos(ang) * 0.09, pv * 0.27 + Math.sin(ang) * 0.09); q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
        g.closePath(); g.fill();
      }
    });
    g.lineWidth = Math.max(1, px * 0.03);
    stroke(front);
  }

  function bearEar(g, x, y, r) {
    g.fillStyle = '#7a4a2a'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e7a0a8'; g.beginPath(); g.arc(x, y + r * 0.1, r * 0.55, 0, Math.PI * 2); g.fill();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  viz.registerMode({
    id: 'joyride', label: 'Joyride',
    init() {
      st = fresh();
      // A / D steer, but only while Joyride is the one drawing
      const set = (e, down) => {
        if (performance.now() - lastDraw > 300) return;
        const a = document.activeElement;
        if (a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable)) return;
        if (e.code === 'KeyA') st.keys.left = down; else if (e.code === 'KeyD') st.keys.right = down; else return;
        st.lastKey = performance.now();
      };
      keyHandlers = { down: (e) => set(e, true), up: (e) => set(e, false) };
      document.addEventListener('keydown', keyHandlers.down);
      document.addEventListener('keyup', keyHandlers.up);
    },
    teardown() {
      if (keyHandlers) { document.removeEventListener('keydown', keyHandlers.down); document.removeEventListener('keyup', keyHandlers.up); }
      keyHandlers = null; echo = vid = null;
    },
    draw(ctx) {
      const { vctx, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale, videoFrame } = ctx;
      if (!st) st = fresh();
      lastDraw = performance.now();
      if (st.lastRot == null) st.lastRot = vizRot;
      const dRot = clamp(vizRot - st.lastRot, 0, 0.5); st.lastRot = vizRot;
      const bass = bassOf(freqData), energy = energyOf(freqData), t = vizRot, H = hueBase;
      st.bassAvg += (bass - st.bassAvg) * 0.12;
      let kicked = false;
      if (bass - st.bassAvg > 0.05 && st.kick < 0.5) { st.kick = 1; kicked = true; }
      st.kick *= 0.9;

      // ── driving ──
      const offRoad = Math.abs(st.playerX) > 1.05;
      const dz = dRot * 40 * (1 + energy * 1.5) * (offRoad ? 0.6 : 1);
      st.z += dz;
      const curv = curvAt(st.z);
      const manual = st.keys.left || st.keys.right || lastDraw - st.lastKey < 1500;
      const want = manual ? (st.keys.right ? 1 : 0) - (st.keys.left ? 1 : 0)
        : clamp(-st.playerX * 2 + curv * 160, -1, 1);   // the bear driving: hold the lane through the bends
      st.steer += (want - st.steer) * 0.15;
      st.playerX = clamp(st.playerX + st.steer * dz * 0.05 - curv * dz * 8, -3, 3);
      st.wheel += (st.steer * 0.7 + curv * 60 - st.wheel) * 0.2;
      st.heading += curv * dz + st.steer * dz * 0.002;
      // the camera rides a spring over the bumps under the wheels; potholes kick it
      const rough = (0.05 + energy * 0.1) * (offRoad ? 2 : 1);
      if (kicked) st.bobV -= 0.15;
      st.bobV += (bump(st.z) * rough - st.bob) * 0.3 - st.bobV * 0.22;
      st.bob += st.bobV;
      const roll = st.bobV * 0.03 - st.steer * 0.025 - curv * 4;
      // the dice feel gravity plus the car's own lurches: a jolt up throws them
      // up, the bends swing them out, speeding up leaves them behind
      const now = performance.now(), dt = clamp((now - (st.lastT || now)) / 1000, 0, 0.05) || 1 / 60; st.lastT = now;
      const lurch = [
        -(st.steer * 2.5 + curv * 400),
        -9.8 - (st.bobV - st.prevBobV) * 6 / dt,
        -(dz - st.prevDz) * 2 / dt,
      ];
      st.prevBobV = st.bobV; st.prevDz = dz;
      for (let i = 0; i < 2; i++) stepDice(st.dice, dt / 2, lurch, kicked && i === 0);
      if (kicked && st.floaters.length < 30) {
        st.floaters.push({ x: Math.random(), y: 0.15 + Math.random() * 0.35, r: 0, life: 1, hue: Math.random() * 360, kind: (Math.random() * 3) | 0 });
      }

      // now and then the driver glances out of the side window for a few seconds
      const ph = t % 8, look = ph < 1.6 ? smooth(clamp(ph / 0.4, 0, 1)) * smooth(clamp((1.6 - ph) / 0.4, 0, 1)) : 0;
      const pan = look * VW;

      const f = VH * 0.85 * vizUserScale, yH = cy - VH * 0.12;
      const x0 = -VW * 0.4, x1 = VW * 1.4;
      const wob = VH * 0.01 * (0.4 + energy * 2);

      vctx.save();
      vctx.translate(pan, 0);
      vctx.translate(cx, cy); vctx.rotate(roll); vctx.translate(-cx, -cy);

      // ── sky, sun, a melting rainbow ──
      const sky = vctx.createLinearGradient(0, yH - VH, 0, yH);
      sky.addColorStop(0, `hsl(${(H + 250) % 360 | 0},80%,14%)`);
      sky.addColorStop(0.7, `hsl(${(H + 300) % 360 | 0},85%,40%)`);
      sky.addColorStop(1, `hsl(${(H + 340) % 360 | 0},95%,62%)`);
      vctx.fillStyle = sky; vctx.fillRect(x0, yH - VH * 1.6, x1 - x0, VH * 2);
      vctx.save();
      vctx.shadowColor = `hsl(${(H + 50) % 360 | 0},100%,70%)`; vctx.shadowBlur = VH * (0.08 + bass * 0.1);
      vctx.beginPath(); vctx.arc(cx - Math.sin(st.heading) * VW, yH - VH * 0.1, VH * (0.08 + bass * 0.04), 0, Math.PI * 2);
      vctx.fillStyle = `hsl(${(H + 50) % 360 | 0},100%,78%)`; vctx.fill();
      vctx.restore();
      // seven bands, each one wobbling and dripping
      const rbX = cx - Math.sin(st.heading * 0.7) * VW * 0.8, rbR = VH * (0.42 + energy * 0.1);
      vctx.lineWidth = VH * 0.022; vctx.globalAlpha = 0.6;
      for (let b = 0; b < 7; b++) {
        vctx.strokeStyle = `hsl(${(b * 46 + H * 0.3) % 360 | 0},100%,60%)`;
        vctx.beginPath();
        for (let k = 0; k <= 48; k++) {
          const a = Math.PI + (k / 48) * Math.PI, r = rbR - b * VH * 0.022 + Math.sin(a * 6 + t * 3 + b) * wob;
          const px = rbX + Math.cos(a) * r, py = yH + Math.sin(a) * r + Math.max(0, Math.sin(k * 0.9 + t * 2)) * wob * 2;
          k ? vctx.lineTo(px, py) : vctx.moveTo(px, py);
        }
        vctx.stroke();
      }
      vctx.globalAlpha = 1;
      // things blooming in the sky on the kicks
      for (const fl of st.floaters) {
        fl.r += (1 - fl.r) * 0.08; fl.life -= 0.006; fl.y -= 0.0015; fl.x += Math.sin(t * 2 + fl.hue) * 0.001;
        const px = fl.x * VW, py = fl.y * VH, r = VH * 0.04 * fl.r * (1 + bass * 0.5);
        vctx.globalAlpha = clamp(fl.life * 1.5, 0, 1);
        if (fl.kind === 0) {          // flower
          for (let p = 0; p < 6; p++) {
            const pa = p / 6 * Math.PI * 2 + t;
            vctx.beginPath(); vctx.arc(px + Math.cos(pa) * r * 0.7, py + Math.sin(pa) * r * 0.7, r * 0.45, 0, Math.PI * 2);
            vctx.fillStyle = `hsl(${(fl.hue + p * 20) % 360 | 0},100%,65%)`; vctx.fill();
          }
          vctx.beginPath(); vctx.arc(px, py, r * 0.4, 0, Math.PI * 2); vctx.fillStyle = '#ffe14d'; vctx.fill();
        } else if (fl.kind === 1) {   // rainbow bubble
          vctx.lineWidth = r * 0.12;
          for (let b = 0; b < 4; b++) {
            vctx.beginPath(); vctx.arc(px, py, r * (1 - b * 0.18), 0, Math.PI * 2);
            vctx.strokeStyle = `hsl(${(fl.hue + b * 60) % 360 | 0},100%,65%)`; vctx.stroke();
          }
        } else {                      // smiling star
          vctx.beginPath();
          for (let p = 0; p < 10; p++) {
            const pa = p / 10 * Math.PI * 2 - Math.PI / 2 + t * 0.5, pr = p % 2 ? r * 0.45 : r;
            p ? vctx.lineTo(px + Math.cos(pa) * pr, py + Math.sin(pa) * pr) : vctx.moveTo(px + Math.cos(pa) * pr, py + Math.sin(pa) * pr);
          }
          vctx.closePath(); vctx.fillStyle = `hsl(${fl.hue | 0},100%,62%)`; vctx.fill();
          vctx.fillStyle = '#1a0b24';
          vctx.beginPath(); vctx.arc(px - r * 0.15, py - r * 0.05, r * 0.07, 0, Math.PI * 2); vctx.arc(px + r * 0.15, py - r * 0.05, r * 0.07, 0, Math.PI * 2); vctx.fill();
          vctx.beginPath(); vctx.arc(px, py + r * 0.05, r * 0.16, 0.2, Math.PI - 0.2); vctx.strokeStyle = '#1a0b24'; vctx.lineWidth = r * 0.05; vctx.stroke();
        }
      }
      vctx.globalAlpha = 1;
      st.floaters = st.floaters.filter(fl => fl.life > 0);

      // ── far mountains (the spectrum lifts them) and mid hills, in parallax ──
      const ridge = (off, yH, amp, lift, hue, light, k, spec) => {
        vctx.beginPath(); vctx.moveTo(x0, yH + VH * 0.05);
        for (let x = x0; x <= x1; x += VW / 60) {
          const u = (x + off) / VW;
          let h = (Math.sin(u * 5 * k) * 0.5 + Math.sin(u * 13 * k + 1) * 0.25 + 0.8) * amp;
          if (spec) h += (freqData[2 + Math.abs((u * 40) | 0) % 48] || 0) / 255 * amp * 0.6;
          vctx.lineTo(x, yH - lift - h + Math.sin(x * 0.02 + t * 2) * wob * 0.5);
        }
        vctx.lineTo(x1, yH + VH * 0.05); vctx.closePath();
        const g = vctx.createLinearGradient(0, yH - lift - amp * 1.6, 0, yH);
        g.addColorStop(0, `hsl(${(H + hue) % 360 | 0},90%,${light + 15}%)`);
        g.addColorStop(1, `hsl(${(H + hue + 60) % 360 | 0},80%,${light}%)`);
        vctx.fillStyle = g; vctx.fill();
      };
      ridge(st.heading * VW * 0.3, yH, VH * 0.14, VH * 0.02, 260, 30, 1, true);
      ridge(st.heading * VW * 0.8, yH, VH * 0.07, -VH * 0.01, 160, 22, 1.7, false);

      // ── the road and the fields, segment by segment (pseudo-3D racer) ──
      const camY = hill(st.z) + CAM_H + st.bob;
      const base = Math.floor(st.z / SEG) * SEG, pts = new Array(N + 1);
      let x = -st.playerX * ROADW, dx = 0;
      for (let i = 0; i <= N; i++) {
        const s = base + i * SEG, d = s - st.z;
        // the road's bumps show up close, where they're under the wheels next
        const e = hill(s) + bump(s) * (0.04 + energy * 0.08) * Math.max(0, 1 - d / 40);
        x += dx; dx += curvAt(s) * SEG;
        if (d < 0.35) { pts[i] = null; continue; }
        const sc = f / d;
        pts[i] = { s, d, sc, sx: cx + x * sc + Math.sin(d * 0.2 - t * 4) * wob * Math.min(1, d / 10), sy: yH + (camY - e) * sc, seg: Math.round(s / SEG) };
      }
      const quad = (n, fa, a, b) => {   // trapezoid between two road points, a..b world units from the centre line
        vctx.beginPath();
        vctx.moveTo(n.sx + a * n.sc, n.sy); vctx.lineTo(n.sx + b * n.sc, n.sy);
        vctx.lineTo(fa.sx + b * fa.sc, fa.sy); vctx.lineTo(fa.sx + a * fa.sc, fa.sy); vctx.closePath(); vctx.fill();
      };
      for (let i = N; i >= 1; i--) {
        const n = pts[i - 1], fa = pts[i];
        if (!n || !fa || n.sy <= fa.sy) continue;   // the far side of a crest
        const par = n.seg & 1, fog = Math.min(1, n.d / (N * SEG)), hs = (H + n.s * 3) % 360;
        // the field: full width, then a checkerboard of crop bands up close
        vctx.fillStyle = `hsl(${hs | 0},85%,${(par ? 32 : 40) + fog * 22 | 0}%)`;
        vctx.fillRect(x0, fa.sy, x1 - x0, n.sy - fa.sy + 1);
        if (n.d < TEXTURE_D) {
          for (let b = 0; b < BANDS; b++) {
            if ((b + (n.seg >> 1)) & 1) continue;
            const a = ROADW * 1.3 + b * BAND;
            vctx.fillStyle = `hsl(${(hs + 40 + b * 28) % 360 | 0},95%,${(par ? 48 : 56) + fog * 15 | 0}%)`;
            quad(n, fa, a, a + BAND); quad(n, fa, -a - BAND, -a);
          }
        }
        // the road, its rumble strips, the centre line
        vctx.fillStyle = `hsl(${(hs + 180) % 360 | 0},40%,${(par ? 14 : 19) + fog * 30 | 0}%)`; quad(n, fa, -ROADW, ROADW);
        vctx.fillStyle = par ? '#fff' : `hsl(${(hs + 90) % 360 | 0},100%,55%)`;
        quad(n, fa, -ROADW * 1.15, -ROADW); quad(n, fa, ROADW, ROADW * 1.15);
        if ((n.seg >> 1) & 1) { vctx.fillStyle = `hsl(${(hs + 60) % 360 | 0},100%,72%)`; quad(n, fa, -0.08, 0.08); }
        // a tree (or now and then a mushroom) stands every so often, drawn
        // now so the nearer ground still covers it
        if (n.seg % 12 === 0) {
          for (const side of [-1, 1]) {
            const r = hash(n.seg * 1.3 + side);
            if (r > 0.55) continue;
            const wx = side * (ROADW * 1.6 + 1.5 + hash(n.seg * 7.7 + side) * 9);
            const px = n.sx + wx * n.sc, sz = n.sc * (2.2 + r * 1.6) * (1 + bass * 0.15);
            if (px < x0 || px > x1 || sz < 2) continue;
            vctx.globalAlpha = clamp(1.4 - fog * 1.4, 0, 1);
            const hue = (H + hash(n.seg * 3.3 + side) * 360 + t * 20) % 360;
            if (r < 0.1) mushroom(vctx, px, n.sy, sz * 0.6, hue);
            else tree(vctx, px, n.sy, sz, hue, Math.sin(t * 3 + n.seg) * sz * 0.05 * (1 + bass * 3));
            vctx.globalAlpha = 1;
          }
        }
      }
      vctx.restore();

      // ── the view out of the driver's side window, slid in from the left as the head turns ──
      if (look > 0.001) {
        vctx.save(); vctx.translate(pan - VW, 0);
        vctx.beginPath(); vctx.rect(0, 0, VW, VH); vctx.clip();
        const yS = VH * 0.36 - st.bob * VH * 0.02, camS = CAM_H + st.bob * 0.3, cxS = VW / 2, carX = st.playerX * ROADW;
        const sg = vctx.createLinearGradient(0, 0, 0, yS);
        sg.addColorStop(0, `hsl(${(H + 250) % 360 | 0},80%,14%)`);
        sg.addColorStop(0.7, `hsl(${(H + 300) % 360 | 0},85%,40%)`);
        sg.addColorStop(1, `hsl(${(H + 340) % 360 | 0},95%,62%)`);
        vctx.fillStyle = sg; vctx.fillRect(x0, -10, x1 - x0, yS + 12);
        // the same mountains and hills, sliding past at their own speeds
        ridge(st.heading * VW * 0.3 + st.z * VW * 0.003, yS, VH * 0.14, VH * 0.02, 260, 30, 1, true);
        ridge(st.heading * VW * 0.8 + st.z * VW * 0.015, yS, VH * 0.07, -VH * 0.01, 160, 22, 1.7, false);
        vctx.fillStyle = `hsl(${(H + st.z * 3) % 360 | 0},85%,36%)`; vctx.fillRect(x0, yS, x1 - x0, VH);
        // the fields: the same crop bands, now streaming past side-on
        const C = 3, sx = (sv, D) => cxS + (sv - st.z) * f / D;
        for (let b = BANDS - 1; b >= -1; b--) {
          const a1 = b < 0 ? ROADW : ROADW * 1.3 + b * BAND, a2 = b < 0 ? ROADW * 1.3 : a1 + BAND;
          const D1 = a1 + carX, D2 = a2 + carX;
          if (D1 < 0.6) continue;
          const yN = yS + camS * f / D1, yF = yS + camS * f / D2;
          if (b < 0) { vctx.fillStyle = `hsl(${(H + 180) % 360 | 0},40%,16%)`; vctx.fillRect(x0, yN, x1 - x0, VH); }
          const kLo = Math.floor((st.z + (x0 - cxS) * D2 / f) / C), kHi = Math.ceil((st.z + (x1 - cxS) * D2 / f) / C);
          for (let k = kLo; k <= kHi; k++) {
            if (b >= 0 && (k + b) & 1) continue;
            vctx.fillStyle = b < 0 ? (k & 1 ? '#fff' : `hsl(${(H + k * 9 + 90) % 360 | 0},100%,55%)`)
              : `hsl(${(H + k * 9 + 40 + b * 28) % 360 | 0},95%,52%)`;
            vctx.beginPath();
            vctx.moveTo(sx(k * C, D1), yN); vctx.lineTo(sx(k * C + C, D1), yN);
            vctx.lineTo(sx(k * C + C, D2), yF); vctx.lineTo(sx(k * C, D2), yF); vctx.closePath(); vctx.fill();
          }
        }
        // the left-hand trees, whipping by
        const trees = [];
        for (let seg = Math.ceil((st.z - 80) / SEG / 12) * 12; seg * SEG <= st.z + 80; seg += 12) {
          const r = hash(seg * 1.3 - 1);
          if (r > 0.55) continue;
          const D = ROADW * 1.6 + 1.5 + hash(seg * 7.7 - 1) * 9 + carX;
          if (D > 1) trees.push({ seg, r, D });
        }
        trees.sort((p, q) => q.D - p.D);
        for (const tr of trees) {
          const sc = f / tr.D, px = sx(tr.seg * SEG, tr.D), py = yS + camS * sc, sz = sc * (2.2 + tr.r * 1.6) * (1 + bass * 0.15);
          if (px < x0 - sz || px > x1 + sz) continue;
          const hue = (H + hash(tr.seg * 3.3 - 1) * 360 + t * 20) % 360;
          if (tr.r < 0.1) mushroom(vctx, px, py, sz * 0.6, hue);
          else tree(vctx, px, py, sz, hue, Math.sin(t * 3 + tr.seg) * sz * 0.05 * (1 + bass * 3));
        }
        vctx.restore();
      }

      // ── melting: last frame's world, dripping down in strips, screened back on ──
      const cw = vctx.canvas.width, ch = vctx.canvas.height;
      if (!echo || echo.c.width !== cw || echo.c.height !== ch) {
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        echo = { c, g: c.getContext('2d'), primed: false };
      }
      vctx.save();
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      if (echo.primed) {
        vctx.globalAlpha = 0.42; vctx.globalCompositeOperation = 'screen';
        const strips = 40, sw = cw / strips, drip = ch * 0.006 * (1 + energy * 5);
        for (let i = 0; i < strips; i++) {
          const dy = drip * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.7 + t * 1.5)));
          const sx = Math.round(i * sw), w = Math.round((i + 1) * sw) - sx;   // no overlap, or the seams screen twice
          vctx.drawImage(echo.c, sx, 0, w, ch, sx, dy, w, ch * 1.01);
        }
      }
      vctx.restore();
      echo.g.clearRect(0, 0, cw, ch); echo.g.drawImage(vctx.canvas, 0, 0); echo.primed = true;

      // ── the car: a future cockpit, shaking with the road ──
      vctx.save(); vctx.translate(pan, 0);
      const jy = st.bob * VH * 0.025, S = Math.min(VW, VH), neon = `hsl(${(H + 300) % 360 | 0},100%,62%)`;
      // roof and slim pillars
      vctx.fillStyle = '#0a0612';
      vctx.beginPath();
      vctx.moveTo(-10, -10); vctx.lineTo(VW + 10, -10); vctx.lineTo(VW + 10, VH * 0.8 + jy);
      vctx.quadraticCurveTo(VW * 0.97, VH * 0.2 + jy, VW * 0.88, VH * 0.05 + jy);
      vctx.quadraticCurveTo(cx, VH * 0.02 + jy, VW * 0.12, VH * 0.05 + jy);
      vctx.quadraticCurveTo(VW * 0.03, VH * 0.2 + jy, -10, VH * 0.8 + jy);
      vctx.closePath(); vctx.fill();
      vctx.strokeStyle = neon; vctx.lineWidth = Math.max(1.5, S * 0.004); vctx.globalAlpha = 0.5 + st.kick * 0.5; vctx.stroke(); vctx.globalAlpha = 1;
      // dashboard: a glossy sweep with a light strip along it
      const dashY = VH * 0.86 + jy;
      const dg = vctx.createLinearGradient(0, dashY - VH * 0.05, 0, VH);
      dg.addColorStop(0, '#2a2140'); dg.addColorStop(0.25, '#120c1e'); dg.addColorStop(1, '#05030a');
      vctx.fillStyle = dg;
      vctx.beginPath(); vctx.moveTo(-10, VH + 10); vctx.lineTo(-10, dashY + VH * 0.02);
      vctx.bezierCurveTo(VW * 0.3, dashY - VH * 0.07, VW * 0.7, dashY - VH * 0.07, VW + 10, dashY + VH * 0.02);
      vctx.lineTo(VW + 10, VH + 10); vctx.closePath(); vctx.fill();
      vctx.beginPath(); vctx.moveTo(VW * 0.02, dashY + VH * 0.015);
      vctx.bezierCurveTo(VW * 0.3, dashY - VH * 0.055, VW * 0.7, dashY - VH * 0.055, VW * 0.98, dashY + VH * 0.015);
      vctx.strokeStyle = neon; vctx.lineWidth = Math.max(2, S * 0.006); vctx.shadowColor = neon; vctx.shadowBlur = S * 0.02; vctx.stroke(); vctx.shadowBlur = 0;
      // holographic HUD: the spectrum and the speed, floating over the dash
      const hudW = VW * 0.16, hudX = cx + VW * 0.24, hudY = dashY - VH * 0.09;
      vctx.globalAlpha = 0.7;
      for (let b = 0; b < 16; b++) {
        const v = (freqData[2 + b * 3] || 0) / 255;
        vctx.fillStyle = `hsl(${(180 + b * 8 + H * 0.2) % 360 | 0},100%,65%)`;
        vctx.fillRect(hudX + b * hudW / 16, hudY - v * VH * 0.06, hudW / 16 - 2, v * VH * 0.06 + 1);
      }
      vctx.font = `700 ${Math.round(S * 0.035)}px "Courier New", monospace`; vctx.textAlign = 'left'; vctx.textBaseline = 'alphabetic';
      vctx.fillStyle = `hsl(${(H + 160) % 360 | 0},100%,70%)`;
      vctx.fillText(`${Math.round(40 * (1 + energy * 1.5) * (offRoad ? 0.6 : 1))} mph`, hudX, hudY - VH * 0.075);
      vctx.globalAlpha = 1;
      // the steering column and yoke right in front of us, our own bear paws on the grips
      const yx = cx, yy = VH * 0.94 + jy, yw = S * 0.44;
      vctx.fillStyle = '#1c1530'; vctx.beginPath();
      vctx.moveTo(yx - yw * 0.08, VH + 10); vctx.lineTo(yx - yw * 0.05, yy); vctx.lineTo(yx + yw * 0.05, yy); vctx.lineTo(yx + yw * 0.08, VH + 10); vctx.fill();
      vctx.save(); vctx.translate(yx, yy); vctx.rotate(st.wheel);
      vctx.lineCap = 'round'; vctx.strokeStyle = '#2b2245'; vctx.lineWidth = yw * 0.1;
      vctx.beginPath(); vctx.moveTo(-yw / 2, -yw * 0.22); vctx.lineTo(-yw / 2, yw * 0.05); vctx.lineTo(yw / 2, yw * 0.05); vctx.lineTo(yw / 2, -yw * 0.22); vctx.stroke();
      vctx.strokeStyle = neon; vctx.lineWidth = yw * 0.018; vctx.shadowColor = neon; vctx.shadowBlur = S * 0.015; vctx.stroke(); vctx.shadowBlur = 0;
      roundRect(vctx, -yw * 0.14, -yw * 0.04, yw * 0.28, yw * 0.14, yw * 0.04); vctx.fillStyle = '#120c1e'; vctx.fill();
      vctx.fillStyle = `hsl(${(H + 180) % 360 | 0},100%,60%)`; vctx.beginPath(); vctx.arc(0, yw * 0.03, yw * 0.03 * (1 + bass), 0, Math.PI * 2); vctx.fill();
      vctx.restore();
      // our arms, coming up from below, and big shaggy paws on the grips
      const pr = yw * 0.21, cw0 = Math.cos(st.wheel), sw0 = Math.sin(st.wheel);
      for (const side of [-1, 1]) {
        const gx = yx + cw0 * side * yw / 2 - sw0 * -yw * 0.12, gy = yy + sw0 * side * yw / 2 + cw0 * -yw * 0.12;
        bearArm(vctx, gx + side * VW * 0.14, VH + pr * 1.6, gx + side * pr * 0.1, gy + pr * 0.35, pr * 2);
        bearPaw(vctx, gx, gy, pr, st.wheel * 0.6);
      }

      // the big rear-view mirror, centred, the video in it (flipped, as mirrors are)
      const mw = VW * 0.4, mh = Math.min(mw / 3.2, VH * 0.17), mx = cx - mw / 2, my = VH * 0.06 + jy * 0.6;
      vctx.fillStyle = '#1c1530'; vctx.fillRect(cx - S * 0.012, 0, S * 0.024, my + 2);
      const rim = vctx.createLinearGradient(0, my, 0, my + mh);
      rim.addColorStop(0, '#e9e6f5'); rim.addColorStop(0.5, '#6a6680'); rim.addColorStop(1, '#cfcbe0');
      roundRect(vctx, mx - 6, my - 6, mw + 12, mh + 12, mh * 0.28); vctx.fillStyle = rim; vctx.fill();
      vctx.save();
      roundRect(vctx, mx, my, mw, mh, mh * 0.24); vctx.clip();
      if (videoFrame) {
        if (!vid || vid.c.width !== videoFrame.w || vid.c.height !== videoFrame.h) {
          const c = document.createElement('canvas'); c.width = videoFrame.w; c.height = videoFrame.h;
          vid = { c, g: c.getContext('2d') };
        }
        vid.g.putImageData(videoFrame.imageData, 0, 0);
        const a = videoFrame.w / videoFrame.h, dh = Math.max(mh, mw / a), dw = dh * a;
        vctx.save(); vctx.translate(cx, my + mh / 2); vctx.scale(-1, 1);
        vctx.drawImage(vid.c, -dw / 2, -dh / 2, dw, dh);
        vctx.restore();
      } else {
        const mg = vctx.createLinearGradient(mx, 0, mx + mw, 0);
        mg.addColorStop(0, `hsl(${(H + 200) % 360 | 0},70%,35%)`); mg.addColorStop(1, `hsl(${(H + 280) % 360 | 0},70%,30%)`);
        vctx.fillStyle = mg; vctx.fillRect(mx, my, mw, mh);
      }
      // reflected in it: just the tops of the bears' ears, bobbing along
      const er = mh * 0.17, ey = my + mh + er * 0.35 - Math.abs(st.bob) * mh * 0.2;
      bearEar(vctx, mx + mw * 0.2, ey, er); bearEar(vctx, mx + mw * 0.34, ey + er * 0.1, er);
      bearEar(vctx, mx + mw * 0.66, ey + er * 0.05, er); bearEar(vctx, mx + mw * 0.8, ey, er);
      vctx.globalAlpha = 0.18; vctx.fillStyle = '#fff';   // glare
      vctx.beginPath(); vctx.moveTo(mx + mw * 0.1, my); vctx.lineTo(mx + mw * 0.22, my); vctx.lineTo(mx + mw * 0.12, my + mh); vctx.lineTo(mx, my + mh); vctx.fill();
      vctx.globalAlpha = 1;
      vctx.restore();

      // one pair of pink fuzzy dice, hanging off the mirror on a cord
      const ax = cx, ay = my + mh + 6, F = S * 0.085 * -CAM[2] / DIE;
      const proj = (p) => { const z = p[2] - CAM[2]; return [ax + p[0] * F / z, ay - (p[1] - CAM[1]) * F / z - CAM[1] * F / -CAM[2], z]; };
      const px = S * 0.085;   // a die's width on screen, roughly
      const order = st.dice.slice().sort((p, q) => q.p[2] - p.p[2]);
      for (const d of order) {
        // the cord: a smooth curve through its links, to the top of the die
        const pts = d.rope.map(r => proj(r.p));
        vctx.strokeStyle = '#f4f0e8'; vctx.lineWidth = Math.max(1, S * 0.0035); vctx.lineCap = 'round';
        vctx.beginPath(); vctx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length - 1; j++) vctx.quadraticCurveTo(pts[j][0], pts[j][1], (pts[j][0] + pts[j + 1][0]) / 2, (pts[j][1] + pts[j + 1][1]) / 2);
        const last = pts[pts.length - 1]; vctx.lineTo(last[0], last[1]); vctx.stroke();
        drawDie(vctx, d, proj, px);
      }

      // the driver's door, round the side window, for when we glance out of it
      if (look > 0.001) {
        const ox = -VW, wx = ox + VW * 0.08, wy = VH * 0.08 + jy, ww = VW * 0.8, wh = VH * 0.56, r = VH * 0.1;
        vctx.beginPath();
        vctx.rect(ox - 10, -10, VW + 10, VH + 20);
        vctx.moveTo(wx + r, wy); vctx.arcTo(wx + ww, wy, wx + ww, wy + wh, r); vctx.arcTo(wx + ww, wy + wh, wx, wy + wh, r * 0.3);
        vctx.arcTo(wx, wy + wh, wx, wy, r * 0.3); vctx.arcTo(wx, wy, wx + ww, wy, r); vctx.closePath();
        vctx.fillStyle = '#0a0612'; vctx.fill('evenodd');
        vctx.strokeStyle = neon; vctx.lineWidth = Math.max(2, S * 0.005); vctx.stroke();
        const pg = vctx.createLinearGradient(0, VH * 0.7, 0, VH);
        pg.addColorStop(0, '#2a2140'); pg.addColorStop(1, '#07040c');
        vctx.fillStyle = pg; vctx.fillRect(ox, VH * 0.7 + jy, VW, VH * 0.3);
        roundRect(vctx, ox + VW * 0.15, VH * 0.76 + jy, VW * 0.55, VH * 0.05, VH * 0.025); vctx.fillStyle = '#3a2f58'; vctx.fill();
        vctx.beginPath(); vctx.moveTo(ox + VW * 0.05, VH * 0.72 + jy); vctx.lineTo(ox + VW * 0.95, VH * 0.72 + jy);
        vctx.shadowColor = neon; vctx.shadowBlur = S * 0.02; vctx.stroke(); vctx.shadowBlur = 0;
        // the wing mirror, just outside the glass, with the video in it too (flipped)
        const gx = wx + ww * 0.74, gy = wy + wh * 0.56, gw = ww * 0.22, gh = wh * 0.3;
        roundRect(vctx, gx - 6, gy - 6, gw + 12, gh + 12, gh * 0.22); vctx.fillStyle = '#1c1530'; vctx.fill();
        vctx.save();
        roundRect(vctx, gx, gy, gw, gh, gh * 0.18); vctx.clip();
        if (videoFrame && vid) {
          const a = videoFrame.w / videoFrame.h, dh = Math.max(gh, gw / a), dw = dh * a;
          vctx.save(); vctx.translate(gx + gw / 2, gy + gh / 2); vctx.scale(-1, 1);
          vctx.drawImage(vid.c, -dw / 2, -dh / 2, dw, dh);
          vctx.restore();
        } else {
          const wg = vctx.createLinearGradient(0, gy, 0, gy + gh);
          wg.addColorStop(0, `hsl(${(H + 300) % 360 | 0},80%,55%)`); wg.addColorStop(1, `hsl(${(H + 40) % 360 | 0},90%,45%)`);
          vctx.fillStyle = wg; vctx.fillRect(gx, gy, gw, gh);
        }
        vctx.globalAlpha = 0.18; vctx.fillStyle = '#fff';   // glare
        vctx.beginPath(); vctx.moveTo(gx + gw * 0.15, gy); vctx.lineTo(gx + gw * 0.32, gy); vctx.lineTo(gx + gw * 0.17, gy + gh); vctx.lineTo(gx, gy + gh); vctx.fill();
        vctx.restore();
      }
      vctx.restore();
    },
  });
})();
