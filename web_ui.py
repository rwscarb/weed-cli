#!/usr/bin/env python3
"""
Local control UI for weed: a small stdlib JSON API (same tool
discovery_relay.py already uses — ThreadingHTTPServer, no new dependency)
plus a static frontend (web/), so hosting/discovering/downloading/
liking/subscribing don't require memorizing weed.py's CLI flags. Every
endpoint is a thin wrapper over the real node.py functions the CLI
already calls — no reimplementation of any protocol logic.

Binds 127.0.0.1 by default on purpose — this is a *local* control
surface, not something meant to face the internet, and there's no auth
built (same "reachability is on you" honesty --advertise-host's docs
already apply elsewhere in this repo). Pass --bind to expose it on a LAN
at your own risk.
"""
import contextlib
import hashlib
import io
import json
import mimetypes
import os
import signal
import socket
import ssl
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import node

try:
    import qrcode  # pip install qrcode -- same package ott.py's own `ott qr` already uses
    _HAS_QR = True
except ImportError:
    _HAS_QR = False

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
# same $WEED_RELAY/$WEED_TUNNEL convention weed.py's CLI subcommands and
# shell.py's WeedShell already read (see weed.py's _default_relay) --
# without this, running web_ui.py directly ignored them entirely and
# silently fell back to the loopback default, even with a real relay
# configured for every other way of running this tool
DEFAULT_RELAY = os.environ.get('WEED_RELAY', 'http://127.0.0.1:9101')
DEFAULT_TUNNEL = os.environ.get('WEED_TUNNEL')
LIBRARY_PATH = os.path.expanduser('~/.weed_library.json')
# play history is a log, not a set -- it grows forever otherwise (every
# playlist "next" and every re-watch appends). This caps ~/.weed_library.json
# from growing unbounded while still keeping far more history than anyone
# is realistically going to scroll back through.
MAX_HISTORY = 500
# every real POST body here is a handful of JSON fields (hashes, URLs,
# titles) -- no endpoint ever legitimately needs anywhere near this much,
# it's purely a cap against a client claiming a huge Content-Length and
# making the server read an unbounded amount into memory
MAX_BODY_SIZE = 1024 * 1024

# script-relative, not CWD-relative -- same reasoning as WEB_DIR above, so
# downloads land in the same place regardless of the directory this was
# launched from (previously defaulted to a bare filename, which meant
# download_<hash> files scattered directly into whatever the CWD happened
# to be when web_ui.py was started)
DOWNLOADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'downloads')
os.makedirs(DOWNLOADS_DIR, exist_ok=True)


class _JobStdout:
    """Replaces sys.stdout for this whole process so a background job
    thread (host/download) can be muted without touching a single print()
    in node.py -- those are correct and wanted when the same functions
    run from weed.py or the interactive shell, where a human is actually
    watching the terminal. They're just noise here: nothing reads this
    process's stdout, and a job's real status already goes through
    _jobs[job_id]/_hosts[host_id], which the API/frontend actually poll.

    Routes by the *calling* thread, not a single global swap -- a
    threading.local() flag, so two jobs running concurrently in different
    threads (or a job running while the main thread prints its own
    [web:PORT] startup line) can't clobber each other's output."""

    def __init__(self, real):
        self._real = real
        self._local = threading.local()

    def write(self, s):
        buf = getattr(self._local, 'buf', None)
        (buf if buf is not None else self._real).write(s)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


_job_stdout = _JobStdout(sys.stdout)
sys.stdout = _job_stdout


@contextlib.contextmanager
def _quiet():
    """Mute node.py's CLI-oriented prints for the current thread only, for
    the duration of the with-block -- yields the buffer they went into, so
    a caller that hits an error can fold the captured detail into it
    instead of only ever surfacing the final exception's one-line summary.
    That gap was real: select_host's per-candidate "x <host>: unreachable
    (...)" lines (exactly the detail that explains *why* a download
    failed) used to get captured here and then thrown away unread, so the
    web UI only ever showed "no candidate host passed the possession
    challenge" with zero indication of which candidate failed how.

    Re-asserts sys.stdout = _job_stdout on every call rather than trusting
    it's still set from module-import time, and manipulates _job_stdout
    directly rather than via sys.stdout -- something else with its own
    reason to reassign sys.stdout globally afterward (pytest's own output
    capturing is the concrete case that surfaced this: it swaps sys.stdout
    to its own capture object between tests, silently detaching
    _JobStdout from the global) would otherwise make this line crash with
    an AttributeError on whatever replaced it, instead of muting output
    like it's supposed to. Nothing in this app's own normal run path ever
    reassigns sys.stdout again after the module-level line above, so this
    is a no-op there -- purely a defensive re-assert."""
    if sys.stdout is not _job_stdout:
        sys.stdout = _job_stdout
    buf = io.StringIO()
    _job_stdout._local.buf = buf
    try:
        yield buf
    finally:
        _job_stdout._local.buf = None


def _with_captured_detail(msg, captured):
    detail = captured.getvalue().strip()
    return f'{msg}\n{detail}' if detail else msg

_hosts = {}   # host_id -> dict describing an actively-hosted file
_jobs = {}    # job_id -> dict describing a download's progress/result
_job_logs = {}   # job_id -> the live io.StringIO node.py's prints are captured into (see _quiet)
_host_logs = {}  # host_id -> same, for a host job (announce progress, [host:PORT] serving, ...)
_lock = threading.Lock()

# what's been downloaded/liked/subscribed, persisted to disk so a page
# reload -- or a server restart -- doesn't forget any of it. Downloads
# are keyed by content_hash (one record per piece of content, most
# recent job wins); likes/subscriptions are just lists of hashes/pubkeys.
# playlists are purely local organization -- unlike likes/subscriptions
# they're never signed or gossiped to a relay, nobody else has any
# business seeing how you've grouped your own downloads -- a list of
# {id, name, items: [{content_hash, title, signer_pubkey}, ...]}, id
# stable across renames so the UI can keep pointing at the same playlist
# while its name changes underneath it. history is a chronological log of
# plays (newest last), each {content_hash, title, played_at} -- separate
# from downloads' own play_count/last_played (see _handle_play) since
# those two are aggregates per content_hash, while this is the actual
# per-play timeline. All access goes through _lock, same as _hosts/_jobs.
_library = {'downloads': {}, 'likes': [], 'subscriptions': [], 'playlists': [], 'history': []}

# what to (re-)host on startup -- _hosts above is pure in-memory runtime
# state, so a restart (a fresh `make node`, a Docker container recreated
# after `make node-down`) used to forget every active host entirely,
# requiring the Host form to be manually re-submitted for each file every
# single time. Keyed by (archive_dir, file_name, port) so resubmitting
# the same host from the UI updates its entry instead of piling up
# duplicates across restarts.
HOSTS_PATH = os.path.expanduser('~/.weed_hosts.json')
_persisted_hosts = {}


