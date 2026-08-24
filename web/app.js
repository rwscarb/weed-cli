'use strict';

// ── small fetch helpers ─────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(path);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function relayList(inputEl) {
  return inputEl.value.split(',').map(s => s.trim()).filter(Boolean);
}

function relayQuery(relays) {
  return relays.map(r => 'relay=' + encodeURIComponent(r)).join('&');
}

function shortHash(h, n = 10) {
  return h ? h.slice(0, n) + '…' : '';
}

function formatBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
}

// shown once a download finishes -- size always, speed only if it took
// long enough to measure (see web_ui.py's elapsed > 0 guard)
function formatDownloadStats(job) {
  if (job.size == null) return '';
  return formatBytes(job.size) + (job.bps != null ? ' · ' + formatBytes(job.bps) + '/s' : '');
}

function mkStatsSpan(job) {
  const stats = formatDownloadStats(job);
  if (!stats) return null;
  const el = document.createElement('span');
  el.className = 'dl-stats';
  el.textContent = stats;
  return el;
}

// ── QR popup, shared by the header "open on phone" button and each
// downloaded video's per-item scan button ─────────────────────────────────

function toggleQr(anchorEl, url) {
  let popup = document.getElementById('shared-qr-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'shared-qr-popup';
    popup.className = 'qr-popup hidden';
    document.body.appendChild(popup);
  }
  if (!popup.classList.contains('hidden') && popup.dataset.url === url) {
    popup.classList.add('hidden');
    return;
  }
  popup.dataset.url = url;
  popup.innerHTML =
    '<img src="/api/qr?data=' + encodeURIComponent(url) + '" alt="QR code for ' + url + '">' +
    '<div class="qr-url">' + url + '</div>';
  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  popup.style.left = (rect.left + window.scrollX) + 'px';
  popup.classList.remove('hidden');
}

document.addEventListener('click', e => {
  const popup = document.getElementById('shared-qr-popup');
  if (!popup || popup.classList.contains('hidden')) return;
  if (popup.contains(e.target) || e.target.closest('.qr-btn, #phone-qr-toggle')) return;
  popup.classList.add('hidden');
});

// The server's idea of "your phone's own address" beats the browser's:
// location.origin only reflects whatever address *this* browser used to
// load the page, which is 127.0.0.1 the instant someone opens it via
// localhost -- exactly the bug a LAN-bound server needs to avoid handing
// a phone a QR code that points right back at the desktop machine.
let lanUrlBase = null;
fetch('/api/lan-url').then(r => r.json()).then(d => { lanUrlBase = d.url; }).catch(() => {});

function qrBaseUrl() {
  return lanUrlBase || (location.origin + '/');
}

document.getElementById('phone-qr-toggle').addEventListener('click', e => {
  toggleQr(e.currentTarget, qrBaseUrl());
});

// ── global video player: PIP ↔ theater ↔ fullscreen ─────────────────────
//
// One player, built lazily (same pattern as the QR popup above) and
// reused by every "▶ Play" button anywhere in the app. It's attached to
// <body>, not any tab panel, so switching tabs never stops or hides
// whatever's playing. Starts docked in the corner; click its header (or
// the ⛶ button) to grow into a centered modal; ⤢ hands off to real
// browser fullscreen. :fullscreen is handled entirely in CSS, so Esc-to-
// exit (which bypasses our own button) still lands back in whichever of
// pip/theater it was in before, with no extra JS bookkeeping.

let playerMode = 'pip';

function getPlayer() {
  let el = document.getElementById('global-player');
  if (el) return el;

  const backdrop = document.createElement('div');
  backdrop.id = 'player-backdrop';
  backdrop.className = 'hidden';
  backdrop.addEventListener('click', () => setPlayerMode('pip'));
  document.body.appendChild(backdrop);

  el = document.createElement('div');
  el.id = 'global-player';
  el.className = 'mode-pip hidden';

  const header = document.createElement('div');
  header.className = 'player-header';
  header.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    setPlayerMode(playerMode === 'pip' ? 'theater' : 'pip');
  });

  const titleEl = document.createElement('span');
  titleEl.className = 'player-title';
  header.appendChild(titleEl);

  const controls = document.createElement('div');
  controls.className = 'player-controls';

  const theaterBtn = document.createElement('button');
  theaterBtn.type = 'button';
  theaterBtn.title = 'Theater / PIP';
  theaterBtn.textContent = '⤢';
  theaterBtn.addEventListener('click', () => setPlayerMode(playerMode === 'theater' ? 'pip' : 'theater'));

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.type = 'button';
  fullscreenBtn.title = 'Fullscreen';
  fullscreenBtn.textContent = '⛶';
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen();
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closePlayer);

  controls.appendChild(theaterBtn);
  controls.appendChild(fullscreenBtn);
  controls.appendChild(closeBtn);
  header.appendChild(controls);

  const video = document.createElement('video');
  video.controls = true;

  el.appendChild(header);
  el.appendChild(video);
  document.body.appendChild(el);
  return el;
}

