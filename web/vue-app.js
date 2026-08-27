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
      library: { downloads: {}, likes: new Set(), subscriptions: new Set(), playlists: [] },

      hostForm: {
        archiveDir: '', fileName: '', port: 9201, price: 0, lightningNode: null,
        relays: 'http://127.0.0.1:9101', advertiseHost: '127.0.0.1',
        tunnelEnabled: false, tunnelAddr: '',
      },
      hostResult: '',
      hosts: [],

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
        // set only when playback started from a playlist's "Play all" --
        // { items: [...], index } into that same array. null means "just
        // playing one thing," the ordinary case -- see openPlayer/
        // onPlayerEnded.
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
        { keys: 'Esc', desc: 'Close player / QR popup / error dialog / this list' },
        { keys: '?', desc: 'Toggle this list' },
      ],

      // easter egg -- deliberately not listed in `shortcuts` above (see
      // onGlobalKeydown's own comment on the trigger)
      easterEggVisible: false,
    };
  },

  computed: {
    discoverRelaysList() {
      return this.splitRelays(this.discoverRelays);
    },
    // search + the three tri-state toggles all narrow the same list
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
        return true;
      });
    },
    highlightedIndex() {
      if (!this.searchHighlightHash) return -1;
      return this.filteredDiscoverResults.findIndex(r => r.content_hash === this.searchHighlightHash);
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
    // ordinary "▶ Play" click omits it, which correctly ends any playlist
    // that happened to be running (manually picking a different video is
    // exactly the "I'm done following that queue" signal)
    openPlayer(jobId, title, contentHash, signerPubkey, queue = null) {
      this.player.jobId = jobId;
      this.player.title = title || jobId;
      this.player.contentHash = contentHash || null;
      this.player.signerPubkey = signerPubkey || null;
      this.player.mode = 'pip';
      this.player.visible = true;
      this.player.queue = queue;
      this.$nextTick(() => {
        const video = this.$refs.playerVideo;
        video.src = '/api/stream/' + jobId;
        video.autoplay = true;
      });
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
        // clear any manual drag/resize from the PIP mode this is leaving
        // (or entering) -- inline styles outrank the mode-pip/
        // mode-theater CSS rules, so a leftover drag position would
        // otherwise still win over theater's centered layout
        el.style.top = '';
        el.style.left = '';
        el.style.right = '';
        el.style.bottom = '';
        el.style.width = '';
        el.style.height = '';
        setTimeout(() => el.classList.remove('mode-transitioning'), 220);
      }
      this.player.mode = mode;
    },
    togglePlayerMode() {
      this.setPlayerMode(this.player.mode === 'theater' ? 'pip' : 'theater');
    },
    // Dragging (PIP only -- theater stays centered) shares the header
    // with the existing click-to-toggle behavior, so pointerdown starts
    // tracking movement and only *becomes* a drag past a small
    // threshold; a real drag sets a one-shot flag that suppresses the
    // click event the browser still fires afterward, so it doesn't also
    // toggle the mode on top of the move.
    onPlayerHeaderPointerDown(e) {
      if (e.target.closest('button')) return;
      if (this.player.mode !== 'pip') return;
      const el = this.$refs.globalPlayer;
      const rect = el.getBoundingClientRect();
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

      // Easter egg: type the mod-9 orbit {1,2,4,8,7,5} and the sequence
      // is consumed digit-by-digit as long as it keeps matching a valid
      // prefix -- none of 1/2/4/8/7/5 reach the tab-switcher below while
      // a correct run is in progress, so typing it clean doesn't also
      // flicker through tabs 1/2/4 on the way. A wrong digit resets the
      // buffer and falls through to whatever that key normally does
      // (including tab-switching), so mistyping never gets stuck.
      // Deliberately not in the `shortcuts` list above -- it's a secret.
      const ORBIT_CODE = '124875';
      if (/^[0-9]$/.test(e.key)) {
        const nextBuffer = (this._orbitBuffer || '') + e.key;
        if (ORBIT_CODE.startsWith(nextBuffer)) {
          this._orbitBuffer = nextBuffer;
          if (this._orbitBuffer === ORBIT_CODE) {
            this._orbitBuffer = '';
            this.easterEggVisible = true;
          }
          return;
        }
        this._orbitBuffer = '';
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
      }
    },

    // Up/Down move a highlight through the currently-filtered rows;
    // Enter/Space act on whichever one is highlighted -- Play if it's
    // already downloaded, otherwise Download (there's nothing to "play"
    // yet, so this is the closest equivalent to hitting that row's own
    // primary button)
    onSearchKeydown(e) {
      const list = this.filteredDiscoverResults;
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
      }
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
    // ── playlist drag-to-reorder ──────────────────────────────────────
    // Native HTML5 drag-and-drop, not a library -- one draggable list,
    // no cross-window/touch requirements, not worth a dependency for.
    // _dragFrom is plain (non-reactive) instance state, same reasoning
    // as the player's own _drag tracking above: it only matters within
    // one drag gesture, nothing ever needs to render off of it directly.
    onItemDragStart(e, playlist, idx) {
      this._dragFrom = { playlistId: playlist.id, index: idx };
      e.dataTransfer.effectAllowed = 'move';
      // Firefox won't fire drop at all unless dragstart sets *some* data
      e.dataTransfer.setData('text/plain', String(idx));
    },
    onItemDragEnd() {
      this._dragFrom = null;
      this.dragOverKey = null;
    },
    // dragOverKey is reactive (unlike _dragFrom) purely to drive the
    // drop-target highlight -- keyed 'playlistId:index' since two
    // playlists' items can share the same index
    onItemDragOver(e, playlist, idx) {
      if (!this._dragFrom || this._dragFrom.playlistId !== playlist.id) return;
      e.dataTransfer.dropEffect = 'move';
      this.dragOverKey = playlist.id + ':' + idx;
    },
    async onItemDrop(e, playlist, idx) {
      this.dragOverKey = null;
      const from = this._dragFrom;
      this._dragFrom = null;
      if (!from || from.playlistId !== playlist.id || from.index === idx) return;
      const items = playlist.items.slice();
      const [moved] = items.splice(from.index, 1);
      items.splice(idx, 0, moved);
      playlist.items = items; // optimistic -- server call below just confirms it
      const resp = await this.apiPost('/api/playlists/reorder',
        { playlist_id: playlist.id, order: items.map(it => it.content_hash) });
      if (resp.error) { this.showError('error: ' + resp.error); return; }
      this._applyPlaylist(resp.playlist);
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
        first.content_hash, first.signer_pubkey || rec.signer_pubkey, { items, index: 0 });
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
        next.content_hash, next.signer_pubkey || rec.signer_pubkey, { items: q.items, index: q.index + 1 });
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

app.component('filter-toggle', FilterToggle);
app.mount('#app');
