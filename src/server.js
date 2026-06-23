// Minimal zero-dependency HTTP server: serves the UI and a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { listMovies, lastSyncRun } from './db.js';
import { runSync, isRunning, startScheduler } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function buildPayload() {
  const movies = listMovies();
  const genres = [...new Set(movies.flatMap((m) => m.genres))].sort((a, b) =>
    a.localeCompare(b)
  );
  return { movies, genres, lastSync: lastSyncRun() || null, syncing: isRunning() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // ---- API ----
  if (pathname === '/api/movies' && req.method === 'GET') {
    return sendJson(res, 200, buildPayload());
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { lastSync: lastSyncRun() || null, syncing: isRunning() });
  }
  if (pathname === '/api/sync' && req.method === 'POST') {
    if (isRunning()) return sendJson(res, 202, { started: false, reason: 'already running' });
    // Fire and forget; the client polls /api/status.
    runSync().catch((e) => console.error('[sync] error:', e.message));
    return sendJson(res, 202, { started: true });
  }

  // ---- static files ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, path.normalize(rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(config.port, () => {
  console.log(`TV+ tracker on http://localhost:${config.port}`);
  if (config.runScheduler) startScheduler();
});
