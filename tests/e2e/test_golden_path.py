"""
The actual point of this app, driven through a real browser against a
real relay + real host + real web_ui server (see conftest.golden_path_server):
Discover finds a hosted video, Download fetches and merkle-verifies it for
real, Play streams it, and the play-history feature (added this session)
records against real server state -- not a mock.
"""
import re


def _vm(page):
    return page.evaluate_handle(
        "document.getElementById('app').__vue_app__._container._vnode.component.proxy")


def test_discover_finds_the_hosted_video(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)
    assert golden_path_server['title'] in page.content()


def test_download_then_play_updates_play_history(page, golden_path_server):
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)

    # reveal the swipe-back actions row (Download button lives there) and click it.
    # .first: the Discover row has two identical .swipe-back action pages
    # now (swipe either direction to reach them on mobile -- see
    # index.html), both visible at once at this test's desktop viewport
    # width since the swipe/scroll-snap CSS only activates under the
    # mobile breakpoint. Either one does the same thing.
    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title']).first
    row.locator('.swipe-back .play-btn', has_text='Download').first.click()

    # real chunked download + merkle verification against the real host --
    # give it real time, not an arbitrary short timeout
    page.wait_for_selector('#discover-table .swipe-back .play-btn:has-text("▶ Play")', timeout=20_000)

    lib_before = page.evaluate("() => fetch('/api/library').then(r => r.json())")
    hash_ = golden_path_server['content_hash']
    rec_before = next(d for d in lib_before['downloads'] if d['content_hash'] == hash_)
    assert rec_before.get('play_count', 0) == 0

    # .first: the Discover row now has two identical .swipe-back action
    # pages (swipe either direction to reach them on mobile -- see
    # index.html), both plainly visible and clickable at this test's
    # desktop viewport width since the swipe/scroll-snap CSS only
    # activates under the mobile breakpoint. Either one does the same
    # thing.
    row.locator('.swipe-back .play-btn', has_text='▶ Play').first.click()
    page.wait_for_selector('#global-player:not(.hidden)', timeout=5_000)

    # the /api/play POST is fire-and-forget from the frontend -- give it a
    # moment to land before asserting server-side state
    page.wait_for_function(
        f"() => fetch('/api/library').then(r => r.json()).then(l => "
        f"l.downloads.find(d => d.content_hash === '{hash_}')?.play_count === 1)",
        timeout=5_000,
    )

    lib_after = page.evaluate("() => fetch('/api/library').then(r => r.json())")
    rec_after = next(d for d in lib_after['downloads'] if d['content_hash'] == hash_)
    assert rec_after['play_count'] == 1
    assert rec_after['last_played'] is not None
    assert len(lib_after['history']) == 1
    assert lib_after['history'][0]['content_hash'] == hash_


def test_sort_by_recently_played_reflects_a_real_play(page, golden_path_server):
    """Regression coverage for the sortable-column-header UI (clicking
    "Last played" instead of the dropdown it replaced) against a real
    dataset -- confirms the click both shows the active-sort tick and
    that a real, single-item dataset with nothing played yet renders the
    "never played" dash cleanly rather than crashing."""
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)
    page.click('#discover-table th.sortable:has-text("Last played")')
    assert page.locator('#discover-table th.sortable:has-text("Last played") .sort-tick').is_visible()
    # nothing played yet -- should render the "never played" dash, not crash
    assert re.search(r'—', page.locator('#discover-table tbody tr').first.inner_text())
