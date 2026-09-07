"""
The Orbit Visualizer's own keyboard bindings, now that it's inline
markup + orbit_visualizer.js instead of a standalone page loaded into an
<iframe> (see orbit_visualizer.js's own docstring for why that changed).
There's no separate document to navigate to anymore -- this goes through
the same open-the-player-then-click-🌀 flow a real user would, via
test_golden_path's own _download_and_play helper, and asserts against
observable DOM state (which button has .active, what a slider's value
is) rather than reaching into orbit_visualizer.js's internals: its per-open
state now lives inside an IIFE closure specifically so nothing outside
orbit_visualizer.js itself can see it, the same reason a plain
`page.evaluate('() => vizMode')` (which the old iframe-page version of
this test used, back when vizMode really was a page-global) doesn't work
against it anymore.
"""
import re

import pytest

from test_golden_path import _download_and_play


def _open_orbit_viz(page):
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')


def _set_range(page, selector, value):
    # range inputs aren't text fields -- setting .value directly and
    # dispatching 'input' (what a real drag fires) is the reliable way
    # to change one via Playwright, same as a user dragging the thumb to
    # an exact spot would trigger
    page.locator(selector).evaluate(
        '(el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }', value)


def test_ascii_mode_renders_several_frames_with_no_console_errors(page, golden_path_server):
    """Real regression risk: ASCII's draw branch now also drawImage()s
    the sampled video frame as a dimmed background (see its own comment
    in orbit_visualizer.js on why -- a flat black fill behind sparse
    glyphs read much darker than the source video actually was) before
    drawing any glyphs. A canvas draw call throwing inside
    requestAnimationFrame fails silently -- no crash, the loop just
    quietly stops -- so this explicitly watches for a JS error while
    real frames render in the default (ASCII) mode against a real
    playing video, rather than trusting an absence of visible failure."""
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)

    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.wait_for_timeout(500)  # several draw frames at real animation-frame speed

    assert errors == []


def test_new_modes_render_several_frames_with_no_console_errors(page, golden_path_server):
    """Plasma/Kaleido/Particles/Freefall (added alongside the original
    seven, per Ryan's "more visualizations"/"falling through infinite
    buildings" asks -- hand-rolled canvas 2D, no new dependency, same
    reasoning as everything else in this file) each get a real
    animation-frame run against a real playing video, watching for a JS
    error the same way the ASCII regression test above does."""
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)

    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    for mode in ('plasma', 'kaleido', 'particles', 'freefall'):
        page.click(f'[data-viz="{mode}"]')
        page.wait_for_timeout(400)
        # each mode recycles (particles wrap, buildings respawn past
        # dist=1) -- running long enough for at least one recycle to
        # happen catches an error in that path too, not just steady state
        page.wait_for_timeout(400)

    assert errors == []


def test_speed_reactivity_and_zoom_sliders_update_their_own_labels(page, golden_path_server):
    """Real ask: sliders for tuning "interesting params" of the
    visualizer, global rather than mode-specific like ASCII's own Res/
    Bri -- Speed (retunes every mode's own animation rate) and
    Reactivity (retunes how much audio energy affects the visuals) are
    new; Zoom is the existing scroll-to-zoom vizUserScale exposed as a
    slider too. This checks the label text next to each slider updates
    to match, the same way ASCII's own Res/Bri labels already do."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    _set_range(page, '#speedSlider', '2.5')
    assert page.locator('#speedVal').inner_text() == '2.5x'

    _set_range(page, '#reactivitySlider', '0.4')
    assert page.locator('#reactivityVal').inner_text() == '0.4x'

    _set_range(page, '#zoomSlider', '3')
    assert page.locator('#zoomVal').inner_text() == '3.00x'


def test_freefall_dimension_sliders_show_only_in_freefall_and_update_labels(page, golden_path_server):
    """Real ask: sliders for the building dimensions in Freefall --
    Width/Height retune every building on screen live, Count grows/
    shrinks the ring itself (see buildingWidthScale's own comment in the
    state object). Mode-specific like ASCII's own Res/Bri, not global
    like Speed/Reactivity/Zoom: shown only while Freefall is active."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    controls = page.locator('#freefallControls')
    assert not controls.is_visible()  # default mode is ASCII, not Freefall

    page.click('[data-viz="freefall"]')
    assert controls.is_visible()

    _set_range(page, '#buildingWidthSlider', '2.2')
    assert page.locator('#buildingWidthVal').inner_text() == '2.2x'

    _set_range(page, '#buildingHeightSlider', '0.5')
    assert page.locator('#buildingHeightVal').inner_text() == '0.5x'

    _set_range(page, '#buildingCountSlider', '90')
    assert page.locator('#buildingCountVal').inner_text() == '90'

    # switching away hides it again, same as ASCII's own controls row
    page.click('[data-viz="tunnel"]')
    assert not controls.is_visible()


