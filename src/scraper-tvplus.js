// Scraper for the TV+ film catalogue (tvplus.com.tr/filmler).
//
// NOTE: TV+ is a JS-heavy site and its markup may change. This scraper is
// deliberately defensive: it tries three strategies in order and returns the
// first that yields movies.
//   1. Embedded JSON  (Next.js __NEXT_DATA__ / inline catalogue payloads)
//   2. Structured movie cards (anchors to /film*/ with a poster + title)
//   3. A loose fallback over poster images with alt text
//
// Each movie is normalized to:
//   { tvplusKey, title, year, poster, tvplusUrl, genres[] }
import * as cheerio from 'cheerio';
import { fetchText } from './fetch.js';
import { config } from './config.js';

// TV+ titles often carry Turkish "watch" suffixes (e.g. "The Banker izle",
// "... full izle", "... türkçe dublaj izle") and stray UI labels. Clean those
// off so both the stored title and the Letterboxd query are accurate.
export function cleanTitle(raw) {
  let t = String(raw || '').trim();
  // Drop "izle" and any qualifiers leading up to it, plus everything after.
  t = t.replace(
    /\s+(full\s+)?(hd\s+)?(t[üu]rk[çc]e\s+dublaj\s+)?(alt[ıi]?yaz[ıi]l[ıi]\s+)?(tek\s+par[çc]a\s+)?izle\b.*$/i,
    ''
  );
  // Strip trailing site/brand fragments.
  t = t.replace(/\s*[-–|]\s*tv\+.*$/i, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// Filter out carousel arrows, menu labels and other non-movie noise that the
// loose card selectors can pick up.
export function looksLikeJunk(title) {
  const t = String(title || '').toLowerCase().trim();
  if (t.length < 2) return true;
  return /(^|\s)(right|left|next|previous|prev)(\s|$)|arrow|slider|carousel|\bmenu\b|\bbutton\b|daha fazla|t[üu]m[üu]n[üu]|giri[şs] yap|abone ol/.test(
    t
  );
}

export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function makeKey(title, year) {
  return `${normalizeTitle(title)}|${year || ''}`;
}

function abs(url) {
  if (!url) return null;
  try {
    return new URL(url, config.tvplusBase || 'https://www.tvplus.com.tr').href;
  } catch {
    return url;
  }
}

function dedupe(movies) {
  const seen = new Map();
  for (const m of movies) {
    if (!m.title) continue;
    const key = m.tvplusKey || makeKey(m.title, m.year);
    m.tvplusKey = key;
    if (!seen.has(key)) seen.set(key, m);
    else {
      // merge: prefer non-empty fields
      const prev = seen.get(key);
      prev.poster ||= m.poster;
      prev.tvplusUrl ||= m.tvplusUrl;
      prev.year ||= m.year;
      if (m.genres?.length) prev.genres = [...new Set([...(prev.genres || []), ...m.genres])];
    }
  }
  return [...seen.values()];
}

// ---- Strategy 1: embedded JSON ---------------------------------------------
function fromEmbeddedJson($) {
  const out = [];
  $('script').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || raw.length < 40) return;
    if (!/poster|film|movie|"title"|"name"/i.test(raw)) return;
    // Try to find JSON objects/arrays inside the script.
    const candidates = [];
    const nextData = $(el).attr('id') === '__NEXT_DATA__' ? raw : null;
    if (nextData) candidates.push(nextData);
    const m = raw.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) candidates.push(m[1]);
    for (const c of candidates) {
      try {
        walkForMovies(JSON.parse(c), out);
      } catch {
        /* ignore unparsable */
      }
    }
  });
  return out;
}

// Recursively look for objects that look like a movie record.
function walkForMovies(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const v of node) walkForMovies(v, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const title = node.title || node.name || node.movieName || node.contentName;
  const looksLikeMovie =
    title &&
    (node.poster || node.posterUrl || node.image || node.imageUrl || node.thumbnail) &&
    (node.type ? /movie|film/i.test(node.type) : true);

  if (looksLikeMovie) {
    const year =
      pickYear(node.year) ||
      pickYear(node.releaseYear) ||
      pickYear(node.productionYear) ||
      pickYear(node.releaseDate);
    const genres = []
      .concat(node.genres || node.genre || node.categories || [])
      .map((g) => (typeof g === 'string' ? g : g?.name))
      .filter(Boolean);
    out.push({
      title: String(title).trim(),
      year,
      poster: abs(node.poster || node.posterUrl || node.image || node.imageUrl || node.thumbnail),
      tvplusUrl: abs(node.url || node.link || node.detailUrl || node.path),
      genres,
    });
  }
  for (const v of Object.values(node)) walkForMovies(v, out, depth + 1);
}

// ---- Strategy 2: structured cards ------------------------------------------
function fromCards($) {
  const out = [];
  $('a[href*="/film"], a[href*="/movie"], [class*="card"], [class*="poster"]').each((_, el) => {
    const $el = $(el);
    const img = $el.find('img').first();
    const title =
      ($el.attr('title') ||
        img.attr('alt') ||
        $el.find('[class*="title"], h2, h3, h4').first().text() ||
        '').trim();
    if (!title) return;
    const poster = img.attr('data-src') || img.attr('src') || img.attr('data-original');
    const href = $el.is('a') ? $el.attr('href') : $el.find('a').attr('href');
    const yearMatch = $el.text().match(/\b(19|20)\d{2}\b/);
    out.push({
      title,
      year: yearMatch ? Number(yearMatch[0]) : null,
      poster: abs(poster),
      tvplusUrl: abs(href),
      genres: [],
    });
  });
  return out;
}

function pickYear(v) {
  if (!v) return null;
  const m = String(v).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/** Scrape the live TV+ catalogue. Returns a normalized, deduped movie array. */
export async function scrapeTvplus() {
  const html = await fetchText(config.tvplusUrl);
  const $ = cheerio.load(html);

  let movies = fromEmbeddedJson($);
  if (movies.length === 0) movies = fromCards($);

  // Clean titles, drop junk, then dedupe and key.
  movies = movies
    .map((m) => ({ ...m, title: cleanTitle(m.title) }))
    .filter((m) => m.title && m.title.length > 1 && !looksLikeJunk(m.title));

  movies = dedupe(movies);
  movies.forEach((m) => {
    m.tvplusKey = makeKey(m.title, m.year);
  });
  return movies;
}
