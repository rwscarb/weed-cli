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
    # Ryan: "remove the header in party mode": no site header, and no
    # placeholder "party" heading either -- the page starts at the picture
    assert page.locator('header').count() == 0
    assert page.locator('#party-view h2').count() == 0
    assert page.locator('#tabs').count() == 0
    # no stream is running in this fixture: flip the flag the way a
    # refresh would once one starts, so the block renders
    page.evaluate("vm => { vm.party.stream.active = true; vm.party.stream.url = '/api/orbit-view'; vm.party.stream.since = 1; vm.party.now_playing = { title: 'Late Night Mix.mp3', content_hash: 'a'.repeat(64) }; }", vm)
    # attached, not visible: with no real stream the <img> has no size yet
    page.wait_for_selector('.party-top .party-stream', state='attached')
    css = page.evaluate("() => { const b = getComputedStyle(document.querySelector('.party-top')); const i = getComputedStyle(document.querySelector('.party-stream img')); return { position: b.position, top: b.top, maxHeight: i.maxHeight, fit: i.objectFit }; }")
    assert css['position'] == 'sticky' and css['top'] == '0px'
    assert css['maxHeight'].endswith('px') and float(css['maxHeight'][:-2]) < 900 * 0.5
    assert css['fit'] == 'contain'
    # "now playing" rides inside the sticky block, without the file extension
    now = page.locator('.party-top .party-now')
    assert now.count() == 1
    assert now.inner_text().strip() == 'now playing: Late Night Mix'


