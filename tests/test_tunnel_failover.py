"""
Tunnel relay failover: a host registered with more than one tunnel_relay.py
stays reachable when one of them is down or has never heard of it, and a
downloader tries them in the order the host published. Real relays (in-
process threads, real sockets), a real host control loop, real bytes.
"""
import os
import subprocess
import sys
import threading
import time

import pytest

import node
from testutil import free_port, wait_for_port, make_fake_archive

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture()
def tunnel_relays():
    """Factory for real tunnel_relay.py processes -- one *process* each,
    never in-process threads: the relay's registration table is a
    module-level global, so two relays sharing one interpreter would
    silently share every registration, which is precisely the opposite
    of the independent relays these tests are about."""
    procs = []

    def start():
        port = free_port()
        proc = subprocess.Popen([sys.executable, os.path.join(REPO_ROOT, 'tunnel_relay.py'), str(port)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(proc)
        assert wait_for_port('127.0.0.1', port), 'tunnel relay never came up'
        return port

    yield start
    for proc in procs:
        proc.terminate()
    for proc in procs:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture()
def hosted_file(tmp_path):
    """One real archived file, served through a host control loop on
    *every* relay in `ports` (registered under its content hash, same as
    `host --tunnel A --tunnel B`)."""
    archive_dir = str(tmp_path / 'archive')
    entry = make_fake_archive(archive_dir, size=100_000, chunk_size=32_768)
    leaves = node.load_leaves(archive_dir, entry['sha256'])
    file_path = node.resolve_file_path(entry, archive_dir)

    def register_on(*ports):
        for port in ports:
            threading.Thread(target=node.run_host_tunnel,
                             args=('127.0.0.1', port, entry['sha256'], entry, leaves, file_path, 0),
                             kwargs={'quiet': True}, daemon=True).start()
        # REGISTER is asynchronous from this thread's point of view -- a
        # CONNECT that races ahead of it gets an honest 'ERR no such
        # host' from the relay. Wait until each relay really has it.
        for port in ports:
            deadline = time.time() + 5
            while True:
                try:
                    node.open_connection('unused:0', tunnel=('127.0.0.1', port, False),
                                         content_hash=entry['sha256']).close()
                    break
                except OSError:
                    assert time.time() < deadline, f'host never registered on relay {port}'
                    time.sleep(0.05)

    return {'entry': entry, 'file_path': file_path, 'register_on': register_on}


def test_split_and_parse_tunnel_specs():
    assert node._split_tunnel_spec(None) == []
    assert node._split_tunnel_spec('') == []
    assert node._split_tunnel_spec('a:1') == ['a:1']
    assert node._split_tunnel_spec('a:1, tls://b:2,,a:1') == ['a:1', 'tls://b:2']
    assert node._split_tunnel_spec(['a:1', 'b:2,c:3']) == ['a:1', 'b:2', 'c:3']
    assert node._parse_tunnels('a:1, tls://b:2') == [('a', 1, False), ('b', 2, True)]
    assert node.candidate_tunnels({'host': 'x:1'}) == []
    assert node.candidate_tunnels({'tunnel': 'a:1'}) == [('a', 1, False)]
    assert node.candidate_tunnels({'tunnel': 'a:1', 'tunnels': ['a:1', 'b:2']}) == [('a', 1, False), ('b', 2, False)]
    with pytest.raises(ValueError):
        node._parse_tunnels('no-port-here')


def test_downloader_fails_over_past_a_dead_relay(hosted_file, tunnel_relays):
    live = tunnel_relays()
    hosted_file['register_on'](live)
    dead = ('127.0.0.1', free_port(), False)   # nothing listens here
    sha = hosted_file['entry']['sha256']

    with node.open_connection('unused:0', tunnel=[dead, ('127.0.0.1', live, False)], content_hash=sha) as conn:
        assert conn.via == f'tunnel 127.0.0.1:{live}'
        import json
        assert json.loads(conn.request('INFO'))['sha256'] == sha


def test_downloader_fails_over_past_a_relay_that_never_heard_of_the_host(hosted_file, tunnel_relays):
    """The harder case: a relay that's up but has no registration for
    this content -- it accepts the CONNECT and only then says 'ERR no such
    host'. The probe in open_connection is what turns that into a
    failover instead of a broken session."""
    stranger = tunnel_relays()   # up, but this host never registers here
    live = tunnel_relays()
    hosted_file['register_on'](live)
    sha = hosted_file['entry']['sha256']

    with node.open_connection('unused:0', tunnel=[('127.0.0.1', stranger, False), ('127.0.0.1', live, False)],
                              content_hash=sha) as conn:
        assert conn.via == f'tunnel 127.0.0.1:{live}'


def test_every_relay_down_raises_instead_of_hanging(hosted_file):
    dead1, dead2 = ('127.0.0.1', free_port(), False), ('127.0.0.1', free_port(), False)
    with pytest.raises(OSError):
        node.open_connection('unused:0', tunnel=[dead1, dead2], content_hash=hosted_file['entry']['sha256'])


def test_host_registered_on_two_relays_serves_through_whichever_is_reached(hosted_file, tmp_path, tunnel_relays):
    a, b = tunnel_relays(), tunnel_relays()
    hosted_file['register_on'](a, b)
    sha = hosted_file['entry']['sha256']

    # full download through the *second* relay, with the first listed as
    # a dead address -- exactly what a discovered event with
    # tunnels=[down, up] resolves to
    dead = ('127.0.0.1', free_port(), False)
    out = str(tmp_path / 'out.bin')
    path = node.download('unused:0', out, tunnel=[dead, ('127.0.0.1', b, False)], content_hash=sha)
    assert path == out
    assert open(out, 'rb').read() == open(hosted_file['file_path'], 'rb').read()

    # and through the first, directly, to prove both registrations are live
    with node.open_connection('unused:0', tunnel=('127.0.0.1', a, False), content_hash=sha) as conn:
        assert conn.via == f'tunnel 127.0.0.1:{a}'
