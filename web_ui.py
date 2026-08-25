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
import io
import json
import mimetypes
import os
import sys
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


sys.stdout = _JobStdout(sys.stdout)


@contextlib.contextmanager
def _quiet():
    """Mute node.py's CLI-oriented prints for the current thread only,
    for the duration of the with-block."""
    sys.stdout._local.buf = io.StringIO()
    try:
        yield
    finally:
        sys.stdout._local.buf = None

_hosts = {}   # host_id -> dict describing an actively-hosted file
_jobs = {}    # job_id -> dict describing a download's progress/result
_lock = threading.Lock()

# what's been downloaded/liked/subscribed, persisted to disk so a page
# reload -- or a server restart -- doesn't forget any of it. Downloads
# are keyed by content_hash (one record per piece of content, most
# recent job wins); likes/subscriptions are just lists of hashes/pubkeys.
# All access goes through _lock, same as _hosts/_jobs.
_library = {'downloads': {}, 'likes': [], 'subscriptions': []}


def _load_library():
    global _library
    try:
        with open(LIBRARY_PATH) as f:
            data = json.load(f)
        _library = {
            'downloads': data.get('downloads') or {},
            'likes': data.get('likes') or [],
            'subscriptions': data.get('subscriptions') or [],
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
                   ln_node=None):
    try:
        with _quiet():
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
            announced = []
            for entry in entries:
                for relay_url in relay_urls:
                    host_addr = f'{advertise_host}:{port}'
                    node.publish(identity, relay_url, entry['sha256'], entry['name'], host_addr,
                                  tunnel=tunnel)
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
            node.run_host_server(archive_dir, file_name, port, quiet=True, price=price, ln_node=ln_node)
    except SystemExit as e:
        with _lock:
            _hosts[host_id].update(status='error', error=str(e))
    except Exception as e:
        with _lock:
            _hosts[host_id].update(status='error', error=f'{type(e).__name__}: {e}')


def _run_download_job(job_id, content_hash, relay_urls, out_path, k, use_lightning, title=None,
                       signer_pubkey=None, lightning_node=None):
    def on_progress(idx, n_chunks):
        with _lock:
            _jobs[job_id].update(idx=idx, n_chunks=n_chunks)

    try:
        t0 = time.time()
        with _quiet():
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
            _jobs[job_id].update(status='error', error=str(e))
    except Exception as e:
        with _lock:
            _jobs[job_id].update(status='error', error=f'{type(e).__name__}: {e}')


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
                return self._json({'hosts': list(_hosts.values())})
        if path == '/api/library':
            with _lock:
                return self._json({
                    'downloads': list(_library['downloads'].values()),
                    'likes': list(_library['likes']),
                    'subscriptions': list(_library['subscriptions']),
                })
        if path.startswith('/api/download/'):
            with _lock:
                job = _jobs.get(path[len('/api/download/'):])
            return self._json(job) if job else self._json({'error': 'no such job'}, status=404)
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
        try:
            body = self._read_json_body()
        except Exception as e:
            return self._json({'error': f'bad JSON body: {e}'}, status=400)

        handlers = {
            '/api/host': self._handle_host, '/api/download': self._handle_download,
            '/api/like': self._handle_like, '/api/subscribe': self._handle_subscribe,
            '/api/verify': self._handle_verify,
        }
        handler = handlers.get(path)
        if not handler:
            return self._json({'error': 'not found'}, status=404)
        try:
            handler(body)
        except Exception as e:
            self._json({'error': f'{type(e).__name__}: {e}'}, status=400)

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

        host_id = uuid.uuid4().hex[:12]
        with _lock:
            _hosts[host_id] = {'id': host_id, 'archive_dir': archive_dir, 'port': port,
                                'price': price, 'tunnel': tunnel, 'status': 'starting'}
        threading.Thread(target=_run_host_job,
                          args=(host_id, archive_dir, body.get('file_name'), port, price,
                                relay_urls, advertise_host, tunnel),
                          kwargs={'ln_node': ln_node}, daemon=True).start()
        self._json({'host_id': host_id})

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


def run_web_ui(port=8080, bind_host='127.0.0.1', quiet=False, advertise_host=None):
    global _lan_url
    _load_library()
    _rehydrate_jobs_from_library()
    srv = WebUIServer((bind_host, port), Handler)

    # advertise_host is an escape hatch for _detect_lan_ip()'s UDP-route
    # trick guessing wrong (multiple interfaces/VPNs, sandboxed or
    # container networking, no outbound route at all) -- same failure
    # shape as "the QR/lan-url doesn't point at a reachable address",
    # just fixed by telling this explicitly instead of guessing
    reachable_host = advertise_host or (_detect_lan_ip() if bind_host == '0.0.0.0' else bind_host)
    if bind_host != '127.0.0.1' and reachable_host:
        _lan_url = f'http://{reachable_host}:{port}/'

    if not quiet:
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
    srv.serve_forever()


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
    parser.add_argument('--advertise-host',
                         help="IP/hostname to put in the phone QR and lan-url instead of "
                              "auto-detecting it -- use this if the QR at startup was missing "
                              "or pointed at the wrong address (auto-detection guesses via an "
                              "outbound route, which can pick the wrong interface or fail "
                              "outright on unusual networking)")
    args = parser.parse_args()
    port = args.port_flag if args.port_flag is not None else args.port
    run_web_ui(port, bind_host=args.bind, advertise_host=args.advertise_host)


if __name__ == '__main__':
    main()