function setPlayerMode(mode) {
  const el = document.getElementById('global-player');
  if (!el) return;
  playerMode = mode;
  el.classList.remove('mode-pip', 'mode-theater');
  el.classList.add('mode-' + mode);
  document.getElementById('player-backdrop').classList.toggle('hidden', mode !== 'theater');
}

function openPlayer(jobId, title) {
  const el = getPlayer();
  el.classList.remove('hidden');
  el.querySelector('.player-title').textContent = title || jobId;
  const video = el.querySelector('video');
  video.src = '/api/stream/' + jobId;
  video.autoplay = true;
  setPlayerMode('pip');
}

function closePlayer() {
  const el = document.getElementById('global-player');
  if (!el) return;
  if (document.fullscreenElement === el) document.exitFullscreen();
  const video = el.querySelector('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  el.classList.add('hidden');
  document.getElementById('player-backdrop').classList.add('hidden');
}

// appends a "▶ Play" + "📱" pair wired to openPlayer/toggleQr for jobId --
// shared by the Downloads jobs table and each Discover row so a finished
// download looks and behaves the same wherever it's watched from
function mkPlayControls(jobId, title) {
  const frag = document.createDocumentFragment();
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'play-btn';
  playBtn.textContent = '▶ Play';
  playBtn.addEventListener('click', () => openPlayer(jobId, title));
  const qrBtn = document.createElement('button');
  qrBtn.type = 'button';
  qrBtn.className = 'play-btn qr-btn';
  qrBtn.textContent = '📱';
  qrBtn.title = 'scan to open this video on your phone';
  qrBtn.addEventListener('click', () => toggleQr(qrBtn, qrBaseUrl() + 'api/stream/' + jobId));
  frag.appendChild(playBtn);
  frag.appendChild(qrBtn);
  return frag;
}

// ── tabs ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// ── identity ─────────────────────────────────────────────────────────────

async function loadIdentity() {
  const { pubkey } = await apiGet('/api/whoami');
  document.getElementById('identity').innerHTML = 'you are <code>' + shortHash(pubkey, 20) + '</code>';
  document.getElementById('identity-pubkey').textContent = pubkey;
}

// ── library: server-persisted memory of what's been downloaded/liked/
// subscribed, so a page reload (or a server restart) doesn't forget any
// of it. Loaded once at startup into these maps/sets, then kept in sync
// as the user acts within this session.

let downloadsByHash = new Map();
let likedHashes = new Set();
let subscribedPubkeys = new Set();

async function loadLibrary() {
  const library = await apiGet('/api/library');
  downloadsByHash = new Map((library.downloads || []).map(d => [d.content_hash, d]));
  likedHashes = new Set(library.likes || []);
  subscribedPubkeys = new Set(library.subscriptions || []);
}

// renders past downloads (this server instance or an earlier one) into
// the Downloads jobs table on load -- they're already 'done', so no
// polling, just the same row shape addJobRow's onDone produces
function renderPersistedDownloads() {
  const tbody = document.querySelector('#jobs-table tbody');
  for (const d of downloadsByHash.values()) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><code>' + d.job_id + '</code></td>' +
      '<td><code>' + shortHash(d.content_hash) + '</code></td>' +
      '<td><div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div></td>' +
      '<td class="status-done">done</td>' +
      '<td>' + d.path + ' </td>';
    const resultCell = tr.lastElementChild;
    resultCell.appendChild(mkPlayControls(d.job_id, d.title || shortHash(d.content_hash)));
    const stats = mkStatsSpan(d);
    if (stats) resultCell.appendChild(stats);
    tbody.appendChild(tr);
  }
}

// ── discover ─────────────────────────────────────────────────────────────

