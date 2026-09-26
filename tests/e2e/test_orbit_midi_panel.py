"""
The 🎹 panel's key assignments. They used to flow into two or three
side-by-side columns depending on how wide the panel happened to be
(each too narrow to say what the row does), and every MIDI message
rebuilt the list and threw it back to the top -- touch the controller
and the row you'd scrolled to was gone.
"""
import json
import os

from test_golden_path import _download_and_play
from test_orbit_visualizer import _open_orbit_viz

SHOTS = os.environ.get('WEED_TEST_SHOTS')   # optional: a folder to save screenshots in


# the four ports an MPK mini IV shows up as -- the long "listening to …"
# line they make is what used to widen the panel into two columns
PORTS = ['MPK mini IV MIDI Port', 'MPK mini IV DAW Port', 'MPK mini IV Plugin Port', 'MPK mini IV Software Control Port']


def _open_midi_panel(page, golden_path_server):
    page.add_init_script("""
      const inputs = new Map(%s.map((name, i) => ['in' + i, { id: 'in' + i, name, state: 'connected', onmidimessage: null }]));
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs, outputs: new Map(), onstatechange: null });
    """ % json.dumps(PORTS))
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizMidiBtn')
    page.wait_for_function("() => /Software Control Port/.test(document.getElementById('midiStatus').textContent)")
    page.wait_for_selector('#midiBindings .midi-row')


def test_rows_stack_in_one_column_with_room_for_what_they_do(page, golden_path_server):
    _open_midi_panel(page, golden_path_server)
    rows = page.evaluate("""() => [...document.querySelectorAll('#midiBindings .midi-row')].map(r => {
        const b = r.getBoundingClientRect(), w = r.querySelector('.midi-what');
        return { left: Math.round(b.left), width: b.width, clipped: w.scrollWidth > w.clientWidth + 1 };
    })""")
    assert len(rows) > 20
    assert len({r['left'] for r in rows}) == 1, 'rows sit side by side in more than one column'
    avail = page.locator('#orbit-egg-dialog .viz-controls').bounding_box()
    assert rows[0]['width'] > avail['width'] * 0.9, (rows[0], avail)   # full width, not a shrink-wrapped centred box
    assert not any(r['clipped'] for r in rows[:20])     # "mode: tunnel", not "m…"
    list_ = page.evaluate("() => { const l = document.getElementById('midiBindings'); return [l.scrollWidth, l.clientWidth]; }")
    assert list_[0] <= list_[1] + 1, list_                # no sideways scrolling
    if SHOTS: page.locator('#midiPanel').screenshot(path=os.path.join(SHOTS, 'midi-desktop.png'))


def test_a_midi_message_does_not_throw_the_list_back_to_the_top(page, golden_path_server):
    _open_midi_panel(page, golden_path_server)
    page.evaluate("() => { document.getElementById('midiBindings').scrollTop = 200; }")
    top = page.evaluate("() => document.getElementById('midiBindings').scrollTop")
    assert top > 0
    for v in (64, 65, 66, 1):   # a knob turning (CC 28, channel 1)
        page.evaluate("(v) => window.orbitMidi._onMessage({ data: [0xB0, 28, v] })", v)
    assert page.evaluate("() => document.getElementById('midiBindings').scrollTop") == top
    assert 'CC 28' in page.locator('#midiLast').inner_text()
    page.evaluate("() => window.orbitMidi.refresh()")   # a full rebuild keeps it too
    assert page.evaluate("() => document.getElementById('midiBindings').scrollTop") == top


def test_the_filter_narrows_the_rows(page, golden_path_server):
    _open_midi_panel(page, golden_path_server)
    total = page.locator('#midiBindings .midi-row').count()
    page.fill('#midiFilter', 'pad 5')
    labels = page.locator('#midiBindings .midi-label').all_inner_texts()
    assert labels and all('pad 5' in l.lower() for l in labels) and len(labels) < total
    page.fill('#midiFilter', 'zzz-nothing')
    assert page.locator('#midiBindings .midi-row').count() == 0
    assert 'no rows match' in page.locator('#midiBindings').inner_text()
    page.fill('#midiFilter', '')
    assert page.locator('#midiBindings .midi-row').count() == total


