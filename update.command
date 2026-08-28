#!/bin/bash
# Double-click BEFORE you start working, to pull down whatever your
# other computer pushed. Safe to run any time.
cd "$(dirname "$0")" || exit 1

if [ -n "$(git status --porcelain)" ]; then
  echo "You have unsaved changes here. Saving them first so nothing is lost."
  git add -A
  git commit -m "Local changes $(date '+%Y-%m-%d %H:%M')"
  echo
fi

echo "Getting the latest from GitHub..."
if git pull --rebase; then
  echo
  echo "Up to date. Open webapp/index.html, or just use the website."
else
  echo
  echo "Couldn't merge automatically -- the same file changed on both"
  echo "computers. Nothing is lost. Ask Claude to sort it out."
fi

echo
read -n 1 -s -r -p "Press any key to close."
