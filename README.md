# Champions League Draft Tool

Python pipeline + static draft board for a 10-team, 16-round, superflex half-PPR league.

## Draft night

```bash
python -m pipeline.build
```

Then open `webapp/index.html` — double-click it, no server needed.

### The four pages

| Page | What it's for |
|---|---|
| **Board** (`index.html`) | The full player table — the weighted composite. Sort, filter, star, mark drafted. |
| **Draft** (`draft.html`) | Where you work during the draft: record picks, track your team, read the room. |
| **Positional** (`positional.html`) | One ranker at a time, tiered by position. **Never blended.** |
| **History** (`history.html`) | What three years of your drafts say, stated as conclusions. |

### Positional Rankings

Deliberately separate from everything else. Pick a ranker from the dropdown and you get *their*
board, tiered their way, four positions side by side. No weights, no composite, no anchor/blend
— this page never combines two people's opinions.

Where tiers come from is stated on the page, because it differs by ranker:

| Ranker | Tiers |
|---|---|
| Joel Smyth | **His own published tier breaks**, read from the `Positional Rankings` sheet in his workbook |
| Faraz | **Derived** — he publishes no positional tiers, so breaks are cut from gaps in his own overall ranks |

Deriving matters here: a positional rank is 1, 2, 3, … so every gap is exactly 1 and no tier
structure exists to find. The dropoffs live in the *overall* rank, which is what gets measured.

Drafted players drop off the list immediately, and `+` assigns to whoever is on the clock. A
player a ranker lists but the main board doesn't carry shows a dash instead of `+` — Joel ranks
4 such players, deeper than the composite pool.

To give a source its own tier sheet, add `positional_sheet: "<sheet name>"` to it in
`config/sources.yml`. Without it, tiers are derived.

### Draft order

Set in `config/league.yml` under `draft_order`, seat 1 picking first:

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|
| Leor | Rutta | Josh | Aaron Lavi | Nitz | Jacob | **Me** | Liran | Jordy | Mikey |

*Edit order* on the Draft page changes it live if the order shifts on the night; the page
remembers your edits and *Reset to config* puts these back.

### Recording picks

Search a name, then press the big button — it is labelled with **whoever is on the clock**, so
the fast path is one click. To give him to someone else instead, use the `to…` dropdown on the
same row. `Enter` assigns to the team on the clock; `/` focuses search; `Ctrl+Z` undoes.

On the **Board** page, clicking a row assigns to whoever is on the clock, and shift-click
assigns to you.

