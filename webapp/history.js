/* History page: the three years of league data, stated as conclusions first.
 *
 * The numbers were always here; what was missing was saying what they mean.
 * Every takeaway below is generated from the data, not hand-written, so it
 * stays true when the history or the rankings change.
 */
'use strict';

let curvePos = 'QB';
const POS_NAME = { QB: 'Quarterbacks', RB: 'Running backs', WR: 'Receivers', TE: 'Tight ends' };

/** Rounds of the draft a takeaway is allowed to talk about.
 *  Beyond this the slots are deep-bench noise: "QB21-QB28 falls to you" is
 *  technically true and completely useless in a 10-team league. */
const RELEVANT_ROUNDS = 10;

/** EARLIEST run of consecutive positional slots whose delta clears a threshold.
 *  Earliest, not longest — the actionable band is the one you hit first, and
 *  the longest run is almost always the flat tail at the end of the draft. */
function earliestBand(pos, predicate) {
  const limit = teams() * RELEVANT_ROUNDS;
  const rows = (state.data.tendencies?.curve || [])
    .filter((r) => r.pos === pos && r.league_pick <= limit)
    .sort((a, b) => a.pos_slot - b.pos_slot);
  let run = [];
  for (const r of rows) {
    if (predicate(r)) {
      run.push(r);
    } else {
      if (run.length >= 3) break;
      run = [];
    }
  }
  if (run.length < 3) return null;
  const avg = run.reduce((a, r) => a + r.delta, 0) / run.length;
  return { from: run[0].pos_slot, to: run[run.length - 1].pos_slot,
           length: run.length, avg: Math.round(Math.abs(avg)) };
}

