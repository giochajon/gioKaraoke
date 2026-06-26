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
const MEILI_URL = process.env.MEILISEARCH_URL || 'http://localhost:7700';
const MEILI_KEY = process.env.MEILISEARCH_KEY || '';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:5000';

const client = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_KEY });

// Cache for extracted ZIP files: songId -> { audioPath, cdgPath, type, tempDir }
const zipCache = new Map();

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
  return { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.cdg': 'application/octet-stream' }[ext]
    || 'application/octet-stream';
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

// ─── Converter proxy → Python processor service ───────────────────────────────
// Pipes all /api/convert/* requests to the processor container.
// No body buffering — multipart uploads and SSE streams pass through as-is.

app.use('/api/convert', (req, res) => {
  const target = new URL(PROCESSOR_URL);
  const options = {
    hostname: target.hostname,
    port: parseInt(target.port) || 80,
    path: '/api/convert' + req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
      // Disable nginx-style proxy buffering so SSE chunks flush immediately
      'x-accel-buffering': 'no',
    },
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.setTimeout(0); // no timeout — processing can take several minutes

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.status(503).json({
        error: 'Processor service is unavailable. Make sure the processor container is running.',
      });
    }
  });

  req.pipe(proxyReq, { end: true });
});

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
