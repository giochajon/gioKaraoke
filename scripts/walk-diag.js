#!/usr/bin/env node
// Diagnostic: walks MUSIC_PATH the same way server.js's walkDir() does, but
// logs every symlink and every readdir error it hits along the way instead
// of silently swallowing them.
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.env.MUSIC_PATH || '/music';

let fileCount = 0;
let dirCount = 0;
const skippedSymlinks = [];
const errors = [];

function walk(dir, depth) {
  dirCount++;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push({ dir, code: e.code, message: e.message });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target = '?';
      let isDir = false;
      try {
        target = fs.readlinkSync(full);
        isDir = fs.statSync(full).isDirectory();
      } catch (e) {
        target = `<broken: ${e.code}>`;
      }
      skippedSymlinks.push({ path: full, target, isDir });
      continue; // this is what walkDir() does implicitly — isDirectory()/isFile() are both false
    }
    if (entry.isDirectory()) {
      walk(full, depth + 1);
    } else if (entry.isFile()) {
      fileCount++;
    }
  }
}

console.log(`Walking: ${root}\n`);
walk(root, 0);

console.log(`Directories visited: ${dirCount}`);
console.log(`Files found (all types): ${fileCount}\n`);

if (errors.length) {
  console.log(`⚠ ${errors.length} directory read error(s) — these subtrees were silently skipped by walkDir():`);
  for (const e of errors) console.log(`  [${e.code}] ${e.dir} — ${e.message}`);
  console.log();
} else {
  console.log('No readdir errors.\n');
}

if (skippedSymlinks.length) {
  console.log(`⚠ ${skippedSymlinks.length} symlink(s) found — walkDir() does NOT follow these, so they're silently skipped:`);
  for (const s of skippedSymlinks) console.log(`  ${s.path} -> ${s.target}${s.isDir ? '  (points to a directory — its contents are being dropped)' : ''}`);
} else {
  console.log('No symlinks found.');
}
