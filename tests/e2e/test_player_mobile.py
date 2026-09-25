"""
The player's transport on a phone. At phone widths the whole seek row
used to sit off the right edge (the mobile `button { width: 100% }` rule
made every transport button as wide as the screen), and with no hover
on a touch screen nothing brought the bar back while a video played.
"""
from test_golden_path import _download_and_play

PHONE = {'width': 375, 'height': 812}


def _bar_layout(page, bar='#audio-transport'):
    return page.evaluate("""(sel) => {
        const bar = document.querySelector(sel), r = e => e.getBoundingClientRect();
        const seek = bar.querySelector('.audio-seek'), btns = [...bar.querySelectorAll('.audio-btn')];
        return { vw: innerWidth, bar: r(bar).toJSON(), seek: r(seek).toJSON(),
                 widestBtn: Math.max(...btns.map(b => r(b).width)),
                 rightmost: Math.max(...[...bar.children].map(c => r(c).right)) };
    }""", bar)


def _assert_usable(lay):
    assert lay['seek']['left'] >= 0 and lay['seek']['right'] <= lay['vw'], lay
    assert lay['seek']['width'] > 150, lay                  # the seek row has the width to itself
    assert lay['widestBtn'] < 80, lay                       # buttons aren't screen-wide
    assert lay['rightmost'] <= lay['bar']['right'] + 1, lay  # nothing hangs off the end


def test_the_seek_bar_is_on_screen_at_phone_width_in_every_player_size(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    page.set_viewport_size(PHONE)
    page.wait_for_timeout(300)
    _assert_usable(_bar_layout(page))                                  # PIP
    page.click('#global-player .icon-btn[title="Theater / PIP"]')
    page.wait_for_timeout(400)
    _assert_usable(_bar_layout(page))                                  # theater
    pip = page.locator('#global-player').bounding_box()
    assert pip['y'] >= 0 and pip['x'] >= 0


def test_a_short_landscape_screen_keeps_the_pip_header_on_screen(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    page.set_viewport_size({'width': 812, 'height': 375})
    page.wait_for_timeout(300)
    box = page.locator('#global-player').bounding_box()
    assert box['y'] >= 0, box
    assert box['y'] + box['height'] <= 375, box


def test_a_tap_on_the_picture_toggles_the_transport(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    page.set_viewport_size(PHONE)
    wrap = page.locator('#global-player .player-video-wrap').bounding_box()
    tap = (wrap['x'] + wrap['width'] / 2, wrap['y'] + wrap['height'] / 4)
    page.mouse.click(*tap)
    assert 'controls-shown' in page.locator('#global-player').get_attribute('class')
    page.mouse.click(*tap)
    assert 'controls-shown' not in page.locator('#global-player').get_attribute('class')
