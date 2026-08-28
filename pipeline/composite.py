"""Weighted composite ranking.

Weighted mean of log(rank), i.e. a weighted geometric mean. Rank distance is
not linear — 1 -> 6 is a chasm, 140 -> 145 is noise — and log space respects
that where a plain arithmetic average does not.

Also emits a disagreement metric (weighted spread of log rank), which is the
boom/bust signal and costs nothing extra to compute.

SOURCE SCOPE
------------
A source in the wrong scoring format is not worthless, it is just wrong about
one thing. A 1QB half-PPR list in a superflex league has Josh Allen far too
low, because it is answering "how valuable is a QB relative to a RB" for a
different league. But its answer to "which RB is better" is still good.

So a source can be scoped:

    overall     ranks players ACROSS positions; sets cross-position value
    positional  only trusted for order WITHIN a position

When any positional source is present, the composite is built in two passes:

    1. ANCHOR  — overall sources only. This fixes the value curve: what an
                 overall rank is worth at QB1, QB2, RB1, RB2 and so on.
    2. BLEND   — every source, including positional ones. This decides WHO
                 deserves each of those slots inside a position.

Then within each position the anchor's own scores are handed out in blend
order. The cross-position shape stays exactly as the format-correct source
had it, while the extra opinion still moves players up and down their own
position board. One board, correct QB values, nothing thrown away.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class _Pass:
    score: np.ndarray
    present_count: np.ndarray
    missing_pct: np.ndarray
    disagreement: np.ndarray
    present_weight: np.ndarray
    floor: float


def _weighted_pass(
    table: pd.DataFrame,
    weights: dict[str, float],
    source_ids: list[str],
    missing_penalty: float,
) -> _Pass:
    """One weighted geometric-mean pass over the given sources."""
    rank_cols = {sid: table[f"rank__{sid}"] for sid in source_ids}
    total_weight = sum(max(0.0, weights[sid]) for sid in source_ids)
    if total_weight <= 0:
        raise ValueError("all source weights are zero — set a weight in config/sources.yml")

    worst = {sid: float(np.nanmax(col.values)) if col.notna().any() else 1.0
             for sid, col in rank_cols.items()}

    log_scores, weight_present = [], []
    for sid in source_ids:
        w = max(0.0, weights[sid])
        col = rank_cols[sid]
        # log1p keeps rank 1 finite and preserves ordering.
        log_scores.append(np.log1p(col.fillna(worst[sid]).values.astype(float)))
        weight_present.append(np.where(col.notna().values, w, 0.0))

    log_matrix = np.vstack(log_scores)               # sources x players
    weight_matrix = np.vstack(weight_present)
    present_weight = weight_matrix.sum(axis=0)

    safe = np.where(present_weight > 0, present_weight, 1.0)
    weighted_mean = (log_matrix * weight_matrix).sum(axis=0) / safe

    # Omission penalty: push a player down in proportion to the weight that
    # declined to rank them at all. A source leaving someone off is a signal.
    missing_fraction = 1.0 - (present_weight / total_weight)
    floor = math.log1p(max(worst.values()))
    score = weighted_mean + missing_penalty * missing_fraction * (floor - weighted_mean)
    score = np.where(present_weight > 0, score, floor)

    diff = log_matrix - weighted_mean
    var = (weight_matrix * diff ** 2).sum(axis=0) / safe
    counts = (weight_matrix > 0).sum(axis=0)
    return _Pass(
        score=score,
        present_count=counts,
        missing_pct=np.round(missing_fraction * 100, 1),
        disagreement=np.where(counts >= 2, np.round(np.sqrt(np.clip(var, 0, None)), 4), np.nan),
        present_weight=present_weight,
        floor=floor,
    )


def _break_floor_ties(
    table: pd.DataFrame,
    score: np.ndarray,
    present_weight: np.ndarray,
    source_ids: list[str],
    floor: float,
) -> np.ndarray:
    """Spread players no weighted source ranks, using any source that does.

    Applied AFTER the positional transplant, because the transplant reassigns
    per-position scores and would otherwise wipe the spread out — leaving the
    whole tail tied at the floor and ordered by whatever the row order happened
    to be. They still sort below everyone with a real score.
    """
    idx = np.where(present_weight <= 0)[0]
    if not len(idx):
        return score
    fallback = np.full(len(table), np.nan)
    for sid in source_ids:
        col = table[f"rank__{sid}"].values.astype(float)
        fallback = np.where(np.isnan(fallback), col, np.fmin(fallback, col))
    values = fallback[idx]
    finite = np.isfinite(values)
    # Ranking a NaN would produce a NaN score and quietly corrupt the sort, so
    # anyone with nothing to sort on simply stays at the floor.
    if finite.any():
        order = pd.Series(values[finite]).rank(method="first").values
        score = score.copy()
        score[idx[finite]] = floor + order / (int(finite.sum()) + 1)
    return score


def _positional_disagreement(
    table: pd.DataFrame,
    weights: dict[str, float],
    source_ids: list[str],
) -> np.ndarray:
    """Weighted spread of log(rank WITHIN position) across sources.

    Measured inside the position on purpose. Comparing raw overall ranks makes
    every quarterback look wildly contested the moment a 1QB list is in the
    mix -- Josh Allen is 3rd on one and 26th on the other -- when that gap is
    the scoring format, not a real difference of opinion about him. Ranking
    within position cancels the format out, so what is left is genuine
    disagreement: two sources arguing about where a player sits among his own
    positional peers.
    """
    pos = table["pos"]
    logs, wts = [], []
    for sid in source_ids:
        w = max(0.0, weights[sid])
        within = table.groupby(pos, dropna=False)[f"rank__{sid}"].rank(method="min")
        logs.append(np.log1p(within.values.astype(float)))
        wts.append(np.where(within.notna().values, w, 0.0))

    log_matrix = np.vstack(logs)
    weight_matrix = np.vstack(wts)
    present = weight_matrix.sum(axis=0)
    safe = np.where(present > 0, present, 1.0)
    mean = np.nansum(np.nan_to_num(log_matrix) * weight_matrix, axis=0) / safe
    diff = np.nan_to_num(log_matrix - mean)
    var = (weight_matrix * diff ** 2).sum(axis=0) / safe
    counts = (weight_matrix > 0).sum(axis=0)
    return np.where(counts >= 2, np.round(np.sqrt(np.clip(var, 0, None)), 4), np.nan)


def _transplant(positions: np.ndarray, anchor: np.ndarray, blend: np.ndarray) -> np.ndarray:
    """Hand out the anchor's per-position value slots in blend order."""
    out = anchor.copy()
    for pos in pd.unique(positions[pd.notna(positions)]):
        idx = np.where(positions == pos)[0]
        if len(idx) < 2:
            continue
        slots = np.sort(anchor[idx])                                    # the value curve
        order = idx[np.argsort(blend[idx], kind="mergesort")]           # who earns each slot
        out[order] = slots
    return out