def _load_persisted_hosts():
    global _persisted_hosts
    try:
        with open(HOSTS_PATH) as f:
            _persisted_hosts = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def _save_persisted_hosts():
    tmp = HOSTS_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(_persisted_hosts, f)
    os.replace(tmp, HOSTS_PATH)


def _default_upload_archive_dir():
    """/share only exists as a real directory when running inside the
    Docker image built from Dockerfile.node -- docker-compose.node.yml
    bind-mounts the host's archive there, and its own comments tell the
    user to type /share into this exact form field. Defaulting an
    omitted archive_dir to the relative './share' instead would land an
    upload in this process's cwd (/app inside that container), a
    directory nobody else is looking at: the file would archive fine,
    but every subsequent /api/host call against the /share the user
    actually typed would report "no archived file found", with no
    restart able to fix it since the file was never in /share to begin
    with. Outside Docker, /share won't exist and this falls back to
    './share', matching docker-compose.node.yml's own default bind-mount
    source on the host side."""
    return '/share' if os.path.isdir('/share') else './share'


def _remember_host(archive_dir, file_name, port, price, relay_urls, advertise_host, tunnel, ln_node):
    key = f'{archive_dir}|{file_name}|{port}'
    _persisted_hosts[key] = {
        'archive_dir': archive_dir, 'file_name': file_name, 'port': port, 'price': price,
        'relay': relay_urls, 'advertise_host': advertise_host, 'tunnel': tunnel,
        'lightning_node': ln_node,
    }
    _save_persisted_hosts()


def _forget_persisted_host(archive_dir, file_name, port):
    """The other half of _remember_host -- nothing previously called this
    at all, so every host ever started (including ones from an old test,
    a since-deleted file, or an archive_dir that predates a since-changed
    default) stayed in ~/.weed_hosts.json and got retried, forever, on
    every single startup. Real report: a real user saw two permanently-
    broken "(starting…)" rows with 'no .ott/manifest.jsonl in ./share'
    errors on every restart with no way to make them stop coming back."""
    key = f'{archive_dir}|{file_name}|{port}'
    if key in _persisted_hosts:
        del _persisted_hosts[key]
        _save_persisted_hosts()
        return True
    return False


def _is_permanently_broken_host_error(message):
    """True for the flavors of host-start failure that a restart (or a
    retry with the exact same config) can never fix -- the manifest or
    the specific file just isn't there. Deliberately narrow: something
    like 'Address already in use' is routine (two configs sharing the
    default port 9201, or this file legitimately already being hosted)
    and retrying later, or once the conflicting host stops, can succeed
    -- pruning on that would silently forget a perfectly good config."""
    return ('no .ott/manifest.jsonl in' in message
            or 'no archived file found in' in message
            or 'archived file not found on disk at' in message)


def _start_host_job(archive_dir, file_name, port, price, relay_urls, advertise_host, tunnel, ln_node):
    host_id = uuid.uuid4().hex[:12]
    # _stop_event is how _handle_forget_host actually stops an
    # already-bound host (see node.run_host_server's own docstring) --
    # stashed on _hosts[host_id] as soon as it exists so a forget/stop
    # request racing against this job's own startup can still reach it.
    # _sock is added later, once _run_host_job actually binds it (there's
    # nothing to close before then). Both are underscore-prefixed so
    # /api/hosts strips them before JSON-serializing this dict -- a live
    # socket object isn't serializable at all, and stop_event has no
    # business being client-visible either.
    stop_event = threading.Event()
    thread = threading.Thread(target=_run_host_job,
                               args=(host_id, archive_dir, file_name, port, price, relay_urls,
                                     advertise_host, tunnel),
                               kwargs={'ln_node': ln_node, 'stop_event': stop_event}, daemon=True)
    with _lock:
        # file_name kept here (not just passed to the thread below) so a
        # host that ends in 'error' -- before ever reaching the
        # files=[...] update on success -- still has enough on _hosts[id]
        # to rebuild its _persisted_hosts key later (see
        # _forget_persisted_host / _resume_persisted_hosts' auto-prune).
        # _thread is join()'d by _handle_forget_host after closing _sock,
        # so it can confirm the port is actually free again (closing a
        # socket another thread is blocked in accept() on doesn't
        # necessarily release the port instantaneously from the OS's
        # point of view -- see that function's own comment) before
        # telling the client "stopped: true".
        _hosts[host_id] = {'id': host_id, 'archive_dir': archive_dir, 'port': port,
                            'file_name': file_name, 'price': price, 'tunnel': tunnel,
                            'status': 'starting', '_stop_event': stop_event, '_thread': thread}
    thread.start()
    return host_id


def _ott_status(archive_dir):
    """Thin wrapper over node.ott_commit_status -- kept here as the name
    the Hosts tab's own live re-read (current state, not a publish-time
    snapshot) already calls; see node.py for the actual implementation,
    shared with the ott_status now embedded in every publish() event for
    Discover's benefit."""
    return node.ott_commit_status(archive_dir)


def _resume_persisted_hosts():
    """Sequential on purpose, not fire-and-forget-them-all-at-once: two
    persisted configs sharing a port (the default in the Host form is
    always 9201, so this is the common case, not an edge case) could
    both bind successfully if started concurrently, since node.bind_host_port
    for the second one wouldn't even run until the first's already had time
    to occupy the port — but nothing serializes *when* each thread gets
    there. Waiting for each host to reach 'bound' (or 'error', if the bind
    itself failed) before starting the next one closes that window: by the
    time the next one binds, the previous one already has the port or
    already knows it can't.

    Only waits for the bind, not all the way to 'running' — 'running'
    doesn't happen until after each host's full publish loop (real network
    I/O, up to 5s timeout per relay), which several persisted hosts
    resuming in sequence have no reason to serialize on. That was a real
    regression the first version of this function had: booting with a
    handful of persisted hosts got noticeably slower, for zero extra
    correctness, since the publish delay doesn't affect port ownership at
    all."""
    broken_keys = []
    for key, cfg in list(_persisted_hosts.items()):
        host_id = _start_host_job(cfg['archive_dir'], cfg['file_name'], cfg['port'], cfg['price'],
                                   cfg['relay'], cfg['advertise_host'], cfg['tunnel'],
                                   cfg.get('lightning_node'))
        for _ in range(100):  # up to ~10s per host before moving on regardless
            with _lock:
                status = _hosts[host_id]['status']
            if status in ('bound', 'running', 'error'):
                break
            time.sleep(0.1)
        with _lock:
            h = _hosts[host_id]
        # a manifest/file that's gone isn't coming back next startup
        # either -- prune it now instead of leaving the same red error to
        # reappear, unexplained, every time the app starts (see
        # _is_permanently_broken_host_error's own docstring for the real
        # report this closes).
        if h['status'] == 'error' and _is_permanently_broken_host_error(h.get('error') or ''):
            broken_keys.append(key)
    if broken_keys:
        for key in broken_keys:
            _persisted_hosts.pop(key, None)
        _save_persisted_hosts()


