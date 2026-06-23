# TV+ Movie Tracker

Tracks the [TV+](https://www.tvplus.com.tr/filmler) movie catalogue and pairs
each film with its **Letterboxd rating**. Ratings are cached in a local SQLite
database, a background job re-scrapes every 24 hours and highlights newly added
films, and the web UI shows everything in a grid that's **filterable by genre**
and **sortable by Letterboxd rating**.

## What it does

- **Scrapes TV+** (`tvplus.com.tr/filmler`) for the current catalogue: title, year, poster, genres.
- **Fetches Letterboxd ratings** by searching `letterboxd.com/search/films/<name>` for each
  movie, picking the best title/year match, then reading the aggregate rating from the film
  page's JSON-LD.
- **Caches in SQLite** (`data/tvplus.db`) so ratings are reused, not re-fetched constantly
  (default freshness window: 7 days; configurable).
- **Background job** re-scrapes TV+ every 24h, flags new films with a **NEW** badge.
- **Web UI**: poster · title · year · Letterboxd rating side by side, filter by genre,
  sort by rating (and more), "new only" toggle, and a manual **Sync now** button.

## Quick start

```bash
npm install
npm run seed     # optional: load a sample catalogue so the UI works offline
npm start        # http://localhost:3000
```

Open <http://localhost:3000>. To pull live data instead of the sample set, run a sync
(button in the header, or `npm run sync`).

## ⚠️ Network access required for live scraping

Live scraping needs outbound access to two hosts:

- `www.tvplus.com.tr`
- `letterboxd.com`

In a sandboxed environment (e.g. Claude Code on the web) these are blocked by the
**network egress allowlist** unless you add them. Until then, a sync exits cleanly with
*"Network egress blocked … cached data left untouched"* and the cached/seeded data stays
in place. See the egress settings docs for
[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).
Running locally with normal internet access, scraping works out of the box.

## Architecture

```
src/
  config.js              Central config (env-overridable): ports, URLs, intervals, TTLs
  fetch.js               Throttled fetch w/ retries + EgressBlockedError detection
  db.js                  node:sqlite schema + queries (no native build needed)
  scraper-tvplus.js      Scrapes the TV+ catalogue (embedded-JSON / card / fallback strategies)
  scraper-letterboxd.js  Search -> best match -> JSON-LD rating extraction
  sync.js                Orchestrates scrape + rating lookup + DB upsert + scheduler
  server.js              Zero-dep HTTP server: static UI + JSON API
public/                  Vanilla-JS grid UI (index.html / app.js / styles.css)
seed/seed.js             Sample catalogue for offline demos
```

### API

| Method | Path           | Description                                   |
| ------ | -------------- | --------------------------------------------- |
| GET    | `/api/movies`  | All movies + available genres + last sync     |
| GET    | `/api/status`  | Current sync status / last run                |
| POST   | `/api/sync`    | Trigger a sync (runs in background)            |

### Configuration (env vars)

| Var                    | Default                          | Meaning                         |
| ---------------------- | -------------------------------- | ------------------------------- |
| `PORT`                 | `3000`                           | HTTP port                       |
| `DB_PATH`              | `data/tvplus.db`                 | SQLite file                     |
| `RESCRAPE_INTERVAL_MS` | `86400000` (24h)                 | Background re-scrape cadence     |
| `RATING_TTL_MS`        | `604800000` (7d)                 | How long a cached rating is fresh|
| `REQUEST_DELAY_MS`     | `1200`                           | Min delay between HTTP requests  |
| `RUN_SCHEDULER`        | `true`                           | Start the 24h loop with server   |

## How matching & caching work

- Each TV+ movie has a stable key (`normalized title | year`). Re-scrapes upsert by this key;
  keys not seen before are flagged `is_new` (the **NEW** badge). The flag clears on the next
  sync where the film is no longer "new".
- A movie's Letterboxd rating is only re-fetched when missing or older than `RATING_TTL_MS`,
  so repeated syncs don't hammer Letterboxd.

## Notes on the scrapers

`scraper-tvplus.js` targets a JS-heavy site whose markup can change; it tries embedded JSON
first, then structured cards, then a loose fallback. If TV+ ships a markup change that yields
zero parsed movies, the sync records that without clobbering cached data — adjust the selectors
in that file against the live DOM. The Letterboxd extraction relies on the stable JSON-LD
`aggregateRating` block present on every film page.