def compute(
    table: pd.DataFrame,
    weights: dict[str, float],
    missing_penalty: float = 0.35,
    scopes: dict[str, str] | None = None,
) -> pd.DataFrame:
    """Attach composite score, composite rank and disagreement columns."""
    scopes = scopes or {}
    source_ids = [sid for sid in weights if f"rank__{sid}" in table.columns]
    if not source_ids:
        raise ValueError("no ranking source columns present")

    weighted = [sid for sid in source_ids if max(0.0, weights[sid]) > 0]
    overall_ids = [sid for sid in weighted if scopes.get(sid, "overall") != "positional"]

    out = table.copy()
    blend = _weighted_pass(table, weights, source_ids, missing_penalty)

    if overall_ids and len(overall_ids) < len(weighted):
        # At least one positional source is in play: anchor the cross-position
        # value curve on the format-correct sources only.
        anchor = _weighted_pass(table, weights, overall_ids, missing_penalty)
        score = _transplant(table["pos"].values, anchor.score, blend.score)
    else:
        # Every weighted source is format-correct (or none is) — nothing to fix.
        score = blend.score

    score = _break_floor_ties(table, score, blend.present_weight, source_ids, blend.floor)

    out["composite_score"] = score
    out["sources_ranking"] = blend.present_count
    out["missing_weight_pct"] = blend.missing_pct
    out["disagreement"] = _positional_disagreement(table, weights, source_ids)

    # Sort on (score, name): an explicit tiebreak, so the board is identical
    # whatever order the sources happened to be read in — and identical to the
    # JS mirror in webapp/core.js.
    out = out.sort_values(["composite_score", "player"], kind="mergesort").reset_index(drop=True)
    out["composite_rank"] = np.arange(1, len(out) + 1)
    out["pos_rank"] = out.groupby("pos")["composite_rank"].rank(method="first").astype("Int64")
    return out


def normalized_weights(specs: list[dict]) -> dict[str, float]:
    """Source weights normalized to sum to 1, so 60/40 == 0.6/0.4."""
    raw = {s["id"]: max(0.0, float(s.get("weight", 0.0))) for s in specs}
    total = sum(raw.values())
    if total <= 0:
        return raw
    return {k: v / total for k, v in raw.items()}
