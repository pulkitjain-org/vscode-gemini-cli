# GeminiCode

GeminiCode is a fork of VS Code (Code - OSS) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

This folder holds everything the fork adds besides its product code, which lives in [`../extensions/gemini/`](../extensions/gemini/). Start here if you want to build GeminiCode, change it, or understand how it works. If you only want to use it, read the [user docs](https://pulkitjain-org.github.io/vscode-gemini-cli/docs/) instead.

> [!IMPORTANT]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## What GeminiCode does

In a sentence each, with the guide page that covers it:

- **Agents.** Several agents side by side, each in its own tab and folder, optionally on a branch of its own whose work you try in your workspace before keeping it, and forkable when the work splits. [Agents](docs/guide/agents.md)
- **Chat.** A composer with context, slash commands, Enhance prompt and Plan mode, whose plans you edit and comment on in Plan Review; send or queue messages while an agent works, react to replies with an emoji, and compact long chats. [Chat and prompting](docs/guide/chat.md)
- **Review.** Approval modes, permission cards, Keep and Undo in the file, Rewind, inline edit and Review My Changes. [Review and safety](docs/guide/review.md)
- **Terminal.** Each agent has a terminal; a reply's shell commands run there with one click, and terminal output goes back to Gemini. [Terminal](docs/guide/terminal.md)
- **Projects.** A coordinator that splits larger work into threads, each an agent on its own branch, whose work you try in your workspace and keep, or take back. [Projects](docs/guide/projects.md)
- **Browser.** A browser agents can use, with Add to Gemini and notes on the page. [Browser](docs/guide/browser.md)
- **Workspace index.** A local index of each workspace, and of attached docs, that agents search in one step. [Workspace index and docs](docs/guide/agents.md#workspace-index-and-docs)
- **Team tools.** Jira (one site or several), Confluence, GitLab, SonarQube, Snyk and Figma with your own account, from ticket to merged merge request, merge request reviews, and Confluence pages agents draft for you to review and publish. [Team tools](docs/guide/team-tools.md)
- **Setup and policy.** A managed Gemini CLI, folder trust asked once per repository, Agent Setup for MCP servers, skills, rules and trusted folders, and settings an administrator can lock. [Getting started](docs/guide/getting-started.md), [Agent Setup](docs/guide/helpers.md), [Settings](docs/guide/settings.md)

## What is in this folder

Documentation:

- [docs/guide/](docs/guide/): the user docs, one page per area, published as the [GeminiCode docs](https://pulkitjain-org.github.io/vscode-gemini-cli/docs/). They describe what is on `main`; update them in the same pull request as the feature.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how GeminiCode works and why, including the security model, admin policies and the [design rules](docs/ARCHITECTURE.md#design-rules).
- [docs/PROJECTS.md](docs/PROJECTS.md): how Projects work inside: the coordinator and its threads, how prompts move between them, and what drives the coordinator's decisions.
- [docs/FINDINGS.md](docs/FINDINGS.md): Gemini CLI behaviour and measurements the design relies on.
- [docs/RELEASING.md](docs/RELEASING.md): versions, cutting a release, the download page, and Apple signing.
- [docs/ROADMAP.md](docs/ROADMAP.md): open work and risks.
- [docs/adr/](docs/adr/): the decisions that shape the fork, one record each.

Tools and assets:

- [site/](site/): the generator for the download page, the feature pages and the docs site (`build.mts`), which the Pages workflow runs.
- [bench/](bench/README.md): the benchmark's tasks and results.
- [branding/](branding/README.md): icon sources.
- [patches/](patches/) and [upstream.json](upstream.json): the fork's edits to upstream files, as a patch series over the pinned upstream tag.
- [scripts/](scripts/):
  - `upstream-series.sh` lists, regenerates, applies and checks the patch series.
  - `commit-policy.sh` holds the commit and branch rules, which the git hooks and Gemini CI's Policy job both run.
  - `third-party-notices.mts` writes the Gemini extension's licence notices, for the release build.
  - `list-fork-touches.sh` lists every `GEMINI-FORK` marker in upstream files.
  - `notarize.sh` sends a signed build to Apple's notary service, for the release workflow.
  - `make-icons.sh` builds the app icon from `branding/`: the layered macOS 26 icon catalog, the classic `.icns` and the workbench's `code-icon.svg`.
  - `git-hooks/` holds the commit and push hooks; install them once per clone with `git-hooks/install.sh`, which keeps any hook it replaces as `<hook>.backup-<time>`.

The repository's top-level README, SECURITY and AGENTS files point here. CONTRIBUTING.md and the `.github` agent instructions are upstream's and stay unchanged, so upstream merges stay clean.

## Issues and security

Report bugs in [GitHub Issues](https://github.com/pulkitjain-org/vscode-gemini-cli/issues). Include the GeminiCode and Gemini CLI versions and the relevant lines from **Gemini: Show Log**, with account names and project IDs removed. Report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/pulkitjain-org/vscode-gemini-cli/security/advisories/new), never in a public issue.

## Contributing

Put new code in `extensions/gemini/` and follow the [design rules](docs/ARCHITECTURE.md#design-rules). Keep `src/acp` free of `vscode` imports, so its logic can be unit tested. If you change the messages between the chat view and its webview (`src/host/chatProtocol.ts`), bump `chatProtocolVersion`.

Commits are authored as the repository owner, branches start with `task/`, `feature/` or `bugfix/`, and nothing names an AI tool; [AGENTS.md](../AGENTS.md#commits-branches-and-pull-requests) has the full rules. `scripts/commit-policy.sh` checks them: the hooks in `scripts/git-hooks/` run it on commit and push, and Gemini CI's Policy job on every pull request.

## Developing

```sh
nvm use                  # Node from .nvmrc
npm ci
npm run watch            # keep running; rebuilds the workbench, extensions and the chat webview
./scripts/code.sh        # launches the branded dev build
```

To run the dev build on the bundled CLI, as a release does, run `npm run bundle-cli --prefix extensions/gemini` once. Without it, the dev build uses a copy you installed from GeminiCode or `gemini` on your `PATH`.

Before a pull request, run Gemini CI's checks for what your branch changes. The pre-push hook runs the quick set, once the hooks are installed (`gemini/scripts/git-hooks/install.sh`); CI runs the full set on every push:

```sh
gemini/scripts/ci-checks.sh                        # quick: lint of the changed files, hygiene, patch series, type checks
GEMINI_FULL_CHECKS=1 gemini/scripts/ci-checks.sh   # full: both bundles, the unit tests, the site; compile and hygiene of changed upstream files when one changed
```

While working, run the extension's checks:

```sh
cd extensions/gemini
npm run check    # both bundles, the unit tests (budgets included) and the three type checks
```

`npm run check` runs `node esbuild.mts`, `node esbuild.webview.mts`, `npx vitest run`, then `tsc --noEmit` on `tsconfig.json`, `webview-src/tsconfig.json` and `tsconfig.test.json`. Then, from the repository root, lint the files you changed with `npm run eslint -- <files>`.

Most tests run against a scripted fake ACP agent. The real-CLI tests (`test/acp/real*.test.ts`: the `initialize` handshake, admin policy, sessions, Rewind and the contract in `src/acp/cli/`) run against the CLI `GEMINI_CLI_PATH` names: its `gemini` executable, its `bundle/gemini.js`, or `bundled` for the copy `npm run bundle-cli` puts in `cli/<version>/`. Locally they are skipped without it; in CI they run against the bundled copy, and fail when it is missing.

If you changed an upstream file, also run `gemini/scripts/upstream-series.sh regenerate` and commit `gemini/patches/` ([Touching upstream files](#touching-upstream-files)), and run the fork's tests in upstream code after `npm run compile`:

```sh
./scripts/test.sh --run src/vs/platform/browserView/test/electron-main/geminiAgentFiles.test.ts \
  --run src/vs/workbench/services/extensionManagement/test/browser/extensionEnablementService.test.ts
```

`node esbuild.mts` and `node esbuild.webview.mts` in `extensions/gemini` rebuild `dist/` and `media/`. The size budgets in `test/perf/budgets.test.ts` read those files, so rebuild before trusting them. If the chat view warns that its script is out of date, the webview bundle in `media/` is older than the extension: run `npm run gulp compile-extension-media`, or keep `npm run watch` running, then reload the window.

## CI

[`gemini-ci.yml`](../.github/workflows/gemini-ci.yml) runs on pull requests and pushes to `main`, and can be run by hand. Its jobs:

- **Policy**, on pull requests: the branch starts with `task/`, `feature/` or `bugfix/`, and every commit from the base branch to the pull request's head is authored and committed as the repository owner and names no AI tool (`scripts/commit-policy.sh`, as the git hooks run it). A pull request that moves the upstream tag leaves out upstream's own history up to that tag. A merge commit made with GitHub's **Update branch** button is GitHub's, so merge `main` into a branch locally instead.
- **Checks**: the Gemini workflow files parse, lint and hygiene on the fork files (the fork's own files beside upstream's, listed in `gemini/patches/ADDED`, included), the patch series matches `HEAD` with every edited upstream code file marked, the download page builds from a sample release and passes its SEO, axe and Lighthouse checks, the extension, tests and webview type-check, both bundles build, and the bundled CLI is downloaded and checked as a release build does it (checksum, patch, ripgrep and the contract in `src/acp/cli/`). Then the unit tests run, the real-CLI tests among them against the bundled CLI. It also prints knip's list of unused exports and files, as a report that never fails.
- **Real CLI (bundled, latest, preview)**: only the real-CLI, contract and patch tests, against the version the app bundles and npm's `latest` and `preview`. A failure on `preview` shows on the run without failing it.
- **Snyk on the fork's code**, when the repository has a `SNYK_TOKEN` secret; without it the job passes with a note.
- **Compile & hygiene**: the whole fork compiles, upstream's hygiene check passes, and the fork's tests in upstream code (the agents' browser file policy and the extension's enablement) run in Electron under `xvfb-run`. A pull request that only changes `extensions/gemini/`, `gemini/`, the Gemini workflows or top-level Markdown files skips this job, because Checks covers those files; a skipped job counts as passing. It restores `node_modules` from a cache keyed on the lockfiles, so it reinstalls only when dependencies change.

Every job installs with npm's cache. A newer push to a pull request cancels its older run; every push to `main` keeps its run, since a release is cut only from a commit Gemini CI passed on.

The intended protection for `main`, which the owner turns on in the repository's ruleset: pull requests only, with **Policy**, **Checks**, **Real CLI (bundled)** and **Compile & hygiene** required to pass, and no bypass outside pull requests. Until it is on, nothing stops a red build from merging, so check the run before merging.

Packaged builds come from [`gemini-release.yml`](../.github/workflows/gemini-release.yml), which a version tag starts, and the download page from [`gemini-pages.yml`](../.github/workflows/gemini-pages.yml); see [RELEASING.md](docs/RELEASING.md).

Gemini CI, Gemini Release and Gemini Pages, with [`gemini-upstream.yml`](../.github/workflows/gemini-upstream.yml) below, are the only workflows the repository runs. It never goes back to upstream, so upstream's workflows (its pull request tests, CodeQL, the component fixtures and the rest) and its Dependabot config are removed. Turning them off in the repository's settings would not last: a workflow a later upstream release adds would start out on. The helper scripts they share with the Gemini workflows, such as `.github/workflows/node_modules_cache/`, and upstream's `.github/actions/` stay.

## Touching upstream files

Keep fork code in `extensions/gemini/`. Edit an upstream file only to register the extension, rebrand, or do something the extension API cannot, and mark the edit with a `GEMINI-FORK` comment. JSON files and icons cannot carry a marker, so the fork also keeps every such edit as a patch:

```sh
gemini/scripts/upstream-series.sh files        # the upstream files the fork modifies, and the files it adds beside them
gemini/scripts/upstream-series.sh regenerate   # rewrite gemini/patches/ from HEAD against the pinned tag
gemini/scripts/upstream-series.sh check        # what CI runs: every patch still matches HEAD, every upstream code file it edits has a GEMINI-FORK marker, and none of upstream's workflows is back
gemini/scripts/upstream-series.sh prune        # remove upstream's workflows and Dependabot config, after merging an upstream tag by hand
```

After editing an upstream file, run `regenerate` and commit `gemini/patches/` with the change; Gemini CI fails otherwise. `gemini/scripts/list-fork-touches.sh` prints the markers.

## Upstream releases

The fork is built on one upstream release tag, pinned in `gemini/upstream.json` (`1.142.0`). Its edits to upstream files are the patch series in `gemini/patches/`, one patch per file, binaries included; everything else the fork owns lives in `extensions/gemini/`, `gemini/`, the `gemini-*.yml` workflows and the files listed in `gemini/patches/ADDED`, which apply to any base.

[`gemini-upstream.yml`](../.github/workflows/gemini-upstream.yml) runs once a week and by hand. It fetches upstream's tags, takes the newest release above the pin, checks it out, applies the series with a three-way merge, copies the fork's own files over from `main`, moves the pin, regenerates the series against the new tag, bumps the bundled Gemini CLI to the newest release with its checksum from npm, and opens one pull request from `task/upstream-<tag>` (or `task/gemini-cli-<version>` for a CLI-only bump), committing as the repository's git user. Gemini CI builds and tests that pull request like any other; merge it once Gemini CI is green, which main's ruleset enforces once its required checks are on ([CI](#ci)). A patch that does not apply leaves conflict markers in the branch, and the pull request names it; finish it on that branch, run `regenerate`, and push. While that branch exists, later runs leave it alone.

Pushing an upstream move needs the `GEMINI_UPSTREAM_TOKEN` repository secret: a fine-grained token for this repository with contents, pull requests and workflows write access. GitHub refuses a push that changes `.github/workflows` from a workflow's own token, and upstream's commits do. A pull request opened with that token starts Gemini CI by itself. Without the secret, a CLI-only bump still goes through, and the job starts Gemini CI on its branch, since a pull request opened with a workflow's own token starts no workflows.

To do the same by hand:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream tag 1.143.0
git checkout -b task/upstream-1.143.0 1.143.0
FROM=main gemini/scripts/upstream-series.sh apply 1.143.0
# resolve anything it names, then:
gemini/scripts/upstream-series.sh regenerate
```

`apply` also removes upstream's workflows again. Merging a tag into the branch instead (`git merge 1.143.0`) brings back any workflow upstream added or changed, and a changed one shows as a conflict: run `gemini/scripts/upstream-series.sh prune` before committing the merge.

After each move:

1. Re-check the items in [FINDINGS.md](docs/FINDINGS.md) that name a CLI version, and the fixtures in `extensions/gemini/test/fixtures/`.
2. Check whether upstream's Agents window (`src/vs/sessions`) gained an extension API for agent providers ([ROADMAP.md](docs/ROADMAP.md)).
3. Let Gemini CI run the extension tests and the full compile on the pull request.
