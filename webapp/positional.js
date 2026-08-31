/* Positional Rankings page.
 *
 * ONE ranker at a time, never blended. This page deliberately ignores the
 * composite, the source weights and the anchor/blend machinery entirely — it
 * shows exactly what the selected person published, tiered their way where
 * they published tiers.
 *
 * It shares only the draft state: a player who has been taken disappears.
 */
'use strict';

let sourceId = null;

const boards = () => state.data.positional || {};

function buildPicker() {
  const ids = Object.keys(boards());
  el('sourcePick').innerHTML = ids
    .map((id) => `<option value="${esc(id)}">${esc(boards()[id].label)}</option>`).join('');
  // Remember the last ranker looked at, so a page reload doesn't reset it.
  let saved = null;
  try { saved = localStorage.getItem('cl-positional-source'); } catch (_) { /* no storage */ }
  sourceId = ids.includes(saved) ? saved : ids[0];
  el('sourcePick').value = sourceId;
  el('sourcePick').addEventListener('change', (e) => {
    sourceId = e.target.value;
    try { localStorage.setItem('cl-positional-source', sourceId); } catch (_) { /* no storage */ }
    render();
  });
}

function renderNote() {
  const b = boards()[sourceId];
  if (!b) { el('sourceNote').textContent = ''; return; }
  const own = b.tiersFrom === 'source';
  el('sourceNote').innerHTML =
    `<strong>${esc(b.label)}</strong> only — nothing here is blended with any other ranker. ` +
    (own
      ? 'Tiers are <strong>his own published tier breaks</strong>.'
      : 'This ranker publishes no positional tiers, so tiers are <strong>derived</strong> ' +
        'from gaps in his own overall ranks.') +
    ' Drafted players drop off the list.';
}

function renderColumns() {
  const b = boards()[sourceId];
  if (!b) { el('columns').innerHTML = '<p class="muted">No positional data.</p>'; return; }

  const clock = seatOnClock();
  const available = b.players.filter((p) => !state.drafted.has(p.id));
  el('leftCount').textContent = available.length;

  el('columns').innerHTML = POSITIONS.map((pos) => {
    const rows = available.filter((p) => p.pos === pos);
    if (!rows.length) {
      return `<section class="poscol${b.hasStatus ? ' tagged' : ''}">
        <div class="poshead"><span class="pos pos-${pos}">${pos}</span>
          <span class="muted">none left</span></div></section>`;
    }
    // Group into consecutive tier blocks, preserving the ranker's order.
    const blocks = [];
    for (const p of rows) {
      const last = blocks[blocks.length - 1];
      if (last && last.tier === p.tier) last.players.push(p);
      else blocks.push({ tier: p.tier, players: [p] });
    }

    return `<section class="poscol${b.hasStatus ? ' tagged' : ''}">
      <div class="poshead">
        <span class="pos pos-${pos}">${pos}</span>
        <span class="muted">${rows.length} left</span>
      </div>
      ${blocks.map((blk) => `
        <div class="tierblock" style="--tier-c:${tierColor(blk.tier)}">
          <div class="tierhead">Tier ${blk.tier ?? '—'}<span class="muted">${blk.players.length}</span></div>
          ${blk.players.map((p) => `
            <div class="posrow r-${pos}" data-id="${esc(p.id)}">
              <span class="posrank">${pos}${p.posRank}</span>
              <span class="posname">${esc(p.player)}</span>
              ${b.hasStatus ? statusTag(p.status) : ''}
              <span class="posteam">${esc(p.team || '')}</span>
              ${p.inPool
                ? `<button class="wltake" data-act="take" title="Assign to ${esc(seatName(clock))}">+</button>`
                : `<span class="notpool" title="This ranker lists him, but he is not on the main board">–</span>`}
            </div>`).join('')}
        </div>`).join('')}
    </section>`;
  }).join('');
}

/* A ranker's own conviction tag, shown only where that ranker published one.
 * Joel marks Target / I'll Pass / Avoiding; Faraz publishes nothing, so his
 * board carries no tags at all rather than a column of blanks. The text is
 * always rendered -- colour alone never carries the meaning. */
/* Four positional columns share the width, so a full-word chip costs the
 * player's name characters it cannot spare -- "Christian McCaffrey" was
 * truncating to "Christia...". Abbreviated here, with the full wording kept
 * on hover. Still a word rather than a bare colour, so the meaning survives
 * for anyone who cannot distinguish the hues. */
const STATUS_META = {
  'target':    ['st-target', 'TGT',   'Target'],
  "i'll pass": ['st-pass',   'PASS',  "I'll Pass"],
  'avoiding':  ['st-avoid',  'AVOID', 'Avoiding'],
};
function statusTag(status) {
  // An empty cell rather than no cell: on a tagged board every row must keep
  // the same column count or the names stop lining up.
  if (!status) return '<span class="stag"></span>';
  const [cls, short, full] =
    STATUS_META[String(status).trim().toLowerCase()] || ['st-other', String(status), String(status)];
  return `<span class="stag ${cls}" title="${esc(full)} — this ranker's own tag">${esc(short)}</span>`;
}

function render() {
  el('undoBtn').disabled = state.picks.length === 0;
  renderNote();
  renderColumns();
}

loadData().then((ok) => {
  if (!ok) return;
  buildPicker();

  el('columns').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act=take]');
    if (!btn) return;
    draftPlayer(btn.closest('[data-id]').dataset.id);
    render();
  });

  el('undoBtn').addEventListener('click', () => { undo(); render(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); render(); }
  });

  render();
});
