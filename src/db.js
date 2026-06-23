// SQLite layer built on Node's native node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS movies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tvplus_key      TEXT UNIQUE NOT NULL,   -- stable identity (slug or normalized title|year)
    title           TEXT NOT NULL,
    year            INTEGER,
    poster          TEXT,                   -- TV+ poster
    tvplus_url      TEXT,
    genres          TEXT,                   -- JSON array of genre strings
    lb_slug         TEXT,
    lb_url          TEXT,                   -- link to the rating source (TMDB/IMDb)
    lb_rating       REAL,                   -- combined 0..5 rating, null if unrated/not found
    lb_rating_count INTEGER,
    lb_poster       TEXT,
    lb_fetched_at   TEXT,                   -- ISO time the rating was last fetched
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    is_new          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    found_count INTEGER,
    new_count   INTEGER,
    status      TEXT,                       -- running | ok | error
    message     TEXT
  );
`);

// Non-destructive migration: add columns introduced after the first release.
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
// Per-source rating breakdown, e.g. {"tmdb":{...},"imdb":{...}}.
ensureColumn('movies', 'rating_detail', 'TEXT');

const nowIso = () => new Date().toISOString();

export function getMovieByKey(key) {
  return db.prepare('SELECT * FROM movies WHERE tvplus_key = ?').get(key);
}

/**
 * Insert a freshly scraped TV+ movie or update the existing row.
 * Returns { isNew } indicating whether this key was seen for the first time.
 */
export function upsertTvplusMovie(m) {
  const existing = getMovieByKey(m.tvplusKey);
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE movies SET title=?, year=?, poster=?, tvplus_url=?, genres=?, last_seen_at=?, is_new=0
       WHERE tvplus_key=?`
    ).run(
      m.title,
      m.year ?? null,
      m.poster ?? null,
      m.tvplusUrl ?? null,
      JSON.stringify(m.genres ?? []),
      now,
      m.tvplusKey
    );
    return { isNew: false, id: existing.id };
  }
  const info = db
    .prepare(
      `INSERT INTO movies (tvplus_key, title, year, poster, tvplus_url, genres,
                           first_seen_at, last_seen_at, is_new)
       VALUES (?,?,?,?,?,?,?,?,1)`
    )
    .run(
      m.tvplusKey,
      m.title,
      m.year ?? null,
      m.poster ?? null,
      m.tvplusUrl ?? null,
      JSON.stringify(m.genres ?? []),
      now,
      now
    );
  return { isNew: true, id: Number(info.lastInsertRowid) };
}

// Store a combined rating (from TMDB/OMDb). Column names keep their lb_*
// prefix for storage compatibility; they now hold the combined-provider data.
export function setRatingData(id, r) {
  db.prepare(
    `UPDATE movies SET lb_slug=?, lb_url=?, lb_rating=?, lb_rating_count=?,
                       lb_poster=?, lb_fetched_at=?, rating_detail=?,
                       genres=COALESCE(NULLIF(?, '[]'), genres)
     WHERE id=?`
  ).run(
    r.sources ? r.sources.join(',') : null,
    r.url ?? null,
    r.rating ?? null,
    r.ratingCount ?? null,
    r.poster ?? null,
    nowIso(),
    r.detail ? JSON.stringify(r.detail) : null,
    JSON.stringify(r.genres ?? []),
    id
  );
}

// Reset the "new" flag on movies that were NOT seen in the current scrape pass.
export function clearStaleNewFlags(seenKeys) {
  const placeholders = seenKeys.map(() => '?').join(',');
  if (seenKeys.length === 0) return;
  db.prepare(
    `UPDATE movies SET is_new=0 WHERE is_new=1 AND tvplus_key NOT IN (${placeholders})`
  ).run(...seenKeys);
}

export function ratingIsStale(movie, ttlMs) {
  if (!movie || !movie.lb_fetched_at) return true;
  return Date.now() - new Date(movie.lb_fetched_at).getTime() > ttlMs;
}

export function listMovies() {
  const rows = db
    .prepare('SELECT * FROM movies ORDER BY (lb_rating IS NULL), lb_rating DESC, title')
    .all();
  return rows.map((r) => ({
    ...r,
    genres: safeParse(r.genres),
    rating_detail: r.rating_detail ? safeParse(r.rating_detail) : null,
  }));
}

export function startSyncRun() {
  const info = db
    .prepare(`INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')`)
    .run(nowIso());
  return Number(info.lastInsertRowid);
}

export function finishSyncRun(id, { found, newCount, status, message }) {
  db.prepare(
    `UPDATE sync_runs SET finished_at=?, found_count=?, new_count=?, status=?, message=? WHERE id=?`
  ).run(nowIso(), found ?? null, newCount ?? null, status, message ?? null, id);
}

export function lastSyncRun() {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
}

function safeParse(s) {
  try {
    return JSON.parse(s) || [];
  } catch {
    return [];
  }
}