def test_video_swap_borrows_another_downloads_picture_and_is_remembered(page, golden_path_server):
    """Ryan: "video swap" -- a user can choose a different video track to
    what's currently playing, for mp3s and static-image videos. The ⇄
    button lists the other downloads; picking one loads its stream into
    a muted, looping overlay <video> the visualizer samples instead, the
    choice is remembered per track, and "none" undoes it. The fixture
    has one real download, so a second record pointing at the same job
    stands in for "another video"."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    job_id = page.evaluate("vm => Object.values(vm.library.downloads)[0].job_id", vm)
    page.evaluate("([vm, jid]) => { vm.library.downloads['b'.repeat(64)] = { content_hash: 'b'.repeat(64), job_id: jid, title: 'Other Footage', path: '/x/other.mp4', signer_pubkey: null }; }", [vm, job_id])

    assert page.locator('#swap-picker.hidden').count() == 1
    page.click('#global-player .swap-btn')
    page.wait_for_selector('#swap-picker:not(.hidden)')
    page.locator('#swap-picker .playlist-picker-item-add', has_text='Other Footage').click()
    page.wait_for_function("vm => vm.player.swap && vm.player.swap.title === 'Other Footage'", arg=vm)
    assert page.locator('#swap-picker.hidden').count() == 1
    sv = page.locator('#global-player video.swap-video')
    assert sv.is_visible()
    assert sv.get_attribute('src') == f'/api/stream/{job_id}'
    # the fixture's "video" is random bytes (see make_fake_archive), so
    # neither element ever decodes a frame; the wiring is what's checked
    assert page.evaluate("() => { const v = document.querySelector('video.swap-video'); return v.muted && v.loop; }")
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('weed.player.swaps'))")
    assert saved[golden_path_server['content_hash']] == 'b' * 64

    # the track's own player still plays its own audio/video source
    assert page.evaluate("vm => vm.$refs.playerVideo.getAttribute('src')", vm) == f'/api/stream/{job_id}'

    # reopening the same track re-applies the remembered swap
    page.evaluate("vm => vm.closePlayer()", vm)
    assert page.evaluate("vm => vm.player.swap", vm) is None
    assert page.evaluate("() => document.querySelector('video.swap-video').getAttribute('src')") is None
    page.evaluate("([vm, jid, h]) => vm.openPlayer(jid, 'Test Clip', h, null)", [vm, job_id, golden_path_server['content_hash']])
    page.wait_for_function("vm => vm.player.swap && vm.player.swap.title === 'Other Footage'", arg=vm)

    # the picker's search box narrows the list; the swapped video has
    # its own seek slider (its clock, not the track's)
    page.evaluate("([vm, jid]) => { for (const [h, t] of [['c', 'Lava lamp loop.mp4'], ['d', 'Road trip 1997.mkv']]) vm.library.downloads[h.repeat(64)] = { content_hash: h.repeat(64), job_id: jid, title: t, path: '/x/' + t, signer_pubkey: null }; }", [vm, job_id])
    page.click('#global-player .swap-btn')
    page.wait_for_selector('#swap-picker:not(.hidden)')
    assert page.locator('#swap-picker .playlist-picker-item-add').count() == 4      # none + 3
    page.fill('#swap-picker .swap-search', 'lava')
    names = page.evaluate("() => [...document.querySelectorAll('#swap-picker .playlist-picker-item-name')].map(e => e.textContent)")
    assert [n for n in names if 'none' not in n] == ['Lava lamp loop.mp4']
    page.fill('#swap-picker .swap-search', 'zzz')
    assert page.locator('#swap-picker .playlist-picker-empty', has_text='nothing matches').count() == 1
    page.fill('#swap-picker .swap-search', '')
    assert page.locator('#swap-picker .swap-seek').count() == 1
    page.evaluate("vm => { vm.player.swapDuration = 120; }", vm)       # the fake clip never decodes; stand in for metadata
    page.locator('#swap-picker .swap-seek-slider').evaluate('(el) => { el.value = 42; el.dispatchEvent(new Event("input")); }')
    assert page.evaluate("vm => vm.player.swapTime", vm) == 42
    assert page.evaluate("vm => vm.$refs.swapVideo.currentTime", vm) == 42

    # "none" forgets it
    page.locator('#swap-picker .playlist-picker-item-add', has_text='none').click()
    page.wait_for_function("vm => vm.player.swap === null", arg=vm)
    assert page.evaluate("() => JSON.parse(localStorage.getItem('weed.player.swaps'))") == {}


def test_party_chat_posts_from_the_guest_page_and_overlays_the_picture(page, golden_path_server, monkeypatch):
    """Ryan: "a togglable chat feature where users can post messages
    overlaying the video." Off by default (no chat box for guests); the
    admin's Party tab switch turns it on; a guest's message shows in the
    list and, with no stream running, over the picture box. The admin
    sees it in the Party tab too."""
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-tok')
    monkeypatch.setattr(web_ui, 'CHAT_MIN_INTERVAL', 0.0)
    with web_ui._chat_lock:
        web_ui._chat_messages.clear(); web_ui._chat_last_post.clear()
    with web_ui._lock:
        web_ui._party_settings()['chat'] = False

    with page.expect_response(lambda r: '/api/chat' in r.url and r.status == 200):
        page.goto(golden_path_server['web_url'] + '/?token=guest-tok')
    page.wait_for_selector('#party-view')
    assert page.locator('.party-chat').count() == 0

    # the admin switches it on (server-side, as the Party tab's Save would)
    with web_ui._lock:
        web_ui._party_settings()['chat'] = True
    page.wait_for_selector('.party-chat', timeout=10_000)   # the next poll picks it up
    page.fill('.party-chat .chat-name', 'dave')
    page.fill('.party-chat .chat-input', 'turn it up')
    page.click('.party-chat button[type=submit]')
    page.wait_for_selector('.party-chat .chat-msg:has-text("turn it up")')
    assert page.locator('.party-chat .chat-msg b').first.inner_text() == 'dave'
    # no stream in this fixture: the overlay rides on the picture box
    overlay = page.locator('.party-top .chat-overlay .chat-line')
    assert overlay.count() == 1 and 'dave: turn it up' in overlay.first.inner_text()
    assert page.evaluate("() => localStorage.getItem('weed.chat.name')") == 'dave'

    # the admin page: the switch reflects the setting and the message is there
    page.goto(golden_path_server['web_url'] + '/?token=admin-tok')
    page.wait_for_selector('#tabs')
    page.locator('#tabs .tab-btn', has_text='Party').click()
    page.wait_for_selector('.admin-chat .chat-msg:has-text("turn it up")', timeout=10_000)
    # the switch fills from /api/party, a separate poll from the chat's
    page.wait_for_function("() => document.getElementById('party-chat-toggle').checked", timeout=10_000)
    # same browser as the guest above, so the remembered name is "dave";
    # blank it and the server's default for an admin applies
    page.fill('.admin-chat .chat-name', '')
    page.fill('.admin-chat .chat-input', 'no')
    page.click('.admin-chat button[type=submit]')
    page.wait_for_selector('.admin-chat .chat-msg:has-text("no")')
    assert page.locator('.admin-chat .chat-msg b').last.inner_text() == 'host'


def test_party_view_alphabetical_index_jumps_by_letter(page, golden_path_server, monkeypatch):
    """Ryan: "an alphabetical index along the right edge, like an iPod."
    The guest list is alphabetical; a strip of letters is pinned to the
    right edge; tapping (or dragging across) a letter scrolls the list
    to that letter's first track, landing just under the sticky top; a
    letter with no track is dimmed and lands on the next one that has.
    The leaders line keeps the vote ranking visible."""
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-tok')
    # seeded server-side (the page polls /api/party every few seconds and
    # would overwrite anything injected into the Vue state)
    names = ['Zebra', 'apple pie', 'Mango', 'banana', '99 problems', 'Tangerine', 'tango', 'Cherry', 'Yellow', 'Lemon', 'Kiwi', 'Quince',
             'Umbrella', 'Vortex', 'Waves', 'Xylophone', 'Zulu', 'Zapp']   # enough below T that T can reach the top
    with web_ui._lock:
        for i, n in enumerate(names):
            h = f'{i:064x}'
            web_ui._library['downloads'][h] = {'content_hash': h, 'job_id': f'seed{i}', 'title': n + '.mp4', 'path': f'/x/{n}.mp4', 'signer_pubkey': None}
            if n == 'Mango': web_ui._party_votes[h] = {'v1', 'v2', 'v3', 'v4', 'v5'}
            if n == 'Kiwi': web_ui._party_votes[h] = {'v1', 'v2'}
    with page.expect_response(lambda r: '/api/party' in r.url and r.status == 200):
        page.goto(golden_path_server['web_url'] + '/?token=guest-tok')
    page.wait_for_selector('.party-index')
    titles = page.evaluate("() => [...document.querySelectorAll('.party-tracks .party-track-title')].map(e => e.textContent)")
    # case-insensitive, numbers first ('tange…' sorts before 'tango')
    assert titles == ['99 problems', 'apple pie', 'banana', 'Cherry', 'Kiwi', 'Lemon', 'Mango', 'Quince', 'Tangerine', 'tango',
                      'Umbrella', 'Vortex', 'Waves', 'Xylophone', 'Yellow', 'Zapp', 'Zebra', 'Zulu']
    assert 'Mango' in page.locator('.party-leaders').inner_text() and page.locator('.party-leaders strong').first.inner_text() == 'Mango'
    letters = page.evaluate("() => [...document.querySelectorAll('.party-index-letter')].map(e => e.textContent)")
    assert letters[0] == '#' and letters[-1] == 'Z' and len(letters) == 27
    assert 'dim' not in page.locator('.party-index-letter[data-letter="B"]').get_attribute('class')   # banana
    assert 'dim' in page.locator('.party-index-letter[data-letter="D"]').get_attribute('class')       # nothing under D
    assert 'dim' not in page.locator('.party-index-letter[data-letter="M"]').get_attribute('class')

    page.set_viewport_size({'width': 420, 'height': 400})   # short: the list has to scroll
    page.locator('.party-index-letter[data-letter="T"]').click()
    page.wait_for_function("() => window.scrollY > 0")
    first_t = page.locator('.party-tracks li[data-letter="T"]').first
    box = first_t.bounding_box(); sticky = page.locator('.party-top').bounding_box()
    assert abs(box['y'] - (sticky['y'] + sticky['height'])) < 12
    assert page.locator('.party-index-bubble').count() == 0   # released
    # an empty letter lands on the next one that has a track
    page.locator('.party-index-letter[data-letter="N"]').click()
    first_q = page.locator('.party-tracks li[data-letter="Q"]').first
    box = first_q.bounding_box()
    assert abs(box['y'] - (sticky['y'] + sticky['height'])) < 12


def test_player_header_stacks_the_marquee_above_the_buttons_with_an_add_to_playlist(page, golden_path_server):
    """Ryan: "move the marquee above the buttons and add a button to add
    to playlist." The title row sits above the controls row, and the
    header's ♫+ opens the same picker the table rows use, for whatever
    is playing."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    title = page.locator('#global-player .player-title').bounding_box()
    controls = page.locator('#global-player .player-controls').bounding_box()
    assert title['y'] + title['height'] <= controls['y'] + 1, (title, controls)
    page.click('#global-player .player-controls .playlist-add-btn')
    page.wait_for_selector('#playlist-picker:not(.hidden)')
    assert page.evaluate("vm => vm.playlistPicker.item.content_hash", vm) == golden_path_server['content_hash']
    page.fill('#playlist-picker .playlist-picker-new input', 'from the player')
    page.click('#playlist-picker .playlist-picker-new button[type=submit]')
    page.wait_for_function("vm => vm.library.playlists.some(p => p.name === 'from the player' && p.items.length === 1)", arg=vm)


