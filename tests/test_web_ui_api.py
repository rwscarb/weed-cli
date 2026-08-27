"""
web_ui.py's REST API against a real, isolated WebUIServer instance (see
conftest.web_server) -- real HTTP requests via the stdlib, same as the
rest of this codebase's own "no new dependency" convention. Every
identity/library/hosts file this touches is redirected into tmp_path by
the isolated_paths fixture web_server depends on; nothing here can ever
read or write a real ~/.weed_* file.
"""
from testutil import http_get_json, http_post_json


def test_whoami_and_empty_library(web_server):
    who = http_get_json(f'{web_server}/api/whoami')
    assert len(who['pubkey']) == 64  # 32-byte Ed25519 pubkey, hex-encoded

    lib = http_get_json(f'{web_server}/api/library')
    assert lib == {'downloads': [], 'likes': [], 'subscriptions': [], 'playlists': [], 'history': []}


def test_like_is_idempotent(web_server):
    status, resp = http_post_json(f'{web_server}/api/like', {'content_hash': 'c' * 64})
    assert status == 200
    for _ in range(3):
        http_post_json(f'{web_server}/api/like', {'content_hash': 'c' * 64})
    lib = http_get_json(f'{web_server}/api/library')
    assert lib['likes'] == ['c' * 64]


def test_like_requires_content_hash(web_server):
    status, resp = http_post_json(f'{web_server}/api/like', {})
    assert status == 400
    assert 'content_hash' in resp['error']


def test_playlist_create_add_reorder_remove_delete(web_server):
    status, resp = http_post_json(f'{web_server}/api/playlists/create', {'name': 'My List'})
    assert status == 200
    playlist_id = resp['playlist']['id']

    for h in ('a' * 64, 'b' * 64):
        status, resp = http_post_json(f'{web_server}/api/playlists/add', {
            'playlist_id': playlist_id, 'content_hash': h, 'title': h[:8],
        })
        assert status == 200

    lib = http_get_json(f'{web_server}/api/library')
    pl = next(p for p in lib['playlists'] if p['id'] == playlist_id)
    assert [it['content_hash'] for it in pl['items']] == ['a' * 64, 'b' * 64]

    status, _ = http_post_json(f'{web_server}/api/playlists/reorder', {
        'playlist_id': playlist_id, 'order': ['b' * 64, 'a' * 64],
    })
    assert status == 200
    lib = http_get_json(f'{web_server}/api/library')
    pl = next(p for p in lib['playlists'] if p['id'] == playlist_id)
    assert [it['content_hash'] for it in pl['items']] == ['b' * 64, 'a' * 64]

    status, _ = http_post_json(f'{web_server}/api/playlists/remove', {
        'playlist_id': playlist_id, 'content_hash': 'a' * 64,
    })
    assert status == 200
    lib = http_get_json(f'{web_server}/api/library')
    pl = next(p for p in lib['playlists'] if p['id'] == playlist_id)
    assert [it['content_hash'] for it in pl['items']] == ['b' * 64]

    status, _ = http_post_json(f'{web_server}/api/playlists/delete', {'playlist_id': playlist_id})
    assert status == 200
    lib = http_get_json(f'{web_server}/api/library')
    assert lib['playlists'] == []


def test_play_requires_content_hash(web_server):
    status, resp = http_post_json(f'{web_server}/api/play', {})
    assert status == 400


def test_play_bumps_count_and_history_for_a_known_download(web_server):
    import web_ui
    web_ui._library['downloads']['c' * 64] = {
        'content_hash': 'c' * 64, 'job_id': 'job1', 'path': '/tmp/x.mp4',
        'title': 'X', 'downloaded_at': 0, 'size': 1, 'bps': 1, 'signer_pubkey': None,
    }

    status, resp = http_post_json(f'{web_server}/api/play', {'content_hash': 'c' * 64, 'title': 'X'})
    assert status == 200
    assert resp['play_count'] == 1
    assert resp['last_played'] is not None

    status, resp = http_post_json(f'{web_server}/api/play', {'content_hash': 'c' * 64, 'title': 'X'})
    assert resp['play_count'] == 2

    lib = http_get_json(f'{web_server}/api/library')
    rec = next(d for d in lib['downloads'] if d['content_hash'] == 'c' * 64)
    assert rec['play_count'] == 2
    assert len(lib['history']) == 2
    assert lib['history'][0]['content_hash'] == 'c' * 64  # newest first


def test_play_for_unknown_content_hash_still_logs_history_but_no_count(web_server):
    """A play_count only exists on a downloads record -- playing something
    that isn't (yet, or ever) in _library['downloads'] shouldn't 500, it
    just can't report a play_count."""
    status, resp = http_post_json(f'{web_server}/api/play', {'content_hash': 'z' * 64, 'title': 'Ghost'})
    assert status == 200
    assert resp['play_count'] is None

    lib = http_get_json(f'{web_server}/api/library')
    assert len(lib['history']) == 1
    assert lib['history'][0]['title'] == 'Ghost'


def test_cross_origin_post_rejected(web_server):
    """No auth at all by design (see web_ui.py's module docstring) --
    Origin-checking is the only thing standing between this and any other
    open tab silently POSTing here. A request claiming a different Origin
    must be refused."""
    status, resp = http_post_json(f'{web_server}/api/like', {'content_hash': 'c' * 64},
                                   headers={'Origin': 'http://evil.example'})
    assert status == 403


def test_request_with_no_origin_header_is_allowed(web_server):
    """curl / server-to-server / direct API use never sets Origin -- only
    a real cross-site browser request does, so a missing header is let
    through (see web_ui.py's _check_origin docstring)."""
    status, resp = http_post_json(f'{web_server}/api/like', {'content_hash': 'd' * 64})
    assert status == 200
