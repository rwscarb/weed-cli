"""
web_ui.py's REST API against a real, isolated WebUIServer instance (see
conftest.web_server) -- real HTTP requests via the stdlib, same as the
rest of this codebase's own "no new dependency" convention. Every
identity/library/hosts file this touches is redirected into tmp_path by
the isolated_paths fixture web_server depends on; nothing here can ever
read or write a real ~/.weed_* file.
"""
import json
import os
import threading
import time
import urllib.parse

import node
from testutil import free_port, http_get_json, http_post_json, http_post_raw, make_fake_archive


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


def _upload_url(web_server, name, archive_dir):
    qs = urllib.parse.urlencode({'name': name, 'archive_dir': archive_dir})
    return f'{web_server}/api/upload?{qs}'


def test_upload_video_produces_a_real_hostable_archive(web_server, tmp_path):
    """End to end: upload real bytes, then confirm node.py's own
    manifest/chunk readers (the actual code `host` runs) can load the
    result back correctly -- not just that the endpoint returned 200."""
    archive_dir = str(tmp_path / 'archive')
    data = os.urandom(200_000)
    status, resp = http_post_raw(_upload_url(web_server, 'clip.mp4', archive_dir), data)

    assert status == 200
    assert resp['ok'] is True
    assert resp['name'] == 'clip.mp4'
    assert len(resp['content_hash']) == 64
    assert resp['n_chunks'] >= 1

    dest = os.path.join(archive_dir, 'clip.mp4')
    assert os.path.isfile(dest)
    assert os.path.getsize(dest) == len(data)
    assert not os.path.exists(dest + '.uploading')  # tmp file cleaned up

    entries = node.load_manifest_entries(archive_dir)
    assert len(entries) == 1
    assert entries[0]['sha256'] == resp['content_hash']
    leaves = node.load_leaves(archive_dir, resp['content_hash'])
    assert len(leaves) == resp['n_chunks']


def test_upload_appends_correctly_when_existing_manifest_has_no_trailing_newline(web_server, tmp_path):
    """Real incident, not a hypothetical: an existing manifest.jsonl that
    doesn't end in a newline (this archive's did not) used to get a new
    entry appended directly onto the end of the last line via a bare
    open(path, 'a') -- merging two JSON objects into one unparseable
    line. node.load_manifest_entries has no per-line error handling, so
    that one bad line broke reading the *entire* manifest, not just the
    new upload -- every pre-existing file in the archive became
    unloadable ("files could not be found") until the manifest was
    rebuilt from scratch."""
    archive_dir = tmp_path / 'archive'
    ott_dir = archive_dir / '.ott'
    ott_dir.mkdir(parents=True)
    pre_existing = {'sha256': 'b' * 64, 'name': 'old.mp4', 'orig_path': 'old.mp4',
                     'last_path': str(archive_dir / 'old.mp4'), 'size': 1,
                     'added': '2020-01-01T00:00:00Z', 'type': 'video', 'n_chunks': 1, 'chunk_size': 262144}
    # deliberately no trailing newline -- this is the exact condition that broke it
    (ott_dir / 'manifest.jsonl').write_text(json.dumps(pre_existing))

    status, resp = http_post_raw(_upload_url(web_server, 'new.mp4', str(archive_dir)), os.urandom(50_000))
    assert status == 200

    # the real assertion: BOTH entries must still be independently
    # loadable afterward, old and new alike
    entries = node.load_manifest_entries(str(archive_dir))
    names = {e['name'] for e in entries}
    assert names == {'old.mp4', 'new.mp4'}


