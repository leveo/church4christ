# CI Maintenance Implementation Plan

> **Required execution skills:** subagent-driven-development, test-driven-development,
> and verification-before-completion.

**Goal:** Remove deprecated embedded action runtimes, cancel only superseded pull-request
runs, and bound the full CI job without weakening D1 or PostgreSQL coverage.

**Scope:** One independent PR. It changes workflow execution mechanics only. The
application remains on the exact Node version in `.nvmrc` and the full existing command
matrix remains intact.

## Files

- Modify: `.github/workflows/ci.yml`
- Modify: `test/node/setup/ci-hardening.test.ts`

## Task 1: Lock the supported action runtime

- [ ] Add failing assertions to the existing workflow contract test for
  `actions/checkout@v7`, `actions/setup-node@v7`, and the absence of their v4 forms.
- [ ] Run:

  ```bash
  npx vitest run --project node test/node/setup/ci-hardening.test.ts
  ```

  Expected RED: only the new action-major assertions fail.
- [ ] Change the two `uses:` entries to `@v7`; do not change any `run:` step.
- [ ] Re-run the focused test and require GREEN.

## Task 2: Make `.nvmrc` authoritative

- [ ] Add a failing source-contract assertion that Setup Node uses:

  ```yaml
  with:
    node-version-file: .nvmrc
    cache: npm
  ```

- [ ] Add a test that parses `.nvmrc` and `package.json` and proves the exact `.nvmrc`
  version satisfies the `engines.node` lower bound.
- [ ] Run the focused test and record RED for the inline `node-version: 22` setting.
- [ ] Replace only that setting with `node-version-file: .nvmrc`; require GREEN.

## Task 3: Add event-aware cancellation and a timeout

- [ ] Add failing assertions for this exact workflow-level block:

  ```yaml
  concurrency:
    group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

- [ ] Add a failing assertion for `timeout-minutes: 30` on `jobs.build-test`.
- [ ] Keep the existing assertions for every D1 and PostgreSQL setup, test, build,
  migration, smoke, and E2E step.
- [ ] Add the YAML and run the focused test to GREEN.

## Task 4: Verify and publish the PR

- [ ] Run:

  ```bash
  npm run docs:check
  npm run tokens:check
  npm test
  npm run check
  npm run build
  git diff --check
  ```

- [ ] Commit only the two scoped files with `ci: modernize workflow execution`.
- [ ] Push `codex/ci-maintenance`, open a CI-only PR, and cite the official Checkout and
  Setup Node v7 releases in the PR body.
- [ ] Verify the PR job passes with no embedded-Node deprecation annotation. If a safe
  follow-up push is needed, verify the older PR run is cancelled.
- [ ] Squash merge only after all checks pass. Locate the run whose `headSha` equals the
  merge commit and require its `main` push run to pass.
- [ ] Only then delete the remote branch, worktree, and local branch.

## Guardrails

- Do not change `.nvmrc`, `engines.node`, workflow permissions, service containers,
  cache type, test commands, or deployment behavior.
- Do not add automatic deployment, release, or npm publication.
- `@v7` is an official supported major tag, not a claim of SHA immutability.
