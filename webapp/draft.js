/* Draft page: record picks, track the board, track your team.
 *
 * Every pick stores the SEAT that made it. The draft-board grid places a pick
 * by (its seat, its position within that seat's picks), so recording in the
 * wrong order is always recoverable — fix the team on the pick and it moves to
 * the right cell. The snake only supplies the default seat.
 */
'use strict';

let bestFilter = 'ALL';
let query = '';

// How deep "Best available" runs. Roughly two rounds of a 10-team league, so
// what you can see covers the gap until your next pick.
const BEST_COUNT = 20;

/* ------------------------------------------------------------------ rows */
function seatOptions(selected) {
  return Array.from({ length: teams() }, (_, i) => {
    const seat = i + 1;
    return `<option value="${seat}"${seat === selected ? ' selected' : ''}>` +
           `${esc(seatName(seat))}</option>`;
  }).join('');
}

function playerRow(p) {
  const starred = state.watch.has(p.id);
  const clock = seatOnClock();
  const note = getNote(p.id);
  return `
    <div class="prow r-${p.pos || 'NA'}" data-id="${esc(p.id)}">
      <button class="star ${starred ? 'on' : ''}" data-act="watch"
              title="${starred ? 'Remove from watch list' : 'Add to watch list'}">★</button>
      <span class="badge" style="--tier-c:${tierColor(p.tier)}"
            title="Tier ${p.tier ?? '—'}">${p.tier ?? '—'}</span>
      <span class="pos pos-${p.pos}">${p.pos || ''}</span>
      <span class="pnamewrap"><span class="pname">${esc(p.player)}</span>${note ? `<span class="pnote" data-act="note" title="${esc(note)}">${esc(note)}</span>` : `<button class="noteadd" data-act="note" title="Add a note">+</button>`}</span>
      <span class="pmeta">${esc(p.team || '')}${p.bye ? ` · bye ${p.bye}` : ''} · #${p.compositeRank}
        ${p.adp == null ? '' : `· ADP ${trim(p.adp)}`}</span>
      <span class="pflags">${p.flags.slice(0, 2).map((f) =>
        `<span class="flag f-${f}" title="${esc(FLAG_HELP[f] || f)}">${FLAG_LABEL[f]}</span>`).join('')}</span>
      <button class="btn take ${clock === state.seat ? 'mine' : ''}" data-act="take"
              title="Assign to ${esc(seatName(clock))}">${esc(seatName(clock))}</button>
      <select class="seatpick" data-act="takeseat" title="Assign to someone else">
        <option value="">to…</option>${seatOptions(null)}
      </select>
    </div>`;
}

/* ------------------------------------------------------------------ clock */
function renderClock() {
  const n = state.picks.length;
  const done = n >= teams() * rounds();
  const clock = seatOnClock();

  el('curPick').textContent = done ? '—' : n + 1;
  el('curRound').textContent = done ? 'done' : roundOfPick(n);
  el('myCount').textContent = myRoster().length;
  el('assignTo').textContent = done ? '—' : seatName(clock);

  if (done) {
    el('onClock').textContent = 'complete';
    el('nextPick').textContent = '—';
    el('untilYou').textContent = '—';
    return { next: null, until: null };
  }

  const yours = state.seat === clock;
  el('onClock').textContent = seatName(clock);
  el('onClock').classList.toggle('you', yours);

  if (state.seat == null) {
    el('nextPick').textContent = '—';
    el('untilYou').textContent = '—';
    return { next: null, until: null };
  }
  const next = nextPickFor(state.seat, n);
  if (next == null) {
    el('nextPick').textContent = '—';
    el('untilYou').textContent = '—';
    return { next: null, until: null };
  }
  const until = next - n;
  el('nextPick').textContent = next + 1;
  el('untilYou').textContent = until === 0 ? 'NOW' : until;
  el('untilYou').classList.toggle('you', until === 0);
  return { next, until };
}