async function refreshDiscover() {
  const relays = relayList(document.getElementById('discover-relays'));
  const { results } = await apiGet('/api/discover?' + relayQuery(relays));
  const tbody = document.querySelector('#discover-table tbody');
  tbody.innerHTML = '';
  if (!results || !results.length) {
    tbody.innerHTML = '<tr><td colspan="6">nothing found — relay(s) unreachable, or nothing published yet</td></tr>';
    return;
  }
  for (const r of results) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td></td>' +
      '<td class="title-cell"><span class="title-text">' + (r.title || '') + '</span></td>' +
      '<td><code>' + shortHash(r.content_hash) + '</code></td>' +
      '<td>' + (r.host || '') + '</td>' +
      '<td>' + (r.tunnel || '—') + '</td>' +
      '<td><code>' + shortHash(r.signer_pubkey, 12) + '</code></td>';
    const actions = tr.firstElementChild;
    const titleCell = tr.children[1];

    const already = downloadsByHash.get(r.content_hash);
    if (already) {
      actions.appendChild(mkPlayControls(already.job_id, r.title || already.title || shortHash(r.content_hash)));
      const stats = mkStatsSpan(already);
      if (stats) actions.appendChild(stats);
    } else {
      const dlBtn = document.createElement('button');
      dlBtn.textContent = 'Download';

      // While a download's in flight the row itself is the progress bar
      // (.dl-progress-row, filled via --pct) -- no separate readout, so
      // the button just disappears for the duration rather than turning
      // into one.
      dlBtn.addEventListener('click', async () => {
        tr.classList.add('dl-progress-row');
        tr.style.setProperty('--pct', '0%');
        dlBtn.remove();

        function reset() {
          tr.classList.remove('dl-progress-row');
          tr.style.removeProperty('--pct');
          actions.appendChild(dlBtn);
        }

        const resp = await startDownload(r.content_hash, relays, null, false, {
          onProgress(pct) { tr.style.setProperty('--pct', pct + '%'); },
          onDone(job) {
            tr.classList.remove('dl-progress-row');
            tr.style.removeProperty('--pct');
            downloadsByHash.set(r.content_hash, {
              content_hash: r.content_hash, job_id: job.job_id, path: job.path, title: r.title,
              size: job.size, bps: job.bps,
            });
            actions.prepend(mkPlayControls(job.job_id, r.title || shortHash(r.content_hash)));
            const stats = mkStatsSpan(job);
            if (stats) actions.appendChild(stats);
          },
          onError(err) {
            reset();
            alert('error: ' + err);
          },
        }, r.title);
        if (resp.error) {
          reset();
          alert('error: ' + resp.error);
        }
      });
      actions.appendChild(dlBtn);
    }

    // Like/Subscribe live as icons to the right of the title, not in the
    // actions column -- Download/Play/Share are the "do something with
    // this file" controls, these two are more like a lightweight social
    // reaction and stay out of their way.
    const iconGroup = document.createElement('span');
    iconGroup.className = 'title-icons';

    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'icon-btn';
    likeBtn.textContent = '♥';
    const alreadyLiked = likedHashes.has(r.content_hash);
    likeBtn.title = alreadyLiked ? 'Liked' : 'Like';
    likeBtn.classList.toggle('active', alreadyLiked);
    likeBtn.disabled = alreadyLiked;
    likeBtn.addEventListener('click', async () => {
      likeBtn.disabled = true;
      await apiPost('/api/like', { content_hash: r.content_hash, relay: relays[0] });
      likedHashes.add(r.content_hash);
      likeBtn.title = 'Liked';
      likeBtn.classList.add('active');
    });
    iconGroup.appendChild(likeBtn);

    const subBtn = document.createElement('button');
    subBtn.type = 'button';
    subBtn.className = 'icon-btn';
    subBtn.textContent = '🔔';
    const alreadySubscribed = subscribedPubkeys.has(r.signer_pubkey);
    subBtn.title = alreadySubscribed ? 'Subscribed' : 'Subscribe';
    subBtn.classList.toggle('active', alreadySubscribed);
    subBtn.disabled = alreadySubscribed;
    subBtn.addEventListener('click', async () => {
      subBtn.disabled = true;
      await apiPost('/api/subscribe', { target_pubkey: r.signer_pubkey, relay: relays[0] });
      subscribedPubkeys.add(r.signer_pubkey);
      subBtn.title = 'Subscribed';
      subBtn.classList.add('active');
    });
    iconGroup.appendChild(subBtn);

    titleCell.appendChild(iconGroup);

    tbody.appendChild(tr);
  }
}

document.getElementById('discover-form').addEventListener('submit', e => {
  e.preventDefault();
  refreshDiscover();
});

// ── host ─────────────────────────────────────────────────────────────────