def test_scroll_zoom_and_the_zoom_slider_stay_in_sync(page, golden_path_server):
    """Real risk: the Zoom slider and scroll-to-zoom both write
    s.vizUserScale, through two different code paths (setZoom() and the
    wheel handler) -- if the wheel handler didn't also call setZoom(),
    scrolling would change the actual zoom level while leaving the
    slider showing a stale value next to it."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    # reads the slider value and its label together in one JS round trip
    # -- mouse.wheel() can synthesize more than one discrete wheel event
    # per call, each one calling setZoom() again, so two separate
    # Python-side calls (slider first, label second) can straddle two
    # different updates and see a slider/label pair that never actually
    # coexisted, even though the two are always written atomically
    # together inside setZoom() itself.
    def read_zoom():
        slider_value, label_text = page.evaluate(
            "() => [document.getElementById('zoomSlider').value, document.getElementById('zoomVal').textContent]")
        return float(slider_value), label_text

    before, _ = read_zoom()
    page.locator('#vizCanvas').hover()
    page.mouse.wheel(0, -400)  # negative deltaY == zoom in, per the wheel handler
    # mouse.wheel() can return before the renderer has actually finished
    # dispatching/handling the synthesized wheel event(s) -- a short
    # settle avoids racing that, not a real product timing dependency
    page.wait_for_timeout(100)
    after, label = read_zoom()
    assert after > before
    assert label == f'{after:.2f}x'

    # double-click resets pan/zoom -- the slider should snap back to 1.00x too
    page.locator('#vizCanvas').dblclick()
    reset_value, reset_label = read_zoom()
    assert reset_value == pytest.approx(1.0, abs=0.01)
    assert reset_label == '1.00x'


def test_shift_digit_keys_jump_directly_to_a_viz_mode(page, golden_path_server):
    """Real ask: number keys should jump straight to a mode instead of
    only being reachable by clicking a button or, in fullscreen, cycling
    one step at a time with arrow keys. Shift+digit, not a bare digit or
    Numpad (both tried and rejected before this -- see
    test_bare_digit_keys_do_not_jump_modes_and_still_switch_tabs below
    for why)."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    # VIZ_MODES = ['tunnel','bars','mirror','scope','spiral','pixels',
    # 'ascii','plasma','kaleido','particles'] -- '3' is the third button,
    # MIRROR
    page.keyboard.press('Shift+Digit3')
    assert page.locator('[data-viz="mirror"]').evaluate('el => el.classList.contains("active")')
    assert not page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("active")')
    # switching away from ascii hides its controls row -- confirms the
    # number-key jump runs the same setVizMode bookkeeping the mouse
    # click handler does, not a stripped-down copy of it
    assert not page.locator('#asciiControls').is_visible()

    # jump back to ASCII (7th button) directly, not by cycling through
    # every mode in between
    page.keyboard.press('Shift+Digit7')
    assert page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("active")')
    assert page.locator('#asciiControls').is_visible()

    # the three new modes (8/9/10th) -- Digit0 is the 10th, not "0th"
    # (see setVizMode's own caller for the raw-to-n mapping)
    page.keyboard.press('Shift+Digit8')
    assert page.locator('[data-viz="plasma"]').evaluate('el => el.classList.contains("active")')
    page.keyboard.press('Shift+Digit9')
    assert page.locator('[data-viz="kaleido"]').evaluate('el => el.classList.contains("active")')
    page.keyboard.press('Shift+Digit0')
    assert page.locator('[data-viz="particles"]').evaluate('el => el.classList.contains("active")')

    # doesn't also switch tabs -- Shift+Digit3's e.key is '#' (US layout),
    # not '3', so vue-app.js's tabByDigit lookup (keyed on e.key) never
    # matches it at all; still on Discover, not Downloads
    assert 'active' in (page.locator('.tab-btn:has-text("Discover")').get_attribute('class') or '')


