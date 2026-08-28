'use strict';

const { createApp } = Vue;

// three-way "Any / <label> / Not <label>" segmented toggle, standing in
// for a plain checkbox anywhere a filter needs to say "must be false",
// not just "must be true or don't care" -- v-model works on it via the
// standard modelValue/update:modelValue convention, same as a native
// input would
const FilterToggle = {
  props: { modelValue: String, label: String },
  emits: ['update:modelValue'],
  template: `
    <div class="filter-toggle">
      <span class="filter-toggle-label">{{ label }}</span>
      <button type="button" :class="{active: modelValue === 'any'}"
              @click="$emit('update:modelValue', 'any')">Any</button>
      <button type="button" :class="{active: modelValue === 'yes'}"
              @click="$emit('update:modelValue', 'yes')">{{ label }}</button>
      <button type="button" :class="{active: modelValue === 'no'}"
              @click="$emit('update:modelValue', 'no')">Not {{ label }}</button>
    </div>
  `,
};

const app = createApp({
  data() {
    const tabs = [
      { id: 'discover', label: 'Discover' },
      { id: 'host', label: 'Host' },
      { id: 'downloads', label: 'Downloads' },
      { id: 'playlists', label: 'Playlists' },
      { id: 'identity-tab', label: 'Identity' },
    ];
    // URL hash is the tab, e.g. weed:8080/#playlists -- read straight
    // into the initial value here (not set later in mounted()) so a
    // refresh lands on the right tab from the very first paint, instead
    // of flashing Discover for a frame first. Anything unrecognized
    // (empty hash on a first visit, a stale/hand-edited one) falls back
    // to Discover same as before this existed.
    const hashTab = location.hash.slice(1);
    return {
      pubkey: '',
      lanUrlBase: null,

      tabs,
      activeTab: tabs.some(t => t.id === hashTab) ? hashTab : 'discover',

      discoverRelays: 'http://127.0.0.1:9101',
      discoverResults: [],
      // true until the first refreshDiscover() actually resolves -- starts
      // true (not false) since mounted() awaits whoami/config/library
      // sequentially before ever calling it, so without this the empty
      // table shows a misleading "nothing found" for that whole stretch,
      // before a real request has even gone out
      discoverLoading: true,
      discoverSearch: '',
      // content_hash of the row the search box's arrow-key navigation is
      // currently sitting on, or null -- tracked by hash rather than a
      // raw index so it survives the filtered list reshuffling under it
      // as search/filter state changes
      searchHighlightHash: null,
      // 'any' | 'yes' | 'no' -- a checkbox can only say "must be true or
      // don't care", not "must be false", so these are a tri-state
      // toggle instead (see the filter-toggle component below)
      filterDownloaded: 'any',
      filterLiked: 'any',
      filterSubscribed: 'any',
      filterPlayed: 'any',
      // collapses the Relay/Search/filter forms behind a toggle -- but
      // only below the mobile breakpoint (see .discover-filters in
      // style.css); the flag itself starts false unconditionally since
      // CSS ignores it entirely at desktop width anyway (those forms
      // always show there, same as before this existed), so there's no
      // need to detect viewport width here just to pick the right
      // default.
      discoverFiltersOpen: false,

      // server-persisted memory of what's been downloaded/liked/subscribed/
      // playlisted, so a page reload (or a server restart) doesn't forget
      // any of it -- loaded once at startup, then kept in sync as the user
      // acts. playlists is a plain array (order is meaningful -- it's
      // playback order), each entry the exact shape web_ui.py's
      // /api/playlists/* endpoints hand back plus a couple of purely
      // client-side UI fields (_editing/_nameDraft) for the inline rename
      // control, same pattern discoverResults already uses for _dl/_verify.
      // history: newest-first log of plays, {content_hash, title, played_at}
      // -- see web_ui.py's _handle_play for why this is separate from each
      // download record's own play_count/last_played (aggregate vs. log)
      library: { downloads: {}, likes: new Set(), subscriptions: new Set(), playlists: [], history: [] },

      // Discover sort -- clickable column headers (Title/Plays/Last
      // played), not a dropdown: discoverSortBy is null until a header's
      // been clicked (discoverResults' own arrival order, whatever the
      // relay(s) returned), then 'title' | 'plays' | 'recent'. plays/
      // recent read off each row's library.downloads entry (nothing
      // plays without downloading first in this app, so that's always
      // where play data lives -- see sortedDiscoverResults/setDiscoverSort).
      discoverSortBy: null,
      discoverSortDir: 'desc',

      hostForm: {
        archiveDir: '', fileName: '', port: 9201, price: 0, lightningNode: null,
        relays: 'http://127.0.0.1:9101', advertiseHost: '127.0.0.1',
        tunnelEnabled: false, tunnelAddr: '',
      },
      hostResult: '',
      hosts: [],
      // drag-and-drop video files straight onto the Host tab -- each
      // entry tracks one in-flight (or finished) upload: {name, pct,
      // status: 'uploading'|'done'|'error', error, contentHash}. Kept
      // around after finishing (not spliced out) so a batch of several
      // dropped files still shows what happened to each one, same
      // reasoning as `jobs` below never removing a finished download.
      uploads: [],
      hostDropzoneActive: false,

      downloadForm: {
        hash: '', relays: 'http://127.0.0.1:9101', out: '', lightning: false, lightningNode: null,
      },
      // both persisted-on-load downloads and ones started this session end
      // up here, in the same shape, so one template handles both instead
      // of two near-identical row renderers
      jobs: [],

      reputationPubkey: '',
      reputationResult: '',

      // one global player, shared by every "▶ Play" button anywhere in the
      // app (Discover rows, Downloads jobs table) -- starts docked
      // PIP-style in the corner, can grow to a centered theater modal, or
      // go true native fullscreen. Never tied to whichever tab/row started
      // it, so switching tabs doesn't stop or hide playback.
      player: {
        visible: false, mode: 'pip', jobId: null, title: '',
        contentHash: null, signerPubkey: null, isPlaying: false,
        // set whenever playback started from a playlist (its "Play all",
        // or clicking any individual track in it -- see playPlaylist/
        // playPlaylistItem) -- { items: [...], index, playlistId } into
        // that same array. null means "just playing one thing," the
        // ordinary case -- see openPlayer/onPlayerEnded. playlistId is
        // what the "Add to playlist" picker checks (see
        // playlistPickerActivePlaylistId) to show which playlist, if
        // any, is the one actually driving the current queue -- carried
        // through on every re-openPlayer() a skip does (onPlayerEnded,
        // playQueueOffset) rather than just set once at the start, same
        // as items/index already were, since it's still the same
        // logical queue continuing, not a new one.
        queue: null,
      },

      // one shared QR popup, repositioned/retargeted by whichever button
      // (header "open on phone", or a per-item share button) last clicked it
      qr: { visible: false, url: '', top: 0, left: null, right: null },

      // one shared "add to playlist" popup, same anchored-under-the-
      // clicked-button pattern as qr above -- item is whatever
      // {content_hash, title, signer_pubkey} triggered it (a Discover
      // result or a Downloads job), so addToPlaylist doesn't need two
      // near-identical copies for the two places this opens from.
      playlistPicker: { visible: false, top: 0, left: null, right: null, item: null },
      newPlaylistName: '',
      // 'playlistId:index' of whichever playlist-item is the current
      // drop target mid-drag, or null -- see onItemDragOver/onItemDrop
      dragOverKey: null,
      // separate from the picker's own newPlaylistName above -- the
      // Playlists tab's own "create an empty playlist" form is a
      // persistent, always-visible field, not a popup that resets itself
      // on every open, so sharing one variable between them would leak
      // whatever was last typed in either into the other.
      newPlaylistNameStandalone: '',

      // errors can now carry node.py's full captured diagnostic trace
      // (see web_ui.py's _with_captured_detail), not just a one-line
      // summary -- a native alert() can't be text-selected/copied in most
      // browsers, which defeats the point once there's a real multi-line
      // trace worth copying out. Plain in-page text instead.
      errorDialog: { visible: false, message: '' },

      shortcutsVisible: false,
      // shown in the shortcuts overlay and used to build the actual
      // keydown handler below, so the two can never drift out of sync
      shortcuts: [
        { keys: '/', desc: 'Jump to Discover search' },
        { keys: '1 – 5', desc: 'Switch tabs (Discover/Host/Downloads/Playlists/Identity)' },
        { keys: '↑ / ↓', desc: 'Move highlight through Discover results (search box focused)' },
        { keys: 'Enter / Space', desc: 'Play or Download the highlighted row (search box focused)' },
        { keys: 'r', desc: 'Refresh Discover' },
        { keys: 'f', desc: 'Cycle player size: PIP → Theater → Fullscreen (while a video is open)' },
        { keys: 'n / p', desc: 'Next / previous track (while playing a playlist)' },
        { keys: 'Space', desc: 'Play / pause (while a video is open)' },
        { keys: 'Esc', desc: 'Close player / QR popup / error dialog / this list' },
        { keys: '?', desc: 'Toggle this list' },
      ],

      // Orbit Visualizer -- toggled via the player header's own 🌀
      // icon (always visible there, see index.html), no unlock/trigger
      // gating it any more.
      easterEggVisible: false,
    };
  },

  computed: {
    discoverRelaysList() {
      return this.splitRelays(this.discoverRelays);
    },
    // search + the four tri-state toggles all narrow the same list
    // together (AND, not OR) -- each one set away from 'any' must hold
    // for a row to show
    filteredDiscoverResults() {
      const q = this.discoverSearch.trim().toLowerCase();
      const matchesTriState = (state, isTrue) =>
        state === 'any' || (state === 'yes') === isTrue;
      return this.discoverResults.filter(r => {
        if (q && !(r.title || '').toLowerCase().includes(q) && !r.content_hash.toLowerCase().includes(q)) {
          return false;
        }
        if (!matchesTriState(this.filterDownloaded, !!this.library.downloads[r.content_hash])) return false;
        if (!matchesTriState(this.filterLiked, this.library.likes.has(r.content_hash))) return false;
        if (!matchesTriState(this.filterSubscribed, this.library.subscriptions.has(r.signer_pubkey))) return false;
        const rec = this.library.downloads[r.content_hash];
        if (!matchesTriState(this.filterPlayed, !!(rec && rec.play_count))) return false;
        return true;
      });
    },
    // Applied after filtering, not before -- sorting doesn't change which
    // rows show, just their order. discoverSortBy null (no header clicked
    // yet) is a no-op copy rather than skipping .slice() so this always
    // returns a fresh array Vue can key off cleanly. Play data lives on
    // each row's own library.downloads entry (a Discover result itself
    // never carries play stats -- nothing plays here without being
    // downloaded first), so unplayed/undownloaded rows read as 0/no-
    // timestamp -- sorted last under descending plays/recent (the default
    // direction those two start at, see setDiscoverSort), first under
    // ascending.
    sortedDiscoverResults() {
      const list = this.filteredDiscoverResults.slice();
      const rec = (r) => this.library.downloads[r.content_hash];
      const dir = this.discoverSortDir === 'asc' ? 1 : -1;
      if (this.discoverSortBy === 'title') {
        list.sort((a, b) => dir * (a.title || '').localeCompare(b.title || ''));
      } else if (this.discoverSortBy === 'plays') {
        list.sort((a, b) => dir * ((rec(a)?.play_count || 0) - (rec(b)?.play_count || 0)));
      } else if (this.discoverSortBy === 'recent') {
        list.sort((a, b) => dir * ((rec(a)?.last_played || 0) - (rec(b)?.last_played || 0)));
      }
      return list;
    },
    highlightedIndex() {
      if (!this.searchHighlightHash) return -1;
      return this.sortedDiscoverResults.findIndex(r => r.content_hash === this.searchHighlightHash);
    },
    // what the browser tab shows -- a playing video wins over an active
    // download (you're far more likely to be glancing at the tab to
    // check playback than to time a download), which wins over the
    // static default. jobs (not r._dl) is the single source of truth
    // for "is anything downloading" -- every download, whether started
    // from a Discover row or the Downloads tab form, always lands there.
    pageTitle() {
      if (this.player.visible) {
        return (this.player.isPlaying ? '▶ ' : '⏸ ') + this.player.title + ' — weed';
      }
      const running = this.jobs.filter(j => j.status === 'running');
      if (running.length === 1) return `⬇ ${running[0].pct}% — weed`;
      if (running.length > 1) return `⬇ ${running.length} downloading — weed`;
      return 'weed';
    },
    // The server's idea of "your phone's own address" beats the browser's:
    // location.origin only reflects whatever address *this* browser used
    // to load the page, which is 127.0.0.1 the instant someone opens it
    // via localhost -- exactly the bug a LAN-bound server needs to avoid
    // handing a phone a QR code that points right back at the desktop
    // machine.
    qrBaseUrl() {
      return this.lanUrlBase || (location.origin + '/');
    },
    qrPopupStyle() {
      return {
        top: this.qr.top + 'px',
        left: this.qr.left != null ? this.qr.left + 'px' : 'auto',
        right: this.qr.right != null ? this.qr.right + 'px' : 'auto',
      };
    },
    playlistPickerStyle() {
      return {
        top: this.playlistPicker.top + 'px',
        left: this.playlistPicker.left != null ? this.playlistPicker.left + 'px' : 'auto',
        right: this.playlistPicker.right != null ? this.playlistPicker.right + 'px' : 'auto',
      };
    },
    // null unless the player's current queue actually came from a
    // playlist (see player.queue's own comment) -- the "Add to playlist"
    // picker uses this to mark whichever playlist that is, so it's clear
    // at a glance which one (if any) is actually playing right now
    // rather than just which playlist a track happens to also sit in.
    playingPlaylistId() {
      return (this.player.visible && this.player.queue) ? this.player.queue.playlistId : null;
    },
  },

  watch: {
    pageTitle: {
      immediate: true,
      handler(title) { document.title = title; },
    },
    // replaceState, not pushState -- a tab switch isn't a "page" the
    // back button should step through one at a time (that would make
    // Back undo your last few tab clicks instead of leaving the site,
    // surprising and not what "keep my tab on refresh" was asking for),
    // it's just where a refresh should land you back at.
    activeTab(tab) {
      history.replaceState(null, '', '#' + tab);
    },
    // starts/stops the live audio feed to the orbit visualizer iframe --
    // one place reacting to the flag instead of every single toggle site
    // (the secret-code trigger, Esc, backdrop click, the iframe's own
    // BACK button) each remembering to start/stop it themselves.
    easterEggVisible(visible) {
      if (visible) this.$nextTick(() => this.startOrbitVizFeed());
      else this.stopOrbitVizFeed();
    },
  },

  async mounted() {
    document.addEventListener('click', this.onDocumentClick);
    // covers back/forward and a hand-edited URL bar -- the watch above
    // only ever writes the hash *from* activeTab; this is the other
    // direction, hash changing out from under activeTab
    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (this.tabs.some(t => t.id === id)) this.activeTab = id;
    });
    document.addEventListener('keydown', this.onGlobalKeydown);
    // orbit_sequencer.html's own "< BACK" button posts this to whatever
    // parent embedded it (harmless no-op if nothing's listening, see its
    // own onclick) -- this is that listener, so the button it already
    // ships with actually closes the easter egg here too
    window.addEventListener('message', e => {
      if (e.data === 'orbit:back') this.easterEggVisible = false;
    });

    const { pubkey } = await this.apiGet('/api/whoami');
    this.pubkey = pubkey;

    // must be awaited (not fire-and-forget) *before* refreshDiscover()
    // below -- otherwise the very first auto-discover on load races this
    // and fires against the hardcoded loopback default regardless of
    // $WEED_RELAY, which is exactly the bug this fixes: running
    // web_ui.py directly used to ignore $WEED_RELAY/$WEED_TUNNEL
    // entirely even though weed.py's CLI/shell already honored them
    const config = await this.apiGet('/api/config');
    this.lanUrlBase = config.lan_url;
    if (config.default_relay) {
      this.discoverRelays = config.default_relay;
      this.hostForm.relays = config.default_relay;
      this.downloadForm.relays = config.default_relay;
    }
    if (config.default_tunnel) {
      this.hostForm.tunnelEnabled = true;
      this.hostForm.tunnelAddr = config.default_tunnel;
    }

    const lib = await this.apiGet('/api/library');
    for (const d of lib.downloads || []) this.library.downloads[d.content_hash] = d;
    this.library.likes = new Set(lib.likes || []);
    this.library.subscriptions = new Set(lib.subscriptions || []);
    this.library.playlists = (lib.playlists || []).map(p => ({ ...p, _editing: false, _nameDraft: '' }));
    this.library.history = lib.history || [];
    for (const d of lib.downloads || []) {
      this.jobs.push({
        job_id: d.job_id, content_hash: d.content_hash, pct: 0, status: 'done',
        path: d.path, error: null, size: d.size, bps: d.bps, title: d.title,
        signer_pubkey: d.signer_pubkey,
      });
    }

    this.refreshDiscover();
    this.refreshHosts();
    setInterval(this.refreshHosts, 3000);
  },

  methods: {
    // ── small fetch helpers ──────────────────────────────────────────
    async apiGet(path) {
      const res = await fetch(path);
      return res.json();
    },
    async apiPost(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    splitRelays(str) {
      return str.split(',').map(s => s.trim()).filter(Boolean);
    },
    shortHash(h, n = 10) {
      return h ? h.slice(0, n) + '…' : '';
    },
    // ts is epoch seconds (Python's time.time(), straight off
    // last_played/played_at) or falsy (never played) -- coarse buckets
    // are enough for a table cell; the exact timestamp is still available
    // in the title attribute wherever this is used.
    relativeTime(ts) {
      if (!ts) return '—';
      const secs = Date.now() / 1000 - ts;
      if (secs < 60) return 'just now';
      if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
      if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
      if (secs < 2592000) return Math.floor(secs / 86400) + 'd ago';
      return Math.floor(secs / 2592000) + 'mo ago';
    },
    // the captured log (see web_ui.py's _job_logs) is every real line
    // node.py printed so far -- discovery/auction/challenge detail, not
    // just chunk progress -- but a table cell only has room for a status
    // line, not a scrollback, so just the most recent one
    lastLogLine(log) {
      if (!log) return '';
      const lines = log.trim().split('\n');
      return lines[lines.length - 1];
    },
    // ott_status (see web_ui.py's _ott_status, sourced straight from the
    // archive's own .ott/ledger.jsonl) answers "has this actually been
    // recorded to Bitcoin, and when" -- null means no archive_dir yet or
    // btcvm/ott isn't importable server-side, not "definitely not committed"
    ottStatusText(status) {
      if (!status) return '—';
      if (!status.committed) return '⚠️ uncommitted';
      return status.tx_hash ? '✅ block ' + status.block_height : '⏱ block ' + status.block_height;
    },
    ottStatusTitle(status) {
      if (!status) return 'no .ott/ archive found, or btcvm not installed server-side';
      if (!status.committed) return 'current archive state has not been committed (run `ott commit`)';
      const when = status.ts ? ' at ' + status.ts : '';
      return status.tx_hash
        ? `committed to Bitcoin block ${status.block_height}${when}, broadcast as ${status.tx_hash} [${status.network}]`
        : `timestamped against Bitcoin block ${status.block_height}${when}, not yet broadcast on-chain (run \`ott broadcast\`)`;
    },
    formatBytes(n) {
      if (n == null) return '';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
    },
    // shown once a download finishes -- size always, speed only if it took
    // long enough to measure (see web_ui.py's elapsed > 0 guard)
    statsText(rec) {
      if (!rec || rec.size == null) return '';
      return this.formatBytes(rec.size) + (rec.bps != null ? ' · ' + this.formatBytes(rec.bps) + '/s' : '');
    },

    // ── QR popup ──────────────────────────────────────────────────────
    toggleQr(event, url) {
      const anchorEl = event.currentTarget;
      if (this.qr.visible && this.qr.url === url) {
        this.qr.visible = false;
        return;
      }
      this.qr.url = url;
      const rect = anchorEl.getBoundingClientRect();
      this.qr.top = rect.bottom + window.scrollY + 6;
      // grows from the button's left edge normally, but that overflows
      // off the viewport for the Discover table's phone/share column (the
      // rightmost thing on the page) -- flip to growing from the right
      // edge whenever there isn't room, e.g. the header's own phone
      // button (near the left edge) is unaffected and keeps growing
      // rightward
      const popupWidth = 232; // ~200px QR image + popup padding/border
      if (rect.left + popupWidth > window.innerWidth) {
        this.qr.left = null;
        this.qr.right = window.innerWidth - rect.right;
      } else {
        this.qr.right = null;
        this.qr.left = rect.left + window.scrollX;
      }
      this.qr.visible = true;
    },
    onDocumentClick(e) {
      if (this.qr.visible) {
        const insidePopup = this.$refs.qrPopup && this.$refs.qrPopup.contains(e.target);
        if (!insidePopup && !e.target.closest('.qr-btn, .qr-toggle')) this.qr.visible = false;
      }
      if (this.playlistPicker.visible) {
        const insidePicker = this.$refs.playlistPicker && this.$refs.playlistPicker.contains(e.target);
        if (!insidePicker && !e.target.closest('.playlist-add-btn')) this.playlistPicker.visible = false;
      }
    },

    showError(message) {
      this.errorDialog.message = message;
      this.errorDialog.visible = true;
    },
    closeError() {
      this.errorDialog.visible = false;
    },

    // ── global video player: PIP ↔ theater ↔ fullscreen ─────────────────
    // :fullscreen is handled entirely in CSS, so Esc-to-exit (which
    // bypasses our own button) still lands back in whichever of
    // pip/theater it was in before, with no extra JS bookkeeping.
    // queue is only ever passed by playPlaylist/onPlayerEnded -- every
    // ordinary "▶ Play" click omits it -- rather than leaving player.queue
    // null (no queue at all), that builds a fresh one-item ad-hoc queue
    // below, with playlistId: null marking it as not backed by any saved
    // playlist. This is the "Currently Playing" queue the playlist-picker
    // popup offers to add to (see its own template block in index.html
    // and addToQueue) whenever nothing explicit is driving playback --
    // without it, playing anything outside a real playlist had no queue
    // at all to add a "play next" onto. Manually picking a different
    // video (any call here that isn't itself continuing an existing
    // queue) still correctly starts a *new* one-item queue rather than
    // appending to the old, since that's exactly the "I'm done following
    // that queue" signal the old comment already described.
    openPlayer(jobId, title, contentHash, signerPubkey, queue = null) {
      this.player.jobId = jobId;
      this.player.title = title || jobId;
      this.player.contentHash = contentHash || null;
      this.player.signerPubkey = signerPubkey || null;
      // Only defaults to pip on a genuinely fresh open (the player wasn't
      // already showing something) -- this used to reset to 'pip'
      // unconditionally, which meant skipping to the next/previous track
      // while watching in theater (or fullscreen) mode snapped straight
      // back to the docked corner every single time, since Next/Prev and
      // the auto-advance on 'ended' all route through this same method.
      // Loading a *different* video into an already-open player keeps
      // whatever mode it's already in for the same reason -- there's no
      // good reason switching tracks should ever fight the size you
      // already chose to watch in.
      if (!this.player.visible) this.player.mode = 'pip';
      this.player.visible = true;
      this.player.queue = queue || {
        items: [{ content_hash: contentHash, title: title || null, signer_pubkey: signerPubkey || null }],
        index: 0, playlistId: null,
      };
      this.$nextTick(() => {
        const video = this.$refs.playerVideo;
        video.src = '/api/stream/' + jobId;
        video.autoplay = true;
      });
      this.recordPlay(contentHash, this.player.title);
    },
    // Every real "start watching this" funnels through openPlayer above
    // (Discover's ▶ Play, a Downloads row, a playlist item, onPlayerEnded's
    // auto-advance) -- one call site here means play_count/last_played/
    // history can't drift out of sync from some path bumping one but not
    // the other. Deliberately NOT hooked off the <video>'s own play/pause
    // events: those fire on every seek/buffer-recovery/tab-refocus, which
    // would wildly overcount a single sit-down-and-watch as dozens of
    // "plays." Fire-and-forget -- a lost play-history entry from a flaky
    // request is not worth blocking or erroring playback over.
    recordPlay(contentHash, title) {
      if (!contentHash) return;
      const rec = this.library.downloads[contentHash];
      if (rec) {
        rec.play_count = (rec.play_count || 0) + 1;
        rec.last_played = Date.now() / 1000;
      }
      this.library.history.unshift({ content_hash: contentHash, title, played_at: Date.now() / 1000 });
      this.apiPost('/api/play', { content_hash: contentHash, title }).catch(() => {});
    },
    closePlayer() {
      if (document.fullscreenElement === this.$refs.globalPlayer) document.exitFullscreen();
      const video = this.$refs.playerVideo;
      video.pause();
      video.removeAttribute('src');
      video.load();
      this.player.visible = false;
      this.player.isPlaying = false;
      this.player.queue = null;
    },
    setPlayerMode(mode) {
      const el = this.$refs.globalPlayer;
      if (el) {
        el.classList.add('mode-transitioning');
        // clear any manual drag/resize from the mode this is leaving (or
        // entering) -- inline styles outrank the mode-pip/mode-theater
        // CSS rules, so a leftover drag position (or, for theater, the
        // transform onPlayerHeaderPointerDown neutralizes mid-drag --
        // see its own comment) would otherwise still win over the new
        // mode's own layout.
        el.style.top = '';
        el.style.left = '';
        el.style.right = '';
        el.style.bottom = '';
        el.style.width = '';
        el.style.height = '';
        el.style.transform = '';
        setTimeout(() => el.classList.remove('mode-transitioning'), 220);
      }
      this.player.mode = mode;
    },
    togglePlayerMode() {
      this.setPlayerMode(this.player.mode === 'theater' ? 'pip' : 'theater');
    },
    // Dragging (PIP and theater both -- fullscreen is a real browser
    // state with its own layout, not something to drag) shares the
    // header with the existing click-to-toggle behavior, so pointerdown
    // starts tracking movement and only *becomes* a drag past a small
    // threshold; a real drag sets a one-shot flag that suppresses the
    // click event the browser still fires afterward, so it doesn't also
    // toggle the mode on top of the move.
    onPlayerHeaderPointerDown(e) {
      if (e.target.closest('button')) return;
      if (this.player.mode !== 'pip' && this.player.mode !== 'theater') return;
      const el = this.$refs.globalPlayer;
      const rect = el.getBoundingClientRect();
      if (this.player.mode === 'theater') {
        // mode-theater centers via top/left: 50% + transform:
        // translate(-50%, -50%), so the drag math below (which moves the
        // box by writing plain top/left pixels) would fight that
        // transform every frame instead of tracking the cursor. Pinning
        // the box to its own current on-screen rect and dropping the
        // transform right now -- before the first pointermove -- swaps
        // to the same plain top/left model PIP already uses with zero
        // visual jump, since rect.left/top already account for the
        // transform that's being removed.
        el.style.left = rect.left + 'px';
        el.style.top = rect.top + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
      }
      this._drag = { moved: false, startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
      window.addEventListener('pointermove', this.onPlayerDragMove);
      window.addEventListener('pointerup', this.onPlayerDragEnd, { once: true });
    },
    onPlayerDragMove(e) {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.startX;
      const dy = e.clientY - this._drag.startY;
      // a finger's contact area shifts a few px just from how a tap
      // naturally presses and lifts, well past what a mouse click ever
      // drifts by -- a 4px threshold tuned for a mouse cursor was
      // classifying an ordinary tap-to-toggle-mode as a drag before it
      // ever reached the click handler, on touch every time.
      const threshold = e.pointerType === 'touch' ? 10 : 4;
      if (!this._drag.moved && Math.hypot(dx, dy) < threshold) return;
      this._drag.moved = true;
      const el = this.$refs.globalPlayer;
      // keep at least a corner on-screen instead of letting it get
      // dragged somewhere unrecoverable
      const left = Math.min(Math.max(this._drag.startLeft + dx, -el.offsetWidth + 60), window.innerWidth - 60);
      const top = Math.min(Math.max(this._drag.startTop + dy, 0), window.innerHeight - 40);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    },
    onPlayerDragEnd() {
      window.removeEventListener('pointermove', this.onPlayerDragMove);
      if (this._drag && this._drag.moved) this._suppressNextClick = true;
      this._drag = null;
    },
    onPlayerHeaderClick(e) {
      if (e.target.closest('button')) return;
      if (this._suppressNextClick) { this._suppressNextClick = false; return; }
      this.togglePlayerMode();
    },
    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.$refs.globalPlayer.requestFullscreen();
    },
    // PIP → Theater → Fullscreen → PIP → ... -- the `f` hotkey's one job,
    // so pressing it repeatedly walks every size the player actually has
    // instead of just flipping fullscreen on/off and leaving pip/theater
    // as a separate, unreachable-by-keyboard click-only toggle. Fullscreen
    // isn't a third value of player.mode (it's a real browser API state,
    // :fullscreen in CSS, see openPlayer's docstring) -- exiting it here
    // also resets mode back to 'pip' so the cycle actually closes the
    // loop, rather than dropping back into whatever theater/pip it
    // started from (which is still exactly what Esc does, unchanged).
    cyclePlayerMode() {
      if (document.fullscreenElement === this.$refs.globalPlayer) {
        document.exitFullscreen();
        this.setPlayerMode('pip');
      } else if (this.player.mode === 'pip') {
        this.setPlayerMode('theater');
      } else {
        this.$refs.globalPlayer.requestFullscreen();
      }
    },

    // ── discover ──────────────────────────────────────────────────────
    // Clicking a column header once activates that column (Plays/Last
    // played default to descending -- "most/most-recently played first"
    // is the useful direction to land on immediately; Title defaults to
    // ascending, A-Z); clicking the *same* header again just flips
    // direction, matching the sortable-table convention most spreadsheet/
    // file-browser UIs already use, rather than adding a third click that
    // clears back to unsorted.
    setDiscoverSort(column) {
      if (this.discoverSortBy === column) {
        this.discoverSortDir = this.discoverSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.discoverSortBy = column;
        this.discoverSortDir = column === 'title' ? 'asc' : 'desc';
      }
    },
    async refreshDiscover() {
      this.discoverLoading = true;
      try {
        const relays = this.discoverRelaysList;
        const qs = relays.map(r => 'relay=' + encodeURIComponent(r)).join('&');
        const { results } = await this.apiGet('/api/discover?' + qs);
        this.discoverResults = (results || []).map(r => ({
          ...r,
          _dl: { downloading: false, pct: 0, log: '' },
          _verify: { busy: false, label: 'Verify', title: '' },
        }));
        this.searchHighlightHash = null;
      } finally {
        this.discoverLoading = false;
      }
    },

    // App-wide hotkeys -- deliberately bare keys (no modifier), so every
    // one of them has to be dead certain it's not intercepting real
    // typing. Escape is the one exception let through while an input is
    // focused (it also needs to blur that input, not just close dialogs);
    // everything else below the `typing` check bails out immediately
    // rather than firing while someone's mid-sentence in a text field.
    onGlobalKeydown(e) {
      const active = document.activeElement;
      const typing = !!active && (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable
      );

      if (e.key === 'Escape') {
        // closest-thing-first: only ever undoes one layer per press, same
        // as a browser's own Esc-closes-the-topmost-thing convention
        if (this.qr.visible) { this.qr.visible = false; return; }
        if (this.easterEggVisible) { this.easterEggVisible = false; return; }
        if (this.player.visible) { this.closePlayer(); return; }
        if (this.errorDialog.visible) { this.closeError(); return; }
        if (this.shortcutsVisible) { this.shortcutsVisible = false; return; }
        if (typing) active.blur();
        return;
      }

      if (e.key === '?' && !typing) {
        e.preventDefault();
        this.shortcutsVisible = !this.shortcutsVisible;
        return;
      }

      if (typing) return;

      if (e.key === '/') {
        e.preventDefault();
        this.activeTab = 'discover';
        // the search box lives inside .discover-filters, collapsed by
        // default below the mobile breakpoint (see discoverFiltersOpen)
        // -- focus() on a display:none input is a silent no-op, so open
        // it first or '/' would look like it just did nothing there
        this.discoverFiltersOpen = true;
        this.$nextTick(() => this.$refs.searchInput && this.$refs.searchInput.focus());
        return;
      }

      const tabByDigit = { '1': 'discover', '2': 'host', '3': 'downloads', '4': 'playlists', '5': 'identity-tab' };
      if (tabByDigit[e.key]) {
        this.activeTab = tabByDigit[e.key];
        return;
      }

      if (e.key === 'r' && this.activeTab === 'discover') {
        e.preventDefault();
        this.refreshDiscover();
        return;
      }

      if (e.key === 'f' && this.player.visible) {
        this.cyclePlayerMode();
        return;
      }

      // Next/Prev track -- playQueueOffset already no-ops without a
      // queue or past either end, so no extra guard needed here beyond
      // "a player is actually open"
      if (e.key === 'n' && this.player.visible) {
        this.playQueueOffset(1);
        return;
      }
      if (e.key === 'p' && this.player.visible) {
        this.playQueueOffset(-1);
        return;
      }

      if (e.key === ' ' && this.player.visible) {
        // preventDefault matters here beyond "don't scroll the page"
        // (Space's other native default): whatever last had focus (e.g.
        // the Play button you just clicked) still has it, and Space's
        // *other* native behavior is "activate the focused button" --
        // without this, pausing here would also re-fire that button's
        // own click right after, an entirely separate, surprising second
        // action.
        e.preventDefault();
        const video = this.$refs.playerVideo;
        if (video.paused) video.play(); else video.pause();
      }
    },

    // Up/Down move a highlight through the currently-filtered rows;
    // Enter/Space act on whichever one is highlighted -- Play if it's
    // already downloaded, otherwise Download (there's nothing to "play"
    // yet, so this is the closest equivalent to hitting that row's own
    // primary button)
    onSearchKeydown(e) {
      const list = this.sortedDiscoverResults;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!list.length) return;
        let idx = this.highlightedIndex;
        if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(idx + 1, list.length - 1);
        else idx = idx < 0 ? list.length - 1 : Math.max(idx - 1, 0);
        this.searchHighlightHash = list[idx].content_hash;
        this.$nextTick(() => {
          const el = document.querySelector(`tr[data-hash="${CSS.escape(this.searchHighlightHash)}"]`);
          if (el) el.scrollIntoView({ block: 'nearest' });
        });
      } else if (e.key === 'Enter' || e.key === ' ') {
        const r = list[this.highlightedIndex];
        if (!r) return;
        e.preventDefault();
        const rec = this.library.downloads[r.content_hash];
        if (rec) {
          this.openPlayer(rec.job_id, r.title || rec.title || this.shortHash(r.content_hash),
            r.content_hash, r.signer_pubkey || rec.signer_pubkey);
        } else if (!r._dl.downloading) {
          this.download(r);
        }
      } else if (e.key === 'Escape' && this.discoverSearch) {
        // only when there's actually something to clear -- an empty
        // search box falls through untouched, so Esc still bubbles up to
        // its usual global job (closing the player/popups/shortcuts list)
        // instead of eating the keystroke for nothing.
        e.preventDefault();
        this.clearDiscoverSearch();
      }
    },
    // The search box's own ✕ button, and Escape above -- one place that
    // clears the query text, drops any stale row highlight left over
    // from arrow-key navigation (that hash may not even match anything
    // once the filter resets), and returns focus to the box so typing a
    // fresh search doesn't need an extra click first.
    clearDiscoverSearch() {
      this.discoverSearch = '';
      this.searchHighlightHash = null;
      this.$nextTick(() => this.$refs.searchInput && this.$refs.searchInput.focus());
    },

    // Handles both the first Download and any later Re-download click for
    // a Discover row -- both need the exact same row-fills-in-as-
    // progress-bar dance (see .dl-progress-row), just starting from a
    // different button.
    async download(r) {
      r._dl.downloading = true;
      r._dl.pct = 0;
      r._dl.log = '';
      const resp = await this.startDownload(
        r.content_hash, this.discoverRelaysList, null, false, null, r.title, r.signer_pubkey,
        {
          onProgress: pct => { r._dl.pct = pct; },
          onLog: log => { r._dl.log = log; },
          onDone: job => {
            r._dl.downloading = false;
            this.library.downloads[r.content_hash] = {
              content_hash: r.content_hash, job_id: job.job_id, path: job.path,
              title: r.title, size: job.size, bps: job.bps, signer_pubkey: r.signer_pubkey,
            };
          },
          onError: err => {
            r._dl.downloading = false;
            this.showError('error: ' + err);
          },
        },
      );
      if (resp.error) {
        r._dl.downloading = false;
        this.showError('error: ' + resp.error);
      }
    },

    async verify(r) {
      r._verify.busy = true;
      r._verify.label = 'Verifying…';
      const result = await this.apiPost('/api/verify', {
        content_hash: r.content_hash, relay: this.discoverRelaysList[0],
      });
      if (result.error) {
        this.showError('verify error: ' + result.error);
        r._verify.label = 'Verify';
        r._verify.busy = false;
        return;
      }
      r._verify.label = result.ok ? '✓ Verified' : '✗ Mismatch';
      r._verify.title = result.ok
        ? `all ${result.n_chunks} chunks match`
        : `${result.mismatches.length} of ${result.n_chunks} chunks don't match`;
      // self-resets instead of staying "✓ Verified" forever, so a stale
      // result can't be mistaken for a check that just happened
      setTimeout(() => {
        r._verify.label = 'Verify';
        r._verify.title = '';
        r._verify.busy = false;
      }, 3000);
    },

    // takes a plain content_hash rather than a whole Discover row object
    // so the player header (which only ever knows content_hash/
    // signer_pubkey, not a full discover result) can call the exact same
    // logic instead of a separate copy
    async like(contentHash) {
      await this.apiPost('/api/like', { content_hash: contentHash, relay: this.discoverRelaysList[0] });
      this.library.likes.add(contentHash);
    },

    // outline -> filled star on subscribe, same toggle language as
    // GitHub/Twitter follow stars
    async subscribe(signerPubkey) {
      await this.apiPost('/api/subscribe', { target_pubkey: signerPubkey, relay: this.discoverRelaysList[0] });
      this.library.subscriptions.add(signerPubkey);
    },

    // ── playlists ─────────────────────────────────────────────────────
    // item is {content_hash, title, signer_pubkey} -- a Discover result
    // or a Downloads job both already carry exactly this shape, so
    // callers just pass the row/job itself (or the equivalent plain
    // object for the player header's own "+ Playlist" button).
    openPlaylistPicker(event, item) {
      const anchorEl = event.currentTarget;
      if (this.playlistPicker.visible && this.playlistPicker.item === item) {
        this.playlistPicker.visible = false;
        return;
      }
      this.playlistPicker.item = item;
      const rect = anchorEl.getBoundingClientRect();
      this.playlistPicker.top = rect.bottom + window.scrollY + 6;
      // same overflow-flip trick as toggleQr -- this can open from the
      // Discover table's rightmost columns too
      const popupWidth = 220;
      if (rect.left + popupWidth > window.innerWidth) {
        this.playlistPicker.left = null;
        this.playlistPicker.right = window.innerWidth - rect.right;
      } else {
        this.playlistPicker.right = null;
        this.playlistPicker.left = rect.left + window.scrollX;
      }
      this.newPlaylistName = '';
      this.playlistPicker.visible = true;
    },
    // server hands back the *whole* updated playlist on every mutation
    // rather than just an ok/error -- findable-and-replaceable here in
    // one line, instead of every caller re-deriving what its own edit
    // should have produced (which is exactly how the items-array
    // ordering from move() could quietly drift out of sync with what the
    // server actually did).
    _applyPlaylist(playlist) {
      const idx = this.library.playlists.findIndex(p => p.id === playlist.id);
      const withUiState = { ...playlist, _editing: false, _nameDraft: '' };
      if (idx === -1) this.library.playlists.push(withUiState);
      else this.library.playlists[idx] = withUiState;
    },
    async addToPlaylist(playlistId) {
      const item = this.playlistPicker.item;
      const resp = await this.apiPost('/api/playlists/add', {
        playlist_id: playlistId, content_hash: item.content_hash,
        title: item.title || null, signer_pubkey: item.signer_pubkey || null,
      });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
      this.playlistPicker.visible = false;
      // The whole point of a playlist is "stuff I can just hit Play
      // through" -- an item sitting in it still undownloaded defeats
      // that the first time playPlaylist reaches it (silently skipped,
      // see its own comment on why it doesn't auto-download mid-queue).
      // Grabbing it now, right when it's added, avoids that gap instead
      // of leaving it as a manual follow-up step. item._dl only exists
      // on a Discover row (the download() this reuses is written against
      // that shape, see its own comment) -- a Downloads job added here
      // is already downloaded by definition, so there's never anything
      // to start for one of those.
      if (item._dl && !item._dl.downloading && !this.library.downloads[item.content_hash]) {
        this.download(item);
      }
    },
    // Lets the picker start playback directly instead of always meaning
    // "add this item, then go find the playlist yourself to press Play
    // all" -- reuses playPlaylist as-is (same "skip anything not
    // downloaded yet, or show an error if nothing in it is" behavior),
    // this just closes the popup afterward like every other picker
    // action already does.
    playPlaylistFromPicker(pl) {
      this.playlistPicker.visible = false;
      this.playPlaylist(pl);
    },
    // The playlist-picker's "▶ Currently Playing" entry (see index.html,
    // shown only while something's playing and no *real* playlist is
    // driving it -- see playingPlaylistId) -- purely client-side, unlike
    // addToPlaylist: this appends to the in-memory queue actually
    // driving playback right now (onPlayerEnded/playQueueOffset already
    // walk player.queue.items generically, playlistId or not), not to
    // anything saved server-side. Same eager-download nudge addToPlaylist
    // already does, for the same reason: an item still sitting
    // undownloaded when playback reaches it would otherwise just get
    // silently skipped.
    addToQueue(item) {
      if (!this.player.queue) return;
      this.player.queue.items.push(
        { content_hash: item.content_hash, title: item.title || null, signer_pubkey: item.signer_pubkey || null });
      this.playlistPicker.visible = false;
      if (item._dl && !item._dl.downloading && !this.library.downloads[item.content_hash]) {
        this.download(item);
      }
    },
    // The Playlists tab's own "Currently Playing" card (see index.html)
    // -- jumps straight to a specific position in whatever queue is
    // actually live, ad-hoc or real playlist alike. Deliberately its own
    // small method rather than reusing playPlaylistItem: that one
    // re-derives the clicked item's index via a downloaded-only filter +
    // findIndex(content_hash), which would resolve to the *first* match
    // instead of the row actually clicked if the same content_hash was
    // queued more than once (routine for an ad-hoc queue, since
    // addToQueue never dedupes) -- indexing by the row's own position
    // sidesteps that ambiguity entirely.
    playQueueIndex(idx) {
      const q = this.player.queue;
      if (!q) return;
      const target = q.items[idx];
      if (!target) return;
      const rec = this.library.downloads[target.content_hash];
      if (!rec) return;
      this.openPlayer(rec.job_id, target.title || rec.title || this.shortHash(target.content_hash),
        target.content_hash, target.signer_pubkey || rec.signer_pubkey,
        { items: q.items, index: idx, playlistId: q.playlistId });
    },
    // Removing a not-yet-reached queue slot shifts the still-playing
    // index back by one so it keeps pointing at the same track; removing
    // something *before* the current position never happens from this
    // card's own UI (nothing renders a remove button for past items
    // specially), but clamping index into range regardless costs nothing
    // and avoids ever pointing past the new end of the array.
    removeFromQueue(idx) {
      const q = this.player.queue;
      if (!q) return;
      q.items.splice(idx, 1);
      if (idx < q.index) q.index -= 1;
      q.index = Math.min(q.index, q.items.length - 1);
    },
    // Keeps only what's actually playing right now, dropping every other
    // queued-up track -- the ad-hoc queue's equivalent of "empty this
    // playlist," since there's no saved playlist here to delete outright.
    clearQueueExceptCurrent() {
      const q = this.player.queue;
      if (!q) return;
      q.items = [q.items[q.index]];
      q.index = 0;
    },
    async createPlaylistAndAdd() {
      const name = this.newPlaylistName.trim();
      if (!name) return;
      const resp = await this.apiPost('/api/playlists/create', { name });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
      await this.addToPlaylist(resp.playlist.id);
    },
    // Playlists tab's own create form -- an empty playlist with nothing
    // added yet, unlike createPlaylistAndAdd above (always paired with an
    // item from wherever the picker was opened)
    async createPlaylistOnly() {
      const name = this.newPlaylistNameStandalone.trim();
      if (!name) return;
      const resp = await this.apiPost('/api/playlists/create', { name });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
      this.newPlaylistNameStandalone = '';
    },
    async removeFromPlaylist(playlistId, contentHash) {
      const resp = await this.apiPost('/api/playlists/remove', { playlist_id: playlistId, content_hash: contentHash });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
    },
    // The whole row is the play target now, not a separate button (see
    // .playlist-item-clickable) -- a no-op for a not-yet-downloaded item
    // rather than an error, same as the old button simply not rendering
    // for one; "not downloaded" is already shown right there on the row.
    // Builds a real queue (same downloaded-only filter playPlaylist's
    // "Play all" already uses) rather than just opening this one track
    // standalone -- picking any track in a playlist makes that playlist
    // the active queue starting from there, so Prev/Next/skip (the
    // header/overlay buttons, n/p keys) are available immediately
    // instead of only ever working after specifically hitting "Play all".
    playPlaylistItem(pl, it) {
      const rec = this.library.downloads[it.content_hash];
      if (!rec) return;
      const items = pl.items.filter(x => this.library.downloads[x.content_hash]);
      const index = items.findIndex(x => x.content_hash === it.content_hash);
      this.openPlayer(rec.job_id, it.title || rec.title || this.shortHash(it.content_hash),
        it.content_hash, it.signer_pubkey || rec.signer_pubkey, { items, index, playlistId: pl.id });
    },
    // ── playlist drag-to-reorder / drag-between-playlists ──────────────
    // Native HTML5 drag-and-drop, not a library -- one draggable list,
    // no cross-window/touch requirements, not worth a dependency for.
    // _dragFrom is plain (non-reactive) instance state, same reasoning
    // as the player's own _drag tracking above: it only matters within
    // one drag gesture, nothing ever needs to render off of it directly.
    onItemDragStart(e, playlist, idx) {
      this._dragFrom = { playlistId: playlist.id, index: idx };
      // 'copyMove', not just 'move' -- dropping on a *different*
      // playlist (see onPlaylistCardDragOver/Drop below) moves by
      // default but copies if <Ctrl> is held, so both effects need to
      // be permitted here for that to ever show up as a real cursor
      // (a plain 'move' would silently coerce a copy attempt back to a
      // move regardless of dropEffect).
      e.dataTransfer.effectAllowed = 'copyMove';
      // Firefox won't fire drop at all unless dragstart sets *some* data
      e.dataTransfer.setData('text/plain', String(idx));
    },
    onItemDragEnd() {
      this._dragFrom = null;
      this.dragOverKey = null;
    },
    // dragOverKey is reactive (unlike _dragFrom) purely to drive the
    // drop-target highlight -- keyed 'playlistId:index' since two
    // playlists' items can share the same index. Deliberately a no-op
    // (not even preventDefault, via the plain @dragover.prevent in the
    // HTML actually doing that part) for a *different* source playlist --
    // dragover bubbles, so leaving this one silent for that case lets it
    // reach onPlaylistCardDragOver on the enclosing .playlist-card
    // instead, which is what actually handles moving/copying between
    // playlists.
    onItemDragOver(e, playlist, idx) {
      if (!this._dragFrom || this._dragFrom.playlistId !== playlist.id) return;
      e.dataTransfer.dropEffect = 'move'; // reordering within one playlist is never a "copy"
      this.dragOverKey = playlist.id + ':' + idx;
    },
    async onItemDrop(e, playlist, idx) {
      // Must NOT touch this._dragFrom/dragOverKey before checking whose
      // drop this actually is -- a cross-playlist drop landing on one of
      // *this* playlist's own item rows (extremely natural to do; you're
      // aiming at the list, not its empty padding) reaches this handler
      // first during bubbling, before onPlaylistCardDrop on the
      // enclosing .playlist-card ever sees the event. Clearing the
      // shared drag state here unconditionally -- the previous version
      // of this did exactly that -- wiped it out before the card-level
      // handler could read it, so the highlight showed (dragover isn't
      // destructive) but the actual move/copy silently never happened.
      const from = this._dragFrom;
      if (!from || from.playlistId !== playlist.id) return;
      this.dragOverKey = null;
      this._dragFrom = null;
      if (from.index === idx) return;
      const items = playlist.items.slice();
      const [moved] = items.splice(from.index, 1);
      items.splice(idx, 0, moved);
      playlist.items = items; // optimistic -- server call below just confirms it
      const resp = await this.apiPost('/api/playlists/reorder',
        { playlist_id: playlist.id, order: items.map(it => it.content_hash) });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
    },
    // Dropping on a *different* playlist's card -- its background, the
    // "empty" message, or any of its own items (onItemDragOver/onItemDrop
    // above deliberately leave a cross-playlist drag alone rather than
    // consuming the event, so it bubbles up here regardless of exactly
    // where within the card the cursor happens to be) -- moves the
    // dragged track there by default; held <Ctrl> copies it instead,
    // leaving the source playlist untouched. Always appends to the end
    // of the target rather than trying to land at a precise position --
    // reordering once it's there is what within-playlist drag already
    // does, this is just "get it into the other list."
    onPlaylistCardDragOver(e, playlist) {
      if (!this._dragFrom || this._dragFrom.playlistId === playlist.id) return;
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      this.dragOverKey = playlist.id + ':card';
    },
    onPlaylistCardDragLeave(e, playlist) {
      if (this.dragOverKey === playlist.id + ':card') this.dragOverKey = null;
    },
    async onPlaylistCardDrop(e, playlist) {
      this.dragOverKey = null;
      const from = this._dragFrom;
      this._dragFrom = null;
      if (!from || from.playlistId === playlist.id) return;
      const sourcePlaylist = this.library.playlists.find(p => p.id === from.playlistId);
      const item = sourcePlaylist && sourcePlaylist.items[from.index];
      if (!item) return;
      const copy = e.ctrlKey;
      const addResp = await this.apiPost('/api/playlists/add', {
        playlist_id: playlist.id, content_hash: item.content_hash,
        title: item.title || null, signer_pubkey: item.signer_pubkey || null,
      });
      if (addResp.error) { this.showError('error: ' + addResp.error); return; }
      this._applyPlaylist(addResp.playlist);
      if (copy) return;
      const removeResp = await this.apiPost('/api/playlists/remove',
        { playlist_id: sourcePlaylist.id, content_hash: item.content_hash });
      if (removeResp.error) { this.showError('error: ' + removeResp.error); return; }
      this._applyPlaylist(removeResp.playlist);
    },
    async deletePlaylist(playlistId) {
      await this.apiPost('/api/playlists/delete', { playlist_id: playlistId });
      this.library.playlists = this.library.playlists.filter(p => p.id !== playlistId);
    },
    // click-to-edit name, same spirit as everything else here staying
    // plain-input rather than a native prompt() -- prompt() blocks the
    // whole tab and looks like a browser chrome dialog, not part of the app
    startRenamePlaylist(playlist) {
      playlist._nameDraft = playlist.name;
      playlist._editing = true;
      // a fresh v-if="!pl._editing" -> v-else swap isn't focused by the
      // browser on its own; attribute selector rather than a v-for ref
      // (those come back as an array, awkward for "the one that just
      // became editable" specifically)
      this.$nextTick(() => {
        const el = document.querySelector(`[data-playlist-name-input="${playlist.id}"]`);
        if (el) { el.focus(); el.select(); }
      });
    },
    async commitRenamePlaylist(playlist) {
      const name = playlist._nameDraft.trim();
      playlist._editing = false;
      if (!name || name === playlist.name) return;
      const resp = await this.apiPost('/api/playlists/rename', { playlist_id: playlist.id, name });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
    },
    // Plays every already-downloaded item in a playlist, in order, via
    // the global player's queue -- an item nobody's downloaded yet gets
    // skipped rather than auto-triggering a download on your behalf
    // (bandwidth/possession-challenge auctions aren't something "press
    // play" should silently kick off); it's still right there with its
    // own Download button in the list below to grab first.
    playPlaylist(playlist) {
      const items = playlist.items.filter(it => this.library.downloads[it.content_hash]);
      if (!items.length) {
        this.showError('Nothing in this playlist is downloaded yet -- download at least one item first.');
        return;
      }
      const first = items[0];
      const rec = this.library.downloads[first.content_hash];
      this.openPlayer(rec.job_id, first.title || rec.title || this.shortHash(first.content_hash),
        first.content_hash, first.signer_pubkey || rec.signer_pubkey, { items, index: 0, playlistId: playlist.id });
    },
    // advances player.queue on the <video>'s own 'ended' event -- see
    // openPlayer's queue param and playPlaylist above. Only ever walks
    // the *already-filtered*, already-downloaded items list playPlaylist
    // built, so every step here is immediately playable with no download
    // detour mid-queue.
    onPlayerEnded() {
      this.player.isPlaying = false;
      const q = this.player.queue;
      if (!q) return;
      const next = q.items[q.index + 1];
      if (!next) { this.player.queue = null; return; }
      const rec = this.library.downloads[next.content_hash];
      if (!rec) { this.player.queue = null; return; }
      this.openPlayer(rec.job_id, next.title || rec.title || this.shortHash(next.content_hash),
        next.content_hash, next.signer_pubkey || rec.signer_pubkey,
        { items: q.items, index: q.index + 1, playlistId: q.playlistId });
    },
    // Manual Prev/Next (the player header's ⏮/⏭, see index.html) --
    // distinct from onPlayerEnded's own auto-advance above rather than
    // sharing it outright: running past either end there means the
    // whole queue genuinely finished, so it clears player.queue; running
    // past either end here just means the button got clicked at a
    // boundary it should already be disabled at (or Prev on the very
    // first track), and the right response is simply nothing -- the
    // current track (and the rest of the queue) keeps playing
    // undisturbed, not queue getting silently cleared out from under it.
    playQueueOffset(delta) {
      const q = this.player.queue;
      if (!q) return;
      const target = q.items[q.index + delta];
      if (!target) return;
      const rec = this.library.downloads[target.content_hash];
      if (!rec) return;
      this.openPlayer(rec.job_id, target.title || rec.title || this.shortHash(target.content_hash),
        target.content_hash, target.signer_pubkey || rec.signer_pubkey,
        { items: q.items, index: q.index + delta, playlistId: q.playlistId });
    },

    // ── orbit visualizer (easter egg) ────────────────────────────────
    // Lazy + cached forever, not per-open: createMediaElementSource can
    // only ever be called once on a given <video> for its whole
    // lifetime -- a second call throws -- and this app has exactly one
    // <video>, reused for every "▶ Play" for as long as the page stays
    // open. Once tapped here, this element's audio is permanently
    // routed through this Web Audio graph instead of its native output;
    // that's transparent to the ear (source connects straight through
    // to destination, unity gain, nothing else touches the signal) but
    // it does mean this can't be un-done for this element short of a
    // full page reload.
    _ensureOrbitAnalyser() {
      if (this._orbitAnalyser) return this._orbitAnalyser;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextClass();
      const source = ctx.createMediaElementSource(this.$refs.playerVideo);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      source.connect(ctx.destination);
      this._orbitAnalyser = {
        ctx, analyser,
        freq: new Uint8Array(analyser.frequencyBinCount),
        wave: new Uint8Array(analyser.fftSize),
      };
      return this._orbitAnalyser;
    },
    // Small offscreen sample of the actual video frame, cached like the
    // analyser above -- same-origin video (this app only ever streams
    // from its own /api/stream/<job_id>), so drawImage + getImageData
    // here never hits a tainted-canvas security error. ~96x54's worth of
    // pixels (5184, not full video res): this gets read back and posted
    // every couple of frames, and the "orbit visualization" a viewer
    // actually wants is a color/motion impression, not a full-res copy
    // of the video the iframe already can't show behind this dialog
    // anyway -- this is still ~9x the pixel count PIXELS/ASCII actually
    // need to look meaningfully more detailed (see ASCII's own comment
    // on why that resolution ceiling mattered enough to bump), while
    // staying cheap: ~20KB/frame over postMessage, nothing.
    // Sized to the video's own aspect ratio, not fixed at 96x54 -- a
    // flat 16:9 canvas silently squashes any video that isn't already
    // 16:9 (vertical phone footage, 4:3, ...) before orbit_visualizer.html
    // ever sees the pixels, which is what actually caused the reported
    // "video looks stretched" (no amount of aspect-correct drawing on
    // the visualizer's own side can undo a distortion baked in here).
    // Re-picks width/height (same pixel budget, same aspect ratio as the
    // video) whenever the video's own aspect ratio has changed since the
    // canvas was last sized, so switching to a differently-shaped video
    // mid-session doesn't keep sampling through the previous one's shape.
    _ensureOrbitVideoCanvas(video) {
      const aspect = (video && video.videoWidth && video.videoHeight)
        ? video.videoWidth / video.videoHeight : 16 / 9;
      const PIXEL_BUDGET = 96 * 54;
      const w = Math.max(1, Math.round(Math.sqrt(PIXEL_BUDGET * aspect)));
      const h = Math.max(1, Math.round(Math.sqrt(PIXEL_BUDGET / aspect)));
      if (this._orbitVideoCanvas && this._orbitVideoCanvas.canvas.width === w
          && this._orbitVideoCanvas.canvas.height === h) {
        return this._orbitVideoCanvas;
      }
      const canvas = this._orbitVideoCanvas ? this._orbitVideoCanvas.canvas : document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      this._orbitVideoCanvas = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
      return this._orbitVideoCanvas;
    },
    // Web Audio nodes themselves can't cross the iframe boundary (each
    // window/realm has its own AudioContext universe), but the plain
    // Uint8Array snapshots getByteFrequencyData/getByteTimeDomainData
    // fill in are just data -- postMessage structured-clones those
    // straight across every frame, which is all orbit_visualizer.html's
    // own draw loop actually needs (see its own comment on this).
    startOrbitVizFeed() {
      // re-entry guard -- the easterEggVisible watch calls this
      // automatically, so a caller that also calls it directly (or the
      // watch itself firing twice for any reason) would otherwise stack
      // a second concurrent rAF loop, each posting its own copy of
      // every frame
      if (this._orbitVizRunning) return;
      const { ctx, analyser, freq, wave } = this._ensureOrbitAnalyser();
      if (ctx.state === 'suspended') ctx.resume();
      this._orbitVizRunning = true;
      let frameCount = 0;
      const tick = () => {
        if (!this._orbitVizRunning) return;
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);
        const frame = this.$refs.orbitVizFrame;
        if (frame && frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'orbit-audio', freq, wave }, '*');
          // video frames don't need 60fps to look good and drawImage+
          // getImageData is real per-frame cost, unlike the audio
          // analysis above -- every other frame (~30fps) is still
          // plenty smooth for a background visualization
          if (frameCount++ % 2 === 0) {
            const video = this.$refs.playerVideo;
            // readyState >= 2 (HAVE_CURRENT_DATA) is "there's an actual
            // decoded frame to draw" -- before that (nothing loaded, or
            // between openPlayer() setting src and the first frame
            // decoding) drawImage would just paint black, which the
            // visualizer can't tell apart from "a genuinely dark video"
            if (video && video.readyState >= 2 && video.videoWidth > 0) {
              // resolved per-frame, not cached outside tick -- picks up
              // the video's current aspect ratio (see this method's own
              // comment on why that matters for avoiding stretching)
              const { canvas: vcanvas, ctx: vctx } = this._ensureOrbitVideoCanvas(video);
              vctx.drawImage(video, 0, 0, vcanvas.width, vcanvas.height);
              const imageData = vctx.getImageData(0, 0, vcanvas.width, vcanvas.height);
              frame.contentWindow.postMessage(
                { type: 'orbit-video', w: vcanvas.width, h: vcanvas.height, data: imageData.data }, '*');
            }
          }
        }
        requestAnimationFrame(tick);
      };
      tick();
    },
    stopOrbitVizFeed() {
      this._orbitVizRunning = false;
    },

    // ── host ──────────────────────────────────────────────────────────
    async submitHost() {
      this.hostResult = 'starting…';
      const body = {
        archive_dir: this.hostForm.archiveDir,
        file_name: this.hostForm.fileName || null,
        port: Number(this.hostForm.port),
        price: Number(this.hostForm.price),
        relay: this.splitRelays(this.hostForm.relays),
        advertise_host: this.hostForm.advertiseHost,
        tunnel: this.hostForm.tunnelEnabled ? this.hostForm.tunnelAddr : null,
        lightning_node: this.hostForm.lightningNode || null,
      };
      const resp = await this.apiPost('/api/host', body);
      if (resp.error) {
        this.hostResult = 'error: ' + resp.error;
        return;
      }
      this.hostResult = 'hosting started (id ' + resp.host_id + ')';
      this.refreshHosts();
    },
    async refreshHosts() {
      const { hosts } = await this.apiGet('/api/hosts');
      this.hosts = hosts || [];
    },
    // Errored "(starting…)" rows for a since-deleted file or an old
    // archive_dir used to stick around forever, re-appearing with the
    // same error on every startup (most of that class self-heals now,
    // see web_ui.py's _resume_persisted_hosts auto-prune -- this covers
    // whatever doesn't). Now also does double duty as an actual stop
    // button for a still-running host: the backend closes its listening
    // socket, which is the only way to free a port it already has and
    // let a *different* host config (e.g. the whole archive instead of
    // one stale single-file leftover) bind it without restarting the
    // whole process -- see _handle_forget_host's own docstring for the
    // real "Address already in use" report this closes.
    async forgetHost(h) {
      const resp = await this.apiPost('/api/host/forget', { host_id: h.id });
      if (resp.error) {
        this.hostResult = 'error: ' + resp.error;
        return;
      }
      this.refreshHosts();
    },

    // ── drag-and-drop video upload (Host tab) ───────────────────────────
    onHostDropzoneDragOver(e) {
      e.dataTransfer.dropEffect = 'copy';
      this.hostDropzoneActive = true;
    },
    onHostDropzoneDragLeave() {
      this.hostDropzoneActive = false;
    },
    onHostFilesDropped(e) {
      this.hostDropzoneActive = false;
      for (const file of e.dataTransfer.files) this.uploadFile(file);
    },
    // XMLHttpRequest, not fetch, specifically for upload.onprogress --
    // fetch still has no broadly-supported way to observe upload (not
    // download) progress, and a multi-hundred-MB video with zero
    // feedback until it's entirely done is exactly the kind of "is this
    // actually working" moment a progress bar exists to answer.
    uploadFile(file) {
      // Deliberately NOT defaulting an empty archiveDir here (used to
      // fill in './share' client-side) -- that silently diverged from
      // what /api/upload itself defaults to (which, inside the Docker
      // image, is '/share', not './share': see web_ui.py's
      // _handle_upload). Sending whatever's actually in the field (even
      // blank) and letting the server pick the default keeps there being
      // exactly one place that decides, instead of two that can disagree
      // -- a real incident: a file uploaded to the client's guessed
      // './share' (which resolves to /app/share inside the container)
      // while the Host form's own /share was what "host" actually read,
      // so the upload archived successfully but never showed up, and
      // no restart could fix it since the file was never in /share.
      const archiveDir = this.hostForm.archiveDir;
      const entry = { name: file.name, pct: 0, status: 'uploading', error: null, contentHash: null, archiveDir: null };
      this.uploads.push(entry);

      const xhr = new XMLHttpRequest();
      const qs = 'name=' + encodeURIComponent(file.name) + '&archive_dir=' + encodeURIComponent(archiveDir);
      xhr.open('POST', '/api/upload?' + qs);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) entry.pct = Math.round((ev.loaded / ev.total) * 100);
      };
      xhr.onload = () => {
        let resp;
        try { resp = JSON.parse(xhr.responseText); } catch { resp = { error: 'malformed server response' }; }
        if (xhr.status !== 200 || resp.error) {
          entry.status = 'error';
          entry.error = resp.error || `HTTP ${xhr.status}`;
          return;
        }
        entry.pct = 100;
        entry.status = 'done';
        entry.contentHash = resp.content_hash;
        entry.archiveDir = resp.archive_dir;
        // Reflect back the archive_dir the server actually used (which
        // may not match, or may have defaulted from, what the field held
        // at request time) so "Start hosting" is guaranteed to target the
        // same directory the upload actually landed in -- see the note
        // above uploadFile for the bug this closes.
        this.hostForm.archiveDir = resp.archive_dir;
        // the newly-archived file is now the most recent thing in this
        // archive_dir -- fills in fileName so "Start hosting" targets it
        // specifically rather than whatever "most recent" happened to
        // mean before this upload (see hostForm.fileName's own label:
        // "optional, default: most recent" -- this just makes that
        // default explicit and visible instead of implicit).
        this.hostForm.fileName = resp.name;
      };
      xhr.onerror = () => {
        entry.status = 'error';
        entry.error = 'network error during upload';
      };
      xhr.send(file);
    },

    // ── downloads ─────────────────────────────────────────────────────
    // One poll loop per job; any number of listeners (the Downloads-tab
    // jobs table, a Discover row, ...) can watch the same job by passing
    // their own callbacks -- nothing here assumes there's exactly one
    // place a job's progress is shown.
    pollJob(jobId, { onProgress, onLog, onDone, onError }) {
      const timer = setInterval(async () => {
        const job = await this.apiGet('/api/download/' + jobId);
        // the server's job dict never carries its own id (job_id is only
        // ever the _jobs dict *key*, on its side) -- stamp it on here so
        // every listener can rely on job.job_id instead of quietly
        // getting undefined
        job.job_id = jobId;
        if (job.error && !job.status) {
          clearInterval(timer);
          if (onError) onError(job.error);
          return;
        }
        // node.py's own real prints (found N candidate host(s), trust
        // graph, per-candidate challenge results, ...) captured server-side
        // to keep its stdout quiet -- see web_ui.py's _job_logs -- surfaced
        // here instead of a download button just vanishing with nothing to
        // show while discovery/auction/challenge runs before any chunk
        // (and therefore onProgress) ever fires
        if (job.log && onLog) onLog(job.log);
        if (job.n_chunks && onProgress) {
          onProgress(Math.round(100 * (job.idx + 1) / job.n_chunks));
        }
        if (job.status === 'done') {
          clearInterval(timer);
          if (onDone) onDone(job);
        } else if (job.status === 'error') {
          clearInterval(timer);
          if (onError) onError(job.error);
        }
      }, 500);
    },

    async startDownload(contentHash, relays, outPath, lightning, lightningNode, title, signerPubkey, extra) {
      const resp = await this.apiPost('/api/download', {
        content_hash: contentHash, relay: relays, out_path: outPath,
        lightning: lightning, lightning_node: lightning ? lightningNode : null,
        title: title || null, signer_pubkey: signerPubkey || null,
      });
      if (resp.error) return resp;

      this.jobs.push({
        job_id: resp.job_id, content_hash: contentHash, pct: 0, status: 'running', log: '',
        path: null, error: null, size: null, bps: null, title, signer_pubkey: signerPubkey || null,
      });
      // Vue 3's reactivity is proxy-based: mutating a plain object literal
      // through a closure-held reference writes the right data but never
      // passes through the proxy's set trap, so nothing gets told to
      // re-render -- the jobs table (and pageTitle's download-progress
      // text) would silently freeze at whatever it first rendered.
      // Re-finding the job via this.jobs on every update instead means
      // every mutation goes through the reactive array itself.
      const findJob = () => this.jobs.find(j => j.job_id === resp.job_id);

      this.pollJob(resp.job_id, {
        onProgress: pct => {
          const job = findJob();
          if (job) job.pct = pct;
          if (extra && extra.onProgress) extra.onProgress(pct);
        },
        onLog: log => {
          const job = findJob();
          if (job) job.log = log;
          if (extra && extra.onLog) extra.onLog(log);
        },
        onDone: j => {
          const job = findJob();
          if (job) {
            job.status = 'done';
            job.path = j.path;
            job.size = j.size;
            job.bps = j.bps;
          }
          if (extra && extra.onDone) extra.onDone(j);
        },
        onError: err => {
          const job = findJob();
          if (job) {
            job.status = 'error';
            job.error = err;
          }
          if (extra && extra.onError) extra.onError(err);
        },
      });
      return resp;
    },

    async submitDownload() {
      // no signer_pubkey here -- a manually-entered content_hash has no
      // associated Discover row to pull one from, so Subscribe just
      // won't be available from the player for this download
      const resp = await this.startDownload(
        this.downloadForm.hash,
        this.splitRelays(this.downloadForm.relays),
        this.downloadForm.out || null,
        this.downloadForm.lightning,
        this.downloadForm.lightningNode,
        null,
        null,
      );
      if (resp.error) this.showError('error: ' + resp.error);
    },

    // ── identity / reputation ─────────────────────────────────────────
    async lookupReputation() {
      const pubkey = this.reputationPubkey.trim();
      if (!pubkey) {
        this.reputationResult = '';
        return;
      }
      const data = await this.apiGet('/api/reputation/' + encodeURIComponent(pubkey));
      this.reputationResult = 'score ' + data.score.toFixed(2) + ' — ' + data.why;
    },
  },
});

