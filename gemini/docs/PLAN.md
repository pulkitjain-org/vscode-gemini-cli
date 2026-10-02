# Gemini VS Code Fork: Build Plan (rev 4)

This revises the original PLAN.md (1 Oct 2026). Rev 3 (2 Oct 2026) makes this repository the full fork and starts the integration as a built-in extension. The claims in rev 1 were checked against the published `@google/gemini-cli@0.62.0` bundle and `@agentclientprotocol/sdk@1.6.0` on 2 Oct 2026. Where rev 1 was wrong, it is corrected here and marked **[changed]**. Background research is in CONTEXT-HANDOFF.md.

Rev 4 (2 Oct 2026) adds Phase 2B, the agent workspace: a left pane of workspaces with several agents under each, so GeminiCode feels like Cursor or Claude Code. It is built inside the extension so upstream merges and CLI upgrades stay cheap; see "Agent workspace" under Repo model.

## Decision

- Fork VS Code for the shell, branding and policy enforcement. The product is a standalone application, like Cursor, not an extension users install.
- Do not reimplement the agent. Run the official `gemini --acp` as a sidecar and implement the ACP *client* natively.
- **[changed]** This repository *is* the fork: a hard fork of `microsoft/vscode` from day one. There is no separate extension-first repo, and the pilot ships the branded application.
- **[changed]** The Gemini integration starts as a **built-in extension** inside the fork (`extensions/gemini/`). It ships inside the app, so users install nothing, and it keeps the upstream merge surface small. Pieces move into the workbench (`src/vs/workbench/contrib/gemini/`) only where the extension API cannot do the job (Phase 4).
- The GenAI SDK was rejected as a transport because it cannot consume the Enterprise Code Assist license.
- OAuth is delegated to the CLI.

## Corrections to rev 1

### C1. ACP does not sandbox the agent **[changed]**

Rev 1 said that "the agent cannot touch the filesystem or spawn a terminal except by asking." That is false in 0.62.0:

- **File access is only partly delegated.** `AcpFileSystemService` routes just the `read_file`, `write_file` and `edit` tools through `fs/read_text_file` and `fs/write_text_file`. Even then, a path outside the session `cwd`, or inside `~/.gemini`, falls back to local disk (`shouldUseFallback`). `glob`, `grep`, `ls`, `read_many_files` and similar tools read the disk directly from the sidecar.
- **`terminal/*` is never used.** The SDK defines `createTerminal`, but the CLI makes zero calls to it. The shell tool runs commands inside the sidecar process.

**What actually enforces ask-don't-decide** is three layers:

1. `session/request_permission`, which the CLI sends for every mutating tool when the session is in `default` mode.
2. The CLI's policy engine, configured through `--admin-policy`. The flag is present in 0.62.0.
3. The IDE never switching modes on the user's behalf.

All three are protocol-level and policy-level controls, not a sandbox. If the threat model needs real containment, the CLI's own `--sandbox` (Seatbelt or Docker) is the lever, and it is tracked as an option for Phase 4.

**Plan impact:**

- The "terminal bridge" task is replaced. The IDE now renders shell tool calls from `session/update` `tool_call` / `tool_call_update` content and permission requests, and Stop maps to `session/cancel`.
- The IDE still advertises `fs` capabilities, so edits inside the workspace go through the editor.

### C2. No native license-validation handler in ACP mode **[changed]**

Only the interactive TUI calls `config.setValidationHandler(...)`. In `--acp` mode, `_doSetupUser` sees no handler and rethrows `ValidationRequiredError`. Plan impact:

- Rev 1's "native `validationHandler`" cannot be built over ACP.
- **Mitigation:** detect the failure, show a clear message, and offer a **"Complete setup in terminal"** action. That action opens an integrated terminal running interactive `gemini` with the same environment, so the CLI's own TUI handler resolves validation once. The IDE then retries.
- Phase 0 still asks whether the tenant triggers validation at all.