def test_the_panel_fits_a_phone(page, golden_path_server):
    _open_midi_panel(page, golden_path_server)
    page.set_viewport_size({'width': 375, 'height': 812})
    page.wait_for_timeout(300)
    over = page.evaluate("""() => { const l = document.getElementById('midiBindings');
        return [...l.querySelectorAll('.midi-row')].filter(r => r.getBoundingClientRect().right > innerWidth + 1).length; }""")
    assert over == 0
    if SHOTS:
        page.locator('#midiPanel').scroll_into_view_if_needed()
        page.locator('#midiPanel').screenshot(path=os.path.join(SHOTS, 'midi-phone.png'))


def test_knobs_drive_volume_and_the_filters(page, golden_path_server):
    """Volume, the DJ filter, the separate cutoffs and resonance: rows
    like any other, reaching the player's sound through window.orbitAudio
    and the Web Audio graph's filters."""
    _open_midi_panel(page, golden_path_server)
    targets = {b['id']: b['target'] for b in page.evaluate("() => window.orbitMidi.bindings()")}
    for row in ('kVol', 'kFilter', 'kLowpass', 'kHighpass', 'kReso', 'actMute', 'actFxReset'):
        assert row in targets
    page.evaluate("""() => window.orbitMidi.importKeymap({ format: 'weed.orbit.midi-keymap', version: 1, bindings: [
        { id: 'kVol', key: 'c0:20' }, { id: 'kFilter', key: 'c0:21' }, { id: 'kLowpass', key: 'c0:22' },
        { id: 'kReso', key: 'c0:23' }, { id: 'actMute', key: 'n0:60' }, { id: 'actFxReset', key: 'n0:61' } ] })""")
    cc = lambda n, v: page.evaluate("([n, v]) => window.orbitMidi._onMessage({ data: [0xB0, n, v] })", [n, v])
    note = lambda n: page.evaluate("(n) => window.orbitMidi._onMessage({ data: [0x90, n, 100] })", n)
    vm = "document.getElementById('app').__vue_app__._container._vnode.component.proxy"
    graph = lambda: page.evaluate(f"""() => {{ const g = {vm}._orbitAnalyser;
        return {{ lp: g.lowpass.frequency.value, hp: g.highpass.frequency.value, q: g.lowpass.Q.value,
                 vol: {vm}.$refs.playerVideo.volume, muted: {vm}.$refs.playerVideo.muted }}; }}""")

    for v in (40, 50, 64):          # a pot sweeping (not step-looking values)
        cc(20, v)
    assert abs(graph()['vol'] - 64 / 127) < 0.01

    for v in (60, 50, 32):          # DJ filter left of centre: low-pass closes
        cc(21, v)
    page.wait_for_timeout(200)      # the cutoff glides
    g = graph()
    assert g['lp'] < 2000 and g['hp'] < 25, g
    for v in (80, 100, 112):        # right of centre: low-pass opens, high-pass rises
        cc(21, v)
    page.wait_for_timeout(200)
    g = graph()
    assert g['lp'] > 19000 and g['hp'] > 200, g
    for v in (80, 70, 66):          # near the middle: the detent parks it off
        cc(21, v)
    page.wait_for_timeout(200)
    assert page.evaluate("() => window.orbitAudio.position('filter')") == 0.5

    for v in (30, 50, 100):
        cc(23, v)
    page.wait_for_timeout(200)
    assert graph()['q'] > 3

    cc(22, 40); cc(22, 30); cc(22, 20)
    page.wait_for_timeout(200)
    assert graph()['lp'] < 500
    note(61)                        # "Filters off"
    page.wait_for_timeout(200)
    g = graph()
    assert g['lp'] > 19000 and g['hp'] < 25 and g['q'] < 1, g

    note(60)
    assert graph()['muted'] is True
    note(60)
    assert graph()['muted'] is False
