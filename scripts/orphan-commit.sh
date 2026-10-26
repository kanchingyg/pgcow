#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GIT_AUTHOR_NAME="Augusto Cerrutti"
export GIT_AUTHOR_EMAIL="augustocerruttisatto@gmail.com"
export GIT_COMMITTER_NAME="Augusto Cerrutti"
export GIT_COMMITTER_EMAIL="augustocerruttisatto@gmail.com"
git read-tree --empty
git add -A
TREE=$(git write-tree)
COMMIT=$(git commit-tree "$TREE" -m "feat: initial release v0.1.0")
git update-ref refs/heads/main "$COMMIT"
git reset --hard
echo "COMMIT=$COMMIT"
git log -1 --format=fuller
