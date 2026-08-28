"""Resolve player identity across ranking sources.

Exact key match first; fuzzy only as a fallback, and only when the position
agrees. Anything below the accept threshold goes to a review queue instead of
being silently guessed.
"""
from __future__ import annotations

from collections import defaultdict
from difflib import SequenceMatcher

import pandas as pd

from .normalize import name_key

ACCEPT = 0.90        # auto-accept a fuzzy match at or above this ratio
REVIEW = 0.78        # below ACCEPT but above this -> surfaced for human review
FIRST_NAME_MIN = 0.85  # first tokens must clear this unless one prefixes the other


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _last(key: str) -> str:
    parts = key.split()
    return parts[-1] if parts else key


def _first_names_compatible(a: str, b: str) -> bool:
    """Guard against same-position, same-surname collisions.

    Whole-string similarity is not enough: "brian robinson" vs "bijan robinson"
    scores 0.93 and both are RBs, so neither the ratio nor the position check
    rejects it. Candidates that share a surname must also agree on the first
    name -- exactly, by prefix (chris/christopher, cam/cameron), or by a high
    token ratio. brian/bijan scores 0.80 and is correctly rejected.
    """
    at, bt = a.split(), b.split()
    if len(at) < 2 or len(bt) < 2:
        return False  # a bare surname is never enough to merge on
    fa, fb = at[0], bt[0]
    if fa == fb or fa.startswith(fb) or fb.startswith(fa):
        return True
    return _similar(fa, fb) >= FIRST_NAME_MIN


def _record(rec: dict, sid: str, row) -> None:
    """Store both the normalized rank (used by the maths) and the source's own
    number (shown on the board -- an ADP of 88.4 reads better than 'rank 88')."""
    rec["ranks"][sid] = float(row.rank)
    rec["raw"][sid] = float(row.rank_raw)


def _age_of(row):
    """Age if this source carries one, else None. Not every source does."""
    v = getattr(row, "age", None)
    try:
        if v is None or pd.isna(v):
            return None
    except (TypeError, ValueError):
        return None
    return round(float(v), 1)


def resolve(sources: list, aliases: dict[str, str]) -> tuple[pd.DataFrame, list[dict]]:
    """Merge per-source frames into one player table.

    Returns the player table plus a list of match decisions needing review.
    """
    alias_keys = {name_key(k): v for k, v in (aliases or {}).items()}
    review: list[dict] = []

    # The source with the most players anchors the roster; others match into it.
    ordered = sorted(sources, key=lambda s: len(s.frame), reverse=True)

    players: dict[str, dict] = {}
    by_last: dict[str, list[str]] = defaultdict(list)

    def register(key: str, row) -> dict:
        rec = players.get(key)
        if rec is None:
            rec = {
                "name_key": key,
                "player": row.player_raw,
                "pos": row.pos,
                "team": row.team,
                "ranks": {},
                "raw": {},
                "age": _age_of(row),
            }
            players[key] = rec
            by_last[_last(key)].append(key)
        else:
            rec["pos"] = rec["pos"] or row.pos
            rec["team"] = rec["team"] or row.team
            # First source to state an age wins. Sources are visited widest
            # first, and a player's age does not depend on who is ranking him.
            if rec.get("age") is None:
                rec["age"] = _age_of(row)
        return rec

    for src in ordered:
        for row in src.frame.itertuples(index=False):
            key = row.name_key
            # Alias file wins outright.
            if key in alias_keys:
                key = name_key(alias_keys[key])

            if key in players:
                _record(register(key, row), src.id, row)
                continue

            # Fuzzy fallback, position-guarded.
            best_key, best_score = None, 0.0
            for cand in by_last.get(_last(key), []):
                cand_pos = players[cand]["pos"]
                if row.pos and cand_pos and row.pos != cand_pos:
                    continue
                score = _similar(key, cand)
                if score > best_score:
                    best_key, best_score = cand, score

            if best_key and best_score >= ACCEPT and _first_names_compatible(key, best_key):
                review.append({
                    "action": "auto-merged",
                    "source": src.id,
                    "incoming": row.player_raw,
                    "matched_to": players[best_key]["player"],
                    "score": round(best_score, 3),
                })
                _record(register(best_key, row), src.id, row)
            else:
                if best_key and best_score >= ACCEPT:
                    review.append({
                        "action": "rejected-by-first-name-guard",
                        "source": src.id,
                        "incoming": row.player_raw,
                        "nearest": players[best_key]["player"],
                        "score": round(best_score, 3),
                        "note": "same surname and position, different first name; kept separate",
                    })
                elif best_key and best_score >= REVIEW:
                    review.append({
                        "action": "kept-separate-needs-review",
                        "source": src.id,
                        "incoming": row.player_raw,
                        "nearest": players[best_key]["player"],
                        "score": round(best_score, 3),
                    })
                _record(register(key, row), src.id, row)

    table = pd.DataFrame(
        [
            {
                "name_key": r["name_key"],
                "player": r["player"],
                "pos": r["pos"],
                "team": r["team"],
                "age": r.get("age"),
                **{f"rank__{sid}": r["ranks"].get(sid) for sid in (s.id for s in sources)},
                **{f"raw__{sid}": r["raw"].get(sid) for sid in (s.id for s in sources)},
            }
            for r in players.values()
        ]
    )
    return table, review
