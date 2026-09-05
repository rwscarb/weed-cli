"""
The actual point of this app, driven through a real browser against a
real relay + real host + real web_ui server (see conftest.golden_path_server):
Discover finds a hosted video, Download fetches and merkle-verifies it for
real, Play streams it, and the play-history feature (added this session)
records against real server state -- not a mock.
"""
import re

import pytest

import web_ui


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
    # :not(.swipe-back-mirror): the Discover row has two identical
    # .swipe-back action pages in the DOM (swipe either direction to
    # reach them on mobile -- see index.html), but the mirror copy is
    # display:none outside the mobile breakpoint (see style.css) -- it's
    # still a real DOM match Playwright's locator counts regardless of
    # CSS visibility, so .first isn't enough here (it happens to land on
    # the mirror, which comes first in document order, and then times out
    # waiting for a hidden element to become clickable). Excluding it
    # explicitly picks the one actually shown at this test's desktop
    # viewport width, rather than relying on DOM-order luck.
    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title']).first
    row.locator('.swipe-back:not(.swipe-back-mirror) .play-btn', has_text='Download').click()

    # real chunked download + merkle verification against the real host --
    # give it real time, not an arbitrary short timeout
    page.wait_for_selector('#discover-table .swipe-back:not(.swipe-back-mirror) .play-btn:has-text("▶ Play")', timeout=20_000)

    lib_before = page.evaluate("() => fetch('/api/library').then(r => r.json())")
    hash_ = golden_path_server['content_hash']
    rec_before = next(d for d in lib_before['downloads'] if d['content_hash'] == hash_)
    assert rec_before.get('play_count', 0) == 0

    # :not(.swipe-back-mirror) -- see this test's earlier Download click
    # for why (a hidden-at-desktop DOM duplicate that .first would land
    # on instead of the real, visible one).
    row.locator('.swipe-back:not(.swipe-back-mirror) .play-btn', has_text='▶ Play').click()
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


def _download_and_play(page, golden_path_server):
    """Shared setup: get the one seeded video downloaded and open in the
    global player, same click path test_download_then_play_updates_play_history
    already exercises (see its own comments for why the two
    :not(.swipe-back-mirror) selectors are needed)."""
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)
    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title']).first
    row.locator('.swipe-back:not(.swipe-back-mirror) .play-btn', has_text='Download').click()
    page.wait_for_selector('#discover-table .swipe-back:not(.swipe-back-mirror) .play-btn:has-text("▶ Play")', timeout=20_000)
    row.locator('.swipe-back:not(.swipe-back-mirror) .play-btn', has_text='▶ Play').click()
    page.wait_for_selector('#global-player:not(.hidden)', timeout=5_000)


