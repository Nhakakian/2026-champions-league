"""Per-source positional rankings and tiers.

This is deliberately SEPARATE from the composite. Nothing here is weighted,
blended or combined across sources. Each source produces its own independent
tiered board per position, and the web app shows exactly one at a time.

Tiers come from one of two places, and the app says which:

  source   the ranker published their own tier breaks (Joel does this on a
           second sheet). Those are used verbatim -- he drew the lines, not us.
  derived  the ranker gave no positional tiers, so breaks are cut from gaps in
           their OWN overall ranks within each position. Note that a positional
           rank of 1,2,3,... has uniform gaps by construction and would produce
           no tiers at all; the overall rank is what carries the dropoffs.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .normalize import name_key
from .sources import claim, discover
from .tiers import _local_thresholds

TIER_LABEL = re.compile(r"^\s*T?(\d+)\s*$", re.I)


def _parse_tier(value: object) -> int | None:
    """Tier from "3", "T3" or a float. A column with any blank cell is read
    by pandas as float, so a plain tier arrives as 3.0 and must not be lost
    to a regex that only accepts digits."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value):     # NaN
            return None
        return int(value)
    m = TIER_LABEL.match(str(value).strip())
    return int(m.group(1)) if m else None


def from_tier_sheet(path, sheet: str, positions: tuple[str, ...]) -> list[dict]:
    """Read a sheet laid out as repeating (Tier, Rank, Player) column groups.

    Each position gets its own group of three columns, with the position name
    in the row above the Tier/Rank/Player headers.
    """
    raw = pd.read_excel(path, sheet_name=sheet, header=None)

    header_row = None
    for r in range(min(12, raw.shape[0])):
        labels = [str(raw.iloc[r, c]).strip().lower() for c in range(raw.shape[1])]
        if "tier" in labels and "player" in labels:
            header_row = r
            break
    if header_row is None or header_row == 0:
        return []

    groups: list[tuple[str, int]] = []
    for c in range(raw.shape[1]):
        if str(raw.iloc[header_row, c]).strip().lower() != "tier":
            continue
        label = str(raw.iloc[header_row - 1, c]).strip().upper()
        if label in positions:
            groups.append((label, c))

    out: list[dict] = []
    for pos, c in groups:
        rank = 0
        for r in range(header_row + 1, raw.shape[0]):
            player = raw.iloc[r, c + 2] if c + 2 < raw.shape[1] else None
            if pd.isna(player) or not str(player).strip():
                continue
            rank += 1
            declared = raw.iloc[r, c + 1] if c + 1 < raw.shape[1] else None
            out.append({
                "id": name_key(player),
                "player": str(player).strip(),
                "pos": pos,
                # Trust the sheet's own rank column when it has one.
                "posRank": int(declared) if pd.notna(declared) and str(declared).isdigit() else rank,
                "tier": _parse_tier(raw.iloc[r, c]),
            })
    return out


def derive(frame: pd.DataFrame, positions: tuple[str, ...],
           gap_z: float = 1.0, min_size: int = 2, max_size: int = 12) -> list[dict]:
    """Positional list built from a source's own frame, with tiers cut from gaps.

    Gaps are measured on the source's OVERALL rank, not its positional rank:
    positional ranks are 1,2,3,... by construction, so every gap is 1 and no
    tier structure exists to find.
    """
    out: list[dict] = []
    for pos in positions:
        block = frame[frame["pos"] == pos].sort_values("rank")
        if block.empty:
            continue
        scores = np.log1p(block["rank"].to_numpy(dtype=float))
        if len(scores) < 2:
            tiers = [1]
        else:
            gaps = np.diff(scores)
            thresholds = _local_thresholds(gaps, gap_z)
            tiers, cur, size = [1], 1, 1
            for i, gap in enumerate(gaps):
                cut = gap >= thresholds[i] and size >= min_size
                if size >= max_size:
                    cut = True
                if cut:
                    cur += 1
                    size = 0
                tiers.append(cur)
                size += 1
        for i, (_, row) in enumerate(block.iterrows()):
            out.append({
                "id": row["name_key"],
                "player": row["player_raw"],
                "pos": pos,
                "posRank": i + 1,
                "tier": int(tiers[i]),
            })
    return out


