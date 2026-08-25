# weed

**Censorship-resistant video distribution — proof of concept.**

BitTorrent-style storage and delivery, discovery via gossiped signed
events instead of a canonical index, incentives paid directly over
Lightning instead of a project token. This repo is the distribution and
incentive layer; [`ott`](https://pypi.org/project/btcvm/) (the `btcvm`
package) is the underlying archive/storage format it builds on.

Every mechanism below has a standalone proof-of-concept script that
validates it in isolation, plus a real integration test with actual
output (not simulated) — see [Status](#status) for what's verified.

## Contents

- [Design goals](#design-goals)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Running a node](#running-a-node)
  - [CLI](#cli)
  - [Interactive shell](#interactive-shell)
  - [Web UI](#web-ui)
  - [Docker](#docker)
- [Core mechanisms](#core-mechanisms)
- [The integrated node](#the-integrated-node)
- [Deploying relays](#deploying-relays)
- [Status](#status)
- [Known limitations](#known-limitations)

## Design goals

Storage and delivery over BitTorrent-plus-a-chain-timestamp is the easy
part. The two things that actually kill projects like this:

- **Incentives.** LBRY minted a token and got sued as an unregistered
  security. BitTube minted a token and died to the standard
  watch-to-earn Ponzi spiral. PeerTube minted nothing and stayed
  permanently niche — no incentive layer at all, purely
  volunteer-hosted. Anchoring to existing BTC (no new token) and paying
  for service directly over Lightning avoids both failure modes at once.
- **Discovery.** A single global index or "trending" list is exactly as
  seizable as YouTube's own trending page. The answer that doesn't
  reintroduce a chokepoint: no canonical list at all — gossiped signals
  (likes, subscribes, payments), any number of independent, replaceable
  indexer apps computing their own view, Nostr-style.

## Architecture

| Component | Role |
|---|---|
| `node.py` | The real node: hosts, discovers, downloads, likes, subscribes. Wraps the actual wire protocol, possession-challenge auction, reputation, and trust graph. |
| `discovery_relay.py` | Dumb store-and-forward HTTP relay for signed events (`publish`/`like`/`subscribe`/`attestation`). No ranking logic, no content opinion — verifies signatures, stores, serves back. |
| `tunnel_relay.py` | NAT-traversal relay: pairs a downloader with a host that has no reachable inbound port, via a rendezvous protocol (REGISTER/CONNECT/NEWSTREAM/DATA). |
| `dht.py` | Kademlia-based discovery (`kademlia` library) — finds peers with no relay at all. Covers `announce`/`lookup` only, not the richer signed-event system. |
| `weed.py` / `shell.py` | Argparse CLI and an interactive, tab-completing shell (`cmd.Cmd`, same pattern as `ott`'s shell). |
| `web_ui.py` + `web/` | Local browser control UI — stdlib HTTP JSON API plus a static, no-build-step frontend. |
| `lightning_settle.py` + `lightning/` | Real Lightning HTLC settlement against two LND nodes on regtest. |
| `poc_*.py` | Standalone proofs for each mechanism (auction, network timing, reputation, discovery, real archive) — see [Core mechanisms](#core-mechanisms). |

## Quick start

```bash
pip install -e .          # installs the `weed` command (see pyproject.toml)
# or: pip install -r requirements.txt   # run via python3 weed.py instead

weed --help
```

Three terminals — host a file, discover it, download it:

```bash
# terminal 1: a discovery relay (or use the shell's `relay` command instead — see below)
python3 discovery_relay.py 9101

# terminal 2: host something (real_archive/ has a small demo .ott archive)
weed host real_archive --port 9201 --relay http://127.0.0.1:9101

# terminal 3
weed whoami
weed discover --relay http://127.0.0.1:9101
weed download <content_hash_prefix> --relay http://127.0.0.1:9101 --out downloaded.mp4
weed like <content_hash> --relay http://127.0.0.1:9101
weed subscribe <target_pubkey> --relay http://127.0.0.1:9101
```

`--advertise-host` matters once you're off localhost — there's no NAT
traversal on the direct path, it just tells the relay what address to
hand out; reachability is on you (see `--tunnel` below for the
NAT-friendly path).

## Running a node

### CLI

`weed.py` is a thin argparse wrapper — `weed <subcommand> --help` for
any command. Also runs straight from source: `python3 weed.py ...`.

### Interactive shell

`weed` with no arguments (or `weed shell`) drops into a `cmd.Cmd` shell
with tab completion and short aliases (`w`/`h`/`r`/`disc`/`dl`/`l`/`sub`).
`relay` and `host` run in background threads, so one session covers the
whole flow — relay, host, discover, download, like, subscribe — with no
second terminal:

```
weed> relay
  relay running on port 9101 in the background — set as your default relay
weed> host real_archive --relay http://127.0.0.1:9101
  hosting real_video.mp4 on port 9201 in the background — shell still usable
weed> discover
  'real_video.mp4'   hash=7f2477c7ea675004...  host=127.0.0.1:9201  by=409a15dcfc59...
weed> download 7f24<TAB>
7f2477c7ea675004ad5dbab6dc7c44327c724b880cc389807df1965b77966acc
weed> download 7f2477c7ea675004ad5dbab6dc7c44327c724b880cc389807df1965b77966acc
3324 chunks downloaded and verified in 1.4s
```

`download`/`like` tab-complete against hashes from the last `discover`;
`subscribe` completes against pubkeys actually seen. `serve` and
`dht start` also run in the background — see below.

### Web UI

`web_ui.py` wraps the same `node.py` functions behind a small stdlib
JSON API plus a static, no-build-step frontend — host/discover/download/
like/subscribe without memorizing CLI flags. Binds `127.0.0.1` by
default (no auth built — this is a local control surface, not something
meant to face the internet); `--bind 0.0.0.0` widens it at your own
risk and auto-detects your real LAN IP for the printed/scanned QR code.

```bash
weed serve                          # alias for `web`, positional: serve [bind] [port]
weed serve 0.0.0.0 8080             # reachable from your phone; prints a scan-to-open QR
```

Includes real HTTP range support (`/api/stream/<job_id>`) so a
`<video>` tag can seek a completed download instead of downloading it
blind.

### Docker

`Dockerfile.node` + `docker-compose.node.yml` package `web_ui.py` to run
somewhere other than a laptop.

```bash
make node                            # build + run, http://127.0.0.1:8080
make node-down                       # stop it — data persists
WEED_SHARE_DIR=~/Movies make node    # mount a real directory of .ott archives at /share
```

- Identity key, reputation store, and library manifest all persist in a
  named volume (`node-data`, mounted at `$HOME=/data`) — one node keeps
  the same pubkey (and everything vouching for it) across restarts.
- `/share` is a separate *bind* mount, not a named volume, so the actual
  `.ott` archives you're hosting are real files on the host you can see
  and manage directly. Point the web UI's Host form at `/share`.
- An entry's `last_path` (recorded at `ott add` time, on whatever
  machine ran it) is only trusted if it exists on disk; otherwise the
  node falls back to the given archive directory. This matters the
  moment the same content is mounted somewhere else than where it was
  archived — e.g. `/share` here vs. wherever it originally lived.

## Core mechanisms

Each of these has a standalone script proving the mechanism works
before it's wired into `node.py`.

**`poc_challenge_auction.py`** — possession-gated reverse auction. A
naive price-only auction picks the cheapest bidder regardless of
whether they can deliver (and does, in the captured run — a peer
holding zero chunks wins on price alone). Gating bid eligibility on a
random chunk-index + Merkle-proof challenge fixes it. A second
mechanism (nonce-salted challenge + timing bound) catches a peer that
*has* the real bytes but fetches them from someone else in real time —
SHA256 preimage resistance alone can't, only added latency can.

**`poc_network_challenge.py`** + **`docker-compose.yml`** — the same
mechanism over real TCP sockets, both on loopback and across real
containers. Finding: single-shot timing does *not* reliably separate an
honest holder from a relay on loopback; averaging repeated challenges
does (crossover point moves between runs — measure it live, don't
hardcode a threshold):

![session-size separation chart](poc_challenge_separation.png)

Over real WAN distance (tunneled to a remote box over SSH), the gap is
~1700x and separates cleanly at a single sample — the hard case this
PoC stress-tests is two peers that are genuinely close together.

**`poc_reputation.py`** — persistent local reputation plus signed,
portable attestations (Ed25519, real signing/verification): a client's
own record of direct experience with a peer, a way to hand a signed
verification outcome to someone else who hasn't dealt with that peer
yet, and signer-scoped revocation (the revoked attestation stays on
record rather than disappearing).

**`lightning_settle.py`** + **`lightning/`** — real Lightning HTLC
settlement: two real LND nodes (`alice`, `bob`) on regtest, real
bitcoind backing them, a real funded channel. `create_invoice(node,
amount, memo)` and `pay_invoice(payer_node, bolt11, expected_hash)` are
the pieces `node.py`'s real download path uses to pay *whichever* host
actually wins the auction, as itself — not a fixed direction.
`poc_challenge_auction.py --lightning` (a standalone demo with no real
distinct host/downloader) still settles through a plain `settle()`
wrapper, alice-pays-bob, unchanged. Every payment independently
re-verifies the revealed preimage against the invoice's own payment
hash rather than trusting LND's status string. See
`lightning/README.md` for one-time channel setup.

**`poc_real_archive_challenge.py`** — the same mechanism against a real
217MB video archived with `ott` at a real 64KB chunk size (3324 real
chunks, not 8 synthetic ones). Confirms Merkle proof size grows
O(log N): 12 steps at 3324 chunks, ~17 steps even at a 2-hour movie's
scale — still under 1KB.

**`discovery_relay.py`** + **`poc_discovery.py`** — no canonical index.
Three independent, deliberately dumb relay processes (verify a
signature, store, serve — zero ranking opinion). Two clients with
different subscribe graphs compute different rankings for the same 27
gossiped events; a 20-identity sybil swarm liking the same content
moves neither client's score, because neither subscribes to any of the
sybils. Killing one relay outright loses only what was posted
exclusively there — redundancy has to be deliberate.

**`dht.py`** — Kademlia DHT discovery (`kademlia` library) for finding
peers with no relay URL known out of band. Verified across three
chained nodes with no direct connection between the endpoints, and —
the strongest test — content still discoverable by a fourth,
independent process after the announcing node's own process had
already exited.

```bash
python3 dht.py 8468                     # first node, new swarm
python3 dht.py 8469 127.0.0.1:8468      # second node, joins the first
```

## The integrated node

`download_with_auction` (the real path behind `weed download`) ties
every mechanism above together:

1. **Resolve** every host claiming to have the content, grouped by
   content hash (not by event — a second host publishing the same file
   is actually considered).
2. **Possession-challenge** each one — sample-FETCH `k` random chunks
   (default 3), verified against Merkle-checked LEAVES.
3. **Auction survivors** by local reputation first, then price.
4. **Pay the winner** over a real Lightning HTLC if `--lightning` is
   given and the price is nonzero — the winning host's own `--lightning-node`
   generates a real BOLT11 invoice (a new `INVOICE` wire verb) for the
   agreed price, and `--lightning-node` on the downloader's side pays
   that exact invoice, on the same session that then serves the file. A
   host with no `--lightning-node` configured just answers `INVOICE`
   with `ERR`, and `--lightning` against it fails loudly instead of
   downloading unpaid.
5. **Download and record** the outcome to `~/.weed_reputation.json`, and
   publish it as a signed attestation so the next downloader — even one
   with no direct history with that host — benefits transitively.

**Transitive trust**: `build_trust_graph()` does a real BFS outward from
your own pubkey through signed `subscribe` events pulled from a relay,
decaying trust per hop (default 0.5×, shortest path only — summing
across paths would let a sybil ring inflate a target's trust just by
adding more low-value paths). A host you've never dealt with directly
can still score above zero if someone in your trust graph has already
vouched for it.

**NAT traversal** (`tunnel_relay.py`): a relay-mediated rendezvous
rather than real STUN/ICE hole-punching — works behind any NAT
including CGNAT, since both sides only ever make outbound connections.
A host opens one persistent outbound `REGISTER` control connection; a
downloader `CONNECT`s; the relay asks the host to dial back
(`NEWSTREAM`/`DATA`) and then shovels raw bytes between the two
sockets, no opinion on the tunneled protocol. Supports TLS at the edge
(`tls://` prefix, for relays like Fly that terminate TLS themselves) and
a periodic heartbeat so idle control connections survive proxies that
reset connections after a few minutes of silence.

```bash
python3 discovery_relay.py 9101
python3 tunnel_relay.py 9199
weed host real_archive --port 9201 --tunnel 127.0.0.1:9199 \
    --relay http://127.0.0.1:9101 --advertise-host 10.255.255.1
weed download <content_hash> --relay http://127.0.0.1:9101 --out downloaded.mp4
```

## Deploying relays

`discovery_relay.py` and `tunnel_relay.py` each ship a `Dockerfile.*`
and `fly.*.toml` for running them publicly on Fly.io, since they need
different scaling behavior:

- **Discovery relay** is plain HTTP — Fly's auto-detected
  `[http_service]` is correct as-is, including scale-to-zero when idle.
  Persist events across restarts/deploys with a mounted Volume at
  `WEED_RELAY_DATA` (defaults to the container's own ephemeral
  filesystem otherwise).
- **Tunnel relay** is raw TCP holding in-memory state
  (`_registrations`/`_pending_streams`), not HTTP — needs an explicit
  `[[services]]` block (`protocol = "tcp"`, `handlers = ["tls"]` for
  edge TLS) instead of the auto-detected one, and exactly one machine,
  always running (`min_machines_running = 1`, no autoscale). Two
  replicas would let a REGISTER and a CONNECT for the same token land on
  machines that have never heard of each other's state; scaling to zero
  would drop every active registration, and a persistent control
  connection can't wake a scaled-to-zero machine the way an HTTP request
  can.

## Status

Everything below is implemented and verified against real output, not
just designed:

- Possession-gated auction (chunk-index + nonce/timing challenges)
- Real-socket timing separation, loopback and real containers
- Local reputation + signed, revocable attestations
- Real WAN calibration against an actual second machine
- Real Lightning HTLC settlement, paid to whichever host actually wins
  the auction, as itself (real BOLT11 invoice over an `INVOICE` wire
  verb, not a fixed pair settled regardless of who hosted) — regtest
- Real `.ott` archive at scale (217MB, 3324 chunks, O(log N) proofs)
- Discovery with no canonical index, sybil-resistant, relay-death tested
- Multi-file hosting (one port, `SELECT` by content hash)
- Transitive trust through the subscribe graph
- NAT traversal via relay-mediated tunneling, with TLS and heartbeat
- Kademlia DHT discovery, survives the announcing node going offline
- Local web UI with live progress, QR onboarding, and HTTP range streaming
- Containerized node (`Dockerfile.node`, `docker-compose.node.yml`)

## Known limitations

Honest edges that are still real constraints even though the core
mechanisms hold up:

- Loopback timing separation isn't airtight on a single sample —
  averaging repeated challenges is required.
- Relay death loses anything posted exclusively there; redundancy
  across relays isn't automatic.
- Lightning settlement is regtest-only, and both sides still have to
  name which of exactly two demo LND identities (`alice`/`bob`) they
  are — the protocol pays whoever really won, but the pool of real
  nodes to test against is still the fixed two-node demo topology, not
  an arbitrary host's own independently-run LND node.
- The DHT covers host-discovery only, not the richer publish/like/
  subscribe/attestation event system.
- The tunnel relay (even with TLS) is a single point of failure and
  bandwidth cost, with no redundancy story the way discovery relays have.
- The web UI has no authentication; it's local-only by design. It also
  doesn't expose `--lightning-node` in its Host/Download forms yet,
  even though the API accepts it.
