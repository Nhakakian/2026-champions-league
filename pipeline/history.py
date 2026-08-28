"""Parse the league's draft-history workbook into tidy picks.

The sheets are draft GRIDS, not records: columns are managers, rows are rounds,
each cell is one pick. Two formats appear:

  modern (2024, 2025)   "Player\\n POS - TEAM - BYE"
  legacy (2023)         "Player (POS)", with a leading round-number column

Overall pick number is reconstructed from the snake. The 2023/2024 sheets carry
a literal arrow column (-> / <-) confirming direction alternates from round 1;
2025 has no arrow column and is assumed to follow the same convention.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from .normalize import is_arrow, name_key, normalize_position, normalize_team

_MODERN = re.compile(r"^(?P<name>.+?)\n\s*(?P<rest>.*)$", re.S)


def _team_columns(header: list[str]) -> list[int]:
    """Column indices that are real managers (not blanks, arrows, round numbers)."""
    cols = []
    for i, value in enumerate(header):
        text = str(value).strip()
        if not text or text.lower() == "nan" or is_arrow(text):
            continue
        if re.fullmatch(r"\d+(\.\d+)?", text):
            continue
        cols.append(i)
    return cols


def _slot(index: int, n_teams: int, rnd: int) -> int:
    """Snake position within the round (1-based)."""
    return index + 1 if rnd % 2 == 1 else n_teams - index


def _parse_modern_cell(raw: str) -> dict:
    match = _MODERN.match(raw)
    if not match:
        return {"name": raw.strip(), "pos": None, "nfl_team": None, "bye": None}
    name = match.group("name").strip()
    parts = [p.strip() for p in match.group("rest").split("-")]
    pos = normalize_position(parts[0]) if parts else None
    team = normalize_team(parts[1]) if len(parts) > 1 else None
    bye = None
    if len(parts) > 2 and re.fullmatch(r"\d+", parts[2]):
        bye = int(parts[2])
    return {"name": name, "pos": pos, "nfl_team": team, "bye": bye}


def _parse_legacy_cell(raw: str) -> dict:
    tags = re.findall(r"\(([^)]*)\)", raw)
    name = re.sub(r"\s*\([^)]*\)", "", raw).strip()
    # Cells like "Christian Kirk (WR) (QB)" carry a stray second tag; first wins.
    pos = normalize_position(tags[0]) if tags else None
    return {"name": name, "pos": pos, "nfl_team": None, "bye": None,
            "multi_tag": len(tags) > 1}


def parse(
    path: Path,
    sheets: dict[str, str],
    owner_aliases: dict[str, str] | None = None,
    player_aliases: dict[str, str] | None = None,
    position_fixes: dict[str, str] | None = None,
    dst_aliases: dict[str, str] | None = None,
) -> tuple[pd.DataFrame, list[dict]]:
    """Return (tidy picks, issues)."""
    owner_aliases = owner_aliases or {}
    alias_keys = {name_key(k): v for k, v in (player_aliases or {}).items()}
    position_fixes = position_fixes or {}
    dst_keys = {name_key(k): v for k, v in (dst_aliases or {}).items()}

    records: list[dict] = []
    issues: list[dict] = []

    for sheet, style in sheets.items():
        year = int(sheet)
        grid = pd.read_excel(path, sheet_name=sheet, header=None)
        if grid.empty:
            issues.append({"year": year, "issue": "sheet is empty"})
            continue

        header = [str(v) for v in grid.iloc[0].tolist()]
        tcols = _team_columns(header)
        n_teams = len(tcols)
        body = grid.iloc[1:].reset_index(drop=True)

        for r in range(len(body)):
            if style == "legacy":
                round_cell = body.iloc[r, 0]
                if pd.isna(round_cell):
                    continue
                rnd = int(float(round_cell))
            else:
                rnd = r + 1

            row_has_pick = False
            for i, c in enumerate(tcols):
                value = body.iloc[r, c]
                if pd.isna(value):
                    continue
                raw = str(value).strip()
                if is_arrow(raw):
                    continue
                row_has_pick = True

                parsed = (_parse_legacy_cell(raw) if style == "legacy"
                          else _parse_modern_cell(raw))
                if parsed.pop("multi_tag", False):
                    issues.append({
                        "year": year, "round": rnd, "cell": raw,
                        "issue": "multiple position tags in one cell; first used",
                    })

                key = name_key(parsed["name"])
                resolved_via = None

                # Team defenses first — they never match the player alias table.
                if key in dst_keys:
                    parsed["pos"] = "DST"
                    parsed["nfl_team"] = dst_keys[key]
                    parsed["name"] = f"{dst_keys[key]} DST"
                    resolved_via = "dst_alias"
                elif key in alias_keys:
                    parsed["name"] = alias_keys[key]
                    resolved_via = "alias"
                    key = name_key(parsed["name"])

                if parsed["name"] in position_fixes:
                    parsed["pos"] = position_fixes[parsed["name"]]
                    resolved_via = (resolved_via or "") + "+position_fix"

                if not parsed["pos"]:
                    issues.append({
                        "year": year, "round": rnd, "cell": raw,
                        "issue": "no position could be determined",
                    })
                if style == "modern" and not parsed["nfl_team"] and parsed["pos"] != "DST":
                    issues.append({
                        "year": year, "round": rnd, "cell": raw,
                        "issue": "malformed cell: NFL team missing",
                    })

                slot = _slot(i, n_teams, rnd)
                owner = str(header[c]).strip()
                records.append({
                    "year": year,
                    "round": rnd,
                    "slot": slot,
                    "overall": (rnd - 1) * n_teams + slot,
                    "owner": owner_aliases.get(owner, owner),
                    "raw": raw,
                    "player": parsed["name"],
                    "name_key": key,
                    "pos": parsed["pos"],
                    "nfl_team": parsed["nfl_team"],
                    "bye": parsed["bye"],
                    "resolved_via": resolved_via,
                })

            if not row_has_pick and style == "modern":
                continue

    picks = pd.DataFrame(records)

    # Same player twice in one year is a genuine error in the record.
    for year, block in picks.groupby("year"):
        dupes = block[block["name_key"].duplicated(keep=False)]
        for key, rows in dupes.groupby("name_key"):
            issues.append({
                "year": int(year),
                "issue": "player drafted more than once in the same year",
                "player": rows.iloc[0]["player"],
                "picks": [
                    {"round": int(r["round"]), "owner": r["owner"]} for _, r in rows.iterrows()
                ],
            })

    return picks, issues
