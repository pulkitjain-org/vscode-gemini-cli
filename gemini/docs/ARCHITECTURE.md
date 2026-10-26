# Architecture

GeminiCode is a hard fork of VS Code that ships the Gemini CLI as its built-in coding agent. This page explains how the pieces fit and why. Measurements and protocol behaviour that the design relies on are in [FINDINGS.md](FINDINGS.md). Open work is in [ROADMAP.md](ROADMAP.md).

## Decisions

- **Fork VS Code, don't extend it.** The product is a standalone, branded application. A fork owns the shell, branding, first-run experience and admin policy.
- **Don't reimplement the agent.** GeminiCode runs the official `gemini --acp` as a child process ("sidecar") and implements only the client side of the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Sign-in, licensing and model calls stay in the CLI. The Gemini API SDK was ruled out because it cannot use a Gemini Code Assist license.
- **Build it as a built-in extension.** Almost all fork code lives in `extensions/gemini/`. It ships inside the app, adds very little to upstream merges, and builds without recompiling the workbench. Code moves into the workbench only for things the extension API cannot do.

## Where the code lives

```
extensions/gemini/
  src/acp/          The agent side. Never imports `vscode` (an ESLint rule), so it can move into the
                    workbench later: the sidecar and the shared agent runtime, sessions, permissions and
                    session approvals, the file access policy, error classification, CLI install and
                    resolution, the transcript model and storage, the local MCP servers (the browser's,
                    the team tools', a project's and the index's, on one base in localMcpServer.ts),
                    the workspace index and its docs store (index/, docs/), the team
                    connectors and the team's servers as children (mcpStdio.ts, teamContainers.ts), the
                    audit log, the benchmark and the pilot's counters.
  src/host/         The VS Code side: the chat view and agent tabs, the Agents pane, Agent Home, the
                    Changes view, the status bar, the settings and team pages, commands, git actions,
                    update notices and the Get Started walkthrough. ChatController owns a chat's
                    webview, transcript and turns; each of its features (git, follow, usage,
                    attachments, permissions, Undo and Rewind, saved sessions, projects) keeps its
                    messages and state in a module of its own in chat/. AgentsView owns the agents
                    running in the window (sessions, chats, tabs) and their saved state; its list,
                    the title bar and tab indicators, the spare session, worktrees, Merge Back,
                    Projects and the ways of starting an agent are modules in agents/.
  webview-src/      The webviews' code, bundled to media/*.js.
  media/            Webview stylesheets and icons.
  themes/           The GeminiCode Dark and Light colour themes.
  icons/            The GeminiCode file icon theme.
  walkthrough/      Get Started step pages.
  scripts/          bundle-cli.mts (fetches the pinned CLI into cli/ for release builds), build-file-icons.py,
                    build-emoji-data.mts (the emoji picker's data), bench-run.mts (the benchmark outside
                    the app), and the measurements FINDINGS.md quotes: perf-real.mts (a real account),
                    perf-first-reply.mts and perf-threads.mts, probe-enhance.mts and coordinator-spike.mts.
  test/             Vitest unit tests, a scripted fake ACP agent and MCP server, real-CLI tests,
                    performance budgets, and theme and webview tests.
src/vs/workbench/contrib/gemini/
                    Fork-only workbench code for what the extension API cannot do (below).
gemini/             Fork material that is not shipped: docs, the patch series and its pin (patches/,
                    upstream.json), icon sources, the download page and docs generator (site/), the
                    benchmark's tasks (bench/), the pilot's admin profile (pilot/), maintainer scripts.
.github/workflows/gemini-ci.yml, gemini-release.yml, gemini-pages.yml, gemini-upstream.yml
```

### Upstream files GeminiCode edits

