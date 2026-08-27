"""
discovery_relay.py + node.discover()/publish()/unpublish() against a real
running relay (subprocess, real sockets) -- no mocking of HTTP or
signatures. Covers the actual trust model: relays store-and-forward
signed events and do nothing else, so "the network" only knows what a
client explicitly told a relay it happened to reach.
"""
import time

import node
from poc_reputation import Identity


def test_publish_then_discover_round_trip(relay):
    identity = Identity('alice')
    result = node.publish(identity, relay, content_hash='c' * 64, title='My Video',
                           host_addr='127.0.0.1:9201')
    assert result.get('ok') is True

    results = node.discover([relay])
    assert len(results) == 1
    assert results[0]['content_hash'] == 'c' * 64
    assert results[0]['title'] == 'My Video'
    assert results[0]['signer_pubkey'] == identity.pubkey_hex()


def test_tampered_event_rejected(relay):
    """The relay verifies signatures itself (node.py's own module
    docstring: 'garbage in doesn't get stored') -- posting a payload that
    doesn't match its signature must be refused, not silently stored."""
    identity = Identity('alice')
    event = identity.sign_event('publish', content_hash='c' * 64, title='Real Title',
                                 host='127.0.0.1:9201', tunnel=None, ott_status=None)
    event['payload']['title'] = 'Tampered Title'  # mutate after signing

    result = node.post_event(relay, event)
    assert result.get('ok') is False

    results = node.discover([relay])
    assert results == []


def test_unpublish_delists(relay):
    identity = Identity('alice')
    node.publish(identity, relay, content_hash='c' * 64, title='My Video', host_addr='127.0.0.1:9201')
    assert len(node.discover([relay])) == 1

    node.unpublish(identity, relay, content_hash='c' * 64)
    assert node.discover([relay]) == []


def test_republish_by_same_signer_replaces_not_duplicates(relay):
    """Re-running `host` always signs a fresh ts -- discover() must key on
    (content_hash, signer_pubkey) and keep only the newest, not grow one
    entry per re-announcement forever."""
    identity = Identity('alice')
    node.publish(identity, relay, content_hash='c' * 64, title='v1', host_addr='127.0.0.1:9201')
    time.sleep(0.01)
    node.publish(identity, relay, content_hash='c' * 64, title='v2', host_addr='127.0.0.1:9202')

    results = node.discover([relay])
    assert len(results) == 1
    assert results[0]['title'] == 'v2'
    assert results[0]['host'] == '127.0.0.1:9202'


def test_two_signers_same_content_both_show_up(relay):
    """Keyed on (content_hash, signer_pubkey), not content_hash alone --
    two independent hosts of the same file are two separate listings."""
    alice, bob = Identity('alice'), Identity('bob')
    node.publish(alice, relay, content_hash='c' * 64, title='v', host_addr='127.0.0.1:9201')
    node.publish(bob, relay, content_hash='c' * 64, title='v', host_addr='127.0.0.1:9202')

    results = node.discover([relay])
    assert {r['signer_pubkey'] for r in results} == {alice.pubkey_hex(), bob.pubkey_hex()}


def test_dead_relay_is_skipped_not_fatal(relay):
    """One relay in the list being unreachable must not lose events that
    genuinely live on a *different*, healthy relay -- discover() degrades,
    it doesn't fail closed."""
    identity = Identity('alice')
    node.publish(identity, relay, content_hash='c' * 64, title='v', host_addr='127.0.0.1:9201')

    dead_relay = 'http://127.0.0.1:1'  # nothing listens here
    results = node.discover([relay, dead_relay])
    assert len(results) == 1
    assert results[0]['content_hash'] == 'c' * 64


def test_content_only_on_a_relay_you_dont_query_is_invisible(relay, tmp_path):
    """The actual answer to 'how long for full network coordination via
    gossip': never, automatically -- relays never talk to each other.
    Publishing to relay A and only ever querying relay B must not surface
    the content, no matter what."""
    import subprocess, sys, os
    from testutil import free_port, wait_for_port

    other_port = free_port()
    env = dict(os.environ, WEED_RELAY_DATA=str(tmp_path / 'other_relay_events.jsonl'))
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen([sys.executable, os.path.join(repo_root, 'discovery_relay.py'), str(other_port)],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        other_relay = f'http://127.0.0.1:{other_port}'
        assert wait_for_port('127.0.0.1', other_port)

        identity = Identity('alice')
        node.publish(identity, other_relay, content_hash='c' * 64, title='v', host_addr='127.0.0.1:9201')

        assert node.discover([relay]) == []  # querying the *other* relay only
        assert len(node.discover([other_relay])) == 1  # but it's really there
    finally:
        proc.terminate()
        proc.wait(timeout=5)
