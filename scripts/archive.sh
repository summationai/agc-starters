#!/bin/sh
# What a starters release holds at a revision, as one tar: every stack (a directory with agentcloud.toml), SPEC.md and
# LICENSE, exactly as committed, with the revision's .gitattributes applied (each conformance.toml is export-ignore).
# It fails, leaving no archive, when SPEC.md, LICENSE or a stack's agentcloud.toml or AGENTS.md isn't in it.
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
# What agc init needs from a release (STK-6 in agent-cloud's docs/specs/init-stack.md) must be in the archive itself, not
# only in the tree: a .gitattributes export-ignore can leave a file out of git archive's output.
listed=$(tar -tf "$out")
for s in $stacks; do need="${need:-} $s/agentcloud.toml $s/AGENTS.md"; done
for f in SPEC.md LICENSE $need; do
  printf '%s\n' "$listed" | grep -qxF "$f" || { rm -f "$out"; echo "$f is missing from the archive at $rev: is .gitattributes leaving it out?" >&2; exit 1; }
done
# shellcheck disable=SC2086 # one line, the names apart by spaces
echo $stacks
