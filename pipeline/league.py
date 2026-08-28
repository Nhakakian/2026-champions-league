"""League-specific tendency model and value flags.

There is no historical ADP for 2023-2025, so we do not compare picks against a
market baseline we don't have. Instead we build a POSITIONAL SLOT CURVE.

For each year and position, picks are sorted by overall pick number and indexed
(QB1, QB2, ... QBn). Averaged across the three years this yields "in this league
QB7 goes around pick 48". The market curve is built the same way from current
ADP: the 7th-best QB by ADP has some global ADP rank, and that rank IS the pick
they'd go at in a pure-market draft. Both curves therefore live on the same
overall-pick axis and subtract cleanly.

    delta = market_expected_pick - league_actual_pick

    delta > 0   league takes this slot EARLIER than the market  -> must reach
    delta < 0   league lets this slot FALL                      -> can wait
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .normalize import SKILL_POSITIONS


def positional_slot_curve(picks: pd.DataFrame, min_years: int = 2) -> pd.DataFrame:
    """Mean overall pick at which each positional slot goes, across years."""
    rows = []
    for (year, pos), block in picks.groupby(["year", "pos"]):
        ordered = block.sort_values("overall")
        for slot, (_, rec) in enumerate(ordered.iterrows(), start=1):
            rows.append({"year": year, "pos": pos, "pos_slot": slot,
                         "overall": rec["overall"]})
    long = pd.DataFrame(rows)
    if long.empty:
        return long

    curve = (
        long.groupby(["pos", "pos_slot"])["overall"]
        .agg(league_pick="mean", spread="std", years_observed="count")
        .reset_index()
    )
    curve = curve[curve["years_observed"] >= min_years].copy()
    curve["league_pick"] = curve["league_pick"].round(1)
    curve["spread"] = curve["spread"].round(1)
    return curve


def market_slot_curve(board: pd.DataFrame, adp_source: str, max_picks: int) -> pd.DataFrame:
    """Where the market would take each positional slot, on the pick axis.

    The pool is truncated to the top `max_picks` by ADP first. Without this the
    two curves sit on different axes: the ranking pool runs ~240 deep while the
    league only ever makes teams x rounds picks, which manufactures a large
    fake 'reach' at every late positional slot.
    """
    col = f"rank__{adp_source}"
    if col not in board.columns:
        return pd.DataFrame(columns=["pos", "pos_slot", "market_pick"])

    ranked = board[board[col].notna()].copy()
    # Global ADP order == the pick a player goes at in a pure-market draft.
    ranked["market_pick"] = ranked[col].rank(method="first")
    ranked = ranked[ranked["market_pick"] <= max_picks].sort_values("market_pick")
    ranked["pos_slot"] = ranked.groupby("pos").cumcount() + 1
    return ranked[["pos", "pos_slot", "market_pick"]]


def build_tendencies(
    picks: pd.DataFrame,
    board: pd.DataFrame,
    adp_source: str,
    min_years: int = 2,
    max_picks: int = 160,
    early_picks: int = 60,
) -> tuple[pd.DataFrame, dict]:
    """Join league and market curves; return the curve plus summary stats."""
    league_curve = positional_slot_curve(picks, min_years=min_years)
    market_curve = market_slot_curve(board, adp_source, max_picks=max_picks)

    if league_curve.empty or market_curve.empty:
        return pd.DataFrame(), {}

    curve = league_curve.merge(market_curve, on=["pos", "pos_slot"], how="inner")
    curve["delta"] = (curve["market_pick"] - curve["league_pick"]).round(1)

    summary = {}
    for pos in SKILL_POSITIONS:
        block = curve[curve["pos"] == pos]
        if block.empty:
            continue
        # The early rounds are where the draft is actually won, and late slots
        # are noisy, so the headline read is driven by the early window.
        early = block[block["league_pick"] <= early_picks]
        headline = float(early["delta"].mean()) if len(early) else float(block["delta"].mean())
        summary[pos] = {
            "slots_compared": int(len(block)),
            "mean_delta": round(float(block["delta"].mean()), 1),
            "early_delta": round(headline, 1),
            "early_slots": int(len(early)),
            "reads": _describe(pos, headline),
        }
    return curve, summary


def _describe(pos: str, delta: float) -> str:
    if delta > 8:
        return f"{pos}s go earlier here than the market - plan to reach."
    if delta < -8:
        return f"{pos}s consistently fall here - you can wait on {pos}."
    return f"{pos} timing tracks the market closely."


def round_position_mix(picks: pd.DataFrame) -> list[dict]:
    """Position mix by round across all years — the 'who reaches when' table."""
    table = pd.crosstab(picks["round"], picks["pos"])
    out = []
    for rnd, row in table.iterrows():
        total = int(row.sum())
        out.append({
            "round": int(rnd),
            "total": total,
            "counts": {p: int(row.get(p, 0)) for p in table.columns},
            "pct": {p: round(float(row.get(p, 0)) / total * 100, 1) for p in table.columns},
        })
    return out


def apply_flags(
    board: pd.DataFrame,
    curve: pd.DataFrame,
    adp_source: str,
    value_threshold: float = 8.0,
    reach_threshold: float = 8.0,
    market_value: float = 15.0,
    market_reach: float = 15.0,
    volatile: float = 0.20,
    thin_coverage: float = 60.0,
) -> pd.DataFrame:
    """Attach league-adjusted value flags to each current-year player."""
    out = board.copy()
    out["league_delta"] = np.nan
    out["league_pick"] = np.nan
    out["market_pick"] = np.nan

    if not curve.empty:
        lookup = curve.set_index(["pos", "pos_slot"])
        for idx, row in out.iterrows():
            key = (row["pos"], int(row["pos_rank"]) if pd.notna(row["pos_rank"]) else None)
            if key[1] is None or key not in lookup.index:
                continue
            rec = lookup.loc[key]
            out.at[idx, "league_delta"] = rec["delta"]
            out.at[idx, "league_pick"] = rec["league_pick"]
            out.at[idx, "market_pick"] = rec["market_pick"]

    # Market divergence: composite opinion vs what the player actually costs.
    adp_col = f"rank__{adp_source}"
    if adp_col in out.columns:
        out["adp_delta"] = (out[adp_col] - out["composite_rank"]).round(1)
    else:
        out["adp_delta"] = np.nan

    flags: list[list[str]] = []
    for _, row in out.iterrows():
        tags = []
        d = row["league_delta"]
        if pd.notna(d):
            if d >= reach_threshold:
                tags.append("LEAGUE_REACH")
            elif d <= -value_threshold:
                tags.append("LEAGUE_VALUE")
        a = row["adp_delta"]
        if pd.notna(a):
            if a >= market_value:
                tags.append("MARKET_VALUE")
            elif a <= -market_reach:
                tags.append("MARKET_REACH")
        if pd.notna(row.get("disagreement")) and row["disagreement"] >= volatile:
            tags.append("VOLATILE")
        if row.get("missing_weight_pct", 0) > thin_coverage:
            tags.append("THIN_COVERAGE")
        flags.append(tags)

    out["flags"] = flags
    return out


def roster_pace(picks: pd.DataFrame) -> list[dict]:
    """Average roster composition per team after each round.

    This is what the Draft page measures your roster against. It is derived
    from what this league actually does rather than from invented lineup rules,
    so it needs no assumption about starter slots to be useful: "by round 8 the
    typical team here has 1.8 QBs and you have 1" is a real, checkable gap.
    """
    if picks.empty:
        return []
    rows = []
    max_round = int(picks["round"].max())
    positions = sorted(picks["pos"].dropna().unique())
    n_teams = picks.groupby("year")["owner"].nunique().max()

    for rnd in range(1, max_round + 1):
        upto = picks[picks["round"] <= rnd]
        entry = {"round": rnd, "avg": {}}
        for pos in positions:
            # Total picks of this position, spread over every team-year.
            team_years = upto.groupby(["year", "owner"]).ngroups or 1
            entry["avg"][pos] = round(
                float((upto["pos"] == pos).sum()) / team_years, 2
            )
        rows.append(entry)
    return rows


def owner_profiles(picks: pd.DataFrame) -> list[dict]:
    """Per-manager positional lean — useful for reading the room live."""
    rows = []
    for owner, block in picks.groupby("owner"):
        counts = block["pos"].value_counts()
        early = block[block["round"] <= 6]["pos"].value_counts()
        rows.append({
            "owner": owner,
            "picks": int(len(block)),
            "by_pos": {p: int(counts.get(p, 0)) for p in counts.index},
            "first_6_rounds": {p: int(early.get(p, 0)) for p in early.index},
            "first_qb_round": _first_round(block, "QB"),
            "first_rb_round": _first_round(block, "RB"),
        })
    return sorted(rows, key=lambda r: r["owner"])


def _first_round(block: pd.DataFrame, pos: str):
    per_year = block[block["pos"] == pos].groupby("year")["round"].min()
    return round(float(per_year.mean()), 1) if len(per_year) else None
