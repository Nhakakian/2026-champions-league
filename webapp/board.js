/* Board page: the sortable/filterable player table. */
'use strict';

const view = {
  filters: { pos: 'ALL', tier: '', flags: new Set(), q: '', showDrafted: true },
  sort: { key: 'compositeRank', dir: 1 },
  pendingFile: null,
};

/* Column model. Source columns are generated, so adding a source adds a
 * column with no code change. */
function columns() {
  const cols = [
    { key: 'watch', label: '★', sortable: false, cls: 'starcol' },
    { key: 'compositeRank', label: '#', cls: 'num' },
    { key: 'player', label: 'Player' },
    { key: 'pos', label: 'Pos' },
    { key: 'team', label: 'Tm' },
    { key: 'tier', label: 'Tier', cls: 'num' },
    { key: 'posRank', label: 'Pos#', cls: 'num' },
  ];
  for (const s of state.sources) {
    cols.push({
      key: 'src:' + s.id, label: s.short || s.label || s.id, cls: 'num', src: s.id,
      title: `${s.label}${s.column ? ' — column: ' + s.column : ''}` +
             `${s.weight > 0 ? '' : '  (weight 0 — shown but not counted)'}`,
    });
  }
  cols.push({ key: 'adpDelta', label: 'vs ADP', cls: 'num',
    title: 'ADP rank minus composite rank. Positive = cheaper than we rank him.' });
  cols.push({ key: 'leagueDelta', label: 'League', cls: 'num',
    title: "Market pick minus this league's historical pick for the positional slot. " +
           'Negative = this league lets the slot fall to you.' });
  cols.push({ key: 'flags', label: 'Flags', sortable: false });
  return cols;
}

const cellValue = (p, key) => key.startsWith('src:') ? srcValue(p, key.slice(4)) : p[key];