/* ------------------------------------------------------------ board grid */
function renderGrid() {
  const grid = boardGrid();
  const n = teams();
  const clockSeat = seatOnClock();
  const clockRound = roundOfPick(state.picks.length);

  const head = `<thead><tr><th class="rnd"></th>${
    Array.from({ length: n }, (_, i) => {
      const seat = i + 1;
      return `<th class="${seat === state.seat ? 'youcol' : ''}">
        <span class="seatno">${seat}</span>${esc(seatName(seat))}</th>`;
    }).join('')}</tr></thead>`;

  const body = Array.from({ length: rounds() }, (_, r) => {
    const round = r + 1;
    // Odd rounds run left to right, even rounds reverse — the snake.
    const arrow = round % 2 === 1 ? '→' : '←';
    const cells = Array.from({ length: n }, (_, i) => {
      const seat = i + 1;
      const pick = grid.get(`${round}|${seat}`);
      const isNow = !pick && round === clockRound && seat === clockSeat;
      const cls = [
        pick ? `r-${pick.pos || 'NA'}` : 'empty',
        seat === state.seat ? 'youcol' : '',
        isNow ? 'onclock' : '',
      ].filter(Boolean).join(' ');
      const inner = pick
        ? `<span class="gpos pos-${pick.pos}">${pick.pos || ''}</span>
           <span class="gname">${esc(pick.player)}</span>`
        : (isNow ? '<span class="gnow">on the clock</span>' : '');
      return `<td class="${cls}"${pick ? ` data-id="${esc(pick.id)}"` : ''}>${inner}</td>`;
    }).join('');
    return `<tr><th class="rnd">${round}<span class="arrow">${arrow}</span></th>${cells}</tr>`;
  }).join('');

  el('boardGrid').innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ---------------------------------------------------------------- search */
function matches() {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return state.players
    .filter((p) => !state.drafted.has(p.id))
    .filter((p) => p.player.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q))
    .sort((a, b) => a.compositeRank - b.compositeRank)
    .slice(0, 8);
}

function renderResults() {
  const rows = matches();
  el('results').innerHTML = query.trim()
    ? (rows.length ? rows.map(playerRow).join('')
                   : '<p class="muted">No available player matches that.</p>')
    : '';
}

function renderBest() {
  let avail = state.players.filter((p) => !state.drafted.has(p.id));
  if (bestFilter === 'WATCH') avail = avail.filter((p) => state.watch.has(p.id));
  else avail = avail.filter((p) => matchesPosFilter(p, bestFilter));
  const rows = avail.sort((a, b) => a.compositeRank - b.compositeRank).slice(0, BEST_COUNT);
  el('best').innerHTML = rows.length ? rows.map(playerRow).join('')
    : `<p class="muted">${bestFilter === 'WATCH'
        ? 'No one on your watch list. Click ★ on any player to add them.'
        : 'Nobody left.'}</p>`;
}

/* ------------------------------------------------------------ watch list */
/* Lives in the 340px sidebar, so it cannot carry the full-width Mine / to…
 * controls the main lists use. One narrow button assigns to whoever is on the
 * clock, which is the only action worth the space here; anything more
 * deliberate is a keystroke away in Record a pick. */
function watchRow(p) {
  const clock = seatOnClock();
  return `
    <div class="wlrow r-${p.pos || 'NA'}" data-id="${esc(p.id)}">
      <button class="star on" data-act="watch" title="Remove from watch list">★</button>
      <span class="badge" style="--tier-c:${tierColor(p.tier)}" title="Tier ${p.tier ?? '—'}">${p.tier ?? '—'}</span>
      <span class="pos pos-${p.pos}">${p.pos || ''}</span>
      <span class="wlname">${esc(p.player)}</span>
      <span class="wlrank">#${p.compositeRank}</span>
      <button class="wltake" data-act="take"
              title="Assign to ${esc(seatName(clock))}">+</button>
    </div>`;
}

