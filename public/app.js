// Front-end: fetch movies, render the grid, wire up filter/sort/sync.
const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const genreFilter = document.getElementById('genreFilter');
const sortBy = document.getElementById('sortBy');
const newOnly = document.getElementById('newOnly');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('syncBtn');

let state = { movies: [], genres: [] };

async function load() {
  const res = await fetch('/api/movies');
  const data = await res.json();
  state = data;
  populateGenres(data.genres);
  renderStatus(data.lastSync, data.syncing);
  render();
}

function populateGenres(genres) {
  const current = genreFilter.value;
  genreFilter.innerHTML = '<option value="">All genres</option>';
  for (const g of genres) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    genreFilter.appendChild(opt);
  }
  genreFilter.value = current;
}

function renderStatus(lastSync, syncing) {
  if (syncing) {
    statusEl.textContent = 'Syncing…';
    syncBtn.disabled = true;
    return;
  }
  syncBtn.disabled = false;
  if (!lastSync || !lastSync.finished_at) {
    statusEl.textContent = 'Not synced yet';
    return;
  }
  const when = new Date(lastSync.finished_at);
  const msg = lastSync.status === 'error' ? `⚠ ${lastSync.message}` : lastSync.message || 'Synced';
  statusEl.textContent = `Last sync: ${when.toLocaleString()} · ${msg}`;
}

function render() {
  const genre = genreFilter.value;
  let movies = state.movies.slice();

  if (genre) movies = movies.filter((m) => (m.genres || []).includes(genre));
  if (newOnly.checked) movies = movies.filter((m) => m.is_new);

  movies.sort(comparator(sortBy.value));

  countEl.textContent = `${movies.length} film${movies.length === 1 ? '' : 's'}`;
  grid.innerHTML = '';

  if (movies.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = state.movies.length
      ? 'No movies match these filters.'
      : 'No movies yet — run a sync to populate the catalogue.';
    return;
  }
  emptyEl.hidden = true;
  for (const m of movies) grid.appendChild(card(m));
}

function comparator(mode) {
  const r = (m) => (m.lb_rating == null ? -Infinity : m.lb_rating);
  switch (mode) {
    case 'rating-asc':
      return (a, b) => r(a) - r(b) || a.title.localeCompare(b.title);
    case 'title-asc':
      return (a, b) => a.title.localeCompare(b.title);
    case 'year-desc':
      return (a, b) => (b.year || 0) - (a.year || 0);
    case 'year-asc':
      return (a, b) => (a.year || 9999) - (b.year || 9999);
    case 'new-first':
      return (a, b) => (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0) || r(b) - r(a);
    case 'rating-desc':
    default:
      return (a, b) => r(b) - r(a) || a.title.localeCompare(b.title);
  }
}

function card(m) {
  const el = document.createElement('article');
  el.className = 'card';

  const poster = m.lb_poster || m.poster;
  const posterHtml = poster
    ? `<a class="poster" style="background-image:url('${escapeAttr(poster)}')" ${linkAttrs(m)}></a>`
    : `<div class="poster placeholder">${escapeHtml(m.title)}</div>`;

  const rating =
    m.lb_rating != null
      ? `<span class="rating"><span class="star">★</span>${m.lb_rating.toFixed(2)}</span>`
      : `<span class="rating none">No rating</span>`;

  const genres = (m.genres || []).slice(0, 3).join(' · ');

  el.innerHTML = `
    ${m.is_new ? '<span class="badge-new">NEW</span>' : ''}
    ${posterHtml}
    <div class="meta">
      <div class="row">
        <span class="title">${escapeHtml(m.title)}</span>
      </div>
      <div class="row">
        <span class="year">${m.year || '—'}</span>
        ${rating}
      </div>
      ${genres ? `<div class="genres">${escapeHtml(genres)}</div>` : ''}
    </div>`;
  return el;
}

function linkAttrs(m) {
  return m.lb_url ? `href="${escapeAttr(m.lb_url)}" target="_blank" rel="noopener"` : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

genreFilter.addEventListener('change', render);
sortBy.addEventListener('change', render);
newOnly.addEventListener('change', render);

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  statusEl.textContent = 'Syncing…';
  await fetch('/api/sync', { method: 'POST' });
  poll();
});

// Poll status while a sync is in flight, then reload the grid when it finishes.
function poll() {
  const iv = setInterval(async () => {
    const res = await fetch('/api/status');
    const s = await res.json();
    renderStatus(s.lastSync, s.syncing);
    if (!s.syncing) {
      clearInterval(iv);
      load();
    }
  }, 1500);
}

load();
