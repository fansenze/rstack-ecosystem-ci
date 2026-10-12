# rstack-ecosystem-ci

This repository provides a unified ecosystem CI harness for Rstack projects.

## Via GitHub workflow

### scheduled

Workflows are scheduled to run automatically every day

### manually

- open [workflow](../../actions/workflows/ecosystem-ci-selected.yml)
- click 'Run workflow' button on top right of the list
- select suite to run in dropdown
- start workflow

## Via CLI

- clone this repo
- run `pnpm i`
- run `pnpm test --stack <stack>` to run every suite under the selected stack (`rsbuild`, `rspack`, `rstest`, `rslib`, `rsdoctor`)
- run `pnpm test --stack rspack` to execute all Rspack suites (available stacks: `rsbuild`, `rspack`, `rstest`, `rslib`, `rsdoctor`)
- run `pnpm test --stack rslib` to execute all Rslib suites
- run `pnpm test --stack rsbuild plugins` to target a specific suite
- or invoke `tsx ecosystem-ci.ts` directly for advanced commands such as `build`, `run-suites`, or `bisect`

The version selection flags apply to the chosen stack:

- `--tag v2.8.0-beta.1`, `--branch some-branch` or `--commit abcd1234` pick the stack source to build
- `--release 2.7.13` skips the local build and pulls the stack from the registry instead

The repositories are checked out into `workspace` subdirectory as shallow clones

### Cheat sheet

- `pnpm test --stack rspack --release nightly <suite>`: run a nightly release of the selected stack
- `pnpm test --stack rsbuild --branch main --suite-branch update-rsbuild <suite>`: use `update-rsbuild` branch for the suite to test `main`
- `pnpm test --stack rspack modernjs` (rspack suites include modernjs, rspress, rsbuild, rslib, rstest, rsdoctor, examples, devserver, plugin, lynx-stack, \_selftest)
- `pnpm test --stack rspress rspress-plugins`: build Rspress and run the [Rspress plugins](https://github.com/rstackjs/rspress-plugins) package builds, documentation builds, unit tests, and Chromium E2E tests

### Rslint

The Rslint suites build and lint Rsbuild, Rslib, and Rstest with type checking enabled. Rsbuild and Rslib exercise Rslint through Rstack; Rstest uses the Rslint CLI directly.

```bash
pnpm test --stack rslint --branch main rsbuild
pnpm test --stack rslint --release 0.9.5 rstest
pnpm test:rslint
```

Source builds require Go (the version in Rslint's `go.mod`), Rust, and the initialized `typescript-go` submodule. They build the Go CLI, native parser, schemas, and JavaScript entrypoints. Local suites pack `@rslint/core` and the host `@rslint/native-*` package into tarballs so workspace and catalog dependencies resolve as they do in published packages. Tarball paths include a content digest so reruns cannot reuse stale same-version binaries.

GitHub Actions publishes the same two packages to a local Verdaccio registry with a unique `<version>-fresh.<runId>.<runAttempt>` version. After installing overrides, each suite checks the core and native versions from the actual caller's dependency tree and verifies required artifacts. Independently versioned tsgo server packages use their published versions.

The Rslint selected workflow builds the branch, tag, or commit provided in its `ref` input. Use the CLI's `--release` option to test a published registry version.

To enable the upstream workflow, first merge this repository's Rslint integration, then configure `REPO_RSLINT_ECO_CI_GITHUB_TOKEN` in `web-infra-dev/rslint` and merge its `.github/workflows/ecosystem-ci.yml`. The token needs access to `rstackjs/rstack-ecosystem-ci` with **Actions read/write**. History publishing uses this repository's own `GITHUB_TOKEN`; the dispatch token needs no Contents permission. Upstream comments use the upstream workflow's `GITHUB_TOKEN`.

The upstream workflow pins the existing shared dispatch actions. This integration does not change those actions or `ecosystem-ci-result`, so it requires no shared-action release or pin updates in the other stacks. Downstream workflows and build actions are picked up through the dispatch bridge's `ref: main`.

# How to add a new integration test

- check out the existing suites under `tests/<stack>` and add one yourself. Thanks to the shared utilities it is really easy
- once you are confidente the suite works, add it to the lists of suites in the [workflows](../../actions/)

> the current utilities focus on pnpm based projects. Consider switching to pnpm or contribute utilities for other pms

# Self-checking with an agent

This repo ships an `eco-ci-selfcheck` skill (under `.agents/skills/eco-ci-selfcheck/SKILL.md`) that audits the latest run of each `*-ecosystem-ci-from-commit` workflow and returns a table separating eco-ci framework failures from legitimate downstream test failures. Invoke it from whichever coding agent you use that loads `.agents/skills/` (in Claude Code: `/eco-ci-selfcheck`, via the `.claude/skills/eco-ci-selfcheck` symlink). Requires `gh` authenticated against `rstackjs/rstack-ecosystem-ci`.

# Reporting results

### On your own server

- Go to `Server settings > Integrations > Webhooks` and click `New Webhook`
- Give it a name, icon and a channel to post to
- copy the webhook url
- get in touch with admins of this repo so they can add the webhook

## Credits

Thanks to:

- [vitejs/vite-ecosystem-ci](https://github.com/vitejs/vite-ecosystem-ci)
- [vuejs/ecosystem-ci](https://github.com/vuejs/ecosystem-ci)

which inspired the development of this project.
