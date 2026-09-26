"""
Downloads' by-hash form: one horizontal row instead of a stack of
full-width fields, folded behind a "Download by content hash" toggle at
every width (it used to fold on phones only), and the open/closed state
survives a reload.
"""
import os

SHOTS = os.environ.get('WEED_TEST_SHOTS')   # optional: a folder to save screenshots in


def _open_downloads(page, url):
    page.goto(url + '#downloads')
    page.wait_for_selector('.download-form', state='attached')


def test_the_form_is_one_row_on_a_desktop(page, golden_path_server):
    page.set_viewport_size({'width': 1400, 'height': 900})
    _open_downloads(page, golden_path_server['web_url'])
    assert page.locator('.download-form').is_visible()     # open to begin with on a desktop
    tops = page.evaluate("""() => ['.dl-hash', '.dl-relays', '.dl-out', 'label.checkbox', 'button[type=submit]']
        .map(s => document.querySelector('.download-form ' + s).getBoundingClientRect())
        .map(r => Math.round(r.top + r.height / 2))""")
    assert max(tops) - min(tops) < 30, tops                 # all side by side, not stacked
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'download-form-desktop.png'))


def test_the_toggle_folds_it_at_any_width_and_it_stays_folded(page, golden_path_server):
    page.set_viewport_size({'width': 1400, 'height': 900})
    _open_downloads(page, golden_path_server['web_url'])
    toggle = page.locator('button.filters-toggle', has_text='Download by content hash')
    assert toggle.is_visible()
    toggle.click()
    assert not page.locator('.download-form').is_visible()
    page.reload()
    page.wait_for_selector('.download-form', state='attached')
    assert not page.locator('.download-form').is_visible()  # remembered
    toggle.click()
    assert page.locator('.download-form').is_visible()
    page.fill('.dl-hash input', 'abc')                      # the fields still work as before
    assert page.evaluate("() => document.querySelector('.dl-hash input').value") == 'abc'


def test_it_starts_folded_on_a_phone_and_stacks_when_opened(page, golden_path_server):
    page.set_viewport_size({'width': 375, 'height': 812})
    _open_downloads(page, golden_path_server['web_url'])
    assert not page.locator('.download-form').is_visible()
    page.locator('button.filters-toggle', has_text='Download by content hash').click()
    lefts = page.evaluate("""() => ['.dl-hash', '.dl-relays', '.dl-out']
        .map(s => Math.round(document.querySelector('.download-form ' + s).getBoundingClientRect().left))""")
    assert len(set(lefts)) == 1, lefts
    gaps = page.evaluate("""() => { const r = s => document.querySelector('.download-form ' + s).getBoundingClientRect();
        return [r('.dl-relays input').top - r('.dl-hash input').bottom, r('.dl-out input').top - r('.dl-relays input').bottom]; }""")
    assert all(g < 60 for g in gaps), gaps                  # stacked snugly, no flex-basis-sized holes
    over = page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1")
    assert not over
    if SHOTS: page.locator('.download-form').screenshot(path=os.path.join(SHOTS, 'download-form-phone.png'))
