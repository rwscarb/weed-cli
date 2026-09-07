"""
The orbit audio relay (web_ui.py _LiveContainerRelay and the two
endpoints around it). The relay is tested as a pure function over
synthetic WebM/Ogg byte strings -- the late-joiner cut is the whole
point of it, and it's exactly the kind of thing a real recording would
only ever exercise by luck. The end-to-end tests push blobs through a
hand-rolled WebSocket client (see test_orbit_ws) into a real WebUIServer
and read them back off /api/orbit-audio with a raw socket, same as the
MJPEG tests do. Stdlib only, like the server.
"""
import os
import queue
import socket
import threading
import time

import pytest

import web_ui
from testutil import http_get_json
from test_orbit_ws import client_frame, ws_connect, _hostport, _read_until

EBML = web_ui._LiveContainerRelay.WEBM_EBML
CLUSTER = web_ui._LiveContainerRelay.WEBM_CLUSTER
OGGS = web_ui._LiveContainerRelay.OGG_PAGE


@pytest.fixture(autouse=True)
def _reset_audio_state():
    """Module globals no other fixture resets -- a listener left behind
    would otherwise still be fed by the next test."""
    web_ui._orbit_audio_relay.end()
    web_ui._orbit_audio.update(on=False, mime=None, since=0.0)
    yield
    web_ui._orbit_audio_relay.end()
    web_ui._orbit_audio.update(on=False, mime=None, since=0.0)


# ── synthetic containers ───────────────────────────────────────────────
def webm_init():
    """EBML header + Segment (unknown size) + Info + Tracks, shaped like
    Chromium's MediaRecorder output, contents irrelevant to the relay."""
    return (EBML + b'\x9f' + os.urandom(31)          # EBML header, 31 bytes of body
            + b'\x18\x53\x80\x67\x01\xff\xff\xff\xff\xff\xff\xff'   # Segment, unknown size
            + b'\x15\x49\xa9\x66\x8a' + os.urandom(10)              # Info
            + b'\x16\x54\xae\x6b\x90' + os.urandom(16))             # Tracks


def webm_cluster(n=40):
    """A live Cluster: ID, unknown-size vint, Timecode element, then a
    SimpleBlock's worth of random 'Opus'."""
    body = b'\xe7\x81\x00' + b'\xa3' + bytes([0x80 | n]) + os.urandom(n)
    return CLUSTER + b'\x01\xff\xff\xff\xff\xff\xff\xff' + body


def ogg_page(n=30):
    return OGGS + b'\x00' + os.urandom(22) + os.urandom(n)


def drain(q):
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except queue.Empty:
            return out


# ── WebM ───────────────────────────────────────────────────────────────
def test_webm_early_subscriber_gets_every_byte_verbatim():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm;codecs=opus')
    q = relay.subscribe()
    blobs = [webm_init() + webm_cluster()[:20], webm_cluster()[20:] + webm_cluster(), webm_cluster()]
    assert sum(relay.feed(b) for b in blobs) == 0
    assert drain(q) == blobs


def test_webm_init_segment_is_everything_before_the_first_cluster():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    init = webm_init()
    assert relay.init_segment is None
    relay.feed(init[:30])                 # the header arrives in pieces
    assert relay.init_segment is None
    relay.feed(init[30:] + webm_cluster())
    assert relay.init_segment == init


def test_webm_late_subscriber_gets_init_then_starts_exactly_at_a_cluster():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm;codecs=opus')
    init = webm_init()
    c1, c2, c3 = webm_cluster(), webm_cluster(), webm_cluster()
    relay.feed(init + c1)
    relay.feed(c2[:25])                   # a blob that ends mid-cluster
    q = relay.subscribe()                 # joins mid-cluster
    # the tail of c2 has no cluster start in it: nothing yet but the init
    relay.feed(c2[25:])
    assert drain(q) == [init]
    # c3 starts 7 bytes into this blob: those 7 are discarded
    blob = c2[-7:] + c3
    relay.feed(blob)
    assert drain(q) == [c3]
    # live from here on
    c4 = webm_cluster()
    relay.feed(c4[:10]); relay.feed(c4[10:])
    assert b''.join(drain(q)) == c4


def test_webm_late_subscriber_start_is_playable_as_a_whole():
    """What a late reader's socket actually carries, end to end, is a
    valid stream: init segment immediately followed by a Cluster ID."""
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    init = webm_init()
    relay.feed(init + webm_cluster() + webm_cluster()[:15])
    q = relay.subscribe()
    relay.feed(webm_cluster()[15:] + webm_cluster())
    got = b''.join(drain(q))
    assert got.startswith(init + CLUSTER)
    assert got[:4] == EBML