def test_solo_play_gets_an_ad_hoc_currently_playing_queue(page, golden_path_server):
    """Real report: playing a video directly (Discover/Downloads, not a
    saved playlist) left player.queue null -- no Prev/Next, and no way to
    queue up something else to play next, unless you'd gone to the extra
    trouble of first building a real saved playlist. openPlayer now seeds
    a one-item ad-hoc queue (playlistId: null) for any solo play, and the
    playlist-picker popup offers a "Currently Playing" entry (only while
    nothing *explicit* is driving playback -- see playingPlaylistId) that
    appends to it. Only one real video exists in this fixture, so this
    queues the same content_hash again -- the point is proving the
    plumbing (queue exists, picker offers it, click grows it), not
    variety of content."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)

    queue = page.evaluate("vm => vm.player.queue", vm)
    assert queue is not None
    assert queue['playlistId'] is None
    assert len(queue['items']) == 1
    assert page.evaluate("vm => vm.playingPlaylistId", vm) is None

    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title']).first
    row.locator('.playlist-add-btn').click()
    page.wait_for_selector('#playlist-picker:not(.hidden)')
    queue_entry = page.locator('.playlist-picker-item-add', has_text='Currently Playing')
    assert queue_entry.is_visible()
    assert '1' in queue_entry.inner_text()

    queue_entry.click()
    page.wait_for_function("vm => vm.player.queue.items.length === 2", arg=vm)
    assert page.locator('#playlist-picker.hidden').count() == 1  # picker closes itself on add

    # the transport overlay's Next button should now be enabled, since
    # there's a real second queue slot to advance into
    page.hover('.player-video-wrap')
    next_btn = page.locator('.transport-overlay-btn[title^="Next"]')
    assert not next_btn.is_disabled()


def test_currently_playing_queue_shows_in_playlists_tab(page, golden_path_server):
    """Follow-up to the ad-hoc queue above: the Playlists tab should show
    the live "Currently Playing" queue too, not just the playlist-picker
    popup -- with enough control (jump to a queued item, remove one,
    clear the rest) to actually be useful there, not just a read-only
    echo of the picker's own count."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)

    # queue a second slot the same way the previous test does, via the
    # picker's "Currently Playing" entry -- this fixture only has one
    # real video, so it's the same content_hash queued twice, which is
    # exactly the "duplicate content_hash in the queue" case
    # playQueueIndex's own docstring is written to handle correctly.
    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title']).first
    row.locator('.playlist-add-btn').click()
    page.locator('.playlist-picker-item-add', has_text='Currently Playing').click()
    page.wait_for_function("vm => vm.player.queue.items.length === 2", arg=vm)

    page.click('.tab-btn:has-text("Playlists")')
    card = page.locator('.playlist-card-current')
    assert card.is_visible()
    assert '2 items' in card.locator('.playlist-count').inner_text()
    items = card.locator('.playlist-item')
    assert items.count() == 2
    assert items.nth(0).locator('.icon-btn').get_attribute('title') == 'Remove from queue'

    # clicking the second (queued-up, not yet playing) row jumps playback
    # to it -- index moves from 0 to 1, same track either way since it's
    # a duplicate, but this proves the click routes through playQueueIndex
    # by position rather than re-resolving by content_hash
    items.nth(1).click()
    page.wait_for_function("vm => vm.player.queue.index === 1", arg=vm)

    # remove the now-non-current first slot -- index should shift down to
    # stay pointing at the same (still-playing) track
    card.locator('.playlist-item').nth(0).locator('.icon-btn').click()
    page.wait_for_function("vm => vm.player.queue.items.length === 1 && vm.player.queue.index === 0", arg=vm)


def test_orbit_visualizer_hides_the_real_video_in_every_player_mode(page, golden_path_server):
    """Real ask: don't show the normal video when the orbit visualizer is
    open. It used to only hide the player in PIP mode (the old
    easterEggVisible && player.mode === 'pip' condition in index.html) --
    Theater mode left the real video visible right alongside the
    visualizer, since neither one's centered box fully covers the
    other."""
    _download_and_play(page, golden_path_server)

    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#orbit-egg-dialog')
    assert not page.locator('#global-player').is_visible()

    # close it (via the backdrop -- the player's own buttons are hidden
    # right now) and confirm it comes back before testing the next mode.
    # position=(5, 5): the backdrop covers the whole viewport but the
    # centered dialog itself sits right on top of its own center, so a
    # plain .click() lands on the iframe instead and never reaches the
    # backdrop underneath it.
    page.locator('#orbit-egg-backdrop').click(position={'x': 5, 'y': 5})
    page.wait_for_selector('#orbit-egg-dialog', state='detached')
    assert page.locator('#global-player').is_visible()

    page.click('#global-player .icon-btn[title="Theater / PIP"]')
    page.wait_for_selector('#global-player.mode-theater')
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#orbit-egg-dialog')
    assert not page.locator('#global-player').is_visible()