**Got the order wrong?** Every pick stores the seat that made it, and the draft board places a
pick by *(its team, its position in that team's picks)* — not by when you typed it. So fixing a
mistake is just reassigning the team: use the dropdown in *Recent picks*, or click the pick in
the draft board grid. It moves to the right cell and every roster, need and count follows.

### The draft board

A live grid: 10 columns (your managers, named) × 16 rounds, snake arrows down the side, cells
coloured by position, your column highlighted, and the current pick outlined. It is the same
shape as the grid in your history workbook.

### Watch list

★ any player — on the Board, in *Best available*, or in the watch list itself — and they appear
in the **Watch list** panel in the Draft page sidebar, directly above *Needs*, sorted by
composite rank.

It uses a compact row (★, tier, position, name, rank, and a `+` button) because the 340px
sidebar cannot fit the full-width Mine / *to…* controls the main lists use. `+` assigns to
whoever is on the clock — the one action worth that space. Anything more deliberate is a
keystroke away in *Record a pick*.

Players on the list who get taken **stay listed**, struck through, with the team that took them
where the buttons were (or **YOURS** if you got him). Knowing a target is off the table is the
point of having kept a list; silently removing him would just leave you wondering.

*Best available* shows the next **20** players — about two rounds in a 10-team league, so it
covers the gap to your next pick.

All four pages share one draft state, so marking a player drafted anywhere updates everything,
and weight changes apply across pages.

The build writes `webapp/data.js` alongside `out/board.json` precisely so the pages work over
`file://`, because browsers block `fetch()` there and you do not want to be debugging a web
server while you are on the clock.

## Moving it to another computer

The web app is **fully static** — Python builds the data, it does not run the app. Everything
the browser needs is in `webapp/` (11 files, no internet, no install).

`python -m pipeline.build` writes two ready-to-move zips into `out/`:

| File | Contains | Use when |
|---|---|---|
| `draft-board-app.zip` | just `webapp/` (~61 KB) | you only want to *use* it on draft night |
| `champions-league-full.zip` | the whole project (~520 KB) | you also want to *update rankings* there |

Move it however you like — OneDrive, email to yourself, USB. Unzip, open `index.html`.
Verified by extracting the zip and running it: the full player pool, every source, and a pick
made on the Board correctly carried over to the Draft page.

To also rebuild rankings on the other machine you need Python 3 plus
`pip install pandas openpyxl PyYAML`.

### If the red storage warning appears

The pages hand the draft to each other through the browser's local storage. Chrome and
Edge allow this for local files; if yours doesn't, the app now says so in a red bar rather than
losing your picks silently. The fix is to serve the folder instead of double-clicking it:

```bash
python -m http.server 8777
```

then open `http://localhost:8777/webapp/index.html`.

## Updating rankings

1. Drop the new CSV/XLSX into `data/sources/`.
2. Re-run `python -m pipeline.build`.

Each source claims the **newest** file matching its glob in `config/sources.yml`, so a new
Faraz export supersedes the old one automatically. Don't delete the old file, don't rename
anything, don't edit config — the build names the superseded file in its warnings so you can
see which one it actually used.

A file no source claims gets auto-registered in `config/sources.yml` at weight `0.0`, with
its detected columns filled in. Set the weight, re-run, done.

Mid-draft you can also swap a source from the board itself — *Add / replace a source* in the
sidebar takes a CSV, asks which existing source to overwrite, and re-ranks immediately. That
is session-only; the drop zone is the permanent path.

## Weights

Set in `config/sources.yml` (relative — `60`/`40` and `0.6`/`0.4` are identical). The board's
sliders override them live and re-rank, re-tier, and re-flag on the spot. Current defaults:

| Source | Weight | Scope | Role |
|---|---|---|---|
| Faraz (Upper Hand) | 0.50 | overall | sets cross-position value |
| Joel Smyth (half PPR) | 0.50 | **positional** | order within a position only |
| Sleeper ADP | **0.00** | — | market reference only |

**ADP has no say in the rankings.** It is kept loaded at weight 0 because it is not just
another opinion — it is the market, and it is the yardstick for `vs ADP`, the `MKT` flags,
*gone before your next pick*, and the entire league-vs-market analysis on the History page.
Deleting the file would silently gut all of that. Its column stays on the board, dimmed.

## How the numbers work

**Composite** — weighted mean of `log(rank)`, i.e. a weighted geometric mean. Rank distance
isn't linear: 1 → 6 is a chasm, 140 → 145 is noise. Log space respects that; a plain average
doesn't. When a source omits a player entirely that omission is information, so the player is
scored on the sources that do rank them and then pushed down in proportion to the weight that
declined to (`missing_penalty`, default 0.35).

**Disagreement** — weighted spread of log rank across sources. Drives the `VOL` flag.

**Tiers** — per position, a break is cut where the gap to the next player is large relative to
a *rolling* median + MAD of nearby gaps. The window matters: composite score is log-rank, so
gaps compress steadily as rank grows, and a single global threshold cuts freely at the top and
never at the bottom.

**League tendencies** — there is no historical ADP for 2023–2025, so nothing is compared against
a market baseline that doesn't exist. Instead, for each year and position, picks are sorted by
overall pick number and indexed (QB1, QB2, … QBn), which yields "in this league QB7 goes around
pick 48." The market curve is built the same way from current ADP over the top 160 players —
the number this league actually drafts — so both curves sit on the same pick axis.

    delta = market_pick - league_pick
    delta < 0  this league lets the slot fall   -> LG+  (you can wait)
    delta > 0  this league takes the slot early -> LG-  (you must move up)

## Sources in the wrong format

A ranking built for a different format is not useless, it is wrong about exactly one thing. A
1QB half-PPR list in a superflex league has Josh Allen far too low, because it is answering
"how valuable is a QB next to a RB" for a league you are not in. Its answer to "which RB is
better" is still worth having.

So each source has a `scope`:

| scope | meaning |
|---|---|
| `overall` | ranks across positions; sets cross-position value |
| `positional` | trusted only for order **within** a position |

With a positional source in play the composite runs two passes: an **anchor** over the
format-correct sources only, which fixes what an overall rank is worth at QB1, RB1 and so on;
and a **blend** over every source, which decides who deserves each of those slots. Then, inside
each position, the anchor's own scores are handed out in blend order.

The result is one board, not two. Cross-position value stays superflex-correct, while the extra
opinion still moves players up and down their own position. Tested with a half-PPR source
weighted at 50% that ranked Josh Allen 191st: he still came out **QB1, 3rd overall**, while the
RB order shifted to follow the new list.

**Joel Smyth's list is wired up this way.** It is half PPR, 1QB: he has Josh Allen as his 26th
player where Faraz has him 3rd. Scoped positional at 50%, Josh Allen still comes out QB1 and
3rd overall, while Joel's opinion reorders the RB/WR/TE boards — he is much higher on Omarion
Hampton, Bucky Irving and Rico Dowdle than Faraz is. All 150 of his names matched the pool
exactly, with no position disagreements.

His list stops at 150 players, so the 75 players Faraz ranks and he does not slip slightly
inside their position — at most 7 slots, all at RB46+/WR50+. Nothing above round 11 moves.

To add another: drop the file in `data/sources/` and copy the `joel` block in
`config/sources.yml`.

## Source columns

Every source gets its own column on the board, generated from the source list — add a source
and a column appears, no code change. Columns show the source's **own number** (ADP `4.5`, not
"rank 4"), are sortable, and stay visible at weight 0 so you can always see where a source has
someone even when it isn't counting toward the composite. Set the header text with `short:` in
`config/sources.yml`.

