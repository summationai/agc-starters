#!/bin/sh
# Builds the starters release asset that `agc init --stack <name>` downloads, and prints its sha256 for the CLI's pin.
#
#   scripts/release.sh v1.0.0              build dist/starters-v1.0.0.tgz from the tag, print the sha256
#   scripts/release.sh v1.0.0 --publish    the same, then create the GitHub Release with the file attached
#
# The tarball holds every stack directory, SPEC.md and LICENSE, exactly as committed at the tag. Each starter's
# conformance.toml stays out: .gitattributes marks it export-ignore, since agc init doesn't copy it. git archive's
# output is fixed for a commit, and gzip -n leaves out the name and time, so the same tag builds the same bytes with the
# same gzip. A release asset never changes once uploaded, so the CLI's sha256 pin holds. (GitHub's own source
# tarballs aren't guaranteed byte-stable.)
set -eu
tag="${1:?usage: scripts/release.sh <tag> [--publish]}"
cd "$(dirname "$0")/.."
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "no tag $tag: tag the commit first (git tag $tag && git push origin $tag)" >&2; exit 1; }
# What goes in must be at the tag, not just in the working tree.
for f in SPEC.md LICENSE; do git cat-file -e "$tag:$f" 2>/dev/null || { echo "$f is missing at $tag: commit it, then tag again" >&2; exit 1; }; done
mkdir -p dist
out="dist/starters-$tag.tgz"
# To a file first, not a pipe: sh has no pipefail, so a failing git archive would still leave gzip's empty output.
rm -f "dist/starters-$tag.tar" "$out"
stacks=$(scripts/archive.sh "$tag" "dist/starters-$tag.tar")
gzip -9 -n -c "dist/starters-$tag.tar" > "$out"
rm -f "dist/starters-$tag.tar"
[ "$(wc -c < "$out")" -gt 1024 ] || { echo "$out is suspiciously small" >&2; exit 1; }
sum=$(shasum -a 256 "$out" 2>/dev/null || sha256sum "$out")
sum=${sum%% *}
echo "$out"
echo "stacks: $(echo $stacks)"
echo "sha256: $sum"
if [ "${2:-}" = "--publish" ]; then
  gh release create "$tag" "$out" --title "Starters $tag" --notes "Starters for \`agc init --stack\`: $(echo $stacks | sed 's/ /, /g'). Each passes SPEC.md.

\`starters-$tag.tgz\` sha256: \`$sum\`"
fi
