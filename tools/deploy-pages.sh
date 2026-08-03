#!/usr/bin/env bash
#
# Publish the built site to the `gh-pages` branch, which GitHub Pages serves.
#
# Why a branch and not a GitHub Actions workflow: pushing anything under
# `.github/workflows/` needs the `workflow` OAuth scope, and the token this was
# set up with has only `gist`, `read:org` and `repo`. A branch deploy needs no
# extra scope. If you ever want CI to do this instead, re-auth with
# `gh auth refresh -s workflow` and the usual actions/deploy-pages job works.
#
# The branch is pure build output, so each deploy is a fresh ORPHAN commit rather
# than a new commit on top of the last one — there is no history worth carrying
# and this keeps the repo from growing a 1.3 MB bundle per deploy forever.
#
# ALPINE_BASE must match the repo name: a Pages project site is served from
# `/<repo>/`, and `vite.config.js` defaults to '/' so the dev server and every
# tool in `tools/` keep working. Change both together or the bundle 404s.
set -euo pipefail

BASE_PATH="${ALPINE_BASE:-/ski-sim-web/}"
BRANCH="${PAGES_BRANCH:-gh-pages}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: working tree is dirty — deploying the BUILD of it, tagged $SHA" >&2
fi

echo "building with base $BASE_PATH"
ALPINE_BASE="$BASE_PATH" npx vite build

test -f dist/index.html || { echo "no dist/index.html — build failed" >&2; exit 1; }

WT="$(mktemp -d)"
cleanup() { cd "$ROOT"; git worktree remove --force "$WT" 2>/dev/null || true; rm -rf "$WT"; }
trap cleanup EXIT

git worktree add --detach "$WT" >/dev/null 2>&1
(
  cd "$WT"
  git checkout --orphan "$BRANCH" >/dev/null 2>&1
  git rm -rf . --quiet >/dev/null 2>&1 || true
  cp -R "$ROOT/dist/." .
  # Jekyll is on by default on Pages and would skip any path starting with an
  # underscore. Nothing here has one today, but a future asset name is one
  # rename away from a silent 404.
  touch .nojekyll
  git add -A -f >/dev/null
  git commit -q -m "Deploy $SHA (base $BASE_PATH)"
  git push -f -q origin "$BRANCH"
)
echo "pushed $BRANCH from $SHA"
