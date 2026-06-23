// Central configuration. Override any value with an environment variable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 3000,

  // Where the SQLite file lives.
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'tvplus.db'),

  // TV+ catalogue page to scrape.
  tvplusUrl: process.env.TVPLUS_URL || 'https://www.tvplus.com.tr/filmler',

  // Letterboxd endpoints (templated by the scraper).
  letterboxdSearchUrl: 'https://letterboxd.com/search/films/',
  letterboxdBase: 'https://letterboxd.com',

  // Re-scrape the TV+ catalogue this often (ms). Default: 24h.
  rescrapeIntervalMs: Number(process.env.RESCRAPE_INTERVAL_MS) || 24 * 60 * 60 * 1000,

  // A cached Letterboxd rating is considered fresh for this long (ms). Default: 7 days.
  // Inside this window we never re-hit Letterboxd, so we are not fetching constantly.
  ratingTtlMs: Number(process.env.RATING_TTL_MS) || 7 * 24 * 60 * 60 * 1000,

  // Politeness: minimum delay between outbound HTTP requests (ms).
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS) || 1200,

  // Browser-like UA so the upstream sites don't reject us outright.
  userAgent:
    process.env.HTTP_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // Run the background sync loop when the server starts.
  runScheduler: process.env.RUN_SCHEDULER !== 'false',
};