Upstream files are touched only where the fork must register itself or rebrand. Each edit carries a `GEMINI-FORK` comment, and the patch series in `gemini/patches/` keeps every one, JSON and icons included (see [../README.md](../README.md#touching-upstream-files)).

- **`product.json`**: names, icons, links, the Open VSX gallery, the download page URL, onboarding themes (the GeminiCode themes are listed in `onboardingThemes`) and the Gemini setting policies. It carries no Copilot auto-update, auth trust or voice endpoint, and no `enableTelemetry`, so telemetry is off.
- **Top-level docs**: `README.md`, `SECURITY.md` and `AGENTS.md`, which point at the fork's docs.
- **Build lists** that register the extension: `build/npm/dirs.ts`, `build/gulpfile.extensions.ts`, `build/lib/extensions.ts`, `build/filters.ts`, `build/hygiene.ts`, `.eslint-ignore`, `eslint.config.js`.
- **Branding**:
  - packaging metadata in `build/lib/electron.ts`, `build/win32/code.iss`, and the macOS, Linux, Windows and server files and icons under `resources/` (the Debian scripts never add Microsoft's apt repository);
  - a rebuild of the dev app when its name or icons change (`build/lib/preLaunch.ts`);
  - the `.dmg` volume name and background (`build/darwin/create-dmg.ts`, which reads `resources/darwin/dmg-background.tiff`);
  - packaging without upstream's Copilot extension (`build/gulpfile.vscode.ts`);
  - GeminiCode's version and the Gemini CLI in use in the About dialog, asked of the extension through `_gemini.cliVersion` (`platform/dialogs/electron-browser/dialog.ts`, `workbench/electron-browser/parts/dialogs/dialog.contribution.ts`);
  - the workbench icons (`code-icon.svg`, `letterpress-*.svg`).
- **The fork's workbench contribution**, `contrib/gemini/electron-browser/gemini.contribution.ts`, imported from `workbench.desktop.main.ts` (described next).
- **The native frame**:
  - Gemini first in the activity bar (its order in `api/browser/viewsExtensionPoint.ts`, plus a one-time move in `browser/parts/paneCompositeBar.ts` for profiles that cached it lower);
  - **New Agent** in the macOS Dock menu (`platform/menubar/electron-main/menubar.ts`, run in the window last used);
  - a description on agent tabs for their line counts (`WebviewInput` in `webviewPanel/browser/webviewEditorInput.ts`, set through `_gemini.setAgentTabs`, matched by tab title). Agent tab icons show the agent's state as SVGs in `media/tabs/`, because tab labels draw a ThemeIcon without its colour or spin.
- **Slimming upstream down**:
  - with `chat.disableAIFeatures` on (GeminiCode's default), Copilot setup does not start (`chatSetupContributions.ts`), so there are no entitlement requests to GitHub at startup;
  - the `tunnel-forwarding` extension, which needs the `code` CLI GeminiCode does not ship, is left out of the build (`build/lib/extensions.ts`);
  - the layout tolerates the activity bar being hidden before its grid exists (`browser/layout.ts`), which Agents mode does at startup.
- **Four workbench edits**:
  - Chat commands are hidden from the Command Palette while upstream AI is off (`commandsQuickAccess.ts`);
  - the Gemini extension cannot be disabled (`extensionEnablementService.ts`, with its test);
  - the product name in the welcome walkthrough (`gettingStartedContent.ts`);
  - the default colour themes (`ThemeSettingDefaults` in `services/themes/common/workbenchThemeService.ts`, with a fallback in `services/themes/browser/workbenchThemeService.ts` to upstream's Dark/Light 2026 if the GeminiCode themes are ever missing).

Edits for specific features (tab rows, agent groups, spell check, menus, the browser) are described with those features under [The agent workspace](#the-agent-workspace).

### The workbench contribution

`gemini.contribution.ts` is a fork-only file. It does what the extension API has no equivalent for.

- **System notifications and the Dock badge.** It registers the internal commands `_gemini.showToast`, `_gemini.hideToast` and `_gemini.setApplicationBadge`.
- **Window defaults.** When the workbench loads, it registers the defaults that must hold from the first frame, before any extension runs. An extension's `configurationDefaults` arrive after the startup page has decided what to open. These defaults are: upstream's AI off; no onboarding, startup editor or empty-editor hint; the view icons at the top of the side bar; the secondary side bar hidden; pill tabs; and the browser button in the title bar.
- **Code fonts.** It loads the bundled JetBrains Mono and Geist Mono (TTF files in `contrib/gemini/electron-browser/media/`, declared in `geminiFonts.css`), because extensions cannot add fonts to the editor.
- **`geminiSoft.css`.** This is the half of GeminiCode Dark and Light that a colour theme cannot express: a static graphite tint at the top of the window (no accent hue) behind the Modern UI layout's floating cards; 8px card corners whose top edge catches the light; the title bar's Home button, Agents | Editor switch and tabs as glass (a translucent fill and a rim); and upstream's frosted pop-ups made opaque (no blur) with a sheen and the rim. All of it is keyed to `gemini-soft`, a class the same file puts on each workbench window while one of the two themes is on (stylelint rejects matching on the theme's own class name). Its CSS variables are listed in `build/lib/stylelint/vscode-known-variables.json`, which hygiene checks against.

The stylesheet is static apart from one transform, which slides the mode switch's lens, so it costs nothing at runtime. It was profiled with an agent streaming a long reply while the chat scrolls, a menu open over it and a mode switch, three runs before and after: no measure (paint, raster, composite, layout, dropped frames) moved beyond the spread between runs, under 0.01 ms per frame.

Its siblings in the same folder are `geminiModes.ts` (the window modes), `geminiTitleTabs.ts` (Agents mode's title bar tabs) and `geminiBrowser.ts` (the agents' browser), all described below. The i18n list in `build/lib/i18n.resources.json` names the folder.

## How a prompt flows

```
Chat webview ──postMessage──▶ ChatController ──▶ AgentClient ──▶ AgentRuntime ──stdio JSON-RPC──▶ gemini --acp
     ▲                              │                                  │
     └──── batched item updates ◀───┴── ChatTranscript ◀── session/update notifications
```

### The agent process

`AgentSidecar` spawns the CLI with the application's own Node (`ELECTRON_RUN_AS_NODE=1`), so users need no Node install. The process starts when a chat first opens, not at activation.

It inherits the editor's environment, including proxy and CA variables, with these changes ([FINDINGS.md](FINDINGS.md#starting-the-agent)):

- `GOOGLE_CLOUD_PROJECT` set to the resolved project, and `GOOGLE_CLOUD_PROJECT_ID` cleared;
- `GEMINI_CLI_NO_RELAUNCH=true` and an explicit heap size;
- `--admin-policy` (see [Security model](#security-model));
- `--include-directories` for each folder, only with `gemini.agents.allWorkspaceFolders` in a multi-root window (`includeDirectoryArgs`). ACP sessions build their config from the process's arguments, so every session's workspace would then cover all the window's folders. The setting is off by default, so an agent keeps to the folder it works in. With it on, a change to the folders restarts the process once no prompt runs.

Restarts:

- A crashed process restarts with backoff (1 s, 4 s, 15 s; the count resets once a process stays up for a minute), but never after a fatal exit such as a failed sign-in (exit code 41).
- Exit code 199, the CLI asking to be relaunched, restarts it at once.
- Changing a setting that affects the process (CLI path or version, project, approval or shell settings) restarts it. The restart is immediate when the change takes a permission away or changes which MCP servers may load (`takesAway`); otherwise it waits until no prompt runs, so turning on YOLO doesn't cut off a running turn.

The command is worked out without blocking the extension host. The CLI's resolution, the CLI's settings and the admin policy file are read at once, asynchronously, and a stop that arrives while they are read wins, so a stopped agent never starts late.

### One process, many agents

`AgentRuntime` runs `initialize` once and serves every chat from that process. Each chat is its own ACP session with its own `cwd`. With a Google sign-in a new session takes about 0.8 s, against about 3 s for a new process ([FINDINGS.md](FINDINGS.md#sessions)).

`AgentWarmup` starts the process 3 s after the window opens (`gemini.agent.startEarly`), but only when it can start without asking anything: setup finished before, a saved sign-in or API key, and no project problem. A CLI with no saved sign-in opens the sign-in flow as it starts.

While the user types on Agent Home, `AgentRuntime.prepareSession` opens a spare session for that folder and the agent's browser servers (the agent id is chosen ahead for that). The next `newSession` with the same key takes it, so starting the agent waits for no `session/new`. A project's coordinator and threads never take a spare, because their sessions need the project's MCP server, which a spare opens without.

### Sessions, modes and models

`AgentClient` opens a session (`session/new`, or `session/load` to resume), signs in when the CLI asks, sends prompts, and exposes the modes and models the agent reports, minus any mode the admin policy turns off. Nothing in the UI hardcodes a mode or model ID.

It closes the sessions it leaves (the one a new session replaces, its own when disposed, and one an outdated open created) when the CLI advertises `sessionCapabilities.close`. gemini-cli 0.64.0 does not, so with it they stay until the process exits.

The model picker rebuilds the list the terminal's `/model` dialog shows from the one the CLI sends apps, which can name a model twice and lacks Gemma (`modelList.ts`). The model the user picked last (kept in global state) is applied to each new or reopened session when the agent offers it. With no pick yet, or one the agent no longer offers, it is the first Flash model the agent lists (`defaultModel`, never Flash-Lite). That also spares the CLI its Auto routing call ([FINDINGS.md](FINDINGS.md#a-prompts-first-reply)).

A chat restored at launch (`openLater`) waits to `session/load` until its tab is shown or used, or 2 s after its webview is ready, so restoring many tabs does not replay every history at once.

### Rendering

`sessionUpdates.ts` turns `session/update` notifications into a few UI events, and `ChatTranscript` folds them into plain, serialisable items. The controller streams item changes to the webview about 30 times a second, sending only appended text for streaming messages.

- **Long transcripts.** A long transcript shows its last 30 items first and adds the older ones above them in idle time, 20 at a time. All but the last 30 elements are marked settled, so they skip layout while out of view.
- **Hidden chats.** An agent's chat whose tab or pane is hidden keeps the updates it receives and renders them, coalesced, when it shows again. The host sends `visibility`, since `document.hidden` doesn't see a hidden tab.
- **Streaming replies.** A streaming reply re-renders only its unfinished tail. A tail over 4,000 characters re-renders at most every 150 ms, and code in an unclosed fence isn't highlighted until it closes.
- **Markdown.** The webview renders agent Markdown with raw HTML disabled, then adds GitHub-style callouts (`> [!NOTE]`), scrolling tables and links on file names in `code` (`markdownExtras.ts`; the extension finds the file from the agent's folder, else by name).
- **Math.** `$...$`, `$$...$$`, `\(...\)` and `\[...\]` are left as placeholders (`mathRule.ts`) and typeset by KaTeX, a bundle of its own that loads with the first reply that has math (`math.ts`, `katex.ts`). Prices and shell variables stay text.

### Code blocks

Finished code blocks are highlighted by highlight.js (about 30 languages, `webview-src/highlight.ts`), a bundle of its own that loads with the first code block and runs when the view is idle. Results are cached, so a re-render is coloured at once. A block still streaming stays plain.

The colours are the colour theme's own. `themeTokens.ts` reads the active theme's file (and those it includes) and matches its TextMate rules to about 20 categories (`tokenColors.ts`), so code in chat looks as it does in the editor. Themes that can't be read fall back to Dark Modern and Light Modern colours.

Shell blocks also get Run (see [Terminals](#terminals)).

### Permissions

`PermissionBroker` holds each `session/request_permission` until the user picks one of the options the agent sent. A request that proposes an edit opens a real diff editor. Stopping a turn answers any open request as cancelled.

The CLI accepts "Allow for this session" on a shell command that reuses earlier tool output but doesn't keep it ([FINDINGS.md](FINDINGS.md#approval-modes-and-the-clis-own-changes)). GeminiCode therefore keeps those approvals itself, per session and in memory (`sessionApprovals.ts`), and answers repeats of the command prefixes allowed. A prefix is the program and, for programs with subcommands, the subcommand and where it matters the word after it (`git status`, `npm run lint`, `go mod tidy`); with options before the subcommand it runs to the first word after a plain word, so it is only ever longer. Redirect targets are approved one by one. The command is read from the call's `rawInput`, not its title.

These always ask again:

- commands that reach the network (including `gh`, `glab`, `gcloud`, `aws`, `az`), install a package by name, or run code they build;
- a redirect outside the agent's folders (`PermissionBroker.roots`) or after `cd`, and one whose target is a variable or a pattern;
- programs that run another program (`env`, `xargs`, `sudo`, `timeout`, shells, interpreters such as `python` or `node`, `npx`) and container tools (`docker`, `podman`);
- a program by a path outside the installed-program folders (`/bin`, `/usr`, `/opt/homebrew` and the like), relative or absolute;
- an environment prefix other than locale and colour variables;
- arguments and subcommands that run code: `find -exec` or `-delete`; `awk` with `-f`, `system(` or a pipe; `sed -f` or `e`/`w`; `make -f`, `-E`, `--eval` or a variable naming a program; `npm`/`pnpm`/`yarn` `exec`, `x`, `dlx`, `create` or npm settings; `go -exec`, `-toolexec` and `go env -w`; `kubectl exec`; and in git `-c`, `--git-dir`, `--upload-pack`, `--receive-pack`, `--exec`, `grep -O`, `clone -u`, `--template`, `--output`, `credential`.

`builtinPrefixes` names the test and read-only prefixes one approval may cover although their program otherwise always asks (`npx vitest`, `npx tsc --noEmit`, `npx eslint`, `python -m pytest`, `./gradlew test`, and read-only git and listing). Each rule has a source, `session` or `permanent`; `setPermanent` takes a permanent list from the host, for an "Always allow" that is not built yet. The CLI's `tools.allowed` is no place for one: gemini-cli 0.64 adds a deny rule for every other shell command once it lists a narrowed `run_shell_command(...)`, and calls the setting deprecated.

Approvals of task runners (`npm`, `make`, `gradle`, `cargo`, `go`, `npx` and the like) and of git commands that run hooks lapse when the agent writes a build file through the editor (`package.json`, a `Makefile`, `build.gradle`, `Cargo.toml`, a tool's config such as `vitest.config.ts`, anything in `node_modules` and so on), since the next run would run what the agent wrote. Every git approval lapses when it writes a git hook (any file named as one, wherever `core.hooksPath` points), a hook manager's settings, a `.git` file or a bare repository's `config` or `HEAD`. A lapsed permanent rule asks again for the rest of the session.

In Auto Edit gemini-cli 0.64 applies edits without consulting its policy engine (`shouldConfirmExecute` returns before the policy check), so no admin rule can make one ask. GeminiCode serves the writes, and `AgentClient` shows a card before writing a protected setting (`isProtectedSetting`: `.gemini/*.sh`, `.gemini/settings.json`, `.vscode/settings.json`, `.vscode/tasks.json`), refusing the write when the user rejects it.

In YOLO the chat allows requests itself, except the confirm class ([Team tools](#team-tools)), which always asks. **Commands Allowed for This Session...** lists and forgets the session's approvals.

### Files

The agent's `fs/read_text_file` and `fs/write_text_file` requests go through the editor. Reads see unsaved changes. Writes are applied as a `WorkspaceEdit`, so they can be undone, and then saved, because the CLI's own shell and search tools read the disk.

Requests are limited to the agent's folder, skip git-ignored files for reads, and refuse secret files:

- `.env`, private keys and credential files;
- cloud credentials (`application_default_credentials.json`, service account keys, the `gcloud` folder);
- cluster and registry configs (`.kube`, `kubeconfig`, `.docker`, `.dockercfg`, `.vault-token`).

A symbolic link is followed: its real target must be inside the folder too, and is checked for secrets again, so a link to `~/.aws/credentials` or to `.env` is refused.

Git-ignore checks go to one long-lived `git check-ignore --stdin` per folder (`gitIgnore.ts`) rather than a process per read, with answers cached for 30 seconds.

## The agent workspace

GeminiCode builds its agent views on public extension APIs rather than upstream's Agents window (`src/vs/sessions`). That window only takes agents registered in core code, and it is the fastest-moving part of upstream. The domain names (workspace, agent session) follow upstream's, so the views can move onto it if it gains an extension API.

### Agents and Editor modes

`contrib/gemini/electron-browser/geminiModes.ts` (fork-only) switches the window between two layouts, from a switch in the title bar or ⌥⌘M. Editor mode is the classic layout. A new workspace opens in Agents mode.

Agents mode:

- hides the activity bar, by setting `workbench.activityBar.location` to `hidden` in memory only, so the user's own setting returns in Editor mode;
- shows the Gemini side bar on the left and the extension's **Changes** panel in the secondary side bar;
- keeps its views fixed: when the user opens any other view container in the side bar (a command, a shortcut or an extension revealing it), the window switches to Editor mode with that container open and says so once.

Each mode stores which parts were open, per workspace (Editor mode also which side bar and secondary side bar), and switching only shows and hides parts. The mode is the context key `gemini.mode`, which the extension's views use in their `when` clauses. The workbench tells the extension about changes through `_gemini.modeChanged`, and `_gemini.getMode` answers at start.

In Editor mode, the same file draws a pill in the title bar for each agent that is working, waiting, or done and unread, from what the extension sends with `_gemini.setAgentStatus`. Clicking one opens that agent. Agents mode has no pills, because the title bar tabs and the agent list already show each agent's state.

The Changes panel is contributed by the extension and can register after the layout is applied, or not at all on a first open in Restricted Mode, where the extension does not run. Agents mode opens it as soon as it registers, remembering in workspace storage that it still owes it. At startup it also fills an open but empty secondary side bar with Changes; a view the user put there is left alone.

#### Tabs in Agents mode

In Agents mode the group holding the agents has no tab row of its own. `browser/parts/editor/geminiTabRows.ts` (fork-only) takes a policy from `geminiModes.ts`, and a marked edit in `editorTitleControl.ts` gives that group no tab row while every other group keeps the normal one. Agents mode sets `workbench.editor.showTabs` to `multiple` in memory only, so a file an agent opens has its name, × and editor actions.

The agents' tabs go to `geminiTitleTabs.ts`, a fork-only tab strip in the title bar: one capsule of tabs mirroring the agents' group, with icon and agent state, truncated title, close button, dirty dot, click to activate, middle-click to close, a context menu and overflow scroll. It stays on the agents when a file beside them is clicked, and redraws only on that group's own model events.

#### Each agent's side group

Each agent's files get a side group of their own, from `geminiAgentGroups.ts` (fork-only):

- Before it opens a file, diff or the Changes view, the extension asks for the agent's column with `_gemini.agentGroupColumn`. The group is made beside the agents' group the first time.
- Only the group of the agent in front is visible. The others are hidden with the grid's own view visibility, through `geminiSetGroupVisible`, a marked addition to `editorPart.ts`, so switching agents reloads nothing and each agent's files come back as left.
- A group that comes to hold an agent or Agent Home is the agents' group from then on and is never hidden (a hidden group's webviews lose their CSS anchor and draw as a small box in the corner). Team-flow pages do not count (`isAgentsTab`). New agents and Agent Home open in the agents' group (`_gemini.agentsColumn`), not the active group.
- Activating a hidden group (from Open Editors, say) brings its agent to the front.
- Closing an agent's tab or removing the agent sends `_gemini.closeAgentGroup`, which closes its files except those with unsaved changes. The group goes when its last file closes.
- The agent-to-group map is kept in workspace storage, since group ids survive a reload.

#### Title bar and side bar

In Agents mode the title bar carries a search button, which opens Quick Open in place of the Command Center that `geminiModes.css` hides there. It also carries the integrated browser button, which the window defaults turn on (`workbench.browser.showInTitleBar`). The foot of the side bar shows the selected agent's branch, which the extension sends with `_gemini.setAgentFooter` (a tree view cannot draw a footer).

### Agent Home

Agent Home (`agentHome.ts`, `webview-src/home.ts`) opens in Agents mode whenever the editor area is empty (except right after closing Agent Home itself), and from the house at the start of the title bar (`geminiModes.ts`, which runs `gemini.home`). The page loads only when first shown.

Its composer starts an agent in a chosen workspace and sends the prompt in one step, optionally on its own branch named after the prompt. Cards show the agents that are working, waiting, done or have changes, with Stop, Review, Merge Back and Open. Earlier agents can be resumed. Projects are listed apart from agents.

### Agents pane

The pane is a tree of workspaces (the open folder plus any the user adds) with agents under each. Workspace rows show just the folder's name, with its path as the tooltip.

Each agent row shows its status as a coloured dot, or a spinner while it works: working, waiting for permission, done but unread, needs attention, idle, or not started in this window. After the title is one short note (`src/acp/agentRow.ts`):

- the turn's clock while it works, ticked once a second for just the working rows, and only while the pane is visible;
- "waiting" when it needs permission;
- the lines it added when it is done;
- otherwise how long ago it was active.

The `+N −M` count and the git branch (read from `.git/HEAD`) are in the tooltip. An agent takes its name from its first prompt unless the user renames it. Removing an agent deletes its saved conversation; removing a workspace only drops it from the list.

The list has a Projects section (projects with their threads below) above the Agents section, each with its own + and a note when empty. Agents mode shows both, since its list has no header (`geminiModes.css`).

### Agent tabs

Each agent opens as an editor tab that reuses the chat webview, and is the main editor. There is no sidebar chat.

Files, proposed edits and diffs that the agent's chat or its Changes open go in the agent's own side group (above). Outside GeminiCode's workbench they go in the group after the agent's tab, added once if there is none (`editorPlacement.ts`). Either way the chat stays in view.

Add to Chat and the chat commands act on the agent tab in front, else the running agent used last, else a new agent (`AgentsView.chatFor`).

Switching to an agent's or thread's tab sends its chat `focus`, and showing Agent Home sends Home `focus`: the message box takes the cursor, unless a popup such as Project settings is open.

### First open and persistence

A first launch opens on Agent Home: the window defaults leave out upstream's onboarding and startup editor, and the Get Started walkthrough opens only from **Gemini: Get Started**. The first time a workspace opens, `layoutDefaults.ts` reveals the Gemini side bar (the workbench would otherwise open on the Explorer). After that the workbench restores whatever the user arranged.

The list of workspaces and agents is kept in global state. Each agent's visible conversation (the last 300 items, long text cut to 20,000 characters) and changed files are saved as one JSON file per agent in the extension's global storage. On reopen, or after the process restarts, GeminiCode resumes the session with `session/load` when the CLI supports it. Otherwise it starts a fresh session and says so in the chat. See [Restarts](#restarts) for everything else that survives a quit.

### The chat

#### Folded turns

`webview-src/workFold.ts` (no DOM, unit-tested) splits a turn's items into two parts:

- the fold: thoughts, tool calls, what the agent said between steps, answered questions;
- what shows after it: the answer, the plan, notices, a waiting question, the turn's end.

It also groups runs of tool calls of one kind and counts what the turn did. `work.ts` draws the fold's line, the pinned changed files and failures, and run lines. `transcript.ts` lays a turn out again when a new item or a step's change arrives, moving items' elements rather than rebuilding them. A folded fold holds no elements for its steps, and an unchanged fold or run line is kept, so a long turn streams no slower than the flat view. `gemini.chat.foldFinishedWork` turns folding off live.

#### Subagents

The CLI's `invoke_agent` tool reaches ACP as one `think` tool call titled `Delegating to agent '<name>'` and its final report. The chat draws it as a Subagent row (`subagentName` in `webview-src/chatLogic.ts`); any other title falls back to a plain tool row. The subagent's own steps are not sent over ACP.

#### Long chats

The chat draws a tick per prompt down its right edge (`webview-src/promptNav.ts`) and jumps between prompts with ⌥⌘↑ and ⌥⌘↓. Prompt positions are read only on a jump, or once a frame while scrolling, to light the current tick.

**Open Chat as Markdown** turns the transcript items into one untitled Markdown document (`src/acp/chatMarkdown.ts`): prompts and replies under headings, thoughts folded, tool calls as a list. An agent that is not running in the window is read from its saved conversation.

#### Follow the agent

With the composer's eye on, the chat opens the file of each read tool call as soon as the call names it, and of each edit or move once it completes, at the call's line (`src/acp/follow.ts`). Each call opens at most once, and at most one file opens every 250 ms (the latest wins, so a burst of reads does not flicker), as a preview with focus left in the chat, in the agent's editor group.

Folders, missing files, files outside the agent's folder and files that `secretPathReason` (`fileAccess.ts`) flags, such as `.env` or anything under `.ssh`, are skipped. Searches, commands and fetches open nothing.

#### Sending while the agent works

Files: `src/acp/promptQueue.ts`, `webview-src/queueStrip.ts`.

The composer stays open during a turn. Return sends now and ⌘Return queues (`isQueueShortcut`). The view sends the prompt with `when`, and `ChatController.send` keeps it in the chat's `PromptQueue` instead of dropping it.

- **Queued.** A queued message waits for the turn to end. All queued messages go together as the next prompt, as the CLI's terminal UI sends its queue.
- **Sent now (steering).** `trySteer` runs on every tool-call update and permission change. Once no tool call of the turn is running (`atSafePoint`; one waiting for permission has not started), it cancels the turn. When the turn comes back `cancelled`, it ends without a "Stopped." notice and the messages go at once as the next turn, with `steeringNote()` ahead of them: the CLI's own steering instruction, in a `<steering_note>` tag that a replayed session leaves out (`withoutSteeringNote`). gemini-cli's ACP mode has no way to add a message to a running turn ([FINDINGS.md](FINDINGS.md#steering-a-running-turn)), so this is the closest it gets without patching the CLI.
- **Held.** Stop, a failed turn or a full context window holds the messages instead. They wait in the strip above the input for the user to send, edit or remove.
- Messages sent during Compact, Undo or a new session go once that work is done.

A project's chat queues only: what the user writes while the coordinator works goes to the hub when the turn ends (see [Projects](#projects)).

#### Reactions

The user can react with an emoji to any of the agent's replies in an agent's or thread's chat. The project chat has no reactions. `gemini.chat.reactions.enabled` (on by default) shows the reaction button, picker and chips.

**The UI.** Hovering or focusing the reaction button at the end of a reply's row shows a quick bar shared by every reply (`webview-src/reactionBar.ts`): thumbs up, thumbs down, question mark, heart, and a smiley that opens the picker. The picker (`webview-src/emojiPicker.ts`, with search in `emojiSearch.ts`) has search, categories and a Recent row of 16, kept in global state by `src/host/chatReactions.ts` so every chat and window shares it. It is its own chunk, `media/emojiPicker.js`, loaded the first time a reaction button is hovered or focused. Its data comes from emojibase-data 18.0.0, fetched by `npm run emoji-data` (`scripts/build-emoji-data.mts`) with a pinned checksum and checked in as `webview-src/emojiData.json`, rather than taking a 52 MB dependency. Webview bundles are written as UTF-8 rather than escaping non-ASCII text, which keeps `chat.js` about 21 KB smaller.

**What a reaction says.** A reaction goes to the agent as a prompt carrying a hidden `<reaction_note>`. The decisions are pure functions in `src/acp/reactions.ts`. Four emoji have fixed meanings:

| Emoji | Meaning sent |
| --- | --- |
| Thumbs up | Approve what you proposed and go ahead. |
| Thumbs down | Stop, say in one line what you understood, and ask what to change; don't undo work. |
| Question mark | Explain the last reply more simply, with an example. |
| Heart | Nothing: a chip on the reply only. |

`gemini.chat.reactions.meanings` lays the user's and workspace's entries over these: an entry (one emoji, a meaning of up to 500 characters) changes or adds a meaning, but never removes a built-in. For any other emoji the note asks the model to decide what it means, with rules: approval means do the proposed next step, a negative means ask what to change, appreciation gets a one-line reply, and when unsure it asks. In every case the model first says in one short line how it read the reaction, before any tool call, so a misread shows before a tool runs. The note quotes the first 300 characters of the reply when it is not the latest one, and says when that reply's turn did not finish.

**When it is sent** (`routeReaction`):

- the heart, unless its meaning is edited, is only a chip;
- a thumbs up on a reply that offers Build This Plan builds the plan;
- when the agent is idle, the reaction starts a turn;
- while a turn runs, a thumbs down steers it at the next safe point (the note then warns that the last step may not have finished), and any other reaction waits in the queue. A second reaction to the same reply replaces one still waiting (`PromptQueue.addReaction`).

**The agent's reactions.** With `gemini.chat.reactions.agentReactions` on (the default), a `<reaction_rule>` sent once per session lets the agent begin a reply with `<react>X</react>`. `ChatTranscript` holds the start of a turn's first reply (up to 32 characters) while it could still be that tag, and lifts the emoji onto the prompt as a badge before the reply is stored or shown. Anything else is left as text.

Reactions are optional fields on transcript items, so they survive reloads, Fork and Rewind. A replayed CLI session turns its notes back into reactions (`withoutReactionNotes`). When a thread's turn came from the user's reactions, its turn-end report tells the coordinator "The user reacted ... to its reply." (`reactionReport`).

#### Spell check in the composers

`windows.ts` leaves Electron's spell checker on (a marked one-line edit). `geminiSpellCheck.ts` (fork-only, registered with a marked line in `windowImpl.ts`) shows the system's suggestions, Add to Dictionary, and Cut, Copy and Paste when a right-click in an editable field reaches the window.

Upstream's inputs and editors set `spellcheck="false"` on themselves. The Gemini pages set it off on their body and on for the chat and Agent Home composers, which let their right-click through instead of showing the webview host's menu. `gemini.chat.spellCheck` turns it off live. Languages follow the OS.

#### Themed menus

Upstream defaults `window.menuStyle` to `native` on a stable Mac build, which opens every workbench menu (the browser's Add to Gemini chevron, right-clicks in the editor, the explorer and tabs, select boxes) as the system's menu. `contrib/gemini/electron-browser/geminiContextMenu.ts` (fork-only) registers `custom` as the default, so they are drawn in the theme's `menu.*` colours. A user's own setting wins, and the macOS menu bar stays the system's.

Two menus are built in the main process: a right-click in a page of the built-in browser (`browserViewMainService.ts`, a marked edit) and the composers' spelling menu (`geminiSpellCheck.ts`). Both go through `platform/windows/electron-main/geminiContextMenu.ts` (fork-only), which sends the items to the window over `vscode:geminiShowContextMenu`. The workbench shows them with its context menu service and answers with the item picked, which main then runs. With `window.menuStyle` set to `native` the workbench answers at once and main opens the system's menu. A page in a window of its own (not a workbench window) keeps the system's menu.

An HTML `<select>` opens the system's menu whatever `window.menuStyle` says, so none is shown:

- in a webview each is wrapped by `webview-src/selectMenu.ts`, which keeps it hidden as the value and draws a button and one of GeminiCode's menus (`menu.ts`) in its place;
- the New Agent popup (`geminiNewAgentDialog.ts`) uses the workbench's `SelectBox`, custom-drawn unless `window.menuStyle` is `native`. Its model list comes from a running agent or, with none, the last list any session sent (`knownModelList`, kept in global state).

`test/webview/themedMenus.test.ts` fails on a new bare `<select>` in either place.

### Session snapshots, Compact and Fork

#### Session snapshots

gemini-cli 0.64 has no fork over ACP: its ACP library routes `session/fork`, but its agent leaves it out. Its `/restore` over ACP puts files back from a checkpoint but only reports the checkpoint's history, never loading it, and `/compress` is terminal-only. `session/load`, though, rebuilds a session from its file's messages.

So a snapshot (`sessionSnapshot.ts`) is a copy of the session's file:

- its messages as they stand, after rewinds and patches (`readSessionMessages`), cut before a prompt or compacted;
- written under a new id where the CLI keeps a folder's sessions (`writeSessionCopy`). The folder must be registered in `projects.json`, which the CLI does when it first opens a session there.

On load the CLI skips the saved `<session_context>` and puts a fresh one first, for the folder it opens in, and its file tools refuse paths outside that folder.

A compacted copy is a summary, the model's acknowledgement, then the latest prompts that fit in 30% of the session (at most four, `compactSplit`). It leaves out the token counts the CLI saved, which describe the whole session. `realSessionSnapshot.test.ts` checks whole, compacted and cut copies against the real CLI.

#### Compact

`/compact`, the usage popover's button, or the card the chat shows once a session passes 40% of the window (`shouldSuggestCompact`) runs Compact (`chat/chatCompact.ts`):

1. A summary turn runs whose updates stay out of the transcript (`ChatController.quietly`).
2. That turn is rewound out of the session.
3. The compacted copy is written and the chat moves to it with `session/load`.

The `compact` item keeps both session ids, so Undo moves back to the full session, also after a restart. If the agent can't open the copy, the chat goes back to its session. The CLI's own compression (at half the window, keeping 30%) lives only in memory and is lost when a session is reopened.

#### Fork Agent

Files: `chat/chatFork.ts`, `agents/agentForks.ts`.

The chat works out the Fork dialog's token estimates and what the fork starts with:

- **Whole**: the session's messages;
- **Compacted**: a compacted copy whose summary comes from a quiet turn rewound out of the parent's session, which the parent then reopens;
- **Conversation only**: the prompts and replies, carried with the first prompt.

Fork from Here sits at the end of a reply and stops before the next prompt (`forkPointAfter`). While a turn runs, the fork stops before that turn's prompt (`messagesBefore`, `forkedItems`).

The Agents pane gives the fork a folder in one of two ways:

- its own branch, made with `createWorktreeFrom` from the parent's folder and branch, with the parent's uncommitted changes from a `git stash create` commit and its untracked files copied, the parent untouched. It is refused mid-merge or mid-rebase.
- the parent's folder, shared without owning it (`forkedFrom.sharedFolder`), so the fork never merges or removes it.

It has the CLI register the fork's folder with a session it closes again, writes the copy there, and starts the fork with `sessionId` set to the copy, the parent's chat shown, a `fork` line, and a note with its first prompt saying where it works now (`forkNote`).

Forks are listed under their parent (`AgentRecord.forkedFrom`), and the parent's chat gets a card per fork. Merge Back of a fork whose parent works on a branch of its own asks where to merge (`AgentMerge.mergeTarget`). A fork of a single-repository project thread is described under [Projects](#projects).

#### Undo and Rewind

Files: `checkpoints.ts`, `checkpointStore.ts`.

After each turn, the text every file had before the agent first edited it in that turn is kept, for the last 100 turns and 20 MB per agent. It is saved to `<globalStorage>/checkpoints/<agent>.json` after the turn ends, never while a tool runs, and deleted with the agent.

ACP has no rewind. Rewind appends the record the CLI's own `/rewind` writes (`{"$rewindTo": <message id>}`, `rewindCliSession` in `cliSessions.ts`) to the session's `.jsonl`, then loads the session again over ACP in the same process. The CLI rebuilds its history without that message and what followed.

Rewind always does both: it undoes the code from the first kept turn after the message, then rewinds the session. The message is found by its text; if it can't be (a team command's prompt), only the code can be undone. `realRewind.test.ts` checks this against the real CLI.

### Changes, Git and worktrees

#### Changes panel and Changes view

The **Changes panel** (`changesPanel.ts`, `webview-src/changes.ts`) is Agents mode's live diff of what the agent in front changed. Each change shows as a unified diff with Keep and Undo, which run the same commands as the editor's CodeLenses, plus Keep All, Undo All and Commit (or Merge Back for an agent on its own branch). Diffs are worked out with `lineDiff.ts` against the open document's text, 150 ms after the last edit, and only while the panel is visible.

In Editor mode the **Changes view** below the Agents pane is shown instead. It lists the files the agent in front has edited, recorded from its completed edit tool calls. Each file opens a diff against its text from before the agent's first edit, **Open All Changes** shows them in the multi-diff editor, and **Clear List** forgets them.

#### Git

Each chat's composer shows the folder's branch as a pill that switches or creates a branch through the built-in Git extension, which is only activated when the user picks an action (`gitActions.ts`).

An agent's chat also offers **Create Branch & Commit**. It stages and commits only that agent's changed files to a new branch (suggested as `gemini/<agent name>`, with the agent's name as the message), warns first when other files are already staged, and then clears the agent's Changes list.

#### Worktrees

An agent can work on its own branch in a Git worktree (`src/acp/worktrees.ts`, plain `git` commands). Worktrees live in `~/.geminicode/worktrees/<repository>/<branch>` rather than inside the repository, so the open workspace's search, file watchers and language servers don't see every file twice.

The agent's session gets the worktree (or the workspace's matching subfolder in it) as its `cwd`, and the agent record keeps the folder, branch and base. Creating one costs a checkout of the repository's files, shown as progress, and nothing on later prompts.

**Merge Back** commits leftovers with the agent's name and runs `git merge --no-ff` in the workspace's repository, leaving conflicts for Source Control.

### Terminals

Files: `agentTerminals.ts`, `chat/chatRun.ts`, `terminalGemini.ts`, `src/acp/runCommands.ts`, `src/acp/riskyCommand.ts`.

These terminals are the user's. Agent commands run inside the CLI: `clientCapabilities.terminal` is false, and gemini-cli 0.64 never calls `terminal/create`.

`AgentTerminals` keeps each agent's terminal per folder, closed when the agent is removed. It also keeps the last command of every terminal, read from shell integration as it runs, because a command's output can only be read from its start: the command line, exit code and last 200 lines (`OutputTail`, control sequences stripped).

**Run on a reply's shell block** (`webview-src/runButtons.ts`) sends the block's text to the host, which:

1. takes its commands (`blockCommands`);
2. picks the place (`placeFor`): the agent's folder, or the repository a command names in a thread or project with several;
3. checks it (`runRisk`) for deletes, `git clean`, discarded work, force-push, root, a download piped to a shell, disk writes, writes outside the folder (by redirect or by a `cp`, `mv`, `rm` or `tee` argument), and several commands;
4. either asks in the block or runs it with `shellIntegration.executeCommand`, waiting for as many commands to end as the block has lines. Without shell integration after 3 s it types the command in and reports nothing.

Block states go back by the block's text, so a redrawn block keeps its result. `gemini.chat.runCommands` (policy `GeminiChatRunCommands`) is `askWhenRisky`, `alwaysAsk` or `off`. A coordinator's Run always asks.

**From a terminal to Gemini:**

- Send to Gemini uses the proposed `terminalSelection` API.
- Ask Gemini on a failed command uses the proposed `terminalQuickFixProvider` API (an `explain` quick fix). Both proposals are enabled in the extension's `enabledApiProposals`. Command marks' own menus can't be extended.
- ⌘I in a terminal asks the quick model (`QuickEdits.enhancePrompt`) for one command and shows it in a quick pick before it runs.

### Projects

Projects are on by default (`gemini.projects.enabled`). A project is a coordinator agent, whose chat is the project chat, plus threads: each thread is an agent on a new branch in its own worktree (`src/host/projects.ts`). The user's guide is [PROJECTS.md](PROJECTS.md); the go/no-go numbers are in [FINDINGS.md](FINDINGS.md).

#### The hub and the coordinator

What the user writes in the project chat goes to a `ProjectHub` (`src/acp/projectHub.ts`). The hub wakes the coordinator with one prompt holding the threads' state, open Conductor tracks (`conductor.ts`) and the new events, and batches events while the coordinator is mid-turn.

Only the user's messages wake the coordinator. A thread's result, question or failure is the user's to take up in that thread, and reaches the coordinator as context with the next message.

- **While the coordinator works**, what the user writes waits in the project chat's queue strip (Edit, Remove) and goes to the hub when the turn ends. The coordinator's turn is never stopped for it.
- **A failed wake** keeps its events. Its error offers Retry, and the user's next message carries them too; nothing wakes again by itself. A wake that failed before reaching the session sends the role brief again.
- **Compact** works on the coordinator. Its summary lists the threads, and the next wake carries the role brief and the notes again, as after a context overflow moves it to a new session.

The coordinator runs on a named Flash model and reaches the hub through the `geminicode-project` MCP server (`projectMcp.ts`, 127.0.0.1 with a token per caller). Its tools are `start_thread`, `message_thread`, `list_threads`, `read_thread` and `post`; a thread has `report`. The coordinator's calls of those tools are allowed at once and hidden, and any other tool it asks for is refused. A reply that only repeats the coordinator's last `post` is dropped (`ChatTranscript`), since models often end the turn by saying the post again.

The coordinator's session runs in an empty folder of its own (`~/.geminicode/projects/<id>`), so it has no code to read and hands work to threads. That folder links to the repository's context files (GEMINI.md, AGENTS.md and any `context.fileName`) but not its `.gemini` or `.agents` folders, whose skills, commands and MCP servers would pull it into doing the work. A thread's worktree links whatever rules the repository ignores (`projectRules.ts`).

#### Threads

Threads show as cards in the project chat that update in place, with Merge back, Review changes, Undo thread and Approve plan. Approvals stay in the thread that asked. A thread's chat has a bar back to its project chat, and the project chat's side panel lists every thread to open.

"New thread" in the + menu opens a dialog in the chat's webview (title, brief, branch, model, Plan first). The thread starts at once and the coordinator hears afterwards.

Starting a thread:

- `start_thread` returns as soon as the worktree exists. Worktrees are added one at a time per repository, so threads started together can't pick the same branch name.
- The repository's setup script runs behind a notification while the thread's agent starts. The brief is sent when setup ends.
- A thread that fails to start removes its worktree and branch again.

Notes to a thread are never dropped:

- a note sent to a thread still setting up waits for setup to end;
- a note sent mid-turn waits in the thread's queue strip, marked "From coordinator", with Send now and Remove, until the turn ends or the user sends it.

A follow-up on a thread's work goes to that thread whatever its state. Once merged, a thread is resolved (kept on its record, so across reloads) and takes nothing more unless the user asks to reopen it. Merge back checks the thread is idle both before and after its dialog, and runs once per thread at a time. Removing a thread from the agent list, or with its branch after a merge, also removes it from the hub and marks its card removed.

Fork Agent on a single-repository thread makes a new thread of the same project, always on a branch of its own, with the repository's rules linked in, a card in the project chat and a "forked" event for the coordinator.

#### Opening and trust

New Project asks only which folder (an open workspace or any Git folder) and opens the project chat at once, named after its repository.

The Gemini CLI loads MCP servers only in trusted folders. Opening or starting a project therefore asks to trust the coordinators' folder and the repository's worktrees folder when they aren't (`trustedFolders.ts`), then waits for the agent's restart.

A coordinator whose session opened before the CLI trusted the project's folders has no `start_thread` and can only say so. So before the first wake goes out, `Projects.ensureTools` opens the session and waits up to 10 s for the CLI to list the coordinator's tools (`ProjectMcpServer.whenListed`). If they don't appear, the message waits while GeminiCode asks to trust the folders or, when they are trusted already, restarts the agent once no agent is working (`reloadProjectTools`), and the session reopens with them. When something else keeps the tools out, `projectToolsCheck.ts` reads the files the CLI decides by (folder trust, `mcp.excluded`, `admin.mcp.enabled`, `mcp-server-enablement.json`) and the project chat names the cause instead of restarting.

#### Side panel and footer

A side panel (`webview-src/project.ts`) shows when the view is at least 1000 px wide. It lists the threads by state (each opens its chat), the Conductor tracks and the coordinator's model, and resizes from a sash (drag, arrow keys, double-click to reset). The extension sends it updates only after a burst of card updates settles.

In a project with several repositories, the coordinator's chat shows one pill per repository with its checked-out branch where the folder and branch pills go, and a thread across repositories shows its worktree of each (`ViewGit.repos`). Each pill opens Copy Path and Reveal for that repository.

#### Settings and memory

Project settings opens as a popup over the project chat (`webview-src/projectSettings.ts`, its state in `settingsLogic.ts`) from the side panel's gear or the project's context menu. It has two tabs:

- **General**: name, repositories, defaults for new threads, stats;
- **Memory**: the Memory text, context files and which role reads each, the repositories' own rules files, and a token estimate.

Nothing is saved until Save. Cancel and Escape ask before discarding edits, and refreshes from the extension keep unsaved edits.

Settings live in the project's own folder, never in a repository (`projectStore.ts`): `project.json`, `instructions.md` and `memory/*.md`.

The Gemini CLI imports `@` files only from inside a session's folder, so memory is not passed as rules files:

- the coordinator gets it in a wake's `<notes>`, sent again only when it changes;
- a single-repository thread gets it as unseen context ahead of its brief (`ChatController.addContext`);
- a multi-repository thread gets it in its folder's `GEMINI.md`.

A new project's Memory text is Gemini's draft (`projectDraft.ts`): one direct request on the quick-edit model with each repository's README, agent rules, manifest and top folders. It is saved with the time it was drafted, so the popup asks the user to review it until they save from the Memory tab. Adding a repository redrafts a text that is empty or still unreviewed.

#### Projects with many threads

Opening a project costs the same with 5 threads or 500.

- Opening a project starts only its six most recently used open threads' sessions, without tabs (`warmThreads`, `resumeThread`), one at a time and 1.5 s apart so they don't compete with the window's start, skipping any whose worktree is gone.
- Any other thread starts when it is likely needed: the pointer rests on its card or side-panel row, or the keyboard selects it in the agent list (`onIntent`, `prepareThread`); when it is opened; or when the coordinator messages it. A thread started that way shows its saved chat first, and prompts wait until that chat is in (`ChatController.holdPrompts`), so a note can't replace the history.
- `read_thread` reads a thread that isn't running from its saved chat rather than starting it.
- Each wake lists every open thread but only the ten latest merged ones (`wakeThreadLines`); `list_threads` with `all: true` lists the rest.
- A thread merged over a week ago is archived (`isArchived`, from `resolvedAt`). It moves under an Archived row in the agent list and leaves the side panel, and keeps its record, chat and branch.
- Project settings' Clean Up removes merged threads' worktree folders whose work is all merged into the repository's checked-out branch (nothing uncommitted, no commits ahead), after a dialog that gives the space freed. Opening or messaging such a thread puts its folder back from its branch first (`restoreWorktree`).

`test/perf/budgets.test.ts` times a 500-thread project.

#### Projects across several repositories

A project lists its repositories in `project.json`, its own repository first, each with a key (its folder's name). With more than one:

- the coordinator's first wake adds how to choose them, and every wake lists them as `<repositories>`;
- `start_thread` must name the thread's `repos`, and errors otherwise, telling the coordinator to ask the user which when the request doesn't say.

One thread holds every repository a task touches. Its agent runs in its own folder, `~/.geminicode/threads/<project>/<branch>`, which holds:

- a worktree of each repository (`<key>/`), all on one branch free in every repository;
- a generated `GEMINI.md` saying which folder is which, that the folder isn't a repository, and the memory;
- a `.geminiignore`.

That folder needs trusting too, so a project with several repositories also asks to trust `~/.geminicode/threads`. A thread that needs another repository calls `add_repo`, which only multi-repository threads are offered.

Each repository merges back on its own from the thread's card (or a pick in Merge back), committing only that worktree's work. The thread is resolved once no repository has work left. Undo and Remove delete every worktree, then the thread's folder. The New thread dialog offers the repositories as checkboxes, and takes its model, Plan first and branch prefix from the project's defaults.

### The GeminiCode browser

Upstream's Integrated Browser ships with agent tools, but they reach only Copilot's chat. GeminiCode serves its own.

#### The server and its tools

`src/acp/browserMcp.ts` is an MCP server on 127.0.0.1 (Streamable HTTP with plain JSON replies), with one path and its own bearer token (an HMAC of a random key) per agent. `src/host/browserTools.ts` passes it to each agent session in ACP's `mcpServers`, only when the CLI advertises `mcpCapabilities.http` (the bundled CLI does), and disposes the server when `gemini.browser.enabled` is turned off.

Its tools are `browser_navigate`, `_snapshot`, `_click`, `_hover`, `_type`, `_select`, `_press_key`, `_scroll`, `_back`, `_forward`, `_reload`, `_wait`, `_screenshot`, `_dialog`, `_console`, `_network` and `_dev_servers`. They call the fork-only workbench commands in `contrib/gemini/electron-browser/geminiBrowser.ts`, which use upstream's browser view and Playwright services directly. Each agent has a Playwright session `gemini-agent:<id>` and owns the pages it opens. The commands run only fixed actions, never code from the extension.

- `browser_console` reads the page's console from the browser view (`getConsoleLogs`).
- `browser_network` reads requests that a fixed Playwright listener keeps on the page (`recordNetwork` in `geminiBrowser.ts`, attached when the agent's page opens or is handed over, the newest 500).
- Both filter in the extension and send back a count and the last lines, never the whole log.
- `browser_dialog` uses Playwright's `replyToDialog`.
- `browser_dev_servers` (`src/acp/devServers.ts`) sends one HTTP request to each usual dev port on `127.0.0.1` and `::1` at once, only when called.

The tool descriptions, the server's `instructions` and the shared-page note tell the model to use the browser rather than the CLI's `web_fetch` for local, private-network and signed-in pages. gemini-cli's web fetch refuses any host that resolves to a private address (or doesn't resolve) before fetching, and otherwise fetches through Google. When a `web_fetch` call fails that way (`src/acp/webFetchHint.ts`), the chat adds a notice pointing to the browser.

#### Agents' pages

`geminiBrowser.ts` adds the "Gemini is using this page" bar with Stop to pages an agent owns. Pages open in the side group without taking focus. Open, snapshot and screenshot return the page's real URL, which the server checks after every step. Removing an agent closes its pages and session, except pages the user handed it, which go back to the user.

With `gemini.browser.keepSignIns` on, `_gemini.browser.open` creates agents' pages in workspace storage instead of agent storage (`agentPageStorage`), except where the user's own pages use workspace storage, in an empty or untrusted window, or under a network policy. The ids of pages agents opened are kept in workspace storage, so after a reload a page is told apart from one the user handed over. The extension also defaults `workbench.browser.openLocalhostLinks` on.

#### What a page may load

- `gemini.browser.allowedOrigins` (`isAllowedOrigin`) is checked before anything else for every http(s) page: on navigate, after every step and on hand-over.
- Local http(s) URLs open freely.
- Any other origin, including one a click or redirect leads to, asks once per agent and site (a modal dialog), and the page goes back if refused. `gemini.browser.allowOtherSites` off refuses them all.
- `file:` URLs follow the agent's file policy, and so does every file an agent's page loads.

That last rule needs work in the main process. Electron gives `file:` pages more than a browser does, so a page the agent wrote could otherwise show it, in a frame or through fetch or a worker, a file the policy refuses.

- The main process (`platform/browserView/electron-main/geminiAgentFiles.ts`) holds each `file:` load of a Gemini agent's page until the page's window has asked the extension (`_gemini.browser.fileAllowed`, `BrowserToolHost.fileAllowed`).
- An agent's documents get `worker-src 'none'`, because workers load files where neither `webRequest` nor the session's `file:` handler sees them.
- Loads with no page (a service worker) are refused in a session that held an agent's page.
- A `file:` page the user hands over is reloaded so its files are checked as the agent's.

#### Handing a page to an agent

**Let Gemini Use This Page** is an `Action2` in `geminiBrowser.ts`, in the page's actions toolbar and the Command Palette. It is hidden on any agent's page (the editor-scoped `geminiBrowserPageIsAgents` key) and when `config.gemini.browser.enabled` is off. It calls the extension's `_gemini.browser.handOver`, which:

1. Shows a quick pick: New Agent..., the running agents, and up to ten recent ones, which start before they get the page (`BrowserTools.handOver`). New Agent opens one popup, `_gemini.newAgentDialog` in `geminiNewAgentDialog.ts`, for the folder, its own branch or not, the model, the mode and an optional task. The workbench draws it because no extension API can float a form over the browser's page, and its block carries `monaco-dialog-modal-block` so the browser's overlay manager hides the page under it. `AgentsView.newAgentFor` then starts the agent with its tab open, and a task is sent with the page.
2. Checks the page's URL as for the agent's own pages, without asking (`handOverRefusal`): http(s) unless the policy keeps agents local, `file:` per the file policy, nothing else.
3. Calls `_gemini.browser.share`. The workbench refuses a page that any agent owns or that is being handed over (one agent per page), adds the agent's session as the page's audience (the main process refuses that outside the network policy), makes the agent the owner, and waits for Playwright to see it.
4. Checks the returned URL again, records the page as the agent's and its origin as allowed for that agent (`adopt`), and adds a note to the agent's composer that names the page and says its text is not the user's.

**Stop Sharing** on the bar (`gemini.browser.stopSharingPage`) sets the owner back to the user and removes the audience; the agent's next tool call finds no page. A page counts as handed over when it is recorded as such or is not in agent storage (pages agents open always are), so a window reload doesn't make Remove Agent close it.

#### Add to Gemini

**Add to Gemini** (the `GeminiBrowserAddToGemini` split button in a page's toolbar, `GeminiPageContext` in `geminiBrowser.ts`) does for Gemini what upstream's Add to Chat does for Copilot's chat, which GeminiCode turns off. It drives the same page overlays (`toggleElementSelection` in select or comment mode, `toggleAreaSelection`, and `setElementComments` for the pinned notes), and sends the element, the notes, a screenshot or the console to `_gemini.browser.addToPrompt`. That builds the attachments (`src/acp/pageContext.ts`) and adds them to the composer of the page's agent, else of the chat in front.

The editor-scoped `geminiBrowserElementSelection` key marks a selection as Gemini's. Upstream's chat integration (`browserEditorChatFeatures.ts`, one `GEMINI-FORK` check) ignores selections while Copilot's chat is off or the selection is Gemini's. Gemini's keybindings take upstream's (Cmd+Shift+C, Cmd+Alt+C) only while Copilot's chat is off.

### Keep awake

On macOS, while any prompt runs on the shared agent process (`AgentRuntime.onDidBecomeBusy` and `onDidBecomeIdle`), the extension runs `/usr/bin/caffeinate -i -w <extension host pid>` (`src/acp/keepAwake.ts`). It prevents idle sleep only, not display sleep, and exits on its own if the extension host dies, so it can never outlive GeminiCode.

It is stopped when the last prompt ends, started again (up to three times per busy spell) if it exits on its own while a prompt still runs, and not tried again once it fails to start. `gemini.keepAwake` turns it off.

### Look

The extension contributes two colour themes (`extensions/gemini/themes/`), **GeminiCode Dark** and **GeminiCode Light**, which the `ThemeSettingDefaults` edit makes the defaults directly. Each is a complete theme with its own token colours, so it needs no other theme; a `configurationDefaults` entry would let upstream's default theme show first. High contrast defaults stay upstream's.

Defaults, each of which the user can change:

- the window defaults (see [The workbench contribution](#the-workbench-contribution)) put the view icons at the top of the side bar, hide the secondary side bar, use pill editor tabs and the browser button in the title bar, and open no startup editor or empty-editor hint;
- the extension's `configurationDefaults` set JetBrains Mono as the editor font, the `geminicode-icons` file icons, localhost links opening in the browser, no breadcrumbs or minimap, and a slightly roomier editor.

The layout uses only native views and editor groups, so every part stays resizable.

The webviews' stylesheets (`media/chat.css`, `media/panels.css` and the shared `media/menu.css`) name the theme's colours once, as `--gemini-*` variables, so they follow any theme. High contrast themes keep their own colours and borders. Chat text is 14px. The Gemini gradient is kept to the sparkle, the working bar on the composer's top edge and the focused composer's outline.

`media/glass.css`, loaded last on every page, gives the webviews the same glass as the workbench: cards and the composer with a lighter top edge, glass buttons and pills, and opaque pop-ups with a sheen and one shadow (the **+**, model, branch and folder menus in `webview-src/menu.ts`, the `@` and `/` picker, usage, and the dialogs). Nothing uses `backdrop-filter` or a mask (`test/themes/noBlur.test.ts` fails on one), and every animation is a `transform` or an `opacity`, paused while the view is hidden.

Selections, menu highlights and quick-input focus are graphite greys rather than the accent in both themes. The user's chat bubble mixes the editor's foreground into its background (7%) and border (15%).

The **Make It Yours** page (`appearance.ts`) marks the theme the window shows. With `window.autoDetectColorScheme` on it reads the preferred light or dark theme, and picking a theme turns auto-detect off so the pick holds.

The model, branch and folder menus replace the system select menu and quick picks. The branch menu asks the extension for the folder's local branches (`listBranches`) and switches or creates one through the git extension's API (`switchBranch`).

### Team tools

#### The local MCP servers

GeminiCode runs four MCP servers of its own: the browser's, the team tools' `geminicode-tools` (`src/acp/teamToolsMcp.ts`), a project's `geminicode-project` and the index's `geminicode-index`. All four are built on `localMcpServer.ts`:

- Streamable HTTP with plain JSON replies on `127.0.0.1`;
- one URL and HMAC bearer token per route;
- a JSON-RPC error for a request that fails, and an error result the model can read for a tool that throws.

The browser's and the team tools' routes are agents, with slots for spare sessions that are bound to the agent that takes the session (at most eight unbound slots are kept). An agent's slots are dropped when it is removed, after which they answer 404.

#### Connectors

`TeamConnections` (`src/host/teamConnections.ts`) owns `geminicode-tools` and gives it to every session once any tool is connected. The server lists tools only for connected tools, so a user with nothing connected pays nothing in prompt size.

The connectors call each tool from the user's machine, so the Mac's VPN, proxy and certificates apply:

| Tool | Connector | Auth |
| --- | --- | --- |
| Jira Cloud REST v3 | `jira.ts` | email plus API token |
| GitLab REST v4 | `gitlab.ts` | `PRIVATE-TOKEN` |
| SonarQube Web API | `sonar.ts` | bearer token |
| The user's Snyk CLI | `snyk.ts` | JSON and SARIF output |
| Figma desktop app's Dev Mode MCP server on `127.0.0.1:3845` | `figma.ts`, a small MCP client | none |

`teamHttp.ts` gives every call an 8-second timeout and turns failures into a reason the user can act on (no answer: check the VPN; 401: replace the token). Tokens are in SecretStorage only; agents never see them. Tool results are trimmed text (`teamTools.ts`), never raw JSON. Tool results that carry other people's text are wrapped in an `<external>` tag (`external()` in `teamTools.ts`), which the server's instructions tell the model to read as data. Team defaults come from `.gemini/geminicode-tools.json` (`teamDefaults.ts`).

#### Reads, writes and the confirm class

Reading tools are answered at once (`TeamConnections.instantAnswer`, the same hook projects use). Write tools always reach the permission card.

The confirm class (`teamConfirmTools`) is a ticket's status, a time log, a new merge request and a merge, plus the same actions in a team's own `jira` and `gitlab` MCP servers. These go through `PermissionBroker.confirmOnly`, which drops every option but Allow once and Reject and skips the instant answers, because the CLI applies "Allow for this session" to all of a server's tools.

#### Audit log

Every write, by an agent or from a page, goes through the audit log (`src/acp/auditLog.ts`): one JSON line per record, in a file per day under global storage, never rewritten. Each write records an intent before the call, then a result with the id the tool gave back, or the failure.

An intent with no result is a write that was running when the app quit. **Open Audit Log** (`src/host/auditPage.ts`, a webview page over the same files) highlights those, Home lists them under Unfinished, and the status bar counts the day's writes (`auditStatusBar.ts`).

#### A repository's own Jira and GitLab servers

Once the user takes over a repository's own Jira and GitLab servers (`src/host/teamTakeover.ts`), `TeamConnections` runs them as children (`src/acp/teamContainers.ts`: pinned images, `docker run -i` with the tokens only in the child's environment, a curated tool list) through a small stdio MCP client (`src/acp/mcpStdio.ts`).

- Jira's and GitLab's are warmed when an agent's session opens; the others start on their first call; each stops when idle.
- A call waits at most 8 seconds for a start under way, which goes on without it. After a failed start, calls skip the child for 5 minutes. So neither a container starting nor one that can't start holds up an agent's turn.
- `runTeamTool` sends the calls that map one to one through the children, and the rest, or everything when a child can't start, through the in-process connectors.

#### Performance trace, benchmark and pilot counters

**Record Performance Trace** (`src/host/traceCommand.ts`, `src/acp/traceRecording.ts`) restarts the agent once with the CLI's OpenTelemetry export going to a file in the home folder, prompts off. While it records, every turn's end gets a readout in the chat of where the time went, hop by hop against a budget for each hop (`turnReadout`: the fork's own hops from what the chat controller measured, the model's and the tools' from the CLI's file). Stop reads the whole file back into a table of each turn's routing call, model calls, tool calls and cached tokens. The CLI writes its records as JSON objects back to back, not one per line, which `parseTraceFile` handles.

**Run Benchmark** (`src/host/benchmarkCommand.ts`) and `scripts/bench-run.mts` share `src/acp/benchmark.ts`, which the command loads only when it runs.

The pilot's counters (`src/acp/pilotLog.ts`) go nowhere unless `gemini.pilot.record` is on. `recordPilot` calls in the chat, the review, the team requests and writes reach a sink that `src/host/pilot.ts` sets, which appends a file per day. **Export Pilot Data** writes them with the audit log to `~/geminicode-pilot/`.

### Merge request reviews

A review (`src/host/reviewSession.ts`, one per merge request, listed by `src/host/reviews.ts`) is a draft that only the user's post sends to GitLab.

**The reviewer.** The reviewer agent works in a worktree of its own checked out at the source branch (`reviewWorktree` in `releaseMerge.ts`). It reads the merge request against its ticket and the open threads, and ends with its findings as a JSON block.

**The draft.** `src/acp/reviewDraft.ts` turns that block into draft comments, replies and suggested changes. The module holds the draft's logic and calls nothing: ticking, editing (an edited comment of Gemini's is kept when Gemini reviews again), moving comments to a newer version by the text of their line, and the GitLab position each one is posted at.

**The diffs.** `src/host/reviewDiffs.ts` shows read-only documents of the two commits GitLab's `diff_refs` name, read with `git show <sha>:<path>` from the user's clone after fetching both branches, so neither the user's checkout nor the reviewer's worktree is read or changed. Comments and threads in those diffs go through the comments API (`src/host/reviewComments.ts`), and the Review page and the diffs edit the same draft.

**Storage.** Every change is written to `<globalStorage>/reviews/<project>-<iid>.json` (`src/acp/reviewStore.ts`), so a closed page or a quit loses nothing. Home, the reviewer's chat and **Open Merge Request Review** reopen from there. A draft goes once it is posted or discarded, or after two weeks untouched.

**Posting.** Posting writes each ticked comment through `teamWrite`, so it passes the same checks and audit log as an agent's write, against the version the user reviewed. A comment on an unchanged line carries both `old_line` and `new_line`, as GitLab requires. A comment GitLab refuses on a line is posted as a general comment that names the file and line. When the source branch moves, the page says so, and Refresh reads the new version and marks the comments whose line changed.

### Workspace index

GeminiCode indexes each folder agents work in, and documentation the user attaches, and serves both to sessions through its MCP server `geminicode-index` ([ADR 0010](adr/0010-workspace-index.md); the user's view is in [the guide](guide/agents.md#workspace-index-and-docs)).

- **Where it runs.** `src/acp/index/indexer.ts` runs in its own process (`src/indexer.ts`, bundled to `dist/indexer.js`, never loaded in the extension host). `IndexClient` forks it with the app's own Node on the first request; it sets itself to the lowest priority and stops after ten idle minutes. A crash restarts it with a growing delay, three times at most. `WorkspaceIndex` (`src/host/workspaceIndex.ts`) owns the client and the server, and on a restart opens again the folders this window keeps current.
- **Storage and isolation.** There is one SQLite file per folder (`node:sqlite`), `~/.geminicode/index/code/<sha256 of the real path>/index.db`, in WAL mode and written in short transactions (`indexStore.ts`). A lock file with its pid (`indexLock.ts`) lets one window write; others read and take over when it goes. A file SQLite can't open or reports damaged, or one from another schema, is moved aside and rebuilt; queries meanwhile answer from live search. An agent's worktree gets its own file, copied from its workspace's with `VACUUM INTO` and then reconciled, and removed with the worktree. Indexes no window used for 30 days are deleted.
- **What is indexed.** The files come from `git ls-files` (cached and untracked, not ignored) or a bounded walk (`inventory.ts`). Left out are `.geminiignore`, `gemini.index.exclude`, `secretPathReason`'s files, binaries, lock files, minified code and files over `gemini.index.maxFileSizeKb`. `gemini.index.include` forces files back in, except secrets and binary content (`SkipRules`), and a file stored as left out is read again once it is included.
- **Parsing.** `parse.ts` finds definitions with per-language line patterns (`languages.ts`), cuts chunks at top-level definitions (and at members of long classes), and keeps relative imports, resolved to files (`resolve.ts`). Chunk text is stored compressed. `cochange.ts` counts files changed together in the last 500 commits.
- **Keeping it current.** A reconcile compares size and mtime, then a content hash, so only changed files are parsed (`runReconcile`). Folders in the window each get a file watcher, batched a second after the last event, and a watch on HEAD and the branch refs (`indexWatchers.ts`). More than 300 changed paths at once reconcile instead. A worktree outside the window gets the agent's completed edits as they happen and a reconcile when each turn ends.
- **The tools.** `IndexMcpServer` (`src/acp/indexMcp.ts`) binds each agent's route and token to the folder it works in, and a spare session's slot to its folder, so no token reaches another folder's index.
  - `code_search` runs BM25 over the chunks, with names and paths weighted above body text and the chunk defining a queried name first (`query.ts`).
  - `find_symbol`, `related_files` and `repo_map` read the symbols, imports and co-change tables.
  - Results are capped at 8,000 characters (`format.ts`).
  - While a folder's first build runs, `code_search` and `find_symbol` answer from the app's ripgrep and say so.
  - The server's instructions carry the folder's outline (`repoMap.ts`), fetched when a session is prepared.
  - It is one of `ownServers`, so `--allowed-mcp-server-names` always includes it.
- **Docs.** `DocsSources` (`src/host/docsSources.ts`) keeps the sources, and the folders each is attached to, in `~/.geminicode/index/docs/sources.json`. It fetches in the extension host (`src/acp/docs/crawler.ts`): `llms-full.txt`, `llms.txt`, the sitemap, then links under the address, within robots.txt, a page limit and conditional requests. The indexer converts HTML to Markdown (`htmlToMarkdown.ts`), cuts it by heading and stores each source once (`docsLibrary.ts`). Due sources refresh in the background, and a lock beside the stores lets one window fetch a source at a time. A worktree's agent sees its workspace's docs.
- **Pages.**
  - The Index page (`src/host/indexPage.ts`, `webview-src/indexPage.ts`) opens as a tab in the active group from Home, the Agents pane's workspace menu or **Gemini: Manage Index**.
  - Home shows a drum icon beside the workspace pill (full, half or empty). Whether a folder has an index is read from the index file, so Home never starts the indexer.
  - The Files Left Out popup groups the left-out files by reason and adds files to `gemini.index.include`.
  - The status bar shows **Indexing N%** only while a build of 50 files or more runs (`indexStatusBar.ts`).
  - Suggested docs come from the folder's manifests and a list that ships with the extension (`src/acp/docs/suggest.ts`).
  - Enhance prompt gets the folder's outline and the files the index finds for the draft, when the index answers within 400 ms, and @-mentions outside the window list files from the index.
- **Getting the model to use it.** The chat sends `indexHint` with a session's first prompt once the folder's index is built (never shown in the chat). Search results rank tests below the code they test unless the query asks for tests, and say they are complete, so the model reads what they point to instead of checking with `grep_search`. Measurements are in [FINDINGS.md](FINDINGS.md#workspace-index).

### Context per model call

Project Helpers measures what every model call carries in the workspace (`src/acp/contextCost.ts`, `src/host/contextCostProbe.ts`). It sends one "reply OK" prompt on the lightest Flash model per variant, each in a CLI started as agents are (`getAgentCommand` with an explicit `--allowed-mcp-server-names`). The variants are:

- every server and GeminiCode's own (the total);
- none (the CLI and context files);
- an empty untrusted folder (the CLI alone);
- each server alone;
- GeminiCode's servers alone.

Each part is the difference between two variants. The probe runs only on request, the result is kept in global state per folder, and each server's share shows beside its switch, with advice for heavy parts. Memory files show a size estimate that includes the files they import with `@`.

## Gemini CLI management

### Which CLI runs

GeminiCode picks the CLI in this order:

1. The `gemini.cliPath` setting.
2. A copy installed from GeminiCode, from `<globalStorage>/gemini-cli/<version>/`. It uses `gemini.cli.version` if set, or else the newest installed copy.
3. The copy bundled with the app, in `extensions/gemini/cli/<version>/`, laid out the same way. Without a pinned version, a bundled copy newer than every installed one wins, so an app update is not held back by an older install. A pinned version that is neither installed nor bundled runs the bundled copy and offers to install the pinned one.
4. `gemini` on `PATH`.

A CLI older than `MIN_CLI_VERSION` (0.64.0) gets a warning.

### The bundled CLI

The bundled version and its npm SHA-512 are pinned in `extensions/gemini/package.json` (`bundledCli`). `npm run bundle-cli` in `extensions/gemini` downloads it with `npm pack`, refuses a mismatched checksum, and unpacks `bundle/`, `package.json` and `LICENSE` into `cli/`, which git ignores. The release build runs it before packaging. The CLI is plain JavaScript with no native modules, so it needs nothing extra for macOS signing. Raise the pin only to a version the real-CLI tests pass on.

### What GeminiCode changes in its own copies

GeminiCode's own copies (bundled and installed) get two changes. A CLI the user chose (`gemini.cliPath`, `PATH`) gets neither.

- **The output cap.** In ACP mode the CLI hands a tool's whole output to the model, skipping the 40,000-character cap it applies elsewhere, so one large `git diff` could push a session past the model's input limit. `src/acp/cliPatches.ts` puts the cap back on the ACP path in three places: when the bundled copy is built, on install, and at launch for older installs. `npm run bundle-cli` fails when the patch no longer matches a new CLI.
- **Ripgrep.** `cliRipgrep.ts` copies the app's ripgrep into `bundle/vendor/ripgrep/`, in the bundled copy when it is built and in installed copies at launch. Without it the CLI's `grep_search` falls back to `git grep`.

If a turn fails anyway with "input token count exceeds the maximum", the chat moves to a new session that carries the conversation without its tool outputs (`continueAfterOverflow` in `chatController.ts`), since retrying the same session would send the same history.

### Installing and updating

- **Install Latest Gemini CLI** downloads the release from the npm registry, checks its SHA-512 checksum, and unpacks only `bundle/` and `package.json`.
- **Install or Change Gemini CLI Version...** lists the last 30 releases, leaving out those older than `MIN_CLI_VERSION`, and pins the one picked in `gemini.cli.version` (unless policy locks it).
- Switching versions restarts the agent once no agent is working. GeminiCode keeps only the installed copy in use (and a pinned one), so copies older than what runs, the bundled CLI included, are deleted.
- Once a day, after the agent is ready, GeminiCode checks for a newer release and offers **Install**, **Skip This Version** or **Don't Check Again**. It never installs without a click, and skips the check when a version or path is pinned.

## GeminiCode updates

GeminiCode does not update itself. Upstream's updater needs a server that answers per build, and a static GitHub Pages site cannot, so `product.json` has no `updateUrl`.

Instead, a minute after start and then at most once a day across windows, `AppUpdateNotice` reads `latest.json` next to the download page (`geminiCodeDownloadUrl` in `product.json`). When it names a release newer than `geminiCodeVersion`, a notification says so, with **Download** (the page) and **Release Notes**. Only `https` links are opened. Dev builds, which have no `geminiCodeVersion`, never check, and admins can turn the check off with `GeminiCodeCheckForUpdates`.

Full auto-update would need a small update server. See [RELEASING.md](RELEASING.md) for how releases and the page are built.

## Security model

ACP does **not** sandbox the agent. The CLI routes only its `read_file`, `write_file` and `edit` tools through the client's file requests. Its shell, `grep`, `glob` and `ls` tools run inside the CLI process with the user's permissions. Real containment needs the CLI's own `--sandbox` (Docker or Podman). It is not the default, because it would require a container runtime on every machine.

What keeps the user in control:

1. **Approval modes.** In **Default** mode the CLI asks permission before every mutating tool. **Auto Edit** and **YOLO** skip some or all of those questions. Admins can remove either mode, and YOLO is off by default.
2. **Admin policy passed to the CLI.** GeminiCode writes a policy file and passes it with `--admin-policy`. A system policy directory on the machine overrides this file. `test/acp/realAgentPolicy.test.ts` checks all of the following against the bundled CLI.
   - When a mode is turned off, the CLI itself keeps asking in that mode.
   - When shell access is off, the CLI removes its shell tool.
   - The commands that print the environment (`env`, `printenv`, `declare -x`, `typeset -x`, `export -p`, `compgen -e`, `ps` with an environment flag, and `set`, `export`, `declare` or `typeset` alone) are refused, even inside a longer command, unless `gemini.tools.denyEnvironmentCommands` is off.
   - The confirm class (merge, open a merge request, move a ticket, log time, and the same actions in a team's `jira` and `gitlab` servers) asks in every mode, YOLO included. Its rules name each tool as the model calls it (`mcp_<server>_<tool>`), because the CLI gives the policy check no server name for servers a session brings. In YOLO the chat answers other requests itself, never those.
   - With `gemini.mcp.allowedServers` set, GeminiCode also passes `--allowed-mcp-server-names` with that list and its own four servers (`ownServers`), which outranks `mcp.allowed` in any settings file. Without it, when the settings files' `mcp.allowed` leaves out any of GeminiCode's servers, GeminiCode passes the flag with that allowlist plus its servers, less anything in `mcp.excluded` (`allowlistWith` in `projectToolsCheck.ts`), so users never add them by hand.
3. **Folder trust.** The CLI refuses Auto Edit and YOLO in a folder it does not trust. GeminiCode asks the user before adding the folder to the CLI's trusted list. A project needs its agents' folders trusted too, since the CLI loads no MCP servers in an untrusted folder. GeminiCode asks before trusting them, and never when `security.folderTrust.enabled` is off.
4. **No silent changes.** The IDE never changes the approval mode on the user's behalf.
5. **File requests stay in the folder.** The CLI's file tools go through the IDE, which refuses paths outside the agent's folder, secret files and git-ignored reads, following symbolic links to their real target. Session approvals of shell commands cover a command prefix, never a program that runs another program or code it is given ([Permissions](#permissions)). An Auto Edit write to a setting that decides what runs next asks first. Reads through the CLI's own shell, `grep`, `glob` and `ls` are not covered.
6. **Team tools ask for every write.** Write tools always reach a permission card with the exact text, and the confirm class offers only Allow once and Reject, in every mode. Every write, by an agent or a page, is in the audit log with its intent, its result and who answered.
7. **Other people's text is marked as data.** Tool results that carry text from Jira, GitLab, Figma or a page are wrapped in `<external source="…" ref="…">`, with any `<external>` tag inside the text escaped so it can't close the frame early (`external` in `teamTools.ts`). The servers' instructions tell the model to read it as data, never as instructions.
8. **Tokens stay out of the agent's reach.** Team tool tokens are in the keychain (SecretStorage), never in settings or the agent's environment. Taking over a repository's own Jira and GitLab servers moves their tokens out of the shell environment, and the environment commands are refused (2, above). The team's containers get their tokens on their input, read by a shell that then runs the image's own entrypoint (`containerSpec`), so neither `docker inspect` (which shows `-e` and `--env-file` values alike) nor the Docker client's environment holds them, and `docker` always asks.
10. **Pages are not trusted to name what runs.** Home runs only the commands it sent the page, with the same arguments; a chat runs only a shell block that is in its messages; Open Trace opens only GeminiCode's own trace files; a dropped file that may hold secrets is not attached; rendered Markdown links only to http, https and mailto (`hostAllowlists.ts`, `linkPolicy.ts`).
11. **Project tools by server, not by name.** A project's tools, and the team tools that only read, are answered for the user only when the call's id names GeminiCode's server (`mcp_<server>_<tool>…`, `mcpToolOf`), so another server's `report` or `post` never is. Snyk's tests run the project's build tools, so they show a card and are refused while shell commands are off.
9. **Sites ask first.** In the browser, an agent opens other origins only after asking, per agent and site, and `gemini.browser.allowedOrigins` can pin them. The CLI's `web_fetch` refuses private hosts.

### Policies

Each setting below can be locked through VS Code's policy system (Group Policy, macOS profiles, or Linux JSON policy). The policy names are defined in `product.json` under `extensionConfigurationPolicy`.

| Setting | Policy | Default |
| --- | --- | --- |
| `gemini.cliPath` | `GeminiCliPath` | empty |
| `gemini.cli.version` | `GeminiCliVersion` | empty (newest copy) |
| `gemini.cli.checkForUpdates` | `GeminiCliCheckForUpdates` | on |
| `gemini.app.checkForUpdates` | `GeminiCodeCheckForUpdates` | on |
| `gemini.approval.allowAutoEdit` | `GeminiAllowAutoEdit` | on |
| `gemini.approval.allowYolo` | `GeminiAllowYolo` | off |
| `gemini.tools.allowShell` | `GeminiAllowShell` | on |
| `gemini.inlineEdit.enabled` | `GeminiInlineEdit` | on |
| `gemini.usageMeter.enabled` | `GeminiUsageMeter` | on |
| `gemini.browser.enabled` | `GeminiBrowser` | on |
| `gemini.browser.allowOtherSites` | `GeminiBrowserOtherSites` | on |
| `gemini.browser.allowedOrigins` | `GeminiBrowserAllowedOrigins` | empty (every site) |
| `gemini.tools.denyEnvironmentCommands` | `GeminiDenyEnvironmentCommands` | on |
| `gemini.mcp.allowedServers` | `GeminiAllowedMcpServers` | empty (the CLI's `mcp.allowed`, plus GeminiCode's own servers) |
| `gemini.index.enabled` | `GeminiIndex` | on |
| `gemini.docs.enabled` | `GeminiDocs` | on |
| `gemini.docs.allowedDomains` | `GeminiDocsAllowedDomains` | empty (every site) |
| `gemini.chat.runCommands` | `GeminiChatRunCommands` | `askWhenRisky` (`alwaysAsk`, or `off` to remove Run) |
| `gemini.projectId` | `GeminiProjectId` | empty (workspace, user, org default, environment) |
| `gemini.projects.enabled` | `GeminiProjects` | on |
| `gemini.team.runTeamServers` | `GeminiRunTeamServers` | off |
| `gemini.agents.worktreeSetup` | `GeminiWorktreeSetup` | empty (the repository's `.gemini/worktree-setup.sh`) |
| `gemini.agents.allWorkspaceFolders` | `GeminiAllWorkspaceFolders` | off |
| `gemini.browser.keepSignIns` | `GeminiBrowserKeepSignIns` | off |
| `gemini.pilot.record` | `GeminiPilotRecord` | off |

`gemini.agents.worktreeSetup` is machine-scoped, so a repository's own settings can't set the command. `gemini.projectId` stays window-scoped, since a workspace's own billing project is documented and in use; starting an agent logs a warning when a workspace's value replaces the user's or the organisation's, and a `GeminiProjectId` policy wins over both (`getProjectSettings` reads it through `get`, as `inspect` leaves policies out).

`gemini/pilot/GeminiCode-pilot.mobileconfig` sets the pilot's values as a macOS configuration profile for the app's preferences domain. An array setting's policy is a JSON string.

To pin a CLI version for everyone, lock `GeminiCliPath` to an empty string and `GeminiCliVersion` to the version.

An organisation's default Google Cloud project ID can ship in `product.json` as `geminiDefaultProjectId`. No build sets it: the release workflow stamps only `geminiCodeVersion`, so an organisation that wants a default adds it to its own build.

## Restarts

GeminiCode runs only on the Mac, with no server ([ADR 0009](adr/0009-desktop-only.md)). When it quits or the Mac restarts, the agent process, the local MCP servers and the team servers' children end, and nothing runs until a window opens again. Two rules follow:

- every flow that spans a model turn or a remote write can be picked up from a record on disk;
- a restart never answers a question the user did not answer.

| State | Kept in | After a restart |
| --- | --- | --- |
| Agents, workspaces, projects and threads | global state | the same list and cards |
| Each conversation | one JSON file per agent in global storage, and the CLI's own chat file | shown at once; the session reopens with `session/load` |
| Undo and Rewind checkpoints | `<globalStorage>/checkpoints/<agent>.json`, written when a turn ends | up to the last finished turn |
| A turn that was running | the agent process | lost; the chat shows that it was cut off, with Retry the Turn and Keep and Continue |
| Permission cards and "Allow for this session" approvals | memory | gone: the next request asks again |
| An open team flow (Open Merge Request, Move Ticket, Review) | a record in `<globalStorage>/flows/`, with what the user typed and ticked | Home's Unfinished card offers Reopen from the same inputs, or Discard |
| A merge request review's draft | `<globalStorage>/reviews/`, written as it changes | Home's Continue Review, the reviewer's chat and Open Merge Request Review reopen it where it was left |
| A write that was in flight | its intent in the audit log, with no result | Home's Unfinished card lists it, with Open Audit Log and Mark as Checked; nothing is redone on its own |
| Home's team data | a snapshot in global state | shown at once, dimmed until it refreshes |
| Sign-in, team tokens, worktrees, folder trust | the CLI's files, the keychain, `~/.geminicode/`, `~/.gemini/trustedFolders.json` | as they were |
| The spare session and the team servers' children | memory and child processes | opened or started again when first needed |

## Direct requests

Inline edit, commit messages and Enhance prompt don't need a whole agent turn. They skip the agent and send one request to a fast model from `src/acp/directRequest.ts`. The model is `gemini.inlineEdit.model`; by default it is the newest Flash model the installed CLI names, falling back to the previous one for accounts that can't use it yet.

Direct requests use the sign-in the CLI saved, read only, and never change the CLI or its files:

- **Google sign-in** (`oauth-personal`): the access token in `~/.gemini/oauth_creds.json` calls the Gemini Code Assist service (`cloudcode-pa.googleapis.com`, the same service and license the CLI uses), billed to `gemini.projectId` or, without one, the project Code Assist reports for the user. An expired token is refreshed in memory with the CLI's own OAuth client, read from the installed CLI's bundle.
- **API key** (`gemini-api-key`): `GEMINI_API_KEY` calls the Gemini API.
- Vertex AI, and sign-ins kept in the system keychain, are not supported; the command says so.

Direct requests carry the CLI's User-Agent, `user_prompt_id` and `session_id`, as the CLI's own requests do. On a real account they answer in 2.8 s at the median, against 4.8 s through the CLI ([FINDINGS.md](FINDINGS.md#prompt-enhancement-direct-requests-or-the-cli)). `GeminiInlineEdit` turns inline edit and Enhance prompt off.

### Inline edit and commit messages

Inline edit streams the answer (`:streamGenerateContent?alt=sse`). It shows the rewrite's whole lines in the file above the lines it replaces, marked as added (`inlineEditPreview.ts`), then swaps in the clean rewrite as one undo step. A request carries only the selection with up to 80 lines around it, or, for a commit message, the diff (cut at 40,000 characters) and the last few commit subjects.

### Enhance prompt

Enhance prompt (`promptEnhancer.ts`, `webview-src/enhance.ts`) is a direct request too (`QuickEdits.enhancePrompt`), on the inline edit model and under the same setting and policy. It streams the rewrite into the read-only composer as it arrives. The draft goes with the names of its attachments, the chat's last six messages, the folder, branch, open file and mode, never file contents. The reply is cleaned (`cleanEnhancedPrompt`) and replaces the draft as an edit, so Undo brings it back.

When direct requests are off, cannot use the sign-in, or fail (for five minutes after a failure), the CLI makes the rewrite:

- each rewrite runs in a fresh session on the shared agent process, in an empty folder (`<globalStorage>/enhance`), so earlier rewrites never leak into it, the CLI adds no folder context, and the sessions stay out of the project's chat history;
- the session is put in Plan mode and on the first Flash-Lite (else Flash) model the agent offers;
- only text sent during its prompt counts as the reply (gemini-cli sends a mode change as message text);
- while direct requests fail, the next session is opened ahead of the click;
- these sessions are not turns, so they never hold back a restart.

### Usage meter

The usage meter (`usageMeter.ts`) makes the same `retrieveUserQuota` request the CLI makes, with the same project, at most every 10 minutes and only while the window is in front. The Gemini status bar item's tooltip lists each model's share of today's quota and when it resets, and the item shows the percentage once a model passes 80%. API key sign-ins have no quota to read, so it shows nothing. `GeminiUsageMeter` turns it off.

### Review My Changes and Build This Plan

**Review My Changes** (`reviewPrompt.ts`, `AgentsView.reviewChanges`) starts an ordinary agent whose session opens in Plan mode (`setModeOnNextSession('plan')`), so the CLI itself refuses edits. The `git diff HEAD` (cut at 100,000 characters) goes as an `uncommitted.diff` document attachment, which keeps the chat bubble short and reaches the model as an embedded resource.

**Build This Plan** appears on the latest turn end when the session's mode is `plan` and the agent offers `default`. It sets the mode with `session/set_mode` and sends a short prompt.

### Project Helpers

The Project Helpers page (`settingsPage.ts`, `projectSettings.ts`, `skills.ts`, `hooks.ts`, `cliCommands.ts`, `memory.ts`) edits the CLI's own files rather than keeping settings of its own:

- `mcpServers` in the personal and workspace `settings.json`, read as JSON with comments, and only rewritten when they have none;
- `mcp-server-enablement.json`, keyed by the lowercased server name as gemini-cli's `McpServerEnablementManager` writes it;
- the `context.fileName` rules files.

Startup failures come from the same debug-log reader as the warnings. The page reads the files only when it is shown or changed, and never starts the CLI by itself: it asks the CLI only when the agent process is already running (on open, when the process becomes ready, after a change) or when the user presses **Refresh**.

**Skills** are read as the CLI reads them: `SKILL.md` and `*/SKILL.md` under the user's and project's `.gemini/skills` and `.agents/skills`, with name and description from the front matter. They are cached per folder until a `SKILL.md` changes (the watcher covers `SKILL.md` and `*/SKILL.md`, as the loader reads both); the skill cache also watches both settings files. A project's skills are offered, in the `/` menu and on the page, only in a trusted workspace (`vscode.workspace.isTrusted`), since the CLI loads them only in trusted folders. Picking one from the `/` menu sends a prompt asking the agent to load it with its `activate_skill` tool. A skill's switch edits `skills.disabled` in the settings file of its scope (merged like `hooksConfig.disabled`, case-insensitive), and the `/` menu leaves out skills it lists.

**Hooks** are the `hooks` entries of the settings files. A hook's switch edits `hooksConfig.disabled` in the file that defines it. Because the CLI merges the disabled lists, switching on a project hook also removes it from the personal list.

**Extensions and memory** come from the CLI itself. `/extensions list` (JSON) and `/memory list` run one after the other in one hidden session on the shared agent process (`runCliCommands`), which the CLI answers without the model; enable and disable go the same way.

- A command is sent only when the session's `available_commands_update` lists it; otherwise it would reach the model as a prompt.
- A command that does not answer in time is cancelled.
- The session is closed afterwards when the CLI advertises `sessionCapabilities.close`.
- Install, update and uninstall run `gemini extensions …` in a terminal instead, because the installer asks for consent on standard input, which over ACP is the protocol stream.
- Settings an extension resolved, which can hold keys, are never read.

**Sign In** on a remote MCP server runs `gemini -i "/mcp auth <name>"` in a terminal, since neither ACP nor the `gemini mcp` subcommands can run the OAuth flow. The CLI stores the tokens where every agent reads them.

**Gemini CLI settings** (`src/acp/cliPreferences.ts`) read and write four keys of the user's `settings.json` through `updateSettingsFile`, which leaves a file with comments alone.

### Team commands

Team commands with `@{path}` or `!{command}` are expanded by `src/acp/teamCommandExpansion.ts` in one pass over the template. File text and command output are never searched again, unlike the CLI, which runs its shell step over injected file text too.

`src/host/teamCommandHost.ts` reads a file only through `checkFileAccess` (workspace folders and the agent's folder, no secrets, nothing git ignores) and refuses folders and files over 256 KB. It runs commands only when `gemini.tools.allowShell` is on and the user confirms the full list in a modal. They run with `shell: true` in the agent's folder, stop after 60 s, and keep 100,000 characters of output.

### Report an Issue

The status bar menu's **Report an Issue...** opens `reportIssueUrl` from `product.json` with the GeminiCode, VS Code, CLI and OS versions in the body (`src/acp/helpLinks.ts`), never an account, project or path.

## Sign-in and errors

- **Sign-in is delegated.** The CLI owns OAuth. GeminiCode calls `authenticate("oauth-personal")` only when `session/new` reports that sign-in is required, because the call rewrites `security.auth.selectedType` in the user's `~/.gemini/settings.json`.
- **Terminal fallback.** Some steps cannot finish over ACP: account validation, and a sign-in on a machine with no browser. For these, **Complete Setup in Terminal** runs the interactive `gemini` with the same environment, and GeminiCode restarts the agent when the terminal closes.
- **Errors are strings.** The CLI turns every setup failure into JSON-RPC error `-32000` with a message string. Other failures arrive as a generic internal error with the CLI's message in `data.details`. `classifyAgentError()` matches those strings against a small table of known patterns (sign-in required or failed, project ID missing or numeric, untrusted folder), each with a test fixture. An unknown message is shown as it is.
- **Project ID.** GeminiCode resolves the Google Cloud project from the workspace setting, then the user setting, then the organisation default, then the `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT_ID` environment variables. It refuses to start the CLI with a project number, and only logs a warning for an ID that looks malformed.

## Upstream's own AI

The window defaults set `chat.disableAIFeatures`. That hides upstream's chat view, Copilot status item and inline chat. One `GEMINI-FORK` filter also keeps upstream's Chat commands out of the Command Palette. `product.json` keeps upstream's `defaultChatAgent`, because removing it would touch about 45 upstream files.

## Design rules

1. Discover model and mode IDs from the agent; never hardcode them.
2. Entitlement comes from the server, never from the client.
3. The CLI is a swappable runtime: any supported version, from any of the four sources.
4. Feature-detect and degrade. Hide a control the agent does not support, and render unknown update kinds generically.
5. Keep the wire-to-UI adapter thin (`sessionUpdates.ts`).
6. `extensions/gemini/src/acp` never imports `vscode`. ESLint enforces this.
7. Edit upstream files only at registration points, and mark each edit `GEMINI-FORK`.
8. Never modify the Gemini CLI's source. The one change to GeminiCode's own copies is the output cap in `cliPatches.ts` (plus the app's ripgrep, added beside it); a CLI the user picks is never changed. Speed comes from GeminiCode's own code: process reuse, prewarming, batching and caching.

## Testing

- **Unit tests** (Vitest, `extensions/gemini/test/acp`) cover the ACP client against a scripted fake agent (`test/fake-agent`), which replays streaming, permission requests, file requests, error strings and unknown update kinds. They also cover the code around it that has no `vscode` dependency:
  - CLI resolution, install and update checks, and the app update check;
  - the admin policy, file access, session approvals, project IDs and folder trust;
  - attachments, the agents model, changes, checkpoints, transcript storage, the prompt queue and reactions;
  - the local MCP servers, the team connectors, their writes and audit records, the team's servers as children (against a scripted MCP server, `test/fake-mcp`) and the take-over;
  - the benchmark and the pilot's counters;
  - Projects: the hub's wake and thread rules (with several repositories too), its MCP server, how rules are linked into a coordinator's folder and a thread's worktree, project settings and memory storage, memory drafts, and multi-repository thread folders.
- **Real CLI tests** (`test/acp/real*.test.ts`) run when `GEMINI_CLI_PATH` points at a CLI, against a fake Gemini API on localhost. They cover the `initialize` handshake and the sign-in-required path, the admin policy (modes, shell, the environment commands and the confirm class), the model list's shape, reopening sessions by id and from the terminal with the replay count, Rewind, and an MCP server that cannot start. CI runs them against the `latest` and `preview` CLI.
- **Performance budgets** (`test/perf/budgets.test.ts`) time the work on the paths a user waits on (a keystroke, a streamed chunk, switching agents, Enter to the first chunk, a 500-thread project) and the bundle sizes, and fail CI when one grows past its budget. The scripts in `scripts/` measure what CI cannot ([FINDINGS.md](FINDINGS.md)):
  - `perf-real.mts`: an agent's start, sessions and first reply on a real account;
  - `perf-first-reply.mts`: the same against a stand-in API;
  - `probe-enhance.mts`: Enhance prompt's routes;
  - `coordinator-spike.mts`: a project's coordinator.
- **Site checks** (`gemini/site/check-a11y.mts`, `check-lighthouse.mts`) run axe-core on every built page and Lighthouse on the landing and docs pages, in Gemini CI on the sample build and in the Pages workflow before a deploy.
- **Theme tests** (`test/themes`) check that every text colour pair in GeminiCode Dark and Light reads at 4.5:1, and that nothing blurs.
- **Webview tests** (`test/webview`) cover the streaming Markdown splitter and the chat's view logic (file names in replies, mentions, attachments, permission defaults, durations, scrolling, the composer height, folded turns), emoji search, the settings popup's state, and that no bare `<select>` opens a system menu.
- The `src/host` code that needs VS Code is checked by running the dev build.