def test_closing_orbit_visualizer_restores_fullscreen_if_it_was_active(page, golden_path_server):
    """Real report: opening the visualizer while the player was in real
    Fullscreen silently dropped back to Theater once closed, and the
    Fullscreen button/`f` stopped doing anything useful afterward until
    pressed several times. Root cause: setting the player to display:none
    (see easterEggVisible's own watch in vue-app.js) is supposed to make
    the *browser itself* auto-exit fullscreen (spec: a fullscreen element
    whose own display becomes none forces an exit) -- a real
    fullscreenchange this app never used to listen for, leaving
    player.mode (never itself a 'fullscreen' value) and the real
    fullscreen state disagreeing once the player reappears.
    document.exitFullscreen() is called explicitly below rather than
    relying on that spec behavior actually firing on its own: confirmed
    directly that this test's own headless Chromium doesn't exercise it
    at all (document.fullscreenElement just never budges here, however
    long you wait) -- simulating it is what makes it possible to test
    the actual fix (recording fullscreen was active before the
    visualizer opened, and explicitly restoring it once closed) in this
    environment at all."""
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Fullscreen"]')
    page.wait_for_function(
        "() => document.fullscreenElement === document.getElementById('global-player')")

    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#orbit-egg-dialog')
    page.evaluate("() => document.exitFullscreen()")
    page.wait_for_function("() => document.fullscreenElement === null")

    page.click('#orbit-egg-dialog button:has-text("Back")')
    page.wait_for_selector('#orbit-egg-dialog', state='detached')
    page.wait_for_function(
        "() => document.fullscreenElement === document.getElementById('global-player')")

    # the reported follow-on symptom: `f` used to need several presses
    # to do anything after this sequence. One press from restored
    # fullscreen should cycle straight to pip, immediately.
    page.keyboard.press('f')
    page.wait_for_function("() => document.fullscreenElement === null")
    assert page.query_selector('#global-player.mode-pip') is not None


def test_closing_orbit_visualizer_does_not_force_fullscreen_when_it_wasnt_active(page, golden_path_server):
    """Regression guard on the fix above: opening/closing the visualizer
    from Theater (not Fullscreen) shouldn't suddenly push the player
    into Fullscreen just because the tracking flag exists."""
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Theater / PIP"]')
    page.wait_for_selector('#global-player.mode-theater')

    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#orbit-egg-dialog')
    page.click('#orbit-egg-dialog button:has-text("Back")')
    page.wait_for_selector('#orbit-egg-dialog', state='detached')

    page.wait_for_selector('#global-player.mode-theater')
    assert page.evaluate("() => document.fullscreenElement") is None


def test_theater_and_orbit_visualizer_are_the_same_size(page, golden_path_server):
    """Real ask: Theater mode and the Orbit Visualizer dialog should be
    uniform in size -- both now read var(--big-dialog-w)/--big-dialog-h
    off :root (see style.css) rather than each hardcoding its own box,
    so this confirms that's actually true on screen, not just true of
    the two numbers happening to be typed the same in the stylesheet."""
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Theater / PIP"]')
    page.wait_for_selector('#global-player.mode-theater')
    theater_box = page.locator('#global-player').bounding_box()

    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#orbit-egg-dialog')
    orbit_box = page.locator('#orbit-egg-dialog').bounding_box()

    assert orbit_box['width'] == pytest.approx(theater_box['width'], abs=1)
    assert orbit_box['height'] == pytest.approx(theater_box['height'], abs=1)


