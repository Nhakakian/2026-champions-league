DYNASTY RANKING FILES GO HERE
============================

Drop your dynasty rankings (.csv or .xlsx) into THIS folder, then run:

    python3 -m pipeline.build

Do NOT put them in data/sources/ -- that folder feeds the redraft board and
a dynasty list there would corrupt your Champions League rankings.

The build registers any new file in config/dynasty.yml at weight 0.0 and
prints the columns it found. Set the weight, re-run, and it's live.
