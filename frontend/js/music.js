// ─── Icons ────────────────────────────────────────────────────────────────────

const TYPE_ICON = {
  mp3:  '🎵',
  flac: '💿',
};

function typeIcon(type) {
  return TYPE_ICON[type] || '🎵';
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Queue ────────────────────────────────────────────────────────────────────

class Queue {
  constructor() {
    this.items = [];
    this.current = -1;
  }

  add(song) {
    this.items.push(song);
    this.render();
    return this.items.length - 1;
  }

  remove(idx) {
    if (idx === this.current) return; // can't remove playing
    this.items.splice(idx, 1);
    if (idx < this.current) this.current--;
    this.render();
  }

  setCurrent(idx) {
    this.current = idx;
    this.render();
  }

  advance(autoRemove) {
    if (autoRemove && this.current >= 0) {
      this.items.splice(this.current, 1);
      // current stays, now pointing to next
    } else {
      this.current++;
    }
    if (this.current >= this.items.length) { this.current = -1; return null; }
    this.render();
    return this.items[this.current];
  }

  prev() {
    if (this.current <= 0) return null;
    this.current--;
    this.render();
    return this.items[this.current];
  }

  start() {
    if (!this.items.length) return null;
    this.current = 0;
    this.render();
    return this.items[0];
  }

  song() {
    return this.current >= 0 ? this.items[this.current] : null;
  }

  render() {
    const el = document.getElementById('queue-list');
    if (!el) return;
    el.innerHTML = '';
    this.items.forEach((song, i) => {
      const div = document.createElement('div');
      div.className = 'queue-item' + (i === this.current ? ' playing' : '');
      div.dataset.idx = i;
      div.innerHTML = `
        <span class="q-num">${i + 1}</span>
        <span class="q-icon">${typeIcon(song.type)}</span>
        <span class="q-title">${esc(song.artist ? `${song.artist} — ${song.title}` : song.title)}</span>
        <button class="q-remove" data-idx="${i}" title="Remove">✕</button>
      `;
      el.appendChild(div);
    });

    // Scroll to current
    const playing = el.querySelector('.playing');
    if (playing) playing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    document.getElementById('queue-count').textContent =
      this.items.length ? `(${this.items.length})` : '';
  }
}

// ─── Lyrics ───────────────────────────────────────────────────────────────────
// Plain lyrics text pulled from a free internet lyrics API (no timestamps,
// so there's no word-by-word sync — just the full lyric sheet for the track).

function setLyricsStatus(text) {
  const el = document.getElementById('lyrics-display');
  el.innerHTML = `<div class="lyrics-status">${esc(text)}</div>`;
}

function renderLyricsText(text) {
  const el = document.getElementById('lyrics-display');
  el.innerHTML = text
    .split(/\r?\n/)
    .map(line => `<p class="lyrics-line">${esc(line) || '&nbsp;'}</p>`)
    .join('');
}

async function loadLyrics(song) {
  setLyricsStatus('Looking up lyrics…');

  try {
    const res = await fetch(`/api/music/${song.id}/lyrics`);
    if (!res.ok) throw new Error('Lyrics unavailable');
    const { lyrics } = await res.json();
    if (lyrics) {
      renderLyricsText(lyrics);
    } else {
      setLyricsStatus('No lyrics found for this track.');
    }
  } catch (_) {
    setLyricsStatus('Lyrics unavailable for this track.');
  }
}

// ─── Album art ────────────────────────────────────────────────────────────────

async function loadAlbumArt(song) {
  const el = document.getElementById('album-art');
  el.classList.add('hidden');
  el.src = '';
  try {
    const res = await fetch(`/api/music/${song.id}/albumart`);
    if (!res.ok) return;
    const { artworkUrl } = await res.json();
    if (artworkUrl) {
      el.src = artworkUrl;
      el.classList.remove('hidden');
    }
  } catch (_) { /* no artwork available */ }
}

// ─── Player ───────────────────────────────────────────────────────────────────

class Player {
  constructor() {
    this.audio = new Audio();
    this.currentSong = null;

    this.audio.addEventListener('ended',  () => onSongEnded());
    this.audio.addEventListener('play',   () => updatePlayBtn());
    this.audio.addEventListener('pause',  () => updatePlayBtn());
    this.audio.addEventListener('timeupdate', () => updateProgress());
  }

  async load(song) {
    this.stop();
    this.currentSong = song;

    document.getElementById('idle-screen').style.display = 'none';
    document.getElementById('lyrics-display').classList.remove('hidden');
    setLyricsStatus('Loading…');

    this.audio.src = `/api/music/${song.id}/audio`;

    document.getElementById('now-playing').textContent =
      song.artist ? `${song.artist} — ${song.title}` : song.title;
    document.getElementById('song-type-badge').textContent =
      typeIcon(song.type) + ' ' + (song.extension || song.type).toUpperCase();

    loadAlbumArt(song);
    loadLyrics(song);
  }

  play() { this.audio.play(); }
  pause() { this.audio.pause(); }
  toggle() { this.audio.paused ? this.play() : this.pause(); }

  stop() {
    this.audio.pause();
    this.audio.src = '';
    document.getElementById('lyrics-display').classList.add('hidden');
    document.getElementById('album-art').classList.add('hidden');
  }

  isPaused() { return this.audio.paused; }
  duration() { return this.audio.duration; }
  currentTime() { return this.audio.currentTime; }

  seek(ratio) {
    const dur = this.duration();
    if (!isFinite(dur)) return;
    this.audio.currentTime = ratio * dur;
  }
}

// ─── App State ────────────────────────────────────────────────────────────────

const queue  = new Queue();
let   player = null;
let   searchTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  player = new Player();

  // Library indexing
  loadIndexStats();
  document.getElementById('btn-index-music').addEventListener('click', startIndexMusic);

  // Search input
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(searchInput.value.trim()), 200);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
  });

  // Close search dropdown on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-container')) closeSearch();
  });

  // Queue list events (delegated)
  document.getElementById('queue-list').addEventListener('click', e => {
    const removeBtn = e.target.closest('.q-remove');
    const item      = e.target.closest('.queue-item');
    if (removeBtn) {
      queue.remove(parseInt(removeBtn.dataset.idx));
    } else if (item) {
      playFromQueue(parseInt(item.dataset.idx));
    }
  });

  // Controls
  document.getElementById('btn-prev').addEventListener('click', playPrev);
  document.getElementById('btn-play').addEventListener('click', () => {
    if (!player.currentSong && queue.items.length) {
      const song = queue.start();
      if (song) player.load(song).then(() => player.play());
    } else {
      player.toggle();
    }
    updatePlayBtn();
  });
  document.getElementById('btn-next').addEventListener('click', playNext);

  // Progress bar
  const progressBar = document.getElementById('progress-bar');
  progressBar.addEventListener('click', e => {
    const rect = progressBar.getBoundingClientRect();
    player.seek((e.clientX - rect.left) / rect.width);
  });
});

