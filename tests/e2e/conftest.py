"""
Browser-driven e2e fixtures. Separate from tests/conftest.py's process
(pytest collects both, but keeping e2e-only fixtures here means the fast
unit/integration suite never imports playwright at all).

golden_path_server is the important one: a real web_ui.py server, a real
discovery_relay.py, and a real node.run_host_server all wired together and
actually talking real HTTP/TCP to each other, serving one small real
video file built by testutil.make_fake_archive. Nothing here is mocked --
the same reasons tests/conftest.py's web_server fixture gives for using a
real server apply doubly to an e2e test, whose entire point is catching
things a mock would paper over.
"""
import os
import subprocess
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import node
import web_ui
from testutil import free_port, wait_for_port, make_fake_archive


# Unset by default -- Playwright's own `playwright install chromium`
# downloads a browser into a versioned cache dir (~/.cache/ms-playwright/),
# and p.chromium.launch() finds it automatically with no executable_path
# needed at all. That's the normal path (what CI uses). WEED_TEST_CHROMIUM
# is only for a dev machine that already has a system Chromium and would
# rather point at that than download Playwright's own copy.
CHROMIUM_PATH = os.environ.get('WEED_TEST_CHROMIUM') or None


@pytest.fixture()
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM_PATH,
                               args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        yield b
        b.close()


@pytest.fixture()
def page(browser):
    pg = browser.new_page(viewport={'width': 1200, 'height': 900})
    yield pg
    pg.close()


@pytest.fixture()
def golden_path_server(tmp_path, monkeypatch):
    """A fully real, isolated weed node: relay + web UI + one hosted
    video, all on loopback. See tests/conftest.py's isolated_paths for why
    every path constant below is repointed at tmp_path first -- an e2e
    test spinning up a *second* real host process is exactly the kind of
    thing that would otherwise clobber a developer's real
    ~/.weed_identity.key."""
    monkeypatch.setattr(node, 'IDENTITY_PATH', str(tmp_path / 'identity.key'))
    monkeypatch.setattr(web_ui, 'LIBRARY_PATH', str(tmp_path / 'library.json'))
    monkeypatch.setattr(web_ui, 'HOSTS_PATH', str(tmp_path / 'hosts.json'))
    monkeypatch.setattr(web_ui, 'DOWNLOADS_DIR', str(tmp_path / 'downloads'))
    os.makedirs(web_ui.DOWNLOADS_DIR, exist_ok=True)
    web_ui._library = {'downloads': {}, 'likes': [], 'subscriptions': [], 'playlists': [], 'history': []}
    web_ui._jobs, web_ui._hosts, web_ui._persisted_hosts = {}, {}, {}
    web_ui._job_logs, web_ui._host_logs = {}, {}
    web_ui._lan_url = None
    monkeypatch.setattr(web_ui, 'DEFAULT_RELAY', 'unused-placeholder')  # set for real below

    # A real subprocess, not an in-process thread importing discovery_relay
    # directly -- its event store is a plain module-level list that only
    # ever appends (_load_events never clears it), so two "relay instances"
    # sharing one Python process/module would silently leak one test's
    # events into the next test's relay. A genuinely separate process gives
    # each test a fresh interpreter and therefore fresh module state, same
    # reasoning as tests/conftest.py's own `relay` fixture.
    relay_port = free_port()
    relay_data = str(tmp_path / 'relay_events.jsonl')
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    relay_proc = subprocess.Popen(
        [sys.executable, os.path.join(repo_root, 'discovery_relay.py'), str(relay_port)],
        env=dict(os.environ, WEED_RELAY_DATA=relay_data),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    assert wait_for_port('127.0.0.1', relay_port), 'relay never came up'
    relay_url = f'http://127.0.0.1:{relay_port}'
    monkeypatch.setattr(web_ui, 'DEFAULT_RELAY', relay_url)

    archive_dir = tmp_path / 'archive'
    entry = make_fake_archive(str(archive_dir), name='clip.mp4', size=300_000, chunk_size=65_536)

    host_port = free_port()
    identity = node.load_or_create_identity()
    ok = node.publish(identity, relay_url, entry['sha256'], 'Test Clip', f'127.0.0.1:{host_port}')
    assert ok.get('ok') is True, f'seed publish failed: {ok}'
    host_thread = threading.Thread(
        target=node.run_host_server, args=(str(archive_dir), None, host_port),
        kwargs={'bind_host': '127.0.0.1', 'quiet': True}, daemon=True)
    host_thread.start()
    assert wait_for_port('127.0.0.1', host_port), 'host server never came up'

    web_port = free_port()
    srv = web_ui.WebUIServer(('127.0.0.1', web_port), web_ui.Handler)
    web_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    web_thread.start()
    assert wait_for_port('127.0.0.1', web_port), 'web_ui server never came up'

    yield {
        'web_url': f'http://127.0.0.1:{web_port}',
        'relay_url': relay_url,
        'content_hash': entry['sha256'],
        'title': 'Test Clip',
    }
    srv.shutdown()
    srv.server_close()
    relay_proc.terminate()
    try:
        relay_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        relay_proc.kill()