function goneWatchRow(p) {
  const seat = state.picks.find((x) => x.id === p.id)?.seat;
  const mine = seat === state.seat;
  return `
    <div class="wlrow gone r-${p.pos || 'NA'}" data-id="${esc(p.id)}">
      <button class="star on" data-act="watch" title="Remove from watch list">★</button>
      <span class="badge" style="--tier-c:${tierColor(p.tier)}">${p.tier ?? '—'}</span>
      <span class="pos pos-${p.pos}">${p.pos || ''}</span>
      <span class="wlname">${esc(p.player)}</span>
      <span class="tookby ${mine ? 'mine' : ''}">${
        seat == null ? 'gone' : (mine ? 'YOURS' : esc(seatName(seat)))}</span>
    </div>`;
}

function renderWatch() {
  const watched = state.players.filter((p) => state.watch.has(p.id));
  const open = watched.filter((p) => !state.drafted.has(p.id))
    .sort((a, b) => a.compositeRank - b.compositeRank);
  const gone = watched.filter((p) => state.drafted.has(p.id))
    .sort((a, b) => a.compositeRank - b.compositeRank);

  el('watchMeta').textContent = watched.length
    ? `${open.length} open${gone.length ? ` · ${gone.length} gone` : ''}`
    : '';

  if (!watched.length) {
    el('watch').innerHTML =
      '<p class="muted">Nobody starred yet. Click ★ on any player to add them.</p>';
    return;
  }
  // Gone players stay listed rather than vanishing: knowing a target is off the
  // table is the point of having kept a list.
  el('watch').innerHTML = open.map(watchRow).join('') + gone.map(goneWatchRow).join('');
}

/* ---------------------------------------------------------------- roster */
function renderRoster() {
  const mine = myRoster();
  el('myMeta').textContent = `${mine.length} of ${rounds()}`;
  if (!mine.length) {
    el('roster').innerHTML =
      '<p class="muted">No picks yet. Search above, then assign one to yourself.</p>';
    return mine;
  }
  // Grouped by position so holes are visible at a glance, which is the whole
  // point of the panel during a superflex draft.
  const byPos = {};
  for (const p of mine) (byPos[p.pos] = byPos[p.pos] || []).push(p);

  el('roster').innerHTML = POSITIONS.concat(
    Object.keys(byPos).filter((k) => !POSITIONS.includes(k)))
    .filter((pos) => byPos[pos])
    .map((pos) => `
      <div class="rgroup">
        <div class="rgh"><span class="pos pos-${pos}">${pos}</span>
          <span class="muted">${byPos[pos].length}</span></div>
        ${byPos[pos].map((p) => `
          <div class="rrow">
            <span class="rpick">R${p.round}</span>
            <span class="badge" style="--tier-c:${tierColor(p.tier)}">${p.tier ?? '—'}</span>
            <span class="rname">${esc(p.player)}</span>
            <span class="rteam">${esc(p.team || '')}</span>
          </div>`).join('')}
      </div>`).join('');
  return mine;
}

/* ----------------------------------------------------------------- needs */
function renderNeeds(mine) {
  if (!el('needs')) return;   // panel omitted (dynasty page has no history)
  const round = Math.max(1, Math.min(rounds(), roundOfPick(state.picks.length)));
  const pace = paceAt(round);
  if (!pace) { el('needs').innerHTML = '<p class="muted">No history loaded.</p>'; return; }
  const have = positionCounts(mine);
  const full = paceAt(rounds());
  el('needs').innerHTML = POSITIONS.map((pos) => {
    const mineN = have[pos] || 0;
    const typical = pace[pos] ?? 0;
    const gap = mineN - typical;
    const denom = full[pos] || 1;
    const status = gap <= -1 ? 'behind' : gap >= 1 ? 'ahead' : 'ok';
    return `
      <div class="need ${status}">
        <div class="need-top">
          <span class="pos pos-${pos}">${pos}</span>
          <span class="need-n"><strong>${mineN}</strong><span class="muted"> vs ${typical} typical</span></span>
          <span class="need-tag">${status === 'behind' ? 'behind' : status === 'ahead' ? 'ahead' : 'on pace'}</span>
        </div>
        <div class="meter">
          <div class="meter-fill" style="width:${Math.min(100, (mineN / denom) * 100)}%"></div>
          <div class="meter-mark" style="left:${Math.min(100, (typical / denom) * 100)}%"></div>
        </div>
      </div>`;
  }).join('') + `<p class="hint" style="margin:6px 0 0">Through round ${round}. Bar is you, notch is the league.</p>`;
}

