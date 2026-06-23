// Scraper for the TV+ film catalogue (tvplus.com.tr/film-izle).
//
// The landing page only renders a curated subset, so we crawl it PLUS every
// genre page (`/film-izle/tur/<slug>--<id>`) and union the films. Each film is
// identified by the numeric contentId in its URL (`/film-izle/<slug>--<id>`),
// which is a stable, unique key. Embedded-JSON / card heuristics remain as a
// fallback if the URL pattern ever stops matching.
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
  // [iİ] covers both ASCII "i" and the Turkish dotted capital "İ" (U+0130),
  // which the regex /i flag does NOT case-fold to "i".
  t = t.replace(
    /\s+(full\s+)?(hd\s+)?(t[üu]rk[çc]e\s+dublaj\s+)?(alt[ıi]?yaz[ıi]l[ıi]\s+)?(tek\s+par[çc]a\s+)?[iİ]zle\b.*$/iu,
    ''
  );
  // Drop a trailing "poster" / "afiş" label (comes from <img alt="… poster">).
  t = t.replace(/\s+(poster|afi[şs])\s*$/iu, '');
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

// ---- Strategy 0 (primary): URL-keyed crawl ---------------------------------
//
// Every TV+ film links to `/film-izle/<slug>--<contentId>` and every genre to
// `/film-izle/tur/<slug>--<genreId>`. The landing page only renders a subset of
// the catalogue, so we also visit each genre page and union the results. The
// numeric contentId is a stable, unique key (no title-based guessing).
const FILM_PATH_RE = /^\/film-izle\/([a-z0-9-]+)--(\d+)\/?$/i;
const GENRE_PATH_RE = /^\/film-izle\/tur\/([a-z0-9-]+)--(\d+)\/?$/i;

function slugToTitle(slug) {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Pull every film anchor and every genre-page URL out of one loaded page.
function extractPage($) {
  const films = [];
  const genreUrls = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, config.tvplusBase || 'https://www.tvplus.com.tr');
    } catch {
      return;
    }
    const path = url.pathname;

    if (GENRE_PATH_RE.test(path)) {
      genreUrls.add(url.href.split('?')[0].split('#')[0]);
      return;
    }
    const fm = path.match(FILM_PATH_RE);
    if (!fm) return;

    const $el = $(el);
    const img = $el.find('img').first();
    const rawTitle =
      $el.attr('title') ||
      $el.find('[class*="title"], h2, h3, h4').first().text() ||
      img.attr('alt') ||
      $el.attr('aria-label') ||
      '';
    films.push({
      contentId: fm[2],
      slug: fm[1],
      title: cleanTitle(rawTitle),
      poster: abs(img.attr('data-src') || img.attr('src') || img.attr('data-original')),
      tvplusUrl: url.href.split('?')[0].split('#')[0],
    });
  });

  return { films, genreUrls: [...genreUrls] };
}

// Merge film records by contentId, keeping the best (non-junk, longest) title.
function mergeById(records) {
  const byId = new Map();
  for (const r of records) {
    const title = r.title && !looksLikeJunk(r.title) ? r.title : '';
    const prev = byId.get(r.contentId);
    if (!prev) {
      byId.set(r.contentId, { ...r, title });
    } else {
      prev.poster ||= r.poster;
      prev.tvplusUrl ||= r.tvplusUrl;
      if (title && (!prev.title || title.length > prev.title.length)) prev.title = title;
    }
  }
  // Ensure every film has a usable title (fall back to the URL slug).
  const out = [];
  for (const m of byId.values()) {
    const title = m.title || slugToTitle(m.slug);
    if (!title || title.length < 2) continue;
    out.push({
      tvplusKey: `tvplus:${m.contentId}`,
      contentId: m.contentId,
      title,
      year: null, // TV+ cards don't expose a year; ratings backfill it
      poster: m.poster || null,
      tvplusUrl: m.tvplusUrl || null,
      genres: [],
    });
  }
  return out;
}

/**
 * Scrape the live TV+ catalogue. Crawls the landing page plus every genre page
 * and unions the films. Returns a normalized, deduped movie array.
 */
export async function scrapeTvplus({ log } = {}) {
  const landing = cheerio.load(await fetchText(config.tvplusUrl));
  const { films, genreUrls } = extractPage(landing);
  const all = [...films];

  if (log) log(`[scrape] landing: ${films.length} film links, ${genreUrls.length} genres`);

  for (const gUrl of genreUrls) {
    try {
      const $g = cheerio.load(await fetchText(gUrl));
      const got = extractPage($g).films;
      all.push(...got);
      if (log) log(`[scrape]   ${gUrl} -> ${got.length}`);
    } catch (err) {
      if (log) log(`[scrape]   ${gUrl} -> failed: ${err.message}`);
    }
  }

  let movies = mergeById(all);

  // Fallback: if the URL pattern yielded nothing (markup changed), use the
  // older embedded-JSON / card heuristics so we still return something.
  if (movies.length === 0) {
    let legacy = fromEmbeddedJson(landing);
    if (legacy.length === 0) legacy = fromCards(landing);
    legacy = legacy
      .map((m) => ({ ...m, title: cleanTitle(m.title) }))
      .filter((m) => m.title && m.title.length > 1 && !looksLikeJunk(m.title));
    movies = dedupe(legacy);
    movies.forEach((m) => (m.tvplusKey = makeKey(m.title, m.year)));
  }

  if (log) log(`[scrape] total unique films: ${movies.length}`);
  return movies;
}
