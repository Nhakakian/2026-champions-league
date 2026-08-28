"""
Dynasty startup draft — built completely independently of the redraft board.

Same machinery (sources -> match -> composite -> tiers), different inputs:
config/dynasty.yml and data/dynasty/. Nothing here reads data/sources/ and
nothing in the redraft path reads this, so the two drafts cannot contaminate
each other's rankings. Pick state is kept apart separately, in the browser --
see the KEY / __CL_NAMESPACE comment in webapp/core.js.

The dynasty page is expected to run with NO sources for a while: you supply
dynasty rankings later. That is a first-class state, not an error -- an empty
pool renders a page that says so, rather than a redraft list that would be
actively misleading for dynasty.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import composite, match, sources, tiers


def _draft_order(cfg: dict) -> list[str]:
    raw = cfg.get("draft_order") or {}
    return [raw[k] for k in sorted(raw, key=lambda x: int(x))]


def register_new_sources(config_dir: Path, unregistered: list[dict]) -> None:
    """Append newly dropped dynasty files to dynasty.yml at weight 0."""
    if not unregistered:
        return
    path = config_dir / "dynasty.yml"
    text = path.read_text(encoding="utf-8")
    additions = []
    for prof in unregistered:
        stem = Path(prof["file"]).stem
        sid = "".join(ch if ch.isalnum() else "_" for ch in stem.lower()).strip("_")[:40]
        additions.append(
            f"\n  - id: {sid}\n"
            f"    label: {stem}\n"
            f"    match: \"{stem}*\"\n"
            f"    weight: 0.0        # <-- SET THIS, then re-run\n"
            f"    scope: overall\n"
            f"    columns:\n"
            f"      player: {prof['detected_player_column'] or 'auto'}\n"
            f"      pos: {prof['detected_pos_column'] or 'auto'}\n"
            f"      team: {prof['detected_team_column'] or 'auto'}\n"
            f"      rank: {(prof['candidate_rank_columns'] or ['auto'])[0]}\n"
            f"    polarity: rank\n"
        )
    block = "".join(additions)
    # Replace the empty `sources: []` placeholder the first time round.
    if "\nsources: []\n" in text:
        text = text.replace("\nsources: []\n", "\nsources:\n" + block, 1)
    else:
        marker = "\ncomposite:"
        text = text.replace(marker, block + marker, 1) if marker in text else text + block
    path.write_text(text, encoding="utf-8")


def build(cfg: dict, drop_zone: Path, config_dir: Path,
          aliases: dict) -> tuple[dict, list[str]]:
    """Return (payload, notes). Payload mirrors board.json's shape closely
    enough that webapp/core.js can consume it unchanged."""
    notes: list[str] = []
    league_cfg = cfg.get("league") or {}
    specs = cfg.get("sources") or []

    loaded, unregistered, warnings = sources.load_all(drop_zone, specs)
    notes.extend(warnings)

    if unregistered:
        register_new_sources(config_dir, unregistered)
        for prof in unregistered:
            notes.append(
                f"[new dynasty source] {prof['file']}: registered in "
                f"config/dynasty.yml at weight 0.0 -- set the weight and re-run"
            )

    players: list[dict] = []
    source_meta: list[dict] = []

    weights = composite.normalized_weights(
        [{"id": s.id, "weight": s.weight} for s in loaded]
    ) if loaded else {}

    if loaded and sum(weights.values()) > 0:
        table, _review = match.resolve(loaded, aliases)
        board = composite.compute(
            table, weights,
            missing_penalty=float((cfg.get("composite") or {}).get("missing_penalty", 0.35)),
            scopes={sp["id"]: sp.get("scope", "overall") for sp in specs},
        )
        tier_cfg = cfg.get("tiers") or {}
        board = tiers.assign(
            board,
            positions=tuple(tier_cfg.get("positions", ["QB", "RB", "WR", "TE"])),
            gap_z_threshold=float(tier_cfg.get("gap_z_threshold", 1.0)),
            min_tier_size=int(tier_cfg.get("min_tier_size", 2)),
            max_tier_size=int(tier_cfg.get("max_tier_size", 12)),
        )
        for _, row in board.iterrows():
            players.append({
                "id": row["name_key"],
                "player": row["player"],
                "pos": row["pos"],
                "team": None if pd.isna(row["team"]) else row["team"],
                "compositeRank": int(row["composite_rank"]),
                "posRank": int(row["pos_rank"]) if pd.notna(row["pos_rank"]) else None,
                "compositeScore": round(float(row["composite_score"]), 5),
                "tier": int(row["tier"]) if pd.notna(row["tier"]) else None,
                "ranks": {
                    s.id: (None if pd.isna(row.get(f"rank__{s.id}")) else float(row[f"rank__{s.id}"]))
                    for s in loaded
                },
                "rawRanks": {
                    s.id: (None if pd.isna(row.get(f"raw__{s.id}")) else float(row[f"raw__{s.id}"]))
                    for s in loaded
                },
                # Fields the redraft board carries that dynasty has no basis for.
                # Present and null so the shared front-end code never branches.
                "adpDelta": None, "leagueDelta": None, "leaguePick": None,
                "marketPick": None, "disagreement": None,
                "sourcesRanking": int(sum(1 for s in loaded
                                          if pd.notna(row.get(f"rank__{s.id}")))),
                "flags": [],
            })
        source_meta = [
            {"id": s.id, "label": s.label, "weight": weights.get(s.id, 0.0),
             "scope": next((sp.get("scope", "overall") for sp in specs if sp["id"] == s.id), "overall"),
             "role": None, "short": getattr(s, "short", None) or s.id,
             "column": s.rank_column, "file": s.path.name, "players": int(len(s.frame))}
            for s in loaded
        ]
    else:
        notes.append(
            "dynasty: no ranking sources yet -- drop a file into data/dynasty/ "
            "and re-run. The page renders an empty pool until then."
        )

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "namespace": "dynasty",
        "league": {
            "name": league_cfg.get("name", "Dynasty Startup"),
            "teams": int(league_cfg.get("teams", 12)),
            "rounds": int(league_cfg.get("rounds", 25)),
            "format": league_cfg.get("format", "superflex"),
            "scoring": league_cfg.get("scoring", "half_ppr"),
            "uncoveredPositions": [],
            "owners": sorted(_draft_order(cfg)),
            "draftOrder": _draft_order(cfg),
            "mySeat": cfg.get("my_seat"),
        },
        "sources": source_meta,
        "tierConfig": {
            "gapZThreshold": float((cfg.get("tiers") or {}).get("gap_z_threshold", 1.0)),
            "minTierSize": int((cfg.get("tiers") or {}).get("min_tier_size", 2)),
            "maxTierSize": int((cfg.get("tiers") or {}).get("max_tier_size", 12)),
        },
        "compositeConfig": {
            "missingPenalty": float((cfg.get("composite") or {}).get("missing_penalty", 0.35)),
        },
        "adpSourceId": None,
        "positional": {},
        "flagThresholds": {},
        "players": players,
        # No history: this league has never drafted before. The redraft board's
        # tendency model is built on 3 years of real picks; inventing an
        # equivalent here would be fabrication, so the page omits it.
        "tendencies": {"summary": {}, "curve": [], "roundMix": [],
                       "owners": [], "rosterPace": []},
    }, notes
