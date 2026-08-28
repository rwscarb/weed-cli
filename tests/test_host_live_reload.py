"""
Real report: dragging a new file into an archive_dir that already has a
host running against it (the common case once a node's been up for a
while -- see web_ui.py's persisted-hosts auto-resume) never made that
file downloadable without restarting the whole process, since
run_host_server used to build entries_by_hash once, at startup, and never
looked at the manifest again. This exercises the fix directly against a
real node.run_host_server thread and a real socket download -- no web_ui,
no relay, no discovery -- proving the actual serving path picks up a file
added after the host was already accepting connections.
"""
import threading
import time

import node
from testutil import free_port, make_fake_archive, wait_for_port


def _host_thread(archive_dir, port):
    t = threading.Thread(
        target=node.run_host_server, args=(archive_dir, None, port),
        kwargs={'bind_host': '127.0.0.1', 'quiet': True}, daemon=True)
    t.start()
    assert wait_for_port('127.0.0.1', port), 'host server never came up'
    return t


def test_a_file_added_after_the_host_started_is_downloadable_without_restart(tmp_path):
    archive_dir = str(tmp_path / 'archive')
    first = make_fake_archive(archive_dir, name='first.mp4', size=40_000, chunk_size=8_192)
    port = free_port()
    _host_thread(archive_dir, port)

    # baseline: the file that existed when the host started works, same
    # as always
    out1 = str(tmp_path / 'out1.mp4')
    node.download(f'127.0.0.1:{port}', out1, content_hash=first['sha256'])
    import os
    assert os.path.getsize(out1) == 40_000

    # this is the real incident: add a *second* file to the same
    # archive_dir the host above is already serving, with no restart in
    # between
    second = make_fake_archive(archive_dir, name='second.mp4', size=25_000, chunk_size=8_192)

    out2 = str(tmp_path / 'out2.mp4')
    node.download(f'127.0.0.1:{port}', out2, content_hash=second['sha256'])
    assert os.path.getsize(out2) == 25_000


def test_a_broken_manifest_mid_session_does_not_take_down_an_already_running_host(tmp_path):
    """The reload is best-effort -- a manifest caught mid-write (or
    otherwise briefly invalid) must not crash the accept loop and take an
    otherwise-healthy host offline over what could just be a transient
    write in progress."""
    archive_dir = str(tmp_path / 'archive')
    first = make_fake_archive(archive_dir, name='first.mp4', size=10_000, chunk_size=4_096)
    port = free_port()
    _host_thread(archive_dir, port)

    manifest_path = tmp_path / 'archive' / '.ott' / 'manifest.jsonl'
    good_manifest = manifest_path.read_text()
    manifest_path.write_text('{not valid json\n')
    # give the corrupt write a moment to actually be what a subsequent
    # accept() would see (mtime resolution / filesystem timing)
    time.sleep(0.05)

    # a fresh connection during the broken window should still serve the
    # file that was already known good before the corruption
    out = str(tmp_path / 'out.mp4')
    node.download(f'127.0.0.1:{port}', out, content_hash=first['sha256'])
    import os
    assert os.path.getsize(out) == 10_000

    # restoring it lets a *new* file added afterward show up normally,
    # proving this was a transient hiccup, not a permanently wedged host
    manifest_path.write_text(good_manifest)
    second = make_fake_archive(archive_dir, name='second.mp4', size=6_000, chunk_size=4_096)
    out2 = str(tmp_path / 'out2.mp4')
    node.download(f'127.0.0.1:{port}', out2, content_hash=second['sha256'])
    assert os.path.getsize(out2) == 6_000