def test_webm_cluster_id_inside_opus_data_is_not_a_boundary():
    """A chance 1F43B675 in the compressed audio isn't followed by a
    size vint and a Timecode element, so a late reader waits for the
    real one."""
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    relay.feed(webm_init() + webm_cluster())
    q = relay.subscribe()
    fake = CLUSTER + b'\x85\xa3\xa3\xa3\xa3\xa3'   # a 1-byte vint (5) then not 0xE7
    relay.feed(b'\xa3\x85' + fake + os.urandom(8))
    assert drain(q) == [relay.init_segment]        # still waiting
    real = webm_cluster()
    relay.feed(os.urandom(3) + real)
    assert drain(q) == [real]


# ── Ogg ────────────────────────────────────────────────────────────────
def test_ogg_init_segment_is_the_first_blob_and_late_readers_start_on_a_page():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/ogg;codecs=opus')
    first = ogg_page() + ogg_page()       # the BOS/header pages
    relay.feed(first)
    assert relay.init_segment == first
    p1, p2 = ogg_page(), ogg_page()
    relay.feed(p1[:12])
    q = relay.subscribe()
    relay.feed(p1[12:] + p2)              # p2 starts partway in
    assert drain(q) == [first, p2]
    p3 = ogg_page()
    relay.feed(p3)
    assert drain(q) == [p3]


def test_ogg_early_subscriber_gets_everything():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/ogg')
    q = relay.subscribe()
    blobs = [ogg_page() + ogg_page(), ogg_page()[:9], ogg_page()[9:]]
    for b in blobs:
        relay.feed(b)
    assert drain(q) == blobs


def test_ogg_capture_pattern_needs_the_version_byte():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/ogg')
    relay.feed(ogg_page())
    q = relay.subscribe()
    relay.feed(b'xx' + OGGS + b'\x07' + os.urandom(5))   # 'OggS' then version 7: not a page
    assert drain(q) == [relay.init_segment]
    page = ogg_page()
    relay.feed(b'yy' + page)
    assert drain(q) == [page]


# ── policy ─────────────────────────────────────────────────────────────
def test_full_queue_drops_oldest_and_keeps_the_reader():
    relay = web_ui._LiveContainerRelay(maxsize=3)
    relay.start('audio/webm')
    q = relay.subscribe()                 # early: live from the start
    blobs = [b'b%d' % i for i in range(6)]
    dropped = sum(relay.feed(b) for b in blobs)
    assert dropped == 3
    assert relay.subscriber_count() == 1
    assert drain(q) == blobs[-3:]


def test_end_sends_none_and_a_new_start_forgets_the_old_init():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    relay.feed(webm_init() + webm_cluster())
    q = relay.subscribe()
    relay.end()
    assert drain(q)[-1] is None
    assert relay.subscriber_count() == 0
    relay.start('audio/webm')
    assert relay.init_segment is None
    q2 = relay.subscribe()
    assert relay._subs[q2] == 'live'      # nothing cached yet: early again


def test_unsubscribe_stops_delivery():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    q = relay.subscribe()
    relay.unsubscribe(q)
    relay.feed(b'x')
    assert drain(q) == []


def test_feed_is_safe_under_concurrent_subscribe():
    relay = web_ui._LiveContainerRelay()
    relay.start('audio/webm')
    relay.feed(webm_init() + webm_cluster())
    stop = threading.Event()
    seen = []
    def joiner():
        while not stop.is_set():
            q = relay.subscribe()
            seen.append(q)
            if len(seen) > 50:
                relay.unsubscribe(seen.pop(0))
    t = threading.Thread(target=joiner, daemon=True)
    t.start()
    for _ in range(300):
        relay.feed(webm_cluster())
    stop.set(); t.join(2)
    # every reader that got anything past its init got a cluster start
    for q in seen:
        items = drain(q)
        if len(items) > 1:
            assert items[1][:4] == CLUSTER


# ── end to end against a real server ───────────────────────────────────
class Listener:
    """A raw-socket reader of /api/orbit-audio: the socket plus whatever
    body bytes came in on the same read as the headers (a late joiner's
    init segment is written the instant the headers are)."""
    def __init__(self, sock, leftover):
        self.sock = sock
        self.leftover = leftover

    def close(self):
        self.sock.close()


