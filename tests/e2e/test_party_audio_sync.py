"""
The party page's 🔊 listen keeps its sound at the live edge, so it stays
with the always-live MJPEG picture (see vue-app.js _feedPartyAudio and
_chasePartyAudioEdge).

The first test is the real thing: a page records an oscillator with
MediaRecorder and streams it to /api/orbit-audio-ws exactly as the
streamer's 🔊 does, and a guest page listens. Before, the guest's
<audio src> was fed in ~2s lumps and ran dry between them, falling a
little further behind every time. The rest drive the chaser with a
stand-in element whose buffered/currentTime are set by hand, so each case
is exact rather than timing-dependent.
"""
import time

import web_ui


def _vm(page):
    return page.evaluate_handle(
        "document.getElementById('app').__vue_app__._container._vnode.component.proxy")


_SEND = """() => { const ctx = new AudioContext(); const o = ctx.createOscillator();
  const d = ctx.createMediaStreamDestination(); o.connect(d); o.start();
  const ws = new WebSocket(`ws://${location.host}/api/orbit-audio-ws?mime=audio/webm;codecs=opus`);
  ws.binaryType = 'arraybuffer';
  const r = new MediaRecorder(d.stream, { mimeType: 'audio/webm;codecs=opus' });
  r.ondataavailable = e => ws.readyState === 1 && ws.send(e.data);
  ws.onopen = () => r.start(250); }"""


def test_live_audio_stays_at_the_edge_without_running_dry(browser, golden_path_server, monkeypatch):
    # the party page only offers 🔊 while a picture is streaming too
    monkeypatch.setattr(web_ui, '_orbit_ws_connected', True)
    sender = browser.new_page()
    sender.goto(golden_path_server['web_url'])
    sender.evaluate(_SEND)
    time.sleep(3)                       # a late joiner, like every real guest
    guest = browser.new_page()
    guest.goto(golden_path_server['web_url'])
    guest.wait_for_function(
        "() => document.getElementById('app').__vue_app__._container._vnode.component.proxy.party.stream.audio",
        timeout=10_000)
    # listen to what the guest actually plays: the sender's oscillator is a
    # sine, so sample-to-sample it never moves more than ~0.06 -- a jump
    # past 0.25 is a click (a gap or a cut-off overlap between frames)
    _vm(guest).evaluate("""vm => { vm.togglePartyListen(); const a = vm._partyAudio;
      window._waits = 0; a.addEventListener('waiting', () => { if (a.currentTime > 0) _waits++; });
      const ctx = new AudioContext(), sp = ctx.createScriptProcessor(4096, 1, 1);
      ctx.createMediaElementSource(a).connect(sp); sp.connect(ctx.destination);
      window._clicks = 0; window._peak = 0; let prev = 0;
      sp.onaudioprocess = e => { for (const v of e.inputBuffer.getChannelData(0)) {
        if (Math.abs(v - prev) > 0.25) _clicks++; _peak = Math.max(_peak, Math.abs(v)); prev = v; } }; }""")
    guest.wait_for_function("() => { const a = document.getElementById('app').__vue_app__._container._vnode"
                            ".component.proxy._partyAudio; return a && a.readyState >= 3 && !a.paused; }",
                            timeout=10_000)
    time.sleep(1)
    probe = """vm => { const a = vm._partyAudio;
      return { mse: !!a._mse, ahead: a.buffered.end(a.buffered.length - 1) - a.currentTime,
               lag: performance.now() / 1000 - a.currentTime, waits: window._waits,
               clicks: window._clicks, peak: window._peak }; }"""
    first = _vm(guest).evaluate(probe)
    # from here on: the start (the jump to the edge is a seek, which can
    # itself fire one 'waiting') isn't what's being measured
    guest.evaluate("() => { window._waits = 0; window._clicks = 0; window._peak = 0; }")
    worst = 0
    for _ in range(16):                 # 8s: the old path ran dry ~every 2s
        time.sleep(0.5)
        r = _vm(guest).evaluate(probe)
        worst = max(worst, r['ahead'])
    assert first['mse']
    assert worst < 1.5, f'audio queued up to {worst:.2f}s behind the live edge'
    # the old <audio src> ran dry ~4 times in this window; one is allowed
    # for a busy CI runner's scheduling, not for the 2s lumps
    assert r['waits'] <= 1, f"ran dry {r['waits']} times"
    # the recorder's jittery timestamps used to put ~25 clicks a second in
    # here (see webmOpusRetimer): ~190 in this window. A busy CI runner
    # costs a few of its own (a stall, a late ScriptProcessor callback;
    # 0-2 locally, 9 seen in CI), so the bar sits well between the two
    assert r['peak'] > 0.5, r                 # it really was playing the tone
    assert r['clicks'] <= 40, f"{r['clicks']} clicks in 8s"
    # media time keeps pace with the wall clock: no drift
    assert abs(r['lag'] - first['lag']) < 0.4

    # a long hold-up (the element held for 4s) is skipped, not kept
    _vm(guest).evaluate("vm => vm._partyAudio.pause()")
    time.sleep(4)
    _vm(guest).evaluate("vm => { vm._partyAudio.play(); }")
    time.sleep(3)
    r = _vm(guest).evaluate(probe)
    assert r['ahead'] < 1.5 and abs(r['lag'] - first['lag']) < 0.8, (first, r)
    _vm(guest).evaluate("vm => vm.stopPartyListen()")