/** "a", "a and b", "a, b and c" */
function listNames(names) {
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function takeaways() {
  const out = [];
  const sum = state.data.tendencies?.summary || {};

  for (const pos of POSITIONS) {
    if (!sum[pos]) continue;
    const falls = earliestBand(pos, (r) => r.delta <= -8);
    const reach = earliestBand(pos, (r) => r.delta >= 8);
    // Whichever pattern starts earlier is the one you act on first.
    const pick = !falls ? reach : !reach ? falls
      : (falls.from <= reach.from ? falls : reach);
    if (!pick) continue;
    const isFall = pick === falls;
    out.push({
      kind: isFall ? 'good' : 'bad',
      pos,
      headline: isFall ? `Wait on ${pos}` : `Move early on ${pos}`,
      body: isFall
        ? `${POS_NAME[pos]} ranked <strong>${pos}${pick.from}–${pos}${pick.to}</strong> go about ` +
          `<strong>${pick.avg} picks later</strong> here than the market expects. ` +
          `That whole band comes back to you — don't pay market price for it.`
        : `${POS_NAME[pos]} ranked <strong>${pos}${pick.from}–${pos}${pick.to}</strong> come off ` +
          `<strong>${pick.avg} picks earlier</strong> here than the market expects. ` +
          `If you want one in that range, you have to take him before the value says to.`,
    });
  }

  // Who takes quarterbacks first — the sharpest read in a superflex league.
  const owners = (state.data.tendencies?.owners || []).filter((o) => o.first_qb_round != null);
  if (owners.length >= 2) {
    const sorted = [...owners].sort((a, b) => a.first_qb_round - b.first_qb_round);
    const early = sorted.filter((o) => o.first_qb_round <= sorted[0].first_qb_round + 0.5);
    const late = sorted[sorted.length - 1];
    out.push({
      kind: 'info', pos: 'QB', headline: 'Know who is chasing you',
      body: `${listNames(early.map((o) => `<strong>${esc(o.owner)}</strong>`))} ` +
            `take a quarterback by round ${early[early.length - 1].first_qb_round} on average. ` +
            `<strong>${esc(late.owner)}</strong> waits until round ${late.first_qb_round}. ` +
            `If an early-QB manager picks just before you, expect the QB you want to be gone.`,
    });
  }

  // When defenses start, since no ranking source covers them.
  const mix = state.data.tendencies?.roundMix || [];
  const withDst = mix.filter((m) => (m.counts.DST || 0) > 0);
  const totalDst = withDst.reduce((a, m) => a + m.counts.DST, 0);
  if (withDst.length && totalDst) {
    const firstEver = withDst[0].round;
    // Where the bulk actually lands, as a share of all defenses taken.
    const heavy = mix.filter((m) => (m.pct.DST || 0) >= 25).map((m) => m.round);
    const heavyShare = Math.round(
      mix.filter((m) => heavy.includes(m.round))
         .reduce((a, m) => a + m.counts.DST, 0) / totalDst * 100);
    out.push({
      kind: 'info', pos: 'DST', headline: `Defenses are a round-${heavy[0] ?? firstEver} problem`,
      body: heavy.length
        ? `The earliest defense ever taken here went in round ${firstEver}, but ` +
          `<strong>${heavyShare}%</strong> of all defenses come off in ` +
          `round${heavy.length > 1 ? 's' : ''} ${listNames(heavy.map(String))}. ` +
          `No ranking source covers them, so that call is yours.`
        : `Defenses start going in round ${firstEver}. No ranking source covers them, ` +
          `so that call is yours.`,
    });
  }

  // Positional weight of the opening rounds.
  const early = mix.filter((m) => m.round <= 2);
  if (early.length === 2) {
    const qbPct = Math.round(early.reduce((a, m) => a + (m.pct.QB || 0), 0) / 2);
    out.push({
      kind: 'info', pos: 'QB', headline: 'The first two rounds are quarterback rounds',
      body: `<strong>${qbPct}%</strong> of every round 1–2 pick in this league is a quarterback. ` +
            `That is superflex working as intended — but it means the runs start immediately.`,
    });
  }
  return out;
}

function renderTakeaways() {
  el('takeaways').innerHTML = takeaways().map((t) => `
    <article class="take ${t.kind}">
      <div class="take-top">
        <span class="pos pos-${t.pos}">${t.pos}</span>
        <h3>${esc(t.headline)}</h3>
      </div>
      <p>${t.body}</p>
    </article>`).join('');
}

function renderMix() {
  const mix = state.data.tendencies?.roundMix || [];
  if (!mix.length) { el('mix').innerHTML = '<p class="muted">No data.</p>'; return; }
  const all = [...new Set(mix.flatMap((m) => Object.keys(m.counts)))];
  const order = [...POSITIONS, ...all.filter((p) => !POSITIONS.includes(p))];

  el('mix').innerHTML = `
    <div class="mixlegend">${order.map((p) =>
      `<span class="mkey"><i class="mswatch m-${p}"></i>${p}</span>`).join('')}</div>` +
    mix.map((m) => `
      <div class="mixrow">
        <span class="mround">R${m.round}</span>
        <span class="mstack">${order.map((p) => {
          const pct = m.pct[p] || 0;
          if (!pct) return '';
          // Only label a slice wide enough for the text to fit.
          return `<i class="m-${p}" style="width:${pct}%"
                    title="Round ${m.round} — ${p}: ${m.counts[p]} of ${m.total} picks (${pct}%)"
                  >${pct >= 14 ? Math.round(pct) + '%' : ''}</i>`;
        }).join('')}</span>
      </div>`).join('');
}

function renderQbRace() {
  const owners = (state.data.tendencies?.owners || []).filter((o) => o.first_qb_round != null);
  if (!owners.length) { el('qbrace').innerHTML = '<p class="muted">No data.</p>'; return; }
  const sorted = [...owners].sort((a, b) => a.first_qb_round - b.first_qb_round);
  const max = Math.max(...sorted.map((o) => o.first_qb_round));

  el('qbrace').innerHTML = sorted.map((o) => `
    <div class="qrow">
      <span class="qname">${esc(o.owner)}</span>
      <span class="qbar"><i style="width:${(o.first_qb_round / max) * 100}%"></i></span>
      <span class="qval">R${o.first_qb_round}</span>
      <span class="qsub muted">${o.by_pos.QB || 0} QBs total</span>
    </div>`).join('') +
    '<p class="hint" style="margin-top:8px">Earlier is higher. Managers at the top ' +
    'will take the quarterback you want before you do.</p>';
}

function renderCurvePicker() {
  el('curvePos').innerHTML = POSITIONS
    .map((p) => `<button data-pos="${p}" class="${p === curvePos ? 'on' : ''}">${p}</button>`)
    .join('');
  el('curvePos').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    curvePos = b.dataset.pos;
    el('curvePos').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderCurve();
  });
}

