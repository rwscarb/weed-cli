// Orbit stream encoder worker -- owns the WebSocket to /api/orbit-ws and
// does the JPEG encode, so neither ever touches the page's main thread.
//
// Why a worker at all: Chrome runs canvas.toBlob's JPEG encode as an
// *idle-time* task, and a heavy visualizer mode (Particles, ASCII, ...)
// leaves the main thread with no idle time. Chrome then waits up to a
// full second before forcing the encode -- measured 1.1-1.7s per frame
// on the sender, i.e. ~0.9fps on the wire, with the tab fully visible
// and rAF ticking at 60Hz the whole time. Even in light modes the round
// trip was ~31ms, which alone caps the stream near 30fps.
// OffscreenCanvas.convertToBlob here runs on this worker's own thread,
// which has nothing else to do, so encode time is the actual encode
// time (a few ms for a 720p frame at quality 0.5).
//
// Protocol, main -> worker:
//   {type:'open', url, width, height, quality}
//   {type:'frame', buf, width, height}   RGBA bytes, transferred (zero-copy)
// worker -> main:
//   {type:'open'} | {type:'close'} | {type:'error', message}
//   {type:'sent', bytes, ms}     one per frame that went out; ms = put+encode+send
//   {type:'skipped', reason}     'backlog' = socket has too much unsent data
//   {type:'done'}                after every 'frame', sent or not -- main's
//                                in-flight gate, so it never queues frames
//                                faster than this thread can encode them

let ws = null;
let canvas = null;
let ctx = null;
let quality = 0.5;
// ~3 frames of unsent backlog before we skip rather than queue -- a
// sending-side backlog is viewer latency, and the server drops-oldest
// on its side too, so skipping here is the only thing that actually
// keeps the picture current
const BUF_LIMIT = 256 * 1024;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'open') {
    quality = m.quality;
    canvas = new OffscreenCanvas(m.width, m.height);
    ctx = canvas.getContext('2d');
    ws = new WebSocket(m.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => self.postMessage({ type: 'open' });
    ws.onerror = () => self.postMessage({ type: 'error', message: 'WebSocket error' });
    ws.onclose = () => { ws = null; self.postMessage({ type: 'close' }); };
    return;
  }
  if (m.type === 'frame') {
    const t0 = performance.now();
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > BUF_LIMIT) { self.postMessage({ type: 'skipped', reason: 'backlog' }); return; }
      // Uint8ClampedArray over the transferred buffer is a view, not a
      // copy; putImageData is the one copy, into the canvas backing store
      ctx.putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.width, m.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const buf = await blob.arrayBuffer();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
        self.postMessage({ type: 'sent', bytes: buf.byteLength, ms: performance.now() - t0 });
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    } finally {
      self.postMessage({ type: 'done' });
    }
  }
};
