"""The Kodi add-on (kodi/plugin.video.weed) against a real, isolated
web_ui server -- same fixture as the API tests. Kodi itself isn't here:
the add-on keeps every decision in resources/lib/plugin.py behind a
small ui object, and FakeUI below records what a real Kodi would have
been told to draw or play. default.py (the xbmc glue) is only checked
for syntax and the URL it builds, with the xbmc modules stubbed."""
import importlib.util
import os
import sys
import types

import pytest

import web_ui
from testutil import http_get_json, http_post_json

ADDON = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'kodi', 'plugin.video.weed')
sys.path.insert(0, ADDON)
from resources.lib import plugin, weedapi   # noqa: E402


class FakeUI:
    def __init__(self, server, token=None):
        self._settings = {'server': server, 'token': token or ''}
        self.folders, self.items, self.played, self.queued, self.notices, self.ended = [], [], [], [], [], []

    def settings(self): return dict(self._settings)
    def folder(self, label, action, **params): self.folders.append((label, action, params))
    def media(self, label, url, info, action, **params): self.items.append((label, url, info, action, params))
    def end(self, content=None): self.ended.append(content)
    def play(self, url, label, info): self.played.append((url, label, info))
    def play_all(self, entries): self.queued.append(entries)
    def notify(self, message): self.notices.append(message)


def _seed(n=3):
    with web_ui._lock:
        for i in range(n):
            h = chr(ord('a') + i) * 64
            web_ui._library['downloads'][h] = {
                'content_hash': h, 'job_id': 'job%d' % i, 'path': '/x/%d.%s' % (i, 'mp3' if i == 2 else 'mp4'),
                'title': 'Track %d.%s' % (i, 'mp3' if i == 2 else 'mp4'), 'downloaded_at': 100 + i, 'size': 1000 * (i + 1),
                'play_count': i, 'tags': ['chill'] if i < 2 else ['party'],
            }
        web_ui._library['downloads']['unfinished'] = {'content_hash': 'unfinished', 'title': 'Not yet'}
        web_ui._library['playlists'] = [{'id': 'pl1', 'name': 'Late', 'items': [
            {'content_hash': 'b' * 64, 'title': 'Track 1.mp4'}, {'content_hash': 'a' * 64, 'title': 'Track 0.mp4'}, {'content_hash': 'zz', 'title': 'gone'}]}]
        web_ui._save_library()


def test_display_title_drops_only_a_media_extension():
    assert weedapi.display_title('Late Night Mix.mp3') == 'Late Night Mix'
    assert weedapi.display_title('Track 8.MP4') == 'Track 8'
    assert weedapi.display_title('v1.2 notes') == 'v1.2 notes'
    assert weedapi.display_title(None) == ''


def test_root_and_downloads_list_finished_tracks_newest_first(web_server):
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run()
    assert [f[1] for f in ui.folders] == ['downloads', 'playlists', 'tags', 'party', 'live', 'live', 'live', 'autopilot']
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='downloads')
    assert [m[0] for m in ui.items] == ['Track 2', 'Track 1', 'Track 0']          # newest first, extension dropped, no unfinished
    label, url, info, action, params = ui.items[0]
    assert url == web_server + '/api/stream/job2' and action == 'play'
    assert params['job_id'] == 'job2' and params['content_hash'] == 'c' * 64
    assert info['mediatype'] == 'song' and info['playcount'] == 2               # an mp3 is a song, and the count comes through
    assert ui.ended == ['musicvideos']


def test_tags_playlists_and_play_all(web_server):
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='tags')
    assert [f[0] for f in ui.folders] == ['chill (2)', 'party (1)']
    assert ui.folders[0][2] == {'tag': 'chill'}
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='downloads', tag='chill', sort='title')
    assert [m[0] for m in ui.items] == ['Track 0', 'Track 1']
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='playlists')
    assert ui.folders == [('Late (3)', 'playlist', {'id': 'pl1'})]
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='playlist', id='pl1')
    assert ui.folders[0][1] == 'playall'
    assert [m[0] for m in ui.items] == ['Track 1', 'Track 0']                  # playlist order, the undownloaded one skipped
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='playall', id='pl1')
    assert [e[0] for e in ui.queued[0]] == [web_server + '/api/stream/job1', web_server + '/api/stream/job0']


def test_play_resolves_the_stream_url_and_counts_the_play(web_server):
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='play', job_id='job0', content_hash='a' * 64, title='Track 0')
    assert ui.played == [(web_server + '/api/stream/job0', 'Track 0', {'title': 'Track 0'})]
    lib = http_get_json(web_server + '/api/library')
    rec = next(d for d in lib['downloads'] if d['content_hash'] == 'a' * 64)
    assert rec['play_count'] == 1 and rec['last_played'] > 0
    assert lib['history'][0]['content_hash'] == 'a' * 64


