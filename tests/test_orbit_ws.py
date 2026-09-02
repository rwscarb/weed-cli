"""
The orbit MJPEG relay (web_ui.py): the WebSocket frame parser and unmask
(pure functions over a byte stream, driven with io.BytesIO), the
drop-oldest fanout policy (against a real queue.Queue), and the whole
path end to end -- a hand-rolled WebSocket client pushes a frame into a
real WebUIServer and a raw-socket viewer reads it back out of
/api/orbit-view as a multipart part. Stdlib only, like the server.
"""
import base64
import hashlib
import io
import os
import queue
import socket
import struct
import time

import pytest

import web_ui
from testutil import http_get_json

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


@pytest.fixture(autouse=True)
def _reset_orbit_state():
    """The relay's state is module globals that no other fixture resets;
    a viewer queue left behind by one test would otherwise still be fed
    (and counted) by the next."""
    web_ui._orbit_subscribers.clear()
    web_ui._orbit_ws_connected = False
    web_ui._orbit_res = None
    web_ui._orbit_rx.update(fps=0.0, kbps=0, dropped=0)
    yield
    web_ui._orbit_subscribers.clear()


# ── frame building (the client side of RFC 6455) ──────────────────────
def client_frame(payload, opcode=2, fin=True, mask_key=None):
    """A masked client->server frame, exactly as a browser sends it."""
    mask_key = mask_key or os.urandom(4)
    b0 = (0x80 if fin else 0) | opcode
    n = len(payload)
    if n < 126:
        hdr = bytes([b0, 0x80 | n])
    elif n < 65536:
        hdr = bytes([b0, 0x80 | 126]) + struct.pack('>H', n)
    else:
        hdr = bytes([b0, 0x80 | 127]) + struct.pack('>Q', n)
    return hdr + mask_key + naive_unmask(payload, mask_key)


def naive_unmask(data, key):
    # the per-byte definition from the RFC, i.e. what the fast path
    # must agree with
    return bytes(data[i] ^ key[i % 4] for i in range(len(data)))


# ── unmask ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize('n', [0, 1, 3, 4, 5, 63, 64, 65, 1000, 120_000])
def test_unmask_matches_the_per_byte_definition(n):
    data, key = os.urandom(n), os.urandom(4)
    assert web_ui._ws_unmask(data, key) == naive_unmask(data, key)


def test_unmask_is_its_own_inverse():
    data, key = os.urandom(777), os.urandom(4)
    assert web_ui._ws_unmask(web_ui._ws_unmask(data, key), key) == data


# ── message parser ─────────────────────────────────────────────────────
def messages(raw):
    return list(web_ui._ws_messages(io.BytesIO(raw)))


def test_single_masked_binary_frame():
    payload = b'\xff\xd8' + os.urandom(100) + b'\xff\xd9'
    assert messages(client_frame(payload)) == [(2, payload)]


@pytest.mark.parametrize('n', [125, 126, 65535, 65536, 200_000])
def test_every_length_encoding(n):
    # 125 / 126 / 65535 / 65536 are the boundaries between the 7-bit,
    # 16-bit and 64-bit length forms; 200KB is a real 720p frame's size
    payload = os.urandom(n)
    assert messages(client_frame(payload)) == [(2, payload)]


def test_fragmented_message_is_reassembled():
    a, b, c = os.urandom(50), os.urandom(60), os.urandom(70)
    raw = (client_frame(a, opcode=2, fin=False)
           + client_frame(b, opcode=0, fin=False)
           + client_frame(c, opcode=0, fin=True))
    assert messages(raw) == [(2, a + b + c)]


def test_ping_passes_through_without_disturbing_a_fragmented_message():
    a, b = os.urandom(10), os.urandom(10)
    raw = (client_frame(a, opcode=2, fin=False)
           + client_frame(b'hi', opcode=9)
           + client_frame(b, opcode=0, fin=True))
    assert messages(raw) == [(9, b'hi'), (2, a + b)]


def test_close_frame_ends_the_stream():
    raw = client_frame(b'one') + client_frame(b'\x03\xe8bye', opcode=8) + client_frame(b'never')
    assert messages(raw) == [(2, b'one')]


def test_truncated_stream_ends_cleanly_without_raising():
    full = client_frame(os.urandom(300))
    for cut in (1, 2, 5, 100, len(full) - 1):
        assert messages(full[:cut]) == []
    assert messages(client_frame(b'ok') + full[:7]) == [(2, b'ok')]


def test_unmasked_frames_are_accepted_too():
    payload = b'abc'
    raw = bytes([0x82, len(payload)]) + payload
    assert messages(raw) == [(2, payload)]


def test_stray_continuation_frame_is_ignored():
    assert messages(client_frame(b'orphan', opcode=0)) == []


# ── fanout policy ──────────────────────────────────────────────────────
def test_fanout_drops_oldest_and_keeps_the_viewer():
    q = queue.Queue(maxsize=2)
    web_ui._orbit_subscribers.add(q)
    frames = [b'f%d' % i for i in range(5)]
    dropped = sum(web_ui._orbit_fanout(f) for f in frames)
    assert q in web_ui._orbit_subscribers            # never evicted
    assert dropped == 3                              # 5 in, room for 2
    assert [q.get_nowait(), q.get_nowait()] == frames[-2:]   # the newest survive


def test_fanout_with_no_viewers_is_a_noop():
    assert web_ui._orbit_fanout(b'x') == 0


# ── end to end against a real server ───────────────────────────────────
def _hostport(url):
    host, _, port = url[len('http://'):].partition(':')
    return host, int(port)