def _unpublish_all_hosts():
    """Best-effort delisting on graceful shutdown (see the SIGTERM handler
    in run_web_ui) -- doesn't touch _persisted_hosts, since the whole
    point is that a *future* restart still auto-resumes the same hosts;
    this only tells relays "not reachable right now" in the meantime,
    same as unpublish()'s own docstring."""
    identity = _identity()
    with _lock:
        hosts_snapshot = list(_hosts.values())
    for h in hosts_snapshot:
        for f in h.get('files') or []:
            for relay_url in h.get('announced_on') or []:
                try:
                    node.unpublish(identity, relay_url, f['content_hash'])
                except Exception:
                    pass


def _load_library():
    global _library
    try:
        with open(LIBRARY_PATH) as f:
            data = json.load(f)
        _library = {
            'downloads': data.get('downloads') or {},
            'likes': data.get('likes') or [],
            'subscriptions': data.get('subscriptions') or [],
            'playlists': data.get('playlists') or [],
            'history': data.get('history') or [],
        }
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def _save_library():
    """Caller must hold _lock. Written to a tmp file + os.replace so a
    crash mid-write can't leave a half-written, unparseable JSON file
    behind -- this runs on every like/subscribe/download-finish, not just
    at shutdown."""
    tmp = LIBRARY_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(_library, f)
    os.replace(tmp, LIBRARY_PATH)


def _rehydrate_jobs_from_library():
    """Lets a restarted server's Downloads tab and Discover "already
    downloaded" check keep working against the same job_ids as before --
    _jobs is otherwise purely in-memory and would forget every finished
    download on restart even though the files (and _library) are still
    there."""
    for content_hash, rec in _library['downloads'].items():
        _jobs[rec['job_id']] = {
            'status': 'done', 'idx': 0, 'n_chunks': None,
            'content_hash': content_hash, 'path': rec['path'],
            'title': rec.get('title'), 'size': rec.get('size'), 'bps': rec.get('bps'),
            'signer_pubkey': rec.get('signer_pubkey'), 'error': None,
        }
_lan_url = None   # set once in run_web_ui() -- the base URL a phone on the
                   # same LAN can actually reach this server at, or None if
                   # it can't (bound to 127.0.0.1). The client can't compute
                   # this itself: window.location.origin only reflects
                   # whatever address the *desktop* browser used to load the
                   # page, which is 127.0.0.1 the moment someone opens it via
                   # localhost -- exactly the bug this fixes.


def _identity():
    return node.load_or_create_identity()


def _as_list(value, default):
    if not value:
        return default
    return [value] if isinstance(value, str) else list(value)


