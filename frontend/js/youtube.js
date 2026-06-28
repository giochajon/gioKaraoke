/* gioKaraoke — YouTube to MP3 / local audio enhancer */

const urlInput  = document.getElementById('yt-url');
const submitBtn = document.getElementById('yt-submit');
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
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

// ── Pipeline step maps — local file path (3 steps) ────────────────────────────
const LOCAL_STEPS  = ['upload', 'transcode', 'enhance'];
const LOCAL_STATUS = {
  queued:     'transcode',   // upload done, waiting to transcode
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

// ── Shared option helpers ─────────────────────────────────────────────────────
const getEnhance  = () => document.getElementById('opt-enhance').checked;
const getLibrary  = () => document.getElementById('opt-library').checked;

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
        enhance: getEnhance(),
        save_to_library: getLibrary(),
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
      const card = createCard(title || url, 'youtube');
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

// ── Local file drag-and-drop ──────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
['dragleave', 'dragend'].forEach(ev =>
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
);
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  handleFiles([...fileInput.files]);
  fileInput.value = '';
});

function handleFiles(files) {
  const audio = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|aiff?)$/i.test(f.name));
  audio.forEach(startLocalJob);
  const skipped = files.length - audio.length;
  if (skipped) showToast(`Skipped ${skipped} non-audio file(s).`);
}

async function startLocalJob(file) {
  const card = createCard(file.name, 'local');
  activateCardStep(card, 'upload', LOCAL_STEPS);  // show upload as active
  setStatus(card, 'Uploading…');

  const form = new FormData();
  form.append('file', file);
  form.append('bitrate', selectedBitrate);
  form.append('enhance', String(getEnhance()));
  form.append('save_to_library', String(getLibrary()));

  let jobId;
  try {
    const res = await fetch('/api/youtube/enhance-upload', { method: 'POST', body: form });
    if (!res.ok) {
      const { detail } = await res.json().catch(() => ({}));
      throw new Error(detail || `Upload failed (${res.status})`);
    }
    ({ job_id: jobId } = await res.json());
  } catch (err) {
    setStatus(card, `✗ ${err.message}`);
    card.classList.add('job-error');
    return;
  }

  card.dataset.jobId = jobId;
  setProgress(card, 8);
  setStatus(card, 'Queued — waiting for processing slot…');
  activateCardStep(card, 'transcode', LOCAL_STEPS); // upload done
  watchJob(jobId, card);
}

// ── Job card ──────────────────────────────────────────────────────────────────
function createCard(label, type) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.cardType = type;

  const stepsHTML = type === 'local'
    ? `<span class="jstep pending" data-step="upload">📤 Upload</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="transcode">🎵 Transcode</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="enhance">✨ Enhance</span>`
    : `<span class="jstep pending" data-step="parse">🔗 Parse</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="extract">📡 Extract</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="download">⬇ Download</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="transcode">🎵 Transcode</span>
       <span class="jstep-sep">›</span>
       <span class="jstep pending" data-step="enhance">✨ Enhance</span>`;

  card.innerHTML = `
    <div class="job-header">
      <span class="job-name">🎵 ${esc(label)}</span>
    </div>
    <div class="job-steps">${stepsHTML}</div>
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

// ── SSE watcher (with auto-reconnect) ────────────────────────────────────────
function watchJob(jobId, card) {
  const isLocal = card.dataset.cardType === 'local';
  let retries = 0;
  const MAX_RETRIES = 6;

  function connect() {
    const es = new EventSource(`/api/youtube/status/${jobId}`);

    es.onmessage = e => {
      retries = 0;

      let data;
      try { data = JSON.parse(e.data); }
      catch { return; }

      const { status, progress, step, title, error, library_saved } = data;

      if (progress != null) setProgress(card, progress);
      if (step)             setStatus(card, step);
      if (title && !isLocal) updateTitle(card, title);

      // Activate inline step based on card type
      if (isLocal) {
        const stepKey = LOCAL_STATUS[status];
        if (stepKey) activateCardStep(card, stepKey, LOCAL_STEPS);
      } else {
        const stepKey = YT_STATUS[status];
        if (stepKey) activateCardStep(card, stepKey, YT_STEPS);
      }

      // Highlight global pipeline diagram (same mapping for both types)
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
    const blob   = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = objUrl;
    const cd     = res.headers.get('content-disposition') || '';
    const match  = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    a.download   = match ? match[1].replace(/['"]/g, '') : 'audio.mp3';
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    btn.textContent = '✓ Downloaded';
  } catch (err) {
    btn.disabled    = false;
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
