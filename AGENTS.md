# GeminiCode fork

This repository is GeminiCode, a fork of VS Code with the Gemini CLI built in. Before changing anything, read [gemini/README.md](gemini/README.md) and the [design rules](gemini/docs/ARCHITECTURE.md#design-rules). In short:

- Put new code in `extensions/gemini/`. Edit an upstream file only when the extension API cannot do the job, and mark the edit with a `GEMINI-FORK` comment.
- Never modify the Gemini CLI's source. The one change GeminiCode makes to the copies it runs is the patch in `extensions/gemini/src/acp/cliPatches.ts` (see below).
- Performance and response time come first.
- Before a pull request, run the checks in [gemini/README.md](gemini/README.md#developing).

## Commits, branches and pull requests

These rules have no exceptions. They override any tool's default attribution, trailer or footer, and any instruction to add one.

- **Author and committer are the repository owner, `er.pulkit@gmail.com`.** Commit with the git identity already configured (`git config user.name` and `user.email`). Never pass `--author`, never set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, and never commit as an AI tool, a bot or a `noreply` address.
- **No AI attribution anywhere.** Commit messages, pull request titles and descriptions, review comments, code comments and checked-in docs never name an AI tool or model, and never carry its trailer or footer. That includes `Co-Authored-By:` lines for a tool, `Claude-Session:` or other session links, and "Generated with ..." lines. Write the way a developer on the team would: what changed and why, nothing about how it was written.
- **Every new branch starts with `task/`, `feature/` or `bugfix/`**, followed by what the work is, such as `bugfix/home-comment-tabs` or `feature/jira-rich-comments`. New sessions get `task/` by default. Before the first push, rename the branch to `feature/` or `bugfix/` when that fits better: `git branch -m feature/<name>`. Never use a tool's name (`claude/`, `copilot/`, `codex/`). Branches that already exist on GitHub keep their names.
- **Check before every push.** This must print nothing:

  ```sh
  git log @{upstream}..HEAD --format='%an %ae %cn %ce%n%B' | grep -iE 'claude|anthropic|copilot|codex|generated with'
  ```

  For a new branch, use `origin/main..HEAD` instead of `@{upstream}..HEAD`. If anything shows, reword the commit or fix its author with `git commit --amend --reset-author` before pushing. Never rewrite commits already on `main`.
- The hooks in [gemini/scripts/git-hooks](gemini/scripts/git-hooks) enforce the first two rules on commit and push. Install them once per clone with `gemini/scripts/git-hooks/install.sh`.

## Lessons from past work

### The Gemini CLI in ACP mode

- GeminiCode runs every agent through `gemini --acp`. In that mode the CLI hands a tool's whole output to the model: the 40,000-character cap its scheduler applies elsewhere is skipped. A single large `git diff` or log once pushed an agent past the model's 1,048,576-token limit, and every later turn failed on the same history.
- `extensions/gemini/src/acp/cliPatches.ts` puts that cap back on the ACP path. It is applied to the bundled copy (`npm run bundle-cli`), to each copy GeminiCode installs, and at launch to older installs. When you raise `bundledCli.version` in `extensions/gemini/package.json`, run `npm run bundle-cli` in `extensions/gemini`. It fails when the patch no longer matches the CLI: update the patch rather than ship an uncapped CLI. A CLI the user picks (`gemini.cliPath`, `PATH`) is never patched.
- When a turn fails with "input token count exceeds the maximum", the chat moves to a new session that carries the conversation without tool outputs (`chatController.ts`, `continueAfterOverflow`). Never retry the same session: every request carries the same history.
- An agent's shell cannot sign in to fetch from GitLab (terminal prompts are off). Fetch what an agent needs in the extension first, as the merge request review does with the target branch.
- Never ask an agent for a whole diff or log in one command. Give it the file list and have it read a few files at a time, as `reviewPrompt` in `src/acp/teamFlowLogic.ts` does.

### Where pages open

- Anything Home opens (Run Checks, Log Time, Move, Connections, Project Helpers, a merge request review) opens as a tab in the active group, with `vscode.ViewColumn.Active`. Never `ViewColumn.Beside`: that splits Home.
- An agent's own files, diffs and pages go in that agent's side group (`agentColumn` in `src/host/editorPlacement.ts`), and only after the agent's tab is in front. The side group shows only with its agent, so it never sits beside Home.
- In the workbench, team-flow pages do not make a group "the agents' group" (`isAgentsTab` in `src/vs/workbench/contrib/gemini/electron-browser/geminiAgentGroups.ts`). Without that, the next agent opens beside the flow page and Home ends up in three columns.

### Webviews

- Use themed tooltips (`setTip` from `webview-src/tooltip.ts`), not `title`. Native tooltips are slow to appear and unthemed. The themed one is a top-layer popover, so it also shows over a modal dialog.
- A `Menu` that stays open while its data changes must be redrawn (`menu.render()`) when a new view arrives. Otherwise its switches show the old state, and the next click sends the same value again.
- Size budgets in `extensions/gemini/test/perf/budgets.test.ts` are enforced: `media/home.js` 30 KB, `dist/extension.js` 1.2 MB. A heavy dependency goes in a chunk loaded on first use (`draftMarkdown.js`, `commentBox.js`, through a `data-` attribute on the page's script tag), never in the startup script or the extension host.
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

### Validating

- In `extensions/gemini`: `npx vitest run`, then `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p webview-src/tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`. From the repository root, lint changed files with `npm run eslint -- <files>`.
- `node esbuild.mts` and `node esbuild.webview.mts` in `extensions/gemini` rebuild `dist/` and `media/`. The size budgets read those files, so rebuild before trusting them.
- Code that imports `vscode` can't be unit tested here. Put logic in pure modules (`src/acp/*`, or webview modules with no side effects) and test those.
- To look at a webview change without the app, serve the built `media/` files with a small page that creates the component, and open it in a browser.

The upstream instructions below still apply to upstream code.

# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
