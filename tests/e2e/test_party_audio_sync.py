"""
The party page's 🔊 listen keeps its <audio> near the live edge (see
vue-app.js _chasePartyAudioEdge). The picture is MJPEG and always live;
an <audio> on a live file never skips, so every stall left it further
behind for good -- the drift a fixed ⏱ offset can't follow. These drive
the chaser with a stand-in element whose buffered/currentTime are set by
hand, so each case is exact rather than timing-dependent.
"""


def _vm(page):
    return page.evaluate_handle(
        "document.getElementById('app').__vue_app__._container._vnode.component.proxy")


# readings: one buffered-ahead value per 500ms tick, in order
_RUN = """(vm, readings) => {
  let played = 0;
  const a = { paused: false, readyState: 4, currentTime: 0, playbackRate: 1,
              src: '/api/orbit-audio?_=1', play() { played++; return Promise.resolve(); } };
  for (const ahead of readings) {
    a.currentTime += 0.5;
    a.buffered = { length: 1, end: () => a.currentTime + ahead };
    vm._chasePartyAudioEdge(a);
  }
  return { rate: a.playbackRate, reconnected: a.src !== '/api/orbit-audio?_=1', played };
}"""


def _run(page, readings):
    return _vm(page).evaluate(_RUN, readings)


def test_near_the_edge_plays_at_normal_speed(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    # Chrome's own sawtooth: ~1s chunks landing on a 0.3s floor
    r = _run(page, [1.3, 0.3, 1.3, 0.3, 1.3, 0.3])
    assert r == {'rate': 1, 'reconnected': False, 'played': 0}


def test_waits_for_a_full_window_before_acting(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    assert _run(page, [1.5] * 5)['rate'] == 1


def test_a_little_behind_speeds_up_gently_then_settles(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [2.1, 1.1, 2.1, 1.1, 2.1, 1.1])        # floor 1.1s: 0.6 over target
    assert abs(r['rate'] - 1.06) < 1e-9 and not r['reconnected']
    assert _run(page, [1.9] * 6)['rate'] == 1.08          # capped
    r = _run(page, [1.9] * 6 + [0.5] * 6)                 # caught up: back to 1x
    assert r['rate'] == 1


def test_a_single_high_reading_is_not_a_backlog(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    assert _run(page, [0.4, 0.4, 3.0, 0.4, 0.4, 0.4])['rate'] == 1


def test_seconds_behind_reconnects_to_the_live_edge(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _run(page, [2.6] * 6)
    assert r == {'rate': 1, 'reconnected': True, 'played': 1}


def test_starved_element_is_left_alone(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    r = _vm(page).evaluate("""vm => { const a = { paused: false, readyState: 2, playbackRate: 1,
        buffered: { length: 1, end: () => 9 }, currentTime: 0 };
      for (let i = 0; i < 8; i++) vm._chasePartyAudioEdge(a); return [a.playbackRate, !!a._aheadHist]; }""")
    assert r == [1, False]
