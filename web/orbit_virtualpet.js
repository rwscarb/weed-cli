'use strict';
// Virtual Pet: an Orbit Visualizer mode (plugin API only -- see
// orbit_visualizer.js's registry comments). 1997, a bedroom desk, and
// it's 3:33 AM. A see-through plastic keychain egg stands propped up in
// the glow of a CRT that's still playing the video, a red alarm clock
// stuck on the wrong side of midnight, glow-in-the-dark stars on the
// wall. On the LCD a little creature hatches, dances to the music (it
// hops on every kick), gets hungry, poops, grows up, grows old and dies,
// and its ghost floats up off the top of the screen. Then a new egg.
// The post-it on the desk keeps count, and every time one dies the clock
// moves on a minute and never gets any closer to morning.
// A feeds it, B flushes the mess away, C shows its stats. It dies anyway.
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

  // ── the LCD: 32 x 16 dots, and the sprites that live on it ─────────
  const LW = 32, LH = 16;
  const spr = (rows) => ({ w: rows[0].length, h: rows.length, rows });
  const SPR = {
    egg: spr(['..####..', '.#....#.', '#......#', '#.#..#.#', '#......#', '#..##..#', '#......#', '#......#', '.#....#.', '..####..']),
    crack: spr(['........', '........', '........', '........', '.#.#.#..', '#.#.#.##', '........', '........', '........', '........']),
    baby: spr(['..###..', '.#####.', '##.#.##', '#######', '##...##', '.#####.']),
    child: spr(['.######.', '#......#', '#.#..#.#', '#......#', '#..##..#', '#......#', '.######.', '.#....#.']),
    teen: spr(['....#.....', '.....#....', '..######..', '.#......#.', '#..#..#..#', '#........#', '#...##...#', '.#......#.', '..######..', '..#....#..']),
    adult: spr(['...######...', '..#......#..', '.#........#.', '.#.##..##.#.', '.#........#.', '.#..####..#.', '##...##...##', '#.#......#.#', '..#......#..', '..#......#..', '...######...', '...#....#...']),
    senior: spr(['..######....', '.#......#.##', '#.##..##.#.#', '#........#.#', '#..#..#..#.#', '#........#.#', '.#..##..#..#', '..#....#...#', '..#....#...#', '...####....#', '...#..#....#']),
    down: spr(['.##########.', '#..........#', '#.#.#..#.#.#', '#..#....#..#', '#.#.#..#.#.#', '.##########.']),
    ghost: spr(['..#####..', '.........', '..#####..', '.#.....#.', '#..#.#..#', '#.......#', '#...#...#', '#.......#', '#.#.#.#.#', '.#.#.#.#.']),
    grave: spr(['...####...', '..#....#..', '.#..##..#.', '.#.####.#.', '.#..##..#.', '.#..##..#.', '.#......#.', '.#......#.', '##########']),
    poop: spr(['..#..', '.#.#.', '.###.', '#.#.#', '#####']),
    stink: spr(['#..', '.#.', '#..']),
    food: spr(['.###.', '#####', '#####', '.###.', '..#..']),
    heart: spr(['.#.#.', '#####', '#####', '.###.', '..#..']),
    hollow: spr(['.#.#.', '#.#.#', '#...#', '.#.#.', '..#..']),
    note: spr(['.##', '.#.', '.#.', '##.']),
    skull: spr(['.###.', '#.#.#', '#####', '.#.#.']),
  };
  // a 3x5 font, just the letters the status pages and the epitaph need
  const FONT = {
    0: '###,#.#,#.#,#.#,###', 1: '.#.,##.,.#.,.#.,###', 2: '##.,..#,.#.,#..,###', 3: '##.,..#,.#.,..#,##.',
    4: '#.#,#.#,###,..#,..#', 5: '###,#..,##.,..#,##.', 6: '.##,#..,###,#.#,###', 7: '###,..#,.#.,.#.,.#.',
    8: '###,#.#,###,#.#,###', 9: '###,#.#,###,..#,##.', A: '.#.,#.#,###,#.#,#.#', E: '###,#..,##.,#..,###',
    G: '.##,#..,#.#,#.#,.##', N: '#.#,###,###,#.#,#.#', H: '#.#,#.#,###,#.#,#.#', U: '#.#,#.#,#.#,#.#,###',
    R: '##.,#.#,##.,#.#,#.#', I: '###,.#.,.#.,.#.,###', P: '##.,#.#,##.,#..,#..', ' ': '...,...,...,...,...',
  };

  // a creature's whole life is measured in frames at Speed 1. Stages end
  // at these fractions of its (randomly allotted) span.
  const LIFE = 9600, HUNGER_STEP = 1100, POOP_STEP = 1100, STARVE = 1500, FILTH = 1500, SICK = 1800;
  const STAGES = [['egg', 0.05], ['baby', 0.15], ['child', 0.32], ['teen', 0.52], ['adult', 0.82], ['senior', 1]];
  const DIE_FLAT = 300, DIE_GHOST = 1300, DIE_GRAVE = 2500, DIE_END = 2800;
  const DEATHS0 = 13;   // it was never the first one
  let st = null, vid = null, noise = null, stars = null, keyHandlers = null, lastDraw = 0;

  function newLife(gen) {
    return {
      gen, age: 0, span: LIFE * (0.75 + Math.random() * 0.5), hunger: 4, hungerT: 0, starving: 0,
      poops: [], poopT: 0, filthy: 0, sick: false, sickT: 0, x: 12, dir: 1, walkT: 0, jump: 0,
      dead: false, deadT: 0, action: null, statusT: 0, statusAt: 1400 + Math.random() * 600,
    };
  }
  function fresh() {
    return {
      t: 0, lastRot: null, lastT: 0, floor: 0, ceil: 0, armed: true, kickCool: 0, beats: 0,
      deaths: DEATHS0, life: newLife(DEATHS0 + 1), disp: new Float32Array(LW * LH), tgt: new Uint8Array(LW * LH),
      shake: 0, notes: [], press: [0, 0, 0], queue: [], vidRGB: [70, 110, 190],
    };
  }
  function stageOf(L) {
    const f = L.age / L.span;
    for (const [name, end] of STAGES) if (f < end) return name;
    return 'senior';
  }

  // ── drawing into the LCD's bitmap ──────────────────────────────────
  function blit(tgt, s, x, y, flip) {
    x = Math.round(x); y = Math.round(y);
    for (let r = 0; r < s.h; r++) {
      const py = y + r; if (py < 0 || py >= LH) continue;
      const row = s.rows[r];
      for (let c = 0; c < s.w; c++) {
        if (row[flip ? s.w - 1 - c : c] !== '#') continue;
        const px = x + c; if (px >= 0 && px < LW) tgt[py * LW + px] = 1;
      }
    }
  }
  function text(tgt, str, x, y) {
    for (const ch of String(str)) {
      const g = FONT[ch];
      if (g) blit(tgt, spr(g.split(',')), x, y);
      x += 4;
    }
  }

  // one step of the creature's life, and the frame of it that's on the LCD
  function live(L, k, kicked, mids) {
    const tgt = st.tgt; tgt.fill(0);
    if (L.dead) {
      L.deadT += k;
      const d = L.deadT, bx = clamp(L.x, 0, LW - 12);
      if (d < DIE_FLAT) {
        if ((d / 40 | 0) % 2 === 0 || d > DIE_FLAT * 0.6) blit(tgt, SPR.down, bx, LH - SPR.down.h);
      } else if (d < DIE_GHOST) {
        const p = (d - DIE_FLAT) / (DIE_GHOST - DIE_FLAT);
        if (hash(Math.floor(d / 6)) > p * 1.2) blit(tgt, SPR.down, bx, LH - SPR.down.h);   // the body, flickering out
        const gy = LH - SPR.ghost.h - p * (LH + 4), gx = bx + 1 + Math.sin(d * 0.03) * 2.5;
        blit(tgt, SPR.ghost, gx, gy);
      } else if (d < DIE_GRAVE) {
        if (!L.counted) { L.counted = true; st.deaths++; }
        blit(tgt, SPR.grave, 11, LH - SPR.grave.h - 1);
        for (let x = 4; x < 28; x++) if ((x + (d / 30 | 0)) % 3) tgt[(LH - 1) * LW + x] = 1;
      } else if (d < DIE_END) {
        text(tgt, 'GEN ' + (st.deaths + 1), 4, 5);
      } else {
        st.life = newLife(st.deaths + 1);
      }
      return;
    }

    L.age += k;
    const stage = stageOf(L);
    if (stage === 'egg') {
      const crack = L.age > L.span * 0.035, wob = kicked ? (st.beats % 2 ? 1 : -1) : 0;
      L.wob = kicked ? wob : (L.wob || 0) * 0.9;
      const ex = 12 + Math.round(L.wob || 0);
      blit(tgt, SPR.egg, ex, LH - SPR.egg.h);
      if (crack) blit(tgt, SPR.crack, ex, LH - SPR.egg.h);
      return;
    }
    // hunger, mess and sickness: left alone, it gets sick, then it dies
    if ((L.hungerT += k) > HUNGER_STEP) { L.hungerT = 0; L.hunger = Math.max(0, L.hunger - 1); }
    if (stage !== 'baby' && (L.poopT += k) > POOP_STEP) {
      L.poopT = Math.random() * 300;
      if (L.poops.length < 4) L.poops.push(L.dir > 0 ? Math.max(0, L.x - 6) : Math.min(LW - 5, L.x + 12));
    }
    L.starving = L.hunger === 0 ? L.starving + k : Math.max(0, L.starving - k * 2);
    L.filthy = L.poops.length >= 3 ? L.filthy + k : Math.max(0, L.filthy - k * 2);
    if (L.starving > STARVE || L.filthy > FILTH) L.sick = true;
    if (L.sick) {
      const cause = L.starving > 0 || L.poops.length >= 3;
      L.sickT = Math.max(0, L.sickT + (cause ? k : -k * 2));
      if (L.sickT === 0 && !cause) L.sick = false;
    }
    if (L.age > L.span || L.sickT > SICK) { L.dead = true; L.deadT = 0; L.action = null; return; }

    // the buttons
    while (st.queue.length) {
      const b = st.queue.shift();
      if (L.action) continue;
      if (b === 0 && L.hunger < 4) L.action = { type: 'feed', t: 0 };
      else if (b === 1 && L.poops.length) L.action = { type: 'flush', t: 0 };
      else if (b === 2) L.action = { type: 'status', t: 0 };
    }
    if (!L.action && (L.statusT += k) > L.statusAt) { L.statusT = 0; L.statusAt = 1800 + Math.random() * 900; L.action = { type: 'status', t: 0 }; }

    const s = SPR[stage], floorY = LH - s.h;
    const A = L.action;
    if (A && A.type === 'status') {
      A.t += k;
      if (A.t < 130) { text(tgt, 'AGE ' + Math.floor(L.age / 1200), 4, 2); text(tgt, 'GEN ' + L.gen, 4, 9); }
      else if (A.t < 260) {
        text(tgt, 'HUNGER', 4, 2);
        for (let i = 0; i < 4; i++) blit(tgt, i < L.hunger ? SPR.heart : SPR.hollow, 3 + i * 7, 9);
      } else L.action = null;
      return;
    }
    if (A && A.type === 'feed') {
      A.t += k;
      blit(tgt, s, 7, floorY + ((A.t / 20 | 0) % 2), false);
      const bites = Math.min(3, A.t / 45 | 0), f = SPR.food;
      blit(tgt, f, 21, LH - f.h);
      for (let b = 0; b < bites; b++) for (let r = 0; r < f.h; r++) tgt[(LH - f.h + r) * LW + 21 + b] = 0;   // bitten away, left to right
      if (A.t > 160) { L.hunger = Math.min(4, L.hunger + 1); L.action = null; }
      return;
    }

    // walking about, and dancing: it hops on the kicks
    L.walkT -= k;
    if (L.walkT < 0) { L.walkT = 120 + Math.random() * 360; L.dir = Math.random() < 0.5 ? -1 : 1; }
    L.x += L.dir * (0.012 + mids * 0.06) * k * (L.sick ? 0.3 : 1) * (stage === 'senior' ? 0.5 : 1);
    if (L.x < 1) { L.x = 1; L.dir = 1; }
    if (L.x > LW - s.w - 1) { L.x = LW - s.w - 1; L.dir = -1; }
    if (kicked && !L.sick) {
      L.jump = stage === 'senior' ? 0.4 : 1;
      if (st.beats % 3 === 0 && st.notes.length < 4) st.notes.push({ x: L.dir > 0 ? L.x + s.w : L.x - 3, y: floorY - 2, life: 0 });
      if (st.beats % 8 === 0) L.dir = -L.dir;
    }
    L.jump = Math.max(0, L.jump - 0.09 * k);
    const hop = Math.round(Math.sin(L.jump * Math.PI * 0.5) * (stage === 'baby' ? 2 : 3));
    blit(tgt, s, L.x, floorY - hop, L.dir < 0);
    if (L.sick && (st.t * 400 | 0) % 2) blit(tgt, SPR.skull, L.x + s.w + 1, floorY - 5);
    for (const px of L.poops) {
      blit(tgt, SPR.poop, px, LH - 5);
      if (((st.t * 300 + px) | 0) % 2) blit(tgt, SPR.stink, px + 1, LH - 9);
    }
    for (let i = st.notes.length - 1; i >= 0; i--) {
      const n = st.notes[i]; n.life += k; n.y -= 0.06 * k;
      if (n.y < -4 || n.life > 160) { st.notes.splice(i, 1); continue; }
      blit(tgt, SPR.note, n.x + Math.sin(n.life * 0.08) * 1.5, n.y);
    }
    if (A && A.type === 'flush') {
      A.t += k;
      const wx = LW - A.t * 0.4;
      L.poops = L.poops.filter((px) => px < wx - 1);
      for (let y = 0; y < LH; y++) {
        const xx = Math.round(wx + Math.sin(y * 0.9 + A.t * 0.3) * 1.2);
        for (let x = xx; x < xx + 2 && x < LW; x++) if (x >= 0) tgt[y * LW + x] = 1;
        for (let x = xx + 2; x < LW; x++) if (x >= 0) tgt[y * LW + x] = 0;
      }
      if (wx < -3) L.action = null;
    }
  }

  // ── the room ───────────────────────────────────────────────────────
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function eggPath(g, w, h) {
    g.beginPath(); g.moveTo(0, -h / 2);
    g.bezierCurveTo(w * 0.36, -h / 2, w / 2, -h * 0.12, w / 2, h * 0.1);
    g.bezierCurveTo(w / 2, h * 0.36, w * 0.3, h / 2, 0, h / 2);
    g.bezierCurveTo(-w * 0.3, h / 2, -w / 2, h * 0.36, -w / 2, h * 0.1);
    g.bezierCurveTo(-w / 2, -h * 0.12, -w * 0.36, -h / 2, 0, -h / 2);
    g.closePath();
  }
  function starPath(g, x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = rot + i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
  }
  // a seven-segment digit, for the alarm clock
  const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
  function digit(g, d, x, y, w, h, on, off) {
    const t = w * 0.18, segs = SEGS[d] || '';
    const bar = (id, sx, sy, horiz) => {
      g.fillStyle = segs.includes(id) ? on : off;
      g.beginPath();
      if (horiz) { g.moveTo(sx + t * 0.5, sy); g.lineTo(sx + w - t * 0.5, sy); g.lineTo(sx + w - t, sy + t * 0.5); g.lineTo(sx + t, sy + t * 0.5); g.lineTo(sx + t * 0.5, sy); g.lineTo(sx + t, sy - t * 0.5); g.lineTo(sx + w - t, sy - t * 0.5); g.lineTo(sx + w - t * 0.5, sy); }
      else { g.moveTo(sx, sy + t * 0.5); g.lineTo(sx + t * 0.5, sy + t); g.lineTo(sx + t * 0.5, sy + h / 2 - t); g.lineTo(sx, sy + h / 2 - t * 0.5); g.lineTo(sx - t * 0.5, sy + h / 2 - t); g.lineTo(sx - t * 0.5, sy + t); }
      g.closePath(); g.fill();
    };
    const sk = w * 0.12;   // a little italic slant
    g.save(); g.transform(1, 0, -sk / h, 1, sk, 0);
    bar('a', x, y, true); bar('g', x, y + h / 2, true); bar('d', x, y + h, true);
    bar('f', x + t * 0.25, y, false); bar('b', x + w - t * 0.25, y, false);
    bar('e', x + t * 0.25, y + h / 2, false); bar('c', x + w - t * 0.25, y + h / 2, false);
    g.restore();
  }

  function drawTV(g, x, y, w, h, videoFrame, t, highs) {
    // the cabinet: a beige 90s set, sitting on the desk with its back to the wall
    const cab = g.createLinearGradient(x, y, x, y + h);
    cab.addColorStop(0, '#5d584c'); cab.addColorStop(1, '#2a2722');
    roundRect(g, x, y, w, h, w * 0.06); g.fillStyle = cab; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = Math.max(1, w * 0.008); g.stroke();
    const sx = x + w * 0.08, sy = y + h * 0.08, sw = w * 0.7, sh = h * 0.8;
    roundRect(g, sx - w * 0.02, sy - w * 0.02, sw + w * 0.04, sh + w * 0.04, w * 0.07); g.fillStyle = '#121110'; g.fill();
    g.save(); roundRect(g, sx, sy, sw, sh, w * 0.06); g.clip();
    if (videoFrame) {
      if (!vid || vid.c.width !== videoFrame.w || vid.c.height !== videoFrame.h) {
        const c = document.createElement('canvas'); c.width = videoFrame.w; c.height = videoFrame.h;
        vid = { c, g: c.getContext('2d') };
      }
      vid.g.putImageData(videoFrame.imageData, 0, 0);
      const d = videoFrame.imageData.data; let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      if (n) { const v = st.vidRGB; v[0] += (r / n - v[0]) * 0.1; v[1] += (gg / n - v[1]) * 0.1; v[2] += (b / n - v[2]) * 0.1; }
      const sc = Math.max(sw / videoFrame.w, sh / videoFrame.h);
      g.imageSmoothingEnabled = true;
      g.drawImage(vid.c, sx + (sw - videoFrame.w * sc) / 2, sy + (sh - videoFrame.h * sc) / 2, videoFrame.w * sc, videoFrame.h * sc);
    } else {
      // nothing on: snow
      if (!noise) { const c = document.createElement('canvas'); c.width = 96; c.height = 72; noise = { c, g: c.getContext('2d'), img: null }; noise.img = noise.g.createImageData(96, 72); }
      const d = noise.img.data;
      for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 200 | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      noise.g.putImageData(noise.img, 0, 0);
      g.imageSmoothingEnabled = false; g.drawImage(noise.c, sx, sy, sw, sh); g.imageSmoothingEnabled = true;
      const v = st.vidRGB; v[0] += (150 - v[0]) * 0.05; v[1] += (150 - v[1]) * 0.05; v[2] += (160 - v[2]) * 0.05;
    }
    // scanlines, the slow rolling bar, the curve of the glass
    g.fillStyle = 'rgba(0,0,0,0.28)';
    const step = Math.max(2, sh / 90);
    for (let yy = sy; yy < sy + sh; yy += step) g.fillRect(sx, yy, sw, step * 0.45);
    const roll = sy + ((t * 0.05) % 1.4 - 0.2) * sh;
    const rb = g.createLinearGradient(0, roll - sh * 0.1, 0, roll + sh * 0.1);
    rb.addColorStop(0, 'rgba(255,255,255,0)'); rb.addColorStop(0.5, `rgba(255,255,255,${0.05 + highs * 0.06})`); rb.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rb; g.fillRect(sx, roll - sh * 0.1, sw, sh * 0.2);
    const vg = g.createRadialGradient(sx + sw / 2, sy + sh / 2, sw * 0.2, sx + sw / 2, sy + sh / 2, sw * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.75)');
    g.fillStyle = vg; g.fillRect(sx, sy, sw, sh);
    g.restore();
    const gl = g.createLinearGradient(sx, sy, sx + sw * 0.5, sy + sh * 0.5);
    gl.addColorStop(0, 'rgba(255,255,255,0.12)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    roundRect(g, sx, sy, sw, sh, w * 0.06); g.fillStyle = gl; g.fill();
    // the knobs and the speaker grille down the side
    const kx = x + w * 0.88;
    for (const [ky, kr] of [[0.2, 0.05], [0.38, 0.05]]) {
      g.beginPath(); g.arc(kx, y + h * ky, w * kr, 0, TAU); g.fillStyle = '#1d1b18'; g.fill();
      g.beginPath(); g.arc(kx - w * 0.01, y + h * ky - w * 0.01, w * kr * 0.6, 0, TAU); g.fillStyle = '#4a463d'; g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 0; i < 7; i++) g.fillRect(kx - w * 0.05, y + h * (0.55 + i * 0.045), w * 0.1, h * 0.018);
    g.beginPath(); g.arc(kx, y + h * 0.9, w * 0.012, 0, TAU); g.fillStyle = '#ff3a2a'; g.fill();   // the standby light, which is lying
  }

  function drawClock(g, x, y, w, h, minute, colon) {
    roundRect(g, x, y, w, h, h * 0.18); g.fillStyle = '#0d0c0c'; g.fill();
    g.strokeStyle = '#2a2826'; g.lineWidth = Math.max(1, h * 0.03); g.stroke();
    const on = '#ff2a1c', off = 'rgba(255,40,30,0.07)';
    const dh = h * 0.56, dw = dh * 0.5, top = y + h * 0.22;
    g.save(); g.shadowColor = 'rgba(255,30,20,0.8)'; g.shadowBlur = h * 0.15;
    const xs = [x + w * 0.24, x + w * 0.53, x + w * 0.73];
    digit(g, 3, xs[0], top, dw, dh, on, off);
    digit(g, Math.floor(minute / 10), xs[1], top, dw, dh, on, off);
    digit(g, minute % 10, xs[2], top, dw, dh, on, off);
    g.fillStyle = colon ? on : off;
    g.fillRect(x + w * 0.445, top + dh * 0.28, dw * 0.18, dw * 0.18);
    g.fillRect(x + w * 0.445, top + dh * 0.68, dw * 0.18, dw * 0.18);
    g.fillStyle = on; g.fillRect(x + w * 0.07, top + dh * 0.05, dw * 0.15, dw * 0.15);   // the AM dot
    g.restore();
    g.fillStyle = 'rgba(255,40,30,0.55)'; g.font = `bold ${Math.max(6, h * 0.12) | 0}px sans-serif`; g.textAlign = 'left';
    g.fillText('AM', x + w * 0.05, top + dh * 0.55);
  }

  function drawPostit(g, x, y, s, rot, deaths) {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-s / 2 + s * 0.03, -s / 2 + s * 0.04, s, s);
    const pg = g.createLinearGradient(0, -s / 2, 0, s / 2);
    pg.addColorStop(0, '#e9d861'); pg.addColorStop(1, '#c9b83e');
    g.fillStyle = pg; g.fillRect(-s / 2, -s / 2, s, s);
    g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(-s / 2, -s / 2, s, s * 0.14);   // the sticky strip
    g.fillStyle = '#1b2a6b'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.font = `${s * 0.13 | 0}px "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive`;
    g.fillText('FEED IT!!', -s * 0.42, -s * 0.22);
    g.font = `${s * 0.105 | 0}px "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive`;
    g.fillText("don't let it", -s * 0.42, -s * 0.06);
    g.fillText('die again', -s * 0.42, s * 0.07);
    g.strokeStyle = '#1b2a6b'; g.lineWidth = Math.max(1, s * 0.012); g.lineCap = 'round';
    // the tally of every one that didn't make it
    const shown = Math.min(deaths, 40), groups = Math.ceil(shown / 5), per = Math.min(6, groups);
    const gw = s * 0.85 / per, mh = Math.min(s * 0.12, gw * 0.75);
    for (let i = 0; i < shown; i++) {
      const grp = i / 5 | 0, j = i % 5, row = grp / per | 0, col = grp % per;
      const gx = -s * 0.42 + col * gw, gy = s * 0.16 + row * mh * 1.25;
      const w = (hash(i * 7.3) - 0.5) * s * 0.008;
      g.beginPath();
      if (j < 4) { g.moveTo(gx + j * gw * 0.16 + w, gy); g.lineTo(gx + j * gw * 0.16 - w, gy + mh); }
      else { g.moveTo(gx - gw * 0.06, gy + mh * 0.8); g.lineTo(gx + gw * 0.6, gy + mh * 0.15); }
      g.stroke();
    }
    g.restore();
  }

  function drawBattery(g, x, y, r, rot) {
    g.save(); g.translate(x, y); g.scale(1, 0.45); g.rotate(rot);
    g.beginPath(); g.arc(0, r * 0.25, r, 0, TAU); g.fillStyle = '#3c3e44'; g.fill();
    const bg = g.createLinearGradient(-r, -r, r, r);
    bg.addColorStop(0, '#8b909a'); bg.addColorStop(0.5, '#565a63'); bg.addColorStop(1, '#9a9fa8');
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fillStyle = bg; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = Math.max(1, r * 0.08); g.stroke();
    g.strokeStyle = 'rgba(20,20,24,0.7)'; g.lineWidth = Math.max(1, r * 0.12);
    g.beginPath(); g.moveTo(-r * 0.3, 0); g.lineTo(r * 0.3, 0); g.moveTo(0, -r * 0.3); g.lineTo(0, r * 0.3); g.stroke();
    g.restore();
  }

  // the bezel's printed icons -- food, light, game, medicine / toilet, stats, discipline, attention
  const ICONS = [
    '..#.#..,..#.#..,..###..,...#...,...#...,...#...', '..###..,.#...#.,.#...#.,..###..,..###..,...#...',
    '..###..,.#.#.#.,.##.##.,.#.#.#.,..###..,.......', '.....##,....##.,..###..,.###...,.##....,#......',
    '..##...,.####..,..####.,.#####.,..###..,.......', '#.....#,#..#..#,#.###.#,#.....#,#######,.......',
    '...#...,..###..,.#####.,...#...,...#...,..###..', '..###..,..###..,...#...,.#####.,...#...,..#.#..',
  ].map((s) => spr(s.split(',')));
  function drawIcon(g, ic, x, y, px, alpha) {
    g.fillStyle = `rgba(40,30,50,${alpha})`;
    for (let r = 0; r < ic.h; r++) for (let c = 0; c < ic.w; c++) if (ic.rows[r][c] === '#') g.fillRect(x + (c - ic.w / 2) * px, y + (r - ic.h / 2) * px, px * 0.92, px * 0.92);
  }

  // the keychain egg itself, drawn about its own centre
  function drawPet(g, w, h, hue, rgb, mids) {
    const [vr, vg2, vb] = rgb.map((v) => v | 0);
    // the ball chain, from the loop on top over the desk and out of frame
    g.save();
    const ax = -w * 0.02, ay = -h * 0.54;
    g.lineWidth = Math.max(1, w * 0.02); g.strokeStyle = '#9da3ad';
    g.beginPath(); g.ellipse(ax, ay, w * 0.06, w * 0.075, 0, 0, TAU); g.stroke();
    const br = w * 0.017;
    // up off the loop, slumped down its side and then lying along the desk
    const runs = [[[ax, ay - w * 0.07], [-w * 0.5, -h * 0.66], [-w * 0.62, h * 0.47], 26], [[-w * 0.62, h * 0.47], [-w * 0.95, h * 0.53], [-w * 1.4, h * 0.46], 16]];
    for (const [p0, p1, p2, balls] of runs) for (let i = 1; i < balls; i++) {
      const tt = i / (balls - 1), u = 1 - tt;
      const bx = u * u * p0[0] + 2 * u * tt * p1[0] + tt * tt * p2[0], by = u * u * p0[1] + 2 * u * tt * p1[1] + tt * tt * p2[1];
      g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fillStyle = '#6d727b'; g.fill();
      g.beginPath(); g.arc(bx - br * 0.3, by - br * 0.3, br * 0.45, 0, TAU); g.fillStyle = '#d6dae0'; g.fill();
    }
    g.restore();

    // the clear plastic shell
    eggPath(g, w, h);
    const shell = g.createRadialGradient(-w * 0.15, -h * 0.2, w * 0.05, 0, 0, h * 0.62);
    shell.addColorStop(0, `hsla(${hue | 0},85%,78%,0.9)`);
    shell.addColorStop(0.6, `hsla(${hue | 0},75%,52%,0.88)`);
    shell.addColorStop(1, `hsla(${(hue + 25) % 360 | 0},80%,28%,0.95)`);
    g.fillStyle = shell; g.fill();
    // you can see the insides: the board, the battery hatch, the little piezo
    g.save(); eggPath(g, w, h); g.clip();
    g.globalAlpha = 0.13;
    roundRect(g, -w * 0.36, -h * 0.2, w * 0.72, h * 0.42, w * 0.04); g.fillStyle = '#1e5a2c'; g.fill();
    g.strokeStyle = '#b9a04a'; g.lineWidth = Math.max(1, w * 0.006);
    for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(-w * 0.32, -h * 0.17 + i * h * 0.045); g.lineTo(-w * 0.12 + hash(i) * w * 0.3, -h * 0.17 + i * h * 0.045); g.lineTo(-w * 0.1 + hash(i) * w * 0.3, -h * 0.15 + i * h * 0.045); g.stroke(); }
    g.beginPath(); g.arc(w * 0.18, h * 0.14, w * 0.11, 0, TAU); g.fillStyle = '#c0c4cc'; g.fill();
    g.beginPath(); g.arc(-w * 0.2, h * 0.16, w * 0.06, 0, TAU); g.fillStyle = '#d9a63a'; g.fill();
    g.globalAlpha = 1;
    // glitter in the plastic
    for (let i = 0; i < 60; i++) {
      const gx = (hash(i * 3.1) - 0.5) * w, gy = (hash(i * 5.7) - 0.5) * h, tw = 0.5 + 0.5 * Math.sin(st.t * 30 + i * 1.7);
      g.fillStyle = `rgba(255,255,255,${(0.15 + tw * 0.5 * (0.4 + mids)).toFixed(2)})`;
      g.fillRect(gx, gy, w * 0.008, w * 0.008);
    }
    // the TV's light, falling on its left side
    const tl = g.createLinearGradient(-w / 2, 0, w * 0.2, 0);
    tl.addColorStop(0, `rgba(${vr},${vg2},${vb},0.35)`); tl.addColorStop(1, `rgba(${vr},${vg2},${vb},0)`);
    g.fillStyle = tl; g.fillRect(-w / 2, -h / 2, w, h);
    g.restore();
    eggPath(g, w, h); g.strokeStyle = `hsla(${hue | 0},60%,85%,0.55)`; g.lineWidth = Math.max(1, w * 0.012); g.stroke();

    // the face plate around the screen
    const fw = w * 0.8, fh = h * 0.52, fy = -h * 0.05;
    g.save(); g.translate(0, fy); eggPath(g, fw, fh); g.restore();
    const fp = g.createLinearGradient(0, fy - fh / 2, 0, fy + fh / 2);
    fp.addColorStop(0, '#f4ecf6'); fp.addColorStop(1, '#cfc3d6');
    g.fillStyle = fp; g.fill();
    g.strokeStyle = 'rgba(60,30,80,0.35)'; g.lineWidth = Math.max(1, w * 0.008); g.stroke();
    g.fillStyle = `hsla(${(hue + 180) % 360 | 0},70%,40%,0.9)`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold italic ${w * 0.042 | 0}px "Arial Black", "Arial", sans-serif`;
    g.fillText('FOREVER \u2665 PAL', 0, fy - fh / 2 - h * 0.035);

    // the icons above and below the screen
    const L = st.life, A = L.action, ipx = w * 0.01;
    const lit = [A && A.type === 'feed', false, false, L.sick, A && A.type === 'flush', A && A.type === 'status', false, !L.dead && (L.hunger === 0 || L.poops.length >= 2 || L.sick)];
    for (let i = 0; i < 8; i++) {
      const row = i < 4 ? -1 : 1, col = i % 4;
      const blink = i === 7 && lit[7] ? (Math.sin(st.t * 60) > 0 ? 0.95 : 0.3) : (lit[i] ? 0.95 : 0.4);
      drawIcon(g, ICONS[i], (col - 1.5) * fw * 0.19, fy + row * fh * 0.37, ipx, blink);
    }

    // the LCD
    const sw = fw * 0.7, sh = sw * 0.56, sx = -sw / 2, sy = fy - sh / 2;
    roundRect(g, sx - sw * 0.05, sy - sw * 0.05, sw * 1.1, sh + sw * 0.1, sw * 0.06); g.fillStyle = '#4b4652'; g.fill();
    const lg = g.createLinearGradient(sx, sy, sx + sw, sy + sh);
    lg.addColorStop(0, '#b4bf96'); lg.addColorStop(1, '#93a07a');
    g.fillStyle = lg; g.fillRect(sx, sy, sw, sh);
    const m = sw * 0.04, cs = (sw - m * 2) / LW, oy = sy + (sh - cs * LH) / 2, ox = sx + m;
    const disp = st.disp;
    // each dot casts a faint shadow onto the backplane a little below it
    for (let pass = 0; pass < 2; pass++) {
      const off = pass === 0 ? cs * 0.18 : 0, a = pass === 0 ? 0.16 : 0.92;
      for (let i = 0; i < LW * LH; i++) {
        const v = disp[i]; if (v < 0.04) continue;
        g.fillStyle = `rgba(22,30,18,${(v * a).toFixed(2)})`;
        g.fillRect(ox + (i % LW) * cs + off, oy + (i / LW | 0) * cs + off, cs * 0.88, cs * 0.88);
      }
    }
    const lgl = g.createLinearGradient(sx, sy, sx, sy + sh);
    lgl.addColorStop(0, 'rgba(255,255,255,0.14)'); lgl.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.fillStyle = lgl; g.fillRect(sx, sy, sw, sh);

    // the three buttons
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * w * 0.2, by = h * 0.31 + (i === 1 ? h * 0.035 : 0), br = w * 0.065, p = st.press[i];
      g.beginPath(); g.arc(bx, by + br * 0.18, br, 0, TAU); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill();
      const bg = g.createRadialGradient(bx - br * 0.35, by - br * 0.4 + p * br * 0.15, br * 0.1, bx, by + p * br * 0.15, br);
      bg.addColorStop(0, '#fff6fb'); bg.addColorStop(1, `hsl(${(hue + 160) % 360 | 0},55%,${62 - p * 14 | 0}%)`);
      g.beginPath(); g.arc(bx, by + p * br * 0.15, br * (1 - p * 0.06), 0, TAU); g.fillStyle = bg; g.fill();
      g.fillStyle = 'rgba(40,20,60,0.6)'; g.font = `bold ${w * 0.04 | 0}px sans-serif`;
      g.fillText('ABC'[i], bx, by + br * 1.55);
    }
    // the shine
    g.save(); eggPath(g, w, h); g.clip();
    const sp = g.createRadialGradient(-w * 0.2, -h * 0.32, 0, -w * 0.2, -h * 0.32, w * 0.3);
    sp.addColorStop(0, 'rgba(255,255,255,0.5)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sp; g.beginPath(); g.ellipse(-w * 0.2, -h * 0.32, w * 0.22, h * 0.1, -0.5, 0, TAU); g.fill();
    g.restore();
  }

  function makeStars() {
    const out = [];
    for (let i = 0; i < 34; i++) out.push({ x: hash(i * 12.9 + 1), y: hash(i * 78.2 + 3), r: 0.6 + hash(i * 4.4) * 0.8, rot: hash(i * 9.1) * TAU, ph: hash(i * 2.3) * TAU });
    return out;
  }

  viz.registerMode({
    id: 'virtualpet', label: 'Virtual Pet',
    init() {
      st = fresh();
      // A feeds, B flushes, C shows the stats -- but only while this is the one drawing
      const set = (e, down) => {
        if (!st || performance.now() - lastDraw > 300 || e.ctrlKey || e.metaKey || e.altKey) return;
        const a = document.activeElement;
        if (a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable)) return;
        const b = ['KeyA', 'KeyB', 'KeyC'].indexOf(e.code);
        if (b < 0) return;
        if (down && !e.repeat) st.queue.push(b);
        st.held = st.held || [false, false, false]; st.held[b] = down;
      };
      keyHandlers = { down: (e) => set(e, true), up: (e) => set(e, false) };
      document.addEventListener('keydown', keyHandlers.down);
      document.addEventListener('keyup', keyHandlers.up);
    },
    teardown() {
      if (keyHandlers) { document.removeEventListener('keydown', keyHandlers.down); document.removeEventListener('keyup', keyHandlers.up); }
      keyHandlers = null; st = null; vid = null; noise = null;
    },
    draw(ctx) {
      const { vctx: g, VW, VH, cx, cy, hueBase, freqData, vizRot, vizUserScale, videoFrame } = ctx;
      if (!st) st = fresh();
      lastDraw = performance.now();
      if (st.lastRot == null) st.lastRot = vizRot;
      const dRot = clamp(vizRot - st.lastRot, 0, 0.5); st.lastRot = vizRot;
      const k = Math.min(dRot / 0.006, 4);   // frames' worth of time at the current Speed
      st.t += dRot;
      const t = st.t * 6;
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
      if (kicked) st.shake = 1;
      st.shake = Math.max(0, st.shake - dt * 6);
      for (let i = 0; i < 3; i++) st.press[i] += ((st.held && st.held[i] ? 1 : 0) - st.press[i]) * ease(0.04);

      // the creature, then the LCD's slow dots: they darken fast and fade slow
      live(st.life, k, kicked, mids);
      for (let i = 0; i < LW * LH; i++) {
        const tv = st.tgt[i], d = st.disp[i];
        st.disp[i] = d + (tv - d) * (tv > d ? ease(0.02) : ease(0.05));
      }

      const S = Math.min(VW, VH) * vizUserScale, M = Math.min(VW, VH);
      const [vr, vg2, vb] = st.vidRGB.map((v) => v | 0);

      // ── the wall, and the stars stuck on it ──
      const wall = g.createLinearGradient(0, 0, 0, VH);
      wall.addColorStop(0, '#080a1a'); wall.addColorStop(0.6, '#0d1024'); wall.addColorStop(1, '#05060d');
      g.fillStyle = wall; g.fillRect(0, 0, VW, VH);
      const deskY = cy + S * 0.06;
      if (!stars) stars = makeStars();
      for (const s of stars) {
        const x = s.x * VW, y = s.y * Math.max(0, deskY - S * 0.05), r = s.r * M * 0.018;
        const a = 0.25 + 0.2 * Math.sin(t * 0.4 + s.ph) + highs * 0.7;
        const gl = g.createRadialGradient(x, y, 0, x, y, r * 3);
        gl.addColorStop(0, `rgba(190,255,170,${(a * 0.35).toFixed(2)})`); gl.addColorStop(1, 'rgba(190,255,170,0)');
        g.fillStyle = gl; g.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
        starPath(g, x, y, r, s.rot); g.fillStyle = `rgba(205,255,185,${clamp(a, 0.1, 1).toFixed(2)})`; g.fill();
      }
      // and a moon, the biggest sticker
      const mx = VW * 0.82, my = Math.max(M * 0.1, deskY * 0.22), mr = M * 0.05;
      g.save(); g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.arc(mx + mr * 0.45, my - mr * 0.15, mr * 0.85, 0, TAU, true);
      g.fillStyle = `rgba(205,255,185,${(0.45 + highs * 0.5).toFixed(2)})`; g.fill('evenodd'); g.restore();

      // ── the desk ──
      const desk = g.createLinearGradient(0, deskY, 0, VH);
      desk.addColorStop(0, '#2b1a10'); desk.addColorStop(1, '#120a05');
      g.fillStyle = desk; g.fillRect(0, deskY, VW, VH - deskY);
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = Math.max(1, M * 0.002);
      for (let i = 0; i < 14; i++) {
        const y0 = deskY + (VH - deskY) * Math.pow(i / 14, 1.6);
        g.beginPath(); g.moveTo(0, y0);
        for (let x = 0; x <= VW; x += VW / 16) g.lineTo(x, y0 + Math.sin(x * 0.01 + i * 1.3) * M * 0.004 * (1 + i * 0.2));
        g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, deskY, VW, Math.max(1, M * 0.003));

      // ── the TV, the clock ──
      const tvW = S * 0.62, tvH = S * 0.5, tvX = cx - S * 0.62 - tvW / 2, tvY = deskY + S * 0.03 - tvH;
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.ellipse(tvX + tvW / 2, deskY + S * 0.03, tvW * 0.55, S * 0.03, 0, 0, TAU); g.fill();
      drawTV(g, tvX, tvY, tvW, tvH, videoFrame, t, highs);
      const minute = (33 + st.deaths - DEATHS0) % 60;
      const clW = S * 0.36, clH = S * 0.15, clX = cx + S * 0.62 - clW / 2, clY = deskY + S * 0.05 - clH;
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.ellipse(clX + clW / 2, deskY + S * 0.05, clW * 0.55, S * 0.02, 0, 0, TAU); g.fill();
      drawClock(g, clX, clY, clW, clH, minute, (now / 1000 | 0) % 2 === 0);
      const red = g.createRadialGradient(clX + clW / 2, clY + clH / 2, 0, clX + clW / 2, clY + clH / 2, clW);
      red.addColorStop(0, 'rgba(255,30,20,0.12)'); red.addColorStop(1, 'rgba(255,30,20,0)');
      g.fillStyle = red; g.fillRect(clX - clW, clY - clW, clW * 3, clW * 3);

      // ── the clutter on the desk ──
      drawPostit(g, cx + S * 0.5, cy + S * 0.36, S * 0.24, 0.12, st.deaths);
      drawBattery(g, cx - S * 0.42, cy + S * 0.42, S * 0.035, 0.3);
      drawBattery(g, cx - S * 0.33, cy + S * 0.46, S * 0.035, 1.4);

      // ── the pet ──
      const pw = S * 0.48, ph = S * 0.58, px = cx + S * 0.02, py = cy + S * 0.43 - ph / 2;
      const sh = g.createRadialGradient(px, cy + S * 0.43, 0, px, cy + S * 0.43, pw * 0.6);
      sh.addColorStop(0, 'rgba(0,0,0,0.6)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.translate(px, cy + S * 0.43); g.scale(1, 0.2); g.fillStyle = sh; g.beginPath(); g.arc(0, 0, pw * 0.6, 0, TAU); g.fill(); g.restore();
      const buzz = st.shake * st.shake * S * 0.006;
      g.save();
      g.translate(px + Math.sin(now * 0.09) * buzz, py + Math.cos(now * 0.11) * buzz * 0.5);
      g.rotate(-0.07 + bass * 0.01 + Math.sin(now * 0.07) * st.shake * 0.01);
      drawPet(g, pw, ph, (hueBase * 0.5 + 285) % 360, st.vidRGB, mids);
      g.restore();

      // ── the TV's glow over everything, then the dark closing in ──
      const glow = g.createRadialGradient(tvX + tvW * 0.42, tvY + tvH * 0.45, 0, tvX + tvW * 0.42, tvY + tvH * 0.45, S * 1.4);
      glow.addColorStop(0, `rgba(${vr},${vg2},${vb},${(0.2 + mids * 0.08).toFixed(2)})`);
      glow.addColorStop(1, `rgba(${vr},${vg2},${vb},0)`);
      g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = glow; g.fillRect(0, 0, VW, VH); g.restore();
      const vgn = g.createRadialGradient(VW / 2, VH / 2, M * 0.3, VW / 2, VH / 2, Math.hypot(VW, VH) * 0.62);
      vgn.addColorStop(0, 'rgba(0,0,0,0)'); vgn.addColorStop(1, 'rgba(0,0,4,0.7)');
      g.fillStyle = vgn; g.fillRect(0, 0, VW, VH);
    },
  });
})();