### C3. Typed errors do not cross the wire **[changed]**

`authenticate` and `session/new` wrap every failure as `RequestError(-32000, getAcpErrorMessage(e))`. The IDE receives a message string, not `IneligibleTierError`, `ProjectIdRequiredError` or `validationLink`. Plan impact:

- Pre-validate what we can client-side: a purely numeric ID, or an ID that is missing or empty.
- Classify the remaining server errors with a small, versioned table of message patterns. It sits behind one `classifyAgentError()` function with fixtures per CLI version, which Compat CI exercises.
- An unknown message falls back to showing the raw text, never a stack trace.

### C4. `authenticate` has side effects on the user's CLI config **[new]**

`authenticate(methodId)` does two things that affect the user's standalone `gemini` CLI:

- It clears cached credentials if `security.auth.selectedType` differs.
- It writes `selectedType` into the user's `~/.gemini/settings.json`.

To limit the impact, the IDE calls `authenticate` only when `session/new` reports that auth is required, and always with `oauth-personal`.

We also need to verify, in the Phase 1 spike, that the OAuth flow in ACP mode opens a browser and never writes the prompt to stdout, where it would corrupt the JSON-RPC stream. If it fails, the fallback is the same "complete login in terminal" action as C2.

### C5. Apply edits *and save* **[changed]**

Routing `fs/write_text_file` through a `WorkspaceEdit` gives us diff, undo and decorations. However, if the buffer is left dirty, the sidecar's shell, grep and test runs read stale disk contents (see C1). So the IDE applies the edit and then saves the document. Undo still works.

### C6. Use Electron's Node from Phase 1 **[changed]**

An extension host already runs on Electron's Node, which is Node 22 in current VS Code and satisfies the CLI's `engines.node >=20`. So the extension can spawn the CLI bundle with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` from day one, with no host Node prerequisite. It is no longer a Phase 5 item. Still to verify: the CLI relaunches itself to raise the heap size, and that child process must inherit the environment variable.

### C7. Compat CI cannot authenticate as a seat holder **[changed]**

`initialize` needs no auth, so it runs in hosted CI against `latest`, `latest-1`, `preview` and `nightly`. That covers protocol version, auth methods, capabilities and the method set.

`session/new` needs the licensed OAuth identity. The models and modes matrix therefore runs as a scheduled smoke test on a self-hosted runner or a maintainer machine that holds a seat. It does not run in hosted CI.

### C8. Version facts refreshed

- On 2 Oct 2026 the CLI dist-tags were `latest` 0.62.0, `preview` 0.63.0-preview.0 and `nightly` 0.64.0-nightly.20261002.
- `@agentclientprotocol/sdk` is at 1.6.0.
- The minimum supported CLI version is set to 0.61.0.

## Testing strategy **[new]**

Development and CI cannot reach the licensed tenant, so most tests run against a **fake ACP agent**: a small script built on the SDK's `AgentSideConnection`. It replays scripted sessions covering streaming updates, permission requests, fs reads and writes, error strings, `-32601` responses and unknown update kinds. Every client feature is tested against it.

The real `gemini --acp` is used in two places only:

- The unauthenticated `initialize` test in CI.
- Manual or scheduled authenticated smoke tests against `ric-prd-gemini-ca-apr`.

## Repo model **[changed]**

### Hard fork with full upstream history

1. Import `microsoft/vscode` with its full history at the **`1.140.0`** release tag, the latest stable release on 2 Oct 2026.
2. Add `upstream` as a remote.
3. Fork-specific work lives on `main`.
4. Upstream bumps are `git merge upstream/release/1.x` (or the next release tag), done as a scheduled task each month.

The full history makes those merges three-way. A squashed snapshot would turn every bump into a hand-applied diff. The cost is a repository of about 1 GB.

### Where our code lives

The aim is minimal collision with upstream.

```
extensions/gemini/            # built-in extension, shipped in the app (Phases 1–3)
  src/acp/                    # host-agnostic ACP client, NO `vscode` import: sidecar spawn and
                              # supervision, JSON-RPC via @agentclientprotocol/sdk, session state,
                              # wire→UI adapter, project-ID resolution and validation,
                              # error classification
  src/host/                   # VS Code host: chat webview, permission and diff UI, fs handlers over
                              # TextDocuments/WorkspaceEdit, status bar, settings, commands
  media/                      # webview assets
  test/fake-agent/            # scripted ACP agent for tests
