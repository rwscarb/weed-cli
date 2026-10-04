"""
Fullscreen hides the mouse cursor after a few seconds without movement
(Ryan: "make the cursor disappear after a period when full screen"),
in both the player's fullscreen and the Orbit Visualizer's. Asserted on
the computed cursor of what's under the pointer -- the visualizer's
canvas sets its own cursor inline, which used to win over the dialog's
cursor: none and leave the pointer showing over the picture.
"""
from test_golden_path import _download_and_play

IDLE_WAIT_MS = 3600


def _cursor(page, selector):
    return page.locator(selector).evaluate('el => getComputedStyle(el).cursor')


def test_player_fullscreen_hides_the_cursor_when_idle(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Fullscreen"]')
    page.wait_for_function(
        "() => document.fullscreenElement === document.getElementById('global-player')")
    page.mouse.move(200, 200)
    assert _cursor(page, '#global-player video[autoplay]') != 'none'
    page.wait_for_timeout(IDLE_WAIT_MS)
    assert _cursor(page, '#global-player video[autoplay]') == 'none'
    page.mouse.move(220, 210)
    assert _cursor(page, '#global-player video[autoplay]') != 'none'

    page.evaluate("() => document.exitFullscreen()")
    page.wait_for_function("() => document.fullscreenElement === null")
    assert 'cursor-idle' not in page.locator('#global-player').get_attribute('class')


def test_player_outside_fullscreen_never_hides_the_cursor(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    box = page.locator('#global-player video[autoplay]').bounding_box()
    page.mouse.move(box['x'] + 10, box['y'] + 10)
    page.wait_for_timeout(IDLE_WAIT_MS)
    assert 'cursor-idle' not in page.locator('#global-player').get_attribute('class')


def test_visualizer_fullscreen_hides_the_cursor_over_the_canvas_when_idle(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')
    page.keyboard.press('f')
    page.wait_for_function(
        "() => document.fullscreenElement === document.getElementById('orbit-egg-dialog')")
    page.mouse.move(300, 300)
    assert _cursor(page, '#vizCanvas') != 'none'
    page.wait_for_timeout(IDLE_WAIT_MS)
    assert _cursor(page, '#vizCanvas') == 'none'
    page.mouse.move(320, 310)
    assert _cursor(page, '#vizCanvas') != 'none'
