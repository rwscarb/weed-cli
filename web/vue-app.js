'use strict';

const { createApp } = Vue;

createApp({
  data() {
    return {
      pubkey: '',
      lanUrlBase: null,

      tabs: [
        { id: 'discover', label: 'Discover' },
        { id: 'host', label: 'Host' },
        { id: 'downloads', label: 'Downloads' },
        { id: 'identity-tab', label: 'Identity' },
      ],
      activeTab: 'discover',

      discoverRelays: 'http://127.0.0.1:9101',
      discoverResults: [],

      // server-persisted memory of what's been downloaded/liked/subscribed,
      // so a page reload (or a server restart) doesn't forget any of it --
      // loaded once at startup, then kept in sync as the user acts
      library: { downloads: {}, likes: new Set(), subscriptions: new Set() },

      hostForm: {
        archiveDir: '', fileName: '', port: 9201, price: 0,
        relays: 'http://127.0.0.1:9101', advertiseHost: '127.0.0.1',
        tunnelEnabled: false, tunnelAddr: '',
      },
      hostResult: '',
      hosts: [],

      downloadForm: {
        hash: '', relays: 'http://127.0.0.1:9101', out: '', lightning: false,
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
      player: { visible: false, mode: 'pip', jobId: null, title: '' },

      // one shared QR popup, repositioned/retargeted by whichever button
      // (header "open on phone", or a per-item share button) last clicked it
      qr: { visible: false, url: '', top: 0, left: null, right: null },
    };
  },

  computed: {
    discoverRelaysList() {
      return this.splitRelays(this.discoverRelays);
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
  },

  async mounted() {
    document.addEventListener('click', this.onDocumentClick);

    const { pubkey } = await this.apiGet('/api/whoami');
    this.pubkey = pubkey;

    this.apiGet('/api/lan-url').then(d => { this.lanUrlBase = d.url; }).catch(() => {});

    const lib = await this.apiGet('/api/library');
    for (const d of lib.downloads || []) this.library.downloads[d.content_hash] = d;
    this.library.likes = new Set(lib.likes || []);
    this.library.subscriptions = new Set(lib.subscriptions || []);
    for (const d of lib.downloads || []) {
      this.jobs.push({
        job_id: d.job_id, content_hash: d.content_hash, pct: 0, status: 'done',
        path: d.path, error: null, size: d.size, bps: d.bps, title: d.title,
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
      if (!this.qr.visible) return;
      if (this.$refs.qrPopup && this.$refs.qrPopup.contains(e.target)) return;
      if (e.target.closest('.qr-btn, .qr-toggle')) return;
      this.qr.visible = false;
    },

    // ── global video player: PIP ↔ theater ↔ fullscreen ─────────────────
    // :fullscreen is handled entirely in CSS, so Esc-to-exit (which
    // bypasses our own button) still lands back in whichever of
    // pip/theater it was in before, with no extra JS bookkeeping.
    openPlayer(jobId, title) {
      this.player.jobId = jobId;
      this.player.title = title || jobId;
      this.player.mode = 'pip';
      this.player.visible = true;
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
    },
    setPlayerMode(mode) {
      this.player.mode = mode;
    },
    togglePlayerMode() {
      this.player.mode = this.player.mode === 'theater' ? 'pip' : 'theater';
    },
    onPlayerHeaderClick(e) {
      if (e.target.closest('button')) return;
      this.setPlayerMode(this.player.mode === 'pip' ? 'theater' : 'pip');
    },
    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.$refs.globalPlayer.requestFullscreen();
    },

    // ── discover ──────────────────────────────────────────────────────
    async refreshDiscover() {
      const relays = this.discoverRelaysList;
      const qs = relays.map(r => 'relay=' + encodeURIComponent(r)).join('&');
      const { results } = await this.apiGet('/api/discover?' + qs);
      this.discoverResults = (results || []).map(r => ({
        ...r,
        _dl: { downloading: false, pct: 0 },
        _verify: { busy: false, label: 'Verify', title: '' },
      }));
    },

    // Handles both the first Download and any later Re-download click for
    // a Discover row -- both need the exact same row-fills-in-as-
    // progress-bar dance (see .dl-progress-row), just starting from a
    // different button.
    async download(r) {
      r._dl.downloading = true;
      r._dl.pct = 0;
      const resp = await this.startDownload(r.content_hash, this.discoverRelaysList, null, false, r.title, {
        onProgress: pct => { r._dl.pct = pct; },
        onDone: job => {
          r._dl.downloading = false;
          this.library.downloads[r.content_hash] = {
            content_hash: r.content_hash, job_id: job.job_id, path: job.path,
            title: r.title, size: job.size, bps: job.bps,
          };
        },
        onError: err => {
          r._dl.downloading = false;
          alert('error: ' + err);
        },
      });
      if (resp.error) {
        r._dl.downloading = false;
        alert('error: ' + resp.error);
      }
    },

    async verify(r) {
      r._verify.busy = true;
      r._verify.label = 'Verifying…';
      const result = await this.apiPost('/api/verify', {
        content_hash: r.content_hash, relay: this.discoverRelaysList[0],
      });
      if (result.error) {
        alert('verify error: ' + result.error);
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

    async like(r) {
      await this.apiPost('/api/like', { content_hash: r.content_hash, relay: this.discoverRelaysList[0] });
      this.library.likes.add(r.content_hash);
    },

    // outline -> filled star on subscribe, same toggle language as
    // GitHub/Twitter follow stars
    async subscribe(r) {
      await this.apiPost('/api/subscribe', { target_pubkey: r.signer_pubkey, relay: this.discoverRelaysList[0] });
      this.library.subscriptions.add(r.signer_pubkey);
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
    pollJob(jobId, { onProgress, onDone, onError }) {
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

    async startDownload(contentHash, relays, outPath, lightning, title, extra) {
      const resp = await this.apiPost('/api/download', {
        content_hash: contentHash, relay: relays, out_path: outPath,
        lightning: lightning, title: title || null,
      });
      if (resp.error) return resp;

      const job = {
        job_id: resp.job_id, content_hash: contentHash, pct: 0, status: 'running',
        path: null, error: null, size: null, bps: null, title,
      };
      this.jobs.push(job);

      this.pollJob(resp.job_id, {
        onProgress: pct => {
          job.pct = pct;
          if (extra && extra.onProgress) extra.onProgress(pct);
        },
        onDone: j => {
          job.status = 'done';
          job.path = j.path;
          job.size = j.size;
          job.bps = j.bps;
          if (extra && extra.onDone) extra.onDone(j);
        },
        onError: err => {
          job.status = 'error';
          job.error = err;
          if (extra && extra.onError) extra.onError(err);
        },
      });
      return resp;
    },

    async submitDownload() {
      const resp = await this.startDownload(
        this.downloadForm.hash,
        this.splitRelays(this.downloadForm.relays),
        this.downloadForm.out || null,
        this.downloadForm.lightning,
        null,
      );
      if (resp.error) alert('error: ' + resp.error);
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
}).mount('#app');