def test_autopilot_keeps_the_music_going_when_nothing_is_queued(page, golden_path_server):
    """The other half of Autopilot: a track ends, nothing is queued, so it
    plays the download heard least recently (never the one that just
    ended). Off, the player just stops as before."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    job_id = page.evaluate("vm => Object.values(vm.library.downloads)[0].job_id", vm)
    page.evaluate("""([vm, jid]) => { vm.library.downloads['b'.repeat(64)] = { content_hash: 'b'.repeat(64), job_id: jid + '-b', title: 'Never played', path: '/x/b.mp4', signer_pubkey: null, last_played: 0 };
      vm.library.downloads['c'.repeat(64)] = { content_hash: 'c'.repeat(64), job_id: jid + '-c', title: 'Played earlier', path: '/x/c.mp4', signer_pubkey: null, last_played: 1000 }; }""", [vm, job_id])
    page.evaluate("vm => { vm.player.queue = null; vm.onPlayerEnded(); }", vm)
    assert page.evaluate("vm => vm.player.jobId", vm) == job_id            # autopilot off: nothing happens
    page.evaluate("() => localStorage.setItem('weed.orbit.settings', JSON.stringify({ autopilot: true }))")
    assert page.evaluate("() => window.orbitViz.autopilot()") is True
    # play count weighs in: a never-played track should win the lottery
    # far more often than one heard ten times a moment ago, and the
    # track that just ended is never picked
    page.evaluate("([vm, jid]) => { vm.library.downloads['c'.repeat(64)].play_count = 10; vm.library.downloads['c'.repeat(64)].last_played = Date.now() / 1000; }", [vm, job_id])
    picks = page.evaluate("vm => { const out = {}; for (let i = 0; i < 400; i++) { const p = vm.autopilotPick(); out[p.title] = (out[p.title] || 0) + 1; } return out; }", vm)
    assert 'Test Clip' not in picks and picks.get('Never played', 0) > 300, picks
    # the 🤖 control's ↑ state turns the lottery over: the most-played track wins instead
    page.evaluate("() => localStorage.setItem('weed.orbit.settings', JSON.stringify({ autopilot: true, autopilotBias: 'up' }))")
    assert page.evaluate("() => window.orbitViz.autopilotBias()") == 'up'
    picks = page.evaluate("vm => { const out = {}; for (let i = 0; i < 400; i++) { const p = vm.autopilotPick(); out[p.title] = (out[p.title] || 0) + 1; } return out; }", vm)
    assert 'Test Clip' not in picks and picks.get('Played earlier', 0) > 300, picks
    page.evaluate("() => localStorage.setItem('weed.orbit.settings', JSON.stringify({ autopilot: true }))")
    page.evaluate("vm => { vm.player.queue = null; vm.onPlayerEnded(); }", vm)
    assert page.evaluate("vm => vm.player.title", vm) in ('Never played', 'Played earlier')


def test_stream_frames_fill_the_frame_at_the_stream_aspect(page, golden_path_server):
    """Ryan: "in party view the stream looks squished narrow on the
    x-axis", then "fixed in the party viewer, but not in /api/orbit-view".
    The stream frame is a fixed 16:9 and the visualizer canvas is whatever
    the window made it. First fix aspect-fit the capture, which stopped
    the distortion but put black bars in every viewer's frame. Now the
    canvas bitmap itself is held at the stream's 16:9 while streaming
    (letterboxed on screen by object-fit), so the frame that goes out on
    /api/orbit-view is filled edge to edge, and released when it stops."""
    import base64, http.client
    from urllib.parse import urlparse
    page.set_viewport_size({'width': 700, 'height': 900})   # a tall window: the canvas would end up nearly square
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')
    page.click('[data-viz="plasma"]')                         # fills the whole canvas with colour
    before = page.evaluate("() => { const c = document.getElementById('vizCanvas'); return [c.width, c.height]; }")
    assert before[0] / before[1] < 1.4, before                 # genuinely not 16:9 on its own
    page.evaluate("vm => vm.toggleOrbitStream()", vm)
    page.wait_for_function("vm => vm.orbitStreaming", arg=vm, timeout=10_000)
    page.wait_for_timeout(1500)
    canvas = page.evaluate("() => { const c = document.getElementById('vizCanvas'); return [c.width, c.height, c.offsetWidth, c.offsetHeight]; }")
    assert abs(canvas[0] / canvas[1] - 16 / 9) < 0.01, canvas  # bitmap held at the stream's shape...
    assert canvas[0] <= canvas[2] and canvas[1] < canvas[3], canvas   # ...inside the element, letterboxed on screen
    # what a viewer actually receives: one real JPEG off /api/orbit-view
    u = urlparse(golden_path_server['web_url'])
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=15)
    conn.request('GET', '/api/orbit-view')
    resp = conn.getresponse()
    assert resp.status == 200
    buf = b''
    while True:
        chunk = resp.fp.read1(65536)
        assert chunk, 'stream ended without a frame'
        buf += chunk
        s0 = buf.find(b'\xff\xd8')
        e0 = buf.find(b'\xff\xd9', s0) if s0 >= 0 else -1
        if e0 > 0:
            break
    conn.close()
    # decoded by the browser itself (no PIL in CI): size, and a sample
    # at every edge and the middle
    shot = page.evaluate("""async (b64) => {
        const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const px = (X, Y) => [...x.getImageData(X, Y, 1, 1).data].slice(0, 3);
        return { w: c.width, h: c.height, samples: [[4, 360], [1275, 360], [640, 4], [640, 715], [640, 360]].map(([X, Y]) => [X, Y, px(X, Y)]) };
    }""", base64.b64encode(buf[s0:e0 + 2]).decode())
    assert (shot['w'], shot['h']) == (1280, 720), shot
    for x, y, rgb in shot['samples']:
        assert sum(rgb) > 60, (x, y, rgb)                       # picture right out to every edge, no bars
    page.evaluate("vm => vm.toggleOrbitStream()", vm)
    page.wait_for_function("vm => !vm.orbitStreaming", arg=vm, timeout=10_000)
    after = page.evaluate("() => { const c = document.getElementById('vizCanvas'); return [c.width, c.height]; }")
    assert after[0] / after[1] < 1.4, after                    # its own shape again once the stream stops


def test_stream_audio_toggle_sends_opus_and_late_listeners_get_a_clean_start(page, golden_path_server, monkeypatch):
    """The 🔊 toggle next to 📡: with it on, the streamer's browser records
    the player's audio (MediaRecorder, WebM/Opus in Chromium) and pushes
    it over a second WebSocket; the server serves it live on
    /api/orbit-audio. The hard part is a listener who connects after the
    recording started -- a WebM reader needs the container's init segment
    and then a Cluster boundary, so the relay caches the one and cuts at
    the other (web_ui._LiveContainerRelay). Both a first and a later
    fetch must therefore start with the EBML magic. The guest page shows
    a 🔊 listen button for it (tap to play -- never autoplay). The seeded
    clip is random bytes that never decode, so what's recorded here is
    the audio graph's silence: still real Opus in a real WebM."""
    import http.client, json, time
    from urllib.parse import urlparse
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')
    assert page.evaluate("vm => vm.orbitAudio", vm) is False           # off by default
    page.click('#orbit-egg-dialog .orbit-audio-btn')
    page.wait_for_function("vm => vm.orbitAudio", arg=vm)
    saved = json.loads(page.evaluate("() => localStorage.getItem('weed.stream.settings')"))
    assert saved['orbitAudio'] is True                                  # persisted with the other stream settings
    page.evaluate("vm => vm.toggleOrbitStream()", vm)
    page.wait_for_function("vm => vm.orbitStreaming", arg=vm, timeout=10_000)
    page.wait_for_function(
        "() => fetch('/api/party').then(r => r.json()).then(p => p.stream.active && p.stream.audio)", timeout=10_000)
    party = page.evaluate("() => fetch('/api/party').then(r => r.json())")
    assert party['stream']['audio_url'] == '/api/orbit-audio'
    assert party['stream']['audio_mime'].startswith('audio/webm')
    status = page.evaluate("() => fetch('/api/orbit-stream').then(r => r.json())")
    assert status['audio'] is True and status['audio_url'].endswith('/api/orbit-audio')

    u = urlparse(golden_path_server['web_url'])
    def grab(path, min_bytes=3000, seconds=8):
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=15)
        conn.request('GET', path)
        resp = conn.getresponse()
        assert resp.status == 200, resp.status
        assert resp.getheader('Content-Type').startswith('audio/webm')
        assert resp.getheader('Content-Length') is None
        buf = b''
        deadline = time.time() + seconds
        while len(buf) < min_bytes and time.time() < deadline:
            chunk = resp.fp.read1(65536)
            if not chunk:
                break
            buf += chunk
        conn.close()
        return buf
    EBML, CLUSTER = b'\x1a\x45\xdf\xa3', b'\x1f\x43\xb6\x75'
    first = grab('/api/orbit-audio')
    assert first[:4] == EBML, first[:16]
    # silence encodes tiny (Opus emits ~3-byte frames for it, ~300 B/s
    # with cluster overhead), so "flowing" is a modest floor, not a rate
    assert len(first) >= 1200, len(first)
    assert CLUSTER in first

    # the late joiner, a couple of seconds in -- and through the ?token=
    # door a player would use, once auth is on
    time.sleep(2)
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-tok')
    second = grab('/api/orbit-audio?token=guest-tok')
    assert second[:4] == EBML, second[:16]                              # the cached init segment...
    assert CLUSTER in second                                            # ...then whole clusters
    assert len(second) >= 1200, len(second)

    # the guest page: a 🔊 listen button under the picture, tap to play
    guest_ctx = page.context.browser.new_context(viewport={'width': 400, 'height': 800})
    guest = guest_ctx.new_page()
    try:
        with guest.expect_response(lambda r: '/api/party' in r.url and r.status == 200):
            guest.goto(golden_path_server['web_url'] + '/?token=guest-tok')
        guest.wait_for_selector('#party-view .party-stream img')
        listen = guest.locator('.party-listen-btn')
        assert listen.inner_text().strip() == '🔊 listen'
        gvm = _vm(guest)
        assert guest.evaluate("vm => vm.partyListening", gvm) is False
        listen.click()
        guest.wait_for_function("vm => vm.partyListening", arg=gvm)
        assert listen.inner_text().strip() == '🔇 mute'
        assert guest.evaluate("vm => vm._partyAudio && vm._partyAudio.src.includes('/api/orbit-audio?_=')", gvm)
        # the element is actually pulling the feed: the server counts it as
        # a listener. (Not readyState: on the silence recorded here, ~300
        # B/s, Chromium sits at HAVE_NOTHING for ages waiting to fill its
        # first read buffer, while real music at 128 kbps is instant.)
        page.wait_for_function(
            "() => fetch('/api/orbit-stream?token=admin-tok').then(r => r.json()).then(s => s.audio_listeners >= 1)", timeout=10_000)
        listen.click()                                                  # 🔇 drops it
        guest.wait_for_function("vm => !vm.partyListening && !vm._partyAudio", arg=gvm)
        assert listen.inner_text().strip() == '🔊 listen'
    finally:
        guest_ctx.close()

    # 🔊 off mid-stream stops the sender: the feed goes away, the picture
    # stays. A DOM click, not a pointer one: auth went on above, so the
    # admin page's polls are now 401 and its unlock gate sits over the UI.
    page.evaluate("() => document.querySelector('#orbit-egg-dialog .orbit-audio-btn').click()")
    page.wait_for_function(
        "() => fetch('/api/orbit-stream?token=admin-tok').then(r => r.json()).then(s => s.audio === false)", timeout=10_000)
    assert page.evaluate("vm => vm.orbitStreaming", vm) is True
    page.evaluate("vm => vm.toggleOrbitStream()", vm)
    page.wait_for_function("vm => !vm.orbitStreaming", arg=vm, timeout=10_000)