function visible() {
  const f = view.filters;
  const q = f.q.trim().toLowerCase();
  return state.players.filter((p) => {
    if (!f.showDrafted && state.drafted.has(p.id)) return false;
    if (!matchesPosFilter(p, f.pos)) return false;
    if (f.tier && !(p.tier != null && p.tier <= +f.tier)) return false;
    if (f.flags.size && !p.flags.some((x) => f.flags.has(x))) return false;
    if (q && !p.player.toLowerCase().includes(q) &&
             !(p.team || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function sorted(list) {
  const { key, dir } = view.sort;
  return [...list].sort((a, b) => {
    const x = cellValue(a, key), y = cellValue(b, key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;              // nulls always last
    if (y == null) return -1;
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * (x - y);
  });
}

const fmt = (v) => v == null ? '—' : (v > 0 ? '+' : '') + v;
// leagueDelta is inverted: a NEGATIVE delta means the slot falls to you, which
// is the good outcome, so the colour is flipped relative to adpDelta.
const cls = (v, invert = false) => v == null ? '' :
  (invert ? (v < 0 ? 'delta-pos' : v > 0 ? 'delta-neg' : '')
          : (v > 0 ? 'delta-pos' : v < 0 ? 'delta-neg' : ''));

function render() {
  const rows = sorted(visible());
  el('availCount').textContent = state.players.length - state.drafted.size;
  el('draftedCount').textContent = state.drafted.size;
  el('undoBtn').disabled = state.picks.length === 0;

  const cols = columns();
  el('headRow').innerHTML = cols.map((c) => {
    const sortable = c.sortable === false ? '' : ' sortable';
    const on = c.key === view.sort.key
      ? (view.sort.dir === 1 ? ' sorted-asc' : ' sorted-desc') : '';
    const dim = c.src && !(state.sources.find((s) => s.id === c.src)?.weight > 0)
      ? ' style="opacity:.55"' : '';
    return `<th data-sort="${esc(c.key)}" class="${c.cls || ''}${sortable}${on}"` +
           `${c.title ? ` title="${esc(c.title)}"` : ''}${dim}>${esc(c.label)}</th>`;
  }).join('');

  el('rows').innerHTML = rows.map((p) => {
    const drafted = state.drafted.has(p.id);
    const cells = cols.map((c) => {
      switch (c.key) {
        case 'watch': return `<td class="starcol"><button class="star ${
          state.watch.has(p.id) ? 'on' : ''}" data-act="watch">★</button></td>`;
        case 'compositeRank': return `<td class="num">${p.compositeRank}</td>`;
        case 'player': return `<td class="name">${esc(p.player)}</td>`;
        case 'pos': return `<td><span class="pos pos-${p.pos}">${p.pos || ''}</span></td>`;
        case 'team': return `<td>${esc(p.team || '—')}</td>`;
        case 'tier': return `<td class="num tiercell" style="--tier-c:${tierColor(p.tier)}">` +
                            `<span class="badge">${p.tier ?? '—'}</span></td>`;
        case 'posRank': return `<td class="num">${p.posRank ?? ''}</td>`;
        case 'adpDelta': return `<td class="num ${cls(p.adpDelta)}">${fmt(p.adpDelta)}</td>`;
        case 'leagueDelta': return `<td class="num ${cls(p.leagueDelta, true)}">${fmt(p.leagueDelta)}</td>`;
        case 'flags': return `<td><span class="flags">${p.flags.map((f) =>
          `<span class="flag f-${f}" title="${esc(FLAG_HELP[f] || f)}">${FLAG_LABEL[f] || f}</span>`)
          .join('')}</span></td>`;
        default: {
          const v = srcValue(p, c.src);
          return `<td class="num srcval">${v == null ? '—' : trim(v)}</td>`;
        }
      }
    }).join('');
    const mine = drafted && isMine(p.id);
    // r-<POS> tints the whole row; the Pos column still carries the text, so
    // position is never communicated by colour alone.
    const cl = [`r-${p.pos || 'NA'}`, drafted ? 'drafted' : '', mine ? 'mypick' : '']
      .filter(Boolean).join(' ');
    return `<tr data-id="${esc(p.id)}" class="${cl}">${cells}</tr>`;
  }).join('');

  el('empty').hidden = rows.length > 0;
  renderLog();
}

function renderLog() {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  el('log').innerHTML = state.picks.map((pk, i) => ({ ...pk, n: i + 1 }))
    .slice(-12).reverse().map(({ id, mine, n }) => {
      const p = byId.get(id);
      return p ? `<li><span class="pnum">${n}</span> ` +
        `<span class="lname${mine ? ' mine' : ''}">${esc(p.player)}</span> ${p.pos}` +
        `${mine ? ' <span class="metag">ME</span>' : ''}</li>` : '';
    }).join('') || '<li class="muted">No picks yet.</li>';
}

/* ------------------------------------------------------------------ chrome */
function buildChrome() {
  for (let i = 1; i <= 12; i++) {
    el('tierFilter').insertAdjacentHTML('beforeend', `<option value="${i}">${i}</option>`);
  }
  el('flagFilter').innerHTML = Object.keys(FLAG_LABEL)
    .map((f) => `<button class="chip f-${f}" data-flag="${f}" title="${esc(FLAG_HELP[f])}">` +
                `${f.replace('_', ' ')}</button>`).join('');
  renderWeights();
}

function renderWeights() {
  const w = normWeights();
  el('weights').innerHTML = state.sources.map((s) => `
    <div class="wrow">
      <div class="wtop"><span>${esc(s.label)}</span><span class="wval">${Math.round(w[s.id] * 100)}%</span></div>
      <input type="range" min="0" max="100" value="${Math.round(s.weight * 100)}" data-src="${esc(s.id)}">
      <div class="wfile">${esc(s.dynamic ? 'uploaded this session' : s.file)}</div>
    </div>`).join('');
  for (const input of el('weights').querySelectorAll('input[type=range]')) {
    input.addEventListener('input', (e) => {
      state.sources.find((x) => x.id === e.target.dataset.src).weight = +e.target.value / 100;
      renderWeights(); recompute(); persist(); render();
    });
  }
}

/* ------------------------------------------------------------------ events */
function wire() {
  el('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.closest('button[data-act=watch]')) { toggleWatch(id); render(); return; }
    // Shift-click records the pick as yours; a plain click defers to the snake.
    toggleDrafted(id, e.shiftKey ? true : undefined);
    render();
  });

  // Delegated: the header is rebuilt on every render, since the source
  // columns change whenever a source is added or replaced.
  el('headRow').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const k = th.dataset.sort;
    view.sort = view.sort.key === k ? { key: k, dir: -view.sort.dir } : { key: k, dir: 1 };
    render();
  });

  el('posFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    view.filters.pos = b.dataset.pos;
    el('posFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });

  el('flagFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const f = b.dataset.flag;
    view.filters.flags.has(f) ? view.filters.flags.delete(f) : view.filters.flags.add(f);
    b.classList.toggle('on');
    render();
  });

  el('search').addEventListener('input', (e) => { view.filters.q = e.target.value; render(); });
  el('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const top = sorted(visible()).find((p) => !state.drafted.has(p.id));
    if (top) { toggleDrafted(top.id); e.target.value = ''; view.filters.q = ''; render(); }
  });

  el('tierFilter').addEventListener('change', (e) => { view.filters.tier = e.target.value; render(); });
  el('showDrafted').addEventListener('change', (e) => { view.filters.showDrafted = e.target.checked; render(); });

  el('clearFilters').addEventListener('click', () => {
    view.filters = { pos: 'ALL', tier: '', flags: new Set(), q: '', showDrafted: true };
    el('search').value = ''; el('tierFilter').value = ''; el('showDrafted').checked = true;
    el('posFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.pos === 'ALL'));
    el('flagFilter').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    render();
  });

  el('undoBtn').addEventListener('click', () => { if (undo()) render(); });
  el('resetBtn').addEventListener('click', () => {
    if (confirm('Clear all drafted players and start over?')) { resetDraft(); render(); }
  });
  el('resetWeights').addEventListener('click', () => {
    state.sources.forEach((s) => { s.weight = s.base ?? s.weight; });
    renderWeights(); recompute(); persist(); render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== el('search')) {
      e.preventDefault(); el('search').focus();
    } else if (e.key === 'Escape') { el('search').blur(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (undo()) render(); }
  });

  wireUpload();
}

/* ------------------------------------------------------------ CSV upload */
function parseCSV(text) {
  // Handles quoted fields containing commas (the Indicators column does).
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { header, records };
}

const nameKey = (s) => String(s).toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[.'’`]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

function wireUpload() {
  const drop = el('filedrop'), input = el('fileInput');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', (e) => { if (e.target.files[0]) readFile(e.target.files[0]); });
  el('srcApply').addEventListener('click', applyUpload);
  el('srcCancel').addEventListener('click', closeUpload);
  el('srcTarget').addEventListener('change', (e) => {
    el('srcNameRow').hidden = e.target.value !== '__new__';
  });
}

function closeUpload() {
  el('fileConfig').hidden = true;
  el('fileInput').value = '';
  view.pendingFile = null;
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const { header, records } = parseCSV(reader.result);
    const nameCol = header.find((h) => /^(player|player name|name)$/i.test(h)) ||
                    header.find((h) => /player|name/i.test(h));
    if (!nameCol || !records.length) { alert('Could not find a player-name column in that CSV.'); return; }
    const numeric = header.filter((h) =>
      h !== nameCol && records.some((r) => r[h] !== '' && !isNaN(+r[h])));
    if (!numeric.length) { alert('No numeric rank column found in that CSV.'); return; }

    view.pendingFile = { file, records, nameCol };
    el('srcColumn').innerHTML = numeric.map((h) => `<option>${esc(h)}</option>`).join('');
    // Replacing is chosen from an explicit list rather than matched on a typed
    // name — "Faraz" never equals "Faraz (Upper Hand)", so name matching
    // silently added a duplicate source instead of overwriting.
    el('srcTarget').innerHTML =
      state.sources.map((s) => `<option value="${esc(s.id)}">Replace: ${esc(s.label)}</option>`)
        .join('') + '<option value="__new__">Add as new source</option>';
    const guess = state.sources.find((s) =>
      nameKey(file.name).includes(nameKey(s.label).split(' ')[0]));
    el('srcTarget').value = guess ? guess.id : '__new__';
    el('srcNameRow').hidden = el('srcTarget').value !== '__new__';
    el('srcName').value = file.name.replace(/\.csv$/i, '').slice(0, 40);
    el('fileConfig').hidden = false;
  };
  reader.readAsText(file);
}

function applyUpload() {
  const pending = view.pendingFile;
  if (!pending) return;
  const col = el('srcColumn').value;
  const target = el('srcTarget').value;
  const existing = target === '__new__' ? null : state.sources.find((s) => s.id === target);
  const label = existing ? existing.label : (el('srcName').value.trim() || pending.file.name);

  // Map by normalized name onto the existing pool. A source can only re-rank
  // players already on the board; it cannot introduce new ones, since the rest
  // of the board (tiers, league curve) is built from the pooled roster.
  const byKey = new Map(state.data.players.map((p) => [nameKey(p.player), p.id]));
  const ranks = new Map();
  let matched = 0; const missed = [];
  const rows = pending.records
    .map((r) => ({ key: nameKey(r[pending.nameCol]), v: parseFloat(r[col]) }))
    .filter((r) => r.key && !isNaN(r.v))
    .sort((a, b) => a.v - b.v);
  rows.forEach((r, i) => {
    const id = byKey.get(r.key);
    if (id) { ranks.set(id, i + 1); matched++; } else missed.push(r.key);
  });
  if (!matched) { alert('None of those player names matched the current board.'); return; }

  if (existing) {
    // Keep the source's identity and weight; swap only the numbers.
    Object.assign(existing, { dynamic: true, ranks, file: pending.file.name });
  } else {
    state.sources.push({
      id: 'up_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label, short: label.slice(0, 8), column: col,
      weight: 0.3, base: 0.3, dynamic: true, ranks, file: pending.file.name,
    });
  }
  closeUpload();
  renderWeights(); recompute(); render();
  alert(`${existing ? 'Replaced' : 'Added'} "${label}" using column "${col}".\n` +
        `${matched} of ${rows.length} rows matched the board.` +
        (missed.length ? `\n${missed.length} unmatched row(s) ignored — not in the player pool.` : ''));
}

loadData().then((ok) => { if (ok) { buildChrome(); wire(); render(); } });
