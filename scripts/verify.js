// Verify a single movie's rating end to end, so you can confirm the numbers
// yourself against the live TMDB / IMDb pages.
//
//   TMDB_API_KEY=... OMDB_API_KEY=... npm run verify -- "Joker"
//
// Prints what each provider returned, the links to check them, and how the
// combined 0–5 rating was computed.
import { lookupTmdb, lookupOmdb, lookupRating } from '../src/ratings.js';
import { config } from '../src/config.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('Usage: npm run verify -- "<movie title>" [year]');
  process.exit(1);
}
// Allow an optional trailing year.
let year = null;
const m = name.match(/\s(\d{4})$/);
const title = m ? name.slice(0, m.index).trim() : name;
if (m) year = Number(m[1]);

console.log(`\nVerifying: "${title}"${year ? ` (${year})` : ''}`);
console.log(`Keys configured -> TMDB: ${config.tmdbApiKey ? 'yes' : 'NO'}, OMDb: ${config.omdbApiKey ? 'yes' : 'NO'}\n`);

const [tmdb, omdb, combined] = await Promise.all([
  lookupTmdb(title, year).catch((e) => ({ error: e.message })),
  lookupOmdb(title, year).catch((e) => ({ error: e.message })),
  lookupRating(title, year).catch((e) => ({ error: e.message })),
]);

function show(label, p) {
  if (!p) return console.log(`${label}: no match`);
  if (p.error) return console.log(`${label}: ERROR ${p.error}`);
  const five = p.score10 != null ? (p.score10 / 2).toFixed(2) : 'n/a';
  console.log(`${label}:`);
  console.log(`   raw score : ${p.score10 ?? 'n/a'} / 10   ->   ${five} / 5`);
  console.log(`   votes     : ${p.votes ?? 'n/a'}`);
  console.log(`   year      : ${p.year ?? 'n/a'}`);
  console.log(`   check it  : ${p.url ?? 'n/a'}`);
}

show('TMDB', tmdb);
console.log('');
show('IMDb (OMDb)', omdb);

console.log('\n--- COMBINED ---');
if (!combined || combined.error) {
  console.log(combined?.error || 'no match on any provider');
} else {
  const parts = Object.entries(combined.detail || {}).map(
    ([k, v]) => `${k.toUpperCase()} ${v.score5}/5`
  );
  console.log(`sources : ${combined.sources?.join(' + ') || 'none'}`);
  console.log(`math    : avg(${parts.join(', ')}) = ${combined.rating}/5`);
  console.log(`stored  : ${combined.rating} / 5\n`);
}
