require('dotenv').config();
const express = require('express');
const { MeiliSearch } = require('meilisearch');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const SONGS_PATH = process.env.SONGS_PATH || '/songs';
const MUSIC_PATH = process.env.MUSIC_PATH || '/music';
const MEILI_URL = process.env.MEILISEARCH_URL || 'http://localhost:7700';
const MEILI_KEY = process.env.MEILISEARCH_KEY || '';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:5000';
const AUTH_USERNAME = process.env.AUTH_USERNAME || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

const client = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_KEY });

// Cache for extracted ZIP files: songId -> { audioPath, cdgPath, type, tempDir }
const zipCache = new Map();
// Cache for album art lookups: musicId -> artworkUrl|null
const artworkCache = new Map();
// Cache for lyrics lookups: musicId -> lyrics text|null
const lyricsCache = new Map();
// Cache for resolved track metadata (via iTunes): musicId -> { artist, title, artworkUrl }
const trackMetaCache = new Map();

// Many library filenames don't follow an "Artist - Title" pattern, so the
// indexed `artist` field is often blank. iTunes' fuzzy search resolves the
// real artist/title from just the (cleaned) filename, which both the album
// art lookup and the lyrics.ovh lookup need to find a match.
async function resolveTrackMeta(id) {
  if (trackMetaCache.has(id)) return trackMetaCache.get(id);

  const doc = await client.index('music').getDocument(id);
  const term = [doc.artist, doc.title].filter(Boolean).join(' ') || doc.title;
  let meta = { artist: doc.artist || '', title: doc.title, artworkUrl: null };

  try {
    const searchUrl = `https://itunes.apple.com/search?media=music&limit=1&term=${encodeURIComponent(term)}`;
    const itunesRes = await fetch(searchUrl);
    const data = await itunesRes.json();
    const hit = data.results?.[0];
    if (hit) {
      meta = {
        artist: hit.artistName || meta.artist,
        title: hit.trackName || meta.title,
        artworkUrl: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '600x600') : null,
      };
    }
  } catch (_) { /* iTunes lookup failed — fall back to filename-derived metadata */ }

  trackMetaCache.set(id, meta);
  return meta;
}

// ─── Basic Auth ───────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  if (!AUTH_USERNAME || !AUTH_PASSWORD) return next(); // auth disabled if unset

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user && pass && safeEqual(user, AUTH_USERNAME) && safeEqual(pass, AUTH_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="gioKaraoke"');
  res.status(401).send('Authentication required.');
}

app.use(basicAuth);
app.use(express.json());
app.use(express.static(FRONTEND_DIR));

// ─── Meilisearch setup ────────────────────────────────────────────────────────