def test_bare_digit_keys_do_not_jump_modes_and_still_switch_tabs(page, golden_path_server):
    """Real reports, in order: with the visualizer inline (not an
    <iframe> with its own separate document -- see orbit_visualizer.js's
    own docstring), its keydown listener and vue-app.js's own
    onGlobalKeydown both sit on the same document.

    First attempt, bare top-row digits: onGlobalKeydown treats bare
    '1'-'5' as "switch to tab N" with no easterEggVisible guard at all,
    so pressing '1' to jump to Tunnel also silently switched the main
    app to the Discover tab underneath.

    Second attempt, Numpad: no collision, but unreachable on most
    laptops, which have no physical numpad at all.

    Shift+Digit (see test_shift_digit_keys_jump_directly_to_a_viz_mode)
    is the one that actually works everywhere: this confirms a *bare*
    digit still does only its one normal job (switching tabs), not a
    leftover mode-jump alongside it."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    page.keyboard.press('Digit3')
    # still ASCII (the default) -- a bare digit doesn't jump modes
    assert page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("active")')
    # its other, real job (switching tabs) still fires -- '3' is Downloads
    assert 'active' in (page.locator('.tab-btn:has-text("Downloads")').get_attribute('class') or '')


def test_arrow_and_bracket_keys_adjust_brightness_and_resolution(page, golden_path_server):
    """Real ask: brightness (ASCII's BRI slider) and resolution (its RES
    slider) should be keyboard-adjustable, not mouse-only -- and the
    on-screen slider itself should reflect the new value, since
    setAsciiBrightness/setAsciiRes are shared with the slider's own
    'input' handler for exactly that reason."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    assert page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("active")')  # default mode

    bri_slider = page.locator('#asciiBriSlider')
    before_bri = float(bri_slider.input_value())
    page.keyboard.press('ArrowUp')
    after_bri = float(bri_slider.input_value())
    assert after_bri == pytest.approx(before_bri + 0.1, abs=0.01)
    assert page.locator('#asciiBriVal').inner_text() == f'{after_bri:.1f}x'

    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowDown')
    assert float(bri_slider.input_value()) == pytest.approx(before_bri - 0.1, abs=0.01)

    res_slider = page.locator('#asciiResSlider')
    before_res = int(res_slider.input_value())
    page.keyboard.press('BracketRight')
    after_res = int(res_slider.input_value())
    assert after_res == before_res + 1

    page.keyboard.press('BracketLeft')
    assert int(res_slider.input_value()) == before_res

    # clamped, not wrapped -- five more decrements than the 1-4 range
    # allows should leave it pinned at the minimum, not go negative
    for _ in range(5):
        page.keyboard.press('BracketLeft')
    assert int(res_slider.input_value()) == 1


