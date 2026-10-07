# Architecture

GeminiCode is a hard fork of VS Code that ships the Gemini CLI as its built-in coding agent. This page explains how the pieces fit and why. Measurements and protocol behaviour that the design relies on are in [FINDINGS.md](FINDINGS.md). Work that is still open is in [ROADMAP.md](ROADMAP.md).

## Decisions

- **Fork VS Code, don't extend it.** The product is a standalone, branded application, like Cursor. A fork owns the shell, branding, first-run experience and admin policy.
- **Don't reimplement the agent.** GeminiCode runs the official `gemini --acp` as a child process ("sidecar") and implements only the client side of the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Sign-in, licensing and model calls stay in the CLI. The Gemini API SDK was ruled out because it cannot use a Gemini Code Assist license.
- **Build it as a built-in extension.** Almost all fork code lives in `extensions/gemini/`. It ships inside the app, adds very little to upstream merges, and builds without recompiling the workbench. Code moves into the workbench only for things the extension API cannot do.

## Where the code lives

```
extensions/gemini/
  src/acp/          ACP client. Never imports `vscode`, so it can move into the workbench later.
                    Sidecar spawn and supervision, the shared agent runtime, sessions, permissions,
                    file access policy, error classification, CLI install and resolution,
                    transcript model and storage.
  src/host/         VS Code side: chat view and agent tabs, Agents pane, Changes view, status bar,
                    settings, commands, git actions, update notices, Get Started walkthrough.
  webview-src/      The chat webview (bundled to media/chat.js).
  media/            Webview stylesheet and icons.
  themes/           The GeminiCode Dark and Light colour themes.
  walkthrough/      Get Started step pages.
  scripts/          bundle-cli.mts, which fetches the pinned CLI into cli/ for release builds.
  test/             Vitest unit tests, a scripted fake ACP agent, and real-CLI tests.
gemini/             Fork material that is not shipped: docs, icon sources, the download page
                    generator (site/), maintainer scripts.
.github/workflows/gemini-ci.yml, gemini-release.yml, gemini-pages.yml
```

Upstream files are touched only where a fork must register itself or rebrand. Each such edit carries a `GEMINI-FORK` comment, and `gemini/scripts/list-fork-touches.sh` lists them (see [../README.md](../README.md)). Today these are:

- `product.json` (names, icons, links, Open VSX gallery, the download page URL, onboarding themes, Gemini setting policies);
- the top-level `README.md`, `SECURITY.md` and `AGENTS.md`, which point at the fork's docs;
- the build lists that register the extension (`build/npm/dirs.ts`, `build/gulpfile.extensions.ts`, `build/lib/extensions.ts`, `build/filters.ts`, `build/hygiene.ts`, `.eslint-ignore`, `eslint.config.js`);
- branding: packaging metadata (`build/lib/electron.ts`, `build/win32/code.iss`, and the Linux, Windows and server files and icons under `resources/`; the Debian scripts never add Microsoft's apt repository), a rebuild of the dev app when its name or icons change (`build/lib/preLaunch.ts`), the `.dmg` volume name (`build/darwin/create-dmg.ts`), packaging without upstream's Copilot extension (`build/gulpfile.vscode.ts`), GeminiCode's version in the About dialog (`platform/dialogs/electron-browser/dialog.ts`), and the workbench icons (`code-icon.svg`, `letterpress-*.svg`);
- system notifications and the Dock badge: `contrib/gemini/electron-browser/gemini.contribution.ts`, a fork-only file imported from `workbench.desktop.main.ts`, registers the internal commands `_gemini.showToast`, `_gemini.hideToast` and `_gemini.setApplicationBadge`, which the extension API has no equivalent for. The same file loads the bundled code fonts (JetBrains Mono and Geist Mono, TTF files in `contrib/gemini/electron-browser/media/` declared in `geminiFonts.css`), because extensions cannot add fonts to the editor. Its sibling `geminiModes.ts` holds the window modes (below), and the i18n list in `build/lib/i18n.resources.json` names the folder;
- the native frame: Gemini first in the activity bar (its order in `api/browser/viewsExtensionPoint.ts`, plus a one-time move for profiles that cached it lower in `browser/parts/paneCompositeBar.ts`), **New Agent** in the macOS Dock menu (`platform/menubar/electron-main/menubar.ts`, run in the window last used), and a description on agent tabs for their line counts (`WebviewInput` in `webviewPanel/browser/webviewEditorInput.ts`, set through `_gemini.setAgentTabs`, matched by tab title). Agent tab icons show the agent's state as SVGs in `media/tabs/`, because tab labels draw a ThemeIcon without its colour or spin;
- slimming upstream down: with `chat.disableAIFeatures` on (GeminiCode's default), Copilot setup does not start (`chatSetupContributions.ts`), so there are no entitlement requests to GitHub at startup; `product.json` carries no Copilot auto-update, auth trust or voice endpoint; the `tunnel-forwarding` extension, which needs the `code` CLI GeminiCode does not ship, is left out of the build (`build/lib/extensions.ts`). Telemetry is already off, because `product.json` has no `enableTelemetry`. The layout also tolerates the activity bar being hidden before its grid exists (`browser/layout.ts`), which Agents mode does at startup;
- four workbench edits: Chat commands hidden from the Command Palette while upstream AI is off (`commandsQuickAccess.ts`), the Gemini extension cannot be disabled (`extensionEnablementService.ts`, with its test), the product name in the welcome walkthrough (`gettingStartedContent.ts`), and the default colour themes (`ThemeSettingDefaults` in `services/themes/common/workbenchThemeService.ts`, with a fallback to upstream's Dark/Light 2026 in `services/themes/browser/workbenchThemeService.ts` if the GeminiCode themes are ever missing). `product.json` lists the GeminiCode themes in `onboardingThemes` too.

## How a prompt flows

```
Chat webview ──postMessage──▶ ChatController ──▶ AgentClient ──▶ AgentRuntime ──stdio JSON-RPC──▶ gemini --acp
     ▲                              │                                  │
     └──── batched item updates ◀───┴── ChatTranscript ◀── session/update notifications
```

1. **The agent process.** `AgentSidecar` spawns the CLI with the application's own Node (`ELECTRON_RUN_AS_NODE=1`), so users need no Node install. The process inherits the editor's environment, including proxy and CA variables, with `GOOGLE_CLOUD_PROJECT` set to the resolved project (and `GOOGLE_CLOUD_PROJECT_ID` cleared), `GEMINI_CLI_NO_RELAUNCH=true` and an explicit heap size ([FINDINGS.md](FINDINGS.md#agent-startup-time)), plus `--admin-policy`. It restarts a crashed process with backoff (1 s, 4 s, 15 s; the count resets once a process stays up for a minute), but never after a fatal exit such as a failed sign-in (exit code 41). Exit code 199, the CLI asking to be relaunched, restarts it at once. The process starts when a chat first opens, not at activation, and changing a setting that affects it (CLI path or version, project, approval or shell settings) restarts it.
2. **One process, many agents.** `AgentRuntime` runs `initialize` once and serves every chat from that process; each chat is its own ACP session with its own `cwd`. A new agent starts in about 30 ms instead of about 1.2 s.
3. **Sessions.** `AgentClient` opens a session (`session/new`, or `session/load` to resume), signs in when the CLI asks, sends prompts, and exposes the modes and models the agent reports, minus any mode the admin policy turns off. Nothing in the UI hardcodes a mode or model ID. The model the user picked last (kept in global state) is applied to each new or reopened session when the agent offers it, which also spares the CLI its Auto routing call ([FINDINGS.md](FINDINGS.md#where-a-prompts-time-goes)).
4. **Rendering.** `sessionUpdates.ts` turns `session/update` notifications into a few UI events, and `ChatTranscript` folds them into plain, serialisable items. The controller streams item changes to the webview about 30 times a second, sending only appended text for streaming messages. The webview renders agent Markdown with raw HTML disabled, then adds GitHub-style callouts (`> [!NOTE]`), scrolling tables and links on file names in `code` (`markdownExtras.ts`; the extension finds the file from the agent's folder, else by name).
5. **Code blocks.** Finished code blocks are highlighted by highlight.js (about 30 languages, `webview-src/highlight.ts`), a bundle of its own that loads with the first code block and runs when the view is idle; results are cached, so a re-render is coloured at once. A block still streaming stays plain. The colours are the colour theme's own: `themeTokens.ts` reads the active theme's file (and those it includes) and matches its TextMate rules to about 20 categories (`tokenColors.ts`), so code in chat looks as it does in the editor. Themes that can't be read fall back to Dark Modern and Light Modern colours.
6. **Permissions.** `PermissionBroker` holds each `session/request_permission` until the user picks one of the options the agent sent. A request that proposes an edit opens a real diff editor. Stopping a turn answers any open request as cancelled.
7. **Files.** The agent's `fs/read_text_file` and `fs/write_text_file` requests go through the editor. Reads see unsaved changes. Writes are applied as a `WorkspaceEdit`, so they can be undone, and then saved, because the CLI's own shell and search tools read the disk. Requests are limited to the agent's folder, skip git-ignored files for reads, and refuse secret files such as `.env`, private keys and credential files.

## The agent workspace

- **Agents and Editor modes.** `contrib/gemini/electron-browser/geminiModes.ts` (fork-only) switches the window between two layouts from a switch in the title bar or Cmd+Alt+M. Agents mode hides the activity bar (by setting `workbench.activityBar.location` to `hidden` in memory only, so the user's own setting returns in Editor mode), shows the Gemini side bar on the left and the extension's **Changes** panel in the secondary side bar; Editor mode is the classic layout. Agents mode's views are fixed: when the user opens any other view container in the side bar (a command, a shortcut or an extension revealing it), the window switches to Editor mode with that container open and says so once. Each mode stores which parts were open, per workspace (Editor mode also which side bar and secondary side bar), and switching only shows and hides parts. The mode is the context key `gemini.mode`, which the extension's views use in their `when` clauses, and the workbench tells the extension about changes through `_gemini.modeChanged` (`_gemini.getMode` answers at start). The same file draws a pill in the title bar for each agent that is working, waiting or done and unread, from what the extension sends with `_gemini.setAgentStatus`; clicking one opens that agent. A new workspace opens in Agents mode.
- **Agent Home** (`agentHome.ts`, `webview-src/home.ts`). In Agents mode it opens whenever the editor area is empty (except right after closing Agent Home itself), and from the Agents pane's home button. Its composer starts an agent in a chosen workspace and sends the prompt in one step, optionally on its own branch named after the prompt; cards show the agents that are working, waiting, done or have changes, with Stop, Review, Merge Back and Open; earlier agents can be resumed. The page loads only when first shown.
- **Changes panel** (`changesPanel.ts`, `webview-src/changes.ts`). Agents mode's live diff of what the agent in front changed: each change as a unified diff with Keep and Undo, which run the same commands as the editor's CodeLenses, plus Keep All, Undo All and Commit (or Merge Back for an agent on its own branch). Diffs are worked out with `lineDiff.ts` against the open document's text, 150 ms after the last edit, and only while the panel is visible. In Editor mode the Changes view below the Agents pane is shown instead.

- **Agents pane.** A tree of workspaces (the open folder plus any you add) with agents under each. Each row shows the agent's status (working, waiting for permission, done but unread, needs attention, idle, or not started in this window), its `+N −M` change count, how long ago it was active, and its git branch, read from `.git/HEAD`. An agent takes its name from its first prompt unless the user renames it. Removing an agent deletes its saved conversation; removing a workspace only drops it from the list.
- **Agent tabs.** Each agent opens as an editor tab that reuses the chat webview, and is the main editor. Files, proposed edits and diffs that the agent's chat or its Changes open go in the editor group after the agent's tab (the one to its right, added once if there is none), so the chat stays in view and the same group is reused (`editorPlacement.ts`). The sidebar's **Quick Chat** is a separate session for the open folder and opens files in the active group, as before.
- **Changes view.** This view sits below the Agents pane in the Gemini side bar and lists the files the agent in front has edited, recorded from its completed edit tool calls. Each file opens a diff against its text from before the agent's first edit, **Open All Changes** shows them in the multi-diff editor, and **Clear List** forgets them.
- **Git.** Each chat's composer shows the folder's branch as a pill that switches or creates a branch, through the built-in Git extension, which is only activated when the user picks an action (`gitActions.ts`). An agent's chat also offers **Create Branch & Commit**, which stages and commits only that agent's changed files to a new branch (suggested as `gemini/<agent name>`, with the agent's name as the message), warns first when other files are already staged, and then clears the agent's Changes list.
- **Worktrees.** An agent can work on its own branch in a Git worktree (`src/acp/worktrees.ts`, plain `git` commands). The worktrees live in `~/.geminicode/worktrees/<repository>/<branch>` instead of inside the repository, so the open workspace's search, file watchers and language servers don't see every file twice. The agent's session gets the worktree (or the workspace's matching subfolder in it) as its `cwd`; the agent record keeps the folder, branch and base. **Merge Back** commits leftovers with the agent's name and runs `git merge --no-ff` in the workspace's repository, leaving conflicts for Source Control. Creating one costs a checkout of the repository's files, shown as progress, and nothing on later prompts.
- **First open.** The first time a workspace opens, `layoutDefaults.ts` reveals the Gemini side bar (the workbench would otherwise open on the Explorer). After that the workbench restores whatever the user arranged.
- **Persistence.** The list of workspaces and agents is kept in global state, and each agent's visible conversation (the last 300 items, long text cut to 20,000 characters) and changed files are saved as one JSON file per agent in the extension's global storage. On reopen, or after the process restarts, GeminiCode resumes the session with `session/load` when the CLI supports it. Otherwise it starts a fresh session and says so in the chat.

GeminiCode builds this pane on public extension APIs rather than upstream's Agents window (`src/vs/sessions`). That window only takes agents registered in core code, and it is the fastest-moving part of upstream. The domain names (workspace, agent session) follow upstream's, so the views can move onto it if it gains an extension API.

### Look

The extension contributes the **GeminiCode Dark** and **GeminiCode Light** colour themes (`extensions/gemini/themes/`), which are complete themes with their own token colours, so they need no other theme. The `ThemeSettingDefaults` edit above makes them the defaults directly; a `configurationDefaults` entry would let upstream's default theme show first. High contrast defaults stay upstream's. The extension's `configurationDefaults` also set the view icons at the top of the side bar, the secondary side bar hidden by default, pill editor tabs, no startup editor or empty-editor hint, no breadcrumbs or minimap, and a slightly roomier editor; users can change each one. The layout uses only native views and editor groups, so every part stays resizable. The chat webview's `media/chat.css` uses theme variables (plus the Gemini gradient on Send), so it follows any theme; high contrast themes keep their own colours and borders.

## Gemini CLI management

GeminiCode picks the CLI to run in this order:

1. The `gemini.cliPath` setting.
2. A copy installed from GeminiCode, from `<globalStorage>/gemini-cli/<version>/`. It uses `gemini.cli.version` if set, or else the newest installed copy.
3. The copy bundled with the app, in `extensions/gemini/cli/<version>/`, laid out the same way. Without a pinned version, a bundled copy newer than every installed one wins, so an app update is not held back by an older install. A pinned version that is neither installed nor bundled runs the bundled copy and offers to install the pinned one.
4. `gemini` on `PATH`.

The bundled version and its npm SHA-512 are pinned in `extensions/gemini/package.json` (`bundledCli`). `npm run bundle-cli` in `extensions/gemini` downloads it with `npm pack`, refuses a mismatched checksum, and unpacks `bundle/`, `package.json` and `LICENSE` into `cli/`, which git ignores. The release build runs it before packaging. The CLI is plain JavaScript with no native modules, so it needs nothing extra for macOS signing. Raise the pin only to a version the real-CLI tests pass on.

**Install Latest Gemini CLI** downloads the release from the npm registry, checks its SHA-512 checksum, and unpacks only `bundle/` and `package.json`. **Install or Change Gemini CLI Version...** lists the last 30 releases and pins the one picked in `gemini.cli.version` (unless policy locks it). Switching versions restarts the agent once no agent is working, and GeminiCode keeps the copy in use and one other. Once a day, after the agent is ready, it checks for a newer release and offers **Install**, **Skip This Version** or **Don't Check Again**; it never installs without a click, and skips the check when a version or path is pinned. A CLI older than `MIN_CLI_VERSION` (0.61.0) gets a warning.

## GeminiCode updates

GeminiCode does not update itself. Upstream's updater needs a server that answers per build, and a static GitHub Pages site cannot, so `product.json` has no `updateUrl`. Instead, a minute after start and then at most once a day across windows, `AppUpdateNotice` reads `latest.json` next to the download page (`geminiCodeDownloadUrl` in `product.json`). When it names a release newer than `geminiCodeVersion`, a notification says so, with **Download** (the page) and **Release Notes**. Only `https` links are opened. Dev builds, which have no `geminiCodeVersion`, never check, and admins can turn the check off with `GeminiCodeCheckForUpdates`. Full auto-update can come later with a small update server. See [RELEASING.md](RELEASING.md) for how releases and the page are built.

## Security model

ACP does **not** sandbox the agent. The CLI routes only its `read_file`, `write_file` and `edit` tools through the client's file requests. Its shell, `grep`, `glob` and `ls` tools run inside the CLI process with the user's permissions. What keeps the user in control:

1. **Approval modes.** In **Default** mode the CLI asks permission before every mutating tool. **Auto Edit** and **YOLO** skip some or all of those questions. Admins can remove either mode, and YOLO is off by default.
2. **Admin policy passed to the CLI.** GeminiCode writes a policy file and passes it with `--admin-policy`. When a mode is turned off, the CLI itself keeps asking in that mode. When shell access is off, the CLI removes its shell tool. A system policy directory on the machine overrides this file.
3. **Folder trust.** The CLI refuses Auto Edit and YOLO in a folder it does not trust. GeminiCode asks the user before adding the folder to the CLI's trusted list.
4. **No silent changes.** The IDE never changes the approval mode on the user's behalf.

Real containment needs the CLI's own `--sandbox` (Docker or Podman). It is not the default, because it would require a container runtime on every machine.

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

To pin a CLI version for everyone, lock `GeminiCliPath` to an empty string and `GeminiCliVersion` to the version. An organisation's default Google Cloud project ID can ship in `product.json` as `geminiDefaultProjectId`. Nothing sets it today: the release workflow stamps only `geminiCodeVersion`, so an organisation that wants a default must add it to its own build.

## Direct requests

Inline edit and commit messages don't need a whole agent turn, so they skip the agent and send one request to a fast model (`gemini.inlineEdit.model`; by default the newest Flash model the installed CLI names, falling back to the previous one for accounts that can't use it yet) from `src/acp/directRequest.ts`. They use the sign-in the CLI saved, read only, and never change the CLI or its files:

- **Google sign-in** (`oauth-personal`): the access token in `~/.gemini/oauth_creds.json` calls the Gemini Code Assist service (`cloudcode-pa.googleapis.com`, the same one and the same license the CLI uses), billed to `gemini.projectId` or, without one, the project Code Assist reports for the user. An expired token is refreshed in memory with the CLI's own OAuth client, read from the installed CLI's bundle.
- **API key** (`gemini-api-key`): `GEMINI_API_KEY` calls the Gemini API.
- Vertex AI, and sign-ins kept in the system keychain, are not supported yet; the command says so.

A request carries only the selection with up to 80 lines around it, or the diff (cut at 40,000 characters) and the last few commit subjects. `GeminiInlineEdit` turns both features off.

The **usage meter** (`usageMeter.ts`) makes the same `retrieveUserQuota` request the CLI makes, with the same project, at most every 10 minutes and only while the window is in front. The Gemini status bar item's tooltip lists each model's share of today's quota and when it resets, and the item shows the percentage once a model passes 80%. API key sign-ins have no quota to read, so it shows nothing. `GeminiUsageMeter` turns it off.

**Enhance prompt** (`promptEnhancer.ts`, `webview-src/enhance.ts`) is just as small a job, and is a direct request too (`QuickEdits.enhancePrompt`), on the inline edit model and under the same setting and `GeminiInlineEdit` policy. Direct requests carry the CLI's User-Agent, `user_prompt_id` and `session_id`, without which Code Assist allows only about one a minute ([FINDINGS.md](FINDINGS.md#prompt-enhancement-direct-requests-or-the-cli)). When direct requests are off, cannot use the sign-in, or fail (for five minutes after a failure), the CLI makes the rewrite: each in a fresh session on the shared agent process, in an empty folder (`<globalStorage>/enhance`), so earlier rewrites never leak into it, the CLI adds no folder context and the sessions stay out of the project's chat history. That session is put in Plan mode and on the first Flash-Lite (else Flash) model the agent offers, and only text sent during its prompt counts as the reply (gemini-cli sends a mode change as message text). While direct requests fail, the next session is opened ahead of the click. The draft goes with the names of its attachments, the chat's last six messages, the folder, branch, open file and mode, never file contents. The reply is cleaned (`cleanEnhancedPrompt`) and replaces the draft as an edit, so Undo brings it back. CLI sessions are not turns, so they never hold back a restart.

**Review My Changes** (`reviewPrompt.ts`, `AgentsView.reviewChanges`) starts an ordinary agent whose session opens in Plan mode (`setModeOnNextSession('plan')`), so the CLI itself refuses edits. The `git diff HEAD` (cut at 100,000 characters) goes as a `uncommitted.diff` document attachment, which keeps the chat bubble short and reaches the model as an embedded resource.

The **MCP Servers and Rules** page (`settingsPage.ts`, `projectSettings.ts`) edits the CLI's own files rather than keeping settings of its own: `mcpServers` in the personal and workspace `settings.json` (read as JSON with comments, and only rewritten when they have none), `mcp-server-enablement.json` keyed by the lowercased server name as gemini-cli's `McpServerEnablementManager` writes it, and the `context.fileName` rules files. Startup failures come from the same debug-log reader as the warnings. The page reads the files only when it is shown or changed.

## Sign-in and errors

- **Sign-in is delegated.** The CLI owns OAuth. GeminiCode calls `authenticate("oauth-personal")` only when `session/new` reports that sign-in is required, because the call rewrites `security.auth.selectedType` in the user's `~/.gemini/settings.json`.
- **Terminal fallback.** Some steps cannot finish over ACP: account validation, and a sign-in on a machine with no browser. For these, **Complete Setup in Terminal** runs the interactive `gemini` with the same environment, and GeminiCode restarts the agent when the terminal closes.
- **Errors are strings.** The CLI turns every setup failure into JSON-RPC error `-32000` with a message string; other failures arrive as a generic internal error with the CLI's message in `data.details`. `classifyAgentError()` matches those strings against a small table of known patterns (sign-in required or failed, project ID missing or numeric, untrusted folder), each with a test fixture. An unknown message is shown as it is.
- **Project ID.** GeminiCode resolves the Google Cloud project from the workspace setting, then the user setting, then the organisation default, then the `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT_ID` environment variables. It refuses to start the CLI with a project number, and only logs a warning for an ID that looks malformed.

## Upstream's own AI

The Gemini extension sets `chat.disableAIFeatures` by default. That hides upstream's chat view, Copilot status item and inline chat. One `GEMINI-FORK` filter also keeps upstream's Chat commands out of the Command Palette. `product.json` still carries upstream's `defaultChatAgent`, because removing it would touch about 45 upstream files.

## Design rules

1. Discover model and mode IDs from the agent; never hardcode them.
2. Entitlement comes from the server, never from the client.
3. The CLI is a swappable runtime: any supported version, from any of the four sources.
4. Feature-detect and degrade. Hide a control the agent does not support, and render unknown update kinds generically.
5. Keep the wire-to-UI adapter thin (`sessionUpdates.ts`).
6. `extensions/gemini/src/acp` never imports `vscode`. ESLint enforces this.
7. Edit upstream files only at registration points, and mark each edit `GEMINI-FORK`.
8. Never patch the Gemini CLI. Speed comes from GeminiCode's own code: process reuse, prewarming, batching and caching.

## Testing

- **Unit tests** (Vitest, `extensions/gemini/test/acp`) cover the ACP client against a scripted fake agent (`test/fake-agent`), which replays streaming, permission requests, file requests, error strings and unknown update kinds. They also cover the code around it that has no `vscode` dependency: CLI resolution, install and update checks, the app update check, admin policy, file access, project IDs, folder trust, attachments, the agents model, changes and transcript storage.
- **Real CLI tests** run when `GEMINI_CLI_PATH` points at a CLI. They check the unauthenticated `initialize` handshake and the sign-in-required path. They also check that the CLI obeys GeminiCode's admin policy, against a fake Gemini API on localhost. CI runs them against the `latest` and `preview` CLI.
- **Webview tests** (`test/webview`) cover the streaming Markdown splitter and the chat's view logic: file names in replies, mentions, attachments, permission defaults, durations, scrolling and the composer height.
- The `src/host` code that needs VS Code has no automated tests yet; check it by running the dev build.
