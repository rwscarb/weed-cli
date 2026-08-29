'use strict';
// Example Orbit Visualizer plugin -- NOT loaded by index.html by
// default (it's not on the <script> list there at all). To try it,
// add <script src="orbit_plugin_example.js"></script> after
// orbit_visualizer.js's own <script> tag; it registers itself the
// moment it loads.
//
// This is the whole contract, demonstrated end to end: register a mode
// with {id, label, draw}, react to the same audio/canvas data the
// built-in modes use, and clean up in teardown(). See
// window.orbitViz's own registerMode/pluginModes comment in
// orbit_visualizer.js for the full API this is exercising.
(function () {
  // init(ctx) runs once, right when the visualizer dialog opens --
  // ctx.container is the dialog's own #vizSection, useful if a plugin
  // wants to mount its own extra controls (there's no declarative way
  // to add sliders/buttons the way the built-in modes' ASCII/Freefall
  // rows do -- this is the escape hatch). This example doesn't need
  // any, so init() here just logs once for visibility.
  function init() {
    console.log('[orbit plugin example] mounted');
  }

  // teardown() runs once when the dialog closes (or this plugin is
  // unregistered while it's open). Nothing to clean up here since
  // init() above didn't create anything -- a plugin that added DOM
  // elements or started its own timers in init() would undo that here.
  function teardown() {
    console.log('[orbit plugin example] unmounted');
  }

  // draw(ctx) runs once per animation frame while "Starfield" (this
  // plugin's own mode) is the active one. ctx fields used below:
  //   vctx            -- the real CanvasRenderingContext2D to draw into
  //   VW, VH          -- canvas size in device pixels
  //   cx, cy          -- canvas center, already adjusted for pan
  //   hueBase         -- 0-360, the same slow color drift every
  //                      built-in mode shares (so a plugin's palette
  //                      drifts in sync with the rest of the app
  //                      instead of looking static next to them)
  //   vizRot          -- a radians-per-frame accumulator, already
  //                      scaled by the Speed slider -- use this for
  //                      any rotation/animation rate instead of reading
  //                      performance.now() directly (see
  //                      orbit_visualizer.js's own plasmaT comment for
  //                      why a live Speed change would jump a clock
  //                      derived straight from wall-clock time)
  //   vizUserScale    -- the Zoom slider's current value
  //   freqData        -- Uint8Array, frequency-domain audio data,
  //                      already scaled by the Reactivity slider
  //   waveData        -- Uint8Array, time-domain audio data, same
  //   videoFrame      -- { w, h, imageData } | null -- a small sampled
  //                      frame of whatever's currently playing, or null
  //                      if nothing's playing yet
  //   speed, reactivity -- the raw slider values themselves, in case a
  //                      plugin wants to read them directly rather than
  //                      relying on vizRot/freqData already reflecting
  //                      them
  //
  // This particular example: a slowly-rotating starfield, star
  // brightness tied to the audio's overall energy.
  let stars = null;
  function ensureStars(ctx) {
    if (stars) return stars;
    stars = [];
    for (let i = 0; i < 140; i++) {
      stars.push({
        angle: Math.random() * Math.PI * 2,
        radius: Math.random(),
        size: 1 + Math.random() * 1.6,
      });
    }
    return stars;
  }

  function draw(ctx) {
    const { vctx, VW, VH, cx, cy, hueBase, vizRot, freqData } = ctx;
    vctx.fillStyle = 'rgba(4,4,8,1)';
    vctx.fillRect(0, 0, VW, VH);

    const energy = freqData.reduce((a, b) => a + b, 0) / (freqData.length * 255);
    const maxR = Math.hypot(VW, VH) * 0.55;
    for (const star of ensureStars(ctx)) {
      const angle = star.angle + vizRot * 0.2;
      const r = star.radius * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const hue = (hueBase + star.radius * 120) % 360;
      vctx.beginPath();
      vctx.arc(x, y, star.size * (1 + energy * 2), 0, Math.PI * 2);
      vctx.fillStyle = `hsla(${hue | 0},80%,${70 + energy * 20 | 0}%,${(0.5 + energy * 0.5).toFixed(2)})`;
      vctx.fill();
    }
  }

  window.orbitViz.registerMode({
    id: 'starfield-example',
    label: 'Starfield',
    init,
    teardown,
    draw,
  });
})();
