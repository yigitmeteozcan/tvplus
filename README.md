# TV+ Movie Tracker

Tracks the [TV+](https://www.tvplus.com.tr/film-izle) movie catalogue and pairs
each film with a **combined movie rating** (TMDB + IMDb, on a 5-point scale).
Ratings are cached in a local SQLite database, a background job re-scrapes every
24 hours and highlights newly added films, and the web UI shows everything in a
grid that's **filterable by genre** and **sortable by rating**.

> **Why not Letterboxd?** Letterboxd has no public API and Cloudflare-blocks all
> scraping (even a plain browser-UA request gets `403`). So ratings come from the
> free **TMDB** and **OMDb (IMDb)** APIs instead: each provider's 0–10 score is
> converted to 0–5 and the available ones are averaged. The per-source breakdown
> is shown in the rating tooltip.

## What it does

- **Scrapes TV+** (`tvplus.com.tr/film-izle`) for the current catalogue: title, year, poster, genres.
  Turkish "izle"/"dublaj"/"altyazılı" suffixes are stripped and UI noise (carousel arrows etc.) filtered out.
- **Fetches ratings** from TMDB and/or OMDb, picks the best title/year match, and combines them onto a /5 scale.
- **Caches in SQLite** (`data/tvplus.db`) so ratings are reused, not re-fetched constantly
  (default freshness window: 7 days; configurable).
- **Background job** re-scrapes TV+ every 24h, flags new films with a **NEW** badge.
- **Web UI**: poster · title · year · rating side by side, filter by genre,
  sort by rating (and more), "new only" toggle, and a manual **Sync now** button.

## Quick start

```bash
npm install

# Get at least one free API key and export it (both is best for combined ratings):
export TMDB_API_KEY=your_tmdb_key   # https://www.themoviedb.org/settings/api
export OMDB_API_KEY=your_omdb_key   # https://www.omdbapi.com/apikey.aspx

npm run seed     # optional: load a sample catalogue so the UI shows something immediately
npm start        # http://localhost:3000  (also runs the 24h background sync)
```

Open <http://localhost:3000>. To pull live data, run a sync (button in the header, or
`npm run sync`). Without an API key the catalogue still scrapes, but ratings stay empty.

## ⚠️ Network access required for live data

Live data needs outbound access to:

- `www.tvplus.com.tr` (catalogue)
- `api.themoviedb.org` and/or `www.omdbapi.com` (ratings)

In a sandboxed environment (e.g. Claude Code on the web) these are blocked by the
**network egress allowlist** unless you add them. Until then, a sync exits cleanly with
*"Network egress blocked … cached data left untouched"* and the cached/seeded data stays
in place. See the egress settings docs for
[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).
Running locally with normal internet access, everything works out of the box.

## Architecture

```
src/
  config.js              Central config (env-overridable): ports, URLs, intervals, TTLs
  fetch.js               Throttled fetch w/ retries + EgressBlockedError detection
  db.js                  node:sqlite schema + queries (no native build needed)
  scraper-tvplus.js      Scrapes the TV+ catalogue (embedded-JSON / card / fallback strategies)
  ratings.js             TMDB + OMDb lookup, combined onto a 0–5 scale
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

| Var                    | Default                          | Meaning                          |
| ---------------------- | -------------------------------- | -------------------------------- |
| `TMDB_API_KEY`         | _(none)_                         | TMDB API key (rating provider)   |
| `OMDB_API_KEY`         | _(none)_                         | OMDb/IMDb API key (rating provider) |
| `PORT`                 | `3000`                           | HTTP port                        |
| `DB_PATH`              | `data/tvplus.db`                 | SQLite file                      |
| `TVPLUS_URL`           | `…/film-izle`                    | Catalogue page to scrape         |
| `RESCRAPE_INTERVAL_MS` | `86400000` (24h)                 | Background re-scrape cadence      |
| `RATING_TTL_MS`        | `604800000` (7d)                 | How long a cached rating is fresh |
| `REQUEST_DELAY_MS`     | `350`                            | Min delay between HTTP requests   |
| `RUN_SCHEDULER`        | `true`                           | Start the 24h loop with server    |

## How matching & caching work

- Each TV+ movie has a stable key (`normalized title | year`). Re-scrapes upsert by this key;
  keys not seen before are flagged `is_new` (the **NEW** badge). The flag clears on the next
  sync where the film is no longer "new".
- A movie's rating is only re-fetched when missing or older than `RATING_TTL_MS`,
  so repeated syncs don't hammer the providers.

## Notes on the scrapers

`scraper-tvplus.js` targets a JS-heavy site whose markup can change; it tries embedded JSON
first, then structured cards, then a loose fallback. If TV+ ships a markup change that yields
zero parsed movies, the sync records that without clobbering cached data — adjust the selectors
in that file against the live DOM. Ratings come from TMDB/OMDb JSON APIs (`ratings.js`), which
are stable and don't require scraping.