def audio_connect(url, path='/api/orbit-audio'):
    host, port = _hostport(url)
    s = socket.create_connection((host, port), timeout=5)
    s.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())
    raw = _read_until(s, b'\r\n\r\n')
    head, leftover = raw.split(b'\r\n\r\n', 1)
    return Listener(s, leftover), head


def recv_exact(listener, n, timeout=5):
    listener.sock.settimeout(timeout)
    buf = listener.leftover
    while len(buf) < n:
        chunk = listener.sock.recv(65536)
        assert chunk, 'listener connection closed'
        buf += chunk
    listener.leftover = buf[n:]
    return buf[:n]


def wait_party(url, pred, timeout=3.0):
    deadline = time.time() + timeout
    p = None
    while time.time() < deadline:
        p = http_get_json(f'{url}/api/party')
        if pred(p['stream']):
            return p['stream']
        time.sleep(0.05)
    pytest.fail(f'party never matched; last seen: {p}')


def test_audio_is_404_until_a_sender_opens(web_server):
    s, head = audio_connect(web_server)
    assert head.startswith(b'HTTP/1.1 404')
    s.close()
    st = http_get_json(f'{web_server}/api/party')['stream']
    assert st['audio'] is False and st['audio_url'] == '/api/orbit-audio'
    st = http_get_json(f'{web_server}/api/orbit-stream')
    assert st['audio'] is False and st['audio_url'].endswith('/api/orbit-audio')


def test_sender_blobs_come_out_of_the_audio_endpoint_with_the_senders_mime(web_server):
    ws = ws_connect(web_server, '/api/orbit-audio-ws?mime=audio%2Fwebm%3Bcodecs%3Dopus')
    try:
        st = wait_party(web_server, lambda s: s['audio'])
        assert st['audio_mime'] == 'audio/webm;codecs=opus' and st['audio_since'] > 0
        init, c1 = webm_init(), webm_cluster()
        listener, head = audio_connect(web_server)          # early: gets everything
        assert head.startswith(b'HTTP/1.1 200')
        assert b'Content-Type: audio/webm;codecs=opus' in head
        assert b'Content-Length' not in head
        assert b'Connection: close' in head
        ws.sendall(client_frame(init + c1))
        assert recv_exact(listener, len(init) + len(c1)) == init + c1
        # a late one, joining mid-cluster: init segment, then the next cluster
        c2 = webm_cluster()
        ws.sendall(client_frame(c2[:20]))
        recv_exact(listener, 20)
        late, head = audio_connect(web_server)
        assert head.startswith(b'HTTP/1.1 200')
        c3 = webm_cluster()
        ws.sendall(client_frame(c2[20:] + c3))
        assert recv_exact(late, len(init) + len(c3)) == init + c3
        assert recv_exact(listener, len(c2) - 20 + len(c3)) == c2[20:] + c3
        assert http_get_json(f'{web_server}/api/orbit-stream')['audio_listeners'] == 2
        listener.close(); late.close()
    finally:
        ws.close()
    wait_party(web_server, lambda s: not s['audio'])


def test_sender_going_away_ends_every_listener(web_server):
    ws = ws_connect(web_server, '/api/orbit-audio-ws?mime=audio/ogg')
    wait_party(web_server, lambda s: s['audio'])
    listener, head = audio_connect(web_server)
    assert b'Content-Type: audio/ogg' in head
    ws.close()
    listener.sock.settimeout(5)
    assert listener.leftover == b'' and listener.sock.recv(1024) == b''    # EOF: Connection: close honoured
    listener.close()


def test_unknown_mime_is_refused_before_the_upgrade(web_server):
    host, port = _hostport(web_server)
    s = socket.create_connection((host, port), timeout=5)
    s.sendall((f'GET /api/orbit-audio-ws?mime=video/mp4 HTTP/1.1\r\nHost: {host}:{port}\r\n'
               'Upgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    head = _read_until(s, b'\r\n\r\n')
    assert head.startswith(b'HTTP/1.1 400')
    s.close()
    assert http_get_json(f'{web_server}/api/party')['stream']['audio'] is False


def test_audio_endpoint_takes_the_token_in_the_query(web_server, monkeypatch):
    monkeypatch.setattr(web_ui, 'AUTH_TOKEN', 'admin-tok')
    monkeypatch.setattr(web_ui, 'STREAM_TOKEN', 'guest-tok')
    s, head = audio_connect(web_server)
    assert head.startswith(b'HTTP/1.1 401')
    s.close()
    s, head = audio_connect(web_server, '/api/orbit-audio?token=guest-tok')
    assert head.startswith(b'HTTP/1.1 404')   # past auth; just no audio yet
    s.close()
