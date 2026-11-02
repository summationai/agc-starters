#!/bin/sh
# Which release a commit on main gets, for .github/workflows/release.yml (CONTRIBUTING.md, "Releasing"). Prints one line:
#
#   new v1.2.4        tag the commit v1.2.4, then publish it: the next patch after the highest vX.Y.Z tag
#   publish v1.3.0    the commit already has this tag, and the tag has no GitHub Release yet: publish it
#   none <why>        nothing to release: it's released already, a later release holds it, or the archive is unchanged
#
#   scripts/next-release.sh <commit>
#
# A release is due when what scripts/archive.sh builds at the commit differs from what it builds at the last tag: any file
# added, removed or changed, or its executable bit, whatever caused it (a stack, SPEC.md, LICENSE or .gitattributes).
# `gh` answers whether a tag has its Release; GH_TOKEN must be set.
set -eu
sha=$(git rev-parse --verify "${1:?usage: scripts/next-release.sh <commit>}^{commit}")
cd "$(dirname "$0")/.."
have=$(git tag --points-at "$sha" --list 'v*' | sort -V | tail -n 1)
if [ -n "$have" ]; then
  if gh release view "$have" >/dev/null 2>&1; then echo "none $sha is released already, as $have"; else echo "publish $have"; fi
  exit 0
fi
last=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
[ -n "$last" ] || { echo "no vX.Y.Z tag to count on from: tag and release the first one by hand" >&2; exit 1; }
if ! git merge-base --is-ancestor "$last" "$sha"; then
  # A commit whose run finished after a later one's was released: that release holds it already.
  if git merge-base --is-ancestor "$sha" "$last"; then echo "none $sha is in $last already"; exit 0; fi
  echo "$last isn't in $sha's history, so there's no next patch to give it" >&2
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
held() {
  mkdir "$work/$2"
  scripts/archive.sh "$1" "$work/$2.tar" >/dev/null
  tar -x -f "$work/$2.tar" -C "$work/$2"
  (cd "$work/$2" && find . -type f -perm -u+x | sort) > "$work/$2.exec"
}
held "$last" was
held "$sha" now
if diff -r "$work/was" "$work/now" >/dev/null && cmp -s "$work/was.exec" "$work/now.exec"; then
  echo "none what a release holds is unchanged since $last"
  exit 0
fi
rest=${last#v}
major=${rest%%.*}; rest=${rest#*.}
minor=${rest%%.*}; patch=${rest#*.}
echo "new v$major.$minor.$((patch + 1))"
