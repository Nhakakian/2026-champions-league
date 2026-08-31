/* Shared state, maths and draft model for all three pages.
 *
 * The composite and tiering maths MIRROR pipeline/composite.py and
 * pipeline/tiers.py so that moving a weight slider produces exactly what a
 * rebuild at those weights would produce. Verified identical across the
 * full player pool. If you change the algorithm in Python, change it here.
 *
 * Loaded as a classic script, not a module: ES modules are blocked over
 * file://, and opening the board by double-click is a hard requirement.
 */
'use strict';

const PALETTE = ['#4d9fff','#3fb950','#e3b341','#f778ba','#a371f7',
                 '#f0883e','#39c5cf','#db6d28','#7ee787','#ff7b72'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
// Flex is every skill position except QB. Kept here so the Board and the
// Draft page can never drift apart on what "Flex" means.
const FLEX_POSITIONS = ['RB', 'WR', 'TE'];
const matchesPosFilter = (p, f) =>
  f === 'ALL' ? true : f === 'FLEX' ? FLEX_POSITIONS.includes(p.pos) : p.pos === f;

// Short badge text. VALUE and REACH must not rely on colour alone to be told
// apart, so the +/- carries the direction and the prefix carries the source.
const FLAG_LABEL = {
  LEAGUE_VALUE: 'LG+', LEAGUE_REACH: 'LG−',
  MARKET_VALUE: 'MKT+', MARKET_REACH: 'MKT−',
  VOLATILE: 'VOL', THIN_COVERAGE: 'THIN',
};

const FLAG_HELP = {
  LEAGUE_VALUE: 'This league historically lets this positional slot fall — you can wait.',
  LEAGUE_REACH: 'This league takes this positional slot earlier than the market — move up.',
  MARKET_VALUE: 'Cheaper by ADP than the composite ranks him.',
  MARKET_REACH: 'Costs more by ADP than the composite ranks him.',
  VOLATILE: 'Sources disagree sharply about this player.',
  THIN_COVERAGE: 'Ranked by only part of the weighted sources.',
};

const state = {
  data: null,
  sources: [],       // {id,label,short,weight,file,dynamic?,ranks?}
  players: [],
  curve: new Map(),  // "POS|slot" -> delta
  picks: [],         // ordered [{id, seat}] — this IS the draft
  drafted: new Set(),// derived from picks
  watch: new Set(),  // starred players
  order: [],         // manager names, index 0 = seat 1
  seat: null,        // 1..teams — which seat is yours
  gridH: null,       // draft-board height in vh; null = the CSS default
  notes: new Map(),  // player id -> your own note. Namespaced with the
                     // rest of the draft state, so dynasty notes and
                     // redraft notes are separate sets entirely.
};

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const trim = (v) => v == null ? null : (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
const tierColor = (t) => t ? PALETTE[(t - 1) % PALETTE.length] : 'var(--line)';

/* Dynasty age bands. Deliberately coarse: the point is to spot the 23-year-old
 * next to the 30-year-old while scanning, not to imply precision the sources
 * do not have. Thresholds differ by position because a 28-year-old running
 * back and a 28-year-old quarterback are not the same asset at all. */
const AGE_BANDS = {           // [young at or below, old at or above]
  QB: [25, 33],
  RB: [23, 27],              // the cliff arrives earliest here
  WR: [24, 30],
  TE: [24, 31],              // and latest here
};
function ageClass(age, pos) {
  if (age == null) return '';
  const [young, old] = AGE_BANDS[pos] || [24, 29];
  if (age <= young) return ' age-young';
  if (age >= old) return ' age-old';
  return '';
}

/* --------------------------------------------------- platform (draft site)
 * The source flagged role: platform in config is the ranking the draft is
 * actually run against. It is not treated as a better opinion -- its weight
 * is whatever you set -- but it is the best available predictor of what the
 * other managers will do next.
 */
function platformSource() {
  const id = state.data?.platformSourceId;
  return id ? state.sources.find((s) => s.id === id) : null;
}
function platformShort() {
  const s = platformSource();
  return s ? (s.short || s.label || s.id) : '';
}
function platformLabel() {
  const s = platformSource();
  return s ? (s.label || s.id) : '';
}
function platformRank(p) {
  const id = state.data?.platformSourceId;
  if (!id) return null;
  const v = p.rawRanks?.[id];
  return v == null ? null : v;
}


/* ======================================================================
 * SYNC — moving your board between computers
 *
 * Picks, watch list and notes live in localStorage, which is per browser on
 * one machine and never travels. This site is static hosting: there is no
 * server to keep your data on, so there is nothing to sync against
 * automatically. What follows makes the state portable instead -- a link you
 * can paste, or a file you can carry -- which doubles as a backup if a
 * browser dies mid-draft.
 *
 * The payload is stamped with its namespace, so a dynasty board can never be
 * restored on top of the redraft board or the other way round.
 * ==================================================================== */

function currentStateBlob() {
  return {
    v: 1,
    ns: NS || 'redraft',
    savedAt: new Date().toISOString(),
    league: state.data?.league?.name || null,
    data: JSON.parse(localStorage.getItem(KEY) || '{}'),
  };
}

function encodeState(blob) {
  // base64 of UTF-8 JSON; encodeURIComponent first so non-ASCII names survive.
  return btoa(unescape(encodeURIComponent(JSON.stringify(blob))));
}
function decodeState(text) {
  return JSON.parse(decodeURIComponent(escape(atob(text))));
}

function applyStateBlob(blob) {
  if (!blob || blob.v !== 1 || !blob.data) throw new Error('not a board backup');
  const mine = NS || 'redraft';
  if (blob.ns !== mine) {
    throw new Error(
      'that backup is from the ' + (blob.ns === 'dynasty' ? 'dynasty' : 'redraft') +
      ' board \u2014 open that board and restore it there');
  }
  localStorage.setItem(KEY, JSON.stringify(blob.data));
  location.reload();
}

function stateSummary(blob) {
  const d = blob.data || {};
  const when = blob.savedAt ? new Date(blob.savedAt).toLocaleString() : 'unknown time';
  return (d.picks || []).length + ' picks \u00b7 ' + (d.watch || []).length +
         ' starred \u00b7 ' + Object.keys(d.notes || {}).length + ' notes \u2014 saved ' + when;
}

/* A restore replaces everything, so say what is about to be lost. */
function confirmRestore(blob) {
  const now = currentStateBlob();
  const d = now.data || {};
  const busy = (d.picks || []).length || (d.watch || []).length ||
               Object.keys(d.notes || {}).length;
  if (!busy) return true;
  return confirm('Restore will REPLACE what is on this board.\n\n' +
    'Now:       ' + stateSummary(now) + '\n' +
    'Restoring: ' + stateSummary(blob) + '\n\nContinue?');
}

function renderSync() {
  const host = el('sync');
  if (!host) return;
  host.innerHTML =
    '<p class="hint">Picks, stars and notes are saved in <em>this</em> browser only. ' +
    'To carry them to another computer, copy a link or save a file.</p>' +
    '<div class="syncbtns">' +
    '<button id="syncCopy" class="btn">Copy sync link</button>' +
    '<button id="syncSave" class="btn btn-quiet">Save file</button>' +
    '<label class="btn btn-quiet filebtn">Restore\u2026' +
    '<input type="file" id="syncLoad" accept=".json,application/json" hidden></label>' +
    '</div><p class="hint" id="syncMsg"></p>';

  const msg = (t, bad) => {
    const m = el('syncMsg');
    m.textContent = t;
    m.classList.toggle('bad', !!bad);
  };

  el('syncCopy').addEventListener('click', async () => {
    const link = location.origin + location.pathname + '#s=' + encodeState(currentStateBlob());
    try {
      await navigator.clipboard.writeText(link);
      msg(link.length > 8000
        ? 'Copied \u2014 but it is a long link. If it will not paste, use Save file instead.'
        : 'Link copied. Open it on the other computer.');
    } catch (_) {
      // Clipboard is blocked over plain http and in some browsers; show the
      // link rather than failing silently.
      prompt('Copy this link:', link);
    }
  });

  el('syncSave').addEventListener('click', () => {
    const b = new Blob([JSON.stringify(currentStateBlob(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = (NS || 'redraft') + '-board-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msg('Saved. Move that file to the other computer and use Restore.');
  });

  el('syncLoad').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const blob = JSON.parse(r.result);
        if (confirmRestore(blob)) applyStateBlob(blob);
      } catch (err) { msg(err.message || 'could not read that file', true); }
    };
    r.readAsText(file);
    e.target.value = '';
  });
}

/* A link opened with #s=... carries a board. Never apply it silently. */
function offerHashImport() {
  const m = /[#&]s=([^&]+)/.exec(location.hash);
  if (!m) return;
  let blob;
  try { blob = decodeState(m[1]); } catch (_) { return; }
  // Clear the fragment first, so declining or reloading does not re-prompt.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    if (confirm('This link carries a saved board:\n\n' + stateSummary(blob) +
                '\n\nLoad it here?')) {
      if (confirmRestore(blob)) applyStateBlob(blob);
    }
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------- boot */
async function loadData() {
  let data = window.BOARD_DATA;
  if (!data) {
    try { data = await (await fetch(NS ? `../out/${NS}.json` : '../out/board.json')).json(); }
    catch (err) {
      document.body.innerHTML =
        '<p style="padding:24px">Could not load board data. Run ' +
        '<code>python -m pipeline.build</code>, then reopen this page.</p>';
      return false;
    }
  }
  state.data = data;
  state.sources = data.sources.map((s) => ({ ...s, base: s.weight }));
  state.order = [...(data.league?.draftOrder || [])];
  state.seat = data.league?.mySeat ?? null;
  for (const row of data.tendencies?.curve || []) {
    state.curve.set(`${row.pos}|${row.pos_slot}`, row.delta);
  }
  restore();
  offerHashImport();
  recompute();
  renderNav();
  renderSync();
  warnIfStorageBlocked();
  return true;
}

/* The three pages hand the draft to each other through localStorage. If the
 * browser blocks it, every navigation silently loses your picks -- the worst
 * possible failure mode, discovered mid-draft. Say so loudly instead. */
function storageAvailable() {
  try {
    localStorage.setItem('__cl_probe', '1');
    const ok = localStorage.getItem('__cl_probe') === '1';
    localStorage.removeItem('__cl_probe');
    return ok;
  } catch (_) {
    return false;
  }
}

function warnIfStorageBlocked() {
  if (storageAvailable()) return;
  const bar = document.createElement('div');
  bar.className = 'storagewarn';
  bar.innerHTML =
    '<strong>This browser is blocking local storage.</strong> Your picks will not survive ' +
    'switching between pages. Serve the folder over a local address ' +
    'instead — see the README — or stay on a single page for the whole draft.';
  document.body.insertBefore(bar, document.body.firstChild);
}

/* -------------------------------------------------------- composite maths */
function normWeights() {
  const total = state.sources.reduce((a, s) => a + Math.max(0, s.weight), 0);
  const out = {};
  for (const s of state.sources) out[s.id] = total > 0 ? Math.max(0, s.weight) / total : 0;
  return out;
}

function rankOf(p, sid) {
  const src = state.sources.find((s) => s.id === sid);
  if (src && src.dynamic) return src.ranks.get(p.id) ?? null;
  const v = p.ranks?.[sid];
  return v === undefined ? null : v;
}

/* What a source column DISPLAYS: that source's own number where we have it
 * (an ADP of 88.4 reads better than "rank 88"), falling back to the
 * normalized rank. Deliberately independent of weight — a source at 0%
 * still shows its opinion, which is the point of having the column. */
function srcValue(p, sid) {
  const src = state.sources.find((s) => s.id === sid);
  if (src && src.dynamic) return src.ranks.get(p.id) ?? null;
  const raw = p.rawRanks?.[sid];
  if (raw !== undefined && raw !== null) return raw;
  const r = p.ranks?.[sid];
  return r === undefined ? null : r;
}

/* One weighted geometric-mean pass over a subset of sources.
 * Mirror of _weighted_pass in pipeline/composite.py. */
function weightedPass(src, w, ids, penalty) {
  const worst = {};
  for (const sid of ids) {
    let m = 1;
    for (const p of src) { const r = rankOf(p, sid); if (r != null && r > m) m = r; }
    worst[sid] = m;
  }
  const floor = Math.log1p(Math.max(...Object.values(worst)));
  const total = ids.reduce((a, sid) => a + Math.max(0, w[sid]), 0);

  const score = new Array(src.length);
  const counts = new Array(src.length);
  const missing = new Array(src.length);
  const dis = new Array(src.length);
  const presentWeight = new Array(src.length);

  src.forEach((p, i) => {
    let presentW = 0, acc = 0, n = 0;
    const logs = [];
    for (const sid of ids) {
      const r = rankOf(p, sid);
      if (r == null) continue;
      const lg = Math.log1p(r);
      presentW += Math.max(0, w[sid]); acc += Math.max(0, w[sid]) * lg; n++;
      logs.push([Math.max(0, w[sid]), lg]);
    }
    const mean = presentW > 0 ? acc / presentW : floor;
    const missingFrac = 1 - presentW / total;
    score[i] = presentW > 0 ? mean + penalty * missingFrac * (floor - mean) : floor;
    counts[i] = n;
    missing[i] = missingFrac * 100;
    if (n >= 2) {
      let v = 0;
      for (const [wi, lg] of logs) v += wi * (lg - mean) ** 2;
      dis[i] = Math.sqrt(Math.max(0, v / presentW));
    } else dis[i] = null;
    presentWeight[i] = presentW;
  });

  return { score, counts, missing, dis, presentWeight, floor };
}

/* Spread players no weighted source ranks, using any source that does.
 * Applied AFTER the transplant, which would otherwise wipe the spread out.
 * Mirror of _break_floor_ties in pipeline/composite.py. */
function breakFloorTies(src, score, presentWeight, ids, floor) {
  const best = [];
  src.forEach((p, i) => {
    if (presentWeight[i] > 0) return;
    let m = Infinity;
    for (const sid of ids) { const r = rankOf(p, sid); if (r != null && r < m) m = r; }
    if (Number.isFinite(m)) best.push({ i, m });
  });
  if (!best.length) return score;
  best.sort((a, b) => a.m - b.m);
  const out = score.slice();
  best.forEach((e, k) => { out[e.i] = floor + (k + 1) / (best.length + 1); });
  return out;
}

/* Weighted spread of log(rank WITHIN position) across sources.
 * Mirror of _positional_disagreement in pipeline/composite.py — measured
 * inside the position so a 1QB list doesn't make every quarterback look
 * contested when the gap is really just the scoring format. */
function positionalDisagreement(src, w, ids) {
  const within = {};
  for (const sid of ids) {
    const arr = new Array(src.length).fill(null);
    const byPos = {};
    src.forEach((p, i) => {
      const r = rankOf(p, sid);
      if (r == null) return;
      const key = p.pos ?? '_';
      (byPos[key] = byPos[key] || []).push({ i, r });
    });
    for (const list of Object.values(byPos)) {
      list.sort((a, b) => a.r - b.r);
      let prevVal = null, prevRank = 0;
      list.forEach((e, k) => {
        // rank(method='min'): ties all take the lowest rank of the tie.
        const rank = (prevVal !== null && e.r === prevVal) ? prevRank : k + 1;
        arr[e.i] = rank;
        prevVal = e.r; prevRank = rank;
      });
    }
    within[sid] = arr;
  }

  return src.map((p, i) => {
    let presentW = 0, acc = 0, n = 0;
    const logs = [];
    for (const sid of ids) {
      const wt = Math.max(0, w[sid]);
      const v = within[sid][i];
      if (wt <= 0 || v == null) continue;      // zero-weight sources don't vote
      const lg = Math.log1p(v);
      presentW += wt; acc += wt * lg; n++;
      logs.push([wt, lg]);
    }
    if (n < 2 || presentW <= 0) return null;
    const mean = acc / presentW;
    let varr = 0;
    for (const [wt, lg] of logs) varr += wt * (lg - mean) ** 2;
    return Math.round(Math.sqrt(Math.max(0, varr / presentW)) * 1e4) / 1e4;
  });
}

/* Hand out the anchor's per-position value slots in blend order.
 * Mirror of _transplant in pipeline/composite.py. */
function transplant(src, anchor, blend) {
  const out = anchor.slice();
  const byPos = {};
  src.forEach((p, i) => { if (p.pos) (byPos[p.pos] = byPos[p.pos] || []).push(i); });
  for (const idx of Object.values(byPos)) {
    if (idx.length < 2) continue;
    const slots = idx.map((i) => anchor[i]).sort((a, b) => a - b);
    const order = [...idx].sort((a, b) => blend[a] - blend[b]);
    order.forEach((i, k) => { out[i] = slots[k]; });
  }
  return out;
}

function recompute() {
  const w = normWeights();
  const src = state.data.players;
  const ids = state.sources.map((s) => s.id);
  const weighted = ids.filter((sid) => w[sid] > 0);
  if (!weighted.length) { state.players = []; return; }

  // A source scoped 'positional' is only trusted for order WITHIN a position —
  // see the header of pipeline/composite.py for why that matters.
  const scopeOf = (sid) => state.sources.find((s) => s.id === sid)?.scope || 'overall';
  const overall = weighted.filter((sid) => scopeOf(sid) !== 'positional');
  const penalty = state.data.compositeConfig?.missingPenalty ?? 0.35;

  const blend = weightedPass(src, w, ids, penalty);
  let score = (overall.length && overall.length < weighted.length)
    ? transplant(src, weightedPass(src, w, overall, penalty).score, blend.score)
    : blend.score;
  score = breakFloorTies(src, score, blend.presentWeight, ids, blend.floor);

  const dis = positionalDisagreement(src, w, ids);
  const players = src.map((p, i) => ({
    ...p,
    compositeScore: score[i],
    disagreement: dis[i],
    sourcesRanking: blend.counts[i],
    missingWeightPct: blend.missing[i],
  }));

  players.sort((a, b) => a.compositeScore - b.compositeScore ||
                         a.player.localeCompare(b.player));
  const posCount = {};
  players.forEach((p, i) => {
    p.compositeRank = i + 1;
    posCount[p.pos] = (posCount[p.pos] || 0) + 1;
    p.posRank = posCount[p.pos];
  });

  assignTiers(players);
  applyFlags(players);
  state.players = players;
}

/* Mirror of pipeline/tiers.py — rolling median+MAD threshold per gap. */
function localThresholds(gaps, z, window = 15) {
  const n = gaps.length, half = Math.max(2, Math.floor(window / 2));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const local = gaps.slice(Math.max(0, i - half), Math.min(n, i + half + 1));
    const med = median(local);
    let mad = median(local.map((g) => Math.abs(g - med)));
    if (mad <= 0) mad = stdev(local) || 1e-9;
    out[i] = med + z * 1.4826 * mad;
  }
  return out;
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

function assignTiers(players) {
  const cfg = state.data.tierConfig || {};
  const z = cfg.gapZThreshold ?? 1.0;
  const minSize = cfg.minTierSize ?? 2;
  const maxSize = cfg.maxTierSize ?? 12;

  for (const pos of POSITIONS) {
    const block = players.filter((p) => p.pos === pos);
    if (block.length < 2) { block.forEach((p) => { p.tier = 1; }); continue; }
    const scores = block.map((p) => p.compositeScore);
    const gaps = scores.slice(1).map((s, i) => s - scores[i]);
    const th = localThresholds(gaps, z);
    let cur = 1, size = 1;
    block[0].tier = 1;
    for (let i = 1; i < block.length; i++) {
      let cut = gaps[i - 1] >= th[i - 1] && size >= minSize;
      if (size >= maxSize) cut = true;
      if (cut) { cur++; size = 0; }
      block[i].tier = cur;
      size++;
    }
  }
  for (const p of players) if (!POSITIONS.includes(p.pos)) p.tier = null;
}

function applyFlags(players) {
  const adpId = state.data.adpSourceId;
  const t = state.data.flagThresholds || {};
  const reach = t.leagueReach ?? 8, value = t.leagueValue ?? 8;
  const mkV = t.marketValue ?? 15, mkR = t.marketReach ?? 15;
  const vol = t.volatile ?? 0.20, thin = t.thinCoverage ?? 60;

  for (const p of players) {
    const flags = [];
    // Not gated on weight: comparing the composite against the market is if
    // anything MORE informative when ADP is weighted at zero.
    const adp = rankOf(p, adpId);
    p.adp = adp;
    p.adpDelta = adp == null ? null : +(adp - p.compositeRank).toFixed(1);
    p.leagueDelta = state.curve.get(`${p.pos}|${p.posRank}`) ?? null;

    if (p.leagueDelta != null) {
      if (p.leagueDelta >= reach) flags.push('LEAGUE_REACH');
      else if (p.leagueDelta <= -value) flags.push('LEAGUE_VALUE');
    }
    if (p.adpDelta != null) {
      if (p.adpDelta >= mkV) flags.push('MARKET_VALUE');
      else if (p.adpDelta <= -mkR) flags.push('MARKET_REACH');
    }
    if (p.disagreement != null && p.disagreement >= vol) flags.push('VOLATILE');
    if (p.missingWeightPct > thin) flags.push('THIN_COVERAGE');
    p.flags = flags;
  }
}

/* --------------------------------------------------------- the draft model
 * Picks are recorded in order, so the snake tells us whose pick each one was
 * without any extra bookkeeping. That single fact drives the roster tracker,
 * the pick clock and the "gone by your next pick" list.
 */
const teams = () => state.data?.league?.teams || 10;
const rounds = () => state.data?.league?.rounds || 16;

function seatOfPick(index) {           // 0-based pick index -> seat 1..teams
  const n = teams();
  const round = Math.floor(index / n) + 1;
  const slot = (index % n) + 1;
  return round % 2 === 1 ? slot : n - slot + 1;
}
const roundOfPick = (index) => Math.floor(index / teams()) + 1;

/** Pick indices belonging to a seat, in order. */
function picksForSeat(seat) {
  const out = [];
  for (let i = 0; i < teams() * rounds(); i++) if (seatOfPick(i) === seat) out.push(i);
  return out;
}

/** Next pick index at or after `from` belonging to `seat`. */
function nextPickFor(seat, from) {
  for (let i = from; i < teams() * rounds(); i++) if (seatOfPick(i) === seat) return i;
  return null;
}

const seatName = (seat) => state.order[seat - 1] || `Seat ${seat}`;
const isMine = (id) => state.picks.find((p) => p.id === id)?.seat === state.seat;

/** Every pick, decorated with the seat that owns it and its round for that seat.
 *
 * The round is the pick's POSITION WITHIN ITS SEAT's picks, not the global
 * pick number. That is what makes recording out of order recoverable: fix the
 * seat on a pick and it lands in the right place on the board grid, regardless
 * of when you typed it in. */
function decoratedPicks() {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const seen = {};
  return state.picks.map((pick, i) => {
    const seat = pick.seat ?? null;
    const round = seat == null ? null : (seen[seat] = (seen[seat] || 0) + 1);
    return { ...byId.get(pick.id), id: pick.id, seat, round, order: i + 1 };
  }).filter((p) => p.player);
}

/** The roster for one seat, in the order that seat took them. */
function rosterForSeat(seat) {
  return decoratedPicks().filter((p) => p.seat === seat);
}

const myRoster = () => state.seat == null ? [] : rosterForSeat(state.seat);

/** grid[round][seat] -> pick, for the draft-board view. */
function boardGrid() {
  const grid = new Map();
  for (const p of decoratedPicks()) {
    if (p.seat == null || p.round == null) continue;
    grid.set(`${p.round}|${p.seat}`, p);
  }
  return grid;
}

function positionCounts(list) {
  const out = {};
  for (const p of list) if (p.pos) out[p.pos] = (out[p.pos] || 0) + 1;
  return out;
}

/** League-average roster composition after a given round. */
function paceAt(round) {
  const pace = state.data.tendencies?.rosterPace || [];
  if (!pace.length) return null;
  const r = Math.max(1, Math.min(round, pace.length));
  return pace[r - 1].avg;
}

/* --------------------------------------------------------- draft actions */
/** Record a pick for a seat. Defaults to whoever the snake says is on the clock. */
function draftPlayer(id, seat) {
  if (state.drafted.has(id)) return;
  state.picks.push({ id, seat: seat === undefined ? seatOnClock() : seat });
  syncDrafted();
  persist();
}

/** The seat the snake says should pick next, ignoring who has actually been
 *  assigned picks — it is a suggestion for the default, not the source of truth. */
const seatOnClock = () => seatOfPick(state.picks.length);

/** Move a recorded pick to a different seat. */
function reassignPick(id, seat) {
  const pick = state.picks.find((p) => p.id === id);
  if (!pick) return;
  pick.seat = seat;
  persist();
}

function undraftPlayer(id) {
  const at = state.picks.findIndex((p) => p.id === id);
  // Removing a pick from the middle shifts everything after it, which is the
  // correct repair for a mis-click: the draft really did have one fewer pick.
  if (at >= 0) state.picks.splice(at, 1);
  syncDrafted();
  persist();
}

function toggleDrafted(id, seat) {
  if (state.drafted.has(id)) undraftPlayer(id);
  else draftPlayer(id, seat);
}

function toggleWatch(id) {
  state.watch.has(id) ? state.watch.delete(id) : state.watch.add(id);
  persist();
}

function undo() {
  if (!state.picks.length) return false;
  state.picks.pop();
  syncDrafted();
  persist();
  return true;
}

function resetDraft() {
  state.picks = [];
  syncDrafted();
  persist();
}

/* Notes are free text you type yourself. Empty clears the note rather than
 * storing a blank, so "has a note" stays a meaningful test. */
function setNote(id, text) {
  const t = (text || '').trim();
  if (t) state.notes.set(id, t); else state.notes.delete(id);
  persist();
}
function getNote(id) { return state.notes.get(id) || ''; }

/* Swap the note button for an input in place. Enter or blur saves, Escape
 * abandons. Kept inline rather than a dialog because on draft night you are
 * typing between picks, not filling in a form. */
function editNote(anchor, id) {
  // On the board the note lives alone in a <td>; on a draft row it is a span
  // among siblings. Replace the cell in the first case, the span in the second.
  const inCell = anchor.tagName === 'BUTTON' && anchor.parentElement.tagName === 'TD';
  const host = inCell ? anchor.parentElement : anchor;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'noteinput';
  input.value = getNote(id);
  input.maxLength = 200;
  input.placeholder = 'note…';
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) setNote(id, input.value);
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // '/' focuses search otherwise
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  if (inCell) host.replaceChildren(input);
  else host.replaceWith(input);
  input.focus();
  input.select();
}

function syncDrafted() { state.drafted = new Set(state.picks.map((p) => p.id)); }

/* ------------------------------------------------------------ persistence */
/* Each draft gets its own storage namespace. A page declares one by setting
 * window.__CL_NAMESPACE before core.js loads (see dynasty.html). Pages that
 * declare none keep the original key, so saved redraft drafts survive.
 * This is what keeps the dynasty draft and the redraft draft from ever
 * seeing each other's picks. */
const NS = (typeof window !== 'undefined' && window.__CL_NAMESPACE) || null;
const KEY = NS ? `cl-draft-board:${NS}` : 'cl-draft-board';
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      picks: state.picks,
      watch: [...state.watch],
      order: state.order,
      seat: state.seat,
      weights: Object.fromEntries(state.sources.filter((s) => !s.dynamic)
        .map((s) => [s.id, s.weight])),
      notes: Object.fromEntries(state.notes),
      gridH: state.gridH,
    }));
  } catch (_) { /* private mode — the board still works, it just won't survive a reload */ }
}
function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Picks have been through two older shapes; keep saved drafts loadable.
    state.picks = (raw.picks || []).map((p) => {
      if (typeof p === 'string') return { id: p, seat: null };
      if ('seat' in p) return p;
      return { id: p.id, seat: p.mine ? (raw.seat ?? null) : null };
    });
    state.watch = new Set(raw.watch || []);
    state.notes = new Map(Object.entries(raw.notes || {}));
    if (typeof raw.gridH === 'number') state.gridH = raw.gridH;
    if (Array.isArray(raw.order) && raw.order.length) state.order = raw.order;
    if (raw.seat !== undefined && raw.seat !== null) state.seat = raw.seat;
    // Weights are shared across pages so every page ranks identically.
    for (const s of state.sources) {
      if (raw.weights && raw.weights[s.id] !== undefined) s.weight = raw.weights[s.id];
    }
    syncDrafted();
  } catch (_) { /* ignore corrupt state */ }
}

/* -------------------------------------------------------------------- nav */
function renderNav() {
  const here = location.pathname.split('/').pop() || 'index.html';
  /* The dynasty draft is a separate universe: its own pages, its own storage,
   * its own rankings. The only thing crossing the line is a plain link, and it
   * is labelled so you always know which draft you are looking at. */
  const pages = NS === 'dynasty'
    ? [['dynasty-board.html', 'Board'],
       ['dynasty.html', 'Draft'],
       ['index.html', '\u2190 Redraft']]
    : [['index.html', 'Board'],
       ['draft.html', 'Draft'],
       ['positional.html', 'Positional'],
       ['history.html', 'History'],
       ['dynasty-board.html', 'Dynasty \u2197']];
  const nav = el('nav');
  if (nav) {
    nav.innerHTML = pages.map(([href, label]) =>
      `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`).join('');
  }
  const lg = state.data.league || {};
  const title = el('leagueName');
  if (title) title.textContent = lg.name || 'Draft Board';
  const meta = el('leagueMeta');
  if (meta) {
    meta.textContent = `${lg.teams} teams · ${lg.rounds} rounds · ${lg.format} · ` +
      `built ${new Date(state.data.generatedAt).toLocaleString()}`;
  }
}
