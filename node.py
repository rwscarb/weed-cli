#!/usr/bin/env python3
"""
The missing integration piece: a real node that hosts, discovers, and
downloads — not another isolated demo. Wires together pieces already built
tonight rather than reinventing them:

  - real chunk-serve protocol, extended from poc_network_challenge.py's
    holder (adds INFO/LEAVES so a downloader can learn the archive's shape
    before fetching)
  - real ott archives (same .ott/ format poc_real_archive_challenge.py
    read from, via `pip install btcvm`)
  - real signed events (Identity/sign_event from poc_reputation.py), now
    persisted to disk instead of regenerated fresh every run — a real node
    needs a stable identity across invocations
  - the same discovery relay protocol from discovery_relay.py

What's actually new here, not just wired: a real client-driven download —
every previous script verified chunks locally or over a network, none of
them reassembled a full file from a remote peer onto disk before this.
"""
import base64
import concurrent.futures
import hashlib
import json
import os
import random
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from poc_reputation import Identity, verify_attestation, attestation_id
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

IDENTITY_PATH = os.path.expanduser('~/.weed_identity.key')
IDENTITY_ARMOR_HEADER = '-----BEGIN WEED IDENTITY KEY-----'
IDENTITY_ARMOR_FOOTER = '-----END WEED IDENTITY KEY-----'

TAGLINE = 'we do in 4 what others do in 5'


def weed_version():
    """Installed package version (pyproject.toml's source of truth), with
    fallbacks for the two other real ways this runs: straight from a git
    checkout without `pip install -e .` (read pyproject.toml directly —
    Dockerfile.node copies it in for exactly this, since it copies loose
    .py files rather than pip-installing the package), or neither file
    present at all (genuinely no version info available)."""
    try:
        from importlib.metadata import version, PackageNotFoundError
        try:
            return version('weed-cli')
        except PackageNotFoundError:
            pass
    except ImportError:
        pass
    pyproject_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pyproject.toml')
    try:
        with open(pyproject_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith('version'):
                    return line.split('=', 1)[1].strip().strip('"\'')
    except (OSError, IndexError):
        pass
    return '0.0.0-dev'


def _git_commit_hash():
    """Short commit hash of whatever checkout this node.py is actually
    running from, if any. A bare version number only changes on a
    deliberate release/bump — it says nothing about which commit's fixes
    are actually loaded between releases, which is exactly the ambiguity
    behind a real debugging session: two checkouts reporting the same
    version, one of them missing a fix the other had. None for anything
    that isn't a git checkout at all (installed from a built wheel/sdist,
    no .git present) — a version number is all there is to go on there.

    $WEED_GIT_COMMIT checked first — Dockerfile.node has no .git directory
    at all (never copied in, on purpose: bloats the image and ships the
    full history for no reason), so a container build has no way to
    answer this live. docker-compose.node.yml passes the *host's* commit
    hash in as a build arg at image-build time instead, baked in as this
    env var, same intent as the live git lookup below just computed once,
    earlier, somewhere that actually has the repo.

    `git rev-parse` walks *up* parent directories looking for a .git —
    a real `pip install .` (not `-e`) copies this file into site-packages,
    which usually isn't a checkout at all, but if it happens to be nested
    anywhere under some unrelated git-tracked ancestor directory (a
    dotfiles repo, a pyenv install tracked in git, anything above it),
    this would otherwise silently report *that* repo's own unrelated
    commit — worse than showing nothing, since it looks plausible. Only
    trust the hash once --show-toplevel confirms this file's own
    directory really is that repo's root."""
    env_commit = os.environ.get('WEED_GIT_COMMIT')
    if env_commit:
        return env_commit
    repo_dir = os.path.dirname(os.path.abspath(__file__))
    try:
        toplevel = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=repo_dir,
                                   capture_output=True, text=True, timeout=2)
        if toplevel.returncode != 0:
            return None
        if os.path.realpath(toplevel.stdout.strip()) != os.path.realpath(repo_dir):
            return None
        result = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=repo_dir,
                                 capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def weed_banner():
    commit = _git_commit_hash()
    commit_note = f' ({commit})' if commit else ''
    return f'weed v{weed_version()}{commit_note} — {TAGLINE}'


def _armor_identity(raw_bytes):
    """Base64 text with a header/footer — NOT real OpenPGP armor (no
    CRC24, no packet framing), and not encryption: this only changes how
    the same private key bytes are encoded on disk, from opaque binary
    (`file` calls it "data") to something readable/diffable/copy-
    pasteable. A weed-specific label on purpose, not a PGP one — this
    repo already decided against adopting the real OpenPGP format (see
    README's "Transitive trust" section), so nothing here should look
    like it's actually PGP-compatible."""
    b64 = base64.b64encode(raw_bytes).decode()
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return IDENTITY_ARMOR_HEADER + '\n' + '\n'.join(lines) + '\n' + IDENTITY_ARMOR_FOOTER + '\n'


def _dearmor_identity(text):
    lines = text.strip().splitlines()
    if len(lines) < 2 or lines[0].strip() != IDENTITY_ARMOR_HEADER \
            or lines[-1].strip() != IDENTITY_ARMOR_FOOTER:
        raise ValueError('not a weed-armored identity key')
    return base64.b64decode(''.join(lines[1:-1]))


def load_or_create_identity():
    """A real node needs a stable pubkey across runs — regenerating fresh
    every invocation (like every other script tonight) would mean nobody
    could ever build reputation or subscribe to a host's key for real."""
    identity = Identity('local')
    if os.path.exists(IDENTITY_PATH):
        with open(IDENTITY_PATH, 'rb') as f:
            file_bytes = f.read()
        try:
            key_bytes = _dearmor_identity(file_bytes.decode())
        except (UnicodeDecodeError, ValueError):
            # pre-armor identity file (raw 32 bytes, no wrapper) — same key,
            # just not encoded yet. Re-armor it in place so this only ever
            # has to happen once; the underlying private key bytes (and
            # therefore the pubkey) are untouched.
            key_bytes = file_bytes
            with open(IDENTITY_PATH, 'w') as f:
                f.write(_armor_identity(key_bytes))
            os.chmod(IDENTITY_PATH, 0o600)
        identity._priv = Ed25519PrivateKey.from_private_bytes(key_bytes)
        identity.pub = identity._priv.public_key()
    else:
        key_bytes = identity._priv.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption())
        with open(IDENTITY_PATH, 'w') as f:
            f.write(_armor_identity(key_bytes))
        os.chmod(IDENTITY_PATH, 0o600)
    return identity


# ── wire protocol — text command line, JSON/base64 bodies where needed ─────

def recv_line(sock):
    buf = b''
    while not buf.endswith(b'\n'):
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    return buf.decode().strip()