/* ------------------------------------------------- gone before next pick */
function renderGone(clock) {
  if (!el('gone')) return;    // panel omitted (dynasty page has no market ADP)
  if (clock.next == null) {
    el('gone').innerHTML = '<p class="muted">Set which seat is yours to see this.</p>';
    el('goneHint').textContent = '';
    return;
  }
  const nextPickNumber = clock.next + 1;
  // ADP rank is a pick number in a pure-market draft, so the comparison is direct.
  const risky = state.players
    .filter((p) => !state.drafted.has(p.id) && p.adp != null && p.adp < nextPickNumber)
    .sort((a, b) => a.compositeRank - b.compositeRank)
    .slice(0, 10);
  el('goneHint').textContent =
    `${clock.until} pick${clock.until === 1 ? '' : 's'} until you're up (pick ${nextPickNumber}).`;
  el('gone').innerHTML = risky.length ? risky.map((p) => `
    <div class="grow">
      <span class="badge" style="--tier-c:${tierColor(p.tier)}">${p.tier ?? '—'}</span>
      <span class="pos pos-${p.pos}">${p.pos}</span>
      <span class="gname">${esc(p.player)}</span>
      <span class="gadp">ADP ${trim(p.adp)}</span>
    </div>`).join('')
    : '<p class="muted">Nobody available is priced to go before your next pick.</p>';
}

/* -------------------------------------------------------------- scarcity */
function renderScarcity() {
  const avail = state.players.filter((p) => !state.drafted.has(p.id));
  el('scarcity').innerHTML = POSITIONS.map((pos) => {
    const inPos = avail.filter((p) => p.pos === pos);
    const byTier = new Map();
    for (const p of inPos) {
      if (p.tier == null) continue;
      byTier.set(p.tier, (byTier.get(p.tier) || 0) + 1);
    }
    const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]).slice(0, 3);
    if (!tiers.length) return '';
    return `
      <div class="scol">
        <div class="stitle"><span class="pos pos-${pos}">${pos}</span>
          <span class="muted">${inPos.length} left</span></div>
        ${tiers.map(([t, n]) => `
          <div class="srow ${n <= 2 ? 'thin' : ''}">
            <span class="badge" style="--tier-c:${tierColor(t)}">${t}</span>
            <span class="sbar"><i style="width:${Math.min(100, n * 12)}%"></i></span>
            <span class="scount">${n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');
}

/* ------------------------------------------------------------------- log */
function renderLog() {
  const recent = decoratedPicks().slice(-14).reverse();
  el('log').innerHTML = recent.length ? recent.map((p) => `
    <div class="lrow ${p.seat === state.seat ? 'mine' : ''}" data-id="${esc(p.id)}">
      <span class="pnum">${p.order}</span>
      <span class="lname">${esc(p.player)}</span>
      <span class="pos pos-${p.pos}">${p.pos}</span>
      <select class="seatpick" data-act="reassign">${seatOptions(p.seat)}</select>
      <button class="undox" data-act="undraft" title="Put back on the board">×</button>
    </div>`).join('') : '<p class="muted">No picks recorded yet.</p>';
}

/* ------------------------------------------------------------ order edit */
function renderOrderEditor() {
  el('orderRows').innerHTML = Array.from({ length: teams() }, (_, i) => `
    <label class="orow">
      <span class="oseat">${i + 1}</span>
      <input type="text" data-seat="${i + 1}" value="${esc(state.order[i] || '')}">
    </label>`).join('');
}

/* ---------------------------------------------------------------- render */
function render() {
  el('undoBtn').disabled = state.picks.length === 0;
  const clock = renderClock();
  const mine = renderRoster();
  renderGrid();
  renderResults();
  renderWatch();
  renderBest();
  renderNeeds(mine);
  renderGone(clock);
  renderScarcity();
  renderLog();
}

/* ---------------------------------------------------------------- events */
function buildSeatSelect() {
  el('seatSelect').innerHTML = seatOptions(state.seat);
  el('seatSelect').value = state.seat ?? '';
  el('seatSelect').addEventListener('change', (e) => {
    state.seat = e.target.value ? +e.target.value : null;
    persist(); render();
  });
}

function wirePlayerRows(container) {
  container.addEventListener('click', (e) => {
    // The note affordance is a span, not a button, so it is matched first.
    const noteEl = e.target.closest('[data-act=note]');
    if (noteEl) {
      editNote(noteEl, noteEl.closest('[data-id]').dataset.id);
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    if (btn.dataset.act === 'watch') toggleWatch(id);
    else if (btn.dataset.act === 'take') { draftPlayer(id); clearSearch(); }
    render();
  });
  container.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-act=takeseat]');
    if (!sel || !sel.value) return;
    draftPlayer(sel.closest('[data-id]').dataset.id, +sel.value);
    clearSearch();
    render();
  });
}

