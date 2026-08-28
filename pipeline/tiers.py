"""Automatic tiering from statistically meaningful gaps in composite score.

Within a position, walk players in composite order and cut a tier wherever the
gap to the next player is large relative to that position's OWN gap
distribution. Using each position's own distribution matters: WR gaps are
naturally tighter than QB gaps because the position is deeper.

The JS in webapp/app.js mirrors this so live weight changes re-tier correctly.
Keep the two implementations in step.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _local_thresholds(gaps: np.ndarray, z: float, window: int = 15) -> np.ndarray:
    """Rolling median + MAD cut threshold, one per gap.

    Median/MAD rather than mean/sd so that one huge cliff (the drop off the
    elite tier) doesn't inflate the threshold and suppress every nearby cut.
    """
    n = len(gaps)
    half = max(2, window // 2)
    out = np.empty(n, dtype=float)
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        local = gaps[lo:hi]
        median = float(np.median(local))
        mad = float(np.median(np.abs(local - median)))
        if mad <= 0:
            mad = float(local.std()) or 1e-9
        out[i] = median + z * 1.4826 * mad
    return out


def assign(
    frame: pd.DataFrame,
    positions: tuple[str, ...] = ("QB", "RB", "WR", "TE"),
    gap_z_threshold: float = 1.0,
    min_tier_size: int = 2,
    max_tier_size: int = 12,
) -> pd.DataFrame:
    """Attach a per-position `tier` column."""
    out = frame.copy()
    out["tier"] = pd.NA

    for pos in positions:
        mask = out["pos"] == pos
        block = out.loc[mask].sort_values("composite_score")
        if len(block) < 2:
            out.loc[block.index, "tier"] = 1
            continue

        scores = block["composite_score"].to_numpy(dtype=float)
        gaps = np.diff(scores)

        # Threshold is computed in a LOCAL window rather than once per position.
        # Composite score is log-rank, so gaps compress steadily as rank grows:
        # a single global threshold cuts freely at the top and never at the
        # bottom, which leaves max_tier_size doing the tiering in the tail --
        # arbitrary chunks, not meaningful ones. A rolling median + MAD adapts
        # to that compression so a real cliff still registers deep in the pool.
        thresholds = _local_thresholds(gaps, gap_z_threshold)

        tiers = np.ones(len(block), dtype=int)
        current, size = 1, 1
        for i, gap in enumerate(gaps, start=1):
            cut = gap >= thresholds[i - 1] and size >= min_tier_size
            if size >= max_tier_size:
                cut = True
            if cut:
                current += 1
                size = 0
            tiers[i] = current
            size += 1

        out.loc[block.index, "tier"] = tiers

    out["tier"] = out["tier"].astype("Int64")
    return out


def summarize(frame: pd.DataFrame) -> list[dict]:
    """Per-position tier sizes and rank spans, for diagnostics."""
    rows = []
    for (pos, tier), block in frame.dropna(subset=["tier"]).groupby(["pos", "tier"]):
        rows.append({
            "pos": pos,
            "tier": int(tier),
            "size": int(len(block)),
            "best_rank": int(block["composite_rank"].min()),
            "worst_rank": int(block["composite_rank"].max()),
            "players": block.sort_values("composite_rank")["player"].tolist(),
        })
    return sorted(rows, key=lambda r: (r["pos"], r["tier"]))