async function setupMeilisearch() {
  try {
    await client.createIndex('songs', { primaryKey: 'id' });
  } catch (_) { /* index already exists */ }

  const index = client.index('songs');
  await index.updateSettings({
    searchableAttributes: ['title', 'filename'],
    filterableAttributes: ['type'],
    displayedAttributes: ['id', 'title', 'filename', 'extension', 'type', 'path'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  });

  try {
    await client.createIndex('music', { primaryKey: 'id' });
  } catch (_) { /* index already exists */ }

  const musicIndex = client.index('music');
  await musicIndex.updateSettings({
    searchableAttributes: ['title', 'artist', 'filename'],
    filterableAttributes: ['type'],
    displayedAttributes: ['id', 'title', 'artist', 'filename', 'extension', 'type', 'path'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walkDir(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkDir(full));
      else if (entry.isFile()) results.push(full);
    }
  } catch (_) { /* unreadable dir */ }
  return results;
}

function cleanTitle(filename) {
  return filename
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function pathToId(p) {
  return crypto.createHash('md5').update(p).digest('hex');
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.cdg': 'application/octet-stream',
    '.flac': 'audio/flac',
  }[ext] || 'application/octet-stream';
}

function parseArtistTitle(filename) {
  // Split on the raw filename's " - " separator *before* cleanTitle runs —
  // cleanTitle collapses "-" into a space (it treats it like "_"/"."), so
  // splitting on the cleaned string never finds the separator.
  const match = filename.match(/^(.+?)\s+-\s+(.+)$/);
  if (match) {
    return { artist: cleanTitle(match[1]), title: cleanTitle(match[2]) };
  }
  return { artist: '', title: cleanTitle(filename) };
}

function streamFile(req, res, filePath, mime) {
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const size = stat.size;
  const type = mime || getMimeType(filePath);
  const range = req.headers.range;

  if (range) {
    const [rawStart, rawEnd] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(rawStart, 10);
    const end = rawEnd ? parseInt(rawEnd, 10) : size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': size,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function resolvePaths(id) {
  const index = client.index('songs');
  const doc = await index.getDocument(id);

  if (doc.type === 'mp3cdg') {
    return { audioPath: doc.path + '.mp3', cdgPath: doc.path + '.cdg', type: 'mp3cdg' };
  }
  if (doc.type === 'mp4') {
    return { audioPath: doc.path + '.mp4', type: 'mp4' };
  }
  if (doc.type === 'mp3') {
    return { audioPath: doc.path + '.mp3', type: 'mp3' };
  }
  if (doc.type === 'zip') {
    if (!zipCache.has(id)) {
      const zip = new AdmZip(doc.path + '.zip');
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-'));
      let audioPath = null, cdgPath = null, innerType = 'mp3';

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const ext = path.extname(entry.entryName).toLowerCase();
        if (!['.mp3', '.mp4', '.cdg'].includes(ext)) continue;
        const dest = path.join(tempDir, path.basename(entry.entryName));
        fs.writeFileSync(dest, entry.getData());
        if (ext === '.mp3' || ext === '.mp4') { audioPath = dest; innerType = ext.slice(1); }
        if (ext === '.cdg') cdgPath = dest;
      }

      zipCache.set(id, {
        audioPath,
        cdgPath,
        type: cdgPath ? 'mp3cdg' : innerType,
        tempDir,
      });
    }
    return zipCache.get(id);
  }
  throw new Error('Unknown song type: ' + doc.type);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const results = await client.index('songs').search(q, { limit });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/songs/:id/info', async (req, res) => {
  try {
    const doc = await client.index('songs').getDocument(req.params.id);
    res.json(doc);
  } catch (e) {
    res.status(404).json({ error: 'Song not found' });
  }
});

app.get('/api/songs/:id/audio', async (req, res) => {
  try {
    const { audioPath } = await resolvePaths(req.params.id);
    streamFile(req, res, audioPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/songs/:id/cdg', async (req, res) => {
  try {
    const { cdgPath } = await resolvePaths(req.params.id);
    if (!cdgPath) return res.status(404).json({ error: 'No CDG for this song' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(cdgPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Music Library Routes ──────────────────────────────────────────────────────

app.get('/api/music/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const results = await client.index('music').search(q, { limit });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/music/:id/info', async (req, res) => {
  try {
    const doc = await client.index('music').getDocument(req.params.id);
    res.json(doc);
  } catch (e) {
    res.status(404).json({ error: 'Track not found' });
  }
});

app.get('/api/music/:id/audio', async (req, res) => {
  try {
    const doc = await client.index('music').getDocument(req.params.id);
    const audioPath = doc.path + '.' + doc.extension;
    streamFile(req, res, audioPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/music/:id/albumart', async (req, res) => {
  try {
    const id = req.params.id;
    if (artworkCache.has(id)) {
      const cached = artworkCache.get(id);
      return cached ? res.json({ artworkUrl: cached }) : res.status(404).json({ error: 'No artwork found' });
    }

    const meta = await resolveTrackMeta(id);
    artworkCache.set(id, meta.artworkUrl);
    if (meta.artworkUrl) {
      res.json({ artworkUrl: meta.artworkUrl });
    } else {
      res.status(404).json({ error: 'No artwork found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function lookupLyrics(artist, title) {
  if (!artist || !title) return null;
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  return (data.lyrics || '').trim() || null;
}

// Fetches plain-text lyrics from the free lyrics.ovh API. Tries the filename-
// parsed artist/title first (it's often already correct and more literal to
// what's on disk), and only falls back to the iTunes-resolved metadata —
// which can occasionally match the wrong recording — if that comes up empty.
app.get('/api/music/:id/lyrics', async (req, res) => {
  try {
    const id = req.params.id;
    if (lyricsCache.has(id)) {
      const cached = lyricsCache.get(id);
      return cached ? res.json({ lyrics: cached }) : res.status(404).json({ error: 'No lyrics found' });
    }

    const doc = await client.index('music').getDocument(id);
    let lyrics = await lookupLyrics(doc.artist, doc.title);

    if (!lyrics) {
      const meta = await resolveTrackMeta(id);
      lyrics = await lookupLyrics(meta.artist, meta.title);
      if (!lyrics) {
        console.error(`[lyrics] no match for "${id}" — tried ("${doc.artist}", "${doc.title}") and iTunes-resolved ("${meta.artist}", "${meta.title}")`);
      }
    }

    lyricsCache.set(id, lyrics);
    if (lyrics) {
      res.json({ lyrics });
    } else {
      res.status(404).json({ error: 'No lyrics found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

app.post('/api/admin/index', async (req, res) => {
  try {
    const allFiles = walkDir(SONGS_PATH);

    // Group files by their path without extension
    const groups = {};
    for (const file of allFiles) {
      const ext = path.extname(file).toLowerCase();
      if (!['.mp3', '.cdg', '.mp4', '.zip'].includes(ext)) continue;
      const base = file.slice(0, -ext.length);
      if (!groups[base]) groups[base] = {};
      groups[base][ext] = file;
    }

    const documents = [];
    for (const [base, exts] of Object.entries(groups)) {
      let type, extension;

      if (exts['.mp3'] && exts['.cdg']) {
        type = 'mp3cdg'; extension = 'mp3+cdg';
      } else if (exts['.mp4']) {
        type = 'mp4'; extension = 'mp4';
      } else if (exts['.zip']) {
        type = 'zip'; extension = 'zip';
      } else if (exts['.mp3']) {
        type = 'mp3'; extension = 'mp3';
      } else {
        continue; // orphan .cdg
      }

      const filename = path.basename(base);
      documents.push({
        id: pathToId(base),
        title: cleanTitle(filename),
        filename,
        extension,
        type,
        path: base,
      });
    }

    const index = client.index('songs');
    await index.deleteAllDocuments();

    const BATCH = 1000;
    for (let i = 0; i < documents.length; i += BATCH) {
      await index.addDocuments(documents.slice(i, i + BATCH));
    }

    res.json({ indexed: documents.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await client.index('songs').getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/music/index', async (req, res) => {
  try {
    const allFiles = walkDir(MUSIC_PATH);

    const documents = [];
    for (const file of allFiles) {
      const ext = path.extname(file).toLowerCase();
      if (!['.mp3', '.flac'].includes(ext)) continue;

      const base = file.slice(0, -ext.length);
      const filename = path.basename(base);
      const { artist, title } = parseArtistTitle(filename);

      documents.push({
        id: pathToId(base + ext),
        title,
        artist,
        filename,
        extension: ext.slice(1),
        type: ext.slice(1),
        path: base,
      });
    }

    const index = client.index('music');
    await index.deleteAllDocuments();

    const BATCH = 1000;
    for (let i = 0; i < documents.length; i += BATCH) {
      await index.addDocuments(documents.slice(i, i + BATCH));
    }

    res.json({ indexed: documents.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/music/stats', async (req, res) => {
  try {
    const stats = await client.index('music').getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Converter proxy → Python processor service ───────────────────────────────
// Pipes all /api/convert/* and /api/youtube/* requests to the processor.
//
// express.json() (above) consumes application/json bodies before any middleware
// runs. Re-serialise req.body when it has been pre-parsed so the proxy request
// is properly ended; pipe everything else (multipart, GET, SSE) as normal.

function proxyToProcessor(prefix) {
  return (req, res) => {
    const target = new URL(PROCESSOR_URL);

    // Body-parser defaults req.body to {} for every request (not just JSON
    // ones), so `req.body !== undefined` can't tell us whether express.json()
    // actually consumed the stream. Key off the real Content-Type instead —
    // that's the only reliable signal, and it's what express.json() itself
    // uses to decide whether to parse. Anything else (multipart, GET, SSE)
    // must be piped raw or the upstream request body gets silently replaced.
    const preBody = req.is('application/json')
      ? Buffer.from(JSON.stringify(req.body))
      : null;

    const headers = {
      ...req.headers,
      host: target.host,
      'x-accel-buffering': 'no',
    };
    if (preBody) {
      headers['content-type']   = 'application/json';
      headers['content-length'] = preBody.length;
    }

    const proxyReq = http.request({
      hostname: target.hostname,
      port:     parseInt(target.port) || 80,
      path:     prefix + req.url,
      method:   req.method,
      headers,
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.setTimeout(0);

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(503).json({
          error: 'Processor service is unavailable. Make sure the processor container is running.',
        });
      }
    });

    if (preBody) {
      proxyReq.end(preBody);
    } else {
      req.pipe(proxyReq, { end: true });
    }
  };
}

app.use('/api/youtube', proxyToProcessor('/api/youtube'));

app.use('/api/convert', proxyToProcessor('/api/convert'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  let retries = 15;
  while (retries-- > 0) {
    try {
      await client.health();
      break;
    } catch (_) {
      console.log(`Waiting for Meilisearch... (${retries} left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await setupMeilisearch();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`gioKaraoke on http://0.0.0.0:${PORT}`);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