def test_back_button_closes_without_a_postmessage_round_trip(page, golden_path_server):
    """Real regression risk in this refactor: the old iframe's BACK
    button posted 'orbit:back' up to the parent window for vue-app.js to
    catch. Inlining the visualizer means that button is now a plain Vue
    @click -- confirms it still actually closes the dialog, not that a
    postMessage handler nobody's listening for anymore still no-ops
    successfully."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#orbit-egg-dialog button:has-text("Back")')
    page.wait_for_selector('#orbit-egg-dialog', state='detached')
    assert page.locator('#global-player').is_visible()


def test_reopening_the_visualizer_does_not_duplicate_document_keydown_handling(page, golden_path_server):
    """Real risk specific to no longer being a fresh iframe load each
    time: orbit_visualizer.js's init() attaches a document-level keydown
    listener, and index.html's v-if destroys/recreates the dialog's DOM
    on every open/close. Without teardown() actually removing that
    listener on close, a second open would stack a second one, and one
    ArrowUp press would then bump brightness by 0.2 instead of 0.1."""
    _download_and_play(page, golden_path_server)

    _open_orbit_viz(page)
    page.locator('#orbit-egg-backdrop').click(position={'x': 5, 'y': 5})
    page.wait_for_selector('#orbit-egg-dialog', state='detached')

    _open_orbit_viz(page)
    bri_slider = page.locator('#asciiBriSlider')
    before = float(bri_slider.input_value())
    page.keyboard.press('ArrowUp')
    after = float(bri_slider.input_value())
    assert after == pytest.approx(before + 0.1, abs=0.01)


def test_midi_panel_stays_folded_on_open_even_when_already_permitted(page, golden_path_server):
    """Ryan: "when I open the orbit visualizer, the MIDI key assignments
    are shown expanded." orbit_midi.js auto-connects when the browser
    remembers a granted MIDI permission (so pads work without a click),
    and mount() used to treat "connected" as "show the panel", so every
    open started with the whole binding list unfolded. The panel is a
    settings surface: folded on every open, until the 🎹 click, and
    folded again on the next open regardless of what the last one did.
    Fake a remembered grant plus a device so the auto-connect path is
    the one exercised."""
    page.add_init_script("""
      const input = { id: 'in1', name: 'MPK mini IV', state: 'connected', onmidimessage: null };
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
      const realQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => d && d.name === 'midi' ? Promise.resolve({ state: 'granted' }) : realQuery(d);
    """)
    _download_and_play(page, golden_path_server)

    _open_orbit_viz(page)
    page.wait_for_function("() => /listening to MPK mini IV/.test(document.getElementById('midiStatus').textContent)")
    panel = page.locator('#midiPanel')
    assert not panel.is_visible(), 'panel unfolded itself on open'
    assert 'active' not in (page.locator('#vizMidiBtn').get_attribute('class') or '')

    page.click('#vizMidiBtn')
    assert panel.is_visible()
    assert page.locator('#midiPanel .midi-row').count() > 0

    page.locator('#orbit-egg-backdrop').click(position={'x': 5, 'y': 5})
    page.wait_for_selector('#orbit-egg-dialog', state='detached')
    _open_orbit_viz(page)
    assert not page.locator('#midiPanel').is_visible(), 'panel remembered being open across a close/reopen'


def test_middle_drag_rotates_shift_pans_ctrl_zooms_like_blender(page, golden_path_server):
    """Ryan: "could I hold middle-click and manipulate like Blender?"
    Middle-drag turns the view, shift+middle pans, ctrl+middle zooms
    (drag up = in); left-drag still pans; double-click resets all of it."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    box = page.locator('#vizCanvas').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    state = lambda: page.evaluate("() => window.orbitViz.debugState()")
    assert state()['rot'] == 0

    page.mouse.move(cx, cy); page.mouse.down(button='middle'); page.mouse.move(cx + 100, cy, steps=5); page.mouse.up(button='middle')
    rot = state()['rot']
    assert 0.3 < rot < 1.0, rot          # 100px * 0.006 rad/px
    assert state()['panX'] == 0          # a plain middle-drag does not pan

    page.keyboard.down('Shift')
    page.mouse.move(cx, cy); page.mouse.down(button='middle'); page.mouse.move(cx + 40, cy + 30, steps=4); page.mouse.up(button='middle')
    page.keyboard.up('Shift')
    st = state()
    assert st['panX'] > 0 and st['panY'] > 0 and st['rot'] == pytest.approx(rot)

    page.keyboard.down('Control')
    page.mouse.move(cx, cy); page.mouse.down(button='middle'); page.mouse.move(cx, cy - 80, steps=4); page.mouse.up(button='middle')
    page.keyboard.up('Control')
    assert state()['zoom'] > 1.3          # dragging up zooms in
    assert float(page.locator('#zoomSlider').input_value()) > 1.3   # the slider followed

    # several frames render under the rotation with no errors
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.wait_for_timeout(300)
    assert errors == []

    page.mouse.dblclick(cx, cy)
    st = state()
    assert st['rot'] == 0 and st['panX'] == 0 and st['panY'] == 0 and st['zoom'] == 1.0


