# Conformance

Checks that a stack follows [SPEC.md](../SPEC.md): every rule, by its ID.

```sh
cd conformance && npm ci
node run.ts ../typescript                 # lint, build, run against the fake platform, dev-mode reloads
node run.ts ../python --no-dev            # skip the dev-mode reload tests
node run.ts ../typescript --lint-only     # files only, no Docker
node run.ts ../typescript --json out.json # the per-rule report as JSON too
npm test                                  # the suite's own tests
```

Needs Node 24, Docker, and `openssl`. Exits 1 if any MUST rule fails. `CONFORMANCE_KEEP=1` leaves the containers running.

## How it works

1. **Lint** (`lint/`): the `LINT:*` rules, from the files `agc ship` would send.
2. **Build**: the stack's image from agent.cloud's default Dockerfile for its language (`images/`), with exactly those files as the context.
3. **Fake platform** (`lib/env.ts`, `platform/server.ts`), on a private Docker network:
   - `db`: Postgres 18 that only takes TLS, with a certificate for `db` from a throwaway CA. The app trusts that CA the way it trusts Neon's in production: Node through `NODE_EXTRA_CA_CERTS`, libpq through `SSL_CERT_FILE`.
   - `platform`: agent.cloud's test-mode sign-in and its email endpoint.
4. **Run**: web and worker as the platform runs them, each with 512 MiB, a read-only filesystem except `/tmp`, and the platform's environment.
5. **Probe** the `CONF:*` rules over HTTP, signals, logs and SQL. The checks run through agc's own `runFlow` and `checkSignInState`. The welcome page's copy (`conf/welcome.ts`) is the stack's own `Welcome` and `NotesView`, transpiled and rendered with `react-dom/server` for every run and production state, as an app set up by hand and as one started from Start.
6. **Dev mode**: `[dev] setup`, then `dev` on a fresh copy. Then edit the files `conformance.toml` names and time the reloads.
7. **Report**: every rule in SPEC.md, as PASS, FAIL, SKIP or REVIEW.

## Vendored from agent.cloud

`vendor/agc/` holds agent-cloud's own code at the commit in `vendor/agc/COMMIT`. It's the checks engine, the migration reader, the manifest parser, how a stack is recognised, the runner's default Dockerfiles for Node and Python, and the secret scan. So the suite enforces what the platform enforces. Refresh it with `vendor/sync.sh <agent-cloud checkout>`, then run the suite for every stack.
