"""The weed node's REST API, from Kodi.

Plain urllib, no dependencies -- Kodi ships Python but not requests. The
add-on talks to the same web_ui.py endpoints the browser UI uses:
/api/library for downloads, playlists and tags, /api/party for the vote
list, /api/play to count a play, and it hands Kodi's player the
/api/stream/<job_id> URL with the auth token in the query, since the
player can't send a header. Everything here is pure Python so it can be
tested against a real node without Kodi (tests/test_kodi_addon.py).
"""
import json
import urllib.error
import urllib.parse
import urllib.request

AUDIO_EXT = ('.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma')
MEDIA_EXT = ('.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.flv') + AUDIO_EXT


class WeedError(Exception):
    pass


def display_title(title):
    """The guest page's rule: drop a trailing media extension, nothing else."""
    t = (title or '').strip()
    low = t.lower()
    for ext in MEDIA_EXT:
        if low.endswith(ext):
            return t[:-len(ext)]
    return t


class WeedApi:
    def __init__(self, base, token=None, timeout=10, opener=None, insecure=True):
        self.base = (base or '').rstrip('/')
        self.token = (token or '').strip() or None
        self.timeout = timeout
        # The node's TLS is self-signed (weed web --tls), which no Kodi
        # box will have in its trust store, so with `insecure` the API
        # calls skip certificate verification. Media never goes through
        # this client (Kodi's player fetches it), see media_base().
        self.insecure = bool(insecure)
        self._open = opener or self._default_open
        self._media_base = None

    def _default_open(self, req, timeout=None):
        if self.insecure and req.full_url.lower().startswith('https://'):
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return urllib.request.urlopen(req, timeout=timeout, context=ctx)
        return urllib.request.urlopen(req, timeout=timeout)

    @property
    def is_tls(self):
        return self.base.lower().startswith('https://')

    def media_base(self):
        """Where Kodi's player fetches files and feeds from. On a plain
        http node that's the node itself. On an https node it's the plain
        stream port the node advertises (--stream-plain-port; asked for
        once via /api/orbit-stream and cached), because Kodi's player
        won't take the self-signed certificate; with no plain port
        configured it falls back to the https node with Kodi's own
        verifypeer=false URL option, which its file player honours."""
        if not self.is_tls:
            return self.base
        if self._media_base is None:
            plain = None
            try:
                st = self._req('/api/orbit-stream') or {}
                for key in ('plain_url', 'audio_plain_url'):
                    u = st.get(key)
                    if u:
                        p = urllib.parse.urlsplit(u)
                        plain = '%s://%s' % (p.scheme, p.netloc)
                        break
            except WeedError:
                pass
            self._media_base = plain or self.base
        return self._media_base

    def _player_url(self, path):
        base = self.media_base()
        url = self._with_token(base + path)
        if base.lower().startswith('https://'):
            url += '|verifypeer=false'
        return url

    # ── plumbing ────────────────────────────────────────────────────
    def _req(self, path, body=None):
        if not self.base:
            raise WeedError('no server URL set -- open the add-on settings')
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method='POST' if body is not None else 'GET')
        try:
            with self._open(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode() or 'null')
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode()).get('error') or str(e)
            except Exception:
                msg = str(e)
            if e.code == 401:
                msg = 'the node refused the token -- check the add-on settings'
            raise WeedError(msg)
        except urllib.error.URLError as e:
            raise WeedError('cannot reach %s (%s)' % (self.base, e.reason))

    def _with_token(self, url):
        if not self.token:
            return url
        sep = '&' if '?' in url else '?'
        return url + sep + 'token=' + urllib.parse.quote(self.token, safe='')

    def stream_url(self, job_id):
        return self._player_url('/api/stream/%s' % job_id)

    def feed_url(self, what):
        """The live Orbit picture ('view') or audio ('audio') feed, for the player."""
        return self._player_url('/api/orbit-audio' if what == 'audio' else '/api/orbit-view')

    # ── reads ───────────────────────────────────────────────────────
    def library(self):
        return self._req('/api/library') or {}

    def downloads(self, lib=None):
        """Finished downloads, newest first, each with 'stream_url' and a
        cleaned 'label' added; the unfinished have no job_id and are left out."""
        lib = lib if lib is not None else self.library()
        out = []
        for d in lib.get('downloads') or []:
            if not d.get('job_id'):
                continue
            d = dict(d)
            d['label'] = display_title(d.get('title')) or d.get('content_hash', '')[:12]
            d['stream_url'] = self.stream_url(d['job_id'])
            d['is_audio'] = (d.get('path') or '').lower().endswith(AUDIO_EXT)
            out.append(d)
        out.sort(key=lambda d: d.get('downloaded_at') or 0, reverse=True)
        return out

    def by_hash(self, lib=None):
        return {d['content_hash']: d for d in self.downloads(lib)}

    def tags(self, lib=None):
        """tag -> [downloads carrying it], tags most-used first."""
        groups = {}
        for d in self.downloads(lib):
            for t in d.get('tags') or []:
                groups.setdefault(t, []).append(d)
        return dict(sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])))

    def playlists(self, lib=None):
        lib = lib if lib is not None else self.library()
        return list(lib.get('playlists') or [])

    def playlist_items(self, playlist_id, lib=None):
        """The playlist's items that are downloaded, in playlist order."""
        lib = lib if lib is not None else self.library()
        recs = self.by_hash(lib)
        for p in self.playlists(lib):
            if p.get('id') == playlist_id:
                return [dict(recs[i['content_hash']], label=display_title(i.get('title')) or recs[i['content_hash']]['label'])
                        for i in p.get('items') or [] if i.get('content_hash') in recs]
        raise WeedError('no such playlist')

    def party(self):
        return self._req('/api/party') or {}

    def orbit_stream(self):
        """The live visualizer stream's URLs, if it's running."""
        return self._req('/api/orbit-stream') or {}

    # ── writes ──────────────────────────────────────────────────────
    def record_play(self, content_hash, title=None):
        return self._req('/api/play', {'content_hash': content_hash, 'title': title})

    def vote(self, content_hash):
        return self._req('/api/party/vote', {'content_hash': content_hash})

    def like(self, content_hash):
        return self._req('/api/like', {'content_hash': content_hash})