def test_midi_keymap_exports_to_a_file_and_imports_back(page, golden_path_server, tmp_path):
    """Ryan: "add the ability to export keymaps." The panel's export
    button downloads a .json of every row's learned control; import
    replaces the bindings from such a file, matching rows by id (or by
    target for a renamed row), leaving unmentioned rows unbound and
    keeping a plugin row's key dormant until its plugin is loaded."""
    page.add_init_script("""
      const input = { id: 'in1', name: 'MPK mini IV', state: 'connected', onmidimessage: null };
      window.__midi = { send: (bytes) => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(bytes) }) };
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
    """)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizMidiBtn')
    page.wait_for_function("() => /listening to MPK mini IV/.test(document.getElementById('midiStatus').textContent)")
    # learn a knob onto Zoom (CC 28) so the export has something non-default in it
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile('^K3$')))
    row.locator('button', has_text='learn').click()
    page.evaluate("() => window.__midi.send([0xB0, 28, 10])")

    with page.expect_download() as dl:
        page.click('#midiExportBtn')
    download = dl.value
    assert download.suggested_filename.startswith('weed-orbit-keymap-MPK_mini_IV-') and download.suggested_filename.endswith('.json')
    path = tmp_path / 'keymap.json'
    download.save_as(str(path))
    import json
    data = json.loads(path.read_text())
    assert data['format'] == 'weed.orbit.midi-keymap' and data['device'] == 'MPK mini IV'
    k3 = next(b for b in data['bindings'] if b['id'] == 'k3')
    assert k3 == {'id': 'k3', 'target': 'param:zoom', 'label': 'K3', 'key': 'c0:28', 'relative': False}
    assert any(b['id'] == 'mode:halftone' for b in data['bindings'])   # plugin rows travel too

    # wipe, then import the file through the real file input
    page.click('#midiResetBtn')
    assert page.evaluate("() => window.orbitMidi.exportKeymap().bindings.find(b => b.id === 'k3').key") == 'c*:72'
    page.locator('#midiImportFile').set_input_files(str(path))
    page.wait_for_function("() => window.orbitMidi.exportKeymap().bindings.find(b => b.id === 'k3').key === 'c0:28'")
    assert 'imported' in page.locator('#midiLast').inner_text()
    # and it took effect: the learned knob drives zoom again (a mid-range
    # value first: the encoder auto-detection holds a lone end-stop value
    # from an undecided knob rather than applying it -- see orbit_midi.js)
    page.evaluate("() => { window.__midi.send([0xB0, 28, 100]); window.__midi.send([0xB0, 28, 127]); }")
    page.wait_for_function("() => parseFloat(document.getElementById('zoomSlider').value) > 7")

    # a file with an unknown id but a known target still lands; junk is refused
    n = page.evaluate("""() => window.orbitMidi.importKeymap({ format: 'weed.orbit.midi-keymap', version: 1,
        bindings: [{ id: 'renamed-row', target: 'param:speed', key: 'n*:60' }, { id: 'mode:not-loaded', target: 'mode:not-loaded', key: 'n*:61' }] })""")
    assert n == 1
    exported = page.evaluate("() => window.orbitMidi.exportKeymap().bindings")
    assert next(b for b in exported if b['id'] == 'k1')['key'] == 'n*:60'
    assert next(b for b in exported if b['id'] == 'k3')['key'] is None
    assert page.evaluate("() => { try { window.orbitMidi.importKeymap({ hello: 1 }); return 'accepted'; } catch (e) { return e.message; } }") == 'not a weed Orbit keymap file'


def test_an_undecided_encoder_on_an_action_row_fires_on_its_first_click(page, golden_path_server):
    """Ryan: "I'm having to turn a knob 2 times to have it take effect
    when bound to video only (toggle)". The encoder auto-detection held
    the first few step-looking values of an undecided knob -- right for
    a slider, pointless for an action, where a held click is a click
    that did nothing. An action row now takes the very first click."""
    page.add_init_script("""
      const input = { id: 'in1', name: 'MPK mini IV', state: 'connected', onmidimessage: null };
      window.__midi = { send: (bytes) => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(bytes) }) };
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
    """)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizMidiBtn')
    page.wait_for_function("() => /listening to MPK mini IV/.test(document.getElementById('midiStatus').textContent)")
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile(r'^Pad 12')))   # video only (toggle)
    row.locator('button', has_text='learn').click()
    page.evaluate("() => window.__midi.send([0xB0, 14, 1])")          # learned, fresh encoder, one click seen
    lit = lambda: page.evaluate("() => document.querySelectorAll('#vizModes .active').length")
    assert lit() == 1
    page.evaluate("() => window.__midi.send([0xB0, 14, 1])")          # the first real click: video only
    assert lit() == 0
    page.evaluate("() => window.__midi.send([0xB0, 14, 1])")          # and straight back
    assert lit() == 1
    # a parameter row still gets the protective hold: one lone click on
    # an undecided knob must not slam Speed to an end stop
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile(r'^K1$')))
    row.locator('button', has_text='learn').click()
    page.evaluate("() => window.__midi.send([0xB0, 15, 1])")
    page.evaluate("() => window.__midi.send([0xB0, 15, 1])")
    assert page.locator('#speedVal').inner_text() == '1.0x'


