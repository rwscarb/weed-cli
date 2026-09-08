"""The add-on's screens and actions, Kodi-free.

Kodi drives a plugin by calling it with a plugin:// URL; default.py
parses that URL and hands the action here along with a `ui` object that
does the actual Kodi calls (directory items, playback, notifications).
Keeping every decision in this module -- what's listed, in what order,
what URL plays what -- means tests/test_kodi_addon.py can run all of it
against a real node with a fake ui and no Kodi at all.

The ui contract (see default.py's KodiUI and the tests' FakeUI):
  folder(label, action, **params)          a directory entry
  media(label, url, info, action, **params) a playable entry; `action`
                                            is what to call on select so
                                            the play gets counted
  end(content=None)                         finish the listing
  play(url, label, info)                    hand a URL to the player
  play_all(entries)                         queue [(url, label, info)] and play
  notify(message)                           a toast
  settings() -> {'server': ..., 'token': ...}
"""
from . import weedapi


ROOT = [
    ('Downloads', 'downloads', {}),
    ('Playlists', 'playlists', {}),
    ('Tags', 'tags', {}),
    ('Party', 'party', {}),
    ('Live: Orbit picture + audio', 'live', {'what': 'mux'}),
    ('Live: Orbit picture only (MJPEG)', 'live', {'what': 'view'}),
    ('Live: Orbit audio (Kodi visualiser)', 'live', {'what': 'audio'}),
    ("Autopilot: play the node's pick", 'autopilot', {}),
]


def info_for(d):
    """Kodi's video info labels for a download record."""
    return {
        'title': d.get('label') or d.get('title') or '',
        'playcount': int(d.get('play_count') or 0),
        'size': int(d.get('size') or 0),
        'tags': list(d.get('tags') or []),
        'mediatype': 'musicvideo' if not d.get('is_audio') else 'song',
    }