def _detect_lan_ip():
    """Best-effort outbound-facing LAN IP. UDP connect() here never sends a
    packet -- it just makes the kernel pick a route -- but that's enough to
    read back the interface address that route would use. Needed because
    a startup/QR URL naming the literal 0.0.0.0 wildcard bind address is
    useless: nothing can connect *to* 0.0.0.0 from another device."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _run_host_job(host_id, archive_dir, file_name, port, price, relay_urls, advertise_host, tunnel,
                   ln_node=None, stop_event=None):
    captured = io.StringIO()
    try:
        with _quiet() as captured:
            _host_logs[host_id] = captured
            identity = _identity()
            # every distinct file in the archive, not just the last-added one
            # — see load_manifest_entries' own docstring for why
            # find_manifest_entry (singular) silently dropped every file but
            # one out of a multi-file archive_dir, same bug shell.py's
            # do_host already had fixed
            entries = node.load_manifest_entries(archive_dir, file_name)
            # fail fast, before announcing anything — a manifest entry with no
            # matching chunk data would otherwise get announced to the relay
            # and only fail later, deep in a background thread with no way
            # for the UI to ever find out
            all_leaves = {e['sha256']: node.load_leaves(archive_dir, e['sha256']) for e in entries}
            # forgotten/stopped before we ever got this far (e.g. clicked
            # right after "Start hosting" on a config that was a mistake)
            # -- no point binding a port just to immediately release it
            if stop_event is not None and stop_event.is_set():
                return
            # bind the real, permanent listening socket now — before
            # announcing anything — and hand it to run_host_server below
            # instead of it binding a second one later. A separate
            # bind-then-close probe here, followed by a *later* real bind,
            # isn't atomic across two hosts starting concurrently (see
            # _resume_persisted_hosts): both could pass the probe before
            # either did the real bind. One bind, kept alive and reused,
            # has no such window — the port either really is free right
            # now or this raises immediately, before any publish.
            bound_sock = node.bind_host_port(port)
            with _lock:
                # forgotten in the narrow window between the stop_event
                # check above and acquiring this lock -- _hosts[host_id]
                # is already gone (see _handle_forget_host), so there's
                # no one left to update and this bound socket would
                # otherwise sit there forever, unreachable and un-closable.
                if host_id not in _hosts:
                    bound_sock.close()
                    return
                # a distinct status the instant the bind (the only part
                # _resume_persisted_hosts actually needs to wait for) is
                # done — 'running' doesn't happen until after the publish
                # loop below, which is real network I/O (up to 5s timeout
                # *per* relay, see post_event) that resuming several
                # hosts sequentially has no reason to serialize on. _sock
                # stashed here too -- see _start_host_job's own comment
                # on why, and _handle_forget_host for the other end of it.
                _hosts[host_id].update(status='bound', _sock=bound_sock)
            ott_status = node.ott_commit_status(archive_dir)
            announced = []
            for entry in entries:
                for relay_url in relay_urls:
                    host_addr = f'{advertise_host}:{port}'
                    result = node.publish(identity, relay_url, entry['sha256'], entry['name'], host_addr,
                                           tunnel=tunnel, ott_status=ott_status)
                    # publish()/post_event() report a failed announce as a
                    # normal {'ok': False, ...} return, not an exception (an
                    # unreachable or malformed relay is routine, not
                    # exceptional -- see post_event's own docstring) -- which
                    # this loop used to just ignore entirely, so a host could
                    # sit at status: running, "announced" on a relay it never
                    # actually reached, with nothing in the UI to say so.
                    # do_host (shell.py) already prints every result
                    # unconditionally; this only prints the failures; a
                    # working host's log staying free of routine "ok: True"
                    # noise matters more here than in a CLI's own scrollback.
                    if isinstance(result, dict) and not result.get('ok', True):
                        print(f'  ✗ announce to {relay_url} failed: {result.get("error")}')
                announced = relay_urls
            files = [{'name': e['name'], 'content_hash': e['sha256']} for e in entries]
            with _lock:
                _hosts[host_id].update(files=files, name=files[0]['name'],
                                        content_hash=files[0]['content_hash'],
                                        announced_on=announced, status='running')
            if tunnel:
                # one control connection per file, each registered under its
                # own content hash — see shell.py do_host's docstring
                relay_host, relay_port, use_tls = node._parse_tunnel(tunnel)
                expanded_dir = os.path.expanduser(archive_dir)
                for entry in entries:
                    file_path = node.resolve_file_path(entry, expanded_dir)
                    threading.Thread(target=node.run_host_tunnel,
                                      args=(relay_host, relay_port, entry['sha256'], entry,
                                            all_leaves[entry['sha256']], file_path, price),
                                      kwargs={'use_tls': use_tls, 'quiet': True, 'ln_node': ln_node},
                                      daemon=True).start()
            node.run_host_server(archive_dir, file_name, port, quiet=True, price=price, ln_node=ln_node,
                                  sock=bound_sock, stop_event=stop_event)
    except SystemExit as e:
        # host_id can already be gone here if this job was forgotten/
        # stopped mid-flight (see _handle_forget_host) -- run_host_server
        # itself returns cleanly on a deliberate stop (see its own
        # docstring), but a SystemExit from elsewhere in this block
        # racing against that removal shouldn't crash trying to update an
        # entry nobody's watching anymore.
        with _lock:
            if host_id in _hosts:
                _hosts[host_id].update(status='error', error=_with_captured_detail(str(e), captured))
    except Exception as e:
        with _lock:
            if host_id in _hosts:
                _hosts[host_id].update(status='error',
                                        error=_with_captured_detail(f'{type(e).__name__}: {e}', captured))


def _run_download_job(job_id, content_hash, relay_urls, out_path, k, use_lightning, title=None,
                       signer_pubkey=None, lightning_node=None):
    def on_progress(idx, n_chunks):
        with _lock:
            _jobs[job_id].update(idx=idx, n_chunks=n_chunks)

    captured = io.StringIO()
    try:
        t0 = time.time()
        with _quiet() as captured:
            # registered as soon as it's the real live buffer (not the
            # placeholder above) so /api/download/<job_id> can read
            # node.py's real prints as they happen, not just after the
            # job finishes — see the GET handler's use of _job_logs
            _job_logs[job_id] = captured
            path = node.download_with_auction(content_hash, relay_urls, out_path=out_path, k=k,
                                               use_lightning=use_lightning, lightning_node=lightning_node,
                                               on_progress=on_progress)
        elapsed = time.time() - t0
        size = os.path.getsize(path)
        bps = size / elapsed if elapsed > 0 else None
        with _lock:
            _jobs[job_id].update(status='done', path=path, size=size, bps=bps)
            _library['downloads'][content_hash] = {
                'content_hash': content_hash, 'job_id': job_id, 'path': path,
                'title': title, 'downloaded_at': time.time(), 'size': size, 'bps': bps,
                'signer_pubkey': signer_pubkey,
            }
            _save_library()
    except SystemExit as e:
        with _lock:
            _jobs[job_id].update(status='error', error=_with_captured_detail(str(e), captured))
    except Exception as e:
        with _lock:
            _jobs[job_id].update(status='error',
                                  error=_with_captured_detail(f'{type(e).__name__}: {e}', captured))


class WebUIServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        """A client opening a TCP connection and resetting it before ever
        sending a request line is routine, not a bug -- phone browsers,
        a QR-scanner app's in-app preview, and Chrome's own speculative
        preconnects all do this. socketserver's default handle_error
        prints a full traceback for every one of these; only genuinely
        unexpected errors get that treatment here."""
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError, TimeoutError):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet — this is a local UI, not a service worth logging every hit for

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_BODY_SIZE:
            raise ValueError(f'body too large ({length} bytes, max {MAX_BODY_SIZE})')
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)

        if path == '/api/whoami':
            return self._json({'pubkey': _identity().pubkey_hex()})
        if path == '/api/config':
            return self._json({'lan_url': _lan_url, 'default_relay': DEFAULT_RELAY,
                                'default_tunnel': DEFAULT_TUNNEL})
        if path == '/api/discover':
            results = node.group_discover_by_content(node.discover(qs.get('relay') or [DEFAULT_RELAY]))
            return self._json({'results': results})
        if path == '/api/hosts':
            with _lock:
                # strip the underscore-prefixed internals (_sock, _stop_event
                # -- see _start_host_job) before this ever reaches json.dumps:
                # a live socket object isn't JSON-serializable at all, and
                # would 500 this whole endpoint the instant any host reached
                # 'bound' the moment this dict(h) copy stopped filtering them.
                hosts = [{k: v for k, v in h.items() if not k.startswith('_')} for h in _hosts.values()]
            for h in hosts:
                log_buf = _host_logs.get(h['id'])
                if log_buf is not None:
                    h['log'] = log_buf.getvalue()
                if h.get('archive_dir'):
                    h['ott_status'] = _ott_status(h['archive_dir'])
            return self._json({'hosts': hosts})
        if path == '/api/library':
            with _lock:
                return self._json({
                    'downloads': list(_library['downloads'].values()),
                    'likes': list(_library['likes']),
                    'subscriptions': list(_library['subscriptions']),
                    'playlists': list(_library['playlists']),
                    # newest first -- the only order a "recently played" list
                    # is ever actually consumed in
                    'history': list(reversed(_library['history'])),
                })
        if path.startswith('/api/download/'):
            job_id = path[len('/api/download/'):]
            with _lock:
                job = _jobs.get(job_id)
                job = dict(job) if job else None
            if not job:
                return self._json({'error': 'no such job'}, status=404)
            log_buf = _job_logs.get(job_id)
            if log_buf is not None:
                job['log'] = log_buf.getvalue()
            return self._json(job)
        if path.startswith('/api/reputation/'):
            from poc_reputation import ReputationStore
            pubkey = path[len('/api/reputation/'):]
            reputation = ReputationStore(os.path.expanduser('~/.weed_reputation.json'))
            score, why = reputation.trust_score(pubkey)
            return self._json({'pubkey': pubkey, 'score': score, 'why': why})
        if path.startswith('/api/stream/'):
            return self._handle_stream(path[len('/api/stream/'):])
        if path == '/api/qr':
            data = (qs.get('data') or [''])[0]
            if not data:
                return self._json({'error': 'data query param required'}, status=400)
            return self._handle_qr(data)
        self._serve_static(path)

    def _check_origin(self):
        """This server has no auth at all (see module docstring) -- the
        only thing stopping any webpage you happen to have open in the
        same browser from POSTing here (start hosting an arbitrary local
        directory, download attacker-chosen content to an
        attacker-chosen path, like/subscribe as you) is confirming the
        request actually came from this UI, not some other origin your
        browser also has open. Browsers always set Origin on cross-origin
        fetch/XHR and can't be told by page JS to fake it, so a mismatch
        here means a real cross-site request; a request with no Origin at
        all (curl, direct API use, older browsers on a same-origin form
        post) is let through since it isn't the CSRF-from-another-tab
        shape this defends against."""
        origin = self.headers.get('Origin')
        if not origin:
            return True
        host = self.headers.get('Host', '')
        return origin in (f'http://{host}', f'https://{host}')

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._check_origin():
            return self._json({'error': 'rejected: request Origin does not match this server — '
                                         'looks like a cross-site request, not this UI'}, status=403)

        # Not a JSON-body endpoint like everything else here -- the body
        # *is* the raw file being uploaded (see _handle_upload's own
        # docstring for why: no multipart/form-data parser exists in the
        # stdlib, and this repo's own "no new dependency" rule already
        # ruled one out elsewhere). Handled before _read_json_body ever
        # runs, since that would try to json.loads() raw video bytes and
        # fail every single upload with a confusing "bad JSON body" error
        # before this endpoint's own code ever ran.
        if path == '/api/upload':
            try:
                return self._handle_upload()
            except Exception as e:
                return self._json({'error': f'{type(e).__name__}: {e}'}, status=400)

        try:
            body = self._read_json_body()
        except Exception as e:
            return self._json({'error': f'bad JSON body: {e}'}, status=400)

        handlers = {
            '/api/host': self._handle_host, '/api/host/forget': self._handle_forget_host,
            '/api/download': self._handle_download,
            '/api/like': self._handle_like, '/api/subscribe': self._handle_subscribe,
            '/api/verify': self._handle_verify, '/api/play': self._handle_play,
            '/api/playlists/create': self._handle_playlist_create,
            '/api/playlists/rename': self._handle_playlist_rename,
            '/api/playlists/delete': self._handle_playlist_delete,
            '/api/playlists/add': self._handle_playlist_add,
            '/api/playlists/remove': self._handle_playlist_remove,
            '/api/playlists/reorder': self._handle_playlist_reorder,
        }
        handler = handlers.get(path)
        if not handler:
            return self._json({'error': 'not found'}, status=404)
        try:
            handler(body)
        except Exception as e:
            self._json({'error': f'{type(e).__name__}: {e}'}, status=400)

    def _handle_upload(self):
        """POST /api/upload?name=<file>&archive_dir=<dir> -- the file's raw
        bytes as the whole request body (application/octet-stream, not
        multipart/form-data: there's no multipart parser in the stdlib,
        and pulling in a dependency just for this is exactly the kind of
        thing this file's own module docstring already rules out
        elsewhere). Streams straight to disk in fixed-size chunks rather
        than reading the whole body into memory first -- fine for a
        JSON API's few-KB bodies, not for a multi-GB video.

        Archives it immediately (chunks + a real manifest.jsonl entry,
        the exact on-disk shape node.load_manifest_entries/load_leaves
        already read) so it's hostable the moment the upload finishes,
        with no separate `ott add` step -- same reasoning as the rest of
        this UI existing at all: don't make someone learn a second tool
        just to do the thing this one already knows how to do.
        Video or audio, matching ott's own is_video()/is_audio() -- an
        upload of neither would just be a manifest entry that can never
        actually be hosted (see load_manifest_entries' own video/audio-
        only filter, added after exactly that silently broke `host` for
        everything else in the same archive_dir), so it's rejected up
        front instead."""
        from ott import is_video, is_audio, chunk_hashes, merkle_root, OttStore

        qs = parse_qs(urlparse(self.path).query)
        raw_name = (qs.get('name') or [''])[0]
        archive_dir = (qs.get('archive_dir') or [None])[0] or _default_upload_archive_dir()
        if not raw_name:
            return self._json({'error': 'name query param required'}, status=400)

        # basename only -- '..' or an absolute path in the filename
        # can't escape archive_dir this way
        safe_name = os.path.basename(raw_name)
        if not safe_name or safe_name in ('.', '..'):
            return self._json({'error': f'invalid file name: {raw_name!r}'}, status=400)

        if is_video(safe_name):
            content_type = 'video'
        elif is_audio(safe_name):
            content_type = 'audio'
        else:
            return self._json(
                {'error': f'{safe_name}: not a recognized video or audio extension -- only '
                           'video/audio files can be hosted (see ott.is_video/ott.is_audio)'},
                status=400)

        archive_dir = os.path.expanduser(archive_dir)
        os.makedirs(archive_dir, exist_ok=True)
        dest_path = os.path.join(archive_dir, safe_name)

        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return self._json({'error': 'empty upload'}, status=400)

        # write to a temp name and os.replace at the end, same reasoning
        # as _save_library's own tmp-file-then-replace: a client
        # disconnecting mid-upload (closed laptop lid, flaky wifi) must
        # not leave a truncated file sitting at the real destination
        # name, silently masquerading as a complete one later.
        tmp_path = dest_path + '.uploading'
        written = 0
        try:
            with open(tmp_path, 'wb') as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
                    remaining -= len(chunk)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
        if written != length:
            os.remove(tmp_path)
            return self._json(
                {'error': f'incomplete upload ({written:,}/{length:,} bytes) -- connection dropped?'},
                status=400)
        os.replace(tmp_path, dest_path)

        ott_dir = os.path.join(archive_dir, '.ott')
        os.makedirs(os.path.join(ott_dir, 'chunks'), exist_ok=True)
        chunk_size = OttStore(ott_dir).chunk_size
        chunks = chunk_hashes(dest_path, chunk_size)
        digest = merkle_root(chunks) if chunks else hashlib.sha256(b'').hexdigest()
        entry = {
            'sha256': digest, 'name': safe_name, 'orig_path': safe_name, 'last_path': dest_path,
            'size': written, 'added': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'type': content_type, 'n_chunks': len(chunks), 'chunk_size': chunk_size,
        }

        # _lock (not just for _jobs/_hosts/_library, see its own comment
        # up top -- this is the same "one file, must not be torn by two
        # threads at once" concern) since dropping several files at once
        # in the browser fires one of these per file, concurrently, and
        # every one of them touches this *same* manifest.jsonl.
        #
        # tmp-file-then-os.replace, not a bare open(path, 'a') -- a real
        # incident: appending blindly assumes the file already ends with
        # a newline, and it didn't. That merged this entry onto the end
        # of the previous line into one unparseable JSON blob, and
        # load_manifest_entries' `[json.loads(line) for line in f]` has
        # no per-line error handling -- one bad line raises and the
        # *entire* manifest fails to load, which is exactly "files could
        # not be found" for everything in the archive, not just the new
        # upload. Reading the whole file, normalizing a missing trailing
        # newline, and writing the result to a temp file before
        # replacing the original atomically (same pattern _save_library
        # already uses) can't leave a half-written or malformed file on
        # disk no matter when a crash or a second concurrent request
        # lands, and fixes the missing-newline case outright instead of
        # just avoiding making it worse.
        chunks_path = os.path.join(ott_dir, 'chunks', f'{digest}.json')
        manifest_path = os.path.join(ott_dir, 'manifest.jsonl')
        with _lock:
            chunks_tmp = chunks_path + '.tmp'
            with open(chunks_tmp, 'w') as f:
                json.dump(chunks, f)
            os.replace(chunks_tmp, chunks_path)

            existing = ''
            if os.path.exists(manifest_path):
                with open(manifest_path) as f:
                    existing = f.read()
            if existing and not existing.endswith('\n'):
                existing += '\n'
            manifest_tmp = manifest_path + '.tmp'
            with open(manifest_tmp, 'w') as f:
                f.write(existing + json.dumps(entry) + '\n')
            os.replace(manifest_tmp, manifest_path)

        self._json({'ok': True, 'name': safe_name, 'content_hash': digest, 'type': content_type,
                     'size': written, 'n_chunks': len(chunks), 'archive_dir': archive_dir})

    def _handle_host(self, body):
        archive_dir = body.get('archive_dir')
        if not archive_dir:
            return self._json({'error': 'archive_dir required'}, status=400)
        port = int(body.get('port') or 9201)
        price = int(body.get('price') or 0)
        relay_urls = _as_list(body.get('relay'), [DEFAULT_RELAY])
        advertise_host = body.get('advertise_host') or '127.0.0.1'
        tunnel = body.get('tunnel') or None
        ln_node = body.get('lightning_node') or None

        file_name = body.get('file_name')
        _remember_host(archive_dir, file_name, port, price, relay_urls, advertise_host, tunnel, ln_node)
        host_id = _start_host_job(archive_dir, file_name, port, price, relay_urls, advertise_host,
                                   tunnel, ln_node)
        self._json({'host_id': host_id})

    def _handle_forget_host(self, body):
        """POST /api/host/forget {host_id} -- removes a host entry from
        the Active hosts table and, if it's also in ~/.weed_hosts.json,
        from there too, so it stops being retried on every future
        startup. For a still-bound/running host this also actually stops
        it: closing its listening socket (see node.run_host_server's own
        docstring) unblocks its accept() loop, freeing the port
        immediately instead of leaving it squatted forever.

        Real report this closes: a single-file host survived a restart
        via _resume_persisted_hosts and permanently held the default
        port, so every later attempt to host the *whole* archive_dir on
        that same port failed with "Address already in use" -- and
        nothing short of restarting the whole container could free it,
        since there was previously no way to stop a specific running
        host from here at all."""
        host_id = body.get('host_id')
        if not host_id:
            return self._json({'error': 'host_id required'}, status=400)
        with _lock:
            h = _hosts.get(host_id)
            if h is None:
                return self._json({'error': f'no such host: {host_id}'}, status=404)
            del _hosts[host_id]
        stop_event = h.get('_stop_event')
        if stop_event is not None:
            stop_event.set()
        sock = h.get('_sock')
        stopped = False
        if sock is not None:
            try:
                sock.close()
                stopped = True
            except OSError:
                pass
            # closing a socket another thread is blocked in accept() on
            # doesn't guarantee the OS has released the port back for a
            # fresh bind() the instant close() returns here -- that other
            # thread still has to actually wake up from its own blocked
            # syscall first. Joining it (briefly -- this is a normal,
            # near-instant wakeup, not something that should ever
            # legitimately take long) before answering means a client
            # that immediately retries "Start hosting" on this same port
            # right after seeing stopped: true reliably finds it free,
            # instead of racing the old thread's own teardown.
            thread = h.get('_thread')
            if thread is not None:
                thread.join(timeout=2)
        forgotten = _forget_persisted_host(h['archive_dir'], h.get('file_name'), h['port'])
        self._json({'ok': True, 'forgotten_from_autostart': forgotten, 'stopped': stopped})

    def _handle_download(self, body):
        content_hash = body.get('content_hash')
        if not content_hash:
            return self._json({'error': 'content_hash required'}, status=400)
        relay_urls = _as_list(body.get('relay'), [DEFAULT_RELAY])
        out_path = body.get('out_path') or os.path.join(DOWNLOADS_DIR, f'download_{content_hash[:16]}')
        k = int(body.get('k') or 3)
        use_lightning = bool(body.get('lightning'))
        lightning_node = body.get('lightning_node') or None
        if use_lightning and not lightning_node:
            return self._json({'error': "lightning requires lightning_node (who's paying)"}, status=400)
        title = body.get('title')
        signer_pubkey = body.get('signer_pubkey')

        job_id = uuid.uuid4().hex[:12]
        with _lock:
            _jobs[job_id] = {'status': 'running', 'idx': 0, 'n_chunks': None,
                              'content_hash': content_hash, 'path': None, 'title': title,
                              'signer_pubkey': signer_pubkey, 'error': None}
        threading.Thread(target=_run_download_job,
                          args=(job_id, content_hash, relay_urls, out_path, k, use_lightning, title,
                                signer_pubkey),
                          kwargs={'lightning_node': lightning_node},
                          daemon=True).start()
        self._json({'job_id': job_id})

    def _handle_like(self, body):
        content_hash = body.get('content_hash')
        if not content_hash:
            return self._json({'error': 'content_hash required'}, status=400)
        identity = _identity()
        event = identity.sign_event('like', content_hash=content_hash)
        result = node.post_event(body.get('relay') or DEFAULT_RELAY, event)
        with _lock:
            if content_hash not in _library['likes']:
                _library['likes'].append(content_hash)
                _save_library()
        self._json({'result': result})

    def _handle_subscribe(self, body):
        target_pubkey = body.get('target_pubkey')
        if not target_pubkey:
            return self._json({'error': 'target_pubkey required'}, status=400)
        identity = _identity()
        event = identity.sign_event('subscribe', target_pubkey=target_pubkey)
        result = node.post_event(body.get('relay') or DEFAULT_RELAY, event)
        with _lock:
            if target_pubkey not in _library['subscriptions']:
                _library['subscriptions'].append(target_pubkey)
                _save_library()
        self._json({'result': result})

    def _handle_play(self, body):
        """Called once per openPlayer() on the frontend (Discover's ▶ Play,
        a Downloads row, a playlist item, or onPlayerEnded's own auto-
        advance) -- not inferred from /api/stream's byte-range requests,
        which fire many times per single watch (seeking, buffering) and
        would massively overcount. No relay/event involved, unlike
        like/subscribe above -- what you've watched is purely local, same
        reasoning as playlists' own docstring on why those aren't gossiped
        either."""
        content_hash = body.get('content_hash')
        if not content_hash:
            return self._json({'error': 'content_hash required'}, status=400)
        now = time.time()
        with _lock:
            rec = _library['downloads'].get(content_hash)
            title = body.get('title') or (rec.get('title') if rec else None)
            play_count = None
            if rec is not None:
                rec['play_count'] = rec.get('play_count', 0) + 1
                rec['last_played'] = now
                play_count = rec['play_count']
            _library['history'].append({'content_hash': content_hash, 'title': title, 'played_at': now})
            _library['history'] = _library['history'][-MAX_HISTORY:]
            _save_library()
        self._json({'play_count': play_count, 'last_played': now})

    def _handle_playlist_create(self, body):
        name = (body.get('name') or '').strip()
        if not name:
            return self._json({'error': 'name required'}, status=400)
        playlist = {'id': uuid.uuid4().hex[:12], 'name': name, 'items': []}
        with _lock:
            _library['playlists'].append(playlist)
            _save_library()
        self._json({'playlist': playlist})

    def _handle_playlist_rename(self, body):
        playlist_id = body.get('playlist_id')
        name = (body.get('name') or '').strip()
        if not playlist_id or not name:
            return self._json({'error': 'playlist_id and name required'}, status=400)
        with _lock:
            playlist = next((p for p in _library['playlists'] if p['id'] == playlist_id), None)
            if not playlist:
                return self._json({'error': 'no such playlist'}, status=404)
            playlist['name'] = name
            _save_library()
            self._json({'playlist': playlist})

    def _handle_playlist_delete(self, body):
        playlist_id = body.get('playlist_id')
        if not playlist_id:
            return self._json({'error': 'playlist_id required'}, status=400)
        with _lock:
            _library['playlists'] = [p for p in _library['playlists'] if p['id'] != playlist_id]
            _save_library()
        self._json({'ok': True})

    def _handle_playlist_add(self, body):
        playlist_id = body.get('playlist_id')
        content_hash = body.get('content_hash')
        if not playlist_id or not content_hash:
            return self._json({'error': 'playlist_id and content_hash required'}, status=400)
        with _lock:
            playlist = next((p for p in _library['playlists'] if p['id'] == playlist_id), None)
            if not playlist:
                return self._json({'error': 'no such playlist'}, status=404)
            # re-adding something already in the playlist just moves it to
            # this spot instead of piling up a duplicate entry -- same
            # dedup-by-content_hash instinct _library['downloads'] already
            # has, just for a list instead of a dict
            playlist['items'] = [it for it in playlist['items'] if it['content_hash'] != content_hash]
            playlist['items'].append({
                'content_hash': content_hash,
                'title': body.get('title') or None,
                'signer_pubkey': body.get('signer_pubkey') or None,
            })
            _save_library()
            self._json({'playlist': playlist})

    def _handle_playlist_remove(self, body):
        playlist_id = body.get('playlist_id')
        content_hash = body.get('content_hash')
        if not playlist_id or not content_hash:
            return self._json({'error': 'playlist_id and content_hash required'}, status=400)
        with _lock:
            playlist = next((p for p in _library['playlists'] if p['id'] == playlist_id), None)
            if not playlist:
                return self._json({'error': 'no such playlist'}, status=404)
            playlist['items'] = [it for it in playlist['items'] if it['content_hash'] != content_hash]
            _save_library()
            self._json({'playlist': playlist})

    def _handle_playlist_reorder(self, body):
        """Whole-list reorder (drag-and-drop's own natural shape) rather
        than one-step-at-a-time move -- a real drag can jump an item
        several positions in one gesture, and doing that as N sequential
        up/down calls (the earlier arrow-button UI's own approach) is both
        chattier and racier under Vue's own optimistic local reorder than
        just telling the server the whole new order in one call."""
        playlist_id = body.get('playlist_id')
        order = body.get('order')
        if not playlist_id or not isinstance(order, list):
            return self._json({'error': 'playlist_id and order (list of content_hash) required'}, status=400)
        with _lock:
            playlist = next((p for p in _library['playlists'] if p['id'] == playlist_id), None)
            if not playlist:
                return self._json({'error': 'no such playlist'}, status=404)
            by_hash = {it['content_hash']: it for it in playlist['items']}
            # order is trusted for *sequence* only, not as the source of
            # truth for membership -- an item order somehow omits (a stale
            # client, a concurrent add from another tab) stays in the
            # playlist, just at the end, rather than silently vanishing
            reordered = [by_hash.pop(h) for h in order if h in by_hash]
            reordered.extend(by_hash.values())
            playlist['items'] = reordered
            _save_library()
            self._json({'playlist': playlist})

    def _handle_verify(self, body):
        """Re-checks an already-downloaded file against its own
        Merkle-committed chunk hashes without re-fetching it -- see
        node.verify_local_download's docstring. Runs synchronously (this
        is a local read + one INFO/LEAVES round-trip, not a real
        download, so it's fast enough not to need a job/poll dance like
        /api/download does)."""
        content_hash = body.get('content_hash')
        if not content_hash:
            return self._json({'error': 'content_hash required'}, status=400)
        with _lock:
            rec = _library['downloads'].get(content_hash)
        if not rec:
            return self._json({'error': 'no local download on record for this content_hash'},
                               status=404)
        relay_urls = _as_list(body.get('relay'), [DEFAULT_RELAY])
        with _quiet():
            result = node.verify_local_download(content_hash, relay_urls, rec['path'])
        self._json(result)

    def _handle_stream(self, job_id):
        """Serve an already-downloaded job's file with real HTTP range
        support, so a <video> tag can seek/scrub instead of just
        downloading the whole thing blind — the actual gap behind
        'play/open media': the web UI could already trigger a download,
        but the bytes only ever landed on this server's disk, never made
        it to the browser. This is a thin BaseHTTPRequestHandler, so
        range parsing is done by hand rather than pulled in from a
        framework — same "no new dependency" choice as the rest of this
        file."""
        with _lock:
            job = _jobs.get(job_id)
        if not job or job.get('status') != 'done' or not job.get('path'):
            return self._json({'error': 'no completed download for that job id'}, status=404)
        path = job['path']
        if not os.path.isfile(path):
            return self._json({'error': f'{path} no longer exists on disk'}, status=404)

        file_size = os.path.getsize(path)
        ctype, _ = mimetypes.guess_type(path)
        ctype = ctype or 'application/octet-stream'

        range_header = self.headers.get('Range')
        if range_header:
            try:
                _, _, range_spec = range_header.partition('=')
                start_s, _, end_s = range_spec.partition('-')
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else file_size - 1
                end = min(end, file_size - 1)
            except ValueError:
                return self._json({'error': f'malformed Range header: {range_header!r}'}, status=400)
            if start > end or start >= file_size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{file_size}')
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        else:
            start, length = 0, file_size
            self.send_response(200)

        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        self.end_headers()

        with open(path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(262144, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return  # client seeked or closed mid-stream -- not an error
                remaining -= len(chunk)

    def _handle_qr(self, data):
        """PNG QR code of an arbitrary string -- same qrcode package and
        same 'encode a URL so a phone can scan instead of type it' idea as
        ott's own `ott qr`, just rendered as an image for the page to
        embed instead of printed as terminal ASCII."""
        if not _HAS_QR:
            return self._json({'error': 'qrcode not installed on the server -- pip install qrcode'},
                               status=501)
        import io
        qr = qrcode.QRCode(border=1)
        qr.add_data(data)
        qr.make(fit=True)
        img = qr.make_image()
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        body = buf.getvalue()
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        if path == '/':
            path = '/index.html'
        safe_path = os.path.normpath(path).lstrip('/')
        full_path = os.path.join(WEB_DIR, safe_path)
        # the trailing os.sep matters: without it, a sibling directory
        # that happens to share WEB_DIR's name as a string prefix (e.g.
        # "web-private") would also pass this check -- str.startswith
        # doesn't know about path boundaries, only os.path.join does
        web_dir_abs = os.path.abspath(WEB_DIR)
        if not os.path.abspath(full_path).startswith(web_dir_abs + os.sep) \
                or not os.path.isfile(full_path):
            return self._json({'error': 'not found'}, status=404)
        ctype, _ = mimetypes.guess_type(full_path)
        with open(full_path, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype or 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        # this UI's still under active iteration -- every static file is
        # re-read from disk fresh on every request (no server-side
        # caching at all), so the only thing that can ever be stale is a
        # browser hanging onto an old copy of index.html/vue-app.js from
        # its own heuristics. No new dependency needed to fix that, just
        # telling it not to.
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


def _generate_self_signed_cert(host):
    """Return (cert_path, key_path) for a self-signed cert written to a temp dir.

    The temp dir is NOT cleaned up — it lives for the process lifetime so the
    files stay valid as long as the server is running. Uses the `cryptography`
    package already in requirements.txt.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    import datetime, ipaddress

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    san_list = [x509.DNSName(host)]
    try:
        san_list.append(x509.IPAddress(ipaddress.ip_address(host)))
    except ValueError:
        pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .sign(key, hashes.SHA256())
    )

    tmp = tempfile.mkdtemp(prefix='weed-tls-')
    cert_path = os.path.join(tmp, 'cert.pem')
    key_path = os.path.join(tmp, 'key.pem')
    with open(cert_path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, 'wb') as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    return cert_path, key_path


