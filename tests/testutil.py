"""
Plain (non-fixture) test helpers, deliberately NOT named conftest.py --
pytest auto-imports every conftest.py it finds under a module name derived
from its path, and tests/e2e/conftest.py needing helpers from
tests/conftest.py hits a real name collision that way (both would want the
bare module name "conftest" under this repo's flat, __init__.py-less
layout). A uniquely-named module both conftest.py files can import from
sidesteps that entirely.
"""
import http.client
import hashlib
import json
import os
import socket
import time

from ott import chunk_hashes, merkle_root


def free_port():
    """Ask the OS for a genuinely free port instead of guessing one and
    racing every other test (and anything else on the machine) for it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_port(host, port, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def http_get(url):
    conn_host, conn_port, path = _split_url(url)
    conn = http.client.HTTPConnection(conn_host, conn_port, timeout=5)
    try:
        conn.request('GET', path)
        resp = conn.getresponse()
        return resp.read().decode()
    finally:
        conn.close()


def http_get_json(url):
    return json.loads(http_get(url))


def http_post_json(url, body, headers=None):
    conn_host, conn_port, path = _split_url(url)
    conn = http.client.HTTPConnection(conn_host, conn_port, timeout=5)
    try:
        h = {'Content-Type': 'application/json'}
        h.update(headers or {})
        conn.request('POST', path, body=json.dumps(body), headers=h)
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read().decode())
    finally:
        conn.close()


def _split_url(url):
    # http.client wants (host, port) and a bare path, not a full URL
    assert url.startswith('http://')
    rest = url[len('http://'):]
    hostport, _, path = rest.partition('/')
    host, _, port = hostport.partition(':')
    return host, int(port), '/' + path


def make_fake_archive(archive_dir, name='clip.mp4', size=200_000, chunk_size=65_536, video=True):
    """Hand-writes a minimal but real .ott/manifest.jsonl + chunks file --
    real sha256 chunk hashes and a real merkle root via the same ott
    helpers node.py itself calls, just skipping ott's own add/stage/commit
    workflow (irrelevant to what node.py/web_ui.py actually read: the
    final manifest.jsonl + chunks/<hash>.json shape). video=False produces
    an 'image'-typed entry with no chunks file, for regression-testing the
    mp3/photo-mixed-into-an-archive fix (load_manifest_entries filtering
    to video-only)."""
    os.makedirs(archive_dir, exist_ok=True)
    ott_dir = os.path.join(archive_dir, '.ott')
    os.makedirs(os.path.join(ott_dir, 'chunks'), exist_ok=True)
    file_path = os.path.join(archive_dir, name)
    with open(file_path, 'wb') as f:
        f.write(os.urandom(size))

    if video:
        chunks = chunk_hashes(file_path, chunk_size)
        digest = merkle_root(chunks)
        entry = {
            'sha256': digest, 'name': name, 'orig_path': name, 'last_path': file_path,
            'size': size, 'added': '2026-01-01T00:00:00Z', 'type': 'video',
            'n_chunks': len(chunks), 'chunk_size': chunk_size,
        }
        with open(os.path.join(ott_dir, 'chunks', f'{digest}.json'), 'w') as f:
            json.dump(chunks, f)
    else:
        digest = hashlib.sha256(open(file_path, 'rb').read()).hexdigest()
        entry = {
            'sha256': digest, 'name': name, 'orig_path': name, 'last_path': file_path,
            'size': size, 'added': '2026-01-01T00:00:00Z', 'type': 'image',
            'n_chunks': 1, 'chunk_size': None,
        }

    with open(os.path.join(ott_dir, 'manifest.jsonl'), 'a') as f:
        f.write(json.dumps(entry) + '\n')
    return entry