src/vs/workbench/contrib/gemini/   # Phase 4 only: workbench-level policy, onboarding and UI that
                                   # the extension API cannot provide
gemini/                       # fork-specific, non-source material
  docs/                       # this plan and the handoff
  scripts/                    # upstream-merge helper, release scripts
  policy/                     # admin-policy templates
  update-feed/                # static update JSON (Phase 5)
.github/workflows/gemini-*.yml
```

Upstream files are edited only at registration points:

- `product.json`
- the build lists that register a built-in extension: `build/gulpfile.extensions.*`, `build/npm/dirs.*`
- (Phase 4) `src/vs/workbench/workbench.common.main.ts`

Every such edit carries a `// GEMINI-FORK` marker, and `gemini/scripts/list-fork-touches.sh` lists them. That is the checklist for each upstream merge.

### Why a built-in extension first, not workbench code

- Built-in extensions ship inside the app and look native to users, with no Extensions-view entry needed. Cursor does the same.
- They add almost no merge surface against upstream.
- The dev loop is faster: no workbench rebuild for each change.
- The extension API already covers the webview, diff editor, `WorkspaceEdit`, status bar and terminals.

What it cannot do is make policy non-bypassable, because a user can disable a built-in extension. It also cannot own first-run onboarding or replace upstream's chat UI. Those move into the workbench in Phase 4.

### Upstream's built-in AI chat

VS Code 1.140 ships its own chat UI wired to Copilot through `product.json` `defaultChatAgent`. The fork removes `defaultChatAgent` and sets `chat.disableAIFeatures` by default, so there are no Copilot entry points beside ours.

### Chat UI

The chat UI is a webview view (confirmed). From Phase 2B the same webview also runs in editor tabs, one per agent, and the sidebar view stays as a quick chat for the current folder.

### Agent workspace **[new in rev 4]**

Upstream already has an Agents Window (`src/vs/sessions`, backed by `src/vs/platform/agentHost`) with a workspaces and sessions sidebar. We do not build on it yet:

- Agents register only in core code: harnesses implement `IAgent` (`src/vs/platform/agentHost/common/agent.ts`) and are added by hardcoded lines in `node/agentHostMain.ts`.
- Session providers are core-only (`ISessionsProvidersService.registerProvider`), with no extension contribution point.
- Extensions are disabled in that window unless listed in `sessionsWindowAllowedExtensions`.
- Opening it needs Copilot chat setup and `chat.agent.enabled`, which clashes with our `chat.disableAIFeatures` default.
- Those two folders are the fastest-moving areas of the repo (about 3,600 files and 197 of the last 339 commits on 2 Oct 2026).

Plugging a Gemini harness in would mean patching those files on every upstream merge. Instead, the extension owns an Agents view built on public APIs (tree view, webview panels, git extension API, multi-diff). Its domain model (workspace, agent session, chat) copies upstream's naming, so moving onto the Agents Window later is a swap of the view layer. Phase 4 checks for an extension provider API at each upstream merge.

Decisions (2 Oct 2026): an agent opens as an editor tab; agents for other workspaces run in this window with that folder as their root; Cmd/Ctrl+L adds the editor selection to chat.

### Tooling

