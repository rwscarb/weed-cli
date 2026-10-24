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
    _vm(guest).evaluate("""vm => { vm.togglePartyListen(); const a = vm._partyAudio;
      window._waits = 0; a.addEventListener('waiting', () => { if (a.currentTime > 0) _waits++; }); }""")
    guest.wait_for_function("() => { const a = document.getElementById('app').__vue_app__._container._vnode"
                            ".component.proxy._partyAudio; return a && a.readyState >= 3 && !a.paused; }",
                            timeout=10_000)
    time.sleep(1)
    probe = """vm => { const a = vm._partyAudio;
      return { mse: !!a._mse, ahead: a.buffered.end(a.buffered.length - 1) - a.currentTime,
               lag: performance.now() / 1000 - a.currentTime, waits: window._waits }; }"""
    first = _vm(guest).evaluate(probe)
    # from here on: the start (the jump to the edge is a seek, which can
    # itself fire one 'waiting') isn't what's being measured
    guest.evaluate("() => { window._waits = 0; }")
    worst = 0
    for _ in range(16):                 # 8s: the old path ran dry ~every 2s
        time.sleep(0.5)
        r = _vm(guest).evaluate(probe)
        worst = max(worst, r['ahead'])
    assert first['mse']
    assert worst < 1.2, f'audio queued up to {worst:.2f}s behind the live edge'
    # the old <audio src> ran dry ~4 times in this window; one is allowed
    # for a busy CI runner's scheduling, not for the 2s lumps
    assert r['waits'] <= 1, f"ran dry {r['waits']} times"
    # media time keeps pace with the wall clock: no drift
    assert abs(r['lag'] - first['lag']) < 0.4

    # a stall (the element held up for 3s) is skipped, not kept
    _vm(guest).evaluate("vm => vm._partyAudio.pause()")
    time.sleep(3)
    _vm(guest).evaluate("vm => { vm._partyAudio.play(); }")
    time.sleep(1.5)
    r = _vm(guest).evaluate(probe)
    assert r['ahead'] < 1.2 and abs(r['lag'] - first['lag']) < 0.6
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
    r = _run(page, [0.4, 0.5, 0.6, 0.4, 0.5, 0.6], mse=True)
    assert r['rate'] == 1 and abs(r['ahead'] - 0.6) < 1e-9


def test_mse_a_little_behind_plays_it_off(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [1.4] * 4, mse=True)                   # 1s over: +10%, no skip
    assert abs(r['rate'] - 1.1) < 1e-9 and abs(r['ahead'] - 1.4) < 1e-9


def test_mse_far_behind_skips_to_the_edge(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [3.0], mse=True)
    assert r['rate'] == 1 and abs(r['ahead'] - 0.4) < 1e-9 and not r['reconnected']


def test_mse_late_joiner_starts_at_the_edge(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    # the playhead at 0, the first blocks stamped minutes in
    r = _vm(page).evaluate("""vm => { const a = { paused: false, currentTime: 0, playbackRate: 1, _mse: {},
        buffered: { length: 1, start: () => 300, end: () => 300.5 } };
      vm._chasePartyAudioEdge(a); return a.currentTime; }""")
    assert abs(r - 300.1) < 1e-9


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
