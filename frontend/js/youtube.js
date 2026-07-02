/* gioKaraoke — YouTube to MP3 / local audio enhancer */

const urlInput  = document.getElementById('yt-url');
const submitBtn = document.getElementById('yt-submit');
const jobList   = document.getElementById('yt-job-list');

// ── Pipeline step maps — YouTube path (5 steps) ───────────────────────────────
const PIPE_MAP = {
  parsing:    'ps-parse',
  extracting: 'ps-extract',
  downloading:'ps-download',
  transcoding:'ps-transcode',
  enhancing:  'ps-enhance',
  done:       'ps-enhance',
};

const YT_STEPS   = ['parse', 'extract', 'download', 'transcode', 'enhance'];
const YT_STATUS  = {
  parsing:    'parse',
  extracting: 'extract',
  downloading:'download',
  transcoding:'transcode',
  enhancing:  'enhance',
};

// ── Bitrate selector ──────────────────────────────────────────────────────────
let selectedBitrate = '192';
document.getElementById('bitrate-sel').addEventListener('click', e => {
  const btn = e.target.closest('.yt-bit-btn');
  if (!btn) return;
  document.querySelectorAll('.yt-bit-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedBitrate = btn.dataset.val;
});

// ── YouTube URL submit ────────────────────────────────────────────────────────
submitBtn.addEventListener('click', submitURL);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitURL(); });

