# gioKaraoke

Containerised karaoke player — search a library of MP3+CDG, MP4, and ZIP files, queue songs, and display synchronized lyrics in the browser.

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

### 3. Start the containers

```bash
docker compose up -d
```

This starts two containers:
- **giokaraoke-app** — the web app, accessible at **http://localhost:8094**
- **giokaraoke-search** — Meilisearch on port 7700 (internal use)

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
- **CDG canvas** — synchronized karaoke lyrics rendered in the browser via Canvas API
- **Progress bar** — click to seek

---

## Ports

| Service | Host port | Container port |
|---------|-----------|----------------|
| Web app | **8094** | 3000 |
| Meilisearch | 7700 | 7700 |

---

## Stopping

```bash
docker compose down
```

Song library data (Meilisearch index) is stored in a Docker named volume and persists across restarts. To clear it:

```bash
docker compose down -v
```

---

## Project Structure

```
gioKaraoke/
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js          # Express API + static file serving
└── frontend/
    ├── index.html          # Karaoke player
    ├── admin.html          # Library management
    ├── css/style.css
    └── js/
        ├── app.js          # Queue, player, search logic
        └── cdg-renderer.js # CD+G canvas renderer
```