function renderCurve() {
  const rows = (state.data.tendencies?.curve || []).filter((r) => r.pos === curvePos);
  if (!rows.length) { el('curve').innerHTML = '<p class="muted">No data.</p>'; return; }
  const max = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);

  el('curve').innerHTML = `
    <div class="chead">
      <span>Slot</span><span>This league</span><span>Market</span>
      <span class="cmid">falls to you ◂ ▸ goes early</span><span>Diff</span>
    </div>` +
    rows.map((r) => {
      const w = (Math.abs(r.delta) / max) * 50;
      const falls = r.delta < 0;
      return `
        <div class="crow">
          <span class="cslot">${curvePos}${r.pos_slot}</span>
          <span class="cnum">${r.league_pick}</span>
          <span class="cnum muted">${r.market_pick}</span>
          <span class="cbar">
            <i class="${falls ? 'neg' : 'pos'}"
               style="${falls ? 'right:50%' : 'left:50%'};width:${w}%"></i>
            <b class="czero"></b>
          </span>
          <span class="cdelta ${falls ? 'delta-pos' : 'delta-neg'}">${r.delta > 0 ? '+' : ''}${r.delta}</span>
        </div>`;
    }).join('');
}

function renderOwners() {
  const owners = state.data.tendencies?.owners || [];
  if (!owners.length) return;
  const cols = ['QB', 'RB', 'WR', 'TE', 'DST'];
  el('ownersHead').innerHTML = '<th>Manager</th>' +
    cols.map((c) => `<th class="num">${c}</th>`).join('') +
    '<th class="num">1st QB</th><th class="num">1st RB</th>';
  el('ownersBody').innerHTML = [...owners]
    .sort((a, b) => (a.first_qb_round ?? 99) - (b.first_qb_round ?? 99))
    .map((o) => `
      <tr>
        <td class="name">${esc(o.owner)}</td>
        ${cols.map((c) => `<td class="num">${o.by_pos[c] || 0}</td>`).join('')}
        <td class="num strong">${o.first_qb_round ?? '—'}</td>
        <td class="num">${o.first_rb_round ?? '—'}</td>
      </tr>`).join('');
}

function renderPace() {
  const pace = state.data.tendencies?.rosterPace || [];
  if (!pace.length) return;
  const last = pace[pace.length - 1].avg;
  const cols = Object.keys(last).sort((a, b) => last[b] - last[a]);
  el('paceHead').innerHTML = '<th>After round</th>' +
    cols.map((c) => `<th class="num">${c}</th>`).join('');
  el('paceBody').innerHTML = pace.map((r) => `
    <tr><td class="num">${r.round}</td>
      ${cols.map((c) => `<td class="num">${(r.avg[c] ?? 0).toFixed(2)}</td>`).join('')}
    </tr>`).join('');
}

loadData().then((ok) => {
  if (!ok) return;
  const years = state.data.tendencies?.roundMix?.length ? '2023–2025' : '';
  el('histMeta').textContent =
    `${state.data.league.teams} teams · ${state.data.league.format} · ${years}`;
  renderTakeaways();
  renderMix();
  renderQbRace();
  renderCurvePicker();
  renderCurve();
  renderOwners();
  renderPace();
});