function clearSearch() { query = ''; el('search').value = ''; }

loadData().then((ok) => {
  if (!ok) return;
  buildSeatSelect();
  wirePlayerRows(el('results'));
  wirePlayerRows(el('watch'));
  wirePlayerRows(el('best'));

  // Reassign or remove a recorded pick.
  el('log').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-act=reassign]');
    if (!sel) return;
    reassignPick(sel.closest('.lrow').dataset.id, +sel.value);
    render();
  });
  el('log').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act=undraft]');
    if (!btn) return;
    undraftPlayer(btn.closest('.lrow').dataset.id);
    render();
  });

  // Clicking a filled grid cell offers the same two fixes.
  el('boardGrid').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-id]');
    if (!td) return;
    const id = td.dataset.id;
    const p = state.players.find((x) => x.id === id);
    const seat = prompt(
      `${p ? p.player : id}\n\nMove to which seat? 1–${teams()}\n` +
      state.order.map((nm, i) => `${i + 1} = ${nm}`).join('\n') +
      `\n\nLeave blank and press OK to REMOVE this pick.`,
      String(state.picks.find((x) => x.id === id)?.seat ?? ''));
    if (seat === null) return;                    // cancelled
    if (seat.trim() === '') undraftPlayer(id);
    else {
      const n = +seat;
      if (n >= 1 && n <= teams()) reassignPick(id, n);
    }
    render();
  });

  el('search').addEventListener('input', (e) => { query = e.target.value; renderResults(); });
  el('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const top = matches()[0];
    if (top) { draftPlayer(top.id); clearSearch(); render(); }
  });

  el('bestPos').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    bestFilter = b.dataset.pos;
    el('bestPos').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderBest();
  });

  el('editOrderBtn').addEventListener('click', () => {
    const box = el('orderEditor');
    box.hidden = !box.hidden;
    if (!box.hidden) renderOrderEditor();
  });
  el('orderRows').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-seat]');
    if (!input) return;
    state.order[+input.dataset.seat - 1] = input.value;
    persist();
  });
  el('orderSave').addEventListener('click', () => {
    el('orderEditor').hidden = true;
    buildSeatSelect();
    render();
  });
  el('orderReset').addEventListener('click', () => {
    state.order = [...(state.data.league?.draftOrder || [])];
    persist(); renderOrderEditor(); buildSeatSelect(); render();
  });

  el('undoBtn').addEventListener('click', () => { undo(); render(); });
  el('resetBtn').addEventListener('click', () => {
    if (confirm('Clear the whole draft and start over?')) { resetDraft(); render(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== el('search')) {
      e.preventDefault(); el('search').focus();
    } else if (e.key === 'Escape') { el('search').blur(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); render(); }
  });

  render();
});
