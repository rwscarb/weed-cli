"""
window.orbitViz.registerMode/unregisterMode/listModes -- the plugin API
added so code outside orbit_visualizer.js can add its own visualization
modes without editing that file at all (see its own pluginModes comment
for the full contract). These drive the API directly via page.evaluate()
rather than loading web/orbit_plugin_example.js as a real <script> tag,
since that file is deliberately not on index.html's own script list (an
example to copy, not something every page load should carry) -- Vue's
own app.js is server-relative on the SAME page though, so evaluate() is
simpler than injecting a second real script tag just for this.
"""
from test_golden_path import _download_and_play
from test_orbit_visualizer import _open_orbit_viz


def _register_stub(page, mode_id, throws=False, label=None):
    """A minimal plugin registered directly against the live
    window.orbitViz -- draws a flat fill so a real frame renders
    successfully, or throws every frame if throws=True (for exercising
    the error-isolation path)."""
    page.evaluate(
        """({ id, label, throws }) => {
            window.__pluginCalls = window.__pluginCalls || {};
            window.__pluginCalls[id] = { init: 0, draw: 0, teardown: 0 };
            window.orbitViz.registerMode({
                id, label,
                init: () => { window.__pluginCalls[id].init++; },
                teardown: () => { window.__pluginCalls[id].teardown++; },
                draw: (ctx) => {
                    window.__pluginCalls[id].draw++;
                    if (throws) throw new Error('boom from ' + id);
                    ctx.vctx.fillStyle = '#123456';
                    ctx.vctx.fillRect(0, 0, ctx.VW, ctx.VH);
                },
            });
        }""",
        {'id': mode_id, 'label': label or mode_id, 'throws': throws},
    )


def _call_counts(page, mode_id):
    return page.evaluate('(id) => window.__pluginCalls[id]', mode_id)


def test_registering_before_open_adds_a_button_that_actually_draws(page, golden_path_server):
    """The common case: a plugin script registers itself at load time,
    well before anyone has opened the visualizer -- its button should
    just be there like any built-in mode's, and clicking it should
    actually call draw() every frame."""
    # registered before the dialog is opened, but after
    # _download_and_play's own page.goto -- that goto is a fresh
    # navigation (a real page reload), which would otherwise wipe out
    # anything registered against the previous page load
    _download_and_play(page, golden_path_server)
    _register_stub(page, 'stub-early')
    _open_orbit_viz(page)

    btn = page.locator('[data-viz="stub-early"]')
    assert btn.is_visible()
    assert btn.inner_text() == 'stub-early'

    btn.click()
    assert btn.evaluate('el => el.classList.contains("active")')
    page.wait_for_function(
        "() => window.__pluginCalls['stub-early'].draw > 5")  # several real animation frames
    counts = _call_counts(page, 'stub-early')
    assert counts['init'] == 1  # once, at dialog-open, not once per frame


def test_registering_while_open_mounts_the_button_live(page, golden_path_server):
    """registerMode() called *after* the dialog is already open should
    still work -- mountPlugin runs immediately instead of only the next
    time init() happens, so a plugin loaded/registered dynamically while
    someone's already watching doesn't need them to close and reopen the
    visualizer to see it."""
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)

    assert page.locator('[data-viz="stub-live"]').count() == 0
    _register_stub(page, 'stub-live')
    assert page.locator('[data-viz="stub-live"]').count() == 1
    assert _call_counts(page, 'stub-live')['init'] == 1


def test_a_throwing_plugin_falls_back_without_taking_down_other_modes(page, golden_path_server):
    """Real risk this is guarding against: an uncaught throw inside
    drawViz's own requestAnimationFrame loop fails *silently* -- no
    crash, no console output by default, the loop just quietly stops
    forever, taking every other mode down with it (this is exactly the
    class of bug the ASCII-background console-error test elsewhere in
    this file exists to catch in this codebase's *own* code -- here it's
    a third-party plugin, which is far more likely to have bugs).
    registerMode wraps every plugin call in try/catch specifically so
    this can't happen: the broken plugin logs once, gets kicked back to
    Tunnel, and the loop keeps running for everything else."""
    console_errors = []
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)

    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    _register_stub(page, 'stub-broken', throws=True)

    page.click('[data-viz="stub-broken"]')
    page.wait_for_function("() => window.__pluginCalls['stub-broken'].draw >= 1")
    # falls back to Tunnel automatically -- the mode that threw isn't
    # left "active" with nothing actually rendering into it
    page.wait_for_function("() => document.querySelector('[data-viz=\"tunnel\"]').classList.contains('active')")
    assert any('stub-broken' in e for e in console_errors)

    # broken once, it stays broken (drawViz checks mode.broken before
    # calling in again) -- draw() shouldn't keep getting called forever
    calls_at_fallback = _call_counts(page, 'stub-broken')['draw']
    page.wait_for_timeout(200)
    assert _call_counts(page, 'stub-broken')['draw'] == calls_at_fallback

    # the rest of the visualizer survived -- switching to a real
    # built-in mode afterward still works, proving the rAF loop is
    # still actually running
    page.click('[data-viz="bars"]')
    assert page.locator('[data-viz="bars"]').evaluate('el => el.classList.contains("active")')