def test_tags_on_downloads_filter_the_table_and_steer_autopilot(page, golden_path_server):
    """Ryan: "can you add a tagging feature?" A finished download's row
    in the Downloads tab has tag chips and a "+ tag" field; the bar above
    the table filters by tag; tags live on the library record (server,
    /api/tags) so they survive a reload; and Autopilot's "tracks tagged"
    pick draws the next track only from a tag."""
    _download_and_play(page, golden_path_server)
    vm = _vm(page)
    page.click('.tab-btn:has-text("Downloads")')
    row = page.locator('#jobs-table tbody tr').first
    assert not page.locator('#tag-filter').is_visible()                  # no tags yet, no bar
    # the field is folded behind a + until asked for
    assert row.locator('.tag-add').count() == 0
    row.locator('.tag-plus').click()
    field = row.locator('.tag-add')
    assert page.evaluate("() => document.activeElement.classList.contains('tag-add')")
    field.fill('Chill, party')
    field.press('Enter')
    page.wait_for_function("() => document.querySelectorAll('#jobs-table .tag-row .tag-chip').length === 2")
    chips = page.locator('#jobs-table .tag-row .tag-chip')
    assert [c.inner_text().strip().rstrip('×').strip() for c in chips.all()] == ['chill', 'party']   # normalised
    assert field.input_value() == ''
    page.keyboard.press('Escape')                                       # folds the field away again
    assert row.locator('.tag-add').count() == 0 and row.locator('.tag-plus').count() == 1
    # the filter bar: all / chill / party, with counts
    bar = page.locator('#tag-filter')
    assert bar.is_visible()
    assert [b.inner_text().split()[0] for b in bar.locator('button.tag-chip').all()] == ['all', 'chill', 'party']
    # a second row-less tag on a fake download, to see filtering exclude it
    page.evaluate("vm => { vm.library.downloads['e'.repeat(64)] = { content_hash: 'e'.repeat(64), job_id: 'zz', title: 'Other', path: '/x/e.mp4', tags: ['other'] }; vm.jobs.push({ job_id: 'zz', content_hash: 'e'.repeat(64), title: 'Other', status: 'done' }); }", vm)
    assert page.locator('#jobs-table tbody tr').count() == 2
    bar.locator('button.tag-chip', has_text='party').click()
    assert page.locator('#jobs-table tbody tr').count() == 1
    # checkbox-style: with party lit, every other chip's count is the
    # intersection with party -- chill 1 (Test Clip has both), other 0
    # (dimmed) -- and lighting chill too keeps the row, lighting other
    # would leave nothing
    counts = lambda: {b.inner_text().split()[0]: b.inner_text().split()[-1] for b in bar.locator('button.tag-chip').all() if not b.inner_text().startswith('all')}
    assert counts() == {'party': '1', 'chill': '1', 'other': '0'}, counts()
    assert 'empty' in bar.locator('button.tag-chip', has_text='other').get_attribute('class')
    bar.locator('button.tag-chip', has_text='chill').click()
    assert page.locator('#jobs-table tbody tr').count() == 1
    assert page.evaluate("vm => vm.tagFilters", vm) == ['party', 'chill']
    bar.locator('button.tag-chip', has_text='party').click()                # unlight one: chill alone
    assert page.evaluate("vm => vm.tagFilters", vm) == ['chill']
    assert counts() == {'chill': '1', 'party': '1', 'other': '0'}, counts()
    bar.locator('button.tag-chip', has_text='all').click()
    assert page.locator('#jobs-table tbody tr').count() == 2
    assert counts() == {'chill': '1', 'party': '1', 'other': '1'}, counts()
    # remove one: the chip goes, the bar follows
    page.locator('#jobs-table .tag-row .tag-chip', has_text='party').locator('.tag-x').click()
    page.wait_for_function("() => document.querySelector('#jobs-table tbody tr .tag-row').querySelectorAll('.tag-chip').length === 1")
    assert [b.inner_text().split()[0] for b in bar.locator('button.tag-chip').all()] == ['all', 'chill', 'other']
    # suggestions: focus the field and the tags in use elsewhere appear as
    # chips (Vue-rendered, so the polls that re-render the table can't
    # close them the way they did the native datalist); a tap adds one
    page.locator('#jobs-table tbody tr').first.locator('.tag-plus').click()
    field = page.locator('#jobs-table tbody tr').first.locator('.tag-add')
    sugg = page.locator('#jobs-table tbody tr').first.locator('.tag-suggestion')
    assert sugg.all_inner_texts() == ['+ other']
    field.type('zz')
    assert sugg.count() == 0                                             # nothing starts with zz
    field.fill('o')
    assert sugg.all_inner_texts() == ['+ other']
    sugg.first.click()
    page.wait_for_function("() => document.querySelector('#jobs-table tbody tr .tag-row').querySelectorAll('.tag-chip:not(.tag-suggestion)').length === 2")
    assert field.input_value() == '' and sugg.count() == 0
    assert page.evaluate("() => document.activeElement.classList.contains('tag-add')")   # still focused for the next one
    page.locator('#jobs-table tbody tr').first.locator('.tag-row .tag-chip', has_text='other').locator('.tag-x').click()
    page.wait_for_function("() => document.querySelector('#jobs-table tbody tr .tag-row').querySelectorAll('.tag-chip:not(.tag-suggestion)').length === 1")
    # persisted on the server
    h = golden_path_server['content_hash']
    lib = page.evaluate("() => fetch('/api/library').then(r => r.json())")
    assert next(d for d in lib['downloads'] if d['content_hash'] == h)['tags'] == ['chill']
    # Autopilot's tag: with 'chill' chosen only the chill track is in the draw
    page.evaluate("vm => { vm.library.downloads['f'.repeat(64)] = { content_hash: 'f'.repeat(64), job_id: 'ff', title: 'Chilly too', path: '/x/f.mp4', tags: ['chill'] }; vm.player.contentHash = 'zzz'; }", vm)
    page.evaluate("vm => { vm.autopilotTag = 'chill'; vm.saveAutopilotTag(); }", vm)
    picks = page.evaluate("vm => { const out = {}; for (let i = 0; i < 100; i++) { const p = vm.autopilotPick(); out[p.title] = (out[p.title] || 0) + 1; } return out; }", vm)
    assert set(picks) <= {'Test Clip', 'Chilly too'} and len(picks) == 2, picks
    assert page.evaluate("() => localStorage.getItem('weed.autopilot.tag')") == 'chill'
    page.evaluate("vm => { vm.autopilotTag = 'nothing-has-this'; }", vm)
    picks = page.evaluate("vm => { const out = {}; for (let i = 0; i < 100; i++) { const p = vm.autopilotPick(); out[p.title] = (out[p.title] || 0) + 1; } return out; }", vm)
    assert 'Other' in picks                                             # no match: everything, not silence
    # the pick is in the visualizer's Autopilot pool row
    page.click('#global-player .icon-btn[title="Orbit Visualizer"]')
    page.wait_for_selector('#vizModes')
    page.click('#autoPoolBtn')
    assert [o.strip() for o in page.locator('#autoTagSelect option').all_inner_texts()][:2] == ['any', 'chill (2)']
    # the ⇄ video-swap picker has the same tag dropdown, narrowing its candidates
    page.evaluate("vm => { vm.easterEggVisible = false; vm.player.contentHash = 'zzz'; vm.swapPicker.visible = true; vm.swapPicker.tag = 'other'; }", vm)
    assert page.evaluate("vm => vm.swapCandidatesFiltered.map(d => d.title)", vm) == ['Other']
    page.evaluate("vm => { vm.swapPicker.tag = 'chill'; }", vm)
    assert sorted(page.evaluate("vm => vm.swapCandidatesFiltered.map(d => d.title)", vm)) == ['Chilly too', 'Test Clip']
    page.evaluate("vm => { vm.swapPicker.tag = ''; }", vm)
    assert len(page.evaluate("vm => vm.swapCandidatesFiltered", vm)) == 3
    assert [o.strip() for o in page.locator('#swap-picker select.swap-tag option').all_inner_texts()] == ['any tag', 'chill (2)', 'other (1)']
