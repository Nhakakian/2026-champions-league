PER-POSITION RANKING FILES
==========================

A ranker's own positional board, when they publish one separately from their
overall list. Referenced from config/sources.yml by `positional_file`.

This folder is deliberately NOT the drop zone. pipeline/sources.discover()
only scans data/sources/ itself, so nothing in here is ever mistaken for a
ranking source and auto-registered at weight 0.

Expected layout: one row per player with Pos, Rank (restarting at 1 within
each position), Player and Tier. Positions may be stacked in any order.