def run_web_ui(port=8080, bind_host='127.0.0.1', quiet=False, advertise_host=None,
               tls=False, certfile=None, keyfile=None):
    global _lan_url
    _load_library()
    _rehydrate_jobs_from_library()
    _load_persisted_hosts()
    _resume_persisted_hosts()
    srv = WebUIServer((bind_host, port), Handler)

    if tls:
        if not certfile or not keyfile:
            reachable_for_cert = advertise_host or (_detect_lan_ip() if bind_host == '0.0.0.0' else bind_host) or bind_host
            if not quiet:
                print(f"[web] generating self-signed TLS cert for {reachable_for_cert} …", flush=True)
            certfile, keyfile = _generate_self_signed_cert(reachable_for_cert)
            if not quiet:
                print(f"[web] cert: {certfile}", flush=True)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile, keyfile)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)

    scheme = 'https' if tls else 'http'

    # `docker compose down` (and plain Ctrl-C) sends SIGTERM -- without
    # this, a host that goes offline just leaves a stale, now-unreachable
    # publish event sitting in discover results until a relay's per-signer
    # cap happens to evict it (could be a long time). _persisted_hosts
    # itself is untouched here on purpose: the whole point is that the
    # *next* `make node` auto-resumes and re-announces the same hosts
    # (see _resume_persisted_hosts above), this only delists them for
    # however long this process happens to be down.
    def _handle_sigterm(signum, frame):
        if not quiet:
            print("\n[web] shutting down — delisting active hosts", flush=True)
        _unpublish_all_hosts()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_sigterm)

    # advertise_host is an escape hatch for _detect_lan_ip()'s UDP-route
    # trick guessing wrong (multiple interfaces/VPNs, sandboxed or
    # container networking, no outbound route at all) -- same failure
    # shape as "the QR/lan-url doesn't point at a reachable address",
    # just fixed by telling this explicitly instead of guessing
    reachable_host = advertise_host or (_detect_lan_ip() if bind_host == '0.0.0.0' else bind_host)
    if bind_host != '127.0.0.1' and reachable_host:
        _lan_url = f'http://{reachable_host}:{port}/'

    if not quiet:
        # answers "is this container actually running the code I think it
        # is" directly in `docker compose logs`/`make node`'s own output —
        # see node.weed_banner()'s own docstring for exactly the debugging
        # session that motivated adding a commit hash to it in the first
        # place; printing it here means the same question doesn't need a
        # docker exec + grep to answer for the web UI specifically
        print(f"[web:{port}] {node.weed_banner()}", flush=True)
        print(f"[web:{port}] weed control UI at http://{bind_host}:{port}/", flush=True)
        if bind_host == '127.0.0.1':
            print("  bound to localhost only -- pass --bind 0.0.0.0 to reach this from your "
                  "phone (and get a scan-to-open QR here)", flush=True)
        elif _lan_url:
            if _HAS_QR:
                print(f"  scan to open on your phone ({_lan_url}):", flush=True)
                qr = qrcode.QRCode(border=1)
                qr.add_data(_lan_url)
                qr.make(fit=True)
                qr.print_ascii(invert=True)
            else:
                print(f"  scan-to-open URL: {_lan_url}  (pip install qrcode for a terminal "
                      f"QR code)", flush=True)
        else:
            print("  couldn't detect a LAN IP -- phone QR codes in the web UI won't work "
                  "until you restart with reachable networking", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        # Ctrl-C raises this directly rather than delivering SIGTERM --
        # same delisting on the way out, so a foreground `weed serve`
        # gets the same graceful-shutdown behavior as `docker compose down`
        if not quiet:
            print("\n[web] shutting down — delisting active hosts", flush=True)
        _unpublish_all_hosts()


def main():
    import argparse
    parser = argparse.ArgumentParser(description='weed local control UI')
    parser.add_argument('port', nargs='?', type=int, default=8080,
                         help='port to listen on (default: 8080)')
    parser.add_argument('--port', dest='port_flag', type=int,
                         help='same as the positional port arg, --port form')
    parser.add_argument('--bind', default='127.0.0.1',
                         help='bind address (default: 127.0.0.1, local only -- no auth is '
                              'built, so only widen this on a network you trust)')
    parser.add_argume