"""Name, position and team canonicalization.

Everything that needs to compare two player names goes through `name_key`.
"""
from __future__ import annotations

import re
import unicodedata

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")
_PAREN = re.compile(r"\s*\([^)]*\)")

POSITION_ALIASES = {
    "DEF": "DST",
    "D/ST": "DST",
    "DST": "DST",
    "PK": "K",
    "K": "K",
    "QB": "QB",
    "RB": "RB",
    "WR": "WR",
    "TE": "TE",
}

#: Positions the draft board actually ranks.
SKILL_POSITIONS = ("QB", "RB", "WR", "TE")


def name_key(value: object) -> str:
    """Collapse a player name to a comparison key.

    Strips accents, punctuation, generational suffixes and parenthetical tags,
    so that "De'Von Achane", "DeVon Achane" and "achane" all reduce cleanly.
    """
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = _PAREN.sub("", text)
    text = text.lower().replace("&", "and")
    text = re.sub(r"[.'’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = _SUFFIX.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_position(value: object) -> str | None:
    """Map a raw position tag onto the canonical set."""
    if value is None:
        return None
    token = str(value).strip().upper()
    if not token or token == "NAN":
        return None
    # Sources sometimes carry positional ranks like "QB1" or "WR12".
    token = re.sub(r"\d+$", "", token)
    return POSITION_ALIASES.get(token, token or None)


def normalize_team(value: object) -> str | None:
    """Upper-case an NFL team abbreviation, tolerating blanks and stray spaces."""
    if value is None:
        return None
    token = str(value).strip().upper()
    # Exports scraped out of a web page carry HTML entities and literal
    # non-breaking spaces where a free agent has no team. Both mean "no team".
    token = token.replace("&NBSP;", "").replace("\u00a0", "").strip()
    if not token or token in {"NAN", "-", "DST", "FA", "NONE"}:
        return None
    return token


def is_arrow(value: object) -> bool:
    """True for the snake-direction marker columns in the history sheets."""
    token = str(value).strip()
    if not token:
        return False
    return set(token) <= set("-<>→←")