## Flags

| Badge | Meaning |
|---|---|
| `LG+` / `LG−` | This league lets the positional slot fall / takes it early |
| `MKT+` / `MKT−` | Cheaper / more expensive by ADP than the composite ranks them |
| `VOL` | Sources disagree sharply **about where he sits among his own position** |
| `THIN` | Essentially no weighted source ranks him |

Thresholds live in `config/league.yml` under `flags`. Two of them matter:

**`volatile`** is measured on rank *within position*, not overall rank. Measured on overall
rank, every quarterback lights up the moment a 1QB list joins — Allen 3rd vs 26th — and the
flag becomes noise. Within position that format gap cancels and what is left is a real
argument, e.g. Omarion Hampton, whom Joel has 28 spots higher among RBs than Faraz does.

**`thin_coverage`** is set above 50 on purpose. With two sources at 50/50, "one of them omits
him" lands at exactly 50 and would flag ~90 players. The per-source columns already show a
blank where a source has no opinion.

## Row colours

Every row is tinted by position — QB pink, RB green, WR blue, TE amber — on the Board, the
Draft page and the draft-board grid. The Pos column still spells it out, so position is never carried by colour
alone. Colours are defined once as `--c-QB`/`--c-RB`/… in `styles.css`, with deeper hues in the
light theme because the dark-theme values wash out on white. `--tint` controls the strength.

Drafted players fade and strike through. **Your** picks are also struck through — they are
taken, after all — but stay at full colour, go bold, and gain a blue edge down the left, so the
three states stay distinct on top of the tint.

## Board controls

`/` focus search · `Enter` drafts the top available hit · `Ctrl+Z` undo · click a row to
toggle drafted · shift-click to draft as yours · ★ to watch. Drafted players stay visible by
default (struck through, yours highlighted); untick *show drafted* to hide them. All state
survives a reload via localStorage.

## Needs, without inventing lineup rules

The Draft page grades your roster against **what a typical team in this league actually has
by that round**, averaged over the three drafts — by round 8 that's 1.93 QB, 2.33 RB, 3.27 WR,
0.47 TE. That needs no assumption about your starter slots to be useful, and it stays correct
if your lineup rules change. `python -m pipeline.build` recomputes it from the history.

## Known gaps

- **No DST in any ranking source.** This league drafts 7–9 defenses a year; 83% of them come
  off in rounds 15–16. Those rounds are not on the board — the History page says so rather
  than a banner nagging you every time you open it.
- **2023 draft history is partly hand-resolved.** 41 of its 160 entries are last-name-only or
  nicknames. These are mapped in `config/aliases.yml` by hand, not by similarity scoring —
  fuzzy matching on them produces confident wrong answers (`Washington (DEF)` → Parker
  Washington, `Pierce (RB)` → Alec Pierce). Corrections go in that file.
- **Christian Watson appears twice in the 2023 draft** (rounds 4 and 7, different managers).
  That is an error in the source record, not a parsing artifact. Reported in diagnostics.
- **`Champions Leage Fantasy Football Ranking 2025.xlsx` is reference only.** Its rankings are
  stale and the pipeline never reads them. Only its sheet layout informed the design.

## Layout

```
config/     sources.yml · league.yml · aliases.yml
data/sources/   <- DROP ZONE
pipeline/   normalize · sources · match · composite · tiers · history · league · build
webapp/     core.js  (shared state + maths, used by all pages)
            index.html + board.js      Board
            draft.html + draft.js      Draft
            history.html + history.js  History
            styles.css · data.js (generated)
out/        board.json · diagnostics.json
```

Scripts are classic, not ES modules — modules are blocked over `file://`, and opening the
board by double-click is a hard requirement.

**Caching.** Each page loads its js/css through a two-line inline loader that appends a fresh
`?v=` every time. The markup itself never changes between builds, so even a cached copy of the
HTML pulls current code and current data. This exists because a stale cached page silently
serves last build's rankings, which is a genuinely nasty thing to discover mid-draft.

`out/diagnostics.json` is worth reading after any rebuild: unmatched names, rejected fuzzy
matches, per-source notes, tier sizes, and every data-quality issue found in the history.

> The composite and tiering maths exist in both `pipeline/*.py` and `webapp/core.js` — the JS
> mirror is what makes the live weight sliders honest. Verified identical across all 241
> players on rank, tier and flags. If you change one, change the other.