def test_unregister_removes_the_button_and_calls_teardown(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    _register_stub(page, 'stub-unreg')
    assert page.locator('[data-viz="stub-unreg"]').count() == 1

    page.evaluate("() => window.orbitViz.unregisterMode('stub-unreg')")
    assert page.locator('[data-viz="stub-unreg"]').count() == 0
    assert _call_counts(page, 'stub-unreg')['teardown'] == 1


def test_list_modes_reports_built_ins_and_registered_plugins(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    before = page.evaluate("() => window.orbitViz.listModes().length")
    _register_stub(page, 'stub-listed')
    after = page.evaluate("() => window.orbitViz.listModes()")
    assert len(after) == before + 1
    assert any(m['id'] == 'stub-listed' and m['builtin'] is False for m in after)
    assert any(m['id'] == 'tunnel' and m['builtin'] is True for m in after)


# ── transitions: orbitViz.registerTransition/unregisterTransition ──────
# Same contract as modes, for the Fade dropdown. The stubs record every
# progress value they're handed so the test can check the plugin is
# really driving frames across the transition, not just registered.

def _register_stub_transition(page, tid, throws=False):
    page.evaluate(
        """({ id, throws }) => {
            window.__transCalls = window.__transCalls || {};
            window.__transCalls[id] = [];
            window.orbitViz.registerTransition({
                id, label: 'T-' + id,
                draw: (ctx) => {
                    window.__transCalls[id].push(ctx.t);
                    if (throws) throw new Error('boom from ' + id);
                    ctx.vctx.globalAlpha = 1 - ctx.t;
                    ctx.vctx.drawImage(ctx.old, 0, 0, ctx.W, ctx.H);
                    ctx.scratch();   // the shared scratch canvas is part of the contract
                },
            });
        }""",
        {'id': tid, 'throws': throws},
    )


def _select_transition(page, name, ms=400):
    page.evaluate(
        """([name, ms]) => {
            const s = document.getElementById('transitionSelect'); s.value = name; s.dispatchEvent(new Event('change'));
            const r = document.getElementById('transitionSlider'); r.value = ms; r.dispatchEvent(new Event('input'));
        }""", [name, ms])


def test_register_transition_adds_a_fade_option_that_drives_frames(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _register_stub_transition(page, 'stub-fade')
    _open_orbit_viz(page)

    opts = page.evaluate("() => [...document.getElementById('transitionSelect').options].map(o => [o.value, o.textContent])")
    assert ['stub-fade', 'T-stub-fade'] in opts
    # plugins sit before Random/None, which stay last
    assert [o[0] for o in opts][-2:] == ['random', 'none']
    assert 'stub-fade' in page.evaluate("() => window.orbitViz.transitions()")
    assert any(t['id'] == 'stub-fade' and t['builtin'] is False for t in page.evaluate("() => window.orbitViz.listTransitions()"))

    _select_transition(page, 'stub-fade')
    page.click('[data-viz="bars"]')       # a mode switch fires the transition
    page.wait_for_function("() => window.__transCalls['stub-fade'].length > 3")
    page.wait_for_function("() => window.orbitViz.debugState().trans === null")   # ran to completion
    ts = page.evaluate("() => window.__transCalls['stub-fade']")
    assert all(0 <= t < 1 for t in ts)
    assert ts == sorted(ts)
    assert ts[-1] > 0.5   # got well into the transition, not just one early frame


def test_a_throwing_transition_drops_back_to_burn_and_keeps_the_loop_alive(page, golden_path_server):
    console_errors = []
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    _register_stub_transition(page, 'stub-boom', throws=True)
    _select_transition(page, 'stub-boom')
    page.click('[data-viz="bars"]')
    page.wait_for_function("() => window.__transCalls['stub-boom'].length >= 1")
    page.wait_for_function("() => document.getElementById('transitionSelect').value === 'burn'")
    assert any('stub-boom' in e for e in console_errors)
    calls = page.evaluate("() => window.__transCalls['stub-boom'].length")
    page.click('[data-viz="scope"]')      # burn now, the loop still running
    page.wait_for_timeout(200)
    assert page.evaluate("() => window.__transCalls['stub-boom'].length") == calls
    assert page.locator('[data-viz="scope"]').evaluate('el => el.classList.contains("active")')


def test_unregister_transition_removes_the_option_and_resets_a_selection_of_it(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    _register_stub_transition(page, 'stub-gone')
    _select_transition(page, 'stub-gone')
    assert page.evaluate("() => window.orbitViz.current().transition") == 'stub-gone'
    page.evaluate("() => window.orbitViz.unregisterTransition('stub-gone')")
    assert page.locator('#transitionSelect option[value="stub-gone"]').count() == 0
    assert page.evaluate("() => document.getElementById('transitionSelect').value") == 'burn'
    assert 'stub-gone' not in page.evaluate("() => window.orbitViz.transitions()")


def test_plugin_modes_join_the_narrow_select_and_next_prev_cycling(page, golden_path_server):
    """A plugin mode has to be reachable every way a built-in is: the
    narrow-viewport <select> (kept in sync with the button row, "Video
    only" still last), arrow/pad cycling (orbitViz.modes() is what the
    MIDI mode selector walks too), and a stale saved mode of a plugin
    that's no longer loaded must not stick."""
    _download_and_play(page, golden_path_server)
    _register_stub(page, 'stub-cycle')
    _open_orbit_viz(page)
    values = page.evaluate("() => [...document.getElementById('vizModeSelect').options].map(o => o.value)")
    assert values[-2:] == ['stub-cycle', '__video']
    modes = page.evaluate("() => window.orbitViz.modes()")
    assert modes[-1] == 'stub-cycle'
    page.click(f'[data-viz="{modes[-2]}"]')   # whatever's just before it (the last extras mode)
    page.evaluate("() => window.orbitViz.trigger('next')")
    assert page.locator('[data-viz="stub-cycle"]').evaluate('el => el.classList.contains("active")')
    page.evaluate("() => window.orbitViz.trigger('next')")
    assert page.locator('[data-viz="tunnel"]').evaluate('el => el.classList.contains("active")')


# ── the bundled extras (web/orbit_extras.js) ──────────────────────────
# Loaded by index.html, so every mode/transition it registers must
# actually render against the real draw loop with no errors.

def test_extras_bundle_registers_modes_that_all_render_without_errors(page, golden_path_server):
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    extra = [m['id'] for m in page.evaluate("() => window.orbitViz.listModes()") if not m['builtin']]
    assert set(extra) >= {'halftone', 'lava', 'terrain', 'rain', 'lissajous', 'ripples', 'cube'}
    _select_transition(page, 'none')
    for mode in extra:
        page.click(f'[data-viz="{mode}"]')
        page.wait_for_timeout(250)
        assert page.evaluate("() => window.orbitViz.current().mode") == mode, f'{mode} did not stay active (a throw kicks a plugin back to tunnel)'
    assert errors == []


def test_extras_bundle_registers_transitions_that_all_run_to_completion(page, golden_path_server):
    errors = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    extra = [t['id'] for t in page.evaluate("() => window.orbitViz.listTransitions()") if not t['builtin']]
    assert set(extra) >= {'melt', 'dissolve', 'iris', 'shatter', 'wave', 'spin', 'zoomblur', 'rgbsplit'}
    modes = ['bars', 'scope']
    for i, name in enumerate(extra):
        _select_transition(page, name, ms=300)
        page.click(f'[data-viz="{modes[i % 2]}"]')
        page.wait_for_function("() => { const d = window.orbitViz.debugState(); return d.trans && d.trans.type === %r; }" % name)
        page.wait_for_function("() => window.orbitViz.debugState().trans === null")
        # still the chosen transition: a throw would have reset it to burn
        assert page.evaluate("() => document.getElementById('transitionSelect').value") == name
    assert errors == []


def test_random_transition_picks_a_real_one_each_time(page, golden_path_server):
    _download_and_play(page, golden_path_server)
    _open_orbit_viz(page)
    _select_transition(page, 'random', ms=2000)
    seen = set()
    for mode in ['bars', 'scope', 'bars', 'scope', 'bars', 'scope']:
        page.click(f'[data-viz="{mode}"]')
        t = page.evaluate("() => window.orbitViz.debugState().trans.type")
        assert t not in ('random', 'none')
        seen.add(t)
    assert len(seen) >= 2
