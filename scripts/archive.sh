#!/bin/sh
# What a starters release holds at a revision, as one tar: every stack (a directory with agentcloud.toml), SPEC.md and
# LICENSE, exactly as committed, with the revision's .gitattributes applied (each conformance.toml is export-ignore).
# scripts/release.sh publishes it, and scripts/next-release.sh compares two of them. Prints the stacks' names.
#
#   scripts/archive.sh <revision> <out.tar>
set -eu
rev="${1:?usage: scripts/archive.sh <revision> <out.tar>}"
out="${2:?usage: scripts/archive.sh <revision> <out.tar>}"
stacks=$(git ls-tree -d --name-only "$rev" | while read -r d; do
  if git cat-file -e "$rev:$d/agentcloud.toml" 2>/dev/null; then echo "$d"; fi
done)
[ -n "$stacks" ] || { echo "no stack at $rev" >&2; exit 1; }
rm -f "$out"
# shellcheck disable=SC2086 # the stack names are plain directory names
git archive --format=tar -o "$out" "$rev" $stacks SPEC.md LICENSE
# shellcheck disable=SC2086 # one line, the names apart by spaces
echo $stacks