document.getElementById('host-tunnel-enabled').addEventListener('change', e => {
  document.getElementById('host-tunnel-addr-row').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('host-form').addEventListener('submit', async e => {
  e.preventDefault();
  const tunnelEnabled = document.getElementById('host-tunnel-enabled').checked;
  const body = {
    archive_dir: document.getElementById('host-archive-dir').value,
    file_name: document.getElementById('host-file-name').value || null,
    port: Number(document.getElementById('host-port').value),
    price: Number(document.getElementById('host-price').value),
    relay: relayList(document.getElementById('host-relays')),
    advertise_host: document.getElementById('host-advertise').value,
    tunnel: tunnelEnabled ? document.getElementById('host-tunnel-addr').value : null,
  };
  const result = document.getElementById('host-result');
  result.textContent = 'starting…';
  const resp = await apiPost('/api/host', body);
  if (resp.error) {
    result.textContent = 'error: ' + resp.error;
    return;
  }
  result.textContent = 'hosting started (id ' + resp.host_id + ')';
  refreshHosts();
});

async function refreshHosts() {
  const { hosts } = await apiGet('/api/hosts');
  const tbody = document.querySelector('#hosts-table tbody');
  tbody.innerHTML = '';
  for (const h of hosts || []) {
    const tr = document.createElement('tr');
    const statusText = h.status === 'error' ? 'error: ' + h.error : h.status;
    const statusClass = h.status === 'error' ? 'status-error' : (h.status === 'running' ? 'status-done' : 'status-running');
    tr.innerHTML =
      '<td>' + (h.name || '(starting…)') + '</td>' +
      '<td>' + h.port + '</td>' +
      '<td>' + (h.price ? h.price + ' sat' : 'free') + '</td>' +
      '<td>' + (h.tunnel || '—') + '</td>' +
      '<td class="' + statusClass + '">' + statusText + '</td>';
    tbody.appendChild(tr);
  }
}

// ── downloads ────────────────────────────────────────────────────────────

// One poll loop per job; any number of listeners (the Downloads-tab jobs
// table, a Discover row, ...) can watch the same job by passing their own
// callbacks — nothing here assumes there's exactly one place a job's
// progress is shown.
function pollJobStatus(jobId, { onProgress, onDone, onError } = {}) {
  const timer = setInterval(async () => {
    const job = await apiGet('/api/download/' + jobId);
    // the server's job dict never carries its own id (job_id is only ever
    // the _jobs dict *key*, on its side) -- stamp it on here so every
    // listener can rely on job.job_id instead of quietly getting undefined
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
}

async function startDownload(contentHash, relays, outPath, lightning, extraCallbacks, title) {
  const resp = await apiPost('/api/download', {
    content_hash: contentHash,
    relay: relays,
    out_path: outPath,
    lightning: lightning,
    title: title || null,
  });
  if (resp.error) return resp;
  const jobsTableCallbacks = addJobRow(resp.job_id, contentHash);
  pollJobStatus(resp.job_id, mergeCallbacks(jobsTableCallbacks, extraCallbacks));
  return resp;
}

function mergeCallbacks(...callbackSets) {
  const merged = {};
  for (const name of ['onProgress', 'onDone', 'onError']) {
    const fns = callbackSets.filter(Boolean).map(c => c[name]).filter(Boolean);
    if (fns.length) merged[name] = (...a) => fns.forEach(fn => fn(...a));
  }
  return merged;
}

document.getElementById('download-form').addEventListener('submit', async e => {
  e.preventDefault();
  const resp = await startDownload(
    document.getElementById('download-hash').value,
    relayList(document.getElementById('download-relays')),
    document.getElementById('download-out').value || null,
    document.getElementById('download-lightning').checked,
  );
  if (resp.error) alert('error: ' + resp.error);
});

function addJobRow(jobId, contentHash) {
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><code>' + jobId + '</code></td>' +
    '<td><code>' + shortHash(contentHash) + '</code></td>' +
    '<td><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div></td>' +
    '<td class="status-running">running</td>' +
    '<td>—</td>';
  document.querySelector('#jobs-table tbody').appendChild(tr);

  const fill = tr.querySelector('.progress-fill');
  const statusCell = tr.children[3];
  const resultCell = tr.children[4];
  return {
    onProgress(pct) { fill.style.width = pct + '%'; },
    onDone(job) {
      fill.style.width = '100%';
      statusCell.textContent = 'done';
      statusCell.className = 'status-done';
      resultCell.textContent = job.path + ' ';
      resultCell.appendChild(mkPlayControls(jobId, shortHash(contentHash)));
      const stats = mkStatsSpan(job);
      if (stats) resultCell.appendChild(stats);
    },
    onError(err) {
      statusCell.textContent = 'error';
      statusCell.className = 'status-error';
      resultCell.textContent = err;
    },
  };
}

// ── identity / reputation tab ────────────────────────────────────────────

document.getElementById('reputation-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pubkey = document.getElementById('reputation-pubkey').value.trim();
  const result = document.getElementById('reputation-result');
  if (!pubkey) { result.textContent = ''; return; }
  const data = await apiGet('/api/reputation/' + encodeURIComponent(pubkey));
  result.textContent = 'score ' + data.score.toFixed(2) + ' — ' + data.why;
});

// ── init ─────────────────────────────────────────────────────────────────

loadLibrary().then(() => {
  renderPersistedDownloads();
  refreshDiscover();
});
loadIdentity();
refreshHosts();
setInterval(refreshHosts, 3000);
