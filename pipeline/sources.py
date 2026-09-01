"""Discovery and loading of ranking sources from the drop zone.

Each configured source claims the NEWEST file in ``data/sources/`` matching its
glob, so dropping an updated export supersedes the previous one with no config
edit. Files that no source claims are profiled and reported so they can be
registered with a weight.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from .normalize import name_key, normalize_position, normalize_team

READABLE = {".csv", ".xlsx", ".xls", ".tsv"}

# Column-name candidates used when a source is configured with `auto`, or when
# profiling an unregistered file.
PLAYER_HINTS = ("player", "player name", "name", "full name")
POS_HINTS = ("pos", "position", "player position")
TEAM_HINTS = ("team", "nfl team", "player team", "tm")
RANK_HINTS = ("rank", "rk", "adp", "ecr", "overall", "consensus", "avg")
# Age is optional and only some sources carry it, but for a dynasty board it
# is close to the whole point, so it is read wherever it is offered.
AGE_HINTS = ("age", "player age")
# A ranker's own conviction tag ("Target", "I'll Pass", "Avoiding").
# Only some publish one; it is never inferred.
STATUS_HINTS = ("status", "tag")
# A ranker's own tier break, published alongside the ranking rather than
# on a separate sheet, and any written note they attach to a player.
TIER_HINTS = ("tier",)
ANALYSIS_HINTS = ("analysis", "ds analysis", "notes", "comment", "writeup")


@dataclass
class LoadedSource:
    id: str
    label: str
    weight: float
    path: Path
    rank_column: str
    frame: pd.DataFrame
    notes: list[str] = field(default_factory=list)


def _find_header_row(raw: pd.DataFrame, scan: int = 12) -> int:
    """Index of the row that actually holds the column headings.

    A hand-made rankings sheet often opens with a title and a colour legend
    before the real headings -- Joel's workbook gained exactly that between
    two updates, which silently turned every column into "Unnamed: N". Look
    for the first row carrying both a rank-ish and a player-ish cell, and
    fall back to row 0 so a well-formed file is unaffected.
    """
    for i in range(min(scan, len(raw))):
        cells = [str(c).strip().lower() for c in raw.iloc[i].tolist() if pd.notna(c)]
        if not cells:
            continue
        has_rank = any(c in {"rank", "rk", "overall", "#"} or c.startswith("rank") for c in cells)
        has_player = any(c in {"player", "name", "player name"} for c in cells)
        if has_rank and has_player:
            return i
    return 0


def _read_any(path: Path) -> pd.DataFrame:
    """Read a CSV/TSV/XLSX, tolerating the BOM that Sleeper exports carry."""
    if path.suffix.lower() in {".csv", ".tsv"}:
        sep = "\t" if path.suffix.lower() == ".tsv" else ","
        raw = pd.read_csv(path, encoding="utf-8-sig", sep=sep, header=None, dtype=object)
    else:
        raw = pd.read_excel(path, header=None, dtype=object)

    head = _find_header_row(raw)
    frame = raw.iloc[head + 1:].copy()
    frame.columns = [str(c).strip() if pd.notna(c) else f"Unnamed: {j}"
                     for j, c in enumerate(raw.iloc[head].tolist())]
    # Drop columns with no heading at all and rows that are entirely blank.
    frame = frame.loc[:, [not str(c).startswith("Unnamed: ") for c in frame.columns]]
    frame = frame.dropna(how="all").reset_index(drop=True)
    # Everything was read as object to keep the header scan honest; let pandas
    # re-infer so numeric ranks behave like numbers again.
    return frame.infer_objects()


def _clean_status(value: object) -> str | None:
    """Normalise a conviction tag; blank and NaN both mean "no opinion"."""
    if value is None:
        return None
    token = str(value).strip()
    if not token or token.lower() in {"nan", "-", "none"}:
        return None
    return token


def _pick_column(columns: list[str], hints: tuple[str, ...]) -> str | None:
    lowered = {c.lower().strip(): c for c in columns}
    for hint in hints:
        if hint in lowered:
            return lowered[hint]
    for hint in hints:
        for low, original in lowered.items():
            if hint in low:
                return original
    return None


def discover(drop_zone: Path) -> list[Path]:
    """All readable files in the drop zone, newest first."""
    files = [
        p for p in sorted(drop_zone.glob("*"))
        if p.is_file() and p.suffix.lower() in READABLE and not p.name.startswith("~$")
    ]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def claim(files: list[Path], pattern: str) -> Path | None:
    """Newest file whose name matches `pattern` (case-insensitive glob)."""
    pat = pattern.lower()
    for path in files:  # already newest-first
        if fnmatch.fnmatch(path.name.lower(), pat):
            return path
    return None


def profile(path: Path) -> dict:
    """Describe an unregistered file so it can be added to sources.yml."""
    frame = _read_any(path)
    cols = [str(c) for c in frame.columns]
    numeric = [c for c in cols if pd.to_numeric(frame[c], errors="coerce").notna().any()]
    return {
        "file": path.name,
        "rows": int(len(frame)),
        "columns": cols,
        "detected_player_column": _pick_column(cols, PLAYER_HINTS),
        "detected_pos_column": _pick_column(cols, POS_HINTS),
        "detected_team_column": _pick_column(cols, TEAM_HINTS),
        "candidate_rank_columns": [c for c in numeric if any(h in c.lower() for h in RANK_HINTS)]
        or numeric,
    }


def load(spec: dict, path: Path) -> LoadedSource:
    """Load one configured source into a tidy frame."""
    raw = _read_any(path)
    cols = [str(c) for c in raw.columns]
    mapping = spec.get("columns") or {}
    notes: list[str] = []

    def resolve(key: str, hints: tuple[str, ...], required: bool = False) -> str | None:
        want = mapping.get(key)
        if want and want != "auto":
            if want in cols:
                return want
            notes.append(f"configured {key} column {want!r} not found; auto-detecting")
        found = _pick_column(cols, hints)
        if required and not found:
            raise ValueError(f"{path.name}: cannot find a {key} column among {cols}")
        return found

    player_col = resolve("player", PLAYER_HINTS, required=True)
    rank_col = resolve("rank", RANK_HINTS, required=True)
    pos_col = resolve("pos", POS_HINTS)
    team_col = resolve("team", TEAM_HINTS)
    age_col = resolve("age", AGE_HINTS)
    status_col = resolve("status", STATUS_HINTS)
    tier_col = resolve("tier", TIER_HINTS)
    analysis_col = resolve("analysis", ANALYSIS_HINTS)

    frame = pd.DataFrame(
        {
            "player_raw": raw[player_col].astype(str).str.strip(),
            "rank_raw": pd.to_numeric(raw[rank_col], errors="coerce"),
        }
    )
    frame["pos"] = raw[pos_col].map(normalize_position) if pos_col else None
    frame["team"] = raw[team_col].map(normalize_team) if team_col else None
    frame["age"] = pd.to_numeric(raw[age_col], errors="coerce") if age_col else pd.NA
    frame["status"] = (raw[status_col].map(_clean_status) if status_col else None)
    frame["src_tier"] = raw[tier_col] if tier_col else None
    frame["analysis"] = (raw[analysis_col].map(_clean_status) if analysis_col else None)
    frame["name_key"] = frame["player_raw"].map(name_key)

    dropped = int(frame["rank_raw"].isna().sum())
    if dropped:
        notes.append(f"{dropped} row(s) had no value in {rank_col!r} and were dropped")
    frame = frame[frame["rank_raw"].notna()].copy()

    blank = frame["name_key"] == ""
    if blank.any():
        notes.append(f"{int(blank.sum())} row(s) had an empty player name and were dropped")
        frame = frame[~blank].copy()

    # A 'score' source is higher-is-better; invert it into rank space.
    if str(spec.get("polarity", "rank")).lower() == "score":
        frame["rank_raw"] = -frame["rank_raw"]
        notes.append("polarity=score: values inverted so lower is better")

    # Dense-rank so ADP floats and integer ranks live on one comparable scale.
    frame["rank"] = frame["rank_raw"].rank(method="min")

    dupes = frame["name_key"].duplicated(keep=False)
    if dupes.any():
        names = sorted(frame.loc[dupes, "player_raw"].unique())
        notes.append(f"duplicate player names collapsed to best rank: {names}")
        frame = frame.sort_values("rank").drop_duplicates("name_key", keep="first")

    return LoadedSource(
        id=spec["id"],
        label=spec.get("label", spec["id"]),
        weight=float(spec.get("weight", 0.0)),
        path=path,
        rank_column=rank_col,
        frame=frame.reset_index(drop=True),
        notes=notes,
    )


def load_all(drop_zone: Path, specs: list[dict]) -> tuple[list[LoadedSource], list[dict], list[str]]:
    """Load every configured source; profile whatever is left over."""
    files = discover(drop_zone)
    loaded: list[LoadedSource] = []
    claimed: set[Path] = set()
    warnings: list[str] = []

    for spec in specs:
        pattern = spec.get("match", f"*{spec['id']}*")
        path = claim(files, pattern)
        if path is None:
            warnings.append(
                f"source {spec['id']!r}: no file in {drop_zone} matches {pattern!r}"
            )
            continue
        # Claim EVERY file matching the glob, not just the newest. The others
        # are superseded exports of the same source; treating them as unclaimed
        # would auto-register last week's file as a brand new ranker.
        superseded = [p for p in files if fnmatch.fnmatch(p.name.lower(), pattern.lower())]
        claimed.update(superseded)
        if len(superseded) > 1:
            older = [p.name for p in superseded if p != path]
            warnings.append(
                f"source {spec['id']!r}: using {path.name}; "
                f"ignoring {len(older)} older file(s): {', '.join(sorted(older))}"
            )
        try:
            loaded.append(load(spec, path))
        except Exception as exc:  # a bad drop-in must not kill the build
            warnings.append(f"source {spec['id']!r}: failed to load {path.name}: {exc}")

    unregistered = [profile(p) for p in files if p not in claimed]
    return loaded, unregistered, warnings
