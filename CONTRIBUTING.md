# Contributing

## Changing a starter

Make the change, then run its own checks and the conformance suite:

```sh
cd conformance && npm ci
node run.ts ../typescript     # or ../python: lint, build, fake platform, dev-mode reloads
```

CI runs the same thing for every stack on every PR, and a starter that doesn't pass fails it. The suite's own tests (`cd conformance && npm test`) also run `npm audit` on the TypeScript starter's lockfile and fail on any high or critical finding, so CI does too; fix one with `npm audit fix --package-lock-only` in `typescript/`, which keeps the versions within `package.json`'s ranges. Keep `web/` identical across stacks: CI diffs it. A change to the UI goes into every stack in the same PR.

## Changing the spec

[SPEC.md](SPEC.md) is the contract, and the rules come before the code. Change it in its own PR, or in the PR whose behaviour needs it, and get it reviewed. Every rule names the test that proves it (`LINT:*`, `CONF:*`) or is marked `review`. The suite reads the rules from SPEC.md, and its own tests fail if a rule names a test that doesn't exist, or if a test exists that no rule names. A new rule therefore lands with its test, and with every stack passing it.

## Adding a stack (Rust, Java, Go…)

A stack is a directory, `<language>/`, holding the same notes app ([SPEC.md §11](SPEC.md)) and passing every rule. In order:

1. **The platform builds it without a Dockerfile.** BLD-1 says starters bring none, so agent.cloud needs a default image for the language first. That's a spec and a PR in agent-cloud: how the language is recognised (`packages/cli/src/stack.ts`), and the generated Dockerfile (`packages/runner/src/build.ts`), as `docs/specs/python-apps.md` did for Python. Its points to settle:
   - a small multi-arch base;
   - a frozen lockfile install;
   - the shared UI built in a Node stage into `web/dist`;
   - a non-root user;
   - unbuffered logs;
   - `HOME=/tmp`;
   - the manifest's `command` under agent.cloud's signal wrapper.
2. **Vendor it here:** `conformance/vendor/sync.sh <agent-cloud checkout>`, then teach `conformance/lib/stack.ts` (`languageOf`) and `conformance/images/index.ts` (`dockerfileFor`) the new language.
3. **Write the starter** in `<language>/`:
   - copy `web/` from `typescript/` unchanged, and the migration;
   - implement the routes, sign-in, the worker and logging the way the rules say;
   - write `agentcloud.toml` (the checks in §11 included), an AGENTS.md stack section and a README;
   - add `conformance.toml`, which names the files the reload tests edit.

   The TypeScript and Python starters show every rule in about 400 lines each.
4. **Pass it:** `node conformance/run.ts ../<language>` until every MUST rule passes. The `review` rules are for your PR's reviewer.
5. **Add it to CI:** append the stack to the matrix in `.github/workflows/conformance.yml`, with a step for its own checks (compiler, linter, tests).
6. **Release it:** the next tagged release carries it (`scripts/release.sh`), and agent-cloud's `agc init --stack <language>` can offer it.

## Releasing

Tag the commit, then run `scripts/release.sh v1.2.3 --publish`. It builds `dist/starters-v1.2.3.tgz`: every stack, SPEC.md and LICENSE, without the conformance descriptors. It prints the sha256, and creates the GitHub Release with the file attached. agent-cloud's CLI pins that version and sha256.