def test_autopilot_pick_never_chooses_nothing_and_counts(web_server):
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='autopilot')
    assert len(ui.played) == 1 and ui.played[0][0].startswith(web_server + '/api/stream/job')
    lib = http_get_json(web_server + '/api/library')
    assert sum(d.get('play_count', 0) for d in lib['downloads']) == 0 + 1 + 2 + 1   # one more play somewhere


def test_token_goes_in_the_header_and_the_stream_query(web_server, monkeypatch):
    _seed()
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    ui = FakeUI(web_server, token='admin-tok')
    plugin.Plugin(ui).run(action='downloads')
    assert ui.items and ui.items[0][1].endswith('/api/stream/job2?token=admin-tok')
    # a wrong token is a clear message, not a stack trace
    ui = FakeUI(web_server, token='nope')
    plugin.Plugin(ui).run(action='downloads')
    assert ui.items == [] and 'token' in ui.notices[0]


def test_live_feeds_and_party_when_nothing_is_streaming(web_server):
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='live', what='view')
    assert ui.played == [] and 'not streaming' in ui.notices[0]
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='party')
    assert ui.folders and all(f[1] == 'vote' or f[1] == 'party' for f in ui.folders)
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='vote', content_hash='a' * 64)
    assert ui.notices == ['voted']
    party = http_get_json(web_server + '/api/party')
    assert any(t['content_hash'] == 'a' * 64 and (t.get('votes') or t.get('score')) for t in party['tracks'])


def test_no_server_set_is_a_settings_hint_not_a_crash():
    ui = FakeUI('')
    plugin.Plugin(ui).run(action='downloads')
    assert 'settings' in ui.notices[0] and ui.ended == [None]


