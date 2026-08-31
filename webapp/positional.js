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
    ' Drafted players drop off the list.' + tagLegend(b);
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
              <span class="posname" title="${esc(p.player)}">${esc(p.player)}</span>
              ${b.hasStatus ? statusTag(p.tags) : ''}
              <span class="posteam">${esc(p.team || '')}</span>
              ${p.inPool
                ? `<button class="wltake" data-act="take" title="Assign to ${esc(seatName(clock))}">+</button>`
                : `<span class="notpool" title="This ranker lists him, but he is not on the main board">–</span>`}
            </div>`).join('')}
        </div>`).join('')}
    </section>`;
  }).join('');
}

/* --------------------------------------------------------- ranker tags
 * A ranker's own conviction markers, shown only where that ranker publishes
 * them. Joel marks one per player; Faraz marks up to four ("Target, High
 * Upside, Safe"), so both arrive as a list.
 *
 * Abbreviated because four positional columns share the width and full words
 * truncated "Christian McCaffrey" to "Christia...". At most two show, ordered
 * by how much they should change a pick, with any remainder behind a +N. The
 * full wording is on hover and spelled out in the legend above the board, so
 * colour never carries the meaning on its own. */
const TAG_META = {
  'avoid':       ['st-avoid',  'AVOID', 'Avoid'],
  'avoiding':    ['st-avoid',  'AVOID', 'Avoiding'],
  "i'll pass":   ['st-pass',   'PASS',  "I'll Pass"],
  'target':      ['st-target', 'TGT',   'Target'],
  'sleeper':     ['st-sleep',  'SLP',   'Sleeper'],
  'boom/bust':   ['st-boom',   'B/B',   'Boom / Bust'],
  'high upside': ['st-upside', 'UP',    'High Upside'],
  'safe':        ['st-safe',   'SAFE',  'Safe'],
};
/* Most decision-relevant first: what would actually change a pick. */
const TAG_ORDER = ['avoid', 'avoiding', "i'll pass", 'target', 'sleeper',
                   'boom/bust', 'high upside', 'safe'];
/* One visible chip. Two fitted Joel's board but not Faraz's: he tags 155
 * of 232 players and often with three at once, and at four columns the
 * second chip cost the player's name a quarter of its width. The rest
 * are on hover and in the legend. */
const TAG_SHOWN = 1;

const tagRank = (t) => {
  const i = TAG_ORDER.indexOf(String(t).trim().toLowerCase());
  return i === -1 ? TAG_ORDER.length : i;
};

function statusTag(tags) {
  // An empty cell rather than no cell: on a tagged board every row must keep
  // the same column count or the names stop lining up.
  const list = (tags || []).slice().sort((a, b) => tagRank(a) - tagRank(b));
  if (!list.length) return '<span class="stags"></span>';
  const full = list.map((t) => (TAG_META[String(t).toLowerCase()] || [0, 0, t])[2]).join('  \u00b7  ');
  const shown = list.slice(0, TAG_SHOWN).map((t) => {
    const meta = TAG_META[String(t).toLowerCase()] || ['st-other', String(t)];
    return `<span class="stag ${meta[0]}">${esc(meta[1])}</span>`;
  }).join('');
  const extra = list.length - TAG_SHOWN;
  return `<span class="stags" title="${esc(full)}">${shown}` +
         (extra > 0 ? `<span class="stag st-more">+${extra}</span>` : '') + '</span>';
}

/* Letters are only learnable if something spells them out. */
function tagLegend(board) {
  if (!board.hasStatus) return '';
  const seen = new Set();
  for (const p of board.players) for (const t of (p.tags || [])) seen.add(String(t).toLowerCase());
  const items = TAG_ORDER.filter((t) => seen.has(t)).map((t) => {
    const [cls, short, full] = TAG_META[t];
    return `<span class="legitem"><span class="stag ${cls}">${esc(short)}</span>${esc(full)}</span>`;
  }).join('');
  return items ? `<div class="taglegend">${items}</div>` : '';
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