// ─── Library indexing ──────────────────────────────────────────────────────────

async function loadIndexStats() {
  const countEl = document.getElementById('music-index-count');
  try {
    const res = await fetch('/api/admin/music/stats');
    const data = await res.json();
    const n = data.numberOfDocuments ?? 0;
    countEl.textContent = `${n} track${n !== 1 ? 's' : ''} indexed`;
  } catch (_) {
    countEl.textContent = 'Index status unavailable';
  }
}

async function startIndexMusic() {
  const btn = document.getElementById('btn-index-music');
  const countEl = document.getElementById('music-index-count');
  btn.disabled = true;
  btn.textContent = '⏳ Indexing…';
  countEl.textContent = 'Scanning MUSIC_PATH…';

  try {
    const res = await fetch('/api/admin/music/index', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      countEl.textContent = `✓ Indexed ${data.indexed} track${data.indexed !== 1 ? 's' : ''}`;
    } else {
      countEl.textContent = `✗ Error: ${data.error}`;
    }
  } catch (e) {
    countEl.textContent = `✗ Network error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Index Music';
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function doSearch(q) {
  if (!q) { closeSearch(); return; }
  try {
    const res  = await fetch(`/api/music/search?q=${encodeURIComponent(q)}&limit=20`);
    const data = await res.json();
    renderSearchResults(data.hits || []);
  } catch (_) {
    renderSearchResults([]);
  }
}

function renderSearchResults(hits) {
  const container = document.getElementById('search-results');
  if (!hits.length) {
    container.innerHTML = '<div class="search-empty">No results</div>';
    container.classList.remove('hidden');
    return;
  }
  container.innerHTML = hits.map(h => `
    <div class="search-hit" data-song='${JSON.stringify(h).replace(/'/g, "&#39;")}'>
      <span class="hit-icon">${typeIcon(h.type)}</span>
      <span class="hit-title">${esc(h.artist ? `${h.artist} — ${h.title}` : h.title)}</span>
      <span class="hit-badge">${esc(h.extension || h.type).toUpperCase()}</span>
    </div>
  `).join('');

  container.querySelectorAll('.search-hit').forEach(el => {
    el.addEventListener('click', () => {
      try {
        const song = JSON.parse(el.dataset.song);
        addToQueue(song);
      } catch (_) {}
    });
  });

  container.classList.remove('hidden');
}

function closeSearch() {
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-results').innerHTML = '';
}

// ─── Queue Management ─────────────────────────────────────────────────────────

function addToQueue(song) {
  const wasEmpty = queue.items.length === 0;
  queue.add(song);

  const input = document.getElementById('search-input');
  input.value = '';
  closeSearch();
  input.placeholder = `"${song.title}" added to queue`;
  setTimeout(() => { input.placeholder = 'Search music…'; }, 2000);

  if (wasEmpty) {
    playFromQueue(0);
  }
}

async function playFromQueue(idx) {
  queue.setCurrent(idx);
  const song = queue.song();
  if (!song) return;
  await player.load(song);
  player.play();
  updatePlayBtn();
}

function playNext() {
  const autoRemove = document.getElementById('auto-remove').checked;
  const next = queue.advance(autoRemove);
  if (next) {
    player.load(next).then(() => player.play());
  } else {
    player.stop();
    document.getElementById('now-playing').textContent = '— nothing playing —';
    document.getElementById('song-type-badge').textContent = '';
    document.getElementById('idle-screen').style.display = 'flex';
  }
  updatePlayBtn();
}

function playPrev() {
  const prev = queue.prev();
  if (prev) player.load(prev).then(() => player.play());
  updatePlayBtn();
}

function onSongEnded() {
  playNext();
}

// ─── UI Updates ───────────────────────────────────────────────────────────────

function updatePlayBtn() {
  document.getElementById('btn-play').textContent = player.isPaused() ? '▶' : '⏸';
}

function updateProgress() {
  const cur = player.currentTime();
  const dur = player.duration();
  if (!isFinite(dur) || dur === 0) return;

  const pct = (cur / dur) * 100;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('time-current').textContent = fmtTime(cur);
  document.getElementById('time-duration').textContent = fmtTime(dur);
}

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}
