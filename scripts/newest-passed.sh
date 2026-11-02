#!/bin/sh
# The newest commit on main whose conformance run, on a push, passed: what .github/workflows/release.yml releases, whichever
# run woke it. A run GitHub's concurrency dropped (it keeps one pending run, not a queue) or one that finished out of order
# then loses nothing: a later run releases the newest passed commit, and with it every change before it.
# Looks back at most 50 commits of the ref's first-parent history. GH_TOKEN and GITHUB_REPOSITORY must be set.
#
#   scripts/newest-passed.sh [<ref>]     (default origin/main)
set -eu
ref="${1:-origin/main}"
for c in $(git rev-list --first-parent -n 50 "$ref"); do
  n=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/conformance.yml/runs?head_sha=$c&event=push&status=success&per_page=1" --jq .total_count)
  if [ "$n" -gt 0 ]; then echo "$c"; exit 0; fi
done
echo "none of $ref's last 50 commits passed conformance on a push" >&2
exit 1
