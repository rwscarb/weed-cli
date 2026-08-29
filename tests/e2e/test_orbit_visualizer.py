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
import pytest

from test_golden_path import _download_and_play


def _open_orbit_viz(page):
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')


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


def test_shift_digit_keys_jump_directly_to_a_viz_mode(page, golden_path_server):
    """Real ask: number keys should jump straight to a mode instead of
    only being reachable by clicking a button or, in fullscreen, cycling
    one step at a time with arrow keys. Shift+digit, not a bare digit or
    Numpad (both tried and rejected before this -- see
    test_bare_digit_keys_do_not_jump_modes_and_still_switch_tabs below
    for why)."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    # VIZ_MODES = ['tunnel','bars','mirror','scope','spiral','pixels','ascii']
    # -- '3' is the third button, MIRROR
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

    # out-of-range digits (8/9/0) are simply ignored, not an error and
    # not wrapping around to some other mode
    page.keyboard.press('Shift+Digit9')
    assert page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("active")')

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