- **Build:** the extension builds with upstream's own extension pipeline: esbuild/tsc through gulp and `npm run watch`.
- **Unit tests:** vitest for `src/acp`.
- **Integration tests:** upstream's extension integration test runner.
- **Lint:** ESLint forbids `vscode` imports under `src/acp`.

### Dev loop

1. `nvm use` (upstream `.nvmrc` is Node 24.18.0).
2. `npm ci`
3. `npm run watch`
4. `./scripts/code.sh` launches the branded dev build with the Gemini extension loaded.

The integration also stays packageable as a `.vsix` for stock VS Code users during the pilot. This is a free side benefit, not the product.

## Phases

### Phase 0: Unblock (people; runs in parallel, does not block coding)

- **gcp-prereqs**: confirm these five items with the admin of `ric-prd-gemini-ca-apr`:
  1. Seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
  2. Each user has IAM access on the project.
  3. VPC-SC allows `cloudcode-pa.googleapis.com`. This one fails silently by degrading to the STANDARD tier.
  4. Whether the tenant triggers `VALIDATION_REQUIRED`.
  5. Whether a proxy or custom CA is needed.
- **signing-certs**: buy an Apple Developer ID and a Windows code-signing certificate, or decide to rely on MDM-deployed trust.

Coding can start now against the fake agent. Only the pilot gate depends on Phase 0.

### Phase 1: Fork bootstrap and protocol/auth spine (3–4 weeks)

1. **fork-import**: import upstream `1.140.0` with history, add the `upstream` remote, and move these docs to `gemini/docs/`.
2. **rebrand-minimal**: in `product.json`, change `nameShort`, `nameLong`, `applicationName`, `dataFolderName`, `sharedDataFolderName`, `darwinBundleIdentifier`, `urlProtocol`, the server and tunnel names and the `win32*` names. Generate fresh `win32*AppId` GUIDs. Set `quality` and the Open VSX `extensionsGallery`, remove `defaultChatAgent`, and add placeholder icons. The goal is that the dev build runs side by side with a real VS Code without sharing settings.
3. **fork-ci**: a GitHub Actions workflow that compiles the fork, builds and tests `extensions/gemini`, runs hygiene checks, and runs the unauthenticated `gemini --acp` `initialize` check on Linux. There are no full packaged builds yet.
4. **ext-scaffold**: register `extensions/gemini` as a built-in extension and add the fake agent, with vitest and lint for `src/acp`.
5. **sidecar**: binary resolution, initially from a `gemini.cliPath` setting or a `gemini` found on `PATH`. Spawn with Electron's Node (C6) and pass `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and the project env. Supervise the process with crash detection, bounded restarts with backoff, and status events. Capture stderr to an output channel.
6. **acp-session**: run `initialize` and negotiate `protocolVersion`, then `session/new` with `cwd` and `mcpServers: []`. On an auth error, call `authenticate` and retry. Then `session/prompt` and `session/cancel`, with `session/update` streamed through a thin adapter into UI models. Unknown update kinds render generically.
7. **project-id**: resolve the project ID in this order: workspace setting, then user setting, then the org default (`product.json` or a policy file), then the process env (`GOOGLE_CLOUD_QUOTA_PROJECT || GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID`). Pre-validate it, inject it as `GOOGLE_CLOUD_PROJECT`, and classify errors (C3). Map the errors to UI with remediation actions (C2 and C4 terminal fallbacks).
8. **status-bar**: show the active account (read from `~/.gemini/google_accounts.json`, non-secret), the project, the sidecar state and the CLI version. Clicking it opens a quick-pick to restart, change project or show logs.
9. **chat-mvp**: a webview chat that sends text prompts, streams agent messages and thoughts, shows tool-call cards and has a Stop button.

**Exit:** the branded dev build runs a real prompt end to end against the tenant on a maintainer machine.

### Phase 2: Native IDE experience (3–4 weeks)

