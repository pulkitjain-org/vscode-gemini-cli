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
                    settings, commands, git actions, Get Started walkthrough.
  webview-src/      The chat webview (bundled to media/chat.js).
  media/            Webview stylesheet and icons.
  walkthrough/      Get Started step pages.
  test/             Vitest unit tests, a scripted fake ACP agent, and real-CLI tests.
gemini/             Fork material that is not shipped: docs, icon sources, maintainer scripts.
.github/workflows/gemini-ci.yml
```

Upstream files are touched only where a fork must register itself or rebrand. Each such edit carries a `GEMINI-FORK` comment, and `gemini/scripts/list-fork-touches.sh` lists them (see [../README.md](../README.md)). Today these are:

- `product.json` (names, icons, links, Open VSX gallery, CLI policies);
- the build lists that register the extension (`build/npm/dirs.ts`, `build/gulpfile.extensions.ts`, `build/lib/extensions.ts`, `build/filters.ts`, `build/hygiene.ts`, `.eslint-ignore`, `eslint.config.js`);
- branding: packaging metadata (`build/lib/electron.ts`, `build/lib/preLaunch.ts`, `build/win32/code.iss`, `resources/`), the `.dmg` volume name (`build/darwin/create-dmg.ts`), GeminiCode's version in the About dialog (`platform/dialogs/electron-browser/dialog.ts`), and the workbench icons (`code-icon.svg`, `letterpress-*.svg`);
- four workbench edits: Chat commands hidden from the Command Palette while upstream AI is off (`commandsQuickAccess.ts`), the Gemini extension cannot be disabled (`extensionEnablementService.ts`), the product name in the welcome walkthrough (`gettingStartedContent.ts`), and the default colour themes (`ThemeSettingDefaults` in `services/themes/common/workbenchThemeService.ts`, with a fallback to upstream's Dark/Light 2026 in `services/themes/browser/workbenchThemeService.ts` if the GeminiCode themes are ever missing). `product.json` lists the GeminiCode themes in `onboardingThemes` too.

## How a prompt flows

```
Chat webview ──postMessage──▶ ChatController ──▶ AgentClient ──▶ AgentRuntime ──stdio JSON-RPC──▶ gemini --acp
     ▲                              │                                  │
     └──── batched item updates ◀───┴── ChatTranscript ◀── session/update notifications
