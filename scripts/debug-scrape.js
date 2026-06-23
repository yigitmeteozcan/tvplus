// Diagnose whether we're capturing the FULL TV+ catalogue or only the first
// batch of a lazy-loading single-page app.
//
//   npm run debug:scrape
//
// Saves the raw page to data/tvplus-page.html and reports how many films each
// strategy finds, plus any API endpoints the page references (which would hold
// the complete list if the visible page is lazy-loaded).
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fetchText } from '../src/fetch.js';
import { config } from '../src/config.js';
import { scrapeTvplus } from '../src/scraper-tvplus.js';

console.log(`Fetching ${config.tvplusUrl} ...`);
const html = await fetchText(config.tvplusUrl);
const out = path.join(path.dirname(config.dbPath), 'tvplus-page.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

const $ = cheerio.load(html);
console.log(`\nSaved raw HTML -> ${out}`);
console.log(`Page size      : ${(html.length / 1024).toFixed(0)} KB`);
console.log(`<script> tags  : ${$('script').length}`);
console.log(`__NEXT_DATA__  : ${$('#__NEXT_DATA__').length ? 'present (Next.js)' : 'absent'}`);

console.log('\n-- raw element counts (before cleaning/dedupe) --');
console.log(`a[href*="/film"] : ${$('a[href*="/film"]').length}`);
console.log(`[class*="poster"]: ${$('[class*="poster"]').length}`);
console.log(`[class*="card"]  : ${$('[class*="card"]').length}`);
console.log(`<img>            : ${$('img').length}`);

// Look for API / data endpoints the SPA might call for the full catalogue.
const urls = [...new Set(html.match(/https?:\/\/[^"'\s\\)]+/g) || [])];
const apiLike = urls.filter((u) => /api|graphql|catalog|content|movie|film|vod/i.test(u));
console.log(`\n-- candidate data endpoints (${apiLike.length}) --`);
apiLike.slice(0, 25).forEach((u) => console.log('  ' + u));

console.log('\n-- crawling landing + every genre page --');
const movies = await scrapeTvplus({ log: (m) => console.log(m) });
console.log(`\n-- result --`);
console.log(`unique movies after full genre crawl: ${movies.length}`);
console.log('first 5:', movies.slice(0, 5).map((m) => m.title));
console.log(
  '\nIf this number is much higher than the ~189 from the landing page alone,\n' +
    'the genre crawl is now pulling the full catalogue.'
);