class Plugin:
    def __init__(self, ui, api=None):
        self.ui = ui
        s = ui.settings()
        self.api = api or weedapi.WeedApi(s.get('server'), s.get('token'), insecure=s.get('insecure', True))

    # ── dispatch ────────────────────────────────────────────────────
    def run(self, action=None, **params):
        handler = getattr(self, 'do_' + (action or 'root'), None)
        if not handler:
            self.ui.notify('unknown action: %s' % action)
            return self.do_root()
        # Kodi adds parameters of its own to the URL it calls us with --
        # content_type=video when it opens the add-on from the video
        # section, since addon.xml provides both video and audio -- so a
        # screen only gets the parameters it declares
        import inspect
        accepted = inspect.signature(handler).parameters
        params = {k: v for k, v in params.items() if k in accepted}
        try:
            return handler(**params)
        except weedapi.WeedError as e:
            self.ui.notify(str(e))
            self.ui.end()

    def _media(self, d, **extra):
        self.ui.media(d['label'], d['stream_url'], info_for(d), action='play',
                      job_id=d['job_id'], content_hash=d['content_hash'], title=d['label'], **extra)

    # ── screens ─────────────────────────────────────────────────────
    def do_root(self):
        for label, action, params in ROOT:
            self.ui.folder(label, action, **params)
        self.ui.end()

    def do_downloads(self, tag=None, sort='newest'):
        lib = self.api.library()
        items = self.api.downloads(lib)
        if tag:
            items = [d for d in items if tag in (d.get('tags') or [])]
        if sort == 'title':
            items.sort(key=lambda d: d['label'].lower())
        elif sort == 'plays':
            items.sort(key=lambda d: -(d.get('play_count') or 0))
        for d in items:
            self._media(d)
        self.ui.end(content='musicvideos')

    def do_playlists(self):
        for p in self.api.playlists():
            n = len(p.get('items') or [])
            self.ui.folder('%s (%d)' % (p.get('name') or p.get('id'), n), 'playlist', id=p.get('id'))
        self.ui.end()

    def do_playlist(self, id=None):
        items = self.api.playlist_items(id)
        if items:
            self.ui.folder('▶ Play all', 'playall', id=id)
        for d in items:
            self._media(d)
        self.ui.end(content='musicvideos')

    def do_playall(self, id=None):
        items = self.api.playlist_items(id)
        if not items:
            self.ui.notify('nothing downloaded in that playlist')
            return
        self.ui.play_all([(d['stream_url'], d['label'], info_for(d)) for d in items])
        for d in items[:1]:
            self._count(d['content_hash'], d['label'])

    def do_tags(self):
        groups = self.api.tags()
        if not groups:
            self.ui.notify('no tags yet -- add some in the Downloads tab')
        for tag, ds in groups.items():
            self.ui.folder('%s (%d)' % (tag, len(ds)), 'downloads', tag=tag)
        self.ui.end()

    def do_party(self):
        party = self.api.party()
        recs = self.api.by_hash()
        now = party.get('now_playing') or {}
        if now.get('title'):
            self.ui.folder('now playing: ' + weedapi.display_title(now['title']), 'party')
        for t in party.get('tracks') or []:
            votes = t.get('votes') or t.get('score') or 0
            label = '+1  %s  (%s)' % (weedapi.display_title(t.get('title')) or t.get('content_hash', '')[:12], votes)
            self.ui.folder(label, 'vote', content_hash=t.get('content_hash'))
        self.ui.end()

    def do_vote(self, content_hash=None):
        self.api.vote(content_hash)
        self.ui.notify('voted')
        self.ui.end()

    def do_live(self, what='view'):
        st = self.api.orbit_stream()
        if not st.get('active'):
            self.ui.notify('the visualizer is not streaming right now (📡 in the player)')
            return self.ui.end()
        # The feed URLs come from weedapi.media_base(): the node itself on
        # plain http, its advertised plain stream port on https (Kodi's
        # player can't take the self-signed certificate), never a stale
        # advertised port on an http node (Ryan: "the log says it's
        # trying 4242, but that's the old port").
        if what == 'mux':
            if not st.get('audio'):
                self.ui.notify('the stream has no audio on (🔊 beside 📡)')
                return self.ui.end()
            if not st.get('ffmpeg'):
                self.ui.notify('the node has no ffmpeg, so picture and audio come separately (see README)')
                return self.ui.end()
            return self.ui.play(self.api.feed_url('mux'), 'weed Orbit', {'title': 'weed Orbit', 'mediatype': 'video'})
        if what == 'audio':
            if not st.get('audio'):
                self.ui.notify('the stream has no audio on (🔊 beside 📡)')
                return self.ui.end()
            self.ui.play(self.api.feed_url('audio'), 'weed Orbit audio', {'title': 'weed Orbit audio', 'mediatype': 'song'})
        else:
            self.ui.play(self.api.feed_url('view'), 'weed Orbit', {'title': 'weed Orbit', 'mediatype': 'video'})

    def do_autopilot(self):
        """The node's own weighted pick between tracks: least-played and
        longest-rested first, same rule the browser's Autopilot uses."""
        import random, time
        items = self.api.downloads()
        if not items:
            self.ui.notify('nothing downloaded yet')
            return self.ui.end()
        now = time.time()
        weights = []
        for d in items:
            plays = max(0, int(d.get('play_count') or 0))
            age_h = (now - d['last_played']) / 3600 if d.get('last_played') else 48
            weights.append(((1 + plays) ** -1.5) * (0.2 + 0.8 * min(1, age_h / 24)))
        d = random.choices(items, weights=weights, k=1)[0]
        self.do_play(job_id=d['job_id'], content_hash=d['content_hash'], title=d['label'])

    # ── playback ────────────────────────────────────────────────────
    def _count(self, content_hash, title):
        try:
            self.api.record_play(content_hash, title)
        except weedapi.WeedError:
            pass   # a lost count is not a reason to stop the music

    def do_play(self, job_id=None, content_hash=None, title=None):
        url = self.api.stream_url(job_id)
        self.ui.play(url, title or job_id, {'title': title or job_id})
        if content_hash:
            self._count(content_hash, title)