def test_default_py_builds_plugin_urls_with_stubbed_kodi(monkeypatch):
    """default.py imports the xbmc modules at the top; stub them and check
    the glue: settings come from the add-on, a folder becomes a
    plugin:// URL with the action and params in the query."""
    calls = []
    xbmc = types.SimpleNamespace(log=lambda *a: None, LOGINFO=1, PLAYLIST_VIDEO=1,
                                 Player=lambda: types.SimpleNamespace(play=lambda *a: calls.append(('play',) + a)),
                                 PlayList=lambda k: types.SimpleNamespace(clear=lambda: None, add=lambda *a: calls.append(('add',) + a)))
    xbmcaddon = types.SimpleNamespace(Addon=lambda: types.SimpleNamespace(
        getAddonInfo=lambda k: ADDON, getSetting=lambda k: {'server': 'http://node:8080', 'token': 't', 'insecure': 'true'}[k]))
    xbmcgui = types.SimpleNamespace(ListItem=lambda **kw: types.SimpleNamespace(setInfo=lambda *a: None, setProperty=lambda *a: None, **kw),
                                    Dialog=lambda: types.SimpleNamespace(notification=lambda *a: calls.append(('notify',) + a)), NOTIFICATION_INFO=0)
    xbmcplugin = types.SimpleNamespace(addDirectoryItem=lambda h, url, item, isFolder=False: calls.append(('dir', url, item.label, isFolder)),
                                       endOfDirectory=lambda h: calls.append(('end',)), setContent=lambda h, c: calls.append(('content', c)),
                                       setResolvedUrl=lambda h, ok, item: calls.append(('resolved', item.path)))
    for name, mod in (('xbmc', xbmc), ('xbmcaddon', xbmcaddon), ('xbmcgui', xbmcgui), ('xbmcplugin', xbmcplugin)):
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(sys, 'argv', ['plugin://plugin.video.weed/', '7', '?action=root'])
    spec = importlib.util.spec_from_file_location('weed_default', os.path.join(ADDON, 'default.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ui = mod.KodiUI()
    assert ui.settings() == {'server': 'http://node:8080', 'token': 't', 'insecure': True}
    ui.folder('Downloads', 'downloads', tag='chill')
    assert calls[-1] == ('dir', 'plugin://plugin.video.weed/?action=downloads&tag=chill', 'Downloads', True)
    ui.media('Track', 'http://node:8080/api/stream/j1?token=t', {'title': 'Track', 'mediatype': 'musicvideo'}, action='play', job_id='j1', content_hash='h', title='Track')
    assert calls[-1][1] == 'plugin://plugin.video.weed/?action=play&job_id=j1&content_hash=h&title=Track' and calls[-1][3] is False
    ui.end('musicvideos')
    assert calls[-2:] == [('content', 'musicvideos'), ('end',)]
    ui.play('http://node:8080/api/stream/j1?token=t', 'Track', {'title': 'Track'})
    assert calls[-1][0] == 'play'                                             # not invoked as a resolver here
    monkeypatch.setattr(sys, 'argv', ['plugin://plugin.video.weed/', '7', '?action=play&job_id=j1'])
    ui.play('http://node:8080/api/stream/j1?token=t', 'Track', {'title': 'Track'})
    assert calls[-1] == ('resolved', 'http://node:8080/api/stream/j1?token=t')


def test_kodi_own_url_parameters_are_ignored(web_server):
    """Ryan's first launch: Kodi opens a video+audio add-on with
    ?content_type=video, which crashed do_root(). Any parameter a screen
    doesn't declare is dropped, on every screen."""
    _seed()
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(content_type='video')
    assert [f[1] for f in ui.folders][:2] == ['downloads', 'playlists'] and not ui.notices
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='downloads', content_type='audio', tag='chill')
    assert [m[0] for m in ui.items] == ['Track 1', 'Track 0'] and not ui.notices


def test_live_feed_urls_come_from_the_configured_node_not_its_advertised_plain_port(web_server, monkeypatch):
    """Ryan: "unable to view the orbit stream, the log says it's trying
    4242, but that's the old port". The node still advertised a plain
    stream port that was no longer exposed; the add-on now builds the feed
    URLs from its own node URL, with the token, and only takes the
    advertised plain URL when the node is https."""
    _seed()
    monkeypatch.setattr(web_ui, '_orbit_ws_connected', True)
    monkeypatch.setattr(web_ui, 'STREAM_PLAIN_PORT', 4242)
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    ui = FakeUI(web_server, token='admin-tok')
    plugin.Plugin(ui).run(action='live', what='view')
    assert ui.played and ui.played[0][0] == web_server + '/api/orbit-view?token=admin-tok'
    assert ':4242' not in ui.played[0][0]
    monkeypatch.setitem(web_ui._orbit_audio, 'on', True)
    ui = FakeUI(web_server, token='admin-tok')
    plugin.Plugin(ui).run(action='live', what='audio')
    assert ui.played and ui.played[0][0] == web_server + '/api/orbit-audio?token=admin-tok'


def test_https_node_sends_media_through_its_plain_port_or_skips_verification():
    """Ryan: "seems that I need the tls for it to work, but the firestick
    doesn't have the cert installed". The API calls tolerate the self-
    signed certificate; the player never sees https when the node
    advertises a plain stream port, and gets Kodi's verifypeer=false
    option when it doesn't."""
    import io, json as _json
    class Resp:
        def __init__(self, body): self._b = _json.dumps(body).encode()
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False
    seen = []
    def opener_with_plain(req, timeout=None):
        seen.append(req.full_url)
        return Resp({'active': False, 'plain_url': 'http://192.168.1.137:8081/api/orbit-view?token=t', 'audio_plain_url': 'http://192.168.1.137:8081/api/orbit-audio?token=t'})
    api = weedapi.WeedApi('https://192.168.1.137:8080', 't', opener=opener_with_plain)
    assert api.is_tls
    assert api.stream_url('job1') == 'http://192.168.1.137:8081/api/stream/job1?token=t'
    assert api.feed_url('view') == 'http://192.168.1.137:8081/api/orbit-view?token=t'
    assert api.feed_url('audio') == 'http://192.168.1.137:8081/api/orbit-audio?token=t'
    assert seen == ['https://192.168.1.137:8080/api/orbit-stream']              # asked once, then cached
    def opener_no_plain(req, timeout=None):
        return Resp({'active': False, 'plain_url': None, 'audio_plain_url': None})
    api = weedapi.WeedApi('https://node:8080', 't', opener=opener_no_plain)
    assert api.stream_url('job1') == 'https://node:8080/api/stream/job1?token=t|verifypeer=false'
    assert api.feed_url('audio') == 'https://node:8080/api/orbit-audio?token=t|verifypeer=false'
    # a plain http node never touches the advertised plain port at all
    def opener_stale(req, timeout=None):
        return Resp({'active': True, 'plain_url': 'http://node:4242/api/orbit-view'})
    api = weedapi.WeedApi('http://node:8080', None, opener=opener_stale)
    assert api.stream_url('job1') == 'http://node:8080/api/stream/job1'
    assert api.feed_url('view') == 'http://node:8080/api/orbit-view'


def test_muxed_live_feed_needs_audio_and_ffmpeg(web_server, monkeypatch):
    """The picture+audio entry: one Matroska URL when the node has ffmpeg
    and audio is on; a plain notice otherwise."""
    _seed()
    monkeypatch.setattr(web_ui, '_orbit_ws_connected', True)
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='live', what='mux')
    assert ui.played == [] and 'no audio' in ui.notices[0]
    monkeypatch.setitem(web_ui._orbit_audio, 'on', True)
    monkeypatch.setattr(web_ui, '_ffmpeg_path', lambda: None)
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='live', what='mux')
    assert ui.played == [] and 'ffmpeg' in ui.notices[0]
    monkeypatch.setattr(web_ui, '_ffmpeg_path', lambda: '/usr/bin/ffmpeg')
    ui = FakeUI(web_server)
    plugin.Plugin(ui).run(action='live', what='mux')
    assert ui.played == [(web_server + '/api/orbit-mux', 'weed Orbit', {'title': 'weed Orbit', 'mediatype': 'video'})]