def test_theater_window_is_draggable(page, golden_path_server):
    """Real report: Theater mode was resizable (free native CSS `resize`)
    but not movable -- onPlayerHeaderPointerDown bailed out immediately
    unless player.mode === 'pip'. Theater's centered layout is
    top/left: 50% + transform: translate(-50%, -50%), so simply lifting
    PIP's drag restriction wouldn't have been enough on its own: without
    also neutralizing that transform at drag start, every dragged
    position would still be re-centered by it and the window wouldn't
    track the cursor at all. This drags the header and checks the window
    actually moved by the drag delta, not just that some button exists."""
    _download_and_play(page, golden_path_server)
    page.click('#global-player .icon-btn[title="Theater / PIP"]')
    page.wait_for_selector('#global-player.mode-theater')

    header = page.locator('#global-player .player-header')
    box = header.bounding_box()
    player_box_before = page.locator('#global-player').bounding_box()

    # start near the left edge of the header, well clear of the
    # like/subscribe/theater/orbit/fullscreen/close buttons clustered on
    # its right side (see index.html's .player-controls)
    start_x, start_y = box['x'] + 20, box['y'] + box['height'] / 2
    dx, dy = 80, 60
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(start_x + dx, start_y + dy, steps=10)
    page.mouse.up()

    player_box_after = page.locator('#global-player').bounding_box()
    assert player_box_after['x'] == pytest.approx(player_box_before['x'] + dx, abs=2)
    assert player_box_after['y'] == pytest.approx(player_box_before['y'] + dy, abs=2)
    # size untouched by a drag -- only position should have moved
    assert player_box_after['width'] == pytest.approx(player_box_before['width'], abs=2)
    assert player_box_after['height'] == pytest.approx(player_box_before['height'], abs=2)


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


def test_search_clear_button_and_escape_both_empty_the_search_box(page, golden_path_server):
    """Real ask: a little ✕ inside the search input to erase what's
    there. It should only appear once there's actually something to
    clear, clicking it should empty the box and hand focus back to it,
    and Escape (while the box has text) should do the same without also
    swallowing Escape when the box is already empty."""
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)

    search = page.locator('input[placeholder="title or content hash"]')
    clear_btn = page.locator('.search-clear-btn')
    assert not clear_btn.is_visible()  # nothing typed yet -- no button to show

    search.fill('nothing matches this')
    assert clear_btn.is_visible()
    assert 'no results match' in page.locator('#discover-table').inner_text()

    clear_btn.click()
    assert search.input_value() == ''
    assert not clear_btn.is_visible()
    assert golden_path_server['title'] in page.content()  # the real row is back
    assert search.evaluate('el => el === document.activeElement')  # focus returned

    search.fill('nothing matches this')
    search.press('Escape')
    assert search.input_value() == ''
    assert golden_path_server['title'] in page.content()


