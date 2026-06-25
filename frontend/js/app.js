// ─── Icons ────────────────────────────────────────────────────────────────────

const TYPE_ICON = {
  mp3cdg: '🎤',
  mp4:    '🎬',
  zip:    '📦',
  mp3:    '🎵',
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
        <span class="q-title">${esc(song.title)}</span>
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

// ─── Player ───────────────────────────────────────────────────────────────────

class Player {
  constructor(cdgCanvas, videoEl) {
    this.cdgCanvas = cdgCanvas;
    this.videoEl = videoEl;
    this.audio = new Audio();
    this.cdg = new CDGRenderer(cdgCanvas);
    this.animFrame = null;
    this.currentSong = null;

    this.audio.addEventListener('ended',  () => onSongEnded());
    this.videoEl.addEventListener('ended', () => onSongEnded());
    this.audio.addEventListener('play',   () => updatePlayBtn());
    this.audio.addEventListener('pause',  () => updatePlayBtn());
    this.videoEl.addEventListener('play',  () => updatePlayBtn());
    this.videoEl.addEventListener('pause', () => updatePlayBtn());
    this.audio.addEventListener('timeupdate', () => updateProgress());
    this.videoEl.addEventListener('timeupdate', () => updateProgress());

    // 'playing' fires when audio truly starts after buffering — anchor CDG here.
    // 'seeked'  fires after the user scrubs — jump CDG to the new position.
    this.audio.addEventListener('playing', () => {
      this.cdg.seekTo(this.audio.currentTime);
      if (!this.animFrame) this._startLoop();
    });
    this.audio.addEventListener('seeked', () => {
      this.cdg.seekTo(this.audio.currentTime);
    });
  }

  async load(song) {
    this.stop();
    this.currentSong = song;

    const idle = document.getElementById('idle-screen');
    if (idle) idle.style.display = 'none';

    if (song.type === 'mp4') {
      this.videoEl.src = `/api/songs/${song.id}/audio`;
      this.videoEl.style.display = 'block';
      this.cdgCanvas.style.display = 'none';
    } else {
      this.videoEl.style.display = 'none';
      this.cdgCanvas.style.display = 'block';
      this.audio.src = `/api/songs/${song.id}/audio`;

      if (song.type === 'mp3cdg' || song.type === 'zip') {
        try {
          const res = await fetch(`/api/songs/${song.id}/cdg`);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            this.cdg.load(buf);
            // Calibrate now if audio duration is already known
            if (isFinite(this.audio.duration)) {
              this.cdg.calibrate(this.audio.duration);
            }
            // Also calibrate once metadata arrives (whichever comes last)
            this.audio.addEventListener('loadedmetadata', () => {
              this.cdg.calibrate(this.audio.duration);
            }, { once: true });
          }
        } catch (_) { /* play without CDG */ }
      } else {
        this.cdg.reset();
      }
    }

    document.getElementById('now-playing').textContent = song.title;
    document.getElementById('song-type-badge').textContent = typeIcon(song.type) + ' ' + (song.extension || song.type).toUpperCase();
  }

  play() {
    if (!this.currentSong) return;
    if (this.currentSong.type === 'mp4') {
      this.videoEl.play();
    } else {
      this.audio.play();
      this._startLoop();
    }
  }

  pause() {
    this.audio.pause();
    this.videoEl.pause();
  }

  toggle() {
    const src = this.currentSong?.type === 'mp4' ? this.videoEl : this.audio;
    src.paused ? this.play() : this.pause();
  }

  stop() {
    if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }
    this.audio.pause();
    this.audio.src = '';
    this.videoEl.pause();
    this.videoEl.src = '';
    this.cdg.reset();
  }

  _startLoop() {
    const loop = () => {
      this.cdg.seekTo(this.audio.currentTime);
      this.animFrame = requestAnimationFrame(loop);
    };
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.animFrame = requestAnimationFrame(loop);
  }

  isPaused() {
    if (!this.currentSong) return true;
    return this.currentSong.type === 'mp4' ? this.videoEl.paused : this.audio.paused;
  }

  duration() {
    return this.currentSong?.type === 'mp4' ? this.videoEl.duration : this.audio.duration;
  }

  currentTime() {
    return this.currentSong?.type === 'mp4' ? this.videoEl.currentTime : this.audio.currentTime;
  }

  seek(ratio) {
    const dur = this.duration();
    if (!isFinite(dur)) return;
    const t = ratio * dur;
    if (this.currentSong?.type === 'mp4') {
      this.videoEl.currentTime = t;
    } else {
      this.audio.currentTime = t;
    }
  }
}

// ─── App State ────────────────────────────────────────────────────────────────

const queue  = new Queue();
let   player = null;
let   searchTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const cdgCanvas = document.getElementById('cdg-canvas');
  const videoEl   = document.getElementById('video-player');
  player = new Player(cdgCanvas, videoEl);

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

// ─── Search ───────────────────────────────────────────────────────────────────

async function doSearch(q) {
  if (!q) { closeSearch(); return; }
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
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
      <span class="hit-title">${esc(h.title)}</span>
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

  // Show feedback
  const btn = document.getElementById('search-input');
  btn.value = '';
  closeSearch();
  btn.placeholder = `"${song.title}" added to queue`;
  setTimeout(() => { btn.placeholder = 'Search songs…'; }, 2000);

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
