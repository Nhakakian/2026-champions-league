#!/bin/bash
# Double-click this AFTER you change something. It saves your work,
# pulls in anything from your other computer, and pushes to GitHub.
cd "$(dirname "$0")" || exit 1

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing changed here."
else
  git add -A
  git commit -m "Update $(date '+%Y-%m-%d %H:%M')"
  echo
fi

# Pull first, so a push can't be rejected because the other computer
# got there first. --rebase keeps the history tidy.
echo "Checking for changes from your other computer..."
if ! git pull --rebase; then
  echo
  echo "The same file changed on both computers, so this needs a human."
  echo "Nothing is lost. Ask Claude to sort it out."
  echo
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo
echo "Pushing to GitHub..."
if git push; then
  echo
  echo "Saved. The website updates in about a minute."
  echo "On your other computer, double-click update.command."
else
  echo
  echo "Push failed -- see the error above."
fi

echo
read -n 1 -s -r -p "Press any key to close."