class LineReader:
    """Buffered line reader for a connection that can receive more than
    one newline-terminated message per recv() — recv_line above assumes
    exactly one line arrives per call, true everywhere else in this
    protocol (strict request/response, never pipelined) but not true for
    the tunnel control channel: if two downloaders CONNECT to
    tunnel_relay.py around the same time, both NEWSTREAM messages can
    legitimately land in a single recv(), and recv_line would silently
    fold both into one malformed line and drop the second one."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b''

    def readline(self):
        while b'\n' not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                line, self.buf = self.buf, b''
                return line.decode().strip()
            self.buf += chunk
        line, self.buf = self.buf.split(b'\n', 1)
        return line.decode().strip()


def find_manifest_entry(archive_dir, file_name=None):
    archive_dir = os.path.expanduser(archive_dir)  # os.path.join never expands ~, it stays literal
    manifest_path = os.path.join(archive_dir, '.ott', 'manifest.jsonl')
    if not os.path.exists(manifest_path):
        sys.exit(f"no .ott/manifest.jsonl in {archive_dir} — archive a file with ott first")
    with open(manifest_path) as f:
        entries = [json.loads(line) for line in f if line.strip()]
    if file_name:
        entries = [e for e in entries if e['name'] == file_name]
    if not entries:
        sys.exit(f"no archived file found in {archive_dir}" + (f" matching {file_name}" if file_name else ""))
    return entries[-1]  # last-write-wins, same convention ott itself uses


def load_manifest_entries(archive_dir, file_name=None):
    """Every distinct file in the archive, not just one — find_manifest_entry
    collapses to a single entries[-1], which is exactly why `host <dir>` with
    no --file only ever served the single most-recently-added file out of a
    45-video archive. Dedupes by name (last-write-wins, same convention).

    Only 'video' entries are returned. Hosting depends on chunk data
    (load_leaves) and per-chunk byte math (entry['chunk_size']), and ott
    only ever writes either for video-type entries — everything else
    (photos, or any file whose extension ott's is_video() doesn't
    recognize, which is also where a plain .mp3 lands, since ott only has
    two types) has chunk_size: None and no .ott/chunks/<hash>.json at all.
    Filtering here, the one function every hosting path (weed.py,
    shell.py, web_ui.py) goes through, means one non-video file sitting
    in an archive_dir no longer poison-pills hosting everything else in
    it with 'no chunks file at ...'."""
    archive_dir = os.path.expanduser(archive_dir)
    manifest_path = os.path.join(archive_dir, '.ott', 'manifest.jsonl')
    if not os.path.exists(manifest_path):
        sys.exit(f"no .ott/manifest.jsonl in {archive_dir} — archive a file with ott first")
    with open(manifest_path) as f:
        raw = [json.loads(line) for line in f if line.strip()]
    if file_name:
        raw = [e for e in raw if e['name'] == file_name]
    by_name = {}
    for e in raw:
        by_name[e['name']] = e
    all_entries = list(by_name.values())
    entries = [e for e in all_entries if e.get('type') == 'video']
    if not entries:
        if all_entries:
            n = len(all_entries)
            sys.exit(f"no hostable video file found in {archive_dir}" +
                     (f" matching {file_name}" if file_name else "") +
                     f" — found {n} non-video entr{'y' if n == 1 else 'ies'} "
                     f"(only video files can be hosted; see ott's is_video())")
        sys.exit(f"no archived file found in {archive_dir}" + (f" matching {file_name}" if file_name else ""))
    return entries


def load_leaves(archive_dir, root_hash):
    archive_dir = os.path.expanduser(archive_dir)
    chunks_path = os.path.join(archive_dir, '.ott', 'chunks', f'{root_hash}.json')
    if not os.path.exists(chunks_path):
        sys.exit(f"no chunks file at {chunks_path} — the manifest entry for this hash has no "
                 f"matching chunk data in this archive_dir (stale/mismatched .ott/ state, or "
                 f"this isn't the archive_dir that file was actually added from)")
    with open(chunks_path) as f:
        return json.load(f)


def resolve_file_path(entry, archive_dir):
    """last_path is recorded at archive time (see ott's own manifest
    writer) and is an absolute path on whatever machine ran `ott add` —
    trusting it unconditionally breaks the moment archive_dir is the same
    content mounted somewhere else (a Docker bind mount at /share instead
    of the original /home/user/share it was archived from, a synced
    folder on another machine, ...), since it's still non-empty and short-
    circuits the `or` before archive_dir is ever considered. Falling back
    whenever last_path doesn't actually exist trusts the directory the
    caller explicitly told us to look in over a possibly-stale hint."""
    last_path = entry.get('last_path')
    if last_path and os.path.exists(last_path):
        return last_path
    return os.path.join(archive_dir, entry['name'])


def _graceful_close(sock):
    """Plain sock.close() on an SSL-wrapped socket tears down the TCP
    connection without ever sending a TLS close_notify -- fine for the
    plaintext direct-connect path, but every tunneled connection here is
    TLS all the way to Fly's edge (fly.tunnel-relay.toml terminates TLS
    there, handlers = ["tls"]), and Fly's proxy logs that abrupt cutoff as
    'fly-proxy-p2p/tls/tcp-backhaul: unexpected end of file' even though
    the app-level protocol already got every byte it needed by then.
    unwrap() sends the close_notify so the edge sees a clean shutdown
    instead of a truncation."""
    if isinstance(sock, ssl.SSLSocket):
        try:
            # unwrap() blocks waiting for the peer's own close_notify --
            # cap that wait so a peer that's already gone can't leak this
            # thread forever, same reasoning as the timeouts already used
            # for connect_via_tunnel/_connect_tunnel_socket
            sock.settimeout(5)
            sock = sock.unwrap()
        except (OSError, ssl.SSLError, ValueError):
            pass
    sock.close()


def serve_session(conn, entries_by_hash, default_hash, price, ln_node=None):
    """Handle every command on one connection, not just one — a download
    needs INFO + LEAVES + one FETCH per chunk (thousands, for a real
    archive), and reconnecting per command is what makes a tunneled
    connection (see tunnel_relay.py) pay a full relay rendezvous per
    chunk instead of once per session. Shared by the direct accept() loop
    below and by run_host_tunnel's per-stream data connections.

    entries_by_hash lets one server (one port) hold more than one file —
    a downloader picks which via SELECT <content_hash_or_prefix> before
    anything else. default_hash (set only when the host has exactly one
    file) means a single-file host never needs SELECT at all, so the
    `download --from host:port` discovery-skipping escape hatch and the
    tunnel path (already scoped to one file before this function runs)
    keep working unchanged.

    ln_node names which demo LND identity (see lightning_settle.NODES) this
    host settles through — None means this host just never answers INVOICE
    with anything payable, same graceful-degradation shape PRICE already
    has for a host/client that doesn't know about it."""
    selected = default_hash
    try:
        while True:
            line = recv_line(conn)
            if not line:
                break
            parts = line.split()
            if not parts:
                continue
            if parts[0] == 'SELECT':
                match = next((h for h in entries_by_hash if len(parts) > 1 and h.startswith(parts[1])), None)
                if match:
                    selected = match
                    conn.sendall(b'OK\n')
                else:
                    conn.sendall(b'ERR unknown content hash\n')
                continue
            if selected is None:
                conn.sendall(b'ERR this host serves more than one file '
                              b'- send SELECT <content_hash> first\n')
                continue
            entry, leaves, file_path = entries_by_hash[selected]
            if parts[0] == 'INFO':
                conn.sendall((json.dumps({
                    'name': entry['name'], 'sha256': entry['sha256'], 'size': entry['size'],
                    'n_chunks': entry['n_chunks'], 'chunk_size': entry['chunk_size'],
                }) + '\n').encode())
            elif parts[0] == 'LEAVES':
                conn.sendall((json.dumps(leaves) + '\n').encode())
            elif parts[0] == 'CHALLENGE':
                idx, nonce_hex = int(parts[1]), parts[2]
                with open(file_path, 'rb') as f:
                    f.seek(idx * entry['chunk_size'])
                    data = f.read(entry['chunk_size'])
                h = hashlib.sha256(data + bytes.fromhex(nonce_hex)).hexdigest()
                conn.sendall(f'HASH {h}\n'.encode())
            elif parts[0] == 'FETCH':
                idx = int(parts[1])
                with open(file_path, 'rb') as f:
                    f.seek(idx * entry['chunk_size'])
                    data = f.read(entry['chunk_size'])
                conn.sendall((f'DATA {base64.b64encode(data).decode()}\n').encode())
            elif parts[0] == 'PRICE':
                conn.sendall(f'PRICE {price}\n'.encode())
            elif parts[0] == 'INVOICE':
                if not ln_node or price <= 0:
                    conn.sendall(b'ERR no payable invoice for this host/price\n')
                else:
                    import lightning_settle
                    try:
                        invoice = lightning_settle.create_invoice(ln_node, price, entry['sha256'][:16])
                        conn.sendall((json.dumps(invoice) + '\n').encode())
                    except lightning_settle.SettlementError as e:
                        conn.sendall(f'ERR invoice creation failed: {e}\n'.encode())
    finally:
        _graceful_close(conn)


