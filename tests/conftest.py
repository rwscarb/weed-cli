"""
Shared fixtures for the unit/integration suite (tests/, not tests/e2e/).

The single most important job of every fixture here is isolation: node.py
and web_ui.py both read/write real files under the developer's home
directory by default (~/.weed_identity.key, ~/.weed_library.json,
~/.weed_hosts.json) — exactly what makes them work with zero setup for a
person running `weed` or `make node`, but exactly what a test suite must
never touch. Every fixture below repoints those module-level path
constants at pytest's own tmp_path before anything can read/write them.

Plain (non-fixture) helpers live in testutil.py, not here -- see its own
docstring for why that split avoids a real conftest.py naming collision
with tests/e2e/conftest.py.
"""
import os
import subprocess
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import node
import web_ui

from testutil import free_port, wait_for_port


@pytest.fixture()
def isolated_paths(tmp_path, monkeypatch):
    """Repoints every real-home-directory path node.py/web_ui.py touch at
    tmp_path, and resets web_ui's in-memory globals -- both halves matter:
    without the module-global reset, a *second* test in the same pytest
    process would still see the first test's _library/_jobs/_hosts sitting
    in memory even though LIBRARY_PATH now points somewhere fresh."""
    monkeypatch.setattr(node, 'IDENTITY_PATH', str(tmp_path / 'identity.key'))
    monkeypatch.setattr(web_ui, 'LIBRARY_PATH', str(tmp_path / 'library.json'))
    monkeypatch.setattr(web_ui, 'HOSTS_PATH', str(tmp_path / 'hosts.json'))
    monkeypatch.setattr(web_ui, 'DOWNLOADS_DIR', str(tmp_path / 'downloads'))
    os.makedirs(web_ui.DOWNLOADS_DIR, exist_ok=True)
    web_ui._library = {'downloads': {}, 'likes': [], 'subscriptions': [], 'playlists': [], 'history': []}
    web_ui._jobs = {}
    web_ui._hosts = {}
    web_ui._persisted_hosts = {}
    web_ui._job_logs = {}
    web_ui._host_logs = {}
    web_ui._lan_url = None
    return tmp_path


@pytest.fixture()
def web_server(isolated_paths):
    """A real web_ui.WebUIServer on a free localhost port, in a daemon
    thread. Deliberately does NOT call web_ui.run_web_ui() -- that
    registers a SIGTERM handler, which Python only allows from the main
    thread, and auto-resumes any persisted hosts, neither of which a test
    fixture wants. This replicates just the request-serving half."""
    web_ui._load_library()
    port = free_port()
    srv = web_ui.WebUIServer(('127.0.0.1', port), web_ui.Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    assert wait_for_port('127.0.0.1', port), 'web_ui server never came up'
    yield f'http://127.0.0.1:{port}'
    srv.shutdown()
    srv.server_close()


def _spawn_relay(tmp_path, name):
    """A real discovery_relay.py, run as a genuinely separate process (not
    imported in-process) -- its event store is plain module globals, so
    two relays sharing one interpreter would silently share state, which
    is exactly wrong for a test that wants two *independent* relays (see
    test_discovery_relay.py's failover and sync tests). Same subprocess
    pattern poc_discovery.py's own demo already uses for the same reason."""
    port = free_port()
    data_path = str(tmp_path / f'{name}_events.jsonl')
    env = dict(os.environ, WEED_RELAY_DATA=data_path)
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        [sys.executable, os.path.join(repo_root, 'discovery_relay.py'), str(port)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        assert wait_for_port('127.0.0.1', port), 'discovery_relay never came up'
        yield f'http://127.0.0.1:{port}'
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture()
def relay(tmp_path):
    yield from _spawn_relay(tmp_path, 'relay')


@pytest.fixture()
def relay2(tmp_path):
    """A second, fully independent relay -- for everything about posting
    to several relays and mirroring between them."""
    yield from _spawn_relay(tmp_path, 'relay2')