def _read_until(sock, marker):
    buf = b''
    while marker not in buf:
        chunk = sock.recv(4096)
        assert chunk, f'connection closed before {marker!r} arrived'
        buf += chunk
    return buf


def ws_connect(url, path='/api/orbit-ws'):
    host, port = _hostport(url)
    s = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n'
               'Upgrade: websocket\r\nConnection: Upgrade\r\n'
               f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    resp = _read_until(s, b'\r\n\r\n')
    assert resp.startswith(b'HTTP/1.1 101 ')
    expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    assert f'Sec-WebSocket-Accept: {expected}'.encode() in resp
    return s


class Viewer:
    """A raw-socket MJPEG viewer: the socket plus whatever bytes past the
    current part have already been read off it (socket objects can't
    carry that themselves -- no __dict__)."""
    def __init__(self, sock, leftover):
        self.sock = sock
        self.leftover = leftover

    def close(self):
        self.sock.close()


def viewer_connect(url):
    """Returns a Viewer once the response headers are in -- the server
    registers the viewer's queue *before* sending them, so any frame
    pushed after this returns is guaranteed to reach it."""
    host, port = _hostport(url)
    s = socket.create_connection((host, port), timeout=5)
    s.sendall(f'GET /api/orbit-view HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())
    head = _read_until(s, b'\r\n\r\n')
    assert b'HTTP/1.1 200' in head
    assert b'multipart/x-mixed-replace; boundary=orbit' in head
    return Viewer(s, head.split(b'\r\n\r\n', 1)[1])


def read_part(viewer):
    """One multipart part off the viewer; returns its JPEG bytes."""
    buf = viewer.leftover
    while b'\r\n\r\n' not in buf:
        chunk = viewer.sock.recv(65536)
        assert chunk, 'viewer connection closed'
        buf += chunk
    head, body = buf.split(b'\r\n\r\n', 1)
    assert head.startswith(b'--orbit\r\n')
    assert b'Content-Type: image/jpeg' in head
    length = int(head.split(b'Content-Length: ')[1].split(b'\r\n')[0])
    while len(body) < length + 2:
        chunk = viewer.sock.recv(65536)
        assert chunk, 'viewer connection closed mid-frame'
        body += chunk
    jpeg, trailer, rest = body[:length], body[length:length + 2], body[length + 2:]
    assert trailer == b'\r\n'
    viewer.leftover = rest
    return jpeg


def wait_status(url, pred, timeout=3.0):
    deadline = time.time() + timeout
    st = None
    while time.time() < deadline:
        st = http_get_json(f'{url}/api/orbit-stream')
        if pred(st):
            return st
        time.sleep(0.05)
    pytest.fail(f'status never matched; last seen: {st}')


def test_frame_pushed_over_websocket_comes_out_of_the_mjpeg_view(web_server):
    viewer = viewer_connect(web_server)
    ws = ws_connect(web_server)
    try:
        # 100KB forces the 8-byte length form, the one a real frame uses
        frame = b'\xff\xd8' + os.urandom(100_000) + b'\xff\xd9'
        ws.sendall(client_frame(frame))
        assert read_part(viewer) == frame
        # a second part proves the viewer connection stays open between frames
        frame2 = b'\xff\xd8' + os.urandom(500) + b'\xff\xd9'
        ws.sendall(client_frame(frame2))
        assert read_part(viewer) == frame2
    finally:
        ws.close()
        viewer.close()


def test_fragmented_frame_is_reassembled_end_to_end(web_server):
    viewer = viewer_connect(web_server)
    ws = ws_connect(web_server)
    try:
        a, b = os.urandom(3000), os.urandom(3000)
        ws.sendall(client_frame(a, opcode=2, fin=False))
        ws.sendall(client_frame(b, opcode=0, fin=True))
        assert read_part(viewer) == a + b
    finally:
        ws.close()
        viewer.close()


def test_server_answers_ping_with_pong(web_server):
    ws = ws_connect(web_server)
    try:
        ws.sendall(client_frame(b'marco', opcode=9))
        pong = _read_until(ws, b'marco')
        assert pong[:2] == bytes([0x8a, 5])   # FIN|pong, unmasked, length 5
    finally:
        ws.close()


def test_status_tracks_the_streamer_and_its_resolution(web_server):
    st = http_get_json(f'{web_server}/api/orbit-stream')
    assert st['active'] is False and st['viewers'] == 0 and st['res'] is None
    assert st['rx'] == {'fps': 0.0, 'kbps': 0, 'dropped': 0}
    assert st['url'].endswith('/api/orbit-view')

    ws = ws_connect(web_server, '/api/orbit-ws?res=480')
    viewer = viewer_connect(web_server)
    try:
        st = wait_status(web_server, lambda s: s['active'] and s['viewers'] == 1)
        assert st['res'] == '480'
    finally:
        ws.close()
    # the streamer going away ends every viewer too, and zeroes the counters
    st = wait_status(web_server, lambda s: not s['active'] and s['viewers'] == 0)
    assert st['res'] is None
    assert st['rx'] == {'fps': 0.0, 'kbps': 0, 'dropped': 0}
    viewer.close()


def test_one_viewer_leaving_does_not_disturb_another(web_server):
    ws = ws_connect(web_server)
    v1 = viewer_connect(web_server)
    v2 = viewer_connect(web_server)
    try:
        wait_status(web_server, lambda s: s['viewers'] == 2)
        v1.close()
        ws.sendall(client_frame(b'\xff\xd8still here\xff\xd9'))
        assert read_part(v2) == b'\xff\xd8still here\xff\xd9'
    finally:
        ws.close()
        v2.close()