def test_concurrent_uploads_to_the_same_archive_dont_lose_an_entry(web_server, tmp_path):
    """Dropping several files at once in the browser fires one upload
    request per file, concurrently -- all racing to read-modify-write the
    same manifest.jsonl. Without a lock around that, two requests can
    both read the same "before" state and whichever writes last wins,
    silently dropping the other's entry."""
    archive_dir = str(tmp_path / 'archive')
    threads = [
        threading.Thread(target=http_post_raw,
                          args=(_upload_url(web_server, f'concurrent{i}.mp4', archive_dir), os.urandom(20_000)))
        for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    entries = node.load_manifest_entries(archive_dir)
    assert {e['name'] for e in entries} == {f'concurrent{i}.mp4' for i in range(8)}


def test_upload_rejects_non_video_extension(web_server, tmp_path):
    archive_dir = str(tmp_path / 'archive')
    status, resp = http_post_raw(_upload_url(web_server, 'notes.txt', archive_dir), b'hello')
    assert status == 400
    assert 'not a recognized video or audio extension' in resp['error']
    assert not os.path.exists(archive_dir)  # never even created


def test_upload_audio_produces_a_real_hostable_archive(web_server, tmp_path):
    """Real ask: support audio (mp3, etc.) in addition to video --
    uploading one should archive it exactly like a video does (real
    chunk data, type: 'audio'), not get rejected the way it used to
    before ott/node.py recognized audio as its own hostable type."""
    archive_dir = str(tmp_path / 'archive')
    data = os.urandom(200_000)
    status, resp = http_post_raw(_upload_url(web_server, 'song.mp3', archive_dir), data)

    assert status == 200
    assert resp['ok'] is True
    assert resp['type'] == 'audio'
    assert resp['n_chunks'] >= 1

    entries = node.load_manifest_entries(archive_dir)
    assert len(entries) == 1
    assert entries[0]['type'] == 'audio'
    leaves = node.load_leaves(archive_dir, resp['content_hash'])
    assert len(leaves) == resp['n_chunks']


def test_upload_sanitizes_path_traversal_in_filename(web_server, tmp_path):
    archive_dir = str(tmp_path / 'archive')
    outside_target = tmp_path / 'evil.mp4'
    status, resp = http_post_raw(
        _upload_url(web_server, '../evil.mp4', archive_dir), os.urandom(1000))
    assert status == 200  # basename strips the traversal, so this is just "evil.mp4" inside archive_dir
    assert resp['name'] == 'evil.mp4'
    assert not outside_target.exists()  # never escaped archive_dir
    assert (tmp_path / 'archive' / 'evil.mp4').exists()


def test_upload_requires_name_param(web_server, tmp_path):
    conn_status, resp = http_post_raw(
        f'{web_server}/api/upload?archive_dir=' + urllib.parse.quote(str(tmp_path)), b'data')
    assert conn_status == 400
    assert 'name' in resp['error']


def test_upload_defaults_archive_dir_when_omitted(web_server, tmp_path, monkeypatch):
    """No archive_dir query param at all, and no /share directory present
    (the bare-metal / dev case) -- falls back to './share', resolved
    relative to the server process's cwd, which is also this test process
    (web_server runs in a background thread, not a subprocess) --
    monkeypatch.chdir into tmp_path first so that resolves somewhere
    throwaway instead of this repo's own real ./share (which has real,
    non-test content -- see the repo root). It's extremely unlikely this
    test machine has a real /share directory, but see
    test_default_upload_archive_dir_unit below for the Docker-mount-
    present branch, tested in isolation instead of through a real
    filesystem write to a faked-out /share."""
    monkeypatch.chdir(tmp_path)
    status, resp = http_post_raw(f'{web_server}/api/upload?name=clip.mp4', os.urandom(1000))
    assert status == 200
    assert resp['archive_dir'] == './share'
    assert (tmp_path / 'share' / 'clip.mp4').exists()


def test_default_upload_archive_dir_unit(monkeypatch):
    """web_ui._default_upload_archive_dir() in isolation, covering both
    branches without ever touching a real filesystem path -- see its own
    docstring for the real incident (a file archived into /app/share
    inside the container while the user's /share went on looking empty,
    fixable only by restarting) that this default exists to prevent."""
    import web_ui
    monkeypatch.setattr(os.path, 'isdir', lambda p: p == '/share')
    assert web_ui._default_upload_archive_dir() == '/share'

    monkeypatch.setattr(os.path, 'isdir', lambda p: False)
    assert web_ui._default_upload_archive_dir() == './share'


def _poll_host_status(web_server, host_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hosts = http_get_json(f'{web_server}/api/hosts')['hosts']
        h = next((x for x in hosts if x['id'] == host_id), None)
        if h and h['status'] in ('bound', 'running', 'error'):
            return h
        time.sleep(0.05)
    raise AssertionError(f'host {host_id} never reached a terminal status')


def test_hosting_a_missing_archive_fails_and_can_be_forgotten(web_server, tmp_path):
    """Real report: a persisted host pointing at an archive_dir with no
    manifest (a deleted file, or an old default that's since changed)
    shows a permanent red error in Active hosts, and used to have no way
    to make it go away short of hand-editing ~/.weed_hosts.json."""
    archive_dir = str(tmp_path / 'nothing_here')
    status, resp = http_post_json(f'{web_server}/api/host', {
        'archive_dir': archive_dir, 'file_name': 'ghost.mp4', 'port': 0,
    })
    assert status == 200
    host_id = resp['host_id']

    h = _poll_host_status(web_server, host_id)
    assert h['status'] == 'error'
    assert 'no .ott/manifest.jsonl in' in h['error']

    status, resp = http_post_json(f'{web_server}/api/host/forget', {'host_id': host_id})
    assert status == 200
    assert resp['forgotten_from_autostart'] is True

    hosts = http_get_json(f'{web_server}/api/hosts')['hosts']
    assert host_id not in [x['id'] for x in hosts]

    import web_ui
    assert web_ui._persisted_hosts == {}


def test_forgetting_a_running_host_actually_frees_its_port(web_server, tmp_path):
    """Real report: a single-file host that survived a container restart
    (via _resume_persisted_hosts) permanently squatted on the default
    port, and no other host config -- e.g. one covering the whole
    archive instead of that one stale leftover -- could ever bind it
    again short of restarting the whole process. Forgetting a
    bound/running host now actually closes its socket (see
    node.run_host_server's stop_event) rather than only being allowed
    for already-errored entries."""
    archive_dir = str(tmp_path / 'archive')
    make_fake_archive(archive_dir, name='first.mp4')
    port = free_port()
    status, resp = http_post_json(f'{web_server}/api/host', {
        'archive_dir': archive_dir, 'port': port, 'relay': [],
    })
    assert status == 200
    host_id = resp['host_id']
    h = _poll_host_status(web_server, host_id)
    assert h['status'] in ('bound', 'running'), h

    # confirms the port really is occupied (not just assumed to be): a
    # second host targeting the same one genuinely can't bind while the
    # first is still up
    status, resp = http_post_json(f'{web_server}/api/host', {
        'archive_dir': archive_dir, 'port': port, 'relay': [],
    })
    assert status == 200
    h2 = _poll_host_status(web_server, resp['host_id'])
    assert h2['status'] == 'error'
    assert 'address already in use' in h2['error'].lower()

    status, resp = http_post_json(f'{web_server}/api/host/forget', {'host_id': host_id})
    assert status == 200
    assert resp['stopped'] is True

    hosts = http_get_json(f'{web_server}/api/hosts')['hosts']
    assert host_id not in [x['id'] for x in hosts]

    # the real assertion: the port is genuinely free now, not just
    # removed from the table -- a fresh host targeting it succeeds
    status, resp = http_post_json(f'{web_server}/api/host', {
        'archive_dir': archive_dir, 'port': port, 'relay': [],
    })
    assert status == 200
    h3 = _poll_host_status(web_server, resp['host_id'])
    assert h3['status'] in ('bound', 'running'), h3


def test_resume_persisted_hosts_auto_prunes_permanently_broken_entries(web_server, tmp_path):
    """web_ui._resume_persisted_hosts (run at real startup, not exercised
    by the web_server fixture itself) should drop entries whose file is
    permanently gone so they stop reappearing as the same red error on
    every future startup, while leaving a genuinely still-hostable entry
    alone."""
    import web_ui

    good_dir = str(tmp_path / 'good')
    make_fake_archive(good_dir)
    bad_dir = str(tmp_path / 'gone')

    good_key = f'{good_dir}|None|0'
    bad_key = f'{bad_dir}|ghost.mp4|0'
    web_ui._persisted_hosts = {
        good_key: {'archive_dir': good_dir, 'file_name': None, 'port': 0, 'price': 0,
                   'relay': [], 'advertise_host': '127.0.0.1', 'tunnel': None, 'lightning_node': None},
        bad_key: {'archive_dir': bad_dir, 'file_name': 'ghost.mp4', 'port': 0, 'price': 0,
                  'relay': [], 'advertise_host': '127.0.0.1', 'tunnel': None, 'lightning_node': None},
    }
    web_ui._resume_persisted_hosts()

    assert good_key in web_ui._persisted_hosts
    assert bad_key not in web_ui._persisted_hosts


def test_like_goes_to_every_relay_listed_and_sync_mirrors_the_rest(web_server, relay, relay2):
    import web_ui
    status, resp = http_post_json(f'{web_server}/api/like', {'content_hash': 'c' * 64, 'relay': [relay, relay2]})
    assert status == 200
    assert resp['result']['ok'] is True
    assert set(resp['result']['results']) == {relay, relay2}

    # something this node signed that only ever reached one relay
    node.publish(web_ui._identity(), relay, content_hash='d' * 64, title='v', host_addr='127.0.0.1:9201')
    assert node.discover([relay2]) == []
    status, report = http_post_json(f'{web_server}/api/sync-relays', {'relay': [relay, relay2]})
    assert status == 200
    assert report['relays'][relay2]['added'] == 1
    assert len(node.discover([relay2])) == 1

    status, err = http_post_json(f'{web_server}/api/sync-relays', {'relay': [relay]})
    assert status == 400 and 'two relays' in err['error']


def test_host_accepts_a_comma_separated_tunnel_list(web_server, tmp_path):
    import web_ui
    archive_dir = str(tmp_path / 'archive')
    make_fake_archive(archive_dir)
    status, resp = http_post_json(f'{web_server}/api/host', {
        'archive_dir': archive_dir, 'port': free_port(), 'relay': [],
        'tunnel': '127.0.0.1:1, 127.0.0.1:2',
    })
    assert status == 200
    cfg = next(iter(web_ui._persisted_hosts.values()))
    assert cfg['tunnel'] == ['127.0.0.1:1', '127.0.0.1:2']
    hosts = http_get_json(f'{web_server}/api/hosts')['hosts']
    assert hosts[0]['tunnel'] == ['127.0.0.1:1', '127.0.0.1:2']


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
