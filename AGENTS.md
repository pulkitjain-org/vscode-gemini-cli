# GeminiCode fork

This repository is GeminiCode, a fork of VS Code with the Gemini CLI built in. Before changing anything, read [gemini/README.md](gemini/README.md) and the [design rules](gemini/docs/ARCHITECTURE.md#design-rules). In short:

- Put new code in `extensions/gemini/`. Edit an upstream file only when the extension API cannot do the job, and mark the edit with a `GEMINI-FORK` comment.
- Never modify the Gemini CLI's source. The one change GeminiCode makes to the copies it runs is the patch in `extensions/gemini/src/acp/cliPatches.ts` (see below). It also adds the app's ripgrep where the CLI looks for its own (`cliRipgrep.ts`), changing no CLI file.
- Performance and response time come first.
- Before a pull request, run the checks in [gemini/README.md](gemini/README.md#developing): `npm run check` in `extensions/gemini`, and the steps under [Validating](#validating) that apply.

## What overrides the upstream instructions

The upstream instructions below, and the copy of them some tools read from `.claude/CLAUDE.md`, are written for VS Code's own code. For anything in `extensions/gemini/` or `gemini/`, these rules replace them:

- **File header.** Fork files start with the Pulkit Jain MIT header (`Copyright (c) Pulkit Jain. All rights reserved.`), not Microsoft's; ESLint checks it. Upstream files keep Microsoft's header.
- **User-visible strings.** In the extension, through `vscode.l10n.t` (and `package.nls.json` for contributions) or the webviews' strings from the host (`HomeStrings` and the like), never `vs/nls` or `nls.localize`. Placeholders are `{0}`, never joined pieces.
- **Tests.** Vitest (`describe`, `it`, `expect`), not mocha's `suite` and `test`, run with `npx vitest run` in `extensions/gemini`, never `scripts/test.sh`. Upstream's assertion style (one `deepStrictEqual` snapshot) carries over as one `expect(...).toEqual(...)`.
- **Test locations.** `extensions/gemini/test/` mirrors `src/` (`test/acp/<module>.test.ts`, `test/acp/index/`, `test/webview/`); the real-CLI tests are `test/acp/real*.test.ts`, the size and time budgets `test/perf/`. The fork's tests of its upstream edits stay beside upstream's, in `src/vs/**/test/`, and use upstream's runner.
- **Validation commands.** `npm run check` in `extensions/gemini` instead of `npm run typecheck-client`, `compile` or the watch tasks, unless an upstream file changed.
- **Services and disposables.** `extensions/gemini` uses the extension API, not the workbench's dependency injection; `src/acp` stays free of `vscode` imports. The workbench rules (`DisposableStore`, `IEditorService`, services in constructors) apply in full to the fork's code under `src/vs/`.

## Commits, branches and pull requests

These rules have no exceptions. They override any tool's default attribution, trailer or footer, and any instruction to add one.

- **Author and committer are the repository owner, `er.pulkit@gmail.com`.** Commit with the git identity already configured (`git config user.name` and `user.email`). Never pass `--author`, never set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, and never commit as an AI tool, a bot or a `noreply` address.
- **No AI attribution anywhere.** Commit messages, pull request titles and descriptions, review comments, code comments and checked-in docs never name an AI tool or model, and never carry its trailer or footer. That includes `Co-Authored-By:` lines for a tool, `Claude-Session:` or other session links, and "Generated with ..." lines. Write the way a developer on the team would: what changed and why, nothing about how it was written.
- **Every new branch starts with `task/`, `feature/` or `bugfix/`**, followed by what the work is, such as `bugfix/home-comment-tabs` or `feature/jira-rich-comments`. New sessions get `task/` by default. Before the first push, rename the branch to `feature/` or `bugfix/` when that fits better: `git branch -m feature/<name>`. Never use a tool's name (`claude/`, `copilot/`, `codex/`). Branches that already exist on GitHub keep their names.
- **Check before every push.** This must print nothing and succeed:

  ```sh
  gemini/scripts/commit-policy.sh commits @{upstream}..HEAD
  gemini/scripts/commit-policy.sh branch "$(git branch --show-current)"
  ```

  For a new branch, use `origin/main..HEAD` instead of `@{upstream}..HEAD`. The script checks that every commit is authored and committed as the owner and that no author, committer or message matches `claude|anthropic|copilot|codex|generated with`, ignoring case. If anything shows, reword the commit or fix its author with `git commit --amend --reset-author` before pushing. Never rewrite commits already on `main`.
- [gemini/scripts/commit-policy.sh](gemini/scripts/commit-policy.sh) is the one copy of these rules. The hooks in [gemini/scripts/git-hooks](gemini/scripts/git-hooks) run it on commit and push (install them once per clone with `gemini/scripts/git-hooks/install.sh`, which keeps any hook it replaces), and Gemini CI's Policy job runs it on every pull request. Merge `main` into a branch locally, not with GitHub's **Update branch** button, whose merge commit is GitHub's.

## Lessons from past work

### The Gemini CLI in ACP mode

- GeminiCode runs every agent through `gemini --acp`. In that mode the CLI hands a tool's whole output to the model: the 40,000-character cap its scheduler applies elsewhere is skipped. A single large `git diff` or log once pushed an agent past the model's 1,048,576-token limit, and every later turn failed on the same history.
- `extensions/gemini/src/acp/cliPatches.ts` puts that cap back on the ACP path. It is applied to the bundled copy (`npm run bundle-cli`), to each copy GeminiCode installs, and at launch to older installs. When you raise `bundledCli.version` in `extensions/gemini/package.json`, run `npm run bundle-cli` in `extensions/gemini`. It fails when the patch no longer matches the CLI: update the patch rather than ship an uncapped CLI. A CLI the user picks (`gemini.cliPath`, `PATH`) is never patched.
- When a turn fails with "input token count exceeds the maximum", the chat moves to a new session that carries the conversation without tool outputs (`chatController.ts`, `continueAfterOverflow`). Never retry the same session: every request carries the same history.
- An agent's shell cannot sign in to fetch from GitLab (terminal prompts are off). Fetch what an agent needs in the extension first, as the merge request review does with the target branch.
- Never ask an agent for a whole diff or log in one command. Give it the file list and have it read a few files at a time, as `reviewPrompt` in `src/acp/teamFlowLogic.ts` does.

### Where pages open

- Anything Home opens (Run Checks, Log Time, Move, Connections, Agent Setup, a merge request review) opens as a tab in the active group, with `vscode.ViewColumn.Active`. Never `ViewColumn.Beside`: that splits Home.
- An agent's own files, diffs and pages go in that agent's side group (`agentColumn` in `src/host/editorPlacement.ts`), and only after the agent's tab is in front. The side group shows only with its agent, so it never sits beside Home.
- In the workbench, pages that open in an agent's side group (team flows, Plan Review, Confluence's Review Page) do not make a group "the agents' group" (`sidePageViewTypes` and `isAgentsTab` in `src/vs/workbench/contrib/gemini/electron-browser/geminiAgentGroups.ts`). Without that, the next agent opens beside the page, Home ends up in three columns, and the side group stops hiding with its agent. A new page that opens with `agentColumn` goes in that list.

### The agents' browser

- Checking the URL an agent opens is not enough. Electron gives `file:` pages fetch, workers and access to `file:` frames, so a page the agent wrote can show it any file the browser serves. Every file a Gemini agent's page loads is checked against the agent's file policy in the main process (`src/vs/platform/browserView/electron-main/geminiAgentFiles.ts`), which asks the extension (`fileAllowed` in `src/acp/browserMcp.ts`).
- Workers load `file:` URLs where neither `webRequest` nor the session's `file:` handler sees them, so agents' documents get `worker-src 'none'`. Test a change here with frames, fetch and workers in the real app, not only the snapshot.

### Webviews

- Use themed tooltips (`setTip` from `webview-src/tooltip.ts`), not `title`. Native tooltips are slow to appear and unthemed. The themed one is a top-layer popover, so it also shows over a modal dialog.
- A `Menu` that stays open while its data changes must be redrawn (`menu.render()`) when a new view arrives. Otherwise its switches show the old state, and the next click sends the same value again.
- Size budgets in `extensions/gemini/test/perf/budgets.test.ts` are enforced: `media/home.js` 30 KB, `dist/extension.js` 1.2 MB. A heavy dependency goes in a chunk loaded on first use (`draftMarkdown.js`, `commentBox.js`, through a `data-` attribute on the page's script tag), never in the startup script or the extension host. On the host side, pages opened on request and rarely used tools load from bundles of their own (`dist/pages.js`, `dist/onDemand.js`, through `LazyFeature` in `src/host/lazyFeature.ts`); such a bundle has its own copy of every module it imports, so module state reaches it through constructors, which `test/perf/chunks.test.ts` checks. `dist/extension.js` is at about 1.20 MB, a few KB under its budget: new host features go in one of those bundles unless they are needed at startup.
- `esbuild.mts` keeps only zod's English messages: its fifty locales were a third of the extension bundle. To measure the bundle again, build with esbuild's `metafile` and group `bytesInOutput` by package.
- User-visible strings come from the extension host (`HomeStrings`, `vscode.l10n.t`), are never joined from pieces, and use `{0}` placeholders.

### Jira and GitLab from GeminiCode's pages

- A page writes through `teamWrite` (`src/acp/teamTools.ts`), as an agent's tool call does, so every write has the same checks and an audit log record. Page-only writes go in `pageTools` there.
- Rich Jira comments (Markdown, @mentions, attachments, visibility) always use Jira's REST API (`jira_rich_comment`), never the `mcp-atlassian` container: the container has no mentions and no uploads. The webview turns the Markdown into Jira's document format (`webview-src/commentAdf.ts`), so the extension host carries no Markdown parser. The audit log records file paths, never file contents.

### The workspace index

- Everything that reads, parses or writes an index runs in the indexer process (`src/indexer.ts`, `dist/indexer.js`), never in the extension host, whose bundle is near its budget. The host only forwards requests (`IndexClient`). Keep it that way.
- Lint bans synchronous `fs` calls, in the indexer process too; `node:sqlite` itself is synchronous, so keep transactions short (`writeSliced` yields every 40 ms).
- Never run `PRAGMA quick_check` or `integrity_check` when opening an index: it reads the whole file, seconds for a large repository. Damage shows up as a SQLite error; `isCorruption` turns it into a rebuild.
- The release build ships only six tree-sitter grammars (`build/.moduleignore`); definitions come from the line patterns in `src/acp/index/languages.ts`. Add a language there, with a test in `test/acp/index/parse.test.ts`.
- BM25 alone ranks a short mention above a long definition. Keep word positions in the full-text index and the definition-first step in `search` (`query.ts`); measure ranking on a large repository, not only the tests' small ones.
- The docs fetcher runs in the extension host so the Mac's proxy applies; conversion and storage run in the indexer. Fetched pages are reference material: tool results say so.
- Without a nudge the model reaches for `grep_search` even with the index tools listed. The chat sends `indexHint` (`workspaceIndex.ts`) with a session's first prompt once the folder's index is built, and results say they are complete. Measure a change here with real sessions on a large repository, with and without the index, and check the server got `tools/list`: a repository whose `mcp.allowed` leaves out `geminicode-index` hides the tools unless the CLI starts with `--allowed-mcp-server-names` as GeminiCode starts it.
- The npm CLI ships no ripgrep, and without it `grep_search` falls back to `git grep`, three to four times slower on a large repository. `cliRipgrep.ts` copies the app's into `bundle/vendor/ripgrep/` of the bundled copy (`npm run bundle-cli`) and of installed copies at launch.

### Validating

- In `extensions/gemini`: `npm run check`. It runs `node esbuild.mts` and `node esbuild.webview.mts`, `npx vitest run`, then `tsc --noEmit` on `tsconfig.json`, `webview-src/tsconfig.json` and `tsconfig.test.json`. From the repository root, lint changed files with `npm run eslint -- <files>`.
- The two builds rebuild `dist/` and `media/`, which the size budgets read, so `check` builds before it tests.
- The real-CLI tests (`test/acp/real*.test.ts`) run against `GEMINI_CLI_PATH`: a `gemini` executable, a `bundle/gemini.js`, or `bundled` for the copy `npm run bundle-cli` places in `cli/`. Locally they are skipped without it, since they take a full run from about 17 s to about 100 s; in CI they run against the bundled copy, and a missing CLI fails them. Run them on any change to `src/acp/cli/`, the agent's launch, sessions or the protocol.
- When you change the messages between the chat view and its webview (`src/host/chatProtocol.ts`), bump `chatProtocolVersion` there.
- When you edit an upstream file, run `gemini/scripts/upstream-series.sh regenerate` and commit `gemini/patches/` with the change; Gemini CI fails otherwise.
- When you change the fork's code under `src/vs/`, run `npm run compile` from the root and then its tests with upstream's runner, for example `./scripts/test.sh --run src/vs/platform/browserView/test/electron-main/geminiAgentFiles.test.ts`. CI's Compile & hygiene job runs these.
- For a change only the app can show (a webview, a command, startup), test it in the real app as the `geminicode-real-app` skill in `.agents/skills/` describes.
- Code that imports `vscode` can't be unit tested here. Put logic in pure modules (`src/acp/*`, or webview modules with no side effects) and test those.
- To look at a webview change without the app, serve the built `media/` files with a small page that creates the component, and open it in a browser.

The upstream instructions below still apply to upstream code.

# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