def test_an_encoder_on_the_mode_selector_never_skips_a_mode(page, golden_path_server):
    """Ryan: "Tunnel is getting skipped by my mode sweep knob", then "the
    smallest turn of the knob causes change to multiple char sets". The
    selector used to map an encoder onto a 0..1 position and pick by
    position, so some modes took one click and some two and a quick turn
    could hop over one. Now every three clicks move exactly one entry,
    clamped at both ends: nothing is ever skipped, and a nudge that sends
    a message or two changes nothing. A fast spin (bigger steps) counts
    its size, so it still gets down the list."""
    page.add_init_script("""
      const input = { id: 'in1', name: 'MPK mini IV', state: 'connected', onmidimessage: null };
      window.__midi = { send: (bytes) => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(bytes) }) };
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
    """)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizMidiBtn')
    page.wait_for_function("() => /listening to MPK mini IV/.test(document.getElementById('midiStatus').textContent)")
    modes = page.evaluate("() => window.orbitViz.modes()")
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile('^Mode$')))
    row.locator('button', has_text='learn').click()
    # settle the detector as relative with a few clicks, then start from a known mode
    for _ in range(4): page.evaluate("() => window.__midi.send([0xB0, 20, 1])")
    page.click('[data-viz="ascii"]')
    current = lambda: page.evaluate("() => window.orbitViz.current().mode")
    start = modes.index('ascii')
    seen = []
    for _ in range(24):
        page.evaluate("() => window.__midi.send([0xB0, 20, 127])")     # one counter-clockwise click
        seen.append(current())
    # three clicks per entry, so the mode changes on every third message and only then
    assert seen[:6] == [modes[start], modes[start], modes[start - 1], modes[start - 1], modes[start - 1], modes[start - 2]], seen[:6]
    assert seen[2::3] == [modes[start - 1], modes[start - 2], modes[start - 3], modes[start - 4], modes[start - 5], 'tunnel', 'tunnel', 'tunnel'], seen[2::3]
    for _ in range(2):
        page.evaluate("() => window.__midi.send([0xB0, 20, 1])")       # a direction change starts a fresh count
    assert current() == 'tunnel'
    page.evaluate("() => window.__midi.send([0xB0, 20, 1])")
    assert current() == modes[1]
    page.evaluate("() => window.__midi.send([0xB0, 20, 6])")           # a fast spin: two entries at once
    assert current() == modes[3]


def test_knobs_have_a_detent_at_home_and_ascii_sets_take_a_deliberate_twist(page, golden_path_server):
    """Ryan: "some of the knobs can be difficult to get back to exactly
    (e.g. center for rotation). Can we implement a small deadzone ... or
    in e.g. switching chars mode in ASCII, it's too sensitive". A pot's
    middle is 64/127, not 0.5, and an encoder's clicks from wherever a
    drag left the rotation never hit zero. Now a pot within a few values
    of the home reads as exactly the home, an encoder click that crosses
    it stops on it, and the ASCII chars selector moves one set per three
    clicks."""
    page.add_init_script("""
      const input = { id: 'in1', name: 'MPK mini IV', state: 'connected', onmidimessage: null };
      window.__midi = { send: (bytes) => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(bytes) }) };
      navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
    """)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizMidiBtn')
    page.wait_for_function("() => /listening to MPK mini IV/.test(document.getElementById('midiStatus').textContent)")
    rot = lambda: page.evaluate("() => window.orbitViz.controlPosition('rotate')")   # 0.5 is straight
    # a pot on Rotate: the values around the middle all read as exactly straight
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile('^Rotate$')))
    row.locator('button', has_text='learn').click()
    page.evaluate("() => window.__midi.send([0xB0, 30, 100])")        # learned; a mid value settles it as a pot
    page.evaluate("() => window.__midi.send([0xB0, 30, 100])")
    assert rot() > 0.7
    for v in (64, 62, 66, 67, 61):
        page.evaluate(f"() => window.__midi.send([0xB0, 30, {v}])")
        assert rot() == 0.5, (v, rot())
    page.evaluate("() => window.__midi.send([0xB0, 30, 70])")
    assert rot() > 0.5
    # an encoder on Rotate, from an angle a mouse drag left it at: clicks toward straight stop exactly on it
    page.evaluate("() => window.orbitViz.control('rotate', 0.53)")
    row.locator('button', has_text='learn').click()
    for _ in range(4): page.evaluate("() => window.__midi.send([0xB0, 31, 127])")   # settles as relative; 4 clicks down cross the detent
    assert rot() == 0.5
    page.evaluate("() => window.__midi.send([0xB0, 31, 127])")        # the next click leaves it
    assert rot() < 0.5
    page.evaluate("() => window.__midi.send([0xB0, 31, 1])")          # and one back lands on it again
    assert rot() == 0.5
    page.evaluate("() => window.__midi.send([0xB0, 31, 1])")
    assert rot() > 0.5
    # ASCII chars on an encoder: one set per three clicks
    page.click('[data-viz="ascii"]')
    ramps = page.evaluate("() => window.orbitViz.asciiRamps()")
    row = page.locator('.midi-row').filter(has=page.locator('.midi-label', has_text=re.compile('^ASCII chars')))
    row.locator('button', has_text='learn').click()
    for _ in range(4): page.evaluate("() => window.__midi.send([0xB0, 32, 1])")     # settle; the 4th counts as the first click
    ramp = lambda: page.evaluate("() => window.orbitViz.current().asciiRamp")
    first = ramp()
    page.evaluate("() => window.__midi.send([0xB0, 32, 1])")
    assert ramp() == first
    page.evaluate("() => window.__midi.send([0xB0, 32, 1])")
    assert ramp() == ramps[ramps.index(first) + 1]
    for _ in range(2): page.evaluate("() => window.__midi.send([0xB0, 32, 1])")
    assert ramp() == ramps[ramps.index(first) + 1]
    page.evaluate("() => window.__midi.send([0xB0, 32, 1])")
    assert ramp() == ramps[ramps.index(first) + 2]