def from_positional_file(path, positions: tuple[str, ...]) -> list[dict]:
    """Read a ranker's own positional board from a separate file.

    Layout is one row per player with a Pos column and a Rank that restarts
    at 1 within each position -- positions simply stacked one after another.
    Unlike a tier sheet there is nothing to detect: the Pos column says which
    board each row belongs to.

    A blank Tier is kept as None rather than guessed. These files also carry
    players the ranker places positionally but leaves off his overall list;
    those are kept, and the caller flags them as not in the pool.
    """
    raw = pd.read_csv(path, encoding="utf-8-sig")
    cols = {str(c).strip().lower(): c for c in raw.columns}
    need = [cols.get(k) for k in ("pos", "player", "rank")]
    if not all(need):
        return []
    pos_c, player_c, rank_c = need
    tier_c = cols.get("tier")

    out: list[dict] = []
    for _, row in raw.iterrows():
        pos = str(row[pos_c]).strip().upper()
        if pos not in positions:
            continue
        player = str(row[player_c]).strip()
        if not player or player.lower() == "nan":
            continue
        try:
            pos_rank = int(float(row[rank_c]))
        except (TypeError, ValueError):
            continue
        tier = None
        if tier_c is not None:
            tier = _parse_tier(row[tier_c]) if pd.notna(row[tier_c]) else None
        out.append({
            "id": name_key(player),
            "player": player,
            "pos": pos,
            "posRank": pos_rank,
            "tier": tier,
        })
    out.sort(key=lambda r: (r["pos"], r["posRank"]))
    return out


def build(loaded_sources, specs: list[dict], pool: dict[str, dict],
          positions: tuple[str, ...] = ("QB", "RB", "WR", "TE"),
          pos_dir=None) -> dict:
    """One independent positional board per ranking source."""
    by_id = {s["id"]: s for s in specs}
    out: dict = {}

    for src in loaded_sources:
        spec = by_id.get(src.id, {})
        if spec.get("role") == "market":
            continue                       # ADP is a yardstick, not a ranking

        rows = []
        tiers_from = "derived"

        # A second sheet in the ranker's own workbook (Joel), or a separate
        # file in data/sources/positional/ (Faraz). Either way these are the
        # ranker's published breaks and are used verbatim.
        sheet = spec.get("positional_sheet")
        if sheet:
            rows = from_tier_sheet(src.path, sheet, positions)
            tiers_from = "source"

        pos_glob = spec.get("positional_file")
        if not rows and pos_glob and pos_dir is not None:
            hit = claim(discover(pos_dir), pos_glob) if pos_dir.exists() else None
            if hit:
                rows = from_positional_file(hit, positions)
                tiers_from = "source"
        if not rows:
            rows = derive(src.frame, positions)
            tiers_from = "derived"

        # Attach team from the composite pool, and flag anyone the board does
        # not carry so the UI can grey out their draft button.
        # This ranker's own conviction tag, where the file carries one. Joel
        # publishes Target / I'll Pass / Avoiding; Faraz publishes none, so
        # his board simply has no tags rather than blank space.
        status_by_id: dict[str, str] = {}
        if "status" in src.frame.columns:
            for r in src.frame.itertuples():
                v = getattr(r, "status", None)
                if v is not None and pd.notna(v):
                    status_by_id[r.name_key] = str(v)

        for row in rows:
            hit = pool.get(row["id"])
            row["team"] = hit["team"] if hit else None
            row["inPool"] = hit is not None
            row["status"] = status_by_id.get(row["id"])

        out[src.id] = {
            "label": src.label,
            "short": spec.get("short", src.id),
            "tiersFrom": tiers_from,
            "counts": {p: sum(1 for r in rows if r["pos"] == p) for p in positions},
            "notInPool": sum(1 for r in rows if not r["inPool"]),
            "hasStatus": any(r.get("status") for r in rows),
            "players": rows,
        }
    return out
