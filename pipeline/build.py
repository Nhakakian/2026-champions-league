"""Pipeline orchestrator.

    python -m pipeline.build

Reads config/, ingests every ranking source in data/sources/, resolves player
identity, computes the weighted composite and auto-tiers, analyses three years
of draft history, and writes out/board.json + out/diagnostics.json.

NOTE: 'Champions Leage Fantasy Football Ranking 2025.xlsx' is reference only.
Its 2025 rankings are stale and are NEVER read by this pipeline.
"""
from __future__ import annotations

import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yaml

from . import dynasty as dynasty_mod, composite, history, league, match, positional, sources, tiers

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DROP_ZONE = ROOT / "data" / "sources"
OUT = ROOT / "out"


def _load_yaml(name: str) -> dict:
    path = CONFIG / name
    if not path.exists():
        raise SystemExit(f"missing config file: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _register_new_sources(cfg: dict, unregistered: list[dict]) -> None:
    """Append newly dropped files to sources.yml at weight 0 so they're one edit away."""
    if not unregistered:
        return
    path = CONFIG / "sources.yml"
    text = path.read_text(encoding="utf-8")
    additions = []
    for prof in unregistered:
        stem = Path(prof["file"]).stem
        sid = "".join(ch if ch.isalnum() else "_" for ch in stem.lower()).strip("_")[:40]
        additions.append(
            f"\n  - id: {sid}\n"
            f"    label: {stem}\n"
            f"    match: \"{Path(prof['file']).stem}*\"\n"
            f"    weight: 0.0        # <-- SET THIS, then re-run\n"
            f"    columns:\n"
            f"      player: {prof['detected_player_column'] or 'auto'}\n"
            f"      pos: {prof['detected_pos_column'] or 'auto'}\n"
            f"      team: {prof['detected_team_column'] or 'auto'}\n"
            f"      rank: {(prof['candidate_rank_columns'] or ['auto'])[0]}\n"
            f"    polarity: rank\n"
        )
    marker = "\n# ---------------------------------------------------------------------------\n# COMPOSITE SETTINGS"
    block = "".join(additions)
    text = text.replace(marker, block + marker, 1) if marker in text else text + block
    path.write_text(text, encoding="utf-8")


APP_README = """CHAMPIONS LEAGUE DRAFT BOARD
============================

Double-click index.html. That's it -- no install, no internet.

Four pages, linked at the top left:
  Board       the full player table (weighted composite)
  Draft       record picks, your team, watch list, the draft board grid
  Positional  one ranker at a time, tiered by position -- never blended
  History     what 3 years of your league's drafts say

Keep all the files in this folder together.

If a red bar appears saying storage is blocked, your picks won't survive
switching pages. Use the full project instead and serve it:
  python -m http.server 8777
then open http://localhost:8777/webapp/index.html
"""

FULL_README = """CHAMPIONS LEAGUE DRAFT TOOL
===========================

JUST USE IT (no install):
  Open webapp/index.html

UPDATE THE RANKINGS (needs Python 3):
  1. pip install pandas openpyxl PyYAML
  2. Drop the new ranking file into data/sources/
  3. python -m pipeline.build
  4. Reopen webapp/index.html

GUARANTEED-STORAGE MODE (if the red storage warning appears):
  python -m http.server 8777
  then open http://localhost:8777/webapp/index.html

Full detail in README.md
"""

SKIP_DIRS = {".git", "__pycache__", ".claude", "out", "_ziptest"}


def _write_bundles(root: Path, out: Path, live_sources: set[str] | None = None,
                   reference_only: set[str] | None = None) -> list[Path]:
    """Write the two ready-to-move zips.

    Regenerated on every build on purpose: a zip that lags the data is exactly
    the thing you would grab on draft night and not notice was stale.

    The full bundle carries only the ranking files actually in use, and skips
    the reference-only workbooks the pipeline never reads. Both exclusions are
    about not shipping ambiguity: a second Joel file invites "which one is
    live?", and the 2025 workbook is stale rankings by definition.
    """
    live_sources = live_sources or set()
    reference_only = reference_only or set()
    app = out / "draft-board-app.zip"
    with zipfile.ZipFile(app, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((root / "webapp").glob("*")):
            if f.is_file():
                z.write(f, f"draft-board/{f.name}")
        z.writestr("draft-board/OPEN ME.txt", APP_README)

    full = out / "champions-league-full.zip"
    with zipfile.ZipFile(full, "w", zipfile.ZIP_DEFLATED) as z:
        for f in root.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(root)          # NOT f.as_posix(): ROOT is absolute,
            if set(rel.parts) & SKIP_DIRS:     # which would bake "C:/Users/..." into
                continue                       # every entry and break most unzippers.
            if f.suffix == ".pyc" or f.name.startswith("~$"):
                continue
            if f.name in reference_only:
                continue
            # Superseded ranking exports: the build ignores them, so shipping
            # them only raises "which file is actually being used?"
            if rel.parts[:2] == ("data", "sources") and live_sources and f.name not in live_sources:
                continue
            z.write(f, f"champions-league/{rel.as_posix()}")
        z.writestr("champions-league/START HERE.txt", FULL_README)
    return [app, full]


def main() -> int:
    src_cfg = _load_yaml("sources.yml")
    league_cfg = _load_yaml("league.yml")
    alias_cfg = _load_yaml("aliases.yml")
    # Bye weeks are team-level, so one map serves both boards. Missing
    # entries stay None and render as "—" rather than a guess.
    bye_map = {k: v for k, v in (_load_yaml("byes.yml").get("byes") or {}).items()
               if v is not None}

    specs = src_cfg.get("sources") or []
    diagnostics: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference_file_excluded": (
            "Champions Leage Fantasy Football Ranking 2025.xlsx — structure only; "
            "its 2025 rankings are stale and are not read by this pipeline."
        ),
        "warnings": [],
    }

    # ---------------------------------------------------------------- sources
    loaded, unregistered, warnings = sources.load_all(DROP_ZONE, specs)
    diagnostics["warnings"].extend(warnings)
    diagnostics["sources"] = [
        {
            "id": s.id, "label": s.label, "file": s.path.name,
            "weight_config": s.weight, "rank_column": s.rank_column,
            "players": int(len(s.frame)), "notes": s.notes,
        }
        for s in loaded
    ]
    diagnostics["unregistered_files"] = unregistered

    if unregistered:
        _register_new_sources(src_cfg, unregistered)
        for prof in unregistered:
            print(f"[new source] {prof['file']}: registered in config/sources.yml at weight 0.0")
            print(f"             rank column candidates: {prof['candidate_rank_columns']}")

    if not loaded:
        print("No ranking sources loaded. Drop a CSV/XLSX into data/sources/ and re-run.")
        return 1

    weights = composite.normalized_weights(
        [{"id": s.id, "weight": s.weight} for s in loaded]
    )
    if sum(weights.values()) <= 0:
        print("All source weights are 0. Set a weight in config/sources.yml and re-run.")
        return 1

    # ---------------------------------------------------------------- matching
    table, review = match.resolve(loaded, alias_cfg.get("players", {}))
    diagnostics["cross_source_match_review"] = review
    diagnostics["player_pool"] = int(len(table))

    missing_pos = table[table["pos"].isna()]
    if len(missing_pos):
        diagnostics["warnings"].append(
            f"{len(missing_pos)} player(s) have no position and are excluded from tiering: "
            + ", ".join(missing_pos["player"].head(10))
        )

    # --------------------------------------------------------------- composite
    board = composite.compute(
        table, weights,
        missing_penalty=float((src_cfg.get("composite") or {}).get("missing_penalty", 0.35)),
        scopes={sp["id"]: sp.get("scope", "overall") for sp in specs},
    )
    tier_cfg = src_cfg.get("tiers") or {}
    board = tiers.assign(
        board,
        positions=tuple(tier_cfg.get("positions", ["QB", "RB", "WR", "TE"])),
        gap_z_threshold=float(tier_cfg.get("gap_z_threshold", 1.0)),
        min_tier_size=int(tier_cfg.get("min_tier_size", 2)),
        max_tier_size=int(tier_cfg.get("max_tier_size", 12)),
    )
    diagnostics["tier_summary"] = tiers.summarize(board)

    # ----------------------------------------------------------------- history
    hist_cfg = league_cfg.get("history") or {}
    hist_path = ROOT / hist_cfg.get("file", "Champions League Draft History.xlsx")
    picks = pd.DataFrame()
    tendency_summary, curve = {}, pd.DataFrame()

    if hist_path.exists():
        picks, issues = history.parse(
            hist_path,
            {str(k): v for k, v in (hist_cfg.get("sheets") or {}).items()},
            owner_aliases=league_cfg.get("owner_aliases", {}),
            player_aliases=alias_cfg.get("players", {}),
            position_fixes=alias_cfg.get("position_fixes", {}),
            dst_aliases=alias_cfg.get("dst", {}),
        )
        diagnostics["history_issues"] = issues
        diagnostics["history_picks"] = int(len(picks))
        diagnostics["history_years"] = sorted(int(y) for y in picks["year"].unique())
        resolved = picks["resolved_via"].notna().sum()
        diagnostics["history_alias_resolutions"] = int(resolved)
    else:
        diagnostics["warnings"].append(f"draft history not found at {hist_path}")

    # -------------------------------------------------------------- tendencies
    adp_source = next((s.id for s in loaded if "adp" in s.id.lower()), None)
    if adp_source is None and loaded:
        adp_source = loaded[-1].id
        diagnostics["warnings"].append(
            f"no source id contains 'adp'; using {adp_source!r} as the market baseline"
        )

    tend_cfg = league_cfg.get("tendencies") or {}
    flag_cfg = league_cfg.get("flags") or {}
    if not picks.empty:
        skill = picks[picks["pos"].isin(["QB", "RB", "WR", "TE"])]
        total_picks = int(league_cfg.get("teams", 10)) * int(league_cfg.get("rounds", 16))
        curve, tendency_summary = league.build_tendencies(
            skill, board, adp_source,
            min_years=int(tend_cfg.get("min_years_observed", 2)),
            max_picks=total_picks,
            early_picks=int(league_cfg.get("teams", 10)) * 6,
        )

    board = league.apply_flags(
        board, curve, adp_source,
        value_threshold=float(tend_cfg.get("value_threshold", 8)),
        reach_threshold=float(tend_cfg.get("reach_threshold", 8)),
        market_value=float(flag_cfg.get("market_value", 15)),
        market_reach=float(flag_cfg.get("market_reach", 15)),
        volatile=float(flag_cfg.get("volatile", 0.20)),
        thin_coverage=float(flag_cfg.get("thin_coverage", 60)),
    )

    # ------------------------------------------------------------------ output
    OUT.mkdir(exist_ok=True)
    players = []
    for _, row in board.iterrows():
        players.append({
            "id": row["name_key"],
            "player": row["player"],
            "pos": row["pos"],
            "team": row["team"],
            "bye": bye_map.get(row["team"]) if pd.notna(row["team"]) else None,
            "age": None if pd.isna(row.get("age")) else float(row["age"]),
            "compositeRank": int(row["composite_rank"]),
            "posRank": int(row["pos_rank"]) if pd.notna(row["pos_rank"]) else None,
            "compositeScore": round(float(row["composite_score"]), 5),
            "tier": int(row["tier"]) if pd.notna(row["tier"]) else None,
            # `ranks` are normalized 1..n and drive the maths; `rawRanks` are
            # each source's own number and are what the board displays.
            "ranks": {
                s.id: (None if pd.isna(row.get(f"rank__{s.id}")) else float(row[f"rank__{s.id}"]))
                for s in loaded
            },
            "rawRanks": {
                s.id: (None if pd.isna(row.get(f"raw__{s.id}")) else float(row[f"raw__{s.id}"]))
                for s in loaded
            },
            "adpDelta": None if pd.isna(row["adp_delta"]) else float(row["adp_delta"]),
            "leagueDelta": None if pd.isna(row["league_delta"]) else float(row["league_delta"]),
            "leaguePick": None if pd.isna(row["league_pick"]) else float(row["league_pick"]),
            "marketPick": None if pd.isna(row["market_pick"]) else float(row["market_pick"]),
            "disagreement": None if pd.isna(row["disagreement"]) else float(row["disagreement"]),
            "sourcesRanking": int(row["sources_ranking"]),
            "flags": row["flags"],
        })

    payload = {
        "generatedAt": diagnostics["generated_at"],
        "league": {
            "name": league_cfg.get("name", "League"),
            "teams": int(league_cfg.get("teams", 10)),
            "rounds": int(league_cfg.get("rounds", 16)),
            "format": league_cfg.get("format", ""),
            "scoring": league_cfg.get("scoring", ""),
            "uncoveredPositions": league_cfg.get("uncovered_positions", []),
            "owners": sorted(picks["owner"].unique().tolist()) if not picks.empty else [],
            # This year's seating, seat 1 first. Defaults for the Draft page.
            "draftOrder": [
                (league_cfg.get("draft_order") or {}).get(i + 1, f"Seat {i + 1}")
                for i in range(int(league_cfg.get("teams", 10)))
            ],
            "mySeat": league_cfg.get("my_seat"),
        },
        "sources": [
            {"id": s.id, "label": s.label, "weight": round(weights[s.id], 4),
             "scope": next((sp.get("scope", "overall") for sp in specs if sp["id"] == s.id), "overall"),
             "role": next((sp.get("role") for sp in specs if sp["id"] == s.id), None),
             # `short` is the board's column header; falls back to the id.
             "short": next((sp.get("short") for sp in specs if sp["id"] == s.id and sp.get("short")),
                           s.id.upper()[:6]),
             "column": s.rank_column,
             "file": s.path.name, "players": int(len(s.frame))}
            for s in loaded
        ],
        "tierConfig": {
            "gapZThreshold": float(tier_cfg.get("gap_z_threshold", 1.0)),
            "minTierSize": int(tier_cfg.get("min_tier_size", 2)),
            "maxTierSize": int(tier_cfg.get("max_tier_size", 12)),
        },
        "compositeConfig": {
            "missingPenalty": float((src_cfg.get("composite") or {}).get("missing_penalty", 0.35)),
        },
        "adpSourceId": adp_source,
        "platformSourceId": next(
            (sp["id"] for sp in specs if sp.get("role") == "platform"), None),
        # Per-source positional boards. Independent of the composite by design:
        # nothing here is weighted or blended across sources.
        "positional": positional.build(
            loaded, specs, {p["id"]: p for p in players},
            pos_dir=DROP_ZONE / "positional",
        ),
        # Mirrored by webapp/app.js so live weight changes reproduce the flags
        # a rebuild at those weights would produce.
        "flagThresholds": {
            "leagueValue": float(tend_cfg.get("value_threshold", 8)),
            "leagueReach": float(tend_cfg.get("reach_threshold", 8)),
            "marketValue": float(flag_cfg.get("market_value", 15)),
            "marketReach": float(flag_cfg.get("market_reach", 15)),
            "volatile": float(flag_cfg.get("volatile", 0.20)),
            "thinCoverage": float(flag_cfg.get("thin_coverage", 60)),
        },
        "players": players,
        "tendencies": {
            "summary": tendency_summary,
            "curve": curve.to_dict("records") if not curve.empty else [],
            "roundMix": league.round_position_mix(picks) if not picks.empty else [],
            "owners": league.owner_profiles(picks) if not picks.empty else [],
            "rosterPace": league.roster_pace(picks) if not picks.empty else [],
        },
    }

    (OUT / "board.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    (OUT / "diagnostics.json").write_text(json.dumps(diagnostics, indent=1, default=str),
                                          encoding="utf-8")

    # Also emit the board as a plain script assignment. Browsers block fetch()
    # over file://, so this lets webapp/index.html be opened by double-click
    # with no local server — which is what you want on draft night.
    web = ROOT / "webapp"
    web.mkdir(exist_ok=True)
    (web / "data.js").write_text(
        "window.BOARD_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )

    # ------------------------------------------------------------- dynasty
    # A completely separate draft: its own config, its own drop zone, its own
    # data file, its own browser storage. Built here only so one command
    # rebuilds everything; nothing above this line reads dynasty data.
    dyn_cfg = _load_yaml("dynasty.yml")
    if dyn_cfg.get("enabled", True):
        dyn_payload, dyn_notes = dynasty_mod.build(
            dyn_cfg, ROOT / "data" / "dynasty", CONFIG,
            alias_cfg.get("players", {}), bye_map,
        )
        (OUT / "dynasty.json").write_text(
            json.dumps(dyn_payload, indent=1), encoding="utf-8")
        (web / "dynasty-data.js").write_text(
            "window.BOARD_DATA = " + json.dumps(dyn_payload, separators=(",", ":")) + ";\n",
            encoding="utf-8",
        )
        diagnostics["dynasty"] = {
            "players": len(dyn_payload["players"]),
            "sources": [d["id"] for d in dyn_payload["sources"]],
            "notes": dyn_notes,
        }

    print(f"\nplayers: {len(players)}   sources: " +
          ", ".join(f"{s.id}={weights[s.id]:.0%}" for s in loaded))
    if not picks.empty:
        print(f"history: {len(picks)} picks across {diagnostics['history_years']}")
    for pos, info in tendency_summary.items():
        print(f"  {pos}: {info['reads']}")
    if diagnostics["warnings"]:
        print("\nwarnings:")
        for w in diagnostics["warnings"]:
            print(f"  - {w}")
    print(f"\nwrote {OUT / 'board.json'}")
    print(f"wrote {OUT / 'diagnostics.json'}")
    for bundle in _write_bundles(
        ROOT, OUT,
        live_sources={s.path.name for s in loaded},
        reference_only=set(league_cfg.get("reference_only") or []),
    ):
        print(f"wrote {bundle}  ({bundle.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