```

1. **The agent process.** `Sidecar` spawns the CLI with the application's own Node (`ELECTRON_RUN_AS_NODE=1`), so users need no Node install. It passes `GOOGLE_CLOUD_PROJECT`, the proxy and CA variables, and `--admin-policy`. It restarts a crashed process with backoff (1 s, 4 s, 15 s), but never after a fatal exit such as a failed sign-in (exit code 41).
2. **One process, many agents.** `AgentRuntime` runs `initialize` once and serves every chat from that process; each chat is its own ACP session with its own `cwd`. A new agent starts in about 30 ms instead of about 1.2 s.
3. **Sessions.** `AgentClient` opens a session (`session/new`, or `session/load` to resume), signs in when the CLI asks, sends prompts, and exposes the modes and models the agent reports. Nothing in the UI hardcodes a mode or model ID.
4. **Rendering.** `sessionUpdates.ts` turns `session/update` notifications into a few UI events, and `ChatTranscript` folds them into plain, serialisable items. The controller streams item changes to the webview about 30 times a second, sending only appended text for streaming messages. The webview renders agent Markdown with raw HTML disabled.
5. **Permissions.** `PermissionBroker` holds each `session/request_permission` until the user picks one of the options the agent sent. A request that proposes an edit opens a real diff editor. Stopping a turn answers any open request as cancelled.
6. **Files.** The agent's `fs/read_text_file` and `fs/write_text_file` requests go through the editor. Reads see unsaved changes. Writes are applied as a `WorkspaceEdit`, so they can be undone, and then saved, because the CLI's own shell and search tools read the disk. Requests are limited to the agent's folder, skip git-ignored files for reads, and refuse secret files such as `.env`, private keys and credential files.

## The agent workspace

- **Agents pane.** A tree of workspaces (the open folder plus any you add) with agents under each. Each row shows the agent's status, its git branch and its `+N −M` change count.
- **Agent tabs.** Each agent opens as an editor tab that reuses the chat webview, and is the main editor. Files, proposed edits and diffs that the agent's chat or its Changes open go in the editor group after the agent's tab (the one to its right, added once if there is none), so the chat stays in view and the same group is reused (`editorPlacement.ts`). The sidebar's **Quick Chat** is a separate session for the open folder and opens files in the active group, as before.
- **Changes view.** This view sits below the Agents pane in the Gemini side bar and lists the files the agent in front has edited. Each file opens a diff against its text from before the agent's first edit, and **Open All Changes** shows them in the multi-diff editor. **Create Branch & Commit** commits only that agent's files.
- **First open.** The first time a workspace opens, `layoutDefaults.ts` reveals the Gemini side bar (the workbench would otherwise open on the Explorer). After that the workbench restores whatever the user arranged.
- **Persistence.** Each agent's visible conversation (the last 300 items) and changed files are saved in the extension's global storage. On reopen, or after the process restarts, GeminiCode resumes the session with `session/load` when the CLI supports it. Otherwise it starts a fresh session and says so in the chat.

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

**Install Gemini CLI** downloads the release from the npm registry, checks its SHA-512 checksum, and unpacks only `bundle/` and `package.json`. Switching versions restarts the agent once no agent is working, and GeminiCode keeps the current and previous copies. Once a day it checks for a newer release. It only asks first, and skips the check when a version or path is pinned. A CLI older than `MIN_CLI_VERSION` (0.61.0) gets a warning.

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
| `gemini.approval.allowAutoEdit` | `GeminiAllowAutoEdit` | on |
| `gemini.approval.allowYolo` | `GeminiAllowYolo` | off |
| `gemini.tools.allowShell` | `GeminiAllowShell` | on |

To pin a CLI version for everyone, lock `GeminiCliPath` to an empty string and `GeminiCliVersion` to the version. An organisation's default Google Cloud project ID ships in `product.json` as `geminiDefaultProjectId`, which each build sets.

## Sign-in and errors

- **Sign-in is delegated.** The CLI owns OAuth. GeminiCode calls `authenticate("oauth-personal")` only when `session/new` reports that sign-in is required, because the call rewrites `security.auth.selectedType` in the user's `~/.gemini/settings.json`.
- **Terminal fallback.** Some steps cannot finish over ACP: account validation, and a sign-in on a machine with no browser. For these, **Complete Setup in Terminal** runs the interactive `gemini` with the same environment, and GeminiCode restarts the agent when the terminal closes.
- **Errors are strings.** The CLI turns every setup failure into JSON-RPC error `-32000` with a message string. `classifyAgentError()` matches those strings against a small table of known patterns, each with a test fixture. An unknown message is shown as it is.
- **Project ID.** GeminiCode resolves the Google Cloud project from the workspace setting, then the user setting, then the organisation default, then the `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT_ID` environment variables. It rejects a project number before the CLI starts.

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

- **Unit tests** (Vitest, `extensions/gemini/test/acp`) cover the ACP client against a scripted fake agent (`test/fake-agent`). The fake agent replays streaming, permission requests, file requests, error strings and unknown update kinds.
- **Real CLI tests** run when `GEMINI_CLI_PATH` points at a CLI. They check the unauthenticated `initialize` handshake and the sign-in-required path. They also check that the CLI obeys GeminiCode's admin policy, against a fake Gemini API on localhost. CI runs them against the `latest` and `preview` CLI.
- **Webview tests** (`test/webview`) cover the streaming Markdown splitter.
