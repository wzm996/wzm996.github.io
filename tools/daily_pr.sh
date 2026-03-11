#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Update from origin
git fetch origin
git checkout master
git pull --ff-only origin master

# Create a branch for today
DATE="$(date +%F)"
BRANCH="openclaw/daily-${DATE}"

git checkout -B "$BRANCH"

# Generate today's post (if it already exists, script exits 2; treat as no-op)
set +e
npm run daily
RC=$?
set -e
if [ $RC -eq 2 ]; then
  echo "Daily post already exists for $DATE; exiting."
  exit 0
elif [ $RC -ne 0 ]; then
  echo "Daily post generation failed with code $RC"
  exit $RC
fi

# Commit
git add source/_posts
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "feat(blog): daily post ${DATE}"

git push -u origin "$BRANCH"

# Create PR (idempotent)
# If PR already exists, gh will fail; we ignore and print info.
set +e
gh pr create --repo wzm996/wzm996.github.io \
  --base master \
  --head "$BRANCH" \
  --title "Daily post: ${DATE}" \
  --body "Automated daily post for ${DATE}." 
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "PR may already exist; you can check with: gh pr list --repo wzm996/wzm996.github.io"
fi
