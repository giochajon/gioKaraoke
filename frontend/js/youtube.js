/* gioKaraoke — YouTube to MP3 */

const urlInput  = document.getElementById('yt-url');
const submitBtn = document.getElementById('yt-submit');
const jobList   = document.getElementById('yt-job-list');

// ── Pipeline step maps ────────────────────────────────────────────────────────
const PIPE_MAP = {
  parsing:    'ps-parse',
  extracting: 'ps-extract',
  downloading:'ps-download',
  transcoding:'ps-transcode',
  enhancing:  'ps-enhance',
  done:       'ps-enhance',
};

const INLINE_ORDER = ['parse', 'extract', 'download', 'transcode', 'enhance'];
const INLINE_MAP   = {
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

// ── Submit ────────────────────────────────────────────────────────────────────
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
      throw new Error(detail || `Server error (${res.status})`);
    }

    const { jobs, is_playlist, playlist_title } = await res.json();

    if (is_playlist && jobs.length > 1) {
      showToast(`Playlist "${playlist_title}" — ${jobs.length} tracks queued.`);
    }

    for (const { job_id, title } of jobs) {
      const card = createCard(title || url, job_id);
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
function createCard(label, jobId) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.jobId = jobId;
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

function setProgress(card, pct) {
  card.querySelector('.job-progress-fill').style.width = pct + '%';
}

function setStatus(card, text) {
  card.querySelector('.job-status').textContent = text;
}

function updateTitle(card, title) {
  card.querySelector('.job-name').textContent = `🎵 ${title}`;
}

function activateStep(card, stepKey) {
  const idx = INLINE_ORDER.indexOf(stepKey);
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

// ── SSE watcher (with auto-reconnect) ────────────────────────────────────────
function watchJob(jobId, card) {
  let retries = 0;
  const MAX_RETRIES = 6;

  function connect() {
    const es = new EventSource(`/api/youtube/status/${jobId}`);

    es.onmessage = e => {
      retries = 0; // reset backoff on each good message

      let data;
      try { data = JSON.parse(e.data); }
      catch { return; } // ignore malformed frames

      const { status, progress, step, title, error, library_saved } = data;

      if (progress != null) setProgress(card, progress);
      if (step)   setStatus(card, step);
      if (title)  updateTitle(card, title);

      const stepKey = INLINE_MAP[status];
      if (stepKey) activateStep(card, stepKey);

      document.querySelectorAll('.pipe-step').forEach(el => el.classList.remove('pipe-active'));
      const pipeId = PIPE_MAP[status];
      if (pipeId) document.getElementById(pipeId)?.classList.add('pipe-active');

      if (status === 'done') {
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
        es.close();
        card.classList.add('job-error');
        setStatus(card, `✗ ${error || step}`);
      }

      if (status === 'not_found') {
        es.close();
        card.classList.add('job-error');
        setStatus(card, '✗ Job not found on server.');
      }
    };

    es.onerror = () => {
      es.close();
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
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    const cd = res.headers.get('content-disposition') || '';
    const match = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    a.download = match ? match[1].replace(/['"]/g, '') : 'audio.mp3';
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    btn.textContent = '✓ Downloaded';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⬇ Retry Download';
    showToast(`Download failed: ${err.message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
  );
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
