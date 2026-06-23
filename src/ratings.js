// Rating provider: looks a movie up on TMDB and/or OMDb (IMDb) and combines
// the results onto a 0–5 scale.
//
// Why not Letterboxd? It has no public API and Cloudflare-blocks all scraping
// (even a plain browser-UA request 403s). TMDB + OMDb are free JSON APIs that
// give us ratings, posters, genres and year reliably.
//
// Combination: each provider's 0–10 score is halved to 0–5, then we average
// whichever providers returned a score. The per-source numbers are kept so the
// UI can show the breakdown.
import { fetchJson } from './fetch.js';
import { config } from './config.js';
import { normalizeTitle } from './scraper-tvplus.js';

// Stable TMDB movie genre id -> English name map (avoids an extra API call).
const TMDB_GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western',
};

function yearOf(dateStr) {
  const m = String(dateStr || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

// Score how well a candidate title/year matches the query (higher = better).
function matchScore(candidateTitles, candidateYear, name, year) {
  const target = normalizeTitle(name);
  let best = -Infinity;
  for (const ct of candidateTitles.filter(Boolean)) {
    const c = normalizeTitle(ct);
    let s = 0;
    if (c === target) s = 100;
    else if (c.startsWith(target) || target.startsWith(c)) s = 60;
    else if (c.includes(target) || target.includes(c)) s = 30;
    if (year && candidateYear) s += candidateYear === year ? 25 : -Math.min(20, Math.abs(candidateYear - year));
    best = Math.max(best, s);
  }
  return best;
}

// ---- TMDB ------------------------------------------------------------------
async function lookupTmdb(name, year) {
  if (!config.tmdbApiKey) return null;
  const url =
    `${config.tmdbBase}/search/movie?api_key=${config.tmdbApiKey}` +
    `&query=${encodeURIComponent(name)}&include_adult=false` +
    (year ? `&year=${year}` : '');
  const data = await fetchJson(url);
  const results = data?.results || [];
  if (results.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const s = matchScore([r.title, r.original_title], yearOf(r.release_date), name, year);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best || bestScore < 30) best = results[0];
  if (!best || !best.vote_average) {
    // No usable rating, but the metadata/poster is still useful.
  }

  return {
    source: 'tmdb',
    score10: best.vote_average || null,
    votes: best.vote_count || null,
    poster: best.poster_path ? config.tmdbImageBase + best.poster_path : null,
    genres: (best.genre_ids || []).map((id) => TMDB_GENRES[id]).filter(Boolean),
    year: yearOf(best.release_date),
    url: `https://www.themoviedb.org/movie/${best.id}`,
  };
}

// ---- OMDb (IMDb) -----------------------------------------------------------
async function lookupOmdb(name, year) {
  if (!config.omdbApiKey) return null;
  const url =
    `${config.omdbBase}?apikey=${config.omdbApiKey}` +
    `&t=${encodeURIComponent(name)}&type=movie` +
    (year ? `&y=${year}` : '');
  const data = await fetchJson(url);
  if (!data || data.Response === 'False') return null;

  const rating = data.imdbRating && data.imdbRating !== 'N/A' ? Number(data.imdbRating) : null;
  return {
    source: 'imdb',
    score10: Number.isFinite(rating) ? rating : null,
    votes: data.imdbVotes && data.imdbVotes !== 'N/A' ? Number(data.imdbVotes.replace(/,/g, '')) : null,
    poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
    genres: data.Genre && data.Genre !== 'N/A' ? data.Genre.split(',').map((g) => g.trim()) : [],
    year: yearOf(data.Year),
    url: data.imdbID ? `https://www.imdb.com/title/${data.imdbID}/` : null,
  };
}

/**
 * Look a movie up across all configured providers and combine them.
 * Returns null if no provider is configured or nothing was found at all.
 *
 * Shape:
 *   { rating, ratingCount, poster, genres[], year, url, sources, detail{tmdb,imdb} }
 *   rating is on a 0–5 scale (average of available providers' score/2).
 */
export async function lookupRating(name, year) {
  if (!config.tmdbApiKey && !config.omdbApiKey) {
    throw new Error(
      'No rating provider configured. Set TMDB_API_KEY and/or OMDB_API_KEY (see README).'
    );
  }

  const [tmdb, omdb] = await Promise.all([
    lookupTmdb(name, year).catch(() => null),
    lookupOmdb(name, year).catch(() => null),
  ]);

  const found = [tmdb, omdb].filter(Boolean);
  if (found.length === 0) return null;

  // Per-source 0–5 scores and the combined average.
  const detail = {};
  const scores5 = [];
  for (const p of found) {
    if (p.score10 != null) {
      const s5 = Math.round((p.score10 / 2) * 100) / 100;
      detail[p.source] = { score10: p.score10, score5: s5, votes: p.votes };
      scores5.push(s5);
    }
  }
  const rating =
    scores5.length > 0
      ? Math.round((scores5.reduce((a, b) => a + b, 0) / scores5.length) * 100) / 100
      : null;

  return {
    rating,
    ratingCount: found.reduce((sum, p) => sum + (p.votes || 0), 0) || null,
    // Prefer TMDB poster/genres (cleaner), fall back to OMDb.
    poster: tmdb?.poster || omdb?.poster || null,
    genres: tmdb?.genres?.length ? tmdb.genres : omdb?.genres || [],
    year: tmdb?.year || omdb?.year || year || null,
    url: tmdb?.url || omdb?.url || null,
    sources: Object.keys(detail),
    detail,
  };
}