def test_autopilot_alternates_modes_and_plain_video_on_the_music(page, golden_path_server):
    """Ryan: "an Autopilot feature that will automatically choose modes/
    transitions based on the beat/music ... and continues to go back to
    video only after each mode", toggled from the dialog's transport.
    With the phases shortened to test length and a beat fed in, the
    visualizer walks mode -> video only -> a different mode -> video only,
    each switch through a transition, and the toggle persists."""
    page.add_init_script("""
      let a = 0;
      AnalyserNode.prototype.getByteFrequencyData = function (arr) { a++; const beat = a % 24; const kick = beat < 3 ? 1.5 : 1;
        for (let i = 0; i < arr.length; i++) { const lo = i < arr.length * 0.06 ? kick : 1; arr[i] = Math.min(255, 160 * Math.exp(-i / (arr.length / 6)) * lo + 25 + Math.random() * 15); } };
      AnalyserNode.prototype.getByteTimeDomainData = function (arr) { for (let i = 0; i < arr.length; i++) arr[i] = 128 + 40 * Math.sin(i * 0.1 + a * 0.4); };
    """)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    assert not page.is_checked('#autopilotToggle')
    assert page.evaluate("() => window.orbitViz.autopilot()") is False
    page.evaluate("() => window.orbitViz.setAutopilotTiming({ modeMin: 0.3, modeMax: 0.6, videoMin: 0.3, videoMax: 0.6 })")
    page.check('#autopilotToggle')
    assert page.evaluate("() => window.orbitViz.autopilot()") is True
    seen, transitions = [], 0
    for _ in range(40):
        page.wait_for_timeout(100)
        d = page.evaluate("() => window.orbitViz.debugState()")
        state = 'video' if d['vizOff'] else d['mode']
        if not seen or seen[-1] != state: seen.append(state)
        if d['trans']: transitions += 1
    # mode / video / mode / video ..., never the same mode twice running
    assert len(seen) >= 4, seen
    for i in range(1, len(seen)):
        assert (seen[i] == 'video') != (seen[i - 1] == 'video'), seen
    modes = [x for x in seen if x != 'video']
    assert len(set(modes)) == len(modes), seen
    assert transitions > 0
    # persists like the other settings, readable with the dialog closed
    page.wait_for_timeout(300)
    page.locator('#orbit-egg-backdrop').click(position={'x': 5, 'y': 5})
    page.wait_for_selector('#orbit-egg-dialog', state='detached')
    assert page.evaluate("() => window.orbitViz.autopilot()") is True
    _open_orbit_viz(page)
    assert page.is_checked('#autopilotToggle')