// v-marquee: slides an overflowing single-line text element back and
// forth to reveal the rest, instead of just leaving it ellipsis-
// truncated forever -- only ever animates elements that actually
// overflow (checked via scrollWidth vs clientWidth), so a short title
// that already fits just sits there normally, no pointless motion.
//
// Animates transform on an inner <span> (see the HTML -- every usage
// wraps its text in one), not text-indent on this element directly.
// text-indent was the first version of this: it worked without needing
// that inner wrapper at all, but animating it forces a real text-layout
// reflow on every single frame -- invisible on a desktop browser's spare
// CPU, but a real phone starts dropping frames doing that 60 times a
// second, especially with several rows animating at once, which is
// exactly what "stutters" instead of gliding. transform is
// compositor-only: the browser can slide the already-painted layer
// around on the GPU without re-laying-out or re-painting text at all.
function _updateMarquee(el) {
  const overflow = el.scrollWidth - el.clientWidth;
  const overflowing = overflow > 4;
  // Bail out if nothing actually changed since last time -- this runs on
  // *every* Vue re-render anywhere in the app (the 'updated' hook fires
  // whenever this element's containing component re-renders at all, not
  // just when this element's own content does -- and this is a single
  // root component, so a hosts poll or a download's pct ticking up
  // re-renders everything), not just when this element's own text or
  // size genuinely changes. Rewriting the same --marquee-duration/
  // --marquee-shift custom properties every single time was restarting
  // the running CSS animation constantly, right in the middle of its
  // slide -- which is exactly what looked like "jumps" instead of a
  // smooth scroll: it never got to run for its own full duration.
  if (el._marqueeOverflowing === overflowing && (!overflowing || el._marqueeAmount === overflow)) {
    return;
  }
  el._marqueeOverflowing = overflowing;
  el._marqueeAmount = overflowing ? overflow : null;
  if (overflowing) {
    // slow and roughly overflow-proportional -- a title that barely
    // clips shouldn't crawl for as long as one that's wildly cut off
    const duration = Math.max(4, 3 + overflow / 30);
    el.style.setProperty('--marquee-shift', `-${overflow}px`);
    el.style.setProperty('--marquee-duration', `${duration}s`);
    el.classList.add('marquee-active');
  } else {
    el.classList.remove('marquee-active');
    el.style.removeProperty('--marquee-shift');
    el.style.removeProperty('--marquee-duration');
  }
}
app.directive('marquee', {
  mounted(el) {
    _updateMarquee(el);
    // the element's *available* width changes independently of its text
    // content -- most notably .player-title, whose box gets wider or
    // narrower purely from switching PIP/theater/fullscreen, with no Vue
    // re-render (and so no 'updated' hook) involved at all
    el._marqueeRO = new ResizeObserver(() => _updateMarquee(el));
    el._marqueeRO.observe(el);
  },
  updated(el) {
    // content itself can also change without a resize -- a Discover
    // poll swapping a different row's title into the same DOM position,
    // a playlist rename -- requestAnimationFrame so this reads layout
    // after the DOM patch has actually settled, not mid-patch
    requestAnimationFrame(() => _updateMarquee(el));
  },
  unmounted(el) {
    if (el._marqueeRO) el._marqueeRO.disconnect();
  },
});

