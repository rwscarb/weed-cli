"""
orbit_visualizer.html's own keyboard bindings -- it's a fully static,
dependency-free file (no audio/video feed needed to exercise mode
switching or the ASCII sliders, both of which are pure JS/DOM state), so
this navigates straight to it rather than going through the full
player-open flow test_golden_path.py's fixtures exist for. golden_path_server
is still the source of a real web_ui server to serve it from, since
static files are served by the same Handler as everything else (see
web_ui.py's _serve_static).
"""
import pytest


def test_number_keys_jump_directly_to_a_viz_mode(page, golden_path_server):
    """Real ask: number keys should jump straight to a mode instead of
    only being reachable by clicking a button or, in fullscreen, cycling
    one step at a time with arrow keys."""
    page.goto(golden_path_server['web_url'] + '/orbit_visualizer.html')
    page.wait_for_selector('#vizModes')

    # VIZ_MODES = ['tunnel','bars','mirror','scope','spiral','pixels','ascii']
    # -- '3' is the third button, MIRROR
    page.keyboard.press('Digit3')
    assert page.evaluate('() => vizMode') == 'mirror'
    assert page.locator('[data-viz="mirror"]').evaluate('el => el.classList.contains("lit")')
    assert not page.locator('[data-viz="ascii"]').evaluate('el => el.classList.contains("lit")')
    # switching away from ascii hides its controls row -- confirms the
    # number-key jump runs the same setVizMode bookkeeping the mouse
    # click handler does, not a stripped-down copy of it
    assert not page.locator('#asciiControls').is_visible()

    # jump back to ASCII (7th button) directly, not by cycling through
    # every mode in between
    page.keyboard.press('Digit7')
    assert page.evaluate('() => vizMode') == 'ascii'
    assert page.locator('#asciiControls').is_visible()

    # out-of-range digits (8/9/0) are simply ignored, not an error and
    # not wrapping around to some other mode
    page.keyboard.press('Digit9')
    assert page.evaluate('() => vizMode') == 'ascii'


def test_arrow_and_bracket_keys_adjust_brightness_and_resolution(page, golden_path_server):
    """Real ask: brightness (ASCII's BRI slider) and resolution (its RES
    slider) should be keyboard-adjustable, not mouse-only -- and the
    on-screen slider itself should reflect the new value, not just the
    underlying JS variable, since setAsciiBrightness/setAsciiRes are
    shared with the slider's own 'input' handler for exactly that
    reason."""
    page.goto(golden_path_server['web_url'] + '/orbit_visualizer.html')
    page.wait_for_selector('#vizModes')
    assert page.evaluate('() => vizMode') == 'ascii'  # default -- no digit key needed to reach the sliders

    before_bri = page.evaluate('() => asciiBrightness')
    page.keyboard.press('ArrowUp')
    after_bri = page.evaluate('() => asciiBrightness')
    assert after_bri == pytest.approx(before_bri + 0.1, abs=0.01)
    assert float(page.locator('#asciiBriSlider').input_value()) == pytest.approx(after_bri, abs=0.01)

    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowDown')
    assert page.evaluate('() => asciiBrightness') == pytest.approx(before_bri - 0.1, abs=0.01)

    before_res = page.evaluate('() => asciiStride')
    page.keyboard.press('BracketRight')
    after_res = page.evaluate('() => asciiStride')
    assert after_res == before_res + 1
    assert int(page.locator('#asciiResSlider').input_value()) == after_res

    page.keyboard.press('BracketLeft')
    assert page.evaluate('() => asciiStride') == before_res

    # clamped, not wrapped -- five more decrements than the 1-4 range
    # allows should leave it pinned at the minimum, not go negative
    for _ in range(5):
        page.keyboard.press('BracketLeft')
    assert page.evaluate('() => asciiStride') == 1