def test_s_key_shuffles_the_queue_without_disturbing_current_playback(page, golden_path_server):
    """Real ask: 's' as a keybinding to shuffle playback. This fixture
    only has one real downloaded video, so a real multi-item queue (the
    "Currently Playing" picker trick other tests here use) would just be
    N copies of the same content_hash -- indistinguishable from each
    other, making "did the order actually change" unobservable. Instead
    this writes a queue of ten distinct fake items directly onto
    player.queue (shufflePlayQueue only ever reorders the array -- it
    doesn't care whether each item is a real download), so the shuffle's
    two real guarantees can both be checked precisely: the currently-
    playing item and player.queue.index don't move, and the rest of the
    order actually does."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)

    before = [f'x{i}' for i in range(10)]
    current_index = 4
    page.evaluate(
        "({ vm, items, index }) => { vm.player.queue = "
        "{ items: items.map(h => ({content_hash: h, title: h, signer_pubkey: null})), "
        "index, playlistId: null }; }",
        {'vm': vm, 'items': before, 'index': current_index},
    )

    page.keyboard.press('s')

    after = page.evaluate("vm => vm.player.queue.items.map(it => it.content_hash)", vm)
    after_index = page.evaluate("vm => vm.player.queue.index", vm)

    assert after_index == current_index  # unchanged -- current playback isn't disturbed
    assert after[current_index] == before[current_index]  # the actual playing item didn't move
    assert sorted(after) == sorted(before)  # same items, just reordered
    # the other nine items being shuffled back into their *exact*
    # original positions has odds of 1 in 9! -- for all practical
    # purposes this only holds if the shuffle is a no-op
    assert after != before


def test_downloading_under_a_not_downloaded_filter_does_not_hide_the_row(page, golden_path_server):
    """Real report: filtering Discover to "not downloaded," then
    downloading a row right there, made it vanish the instant the
    download finished -- it now (correctly) matches library.downloads,
    so it fails that same "not downloaded" filter it was found under.
    The user almost always wants to hit Play on exactly the row they
    just downloaded, not re-hunt for it under a different filter."""
    page.goto(golden_path_server['web_url'])
    page.wait_for_selector('#discover-table tbody tr:not(.skeleton-row)', timeout=10_000)

    page.locator('.filter-toggle', has_text='Downloaded').locator('button', has_text='Not Downloaded').click()
    row = page.locator('#discover-table tbody tr', has_text=golden_path_server['title'])
    assert row.count() == 1  # not downloaded yet -- matches the filter

    row.locator('.swipe-back:not(.swipe-back-mirror) .play-btn', has_text='Download').click()
    page.wait_for_selector('#discover-table .swipe-back:not(.swipe-back-mirror) .play-btn:has-text("▶ Play")', timeout=20_000)

    # still there -- the filter is still "Not Downloaded" and this row is
    # now genuinely downloaded, so without the fix it would have
    # disappeared right when that Play button appeared
    assert row.count() == 1
    assert golden_path_server['title'] in page.content()


# ── Party tab / party view ─────────────────────────────────────────────

def test_party_tab_votes_row_can_add_the_track_to_a_playlist(page, golden_path_server):
    """Ryan: "in party admin make adding to playlist an option." Each row
    of the admin's Votes table gets the same ♫+ the Discover/Downloads
    rows have, opening the same picker -- creating a playlist from it
    lands the voted track in a real playlist."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    page.locator('#tabs .tab-btn', has_text='Party').click()
    row = page.locator('#party-votes-table tbody tr', has_text=golden_path_server['title'])
    row.wait_for()
    # the floating PIP player from _download_and_play sits over the
    # table's right edge in this viewport and would swallow the click
    page.evaluate("vm => vm.closePlayer()", vm)
    row.locator('.playlist-add-btn').click()
    page.wait_for_selector('#playlist-picker:not(.hidden)')
    page.fill('#playlist-picker .playlist-picker-new input', 'party picks')
    page.click('#playlist-picker .playlist-picker-new button[type=submit]')
    page.wait_for_function("vm => vm.library.playlists.length === 1 && vm.library.playlists[0].items.length === 1", arg=vm)
    pl = page.evaluate("vm => vm.library.playlists[0]", vm)
    assert pl['name'] == 'party picks'
    assert pl['items'][0]['content_hash'] == golden_path_server['content_hash']
    assert page.locator('#playlist-picker.hidden').count() == 1


def test_party_view_keeps_the_stream_picture_stuck_to_the_top(page, golden_path_server, monkeypatch):
    """Ryan: "make the visualizer sticky in party view mode." A guest
    scrolling down the vote list keeps the live picture in view: the
    stream block is position: sticky, and its picture is capped below
    the viewport height so the list always has room under it."""
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-tok')
    # wait for the first /api/party answer before touching vm.party:
    # #party-view appears before that fetch lands, and its arrival would
    # overwrite the flags set below (a 5s poll follows, comfortably later)
    with page.expect_response(lambda r: '/api/party' in r.url and r.status == 200):
        page.goto(golden_path_server['web_url'] + '/?token=guest-tok')
    page.wait_for_selector('#party-view')
    vm = _vm(page)
    # no stream is running in this fixture: flip the flag the way a
    # refresh would once one starts, so the block renders
    page.evaluate("vm => { vm.party.stream.active = true; vm.party.stream.url = '/api/orbit-view'; vm.party.stream.since = 1; }", vm)
    # attached, not visible: with no real stream the <img> has no size yet
    page.wait_for_selector('.party-stream', state='attached')
    css = page.evaluate("() => { const b = getComputedStyle(document.querySelector('.party-stream')); const i = getComputedStyle(document.querySelector('.party-stream img')); return { position: b.position, top: b.top, maxHeight: i.maxHeight, fit: i.objectFit }; }")
    assert css['position'] == 'sticky' and css['top'] == '0px'
    assert css['maxHeight'].endswith('px') and float(css['maxHeight'][:-2]) < 900 * 0.5
    assert css['fit'] == 'contain'