Done: permission-ui and fs-handlers (PR #4), the chat redesign with model and mode pickers (PR #5), startup and streaming speed (PR #6), context-attachment (PR #7). Session history moves to Phase 2B.

- **permission-ui**: handle `session/request_permission` with the options the agent sends (`allow_once`, `allow_always`, `reject_once` or `reject_always`, rendered from the request rather than hardcoded). Edit permissions open a real diff editor from the tool call's `diff` content. Cancel resolves as `cancelled`.
- **fs-handlers**: `fs/read_text_file` serves unsaved buffers, honours `line` and `limit`, and enforces policy (workspace trust, `.gitignore` and a secrets denylist). `fs/write_text_file` applies a `WorkspaceEdit` and then saves (C5).
- **context-attachment**: `@`-mention file picker, "Add file / Add selection to chat" commands, `resource_link` for files, embedded `resource` for selections and snippets, and `image` blocks when `promptCapabilities.image` is set.
- **tool-call-rendering** (replaces "terminal bridge", per C1): shell commands, output and exit status appear as tool-call cards with locations that link to files, and Stop cancels in-flight work.
- **capability-discovery**: model, mode and config pickers are built only from server responses. A test fails the build if model or mode IDs are hardcoded in UI code.
- **feature-detection**: `session/set_model` and `session/set_config_option` are optional, `-32601` hides the control, and an unsupported `protocolVersion` produces a clear message.
- **session-history**: moved to Phase 2B (`agent-resume`).

### Phase 2B: Agent workspace **[new in rev 4]** (3–4 weeks, after tool-call-rendering)

One PR each, in this order. Each PR states what it did for startup and streaming speed.

1. **multi-session-runtime**: one CLI process serves every agent that shares its launch settings (CLI path and project ID), whatever folder each agent works in, because `session/new` takes its own `cwd`. A second agent starts in about 30 ms and costs about 2.5 MB, against about 1.2 s and 230 MB for a new process (FINDINGS.md). Each agent keeps its own permission answers and can have its own file roots. Processes for other launch settings, and shutting down idle ones, come with agents-pane, which is the first to need them.
2. **agents-pane**: an Agents view container in the activity bar, shown first. A tree of workspaces (the open folder plus folders the user adds) with agents under each. Each row shows title, status (working, needs permission, done, error), relative time and git branch. Actions: add workspace (folder picker), new agent per workspace, rename, remove, and a search filter.
3. **agent-tabs**: an agent opens as an editor tab (`WebviewPanel`) reusing the chat webview. Several agents can sit in split editors. The sidebar chat stays as a quick chat.
4. **agent-resume**: when `loadSession` is advertised, agents survive a reload through `session/list` and `session/load`. Otherwise the pane keeps our own transcript and starts a fresh session on reopen, and says so.
5. **agent-changes**: each agent tracks the files its tools edited, shows `+N −M` in its row and tab, and opens them in the multi-diff editor.
6. **composer-extras**: "Worked for Ns" turn timing, copy on replies, a branch picker and "Create Branch & Commit" through the git extension API. Fork-from-here waits on `agent-resume`.
7. **layout-defaults**: Agents pane first, panel and secondary sidebar tuned through `product.json` and `configurationDefaults`, not workbench code.

Skipped for now: feedback thumbs, voice input, a machine picker (VS Code Remote covers it) and automations.

Budgets: a new agent in a running workspace shows its composer in under 100 ms and is ready to prompt in under 300 ms; the pane renders 200 agents without lag.

### Phase 3: Version resilience and pilot (2–3 weeks; overlaps Phase 5 start)

- **runtime-resolution**: resolve the CLI from an admin-pinned path or version, then the managed directory (`<userData>/gemini-cli/<version>`), then the global install. Support side-by-side versions, in-IDE upgrade with sidecar restart, and the minimum-version check.
- **compat-ci**: run the hosted `initialize` matrix and the authenticated smoke test on a self-hosted runner, diffing the capability snapshots (C7).
- **pilot-builds**: packaged builds of the branded app for the pilot team's platforms, signed if Phase 0 certificates are in hand, otherwise distributed under MDM trust or an explicit "unsigned internal build" note.
- **app-pilot** (*gate*): pilot the branded application with the team and collect feedback on auth, approval UX, context attachment and the agent workspace. First run opens the Agents pane.

### Phase 4: Native deepening and policy (3–4 weeks, then ongoing)

- **workbench-contrib**: add `src/vs/workbench/contrib/gemini/` for what the extension API cannot do:
  - first-run onboarding that walks through sign-in and project verification;
  - locking the Gemini built-in extension so it cannot be disabled;
  - hiding or replacing upstream chat entry points;
  - layout defaults that `configurationDefaults` cannot express.
- **policy-enforcement**: keep `default` mode, gate `yolo` and `autoEdit` behind admin policy (VS Code's policy system plus `--admin-policy` passed to the sidecar), and ship the org default project ID in `product.json`. Per C1, evaluate `--sandbox` and decide, as policy, whether shell tools are allowed at all.
- **full-rebrand**: final icons, about dialog, license and issue-reporter URLs, and welcome page.
- **upstream-merge-1**: the first scheduled merge of the next upstream release, to prove the process and the `GEMINI-FORK` touch list.
- **upstream-agents-watch** **[new in rev 4]**: at each upstream merge, check whether the Agents Window (`src/vs/sessions`) gained an extension-contributed provider API. If it has, plan moving the agent workspace onto it.

### Phase 5: Distribution (overlaps Phases 3–4)

This phase covers:

- the release pipeline: the gulp targets on a CI matrix, plus signing and notarization;
- a static update feed (`product.quality` must be set; `downloadUrl` too);
- CLI provisioning, by bundling a known-good CLI in the installer and reusing the C6 mechanism;
- rollout: MDM or a download page, the Open VSX extension survey, settings import on first run, and `insider` and `stable` rings.

## Design rules

1. Discover, never hardcode, model and mode IDs.
2. Entitlement comes from the server.
3. The CLI is a swappable runtime.
4. Feature-detect and degrade, and render unknown update kinds generically.
5. Keep a thin wire-to-UI adapter.
6. **[new]** `extensions/gemini/src/acp` never imports `vscode`, so it can move into the workbench (or a platform service) mechanically if needed.
7. **[new]** Every edit to an upstream file is marked `GEMINI-FORK` and kept to registration points.
8. **[new in rev 4]** The agent workspace adds no core edits. Optional agent features (session load, model switch, images) turn on from advertised capabilities and are hidden otherwise.
9. **[new in rev 4]** Never patch the Gemini CLI. Speed comes from GeminiCode's own code: process reuse, prewarming, batching and caching.

## Risks (updated)

The rev 1 risks still stand: the signing pipeline, gaps in Open VSX, daily CLI releases and client-eligibility gating. These are added:

- **Error-string coupling (C3).** Error classification breaks silently when the CLI changes its wording. This is mitigated by the fixture tests and by falling back to the raw message.
- **No sandbox (C1).** "Ask, don't decide" depends on running in `default` mode under the admin policy. The UI must make the current mode impossible to miss.
- **ACP OAuth flow (C4)** is unverified in an IDE-spawned sidecar. The Phase 1 spike settles it.
- **Many agents in one process (rev 4).** gemini-cli 0.62 has no way to close a session, so a long-lived process keeps every session it opened (about 2.5 MB each). Restarting an idle process frees them; the pane must show when an agent's process was stopped.
- **Upstream merge cost.** A hard fork on a ~monthly upstream cadence needs a named owner. The `GEMINI-FORK` marker list and keeping work in the built-in extension are the main controls.
- **Build resources.** Full packaged VS Code builds need large CI runners (about 16 GB RAM) and an ARM64 macOS runner. Phase 1 CI compiles and tests only.