# readings: one buffered-ahead value per 250ms tick, in order
_RUN = """(vm, [readings, mse]) => {
  let played = 0;
  const a = { paused: false, readyState: 4, currentTime: 100, playbackRate: 1,
              src: '/api/orbit-audio?_=1', play() { played++; return Promise.resolve(); } };
  if (mse) a._mse = {};
  for (const ahead of readings) {
    a.currentTime += 0.25;
    const end = a.currentTime + ahead;
    a.buffered = { length: 1, start: () => 50, end: () => end };
    vm._chasePartyAudioEdge(a);
  }
  return { rate: a.playbackRate, ahead: a.buffered.end(0) - a.currentTime,
           reconnected: a.src !== '/api/orbit-audio?_=1', played };
}"""


def _run(page, readings, mse=False):
    return _vm(page).evaluate(_RUN, [readings, mse])


def test_mse_near_the_edge_is_left_alone(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [0.3, 0.45, 0.6] * 11, mse=True)
    assert r['rate'] == 1 and not r['reconnected']


def test_mse_audio_that_always_waits_is_played_off_at_one_steady_rate(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [1.0] * 32, mse=True)                  # 0.75s never used
    assert r['rate'] == 1.04 and abs(r['ahead'] - 1.0) < 1e-9
    r = _run(page, [1.0] * 32 + [0.3] * 32, mse=True)     # drained: back to 1x
    assert r['rate'] == 1


def test_mse_a_dip_between_bursts_keeps_the_buffer(page, golden_path_server):
    """Over the internet the blobs come in bursts. The buffer that just
    covers the gaps between them is in use, so it's kept: trimming it
    was what ran the sound dry (stutter) and seeking was the click."""
    page.goto(golden_path_server['web_url'])
    r = _run(page, [1.5] * 20 + [0.05] + [1.5] * 11, mse=True)
    assert r['rate'] == 1 and abs(r['ahead'] - 1.5) < 1e-9


def test_mse_seconds_behind_jumps_to_the_edge(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [4.0] * 8, mse=True)
    assert r['rate'] == 1 and abs(r['ahead'] - 1.0) < 1e-9 and not r['reconnected']


def test_mse_late_joiner_starts_at_the_edge(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    # the playhead at 0, the first blocks stamped minutes in
    r = _vm(page).evaluate("""vm => { const a = { paused: false, currentTime: 0, playbackRate: 1, _mse: {},
        buffered: { length: 1, start: () => 300, end: () => 300.5 } };
      vm._chasePartyAudioEdge(a); return a.currentTime; }""")
    assert abs(r - 299.5) < 1e-9


def test_fallback_near_the_edge_plays_at_normal_speed(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    # the <audio src> lumps: 2s landing on a 0.3s floor
    r = _run(page, [2.3, 2.05, 1.8, 1.55, 1.3, 1.05, 0.8, 0.55, 0.3, 2.3, 2.05, 1.8])
    assert r['rate'] == 1 and not r['reconnected'] and r['played'] == 0


def test_fallback_backlog_speeds_up_gently(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [1.1] * 12)                            # floor 1.1s: 0.6 over target
    assert abs(r['rate'] - 1.06) < 1e-9 and not r['reconnected']
    assert _run(page, [4.0] * 12)['rate'] == 1.08         # capped


def test_fallback_seconds_behind_reconnects(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [5.0] * 12)
    assert r['rate'] == 1 and r['reconnected'] and r['played'] == 1


def test_starved_element_is_left_alone(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _vm(page).evaluate("""vm => { const a = { paused: false, readyState: 2, playbackRate: 1,
        buffered: { length: 1, start: () => 0, end: () => 9 }, currentTime: 1 };
      for (let i = 0; i < 16; i++) vm._chasePartyAudioEdge(a); return [a.playbackRate, !!a._aheadHist]; }""")
    assert r == [1, False]


# a minimal live WebM: EBML header, unknown-size Segment, Info with a 1ms
# TimecodeScale, empty Tracks, then one Cluster (Timecode 1000) of three
# 60ms Opus packets (TOC 0x9B: 20ms CELT, code 3, count byte 3) stamped
# the way the recorder does it -- 0, 52 and 111ms in
_STREAM = """() => {
  const simple = (rel) => [0xA3, 0x86, 0x81, (rel >> 8) & 0xFF, rel & 0xFF, 0x80, 0x9B, 0x03];
  return [0x1A, 0x45, 0xDF, 0xA3, 0x80,
          0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
          0x15, 0x49, 0xA9, 0x66, 0x87, 0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40,
          0x16, 0x54, 0xAE, 0x6B, 0x80,
          0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE7, 0x82, 0x03, 0xE8,
          ...simple(0), ...simple(52), ...simple(111)];
}"""


def test_retimer_butts_the_recorders_jittery_packets_end_to_end(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = page.evaluate("""(mk) => { const src = new Uint8Array(eval(mk)());
      const whole = Array.from(webmOpusRetimer()(src));
      const f = webmOpusRetimer(), bytewise = [];            // the same, one byte at a time
      for (const b of src) bytewise.push(...f(new Uint8Array([b])));
      return { whole, bytewise, n: src.length }; }""", _STREAM)
    assert r['whole'] == r['bytewise']
    out = r['whole']
    # the init segment passes through untouched (34 bytes, Info included)
    assert out[:34] == page.evaluate(f"() => ({_STREAM})().slice(0, 34)")
    # then a fresh Cluster at the running time, and the blocks 60ms apart
    cl = out[34:]
    assert cl[:4] == [0x1F, 0x43, 0xB6, 0x75] and cl[12:16] == [0xE7, 0x82, 0x03, 0xE8]
    blocks = cl[16:]
    rels = [(blocks[i + 3] << 8) | blocks[i + 4] for i in range(0, len(blocks), 8)]
    assert rels == [0, 60, 120]
