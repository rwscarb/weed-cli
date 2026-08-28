"""
dht.py's real Kademlia swarm -- multiple real dht.DHTNode instances (each
its own thread + its own asyncio event loop, see DHTNode's own docstring)
in one process. Unlike discovery_relay.py, kademlia.network.Server carries
no module-level global state shared across instances, so running several
in-process (rather than as separate subprocesses, the way
tests/conftest.py's `relay` fixture has to for discovery_relay.py) is
correct here, not a test-isolation shortcut -- kademlia's own test suite
does the same thing for the same reason.
"""
import pytest

import dht
from testutil import free_port


def make_node(bootstrap_port=None):
    port = free_port()
    bootstrap = [('127.0.0.1', bootstrap_port)] if bootstrap_port else None
    node = dht.DHTNode(port, bootstrap_nodes=bootstrap, quiet=True)
    node.start()
    return node, port


@pytest.fixture()
def swarm():
    """Yields a list callers append (node, port) pairs to; stops every
    node on teardown regardless of how many the test actually created."""
    nodes = []
    yield nodes
    for node, _ in nodes:
        node.stop()


def test_solo_node_with_no_neighbors_cannot_store_or_retrieve_anything(swarm):
    """Not a trivial "empty DHT" check -- a real, easy-to-miss operational
    gotcha discovered while writing these tests: kademlia's get/set work
    by routing to the nearest *known* nodes, and a node with zero known
    neighbors (the very first node in a swarm, before anyone else has
    bootstrapped to or from it) has nowhere to route to. It doesn't raise
    -- it logs a warning and silently no-ops, so announce()/lookup() both
    just look like "nothing here" instead of "not connected to anything
    yet." A genuinely-empty lookup in a *working* multi-node swarm is
    covered separately below (test_lookup_for_unknown_hash_on_a_real_swarm)."""
    a, _ = make_node()
    swarm.append((a, _))
    a.announce('c' * 64, '127.0.0.1:9201')
    assert a.lookup('c' * 64) == []


def test_two_nodes_announce_and_lookup(swarm):
    """The actual round trip: B joins A's swarm, B announces, A looks it
    up -- A and B never talk except for B's one bootstrap connection, so
    finding it on A proves the DHT's own get/set is doing the work, not
    some direct A<->B shortcut."""
    a, a_port = make_node()
    swarm.append((a, a_port))
    b, b_port = make_node(bootstrap_port=a_port)
    swarm.append((b, b_port))

    b.announce('c' * 64, '127.0.0.1:9201', title='My Video')

    results = a.lookup('c' * 64)
    assert results == [{'host': '127.0.0.1:9201', 'title': 'My Video'}]


def test_lookup_for_unknown_hash_on_a_real_swarm_is_empty(swarm):
    a, a_port = make_node()
    swarm.append((a, a_port))
    b, b_port = make_node(bootstrap_port=a_port)
    swarm.append((b, b_port))

    b.announce('c' * 64, '127.0.0.1:9201')
    assert a.lookup('d' * 64) == []


def test_two_hosts_for_same_content_hash_merge_not_overwrite(swarm):
    """_announce's own contract (see its docstring): a second host
    announcing the same content_hash must show up *alongside* the first,
    not replace it -- multiple peers hosting the same file is real,
    useful redundancy, not a conflict to resolve."""
    a, a_port = make_node()
    swarm.append((a, a_port))
    b, b_port = make_node(bootstrap_port=a_port)
    swarm.append((b, b_port))

    a.announce('c' * 64, '127.0.0.1:9201', title='v')
    b.announce('c' * 64, '127.0.0.1:9202', title='v')

    hosts = {e['host'] for e in a.lookup('c' * 64)}
    assert hosts == {'127.0.0.1:9201', '127.0.0.1:9202'}


def test_reannouncing_same_host_replaces_its_own_entry_not_duplicates(swarm):
    """A completely solo node (zero known neighbors -- nobody's ever
    bootstrapped to or from it) can't even get/set against itself:
    kademlia's own set/get work by routing to the nearest known nodes, and
    with none known there's nowhere to route to (it logs a warning and
    silently no-ops, discovered the hard way -- an earlier version of
    this test tried exactly that and got [] back instead of real data).
    Two nodes is the minimum for get/set to actually do anything."""
    a, a_port = make_node()
    swarm.append((a, a_port))
    b, b_port = make_node(bootstrap_port=a_port)
    swarm.append((b, b_port))

    a.announce('c' * 64, '127.0.0.1:9201', title='v1')
    a.announce('c' * 64, '127.0.0.1:9201', title='v2')

    results = b.lookup('c' * 64)
    assert results == [{'host': '127.0.0.1:9201', 'title': 'v2'}]


def test_three_node_chain_propagates_through_indirect_bootstrap(swarm):
    """C bootstraps through B, never touches A directly -- if C can still
    look up something A announced, that's Kademlia's own routing doing
    real work, not just a two-node special case."""
    a, a_port = make_node()
    swarm.append((a, a_port))
    b, b_port = make_node(bootstrap_port=a_port)
    swarm.append((b, b_port))
    c, c_port = make_node(bootstrap_port=b_port)
    swarm.append((c, c_port))

    a.announce('c' * 64, '127.0.0.1:9201', title='from A')

    results = c.lookup('c' * 64)
    assert results == [{'host': '127.0.0.1:9201', 'title': 'from A'}]
