// Orchestrates a full sync:
//   1. Scrape the TV+ catalogue.
//   2. Upsert each movie (new ones get flagged is_new=1).
//   3. For movies whose cached Letterboxd rating is missing/stale, look it up.
//   4. Record the run in sync_runs.
//
// Designed to be safe to run on a schedule: if TV+ is unreachable (e.g. egress
// blocked), existing cached data is left intact rather than wiped.
import {
  upsertTvplusMovie,
  setLetterboxdData,
  getMovieByKey,
  clearStaleNewFlags,
  ratingIsStale,
  startSyncRun,
  finishSyncRun,
} from './db.js';
import { scrapeTvplus } from './scraper-tvplus.js';
import { lookupLetterboxd } from './scraper-letterboxd.js';
import { EgressBlockedError } from './fetch.js';
import { config } from './config.js';

let running = false;

export function isRunning() {
  return running;
}

/** Run one full sync. Returns a summary object. */
export async function runSync({ log = console.log } = {}) {
  if (running) {
    log('[sync] already running, skipping');
    return { skipped: true };
  }
  running = true;
  const runId = startSyncRun();
  log('[sync] starting');

  try {
    const scraped = await scrapeTvplus();
    log(`[sync] scraped ${scraped.length} movies from TV+`);

    if (scraped.length === 0) {
      finishSyncRun(runId, {
        found: 0,
        newCount: 0,
        status: 'ok',
        message: 'No movies parsed from TV+ (markup may have changed).',
      });
      return { found: 0, newCount: 0, ratingsFetched: 0 };
    }

    const seenKeys = scraped.map((m) => m.tvplusKey);
    // Reset the "new" badge on movies not in this scrape, then upsert.
    clearStaleNewFlags(seenKeys);

    let newCount = 0;
    let ratingsFetched = 0;

    for (const movie of scraped) {
      const { isNew, id } = upsertTvplusMovie(movie);
      if (isNew) newCount += 1;

      const row = getMovieByKey(movie.tvplusKey);
      if (ratingIsStale(row, config.ratingTtlMs)) {
        try {
          const lb = await lookupLetterboxd(movie.title, movie.year);
          if (lb) {
            setLetterboxdData(id, lb);
            ratingsFetched += 1;
            log(`[sync]   ${movie.title} -> Letterboxd ${lb.rating ?? 'n/a'}`);
          } else {
            log(`[sync]   ${movie.title} -> no Letterboxd match`);
          }
        } catch (err) {
          if (err instanceof EgressBlockedError) throw err; // bubble up – stop early
          log(`[sync]   ${movie.title} -> rating lookup failed: ${err.message}`);
        }
      }
    }

    finishSyncRun(runId, {
      found: scraped.length,
      newCount,
      status: 'ok',
      message: `Synced ${scraped.length} movies (${newCount} new, ${ratingsFetched} ratings fetched).`,
    });
    log(`[sync] done: ${scraped.length} movies, ${newCount} new, ${ratingsFetched} ratings`);
    return { found: scraped.length, newCount, ratingsFetched };
  } catch (err) {
    const blocked = err instanceof EgressBlockedError;
    finishSyncRun(runId, {
      status: 'error',
      message: blocked
        ? `Network egress blocked: ${err.host}. Cached data left untouched.`
        : err.message,
    });
    log(`[sync] error: ${err.message}`);
    return { error: err.message, blocked };
  } finally {
    running = false;
  }
}

let timer = null;

/** Start the 24h background loop. Runs once at boot, then on the interval. */
export function startScheduler({ log = console.log } = {}) {
  const tick = () => {
    runSync({ log }).catch((e) => log('[scheduler] sync threw:', e.message));
  };
  tick();
  timer = setInterval(tick, config.rescrapeIntervalMs);
  if (timer.unref) timer.unref();
  log(`[scheduler] background sync every ${Math.round(config.rescrapeIntervalMs / 3600000)}h`);
  return () => clearInterval(timer);
}

// Allow `npm run sync` for a one-off run.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSync().then((r) => {
    console.log('[sync] result:', r);
    process.exit(r?.error ? 1 : 0);
  });
}
