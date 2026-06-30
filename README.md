# gioKaraoke

Containerised karaoke player — search a library of MP3+CDG, MP4, and ZIP files, queue songs, and display synchronized lyrics in the browser. Includes a built-in YouTube to MP3 converter with optional AI audio enhancement.

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

Edit `.env` and set `SONGS_PATH` to the absolute path of your karaoke files on the host:

```env
SONGS_PATH=/home/user/karaoke
MEILI_MASTER_KEY=karaoke-secret-key
```

If `SONGS_PATH` is not set, the stack defaults to the empty `./songs/` directory in the repo root.

### 3. Start the containers

```bash
docker compose up -d
```

This starts three containers:
- **giokaraoke-app** — the web app, accessible at **http://localhost:8094**
- **giokaraoke-processor** — Python/FastAPI service for audio conversion (internal)
- **giokaraoke-search** — Meilisearch (internal, port 7700)

The app waits for Meilisearch to pass its health check before starting.

### 4. Index your song library

Open **http://localhost:8094/admin.html** and click **⚡ Index Songs**.

The indexer scans the mounted `/songs` directory, finds all supported files, and populates the search index. Re-indexing is safe and idempotent.

### 5. Start singing

Open **http://localhost:8094**, search for a song, and add it to the queue.

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

---

## Karaoke Creator

Open **http://localhost:8094/convert.html** to turn any MP3 into a karaoke MP4 with synced, highlighted lyrics — entirely on your own infrastructure.

### Pipeline

1. **Vocal separation** — `audio-separator` (`UVR_MDXNET_KARA_2.onnx`, CPU-only ONNX inference) splits the track into instrumental and vocal stems
2. **Lyrics acquisition** — fetches synced lyrics from [lrclib.net](https://lrclib.net) (free, unauthenticated) using the "Artist - Title" filename convention; falls back to Whisper transcription (`whisper-timestamped`, model `base`) if lrclib.net has no match or returns fewer than 4 lines
3. **Subtitle generation** — converts the lyrics (LRC timestamps or Whisper segments) into an ASS karaoke subtitle file with a `\kf` fill effect; the generated file is validated to contain at least one `Dialogue:` line before rendering, so a failed fetch surfaces a warning instead of silently shipping a video with no lyrics
4. **Background generation** — PIL-rendered background image
5. **Render** — FFmpeg burns the subtitles and audio into the final MP4

### Lyrics preview

While a job is processing, a **🎵 Lyrics Preview** panel shows up to 4 lines at a time with the current line highlighted in the middle. Click **▶ Auto-scroll** to play through the lyrics on their original timestamps (lrclib.net jobs only).

### Reliability

- The vocal-separation step is CPU-bound and can take 10–20+ minutes on larger files; it now has a 40-minute hard timeout so a stuck job fails with a clear error instead of running forever
- If the processor container restarts mid-job (e.g. an out-of-memory kill during separation), the browser detects 20 seconds of SSE silence and shows "Server stopped responding" instead of leaving the progress bar frozen indefinitely

---

## Configuration

All settings are controlled via environment variables (`.env` file or shell environment).

| Variable | Default | Description |
|----------|---------|-------------|
| `SONGS_PATH` | `./songs` | Host path to your karaoke files directory |
| `MEILI_MASTER_KEY` | `karaoke-secret-key` | Meilisearch master key — change this in any non-local deployment |

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
├── backend/
│   ├── Dockerfile             # Node 20-alpine image
│   ├── package.json
│   └── server.js              # Express API + static file serving + processor proxy
├── processor/
│   ├── Dockerfile             # Python 3.11-slim + FFmpeg + yt-dlp + Node.js
│   ├── requirements.txt
│   └── app.py                 # FastAPI: YouTube download + audio transcoding/enhancement
└── frontend/
    ├── index.html             # Karaoke player
    ├── youtube.html           # YouTube to MP3 converter
    ├── convert.html           # MP3 to karaoke MP4 creator
    ├── admin.html             # Library management & indexing
    ├── css/style.css
    └── js/
        ├── app.js             # Queue, player, search logic
        ├── youtube.js         # YouTube converter UI + SSE job tracking
        ├── convert.js         # Karaoke creator UI + lyrics preview + SSE job tracking
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