def bind_host_port(port, bind_host='0.0.0.0'):
    """Split out of run_host_server so a caller (see web_ui.py's
    _run_host_job) can bind the real, permanent listening socket early —
    right where a port-collision needs to fail fast, before announcing
    anything — and hand that exact socket to run_host_server later
    instead of it binding a second, separate one. A bind-then-close probe
    followed by a *second*, later bind of the same port isn't atomic
    across two hosts starting concurrently: both can pass the probe
    before either does the real bind. Binding once, early, and reusing
    the same socket removes that race entirely instead of narrowing it."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((bind_host, port))
    return srv


def run_host_server(archive_dir, file_name, port, bind_host='0.0.0.0', quiet=False, price=0,
                     ln_node=None, sock=None):
    archive_dir = os.path.expanduser(archive_dir)
    entries = load_manifest_entries(archive_dir, file_name)
    entries_by_hash = {}
    for entry in entries:
        leaves = load_leaves(archive_dir, entry['sha256'])
        file_path = resolve_file_path(entry, archive_dir)
        if not os.path.exists(file_path):
            sys.exit(f"archived file not found on disk at {file_path}")
        entries_by_hash[entry['sha256']] = (entry, leaves, file_path)
    default_hash = next(iter(entries_by_hash)) if len(entries_by_hash) == 1 else None

    srv = sock if sock is not None else bind_host_port(port, bind_host)
    srv.listen(8)
    if not quiet:
        # a background thread's print() races with cmd.Cmd's input()-driven
        # prompt on the same stdout — see run_relay_server's docstring for
        # why the shell passes quiet=True instead of patching this visually
        if default_hash:
            entry = entries[0]
            print(f"[host:{port}] serving {entry['name']} ({entry['size']:,} bytes, "
                  f"{entry['n_chunks']} chunks x {entry['chunk_size']} bytes)")
            print(f"[host:{port}] sha256/merkle root: {entry['sha256']}")
        else:
            total_size = sum(e['size'] for e in entries)
            print(f"[host:{port}] serving {len(entries)} files ({total_size:,} bytes total) "
                  f"— clients SELECT which one by content hash")

    while True:
        conn, _ = srv.accept()
        # a whole download now lives on one connection (see serve_session) —
        # accept() must hand off to a thread per connection, or one session
        # would block every other downloader until it finished
        threading.Thread(target=serve_session, args=(conn, entries_by_hash, default_hash, price, ln_node),
                          daemon=True).start()


def _connect_tunnel_socket(relay_host, relay_port, use_tls):
    """Plain TCP to the tunnel relay, or TLS-wrapped if the relay
    terminates TLS at the edge (e.g. Fly's `handlers = ["tls"]`) — the
    relay process itself (tunnel_relay.py) never sees or needs to know
    about TLS either way, since edge termination decrypts before
    forwarding to it. Only the two ends actually crossing the public
    internet need this: a host's REGISTER/DATA connections here, and a
    downloader's CONNECT in HostConnection.connect_via_tunnel."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((relay_host, relay_port))
    if use_tls:
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(sock, server_hostname=relay_host)
    return sock


def run_host_tunnel(relay_host, relay_port, token, entry, leaves, file_path, price,
                     use_tls=False, quiet=False, heartbeat_interval=45, ln_node=None,
                     max_backoff=60):
    """NAT-traversal path: instead of (or alongside) binding a locally
    reachable port, register with a tunnel_relay.py relay and serve every
    downloader it pairs us with. One persistent CONTROL connection stays
    open for the lifetime of hosting; each real downloader gets its own
    DATA connection, dialed back to the relay on demand (NEWSTREAM), so
    concurrent tunneled downloads don't block each other.

    REGISTER gets one immediate OK/ERR reply (see below), then the
    control connection sends nothing at all until the first real
    NEWSTREAM — which can be minutes or hours if no one downloads in the
    meantime. Real-world proxies in the middle (observed: Fly's own
    edge) reset TCP connections that go idle for a few minutes, which
    silently unregisters the host with no error on this end until the
    next download attempt fails. A small periodic heartbeat keeps the
    connection looking active; tunnel_relay.py's REGISTER loop already
    discards anything it receives that isn't relevant to it (it only ever
    checks for EOF), so this needs zero changes on the relay side.

    The OK/ERR reply exists so a REGISTER for a token someone else
    already holds an active registration for can be refused instead of
    silently overwriting it — content_hash tokens are public (announced
    via discover), so without this anyone could squat/hijack another
    host's rendezvous slot for content they didn't actually publish.

    Runs forever, reconnecting with exponential backoff (1s, 2s, 4s, ...,
    capped at max_backoff) on any connection failure, rejected REGISTER,
    or the control connection just closing — this used to be one-shot
    (sys.exit on a rejected REGISTER, plain return once the connection
    dropped), which meant a tunnel relay restart for *any* reason (deploy,
    crash, Fly host migration) silently and permanently dropped every
    currently-hosting process until a human noticed and manually re-ran
    `host --tunnel`. Not hypothetical: a real Fly Machine restart took
    down every active registration on this relay at once in production
    (see the tunnel_relay.py fly logs from 2026-08-25), and every one of
    them stayed dead until manually restarted. This is the fix — the
    relay coming back is enough, no human required."""
    entries_by_hash = {entry['sha256']: (entry, leaves, file_path)}
    backoff = 1
    while True:
        rejected, reject_reason = False, None
        try:
            ctrl = _connect_tunnel_socket(relay_host, relay_port, use_tls)
            ctrl.sendall(f'REGISTER {token}\n'.encode())
            # one LineReader for the whole connection, created before the
            # first read and reused for the NEWSTREAM loop below --
            # creating a second one later would lose whatever extra bytes
            # this first recv() also happened to pick up (LineReader
            # buffers internally; a fresh instance starts with an empty
            # buffer, discarding anything already read into the old one)
            reader = LineReader(ctrl)
            ack = reader.readline()
            if ack != 'OK':
                rejected, reject_reason = True, ack or '(connection closed)'
                ctrl.close()
            else:
                if not quiet:
                    tls_note = ' (tls)' if use_tls else ''
                    print(f"[tunnel] registered {token[:16]}... with relay "
                          f"{relay_host}:{relay_port}{tls_note}")
                backoff = 1  # a real registration succeeded — forget any earlier backoff

                stop_heartbeat = threading.Event()

                def send_heartbeats():
                    while not stop_heartbeat.wait(heartbeat_interval):
                        try:
                            ctrl.sendall(b'PING\n')
                        except OSError:
                            return

                threading.Thread(target=send_heartbeats, daemon=True).start()

                try:
                    while True:
                        line = reader.readline()
                        if not line:
                            if not quiet:
                                print(f"[tunnel] control connection to {relay_host}:{relay_port} "
                                      f"closed for {token[:16]}... — reconnecting")
                            break
                        parts = line.split()
                        if parts and parts[0] == 'NEWSTREAM':
                            stream_id = parts[1]
                            data_conn = _connect_tunnel_socket(relay_host, relay_port, use_tls)
                            data_conn.sendall(f'DATA {stream_id}\n'.encode())
                            threading.Thread(target=serve_session,
                                              args=(data_conn, entries_by_hash, entry['sha256'],
                                                    price, ln_node),
                                              daemon=True).start()
                        # anything else (notably our own echoed-back nothing --
                        # PING is one-directional, the relay never echoes it)
                        # is silently ignored, same as it always was
                finally:
                    stop_heartbeat.set()
        except OSError as e:
            if not quiet:
                print(f"[tunnel] connection to relay {relay_host}:{relay_port} for "
                      f"{token[:16]}... failed ({e}) — retrying in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)
            continue

        if rejected:
            if not quiet:
                print(f"[tunnel] relay at {relay_host}:{relay_port} rejected REGISTER for "
                      f"{token[:16]}...: {reject_reason} — retrying in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)
            continue

        # control connection closed on its own after a previously-successful
        # registration (relay restart, idle proxy reset, ...) -- reconnect
        # right away rather than backing off; if the relay's actually still
        # down this just falls into the OSError branch above on the very
        # next iteration and starts backing off normally from there
        backoff = 1


# ── client side ──────────────────────────────────────────────────────────

class HostConnection:
    """One persistent socket carrying every command for a session, direct
    or tunneled — see serve_session's docstring for why reconnecting per
    command (the old behavior) is untenable once a tunnel relay is in the
    path."""

    def __init__(self, sock):
        self.sock = sock

    @classmethod
    def connect_direct(cls, host, port, timeout=10):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))
        return cls(sock)

    @classmethod
    def connect_via_tunnel(cls, relay_host, relay_port, token, use_tls=False, timeout=10):
        """token is the content_hash the host registered under (see
        run_host_tunnel) — the tunnel relay has zero opinion on content,
        it just pairs this CONNECT with that host's next NEWSTREAM."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((relay_host, relay_port))
        if use_tls:
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=relay_host)
        sock.sendall(f'CONNECT {token}\n'.encode())
        return cls(sock)

    def request(self, line):
        self.sock.sendall((line + '\n').encode())
        return recv_line(self.sock)

    def close(self):
        _graceful_close(self.sock)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()


def _parse_tunnel(tunnel_addr):
    """'relay_host:relay_port' or 'tls://relay_host:relay_port' ->
    (relay_host, relay_port, use_tls), or None. The tls:// prefix marks a
    relay that terminates TLS at the edge (e.g. Fly's `handlers =
    ["tls"]`) — publish() stores this string as given, so a downloader
    who discovers the host gets the same tls:// marker automatically and
    connects the same way the host registered."""
    if not tunnel_addr:
        return None
    use_tls = tunnel_addr.startswith('tls://')
    if use_tls:
        tunnel_addr = tunnel_addr[len('tls://'):]
    if ':' not in tunnel_addr:
        raise ValueError(f"--tunnel {tunnel_addr!r} is missing a port — expected "
                          f"[tls://]host:port, e.g. tls://tunnel.hak4.org:9199")
    relay_host, relay_port = tunnel_addr.rsplit(':', 1)
    if not relay_port.isdigit():
        raise ValueError(f"--tunnel port {relay_port!r} isn't a number — expected "
                          f"[tls://]host:port, e.g. tls://tunnel.hak4.org:9199")
    return relay_host, int(relay_port), use_tls


def open_connection(host_addr, tunnel=None, content_hash=None, timeout=10):
    """host_addr is 'host:port' — used directly unless tunnel is given, in
    which case it's ignored and content_hash is used as the tunnel
    rendezvous token instead (the host isn't reachable at host_addr at
    all in that case). tunnel is a pre-parsed _parse_tunnel() result."""
    if tunnel:
        if not content_hash:
            raise ValueError("tunnel connection requires content_hash as the rendezvous token")
        relay_host, relay_port, use_tls = tunnel
        return HostConnection.connect_via_tunnel(relay_host, relay_port, content_hash,
                                                   use_tls=use_tls, timeout=timeout)
    host, port_s = host_addr.rsplit(':', 1)
    return HostConnection.connect_direct(host, int(port_s), timeout=timeout)


def download(host_addr, out_path, tunnel=None, content_hash=None, on_progress=None,
             price=0, use_lightning=False, lightning_node=None):
    from ott import merkle_root  # pip install btcvm

    out_path = os.path.expanduser(out_path)
    via = f"tunnel {tunnel[0]}:{tunnel[1]}" if tunnel else host_addr
    with open_connection(host_addr, tunnel=tunnel, content_hash=content_hash) as conn:
        if content_hash and not tunnel:
            # tunnel connections are already scoped to one file by the relay's
            # rendezvous token (see run_host_tunnel) — SELECT is only needed
            # against a direct multi-file host, which may be serving more than
            # just this content_hash on the same port
            sel = conn.request(f'SELECT {content_hash}')
            if sel != 'OK':
                sys.exit(f"host at {host_addr} rejected SELECT {content_hash[:16]}...: {sel}")
        if use_lightning and price > 0:
            # pay this specific host as itself, on this same session, before
            # trusting it with a single byte -- INVOICE returns a real BOLT11
            # from the host's own LND (see serve_session), not a fixed demo
            # pair settled through a side channel regardless of who won
            import lightning_settle
            inv_resp = conn.request('INVOICE')
            if inv_resp.startswith('ERR') or not inv_resp:
                sys.exit(f"host at {via} can't produce a real Lightning invoice "
                         f"({inv_resp or 'no response'}) — rerun without --lightning to "
                         f"download unpaid, or ask the host to set --lightning-node")
            invoice = json.loads(inv_resp)
            payment = lightning_settle.pay_invoice(lightning_node, invoice['payment_request'],
                                                    invoice['payment_hash'])
            print(f"paid {via}'s own real Lightning invoice: {invoice['amount_sat']} sat, "
                  f"preimage {payment['preimage'][:12]}... verified against "
                  f"payment_hash {payment['payment_hash'][:12]}...")
        info = json.loads(conn.request('INFO'))
        print(f"downloading {info['name']} ({info['size']:,} bytes, {info['n_chunks']} chunks) "
              f"from {via}")
        leaves = json.loads(conn.request('LEAVES'))
        if len(leaves) != info['n_chunks']:
            sys.exit(f"host's LEAVES count ({len(leaves)}) doesn't match its own INFO "
                     f"({info['n_chunks']}) — refusing to trust an inconsistent host")

        # ott records a VIDEO's sha256 field as the Merkle root over its chunk
        # hashes, not a linear whole-file hash (see cmd_add: `digest =
        # merkle_root(chunks)`) — verify that BEFORE downloading a single byte,
        # so a host can't serve a self-consistent-but-fake leaves list.
        recomputed_root = merkle_root(leaves)
        if recomputed_root != info['sha256']:
            sys.exit(f"host's LEAVES don't Merkle-root to its own advertised sha256 "
                     f"({recomputed_root[:16]}... != {info['sha256'][:16]}...) — "
                     f"refusing to download from a host lying about its own archive")

        t0 = time.time()
        with open(out_path, 'wb') as out:
            for idx in range(info['n_chunks']):
                resp = conn.request(f'FETCH {idx}')
                if not resp.startswith('DATA '):
                    sys.exit(f"chunk {idx}: bad response from host: {resp[:80]}")
                data = base64.b64decode(resp[5:])
                leaf = hashlib.sha256(data).hexdigest()
                if leaf != leaves[idx]:
                    sys.exit(f"chunk {idx}: hash mismatch — host sent bytes that don't match "
                             f"its own committed chunk hash. aborting download, not writing a "
                             f"corrupted/tampered file.")
                out.write(data)
                if on_progress:
                    on_progress(idx, info['n_chunks'])
                if idx % 200 == 0 or idx == info['n_chunks'] - 1:
                    print(f"  chunk {idx + 1}/{info['n_chunks']} verified", end='\r', flush=True)
        elapsed = time.time() - t0
    actual_size = os.path.getsize(out_path)
    print(f"\n{info['n_chunks']} chunks downloaded and verified in {elapsed:.1f}s")
    print("Merkle root over received chunks matches host's advertised sha256: True "
          "(checked before downloading, not after)")
    if actual_size != info['size']:
        os.remove(out_path)
        sys.exit(f"size mismatch: wrote {actual_size:,} bytes, host advertised {info['size']:,} "
                 f"— deleted the output, do not trust this download")
    return out_path


def verify_local_download(content_hash, relay_urls, path):
    """Re-checks an already-downloaded file against its own Merkle-
    committed chunk hashes without re-downloading a single byte: one
    INFO+LEAVES round-trip to a currently-advertising host (to learn
    chunk_size and get the leaf hash list — this repo's protocol has no
    way to fetch just that from the file itself), then a purely local
    read-and-rehash of every chunk already on disk. Same trust chain
    download() uses (Merkle-root the leaves against the host's advertised
    sha256 before trusting anything it says), just pointed at bytes that
    are already local instead of a live FETCH stream."""
    from ott import merkle_root

    hosts = discover_hosts_for(relay_urls, content_hash)
    if not hosts:
        return {'ok': False, 'error': 'no host currently advertising this content_hash on the given relay(s)'}
    match = hosts[0]
    tunnel = _parse_tunnel(match['tunnel']) if match.get('tunnel') else None

    with open_connection(match['host'], tunnel=tunnel, content_hash=content_hash) as conn:
        if content_hash and not tunnel:
            sel = conn.request(f'SELECT {content_hash}')
            if sel != 'OK':
                return {'ok': False, 'error': f"host rejected SELECT: {sel}"}
        info = json.loads(conn.request('INFO'))
        leaves = json.loads(conn.request('LEAVES'))

    if len(leaves) != info['n_chunks'] or merkle_root(leaves) != info['sha256'] \
            or info['sha256'] != content_hash:
        return {'ok': False, 'error': "host's advertised LEAVES don't Merkle-root to this "
                                       "content_hash — refusing to trust it as a reference"}
    if not os.path.isfile(path):
        return {'ok': False, 'error': f'{path} no longer exists on disk'}

    actual_size = os.path.getsize(path)
    if actual_size != info['size']:
        return {'ok': False, 'error': f'local file is {actual_size:,} bytes, host advertises '
                                       f'{info["size"]:,} — refetch with re-download'}

    mismatches = []
    with open(path, 'rb') as f:
        for idx in range(info['n_chunks']):
            data = f.read(info['chunk_size'])
            if hashlib.sha256(data).hexdigest() != leaves[idx]:
                mismatches.append(idx)

    return {'ok': not mismatches, 'n_chunks': info['n_chunks'], 'mismatches': mismatches}


# ── possession challenge + price auction, wired to real discovery ───────
#
# Everything below stitches poc_challenge_auction.py (challenge-gate a
# reverse auction), poc_reputation.py (local trust score), and
# lightning_settle.py (real HTLC settlement) into the real download path —
# none of them were reachable from `download()` before this, which meant
# `discover` -> `download` would silently trust the first host found, for
# free, with zero possession check.
#
# Scoped honestly, not silently: this uses sample-FETCH + Merkle-proof
# verification (poc_challenge_auction.py Part 1's mechanism) to prove a
# host holds real chunks, not the nonce-salted timing challenge from Part
# 2 — that one specifically detects a RELAY masquerading as a holder, but
# needs ground-truth bytes the verifier already trusts, which a first-time
# downloader doesn't have yet (that's the whole point of downloading).
# Sample-verifying a few chunks via FETCH is what a fresh client can
# actually do independently, since LEAVES is already Merkle-root-checked
# against the host's own advertised sha256.

def sample_challenge(conn, leaves, k=3):
    """Fetch k random chunks over the given (already-open) connection and
    verify each against the (already Merkle-verified) leaves list —
    proves *this specific host* truly holds real chunks, not just that
    someone somewhere does."""
    n = len(leaves)
    indices = random.sample(range(n), min(k, n))
    latencies = []
    for idx in indices:
        t0 = time.perf_counter()
        try:
            resp = conn.request(f'FETCH {idx}')
        except OSError:
            return False, latencies
        latencies.append((time.perf_counter() - t0) * 1000)
        if not resp.startswith('DATA '):
            return False, latencies
        data = base64.b64decode(resp[5:])
        if hashlib.sha256(data).hexdigest() != leaves[idx]:
            return False, latencies
    return True, latencies


def get_price(conn):
    try:
        resp = conn.request('PRICE')
    except OSError:
        return 0
    if resp.startswith('PRICE '):
        try:
            return int(resp[6:])
        except ValueError:
            return 0
    return 0  # host doesn't implement PRICE — treat as free rather than failing


def discover_hosts_for(relay_urls, content_hash):
    """Every host that published a matching content_hash — real multi-host
    resolution (discover() dedupes per-signer, not across signers, so
    two different publishers of the same file both show up here)."""
    return [p for p in discover(relay_urls) if p['content_hash'].startswith(content_hash)]


def build_trust_graph(subscribe_events, root_pubkey, max_hops=3, decay=0.5):
    """Transitive trust, computed here instead of adopting PGP's standard
    to get it: BFS outward from root_pubkey through real signed subscribe
    events (each one a real trust edge — 'I subscribe to X' = 'I trust
    X'). Trust decays per hop, same shape as PGP's marginal-vs-full
    distinction (a direct subscribe counts more than a friend-of-a-
    friend), computed on the Ed25519 events already in place rather than
    needing the OpenPGP format at all.

    Takes the *shortest* path to each reachable pubkey (first time BFS
    reaches it), not the sum across every path that reaches it — summing
    would let a sybil ring inflate a target's trust just by adding more
    low-value paths to it, which defeats the point of a hop-decayed graph
    in the first place."""
    edges = {}
    for e in subscribe_events:
        p = e['payload']
        edges.setdefault(p['signer_pubkey'], set()).add(p['target_pubkey'])

    trust = {}
    frontier = [root_pubkey]
    seen = {root_pubkey}
    hop = 0
    while frontier and hop < max_hops:
        hop += 1
        weight = decay ** hop
        next_frontier = []
        for node in frontier:
            for target in edges.get(node, ()):
                if target not in seen:
                    seen.add(target)
                    trust[target] = weight
                    next_frontier.append(target)
        frontier = next_frontier
    return trust


def select_host(candidates, k=3, reputation=None, trust_in_signers=None):
    """Gate on real possession, then rank survivors by reputation then
    price — same 'challenge gates the auction' shape as
    poc_challenge_auction.py's naive-vs-gated comparison. trust_in_signers
    (from build_trust_graph) lets a candidate with zero *direct* history
    still score above 0 if someone in the caller's transitive trust graph
    has attested to it."""
    from ott import merkle_root

    scored = []
    for c in candidates:
        tunnel = _parse_tunnel(c.get('tunnel'))
        try:
            with open_connection(c['host'], tunnel=tunnel, content_hash=c['content_hash']) as conn:
                if not tunnel:
                    sel = conn.request(f"SELECT {c['content_hash']}")
                    if sel != 'OK':
                        print(f"  x {c['host']}: SELECT rejected ({sel}) — skipping")
                        continue
                leaves = json.loads(conn.request('LEAVES'))
                info = json.loads(conn.request('INFO'))
                if merkle_root(leaves) != info['sha256'] or info['sha256'] != c['content_hash']:
                    print(f"  x {c['host']}: advertised content doesn't match its own LEAVES/INFO — skipping")
                    continue
                passed, latencies = sample_challenge(conn, leaves, k=k)
                if not passed:
                    print(f"  x {c['host']}: failed possession challenge ({k} chunks sampled) — skipping")
                    continue
                price = get_price(conn)
        except (OSError, ValueError, KeyError) as e:
            # ValueError also catches json.JSONDecodeError: a tunnel CONNECT
            # paired with a dead/gone registration (or any host that closes
            # mid-protocol) reads back '' instead of raising a socket error,
            # and a malformed INFO dict raises KeyError on ['sha256'] above —
            # either way this is one bad candidate, not a reason to abort the
            # whole auction.
            print(f"  x {c['host']}: unreachable ({type(e).__name__}: {e})")
            continue
        rep_score, rep_why = (reputation.trust_score(c['signer_pubkey'], trust_in_signers)
                               if reputation else (0.5, 'no reputation store'))
        avg_latency = sum(latencies) / len(latencies) if latencies else 0.0
        print(f"  + {c['host']}: possession verified ({k}/{k} chunks), price={price} sat, "
              f"reputation={rep_score:.2f} ({rep_why}), avg_latency={avg_latency:.1f}ms")
        scored.append({'candidate': c, 'info': info, 'price': price,
                        'reputation': rep_score, 'avg_latency_ms': avg_latency})

    if not scored:
        return None
    scored.sort(key=lambda s: (-s['reputation'], s['price']))  # highest trust first, then cheapest
    return scored[0]


def fetch_verified(relay_urls, event_type):
    """Fetch+verify every event of a type across relays, deduped by event
    id — same merge pattern discover() uses, generalized so subscribe/
    attestation gossip go through the same real signature-checking path."""
    seen = {}
    for relay_url in relay_urls:
        events = fetch_events(relay_url, event_type)
        if events is None:
            continue
        for e in events:
            ok, _ = verify_attestation(e)
            if ok:
                seen[attestation_id(e)] = e
    return list(seen.values())


def download_with_auction(content_hash, relay_urls, out_path=None, k=3, use_lightning=False,
                           lightning_node=None, trust_hops=3, trust_decay=0.5, on_progress=None):
    """The real end-to-end path: resolve every host claiming to have this
    content, challenge-gate them, auction among survivors — weighted by
    reputation built from real transitive trust (your own subscribes, plus
    your subscribes' subscribes, decayed per hop) and real attestations
    gossiped from relays, not just your own direct history — optionally
    pay the winner over a real Lightning HTLC, download, record the
    outcome locally AND publish it so others can benefit transitively too."""
    from poc_reputation import ReputationStore

    identity = load_or_create_identity()
    candidates = discover_hosts_for(relay_urls, content_hash)
    if not candidates:
        sys.exit(f"no hosts found publishing content matching {content_hash}")
    print(f"found {len(candidates)} candidate host(s) for {content_hash[:16]}...")

    subscribe_events = fetch_verified(relay_urls, 'subscribe')
    trust_graph = build_trust_graph(subscribe_events, identity.pubkey_hex(),
                                     max_hops=trust_hops, decay=trust_decay)
    print(f"trust graph: {len(trust_graph)} pubkey(s) reachable within {trust_hops} hop(s) "
          f"of your own subscribes")

    reputation = ReputationStore(os.path.expanduser('~/.weed_reputation.json'))
    attestation_events = fetch_verified(relay_urls, 'attestation')
    added = 0
    for e in attestation_events:
        ok, _ = reputation.add_attestation(e)
        added += ok
    if attestation_events:
        print(f"pulled {added}/{len(attestation_events)} real attestation(s) from relays "
              f"(others' vouches, weighted by your trust in whoever signed them)")

    winner = select_host(candidates, k=k, reputation=reputation, trust_in_signers=trust_graph)
    if winner is None:
        sys.exit("no candidate host passed the possession challenge — "
                 "refusing to download from an unverified source")

    c = winner['candidate']
    print(f"selected {c['host']} — price {winner['price']} sat, "
          f"reputation {winner['reputation']:.2f}, {winner['avg_latency_ms']:.1f}ms avg")

    if winner['price'] > 0 and not use_lightning:
        print(f"  price is {winner['price']} sat but --lightning not given "
              f"— downloading anyway, unpaid (no enforcement in this demo)")

    # payment (if any) happens inside download() itself, over the same
    # session that then serves the bytes — see its own docstring for why:
    # this host's own INVOICE, paid by lightning_node, not a fixed demo
    # pair settled regardless of who actually won the auction
    path = download(c['host'], out_path or c['title'], tunnel=_parse_tunnel(c.get('tunnel')),
                     content_hash=c['content_hash'], on_progress=on_progress,
                     price=winner['price'], use_lightning=use_lightning, lightning_node=lightning_node)

    reputation.record_direct(c['signer_pubkey'], passes=1, fails=0,
                              avg_latency_ms=winner['avg_latency_ms'])
    reputation.save()
    print(f"recorded this download in local reputation store "
          f"(~/.weed_reputation.json) for {c['signer_pubkey'][:12]}...")

    attestation = identity.sign_event('attestation', peer_pubkey=c['signer_pubkey'],
                                       passes=1, fails=0, avg_latency_ms=winner['avg_latency_ms'], k=k)
    for relay_url in relay_urls:
        post_event(relay_url, attestation)
    print(f"published this outcome as a real attestation — anyone who trusts you "
          f"(directly or transitively) now benefits from it too, without dealing with "
          f"{c['signer_pubkey'][:12]}... themselves first")
    return path


# ── discovery + social signals ──────────────────────────────────────────

def _relay_url_hint(relay_url):
    """Relays are plain HTTP(S) endpoints, hit via urllib -- tls:// is a
    completely different, unrelated convention that only means something
    to --tunnel (a hand-rolled raw-TCP-plus-TLS protocol, see
    _connect_tunnel_socket/connect_via_tunnel). Easy to mix up since both
    flags take a host:port-shaped value and this same tool uses tls://
    for the other one; without this check the failure is just urllib's
    raw 'unknown url type: tls' with no hint about why."""
    if relay_url.startswith('tls://'):
        return (f"{relay_url!r} looks like a --tunnel address, not a relay URL — "
                f"relays are plain HTTP(S) endpoints, try "
                f"'https://{relay_url[len('tls://'):]}' for --relay instead "
                f"(tls:// only means something to --tunnel)")
    return None


def _normalize_relay_url(relay_url):
    """A bare host:port with no scheme (e.g. '127.0.0.1:9101', the most
    natural way to type a local relay) isn't a URL urllib can parse at
    all -- everything before the first ':' becomes the *scheme*, so this
    reads as scheme '127.0.0.1' and raises "unknown url type", not a
    connection error. That already lands on post_event/fetch_events'
    existing except clauses (an unreachable relay is routine, not
    exceptional), which is exactly the trap: hosting against a
    scheme-less relay used to report status: running with zero actual
    announcements ever reaching it, and discover against one silently
    came back empty -- nothing hinted that the URL itself, not the
    relay, was the problem. Every relay this project actually ships or
    documents is plain HTTP(S), so defaulting a missing scheme to
    http:// turns the common typo into the thing the user obviously
    meant instead of a silent no-op."""
    if '://' not in relay_url:
        return 'http://' + relay_url
    return relay_url


_dns_bound_pool = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix='urlopen')


def _urlopen_bounded(req_or_url, timeout=5):
    """urlopen's own timeout= only bounds the connect/read phases — the
    getaddrinfo() call underneath (DNS resolution) is a blocking libc call
    with no timeout of its own, so a relay hostname that's slow or
    unreachable to resolve can hang here indefinitely no matter what
    timeout= says. That's exactly the situation right after a container
    boots and its network/DNS isn't fully settled yet: _resume_persisted_hosts
    (web_ui.py) resuming a host at that moment used to get stuck at
    "(starting…)" forever, since nothing downstream ever times out either.
    Running the call in a worker thread and bounding *that* with
    .result(timeout=) catches DNS hangs the same as connect/read hangs —
    the stuck worker thread leaks (a blocking C call can't be cancelled),
    but it's a daemon-pool thread and this process was going to give up and
    move on regardless."""
    future = _dns_bound_pool.submit(urllib.request.urlopen, req_or_url, timeout=timeout)
    return future.result(timeout=timeout + 1)


def post_event(relay_url, event):
    hint = _relay_url_hint(relay_url)
    if hint:
        return {'ok': False, 'error': hint}
    relay_url = _normalize_relay_url(relay_url)
    req = urllib.request.Request(
        f'{relay_url}/event', data=json.dumps(event).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with _urlopen_bounded(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
    except (urllib.error.URLError, ConnectionRefusedError, concurrent.futures.TimeoutError) as e:
        # download_with_auction posts the post-download attestation to every
        # relay in relay_urls, which by default includes 127.0.0.1:9101
        # whether or not anything is actually listening there (same default
        # fetch_events already tolerates) — an unreachable relay here used to
        # take down the whole download with an uncaught traceback *after* the
        # file was already correctly written and reputation already recorded
        return {'ok': False, 'error': str(e)}


def fetch_events(relay_url, event_type=None):
    hint = _relay_url_hint(relay_url)
    if hint:
        print(f"  {relay_url}: {hint}")
        return None
    relay_url = _normalize_relay_url(relay_url)
    url = f'{relay_url}/events' + (f'?type={event_type}' if event_type else '')
    try:
        with _urlopen_bounded(url, timeout=5) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, ConnectionRefusedError, concurrent.futures.TimeoutError):
        return None


def ott_commit_status(archive_dir):
    """Real Bitcoin-commitment status for archive_dir's .ott/ store, read
    straight from its ledger — the same data `ott status`/`ott log` show
    on the CLI. Embedded in publish() events (see below) so a downloader
    browsing Discover can see "has this actually been recorded to
    Bitcoin, and when" straight from the gossiped event, without
    connecting to the host at all — a live per-host query would mean a
    full CONNECT/NEWSTREAM/DATA round trip per row just to check this,
    for hosts behind a tunnel. Cheap and fully local: just reads
    ledger.jsonl + recomputes the current merkle root, no network call
    (confirming the recorded block hash still matches a live block
    explorer is `ott verify-chain --check-txs`'s job, not this). None on
    any error (btcvm not installed, no .ott/ yet, archive_dir doesn't
    exist) rather than blocking publish over a host that simply hasn't
    committed anything yet."""
    try:
        from ott import OttStore
        expanded = os.path.expanduser(archive_dir)
        store = OttStore(os.path.join(expanded, '.ott'))
        ledger = store.load_ledger()
        if not ledger:
            return {'committed': False}
        last = ledger[-1]
        return {
            'committed': last.get('merkle_root') == store.current_root(),
            'block_height': last.get('block_height'),
            'ts': last.get('ts'),
            'tx_hash': last.get('tx_hash'),
            'network': last.get('network', 'mainnet'),
        }
    except Exception:
        return None


def publish(identity, relay_url, content_hash, title, host_addr, tunnel=None, ott_status=None):
    """tunnel, if given, is 'relay_host:relay_port' for a tunnel_relay.py
    instance this host registered with — additive and backward compatible,
    same as the optional PRICE wire verb: an event without it just means
    'connect directly to host_addr', same as before this field existed.
    ott_status (see ott_commit_status) is the same kind of additive,
    optional field — an event without it just means the discovering
    client doesn't get a BTC-commit answer for that listing, same as
    before this existed."""
    event = identity.sign_event('publish', content_hash=content_hash, title=title,
                                 host=host_addr, tunnel=tunnel, ott_status=ott_status)
    return post_event(relay_url, event)


def unpublish(identity, relay_url, content_hash):
    """Signs this signer's own delisting of content_hash — see discover()'s
    handling: whichever event (publish or unpublish) is newest for a given
    (content_hash, signer_pubkey) wins, so this only takes effect if it's
    genuinely the latest word from this signer. Lets a host that's
    shutting down gracefully (see web_ui.py's SIGTERM handler) remove
    itself from discover results immediately, instead of leaving a
    stale, now-unreachable entry sitting around until a relay's per-signer
    cap happens to evict it. Doesn't affect a *different* signer's own
    publish for the same content_hash — this is scoped to this signer's
    own listing only, same as everything else keyed off signer_pubkey."""
    event = identity.sign_event('unpublish', content_hash=content_hash)
    return post_event(relay_url, event)


def discover(relay_urls):
    """Deduped by (content_hash, signer_pubkey), keeping whichever event has
    the newest ts — not by attestation_id (a hash of the whole signed
    payload, ts included), which made every re-announcement of the same
    file a "new" event forever, since re-running `host` always signs a
    fresh ts. Keyed on the pair rather than content_hash alone so two
    different signers hosting the same file still both show up (see
    discover_hosts_for) — only a single signer's own repeat
    announcements collapse.

    Also fetches 'unpublish' events over the same relays and lets them win
    the same newest-ts comparison — a signer's most recent word on a given
    (content_hash, signer_pubkey) pair might be "I've stopped hosting
    this," not another publish, and honoring that is what makes
    unpublish() actually delist something instead of just adding more
    unread noise to the relay."""
    seen = {}
    unreachable_relays = set()
    for relay_url in relay_urls:
        for event_type in ('publish', 'unpublish'):
            events = fetch_events(relay_url, event_type)
            if events is None:
                unreachable_relays.add(relay_url)
                continue
            for e in events:
                ok, _ = verify_attestation(e)
                if not ok:
                    continue
                payload = e['payload']
                key = (payload['content_hash'], payload['signer_pubkey'])
                existing = seen.get(key)
                if existing is None or payload['ts'] > existing['ts']:
                    seen[key] = payload
    for relay_url in unreachable_relays:
        print(f"  {relay_url}: unreachable, skipped")
    return [p for p in seen.values() if p['type'] == 'publish']


def group_discover_by_content(results):
    """Collapse discover()'s one-row-per-publisher output to one row per
    content_hash, for display only — real host resolution
    (discover_hosts_for, the auction) still needs every distinct publisher
    separate, since two different people hosting the same file is real,
    useful redundancy, not noise. But a person scanning a list doesn't
    want to see the identical title N times just because N different
    signers happen to host it — that's the actual complaint this fixes,
    distinct from discover()'s own per-signer re-announcement dedup.
    Keeps the most recently announced publisher's fields as the
    representative row, plus host_count/hosts so a UI can still surface
    "N hosts" instead of hiding the redundancy entirely."""
    by_hash = {}
    for r in results:
        by_hash.setdefault(r['content_hash'], []).append(r)
    merged = []
    for content_hash, group in by_hash.items():
        group.sort(key=lambda r: r['ts'], reverse=True)
        rep = dict(group[0])
        rep['host_count'] = len(group)
        rep['hosts'] = [g['host'] for g in group]
        merged.append(rep)
    return merged