async function submitURL() {
  const url = urlInput.value.trim();
  if (!url) { showToast('Paste a YouTube URL first.'); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Submitting…';

  try {
    const res = await fetch('/api/youtube/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        bitrate: selectedBitrate,
        enhance: document.getElementById('opt-enhance').checked,
        save_to_library: document.getElementById('opt-library').checked,
      }),
    });

    if (!res.ok) {
      const { detail } = await res.json().catch(() => ({}));
      throw new Error(formatErrorDetail(detail, `Server error (${res.status})`));
    }

    const { jobs, is_playlist, playlist_title } = await res.json();

    if (is_playlist && jobs.length > 1) {
      showToast(`Playlist "${playlist_title}" — ${jobs.length} tracks queued.`);
    }

    for (const { job_id, title } of jobs) {
      const card = createCard(title || url);
      watchJob(job_id, card);
    }

    urlInput.value = '';
  } catch (err) {
    showToast(`✗ ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '▶ Convert';
  }
}

// ── Job card ──────────────────────────────────────────────────────────────────
function createCard(label) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.innerHTML = `
    <div class="job-header">
      <span class="job-name">🎵 ${esc(label)}</span>
    </div>
    <div class="job-steps">
      <span class="jstep pending" data-step="parse">🔗 Parse</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="extract">📡 Extract</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="download">⬇ Download</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="transcode">🎵 Transcode</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="enhance">✨ Enhance</span>
    </div>
    <div class="job-progress-bar"><div class="job-progress-fill"></div></div>
    <div class="job-status">Queued…</div>
    <div class="job-actions" style="display:none;align-items:center;gap:12px;">
      <button class="big-btn download-btn">⬇ Download MP3</button>
      <span class="lib-badge" style="display:none;">📚 Saved to library</span>
    </div>
  `;
  jobList.prepend(card);
  return card;
}

// ── Step helpers ──────────────────────────────────────────────────────────────
function setProgress(card, pct) {
  card.querySelector('.job-progress-fill').style.width = pct + '%';
}

function setStatus(card, text) {
  card.querySelector('.job-status').textContent = text;
}

function updateTitle(card, title) {
  card.querySelector('.job-name').textContent = `🎵 ${title}`;
}

function activateCardStep(card, stepKey, order) {
  const idx = order.indexOf(stepKey);
  card.querySelectorAll('.jstep').forEach((el, i) => {
    el.classList.remove('pending', 'active', 'done');
    if (i < idx)        el.classList.add('done');
    else if (i === idx) el.classList.add('active');
    else                el.classList.add('pending');
  });
}

function allStepsDone(card) {
  card.querySelectorAll('.jstep').forEach(el => {
    el.classList.remove('pending', 'active');
    el.classList.add('done');
  });
}

// ── SSE watcher (with auto-reconnect + stall detection) ───────────────────────
// The processor's status stream emits a heartbeat every ~1.5s for as long as a
// job is active, even when nothing's changed — so silence past STALL_TIMEOUT
// reliably means the connection died or the processor container restarted
// mid-job (e.g. the host went to sleep), not that a step is just taking a
// while.
function watchJob(jobId, card) {
  let retries = 0;
  const MAX_RETRIES = 6;
  const STALL_TIMEOUT = 20000;
  let watchdog = null;

  function armWatchdog(es) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      es.close();
      handleDisconnect();
    }, STALL_TIMEOUT);
  }

  function handleDisconnect() {
    if (card.classList.contains('job-done') || card.classList.contains('job-error')) return;
    retries++;
    if (retries <= MAX_RETRIES) {
      const delay = Math.min(2000 * retries, 12000);
      setStatus(card, `⏳ Reconnecting… (${retries}/${MAX_RETRIES})`);
      setTimeout(connect, delay);
    } else {
      card.classList.add('job-error');
      setStatus(card, '✗ Lost connection after several retries. Refresh the page to check status.');
    }
  }

  function connect() {
    const es = new EventSource(`/api/youtube/status/${jobId}`);
    armWatchdog(es);

    es.onmessage = e => {
      retries = 0;
      armWatchdog(es);

      let data;
      try { data = JSON.parse(e.data); }
      catch { return; }

      const { status, progress, step, title, error, library_saved } = data;

      if (progress != null) setProgress(card, progress);
      if (step)   setStatus(card, step);
      if (title)  updateTitle(card, title);

      const stepKey = YT_STATUS[status];
      if (stepKey) activateCardStep(card, stepKey, YT_STEPS);

      document.querySelectorAll('.pipe-step').forEach(el => el.classList.remove('pipe-active'));
      const pipeId = PIPE_MAP[status];
      if (pipeId) document.getElementById(pipeId)?.classList.add('pipe-active');

      if (status === 'done') {
        clearTimeout(watchdog);
        es.close();
        allStepsDone(card);
        card.classList.add('job-done');
        card.classList.remove('job-error');
        const actions = card.querySelector('.job-actions');
        actions.style.display = 'flex';
        const btn = actions.querySelector('.download-btn');
        btn.addEventListener('click', () => triggerDownload(jobId, btn));
        if (library_saved) actions.querySelector('.lib-badge').style.display = 'inline';
        document.querySelectorAll('.pipe-step').forEach(el => el.classList.remove('pipe-active'));
      }

      if (status === 'error') {
        clearTimeout(watchdog);
        es.close();
        card.classList.add('job-error');
        setStatus(card, `✗ ${error || step}`);
      }

      if (status === 'not_found') {
        clearTimeout(watchdog);
        es.close();
        card.classList.add('job-error');
        setStatus(card, '✗ Job not found on server — the processor may have restarted mid-job. Please retry.');
      }
    };

    es.onerror = () => {
      clearTimeout(watchdog);
      es.close();
      handleDisconnect();
    };
  }

  connect();
}

// ── Download ──────────────────────────────────────────────────────────────────
async function triggerDownload(jobId, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Preparing…';
  try {
    const res = await fetch(`/api/youtube/download/${jobId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob   = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = objUrl;
    const cd     = res.headers.get('content-disposition') || '';
    a.download   = parseContentDispositionFilename(cd) || 'audio.mp3';
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    btn.textContent = '✓ Downloaded';
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '⬇ Retry Download';
    showToast(`Download failed: ${err.message}`);
  }
}

// ── Content-Disposition filename parser ──────────────────────────────────────
// Starlette sends RFC 5987 when the filename contains spaces or non-ASCII:
//   filename*=utf-8''Siempre%20Reza%20Por%20M%C3%AD.mp3
// The old regex captured that verbatim, giving "utf-8Siempre%20..." as the name.
function parseContentDispositionFilename(cd) {
  // Try filename*=charset''encoded first (RFC 5987)
  const star = cd.match(/filename\*\s*=\s*(?:[^']*'[^']*')?([^;\s]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { return star[1]; }
  }
  // Fall back to plain filename="..."
  const plain = cd.match(/filename\s*=\s*"([^"]+)"/i)
             || cd.match(/filename\s*=\s*([^;\s]+)/i);
  return plain ? plain[1] : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
  );
}

// FastAPI validation errors return `detail` as an array of {loc, msg, type}
// objects (not a string) — stringifying that directly via `new Error(detail)`
// produces "[object Object]". Flatten it into something readable instead.
function formatErrorDetail(detail, fallback) {
  if (!detail) return fallback;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(d => (d && d.msg) ? d.msg : JSON.stringify(d)).join('; ');
  }
  if (typeof detail === 'object') return detail.msg || JSON.stringify(detail);
  return String(detail);
}

let toastTimer;
function showToast(msg) {
  let toast = document.getElementById('yt-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'yt-toast';
    toast.className = 'conv-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}
