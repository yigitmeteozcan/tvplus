// Letterboxd rating lookup.
//
// Two steps:
//   1. Search letterboxd.com/search/films/<name>/ -> pick the best matching result
//      (its film slug + the URL of the film page).
//   2. Load the film page and read the aggregate rating from the JSON-LD block
//      (Letterboxd embeds <script type="application/ld+json"> with
//      aggregateRating.ratingValue on every film page).
import * as cheerio from 'cheerio';
import { fetchText } from './fetch.js';
import { config } from './config.js';
import { normalizeTitle } from './scraper-tvplus.js';

/** Search Letterboxd and return candidate results [{ slug, url, title, year }]. */
export async function searchLetterboxd(name) {
  const url = config.letterboxdSearchUrl + encodeURIComponent(name) + '/';
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const results = [];

  $('ul.results li, .results li').each((_, li) => {
    const $li = $(li);
    const poster = $li.find('[data-film-slug]').first();
    const slug = poster.attr('data-film-slug');
    if (!slug) return;
    const link = poster.attr('data-target-link') || `/film/${slug}/`;
    const title =
      $li.find('.film-title-wrapper a, .headline-2 a, h2 a').first().text().trim() ||
      $li.find('img').attr('alt') ||
      slug.replace(/-/g, ' ');
    const yearMatch = $li.find('.film-title-wrapper, .metadata').text().match(/\b(19|20)\d{2}\b/);
    results.push({
      slug,
      url: new URL(link, config.letterboxdBase).href,
      title,
      year: yearMatch ? Number(yearMatch[0]) : null,
    });
  });
  return results;
}

/** Pick the result whose title (and year, if available) best matches the query. */
export function pickBestMatch(results, name, year) {
  if (results.length === 0) return null;
  const target = normalizeTitle(name);
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    let score = 0;
    const rt = normalizeTitle(r.title);
    if (rt === target) score += 100;
    else if (rt.startsWith(target) || target.startsWith(rt)) score += 60;
    else if (rt.includes(target) || target.includes(rt)) score += 30;
    if (year && r.year) score += r.year === year ? 25 : -Math.min(20, Math.abs(r.year - year));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  // Require at least a partial title overlap to avoid wildly wrong matches.
  return bestScore >= 30 ? best : results[0];
}

/** Fetch a film page and extract rating + metadata from its JSON-LD block. */
export async function fetchFilmRating(filmUrl) {
  const html = await fetchText(filmUrl);
  const $ = cheerio.load(html);

  let data = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (data) return;
    let raw = $(el).contents().text().trim();
    // Letterboxd wraps the JSON in /* <![CDATA[ */ ... /* ]]> */
    raw = raw.replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/$/, '').trim();
    try {
      const parsed = JSON.parse(raw);
      const node = Array.isArray(parsed) ? parsed.find((n) => n.aggregateRating) : parsed;
      if (node) data = node;
    } catch {
      /* ignore */
    }
  });

  const result = {
    rating: null,
    ratingCount: null,
    poster: null,
    genres: [],
    year: null,
  };

  if (data) {
    if (data.aggregateRating) {
      result.rating = numOrNull(data.aggregateRating.ratingValue);
      result.ratingCount = numOrNull(data.aggregateRating.ratingCount);
    }
    result.poster = data.image || null;
    result.genres = [].concat(data.genre || []).filter(Boolean);
    const dateStr =
      data.releasedEvent?.[0]?.startDate || data.datePublished || data.dateCreated || '';
    const ym = String(dateStr).match(/\b(19|20)\d{2}\b/);
    if (ym) result.year = Number(ym[0]);
  }

  // Fallback: the og:image and the twitter:data2 meta sometimes carry the rating.
  if (!result.poster) result.poster = $('meta[property="og:image"]').attr('content') || null;
  if (result.rating == null) {
    const td2 = $('meta[name="twitter:data2"]').attr('content') || '';
    const m = td2.match(/([\d.]+)\s+out of 5/i);
    if (m) result.rating = Number(m[1]);
  }
  return result;
}

/**
 * Full lookup for one movie: search -> best match -> rating.
 * Returns null if nothing usable was found.
 */
export async function lookupLetterboxd(name, year) {
  const results = await searchLetterboxd(name);
  const match = pickBestMatch(results, name, year);
  if (!match) return null;
  const detail = await fetchFilmRating(match.url);
  return {
    slug: match.slug,
    url: match.url,
    rating: detail.rating,
    ratingCount: detail.ratingCount,
    poster: detail.poster,
    genres: detail.genres,
    year: detail.year || match.year || year || null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
