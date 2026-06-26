/* gioKaraoke — Karaoke Creator frontend */

const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const jobList   = document.getElementById('job-list');

// ── Step map: server status → pipeline icon id ────────────────────────────────
const STEP_MAP = {
  queued:      null,
  separating:  'ps-separate',
  transcribing:'ps-transcribe',
  subtitles:   'ps-subtitles',
  background:  'ps-subtitles',
  rendering:   'ps-render',
  done:        'ps-render',
  error:       null,
};

// ── Drag-and-drop wiring ──────────────────────────────────────────────────────
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

// ── File handling ─────────────────────────────────────────────────────────────
function handleFiles(files) {
  files
    .filter(f => f.name.toLowerCase().endsWith('.mp3'))
    .forEach(startJob);

  const rejected = files.filter(f => !f.name.toLowerCase().endsWith('.mp3'));
  if (rejected.length) showToast(`Skipped ${rejected.length} non-MP3 file(s).`);
}

// ── Job card helpers ──────────────────────────────────────────────────────────
function createCard(file) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.innerHTML = `
    <div class="job-header">
      <span class="job-name">🎵 ${esc(file.name)}</span>
      <span class="job-size">${fmtSize(file.size)}</span>
    </div>
    <div class="job-steps">
      <span class="jstep pending" data-step="separate">🎙 Separate</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="transcribe">📝 Transcribe</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="subtitles">💬 Subtitles</span>
      <span class="jstep-sep">›</span>
      <span class="jstep pending" data-step="render">🎬 Render</span>
    </div>
    <div class="job-progress-bar"><div class="job-progress-fill"></div></div>
    <div class="job-status">Uploading…</div>
    <div class="job-actions" style="display:none;">
      <button class="big-btn download-btn">⬇ Download MP4</button>
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

function activateStep(card, stepKey) {
  const stepMap = { separate: 0, transcribe: 1, subtitles: 2, render: 3 };
  const steps = card.querySelectorAll('.jstep');
  const idx = stepMap[stepKey] ?? -1;
  steps.forEach((el, i) => {
    el.classList.remove('pending', 'active', 'done');
    if (i < idx)       el.classList.add('done');
    else if (i === idx) el.classList.add('active');
    else                el.classList.add('pending');
  });
}

// ── Upload + job pipeline ─────────────────────────────────────────────────────
async function startJob(file) {
  const card = createCard(file);

  // Upload
  const form = new FormData();
  form.append('file', file);

  let jobId, songTitle;
  try {
    const res = await fetch('/api/convert/upload', { method: 'POST', body: form });
    if (!res.ok) {
      const { detail } = await res.json().catch(() => ({}));
      throw new Error(detail || `Upload failed (${res.status})`);
    }
    ({ job_id: jobId, song_title: songTitle } = await res.json());
  } catch (err) {
    setStatus(card, `✗ ${err.message}`);
    card.classList.add('job-error');
    return;
  }

  setProgress(card, 5);
  setStatus(card, 'Queued — waiting for processing slot…');
  card.dataset.jobId = jobId;

  // SSE progress stream
  const es = new EventSource(`/api/convert/status/${jobId}`);

  es.onmessage = e => {
    const data = JSON.parse(e.data);
    const { status, progress, step, error } = data;

    setProgress(card, progress ?? 0);
    setStatus(card, step || status);

    // Activate pipeline step indicator
    const stepKey = {
      separating:  'separate',
      transcribing:'transcribe',
      subtitles:   'subtitles',
      background:  'subtitles',
      rendering:   'render',
    }[status];
    if (stepKey) activateStep(card, stepKey);

    // Highlight global pipeline steps
    const pipeId = STEP_MAP[status];
    document.querySelectorAll('.pipe-step').forEach(el => el.classList.remove('pipe-active'));
    if (pipeId) document.getElementById(pipeId)?.classList.add('pipe-active');

    if (status === 'done') {
      es.close();
      activateStep(card, 'render');
      card.classList.add('job-done');
      const actions = card.querySelector('.job-actions');
      actions.style.display = 'block';
      const btn = actions.querySelector('.download-btn');
      btn.addEventListener('click', () => triggerDownload(jobId, songTitle, btn));
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
    // SSE closed — if job is not done, mark as network error
    if (!card.classList.contains('job-done')) {
      es.close();
      setStatus(card, '✗ Connection lost. The server may still be processing.');
      card.classList.add('job-error');
    }
  };
}

// ── Download ──────────────────────────────────────────────────────────────────
async function triggerDownload(jobId, songTitle, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Preparing…';
  try {
    const res = await fetch(`/api/convert/download/${jobId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${songTitle || 'karaoke'}_karaoke.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    btn.textContent = '✓ Downloaded';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⬇ Retry Download';
    showToast(`Download failed: ${err.message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

let toastTimer;
function showToast(msg) {
  let toast = document.getElementById('conv-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'conv-toast';
    toast.className = 'conv-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}
