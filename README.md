# gioKaraoke

Containerised karaoke player — search a library of MP3+CDG, MP4, and ZIP files, queue songs, and display synchronized lyrics in the browser. Also includes a separate Music Library player (MP3/FLAC, lyrics, album art), a built-in YouTube to MP3 converter with optional AI audio enhancement, and optional HTTP Basic Auth to lock down access to the whole app.

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)
- A folder of karaoke files (MP3+CDG pairs, MP4, or ZIP files containing either)

---

## Quick Start

### 1. Clone the repo

```bash
git clone <repo-url>
cd gioKaraoke
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set `SONGS_PATH` / `MUSIC_PATH` to the absolute paths of your karaoke and music files on the host, and set `AUTH_USERNAME` / `AUTH_PASSWORD` to protect the app with a login:

```env
SONGS_PATH=/home/user/karaoke
MUSIC_PATH=/home/user/music
MEILI_MASTER_KEY=karaoke-secret-key
AUTH_USERNAME=admin
AUTH_PASSWORD=change-me
```

If `SONGS_PATH` / `MUSIC_PATH` are not set, the stack defaults to the empty `./songs/` and `./music/` directories in the repo root. If `AUTH_USERNAME` / `AUTH_PASSWORD` are left blank, the app is unprotected (HTTP Basic Auth is skipped entirely).

### 3. Start the containers

```bash
docker compose up -d
```

This starts three containers:
- **giokaraoke-app** — the web app, accessible at **http://localhost:8094**
- **giokaraoke-processor** — Python/FastAPI service for audio conversion (internal)
- **giokaraoke-search** — Meilisearch (internal, port 7700)

The app waits for Meilisearch to pass its health check before starting.

### 4. Index your libraries

Open **http://localhost:8094/admin.html** and click **⚡ Index Songs** for the karaoke library. For the music library, open **http://localhost:8094/music.html** and click **⚡ Index Music** at the top of the left panel.

Both indexers scan their respective mounted directories (`/songs`, `/music`), find all supported files, and populate their own Meilisearch index (`songs` and `music`, in the same Meilisearch instance). Re-indexing is safe and idempotent.

### 5. Start singing (or listening)

Open **http://localhost:8094** — if a login is configured, enter the `AUTH_USERNAME` / `AUTH_PASSWORD` credentials — then choose **Karaoke** or **Music Library**, search, and add tracks to the queue.

---

## Supported Formats

| Format | Description |
|--------|-------------|
| `song.mp3` + `song.cdg` | Standard karaoke pair — CDG lyrics synced to audio |
| `song.mp4` | Video karaoke file |
| `song.zip` | ZIP containing an MP3+CDG pair or an MP4 |
| `song.mp3` | Audio only (no lyrics graphics) |

MP3+CDG pairs are matched by sharing the same base filename in the same directory.

---

## Player Features

- **Search as you type** — Meilisearch-powered instant search with format icons
- **Queue** — scrollable list; currently playing song is highlighted
- **Controls** — previous / play-pause / next; click any queue item to jump to it
- **Auto-remove** — checkbox to remove songs from the queue after they finish playing
- **CDG canvas** — synchronized karaoke lyrics rendered in the browser via Canvas API (300×216 px native, 75 packets/sec)
- **Progress bar** — click to seek

---

## Music Library

Open **http://localhost:8094/music.html** to search and queue your MP3 / FLAC music collection, separate from the karaoke song library.

### Features

- **Search & queue** — same Meilisearch-powered instant search and queue UX as the karaoke player
- **MP3 + FLAC playback** — lossless FLAC files stream and play natively in the browser
- **Lyrics** — full lyric sheet pulled from the free lyrics.ovh API based on the track's artist/title, shown in the main display area (not synced to playback — internet lyrics have no timestamps)
- **Album art** — fetched from the free iTunes Search API based on the track's artist/title and shown in the corner of the display area
- **Self-service indexing** — a compact "⚡ Index Music" bar at the top of the page rebuilds the `music` search index without needing the admin page

Both lyrics and album art lookups are cached in memory by the backend so repeat plays don't re-query the internet.

---

## YouTube to MP3 Converter

Open **http://localhost:8094/youtube.html** to convert any YouTube video or playlist to MP3 entirely on your own infrastructure — no third-party services involved.

### Features

- **Real-time pipeline progress** — 5-step status display: URL Parse → Stream Extract → Download → Transcode → AI Enhance
- **Bitrate selection** — 128 / 192 / 320 kbps
- **AI audio enhancement** (optional) — FFmpeg `anlmdn` noise reduction followed by EBU R128 loudness normalization via `loudnorm`
- **Playlist / batch support** — paste a playlist URL to queue up to 50 videos at once
- **Save to Library** — optionally copy the finished MP3 directly into the host karaoke library so it appears in search immediately
- **Browser download** — download the MP3 to your device with the original video title as the filename

### How it works

| Tool | Role |
|------|------|
| **yt-dlp** | Extracts metadata, selects the best audio-only stream (AAC or Opus), downloads with real-time speed reporting |
| **FFmpeg libmp3lame** | Transcodes the raw stream to MP3 at the chosen bitrate with embedded ID3 title tag |
| **FFmpeg anlmdn** | AI non-local means denoising to reduce background hiss (optional) |
| **FFmpeg loudnorm** | EBU R128 broadcast loudness normalization for consistent playback volume (optional) |

Processing runs in the `giokaraoke-processor` container. Files are never stored inside the container — they are streamed directly to the browser or saved to the host library volume.

### Reliability

Both the Karaoke Creator and YouTube converter track job progress over Server-Sent Events. The processor emits a heartbeat every ~1.5s for the life of a job, so the frontend can tell the difference between "still working" and "connection died" — if no heartbeat arrives for 20 seconds (e.g. the processor container restarted mid-job, or the host went to sleep), the UI automatically reconnects with backoff (up to 6 attempts) instead of hanging silently.

---

## Configuration

All settings are controlled via environment variables (`.env` file or shell environment).

| Variable | Default | Description |
|----------|---------|-------------|
| `SONGS_PATH` | `./songs` | Host path to your karaoke files directory |
| `MUSIC_PATH` | `./music` | Host path to your MP3 / FLAC music directory |
| `MEILI_MASTER_KEY` | `karaoke-secret-key` | Meilisearch master key — change this in any non-local deployment |
| `AUTH_USERNAME` | *(blank)* | HTTP Basic Auth username — leave blank to disable login |
| `AUTH_PASSWORD` | *(blank)* | HTTP Basic Auth password — leave blank to disable login |

---

## Ports

| Service | Host port | Container port |
|---------|-----------|----------------|
| Web app | **8094** | 3000 |
| Meilisearch | 7700 | 7700 |

The processor service runs on port 5000 internally and is not exposed to the host.

---

## Stopping

```bash
docker compose down
```

The Meilisearch index is stored in a Docker named volume (`meilisearch_data`) and persists across restarts. To wipe it and start fresh:

```bash
docker compose down -v
```

---

## Project Structure

```
gioKaraoke/
├── docker-compose.yml
├── .env.example
├── songs/                     # Default empty mount point (git-ignored)
├── music/                     # Default empty mount point (git-ignored)
├── backend/
│   ├── Dockerfile             # Node 20-alpine image
│   ├── package.json
│   └── server.js              # Express API + basic auth + static file serving + processor proxy
├── processor/
│   ├── Dockerfile             # Python 3.11-slim + FFmpeg + yt-dlp + Node.js
│   ├── requirements.txt
│   └── app.py                 # FastAPI: YouTube download + audio transcoding/enhancement
└── frontend/
    ├── index.html             # Landing page (Karaoke / Music Library)
    ├── karaoke.html           # Karaoke player
    ├── music.html             # Music library player (lyrics + album art)
    ├── youtube.html           # YouTube to MP3 converter
    ├── admin.html             # Library management & indexing
    ├── css/style.css
    └── js/
        ├── app.js             # Karaoke queue, player, search logic
        ├── music.js           # Music queue, player, lyrics, album art
        ├── youtube.js         # YouTube converter UI + SSE job tracking + reconnect
        └── cdg-renderer.js    # CD+G canvas renderer
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20 / Express |
| Processor | Python 3.11 / FastAPI |
| Audio | FFmpeg, yt-dlp |
| Search | Meilisearch v1.7 |
| Frontend | Vanilla JS, no framework or bundler |
| Container | Docker Compose (three services) |
| ZIP support | adm-zip |
