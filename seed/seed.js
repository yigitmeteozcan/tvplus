// Seed the database with a sample catalogue so the UI is fully demoable
// without live network access. Ratings/posters mirror real Letterboxd data
// at the time of writing. Run: npm run seed
//
// Real syncs (npm run sync) overwrite this with live TV+ data.
import { db } from '../src/db.js';
import { makeKey } from '../src/scraper-tvplus.js';

const now = new Date().toISOString();
const lbImg = (slug) => `https://a.ltrbxd.com/resized/film-poster/${slug}.jpg`;

// title, year, genres, lb_slug, lb_rating, lb_rating_count, isNew
const SAMPLE = [
  ['Inception', 2010, ['Action', 'Science Fiction', 'Thriller'], 'inception', 4.21, 1300000, false],
  ['Parasite', 2019, ['Comedy', 'Thriller', 'Drama'], 'parasite-2019', 4.56, 1400000, false],
  ['The Grand Budapest Hotel', 2014, ['Comedy', 'Drama'], 'the-grand-budapest-hotel', 4.25, 1100000, false],
  ['Whiplash', 2014, ['Drama', 'Music'], 'whiplash-2014', 4.41, 1200000, false],
  ['Mad Max: Fury Road', 2015, ['Action', 'Adventure', 'Science Fiction'], 'mad-max-fury-road', 4.13, 950000, false],
  ['La La Land', 2016, ['Comedy', 'Drama', 'Romance', 'Music'], 'la-la-land', 4.08, 1000000, false],
  ['Interstellar', 2014, ['Adventure', 'Drama', 'Science Fiction'], 'interstellar', 4.37, 1500000, false],
  ['The Dark Knight', 2008, ['Action', 'Crime', 'Drama', 'Thriller'], 'the-dark-knight', 4.55, 1600000, false],
  ['Pulp Fiction', 1994, ['Crime', 'Thriller'], 'pulp-fiction', 4.26, 1400000, false],
  ['Spirited Away', 2001, ['Animation', 'Family', 'Fantasy'], 'spirited-away', 4.50, 900000, false],
  ['Drive', 2011, ['Crime', 'Drama', 'Thriller'], 'drive-2011', 4.05, 1000000, false],
  ['Blade Runner 2049', 2017, ['Science Fiction', 'Drama'], 'blade-runner-2049', 4.27, 800000, false],
  ['Dune: Part Two', 2024, ['Science Fiction', 'Adventure'], 'dune-part-two', 4.34, 700000, true],
  ['Poor Things', 2023, ['Comedy', 'Drama', 'Romance', 'Science Fiction'], 'poor-things-2023', 4.10, 650000, true],
];

const insert = db.prepare(`
  INSERT INTO movies
    (tvplus_key, title, year, poster, tvplus_url, genres,
     lb_slug, lb_url, lb_rating, lb_rating_count, lb_poster, lb_fetched_at,
     first_seen_at, last_seen_at, is_new)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(tvplus_key) DO UPDATE SET
    genres=excluded.genres, lb_rating=excluded.lb_rating,
    lb_rating_count=excluded.lb_rating_count, lb_poster=excluded.lb_poster,
    lb_fetched_at=excluded.lb_fetched_at, is_new=excluded.is_new
`);

for (const [title, year, genres, slug, rating, count, isNew] of SAMPLE) {
  const url = `https://letterboxd.com/film/${slug}/`;
  insert.run(
    makeKey(title, year),
    title,
    year,
    lbImg(slug),
    `https://www.tvplus.com.tr/filmler`,
    JSON.stringify(genres),
    slug,
    url,
    rating,
    count,
    lbImg(slug),
    now,
    now,
    now,
    isNew ? 1 : 0
  );
}

db.prepare(`INSERT INTO sync_runs (started_at, finished_at, found_count, new_count, status, message)
            VALUES (?,?,?,?, 'ok', ?)`).run(
  now,
  now,
  SAMPLE.length,
  SAMPLE.filter((s) => s[6]).length,
  `Seeded ${SAMPLE.length} sample movies.`
);

console.log(`Seeded ${SAMPLE.length} movies into the database.`);
