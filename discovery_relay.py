#!/usr/bin/env python3
"""
Roadmap item 8: discovery. The design from the brainstorm was "no single
canonical index — gossiped signed events, any number of independent
replaceable relays, personalized ranking client-side," Nostr-style. This is
that, actually built and running, not just described.

A relay here is deliberately dumb: real stdlib HTTP server, verifies a
posted event's signature (cheap, uncontroversial — garbage in doesn't get
stored) but has NO opinion on content quality, no ranking, no single
"trending" list. It just stores what it's given and serves it back on
request. That's the whole point: any number of these can run independently,
none of them are load-bearing on their own, and a client is expected to
query several and merge — see poc_discovery.py for the client side.

Event shapes (all just signed JSON blobs, reusing poc_reputation.py's
Ed25519 signing):
  publish    {content_hash, title}                — a creator announces content
  like       {content_hash}                        — a viewer signals approval
  subscribe  {target_pubkey}                        — a viewer follows a creator/signer
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from poc_reputation import verify_attestation, attestation_id

# Events are still held in-memory for serving (a real relay would use a
# real DB; irrelevant to the design) -- but write-through to a JSONL file
# too, so a restart (deploy, crash, or Fly scaling this to zero when
# idle) doesn't silently wipe every event that's ever been posted. Point
# WEED_RELAY_DATA at a mounted Fly Volume path (e.g. /data/events.jsonl)
# to survive machine restarts; the local relative-path default is fine
# for dev/shell.py use where nothing's actually being deployed.
DATA_PATH = os.environ.get('WEED_RELAY_DATA',
                            os.path.join(os.path.dirname(os.path.abspath(__file__)), 'relay_events.jsonl'))
_events = []
_lock = threading.Lock()

# no real signed event (a handful of JSON fields: hashes, URLs, titles)
# is anywhere close to this; it's purely a cap against a client claiming
# a huge Content-Length and making this internet-facing server read an
# unbounded amount into memory
MAX_BODY_SIZE = 256 * 1024

# bounds one identity's storage footprint on this relay -- signer_pubkey
# is cryptographically bound to its event's signature (see
# verify_attestation), so it can't be spoofed to blame someone else's
# quota, and is genuinely what's exceeding the cap. Doesn't stop an
# attacker from generating a fresh keypair per event -- Ed25519 keygen is
# free -- but that's a fundamentally bigger attack (unlimited identities)
# than "spam with one key," and defending against it needs proof-of-
# work/stake, a bigger design decision than this PoC calls for.
MAX_EVENTS_PER_SIGNER = 200


def _load_events():
    if not os.path.exists(DATA_PATH):
        return
    with open(DATA_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                _events.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # tolerate a truncated last line from a killed-mid-write process


def _append_event(event):
    os.makedirs(os.path.dirname(DATA_PATH) or '.', exist_ok=True)
    with open(DATA_PATH, 'a') as f:
        f.write(json.dumps(event) + '\n')


def _rewrite_events_file():
    """Full rewrite instead of the usual cheap append -- only needed when
    an entry was evicted from _events (see _evict_oldest_for_signer),
    since dropping a line from a JSONL file means rewriting it."""
    os.makedirs(os.path.dirname(DATA_PATH) or '.', exist_ok=True)
    tmp = DATA_PATH + '.tmp'
    with open(tmp, 'w') as f:
        for event in _events:
            f.write(json.dumps(event) + '\n')
    os.replace(tmp, DATA_PATH)


def _evict_oldest_for_signer(signer_pubkey):
    """Caller must hold _lock. Drops that signer's own oldest event once
    they're at the cap, making room for the new one -- an active
    publisher keeps working, they just eventually lose their own oldest
    entries first, same trade as any keep-last-N retention policy."""
    if not signer_pubkey:
        return
    mine = [e for e in _events if e['payload'].get('signer_pubkey') == signer_pubkey]
    if len(mine) < MAX_EVENTS_PER_SIGNER:
        return
    oldest = min(mine, key=lambda e: e['payload'].get('ts', 0))
    _events.remove(oldest)
    _rewrite_events_file()


class RelayHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet — poc_discovery.py prints what matters

    def do_POST(self):
        if self.path != '/event':
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_BODY_SIZE:
            self.send_response(413)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False,
                                          'reason': f'body too large (max {MAX_BODY_SIZE} bytes)'}).encode())
            return
        try:
            event = json.loads(self.rfile.read(length))
            ok, reason = verify_attestation(event)  # generic: works on any {payload, signature} blob
        except Exception as e:
            ok, reason = False, f'malformed request: {e}'
        if not ok:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False, 'reason': reason}).encode())
            return
        eid = attestation_id(event)
        with _lock:
            if not any(attestation_id(e) == eid for e in _events):
                _evict_oldest_for_signer(event['payload'].get('signer_pubkey'))
                _events.append(event)
                _append_event(event)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'event_id': eid}).encode())

    def do_GET(self):
        if self.path.split('?')[0] != '/events':
            self.send_response(404); self.end_headers(); return
        qs = parse_qs(urlparse(self.path).query)
        with _lock:
            out = list(_events)
        if 'type' in qs:
            out = [e for e in out if e['payload'].get('type') == qs['type'][0]]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(out).encode())


def run_relay_server(port, quiet=False):
    """Split out from main() so shell.py can run a relay in a background
    thread — same pattern as node.run_host_server. quiet=True for the shell:
    a background thread's print() races with cmd.Cmd's input()-driven
    prompt on the same stdout with no coordination between them — readline
    doesn't know to redraw the prompt when unrelated output shows up mid-
    read, so the two interleave and the prompt looks like it "disappeared."
    The shell already prints its own equivalent confirmation line, so this
    fixes it at the source instead of patching the visual symptom."""
    _load_events()
    srv = ThreadingHTTPServer(('0.0.0.0', port), RelayHandler)
    if not quiet:
        print(f"[relay:{port}] up, no opinion on content, just store-and-forward "
              f"({len(_events)} event(s) loaded from {DATA_PATH})", flush=True)
    srv.serve_forever()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9101
    run_relay_server(port)


if __name__ == '__main__':
    main()
