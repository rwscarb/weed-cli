"""
The nonce-salted timing challenge on the real download path
(node.nonce_challenge / select_host's timing gate): a real host serving
a real archive, a host that fabricates hashes, and a relay that has none
of the bytes but fetches each chunk from the real host on demand. Real
sockets throughout; the relay's extra hop is a real upstream round trip
plus a little added distance, so the separation is a measurement, not a
mock.
"""
import hashlib
import json
import socket
import socketserver
import threading
import time

import node
from testutil import free_port, make_fake_archive, wait_for_port


def _real_host(archive_dir, port):
    threading.Thread(target=node.run_host_server, args=(archive_dir, None, port),
                     kwargs={'bind_host': '127.0.0.1', 'quiet': True}, daemon=True).start()
    assert wait_for_port('127.0.0.1', port), 'host server never came up'


class _FakeHost(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """Speaks the host protocol by forwarding to an upstream real host,
    except for CHALLENGE, which `answer_challenge` decides."""
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, upstream_port, answer_challenge):
        self.upstream_port = upstream_port
        self.answer_challenge = answer_challenge
        super().__init__(('127.0.0.1', 0), _FakeHandler)


class _FakeHandler(socketserver.BaseRequestHandler):
    def handle(self):
        srv = self.server
        with node.HostConnection.connect_direct('127.0.0.1', srv.upstream_port) as up:
            while True:
                line = node.recv_line(self.request)
                if not line:
                    return
                parts = line.split()
                if parts[0] == 'CHALLENGE':
                    reply = srv.answer_challenge(up, int(parts[1]), parts[2])
                else:
                    reply = up.request(line)
                self.request.sendall((reply + '\n').encode())


def _start_fake(upstream_port, answer_challenge):
    srv = _FakeHost(upstream_port, answer_challenge)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def _relay_answer(extra_delay_s):
    """A relay with none of the bytes: it must FETCH the chunk upstream
    before it can hash it with the nonce. extra_delay_s stands in for
    the network distance to that upstream -- on a single machine both
    hops are loopback, which is exactly the case the README says a
    single sample can't separate."""
    def answer(up, idx, nonce_hex):
        time.sleep(extra_delay_s)
        resp = up.request(f'FETCH {idx}')
        import base64
        data = base64.b64decode(resp[5:])
        return 'HASH ' + hashlib.sha256(data + bytes.fromhex(nonce_hex)).hexdigest()
    return answer


def _liar_answer(up, idx, nonce_hex):
    return 'HASH ' + '0' * 64


def _setup(tmp_path):
    archive_dir = str(tmp_path / 'archive')
    # 12 chunks: enough that 2 sampled + 5 timed still leaves the timed
    # rounds a full pool to draw from (nonce_challenge stays off the
    # sampled ones -- see its `avoid`)
    entry = make_fake_archive(archive_dir, size=64 * 1024 * 12, chunk_size=64 * 1024)
    port = free_port()
    _real_host(archive_dir, port)
    leaves = node.load_leaves(archive_dir, entry['sha256'])
    return entry, port, leaves


def test_honest_host_passes_and_reports_a_ratio(tmp_path):
    entry, port, leaves = _setup(tmp_path)
    with node.HostConnection.connect_direct('127.0.0.1', port) as conn:
        r = node.nonce_challenge(conn, leaves, rounds=5)
    assert r['supported'] and r['passed']
    assert r['rounds'] == 5 and len(r['challenge_ms']) == 5 and len(r['baseline_ms']) == 5
    assert r['ratio'] > 0 and r['median_challenge_ms'] > 0


def test_avoid_keeps_the_timed_chunks_off_the_ones_already_fetched(tmp_path):
    entry, port, leaves = _setup(tmp_path)
    seen = []
    with node.HostConnection.connect_direct('127.0.0.1', port) as conn:
        orig = conn.request

        def spy(line):
            if line.startswith('CHALLENGE '):
                seen.append(int(line.split()[1]))
            return orig(line)
        conn.request = spy
        r = node.nonce_challenge(conn, leaves, rounds=3, avoid=[0, 1, 2])
    assert r['passed']
    assert set(seen).isdisjoint({0, 1, 2})


def test_fabricated_hash_fails_no_matter_how_fast(tmp_path):
    entry, port, leaves = _setup(tmp_path)
    liar_port = _start_fake(port, _liar_answer)
    with node.HostConnection.connect_direct('127.0.0.1', liar_port) as conn:
        r = node.nonce_challenge(conn, leaves, rounds=3)
    assert r['supported'] and not r['passed']


def test_relay_hashes_correctly_but_its_timing_ratio_gives_it_away(tmp_path):
    entry, port, leaves = _setup(tmp_path)
    relay_port = _start_fake(port, _relay_answer(0.02))
    with node.HostConnection.connect_direct('127.0.0.1', port) as conn:
        honest = node.nonce_challenge(conn, leaves, rounds=5)
    with node.HostConnection.connect_direct('127.0.0.1', relay_port) as conn:
        relay = node.nonce_challenge(conn, leaves, rounds=5)
    assert relay['passed'], 'the relay forwards real bytes, so its hashes are right'
    # 20ms of upstream distance against a sub-millisecond baseline: the
    # relay's median CHALLENGE carries the whole delay, its ratio is
    # well clear of the holder's -- which itself can spike on a busy
    # loopback, hence a multiple rather than a fixed number
    assert relay['median_challenge_ms'] > 15
    assert relay['ratio'] > 3 * honest['ratio']


def test_select_host_prefers_the_holder_and_can_reject_the_relay_outright(tmp_path):
    entry, port, leaves = _setup(tmp_path)
    relay_port = _start_fake(port, _relay_answer(0.02))
    sha = entry['sha256']
    candidates = [
        {'host': f'127.0.0.1:{relay_port}', 'content_hash': sha, 'signer_pubkey': 'r' * 64},
        {'host': f'127.0.0.1:{port}', 'content_hash': sha, 'signer_pubkey': 'h' * 64},
    ]
    # equal reputation, equal price: timing breaks the tie toward the holder
    winner = node.select_host(candidates, k=2, timing_rounds=5)
    assert winner['candidate']['host'] == f'127.0.0.1:{port}'
    assert winner['timing_ratio'] is not None and winner['timing_rounds'] == 5

    # with a limit, the relay isn't just ranked lower -- it's out
    only_relay = [candidates[0]]
    assert node.select_host(only_relay, k=2, timing_rounds=5, max_timing_ratio=8.0) is None
    assert node.select_host(only_relay, k=2, timing_rounds=5) is not None   # unlimited: still allowed

    # timing off entirely: back to the plain FETCH-and-verify gate
    off = node.select_host(only_relay, k=2, timing_rounds=0)
    assert off is not None and off['timing_ratio'] is None


def test_attestation_carries_the_timing_fields(tmp_path):
    """download_with_auction signs timing_ratio/timing_rounds into its
    attestation -- additive fields, so poc_reputation's own verify/score
    path (which only reads passes/fails) is unaffected."""
    from poc_reputation import Identity, verify_attestation, ReputationStore
    identity = Identity('alice')
    att = identity.sign_event('attestation', peer_pubkey='h' * 64, passes=1, fails=0,
                              avg_latency_ms=0.5, k=3, timing_ratio=2.13, timing_rounds=5)
    ok, _ = verify_attestation(att)
    assert ok
    store = ReputationStore(str(tmp_path / 'rep.json'))
    assert store.add_attestation(att)[0] is True
