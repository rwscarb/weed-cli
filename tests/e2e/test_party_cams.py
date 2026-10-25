"""
The party webcams for real: the host (Party tab) and a guest (party
page) each join with Chromium's fake camera and mic, and each ends up
playing the other's video over a real WebRTC connection the server only
signalled for (see vue-app.js joinCam). Then the guest leaves, and the
host's tile for them goes away.
"""
import os

import pytest

import web_ui


@pytest.fixture()
def cam_browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('WEED_TEST_CHROMIUM') or None, args=[
            '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        yield b
        b.close()


_VM = "document.getElementById('app').__vue_app__._container._vnode.component.proxy"

# every remote tile showing real frames: the video decoded something
_PLAYING = f"""n => {{ const vm = {_VM}; const remote = vm.cam.tiles.filter(t => !t.me);
  if (remote.length !== n) return false;
  const vids = [...document.querySelectorAll('.cam-tile:not(.me) video')];
  return vids.length === n && vids.every(v => v.videoWidth > 0 && v.readyState >= 2 && !v.paused); }}"""


def test_host_and_guest_see_each_other_on_camera(cam_browser, golden_path_server, monkeypatch):
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-secret')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-secret')
    web_ui._cam_clear()
    with web_ui._lock:
        web_ui._party_settings()['cam'] = True
    url = golden_path_server['web_url']

    host = cam_browser.new_page()
    host.goto(f'{url}/?token=admin-secret#party')
    host.wait_for_function(f"() => {_VM}.cam.enabled", timeout=10_000)
    host.click('.admin-cams button:has-text("join")')
    host.wait_for_function(f"() => {_VM}.cam.joined", timeout=10_000)
    # your own picture, muted so your mic never plays back at you
    assert host.evaluate("() => { const v = document.querySelector('.cam-tile.me video'); return !!v && v.muted; }")

    guest = cam_browser.new_page()
    guest.goto(f'{url}/?token=guest-secret')
    guest.wait_for_function(f"() => {_VM}.partyMode && {_VM}.cam.enabled", timeout=10_000)
    guest.click('.party-cams button:has-text("join")')

    guest.wait_for_function(_PLAYING, arg=1, timeout=20_000)
    host.wait_for_function(_PLAYING, arg=1, timeout=20_000)
    # both directions carry sound too
    for pg in (host, guest):
        assert pg.evaluate(f"""() => {{ const t = {_VM}.cam.tiles.find(t => !t.me);
          return t.stream.getAudioTracks().length === 1 && t.stream.getVideoTracks().length === 1; }}""")

    guest.click('.party-cams button:has-text("leave")')
    host.wait_for_function(f"() => {_VM}.cam.tiles.length === 1", timeout=10_000)
    with web_ui._cam_lock:
        assert len(web_ui._cam_roster()) == 1
