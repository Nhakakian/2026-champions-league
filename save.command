#!/bin/bash
# Double-click this file to save every change and push it to GitHub.
cd "$(dirname "$0")" || exit 1

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing changed -- already saved."
else
  git add -A
  git commit -m "Update $(date '+%Y-%m-%d %H:%M')"
fi

echo "Pushing to GitHub..."
if git push; then
  echo
  echo "Saved. Your other computer can get it with: git pull"
else
  echo
  echo "Push failed -- see the error above."
fi

echo
read -n 1 -s -r -p "Press any key to close."
