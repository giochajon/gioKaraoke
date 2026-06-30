/* gioKaraoke — Lyrics Lookup Tester frontend */

const dropZone   = document.getElementById('drop-zone');
const fileInput  = document.getElementById('file-input');
const resultList = document.getElementById('result-list');

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

function handleFiles(files) {
  files
    .filter(f => f.name.toLowerCase().endsWith('.mp3'))
    .forEach(runLookup);
}

// ── Lookup ────────────────────────────────────────────────────────────────────
async function runLookup(file) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.innerHTML = `
    <div class="job-header">
      <span class="job-name">🎵 ${esc(file.name)}</span>
    </div>
    <div class="job-status">Searching lrclib.net…</div>
  `;
  resultList.prepend(card);

  const form = new FormData();
  form.append('file', file);

  try {
    const res = await fetch('/api/convert/lyrics-test', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const debug = await res.json();
    renderDebug(card, debug);
  } catch (err) {
    card.querySelector('.job-status').textContent = `✗ ${err.message}`;
    card.classList.add('job-error');
  }
}

function renderDebug(card, debug) {
  const matched = !!debug.lines;
  card.classList.add(matched ? 'job-done' : 'job-error');

  const statusEl = card.querySelector('.job-status');
  statusEl.textContent = matched
    ? `✓ Found ${debug.lines.length} synced lines`
    : '✗ No synced lyrics found';

  const detail = document.createElement('div');
  detail.className = 'admin-card';
  detail.style.marginTop = '10px';
  detail.style.fontSize = '0.82rem';

  let html = `
    <p><strong>Raw filename title:</strong> ${esc(debug.raw_title)}</p>
    <p><strong>Cleaned query:</strong> ${esc(debug.cleaned_query)}</p>
  `;

  debug.attempts.forEach((attempt, i) => {
    const paramsStr = Object.entries(attempt.params)
      .map(([k, v]) => `${k}=${v}`).join(', ');
    html += `<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">`;
    html += `<p><strong>Attempt ${i + 1}:</strong> ${esc(paramsStr)} ${attempt.matched ? '— ✓ matched' : ''}</p>`;

    if (attempt.error) {
      html += `<p style="color:#ff7096;">Error: ${esc(attempt.error)}</p>`;
    } else {
      html += `<p>${attempt.result_count} result(s) from lrclib.net</p>`;
      if (attempt.candidates.length) {
        html += `<table style="width:100%; margin-top:6px; font-size:0.78rem; border-collapse:collapse;">
          <tr style="text-align:left; color:var(--text-dim);">
            <th style="padding:2px 6px;">Artist</th>
            <th style="padding:2px 6px;">Track</th>
            <th style="padding:2px 6px;">Score</th>
            <th style="padding:2px 6px;">Synced?</th>
            <th style="padding:2px 6px;">Lines</th>
          </tr>`;
        attempt.candidates.forEach(c => {
          html += `<tr style="border-top:1px solid var(--border);">
            <td style="padding:2px 6px;">${esc(c.artistName)}</td>
            <td style="padding:2px 6px;">${esc(c.trackName)}</td>
            <td style="padding:2px 6px;">${c.score}</td>
            <td style="padding:2px 6px;">${c.has_synced ? 'yes' : 'no'}</td>
            <td style="padding:2px 6px;">${c.line_count}</td>
          </tr>`;
        });
        html += `</table>`;
      }
    }
    html += `</div>`;
  });

  if (matched) {
    html += `<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">
      <p><strong>First lines:</strong></p>
      <pre style="white-space:pre-wrap; font-size:0.78rem; margin-top:4px;">${
        esc(debug.lines.slice(0, 6).map(l => `[${l.time.toFixed(2)}] ${l.text}`).join('\n'))
      }</pre>
    </div>`;
  }

  detail.innerHTML = html;
  card.appendChild(detail);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