// v-center-swipe: for a .swipe-row built as three 100%-wide pages
// [actions, front, actions] (see index.html's Discover row markup) --
// scroll-snap's own default resting position is the *first* child
// (scrollLeft 0), which would make the front page the leftmost page and
// leave only one swipe direction doing anything. Centering scrollLeft on
// the middle page instead means swiping either way reveals a (identical)
// actions page, matching the already-bidirectional-looking "‹ actions ›"
// hint text that was, until now, only ever true in one direction.
function _centerSwipeRow(el) {
  if (el.children.length < 2) return;
  el.scrollLeft = el.children[0].offsetWidth;
}
app.directive('center-swipe', {
  mounted(el) {
    _centerSwipeRow(el);
    // the row's own width changes independent of any Vue re-render too
    // (orientation change, viewport resize) -- scrollLeft is a raw pixel
    // value, so a stale one no longer lines up with the new page width,
    // leaving the view stuck between snap points until the next manual
    // touch. Same ResizeObserver-on-mount pattern v-marquee already uses.
    el._centerSwipeRO = new ResizeObserver(() => _centerSwipeRow(el));
    el._centerSwipeRO.observe(el);
  },
  unmounted(el) {
    if (el._centerSwipeRO) el._centerSwipeRO.disconnect();
  },
});

app.component('filter-toggle', FilterToggle);
app.mount('#app');
