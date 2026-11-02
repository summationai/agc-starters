#!/bin/sh
# Tests for the release-on-merge scripts (CONTRIBUTING.md, "Releasing"), in a throwaway repository with a stand-in `gh`:
# what next-release.sh decides for each kind of change, and which commit newest-passed.sh picks. CI runs it on every PR.
#
#   sh scripts/test-release.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
failed=0
expect() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: expected \"$2\", got \"$3\""; failed=1; fi; }

# `gh release view <tag>` succeeds for the tags in $RELEASED; `gh api …runs?head_sha=<c>…` counts 1 for the commits in $PASSED.
mkdir "$t/bin"
cat > "$t/bin/gh" <<'GH'
#!/bin/sh
case "$1 $2" in
  "release view") case " ${RELEASED:-} " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac ;;
  api\ *) c=$(echo "$2" | sed -n 's/.*head_sha=\([0-9a-f]*\).*/\1/p'); case " ${PASSED:-} " in *" $c "*) echo 1 ;; *) echo 0 ;; esac ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
GH
chmod +x "$t/bin/gh"
PATH="$t/bin:$PATH"
export PATH RELEASED PASSED GITHUB_REPOSITORY=summationai/agc-starters

r="$t/repo"
mkdir -p "$r/scripts" "$r/ts"
cp "$here/archive.sh" "$here/next-release.sh" "$here/newest-passed.sh" "$here/release.sh" "$r/scripts/"
cd "$r"
git init -q -b main
g() { git -c user.name=test -c user.email=test@example.test "$@"; }
printf '[app]\nname = "starter"\n' > ts/agentcloud.toml
echo 'export const a = 1;' > ts/app.ts
echo '# the stack' > ts/AGENTS.md
echo '# the suite' > ts/conformance.toml
echo 'conformance.toml export-ignore' > .gitattributes
echo 'spec' > SPEC.md; echo 'license' > LICENSE; echo 'readme' > README.md
g add -A && g commit -qm one && g tag v1.0.0
RELEASED="v1.0.0"; PASSED=""
next() { scripts/next-release.sh "$1" 2>&1 | cut -d' ' -f1,2; }
change() { "$@"; g add -A; g commit -qm change; git rev-parse HEAD; }
back() { git reset -q --hard v1.0.0; }

expect "a released commit releases nothing" "none $(git rev-parse v1.0.0)" "$(next v1.0.0)"
c=$(change sh -c 'echo more >> README.md'); expect "a docs change releases nothing" "none what" "$(next "$c")"; back
c=$(change sh -c 'echo more >> ts/conformance.toml'); expect "a conformance.toml change releases nothing" "none what" "$(next "$c")"; back
c=$(change sh -c 'echo "export const b = 2;" >> ts/app.ts'); expect "a stack change is the next patch" "new v1.0.1" "$(next "$c")"; back
c=$(change sh -c 'echo more >> SPEC.md'); expect "a SPEC.md change is the next patch" "new v1.0.1" "$(next "$c")"; back
c=$(change sh -c 'mkdir py && printf "[app]\nname = \"starter\"\n" > py/agentcloud.toml && echo "# py" > py/AGENTS.md'); expect "a new stack is the next patch" "new v1.0.1" "$(next "$c")"; back
# security-agent on #35: .gitattributes changes what git archive holds without touching a stack.
# security-agent on #35, again: an archive missing what agc init needs is refused, never decided on or published.
refused() { if "$@" >/dev/null 2>&1; then echo went; else echo refused; fi; }
c=$(change sh -c 'echo "SPEC.md export-ignore" >> .gitattributes')
expect ".gitattributes leaving SPEC.md out is refused, not released" "refused" "$(refused scripts/next-release.sh "$c")"
expect "archive.sh says which file is missing" "SPEC.md is missing from the archive at $c: is .gitattributes leaving it out?" "$(scripts/archive.sh "$c" "$t/x.tar" 2>&1 >/dev/null)"
g tag v9.9.9 "$c"
expect "release.sh --publish refuses it too, and leaves no tarball" "refused, none left" "$(r=$(refused scripts/release.sh v9.9.9 --publish); if ls dist/starters-v9.9.9.* >/dev/null 2>&1; then echo "$r, one left"; else echo "$r, none left"; fi)"
g tag -d v9.9.9 >/dev/null; rm -rf dist; back
c=$(change sh -c 'echo "ts/AGENTS.md export-ignore" >> .gitattributes'); expect "a stack's AGENTS.md left out is refused" "refused" "$(refused scripts/next-release.sh "$c")"; back
c=$(change sh -c 'echo "LICENSE export-ignore" >> .gitattributes'); expect "LICENSE left out is refused" "refused" "$(refused scripts/next-release.sh "$c")"; back
c=$(change sh -c 'echo "README.md export-ignore" >> .gitattributes'); expect "a .gitattributes change to a file no release holds releases nothing" "none what" "$(next "$c")"; back
c=$(change sh -c 'echo "# a comment" >> .gitattributes'); expect "a .gitattributes change the archive doesn't show releases nothing" "none what" "$(next "$c")"; back
c=$(change sh -c 'chmod +x ts/app.ts'); expect "an executable bit is the next patch" "new v1.0.1" "$(next "$c")"; back
c=$(change sh -c 'echo "export const c = 3;" >> ts/app.ts'); g tag v1.1.0 "$c"
expect "a hand tag with no Release is published as it is" "publish v1.1.0" "$(next "$c")"
RELEASED="v1.0.0 v1.1.0"; expect "a hand tag with its Release releases nothing" "none $c" "$(next "$c")"
d=$(change sh -c 'echo "export const d = 4;" >> ts/app.ts'); expect "the next change after a hand tag counts on from it" "new v1.1.1" "$(next "$d")"
g tag v1.1.1 "$d"; RELEASED="v1.0.0 v1.1.0 v1.1.1"

# security-agent on #35: a run that's dropped, or finishes out of order, loses no passed commit. Each run releases the
# newest commit that passed, whichever woke it.
git update-ref refs/remotes/origin/main HEAD
a=$(change sh -c 'echo "export const e = 5;" >> ts/app.ts'); b=$(change sh -c 'echo "export const f = 6;" >> ts/app.ts')
git update-ref refs/remotes/origin/main "$b"
PASSED="$a $b"; expect "the newest passed commit is the tip when it passed" "$b" "$(scripts/newest-passed.sh)"
PASSED="$a"; expect "a tip still running leaves the newest passed one" "$a" "$(scripts/newest-passed.sh)"
PASSED="$b $a"; got=$(scripts/newest-passed.sh); expect "a's run, finishing after b's passed, still releases b" "$b" "$got"
expect "and b's release is the next patch, holding a's change too" "new v1.1.2" "$(next "$got")"
g tag v1.1.2 "$b"; RELEASED="$RELEASED v1.1.2"
expect "a, older and untagged, is in b's release already" "none $a" "$(next "$a")"
PASSED=""; expect "nothing passed is an error, never a guess" "error" "$(if scripts/newest-passed.sh >/dev/null 2>&1; then echo picked; else echo error; fi)"

[ "$failed" = 0 ] && echo "all passed"
exit "$failed"
