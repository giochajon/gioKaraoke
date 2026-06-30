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
    <div class="lyrics-panel" style="display:none;">
      <div class="lyrics-header">
        <span class="lyrics-title">🎵 Lyrics Preview</span>
        <button class="lyrics-preview-btn">▶ Auto-scroll</button>
      </div>
      <div class="lyrics-window"></div>
    </div>
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
      let msg = `Upload failed (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string')       msg = body.detail;
        else if (Array.isArray(body.detail))       msg = body.detail.map(e => e.msg || JSON.stringify(e)).join('; ');
        else if (typeof body.error === 'string')   msg = body.error;
      } catch (_) {}
      throw new Error(msg);
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

  // Detect server restart: if SSE goes silent for >20 s the container likely crashed.
  let sseLastSeen = Date.now();
  const sseSilenceTimer = setInterval(() => {
    if (card.classList.contains('job-done') || card.classList.contains('job-error')) {
      clearInterval(sseSilenceTimer);
      return;
    }
    if (Date.now() - sseLastSeen > 20_000) {
      clearInterval(sseSilenceTimer);
      es.close();
      card.classList.add('job-error');
      setStatus(card, '✗ Server stopped responding — it may have run out of memory. Please try again.');
    }
  }, 5000);

  es.onmessage = e => {
    sseLastSeen = Date.now();
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

    if (data.lyrics_ready && !card.dataset.lyricsLoaded) {
      card.dataset.lyricsLoaded = '1';
      fetchAndDisplayLyrics(jobId, card);
    }

    if (status === 'done') {
      clearInterval(sseSilenceTimer);
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
      clearInterval(sseSilenceTimer);
      es.close();
      card.classList.add('job-error');
      setStatus(card, `✗ ${error || step}`);
    }

    if (status === 'not_found') {
      clearInterval(sseSilenceTimer);
      es.close();
      card.classList.add('job-error');
      setStatus(card, '✗ Server restarted — job was lost (possibly out of memory). Please try again.');
    }
  };

  es.onerror = () => {
    if (!card.classList.contains('job-done') && !card.classList.contains('job-error')) {
      clearInterval(sseSilenceTimer);
      es.close();
      setStatus(card, '✗ Connection lost — server may have restarted. Please try again.');
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

// ── Lyrics preview ────────────────────────────────────────────────────────────

async function fetchAndDisplayLyrics(jobId, card) {
  try {
    const res = await fetch(`/api/convert/lyrics/${jobId}`);
    if (!res.ok) return;
    const { lyrics } = await res.json();
    if (!lyrics || !lyrics.length) return;
    card._lyrics = lyrics;
    showLyricsAt(card, 0);
    card.querySelector('.lyrics-panel').style.display = 'block';
    card.querySelector('.lyrics-preview-btn')
        .addEventListener('click', () => startLyricsPreview(card));
  } catch (_) {}
}

function showLyricsAt(card, idx) {
  const lyrics = card._lyrics;
  if (!lyrics) return;
  idx = Math.max(0, Math.min(idx, lyrics.length - 1));
  card._lyricsIdx = idx;
  const start = Math.max(0, idx - 1);
  const visible = lyrics.slice(start, start + 4);
  card.querySelector('.lyrics-window').innerHTML = visible.map((line, i) => {
    const cur = (start + i === idx);
    return `<div class="lyric-line${cur ? ' lyric-active' : ''}">${esc(line.text)}</div>`;
  }).join('');
}

function startLyricsPreview(card) {
  const lyrics = card._lyrics;
  if (!lyrics) return;
  const btn = card.querySelector('.lyrics-preview-btn');

  if (card._previewTimer) {
    clearInterval(card._previewTimer);
    card._previewTimer = null;
    btn.textContent = '▶ Auto-scroll';
    return;
  }

  btn.textContent = '⏸ Stop';
  const t0 = Date.now();

  card._previewTimer = setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    let idx = 0;
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time != null && lyrics[i].time <= elapsed) idx = i;
    }
    showLyricsAt(card, idx);

    const last = lyrics[lyrics.length - 1];
    if (last.time != null && elapsed > last.time + 6) {
      clearInterval(card._previewTimer);
      card._previewTimer = null;
      btn.textContent = '▶ Auto-scroll';
    }
  }, 200);
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
