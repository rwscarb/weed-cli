"""
The ☰ Customize panel: add/remove/reorder the visualizer's modes and
transitions (orbit_visualizer.js setLayout/applyLayout). What's removed
disappears everywhere a mode/transition is offered -- buttons, the
narrow <select>, the Fade dropdown, next/prev cycling -- but stays a
real mode a MIDI pad can still pick; the arrangement survives a reload.
"""
from test_golden_path import _download_and_play
from test_orbit_visualizer import _open_orbit_viz


def _shown_buttons(page):
    return page.evaluate("""() => [...document.querySelectorAll('#vizModes button[data-viz]')]
        .filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.viz)""")


def test_customize_panel_removes_and_reorders_modes_everywhere(page, golden_path_server):
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    default = page.evaluate("() => window.orbitViz.modes()")
    page.click('#vizLayoutBtn')
    assert page.locator('#layoutModes li').count() == len(default)

    page.locator('#layoutModes li[data-id="bars"] input').click()        # remove
    page.locator('#layoutModes li[data-id="plasma"] button[title="Move up"]').click()
    modes = page.evaluate("() => window.orbitViz.modes()")
    assert 'bars' not in modes
    assert modes.index('plasma') < modes.index('ascii') < default.index('plasma')
    assert _shown_buttons(page) == modes
    assert page.evaluate("() => [...document.getElementById('vizModeSelect').options].map(o => o.value)") == modes + ['__video']

    # cycling skips a removed mode; a pad bound to one still reaches it
    page.evaluate("() => window.orbitViz.trigger('mode:tunnel')")
    page.evaluate("() => window.orbitViz.trigger('next')")
    assert page.evaluate("() => window.orbitViz.current().mode") == 'mirror'
    page.evaluate("() => window.orbitViz.trigger('mode:bars')")
    assert page.evaluate("() => window.orbitViz.current().mode") == 'bars'

    # removing what's on screen moves along to the first one still shown
    page.evaluate("() => window.orbitViz.trigger('mode:mirror')")
    page.locator('#layoutModes li[data-id="mirror"] input').click()
    assert page.evaluate("() => window.orbitViz.current().mode") == page.evaluate("() => window.orbitViz.modes()[0]")

    # never everything
    assert page.evaluate("() => window.orbitViz.setModeLayout(null, window.orbitViz.layout().modes.map(m => m.id))") is False

    page.click('[data-layout-reset="modes"]')
    assert page.evaluate("() => window.orbitViz.modes()") == default
    assert errors == []


def test_drag_the_grip_to_reorder(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizLayoutBtn')
    page.locator('#layoutModes').scroll_into_view_if_needed()
    grip = page.locator('#layoutModes li[data-id="scope"] .layout-grip').bounding_box()
    first = page.locator('#layoutModes li').first.bounding_box()
    page.mouse.move(grip['x'] + 4, grip['y'] + 4)
    page.mouse.down()
    page.mouse.move(grip['x'] + 4, first['y'] + 2, steps=8)
    page.mouse.up()
    assert page.evaluate("() => window.orbitViz.modes()[0]") == 'scope'
    assert _shown_buttons(page)[0] == 'scope'


def test_removed_transitions_leave_the_dropdown_and_random(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.click('#vizLayoutBtn')
    page.select_option('#transitionSelect', 'burn')
    page.locator('#layoutTransitions li[data-id="burn"] input').click()
    page.locator('#layoutTransitions li[data-id="glitch"] input').click()
    options = page.evaluate("() => [...document.getElementById('transitionSelect').options].map(o => o.value)")
    assert 'burn' not in options and 'glitch' not in options
    assert page.evaluate("() => document.getElementById('transitionSelect').value") in options   # moved along
    pool = page.evaluate("() => [...document.querySelectorAll('#randomPoolList input')].map(i => i.dataset.transition)")
    assert 'burn' not in pool and 'glitch' not in pool
    # a MIDI pad that sets a removed transition still can
    page.evaluate("() => window.orbitViz.trigger('transition:set:glitch')")
    assert page.evaluate("() => window.orbitViz.debugState().transition") == 'glitch'


def test_the_layout_survives_a_reload(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    page.evaluate("() => window.orbitViz.setModeLayout(['kaleido', 'tunnel'], ['bars'])")
    page.reload()
    # already downloaded: play it from Downloads rather than downloading again
    page.goto(golden_path_server['web_url'] + '/#downloads')
    page.locator('#jobs-table button:has-text("Play")').first.click()
    _open_orbit_viz(page)
    modes = page.evaluate("() => window.orbitViz.modes()")
    assert modes[:2] == ['kaleido', 'tunnel'] and 'bars' not in modes
    assert _shown_buttons(page)[:2] == ['kaleido', 'tunnel']
