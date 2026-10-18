# Agentic development plan

How GeminiCode (this fork of VS Code with the Gemini CLI built in, on Gemini Code Assist enterprise licensing and Google Cloud project billing) brings agentic development to a team that works in Jira, GitLab, Figma, Snyk and SonarQube, with Atlassian Rovo and GitLab Duo turned off. Each section gives the design, what is built, and what is still open. The irreversible decisions are recorded in [adr/](adr/).

Every claim names its evidence with one of these tags. A claim without evidence is tagged **[A]**, an assumption, with the check that would settle it.

| Tag | What counts |
| --- | --- |
| **[T]** | A measurement in the trace log below (M-…), or one of the three session traces (T-10 to T-12) once they are in |
| **[CI]** | A named CI job that is green on the commit |
| **[AUDIT]** | An action visible in Jira's issue history or GitLab's merge request activity |
| **[BENCH]** | A score from the benchmark in section 5 |
| **[PILOT]** | Pilot data from section 6 |
| **[LIC]** | A clause of the Gemini Code Assist license or the published quota page |
| **[SRC]** | Code or a test in this repository, by file |
| **[F]** | A finding in [FINDINGS.md](FINDINGS.md) |
| **[A]** | Assumption. The check that would turn it into evidence is named |

## 0. Inputs and constraints

| Input | State | Where |
| --- | --- | --- |
| The fork against its upstream base | The fork is upstream `1.142.0` plus its own commits. `git diff --shortstat 1.142.0 HEAD`: 887 files, +100,364 / −205. By area: `extensions/gemini` 565 files (+71,947), `gemini/` 218 files (+23,065, of which the patch series, the docs, the mockups and the site), `src/vs/workbench` 44 files (+3,830 / −30), `src/vs/platform` 8 files, `build/` 12 files, `resources/` 30 icons, `.github` 4 workflows, plus `product.json`, `eslint.config.js` and three top-level Markdown files. | `gemini/scripts/upstream-series.sh files` |
| The Gemini CLI | `extensions/gemini/package.json` pins `@google/gemini-cli@0.64.0` with its npm SHA-512 (`bundledCli`). Over ACP it implements `initialize`, `authenticate`, `session/new`, `session/load`, `session/cancel`, `session/prompt`, `session/set_mode` and `session/set_model`, and advertises no session close, list, fork or resume [F]. Its headless mode (`gemini -p`, `--output-format text\|json\|stream-json`), `--approval-mode`, `--admin-policy`, `--allowed-mcp-server-names`, `--include-directories` and `--sandbox` are what the plan builds on, with its OpenTelemetry export (`GEMINI_TELEMETRY_*`). | `extensions/gemini/cli/0.64.0/` |
| Performance traces | A real-account measurement of the agent's start, sessions, first reply and tokens, and stand-in measurements of everything but the model (trace log, M-01 to M-07). The three session traces (a Chromium profile, an extension-host CPU profile and a CLI telemetry export of a real working session) are not taken yet; section 1 says which rows of the budget they fill. | `extensions/gemini/scripts/perf-real.mts`, `perf-first-reply.mts` |
| Jira workflow schema, GitLab approval rules and CI config | **Not provided.** Section 3 is written against the Jira and GitLab objects that carry them (`/transitions?expand=transitions.fields`, `/approval_state`, `/approval_rules`) and names the exports to attach. | |
| Rate limits and OAuth scopes of the five tools | **Partly known.** The figures in section 3 come from the vendors' public pages and are tagged for checking against the team's tenants. | |
| Gemini Code Assist enterprise license and quota | **Not provided.** The public quota page says Enterprise agent mode and Gemini CLI allow 2,000 requests per user per day and 120 per minute, across models. | [LIC] pending |
| Desktop only | **A hard constraint.** GeminiCode is a Mac app. When it quits or the Mac restarts, every process (the extension host, the `gemini --acp` sidecar, the local MCP servers, the team servers' children) ends, and comes back only when a window opens. There is no relay, server or always-on runner owned by this project. Section 1 has the restart model. Sections 5 and 6 use only the team's existing CI (GitHub Actions for this repository, the team's GitLab CI) and developers' Macs. | [ADR 0009](adr/0009-desktop-only.md) |
| Rovo and Duo turned off | **A hard constraint.** The Atlassian Remote MCP Server and the GitLab MCP server both need those products, so neither official server is usable for Jira or GitLab (section 3). | |

### Mockups

Eight screens of the IDE as this plan describes it, in the GeminiCode Dark look, are in [`mockups/`](mockups/README.md), one HTML page per screen:

| Screen | Section | What it shows |
| --- | --- | --- |
| Home: my work | 3 | Needs you with the ready-to-merge row, My tickets, Pending on me, Mine, Quality, Gemini; each card named by the query that fills it; the row menu with Start Agent, Move, Log Time, Reassign |
| Merge request panel | 3 | The merge checklist read live from GitLab (pipeline, approval rules by name, approvals valid after a push, threads resolved, mergeable, author rule), the exact request it will make, and a Merge button that stays off until every line holds |
| Confirm-class card | 4 | A `jira_transition` card with the transition, the required Fix version and the comment, offering only Allow once and Reject; a queued `jira_log_time` card; the read rows that ran without a card |
| Audit log | 4 | One row per write with caller, effect, who answered and the remote id, and an intent without a result highlighted |
| After a restart | 1 | Home's Unfinished card, the chat's interrupted-turn card with Retry and Undo, and the cold-start rows |
| Connections | 3, 4 | The five tools with their logos, which run as the team's servers, where each token lives, the tool-schema cost per turn, and the take-over offer |
| Checks on a branch | 5 | The branch picker (checked out here, agents', local, on origin), the checks on a checkout of their own, and Fix starting an agent there |
| Latency readout | 1 | Where a turn's time went, hop by hop against the budget, and the status menu's Record Performance Trace, Open Audit Log and Run Benchmark |

### Trace log

All taken on 18 Oct 2026 on an Apple M3 Pro Mac (12 cores, 36 GB) with gemini-cli 0.64.0. "Real" is a Google sign-in on a Gemini Code Assist license over the network; "stand-in" is a local fake of the Gemini API that answers each model call after 300 ms, with an API key. [FINDINGS.md](FINDINGS.md) has the full tables.

| Trace | Setup | Result |
| --- | --- | --- |
| **M-01** | Real, `perf-real.mts --runs 3`, this repository (untrusted), median of three | `initialize` 2,906 ms (3,314 ms when the CLI relaunches itself) · `session/new` 780 ms, a second 1,063 ms · first text 3,450 ms with Flash picked, 8,114 ms on Auto · 11,882 input tokens per model call · 280 MB after `initialize` |
| **M-02** | Stand-in, `perf-first-reply.mts --runs 3`, empty untrusted folder | `initialize` 745 ms · `session/new` 53 ms · spare 53 ms · first text 676 ms on Auto, 318 ms with Flash picked |
| **M-03** | Stand-in, the same with `--repo` this repository, trusted | `initialize` 812 ms · `session/new` 97 ms · spare 89 ms · first text 675 ms on Auto, 318 ms with Flash picked |
| **M-04** | `vitest run test/perf` | 16 of 16 budgets hold, from Enter to the first chunk to a 500-thread project |
| **M-05** | Real, `probe-enhance.mts`, 12 drafts 10 s apart and a burst of five | Direct request p50 2.8 s / p95 4.7 s · through the CLI on Flash-Lite 4.8 / 15.7 s · on Flash 10.0 / 11.5 s |
| **M-06** | Real, `spike-coordinator --real --model gemini-3.8-flash` | Role held, 5 of 5 asks as expected · median coordinator turn 12.7 s, 43,174 tokens in and 138 out · threads started 39.3 s and 9.9 s after the ask |
| **M-07** | Stand-in, `spike-coordinator` | A coordinator and five threads streaming at once add 5 ms per chunk at p95 |
| **T-10, T-11, T-12** | **Pending: three real working sessions.** A Chromium profile, an extension-host CPU profile (`--inspect-extensions`), and the CLI's telemetry file from **Gemini: Record or Stop Performance Trace** | Fill the budget's "real" column for the fork's own hops |

## 1. Latency budget

### The hops

```
UI (chat webview) ─postMessage─▶ extension host (ChatController → AgentClient → AgentRuntime)
   ─stdio JSON-RPC─▶ gemini --acp (session) ─▶ Code Assist sign-in ─▶ model (routing call on Auto, main call)
   ─▶ tool calls (permission card ⇄ user; fs/* through the IDE; shell inside the CLI) ─▶ session/update ─▶ render
```

### Budget

Values are medians unless marked. Stand-in rows include a 300 ms model call.

| Hop | Measured | Still to measure | Owner |
| --- | --- | --- | --- |
| Enter to `session/prompt` sent | Within its 30 ms budget [M-04]; the webview batches updates at about 30 a second [SRC `chatController.ts`] | Real sessions (T-10) | fork |
| Agent start | 2.9 s to `initialize` on the real account [M-01], 0.8 s on the stand-in [M-03]. Hidden by `AgentWarmup`, which starts the agent 3 s after the window opens when a sign-in is saved [SRC `agentWarmup.ts`] | How often a first prompt still waits for it (T-11, and the pilot's wait counter) | fork |
| Cold start after a quit or a reboot | Window restore (upstream's) + extension activation + the 3 s warm-up delay + 2.9 s to `initialize` [M-01] + `session/load` of the tab in front, with the other tabs deferred [SRC `agentsView.ts` `openLater`]; Home shows its last team snapshot at once and refreshes behind it [SRC `teamData.ts`] | App icon to the first accepted prompt, after a reboot (T-11; the pilot records it per launch) | fork |
| `session/new` | 0.8 s on the real account, 53 to 97 ms on the stand-in [M-01, M-02, M-03]. Hidden by a spare session opened while the user types [SRC `agentRuntime.ts` `prepareSession`] | The CLI's own split of that time (T-12) | CLI, hidden by the fork |
| Model, first text, Flash picked | 3.5 s for a one-word reply on the real account [M-01]; the CLI adds under 20 ms around the model call on the stand-in [M-02] | | model |
| Model, first text, Auto | 8.1 s on the real account [M-01]: the routing call runs before every reply [F] | | CLI, avoided by naming a model |
| Tool calls | The permission card is user time; `fs/read_text_file` goes through the IDE, with `git check-ignore` answers cached 30 s [SRC `fileAccess.ts`, `gitIgnore.ts`]; a coordinator and five threads streaming at once add 5 ms per chunk at p95 [M-07] | `gemini_cli.tool_call` durations (T-12), the extension host's share (T-11) | fork and CLI |
| Render | About 2 ms per update for a 30 KB streaming reply, re-rendering only its unfinished tail [F, M-04] | Real sessions (T-10) | fork |
| Enhance prompt, whole request | 2.8 s p50, 4.7 s p95 as a direct request [M-05] | | model |
| A coordinator turn | 12.7 s median, all model time [M-06] | | model |

### The three biggest costs

1. **Model time, and Auto's routing call.** On the real account a one-word reply takes 3.5 s on Flash and 8.1 s on Auto [M-01]; every prompt on Auto first makes a routing call that the reply waits for [F]. New agents therefore open on the first Flash model the agent lists until the user picks one, and the user's pick is remembered [SRC `agentClient.ts` `defaultModel`, `modelPreference.ts`]. Only an admin-owned `modelConfigs.customOverrides` can lower the routing call's own cost for users who pick Auto, since the CLI ignores system settings files that fail its ownership check [F]. Evidence that it holds: `gemini_cli.model_routing` absent from T-12 on the default path.
2. **The session's start with a Google sign-in.** `session/new` takes 0.8 s on the real account against under 0.1 s with an API key [M-01, M-03]. A plain agent's spare session is keyed by its folder, and the browser's and team tools' servers are bound to it afterwards through slots (`AgentMcpServer.configForSlot`, `bind`), so turning a tool on or off never leaves a spare that cannot be used: the Agents pane prepares a new one when the team tools or the browser setting change [SRC `agentsView.ts` `refreshSpare`]. Threads and a project's coordinator cannot take a spare: a session's folder is fixed when it opens, and each thread's worktree and the coordinator's folder exist only once the thread or project does. Hiding their `session/new` would need a session the CLI can move to another folder, which ACP does not offer. Evidence: the pilot's first-prompt wait counter [PILOT].
3. **Input tokens per request.** A one-line prompt costs 11,882 input tokens per model call, and a coordinator turn 43,174, because the CLI resends its system prompt, every tool declaration and the conversation with each call [M-01, M-06]. Time to first token grows with input; quota counts requests, not tokens [LIC pending]. What the fork controls: the team tools server lists only connected tools, and the team's Jira and GitLab servers, run as children, expose 14 tools rather than 106 (section 3). What it measures: **Record Performance Trace** reads `cached_content_token_count` for every model call, to show whether Code Assist's caching hits the CLI's stable prefix [SRC `traceRecording.ts`]. What it cannot change: the CLI's prefix order (design rule 8: never patch the CLI), so a low cache share becomes an upstream request with the trace attached.

Two fixed costs stay in the budget as regressions to watch: the CLI's relaunch to raise its heap, 0.4 s of every start, avoided with `GEMINI_CLI_NO_RELAUNCH` [M-01], and whole-reply re-rendering, 25 ms per update, replaced by tail rendering [F].

### Restart model: what a quit or a reboot costs, and what survives

The app has no server, so every piece of state has a place and a behaviour after a window opens again.

| State | Lives in | Survives a quit or reboot | What the user sees after |
| --- | --- | --- | --- |
| Agent list, workspaces, project and thread records | global state | yes | the same list and cards [SRC `agents.ts`] |
| Each agent's conversation | one JSON per agent in global storage, plus the CLI's chat file under `~/.gemini/tmp/<project>/chats/` | yes | shown at once; the CLI session reopens with `session/load` by id [SRC `cliSessions.ts`] |
| Undo and Rewind checkpoints | `<globalStorage>/checkpoints/<agent>.json`, written when a turn ends | yes, up to the last finished turn | Undo works for finished turns |
| A turn that was running | the sidecar process | **no** | a card says the turn was cut off when GeminiCode quit, with Retry the Turn and Keep and Continue; the CLI's chat file keeps what streamed [SRC `chatController.ts` `wasCutOff`] |
| Pending permission cards | memory | **no**: cancelled | the card is gone with the turn; a restart never answers for the user |
| "Allow for this session" shell approvals | memory [SRC `sessionApprovals.ts`] | **no** | the next command asks again |
| Google sign-in | `~/.gemini/oauth_creds.json`, the CLI's | yes | `AgentWarmup` starts the agent 3 s after the window opens |
| Team tool tokens and accounts | macOS keychain (SecretStorage) and global state | yes | Connections shows the last state, then checks again |
| Home's team data | a snapshot in global state [SRC `teamData.ts`] | yes | cards at once, dimmed until refreshed |
| Worktrees and branches | `~/.geminicode/worktrees/` and the repository | yes | restored, or recreated from the branch [SRC `restoreWorktree`] |
| Folder trust | `~/.gemini/trustedFolders.json`, the CLI's | yes | |
| The spare session, slot bindings, the team servers' children | memory and child processes | **no** | the first new agent pays `session/new`; each child starts on its first call, starts again after it exits, and stops after 10 idle minutes [SRC `mcpStdio.ts` `ChildServer`] |
| A flow tab (Open Merge Request, Move Ticket, Review) | a webview panel, with a record in `<globalStorage>/flows/` while open, including what the user typed and ticked [SRC `flowRecords.ts`] | the record does | Home's Unfinished card offers Reopen from the same inputs, or Discard |
| Last check results per agent | the agent's record [SRC `AgentsModel.setChecks`] | yes | Open Merge Request still offers the checks attachment |
| A write that was in flight (branch pushed but no merge request yet; ticket moved but comment not posted) | the audit log's intent record | yes | Home's Unfinished card lists intents without a result, with Open Audit Log and Mark as Checked; nothing is redone on its own |
| The audit log (section 4) | append-only JSON lines, a file per day | yes | **Open Audit Log** shows it by day with intents without a result highlighted; the status bar counts the day's writes [SRC `auditPage.ts`, `auditStatusBar.ts`] |

Two rules follow, and are in ADR 0009: **every flow that spans a model turn or a remote write can be resumed from a record on disk**, and **a restart never answers a question the user did not answer**. Losing a turn mid-way is accepted; finishing it silently is not.

### Taking the session traces

- CLI: **Gemini: Record or Stop Performance Trace** restarts the agent once with `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OUTFILE=~/geminicode-trace-<date>.jsonl`, `GEMINI_TELEMETRY_LOG_PROMPTS=false` and `GEMINI_TELEMETRY_TRACES_ENABLED=true`. While it records, every turn's end shows where its time went, hop by hop against this budget; Stop reads the file into a table of each turn's routing call, model calls, tool calls and cached tokens [SRC `traceRecording.ts`, F "The telemetry file"]. The file carries no prompt or reply text, but it does carry the CLI's system prompt and tool declarations.
- Extension host: start with `--inspect-extensions=9333` and record a CPU profile over one turn, or use **Developer: Start Extension Host Profile**.
- Chromium: **Developer: Toggle Developer Tools → Performance**, recording from Enter to the end of the reply.

## 2. Fork hygiene

### Where the fork stands

- Custom code is confined: 71,947 of the 100,364 added lines are in `extensions/gemini`, and `src/acp` never imports `vscode` (an ESLint rule) [SRC]. The workbench part is 23 fork-only files under `src/vs/workbench/` (most in `contrib/gemini/`) and 3 under `src/vs/platform/`.
- Upstream files **modified**, the ones that can conflict on an upstream move: 21 under `src/vs/workbench`, 5 under `src/vs/platform`, 12 build files, `product.json`, `eslint.config.js`, three top-level Markdown files and 30 icon resources. Each code edit carries a `GEMINI-FORK` marker [SRC `gemini/scripts/list-fork-touches.sh`].
- The upstream base moves by merging the release tag, so every move is a three-way merge and existing clones keep working.

### Design: a patch series over a pinned tag

1. **Pin.** `gemini/upstream.json` holds the tag (`1.142.0`). The set of edits to upstream files is kept as a patch series, `gemini/patches/`, one patch per file, binaries included, regenerated from `HEAD` against the pinned tag (`upstream-series.sh regenerate`, 74 patches). Files the fork adds beside upstream's are listed in `gemini/patches/ADDED`; the fork-owned paths (`extensions/gemini/`, `gemini/`, `contrib/gemini/`, the `gemini-*.yml` workflows) apply to any base.
2. **Confinement, enforced.** `upstream-series.sh check`, which CI's `Patch series matches HEAD` step runs, fails when the series is stale against `HEAD` and when an upstream code file the series edits has no `GEMINI-FORK` marker. Images, JSON, Markdown, XML, YAML and the Debian and RPM templates cannot carry a marker and are exempt. The rule is per file: an added import or a deleted line beside a marked edit needs no marker of its own [CI].
3. **The upstream job, `gemini-upstream.yml`.** Runs once a week and by hand:
   - Fetches upstream's tags and takes the newest release above the pin (`1.N.0`, and patch releases `1.N.x`).
   - Checks out the tag, applies the series with a three-way merge, copies the fork-owned paths from `main`, moves the pin, and regenerates the series. A patch that does not apply leaves conflict markers in the branch, and the pull request names it.
   - Bumps the bundled Gemini CLI to the newest release, with its integrity from npm. Raising `MIN_CLI_VERSION` stays a separate decision.
   - Opens one pull request, which lists what to re-check: the CLI findings that name a version, and whether upstream's Agents window (`src/vs/sessions`) gained an extension API for agent providers.
   - Gemini CI builds and tests the pull request like any other: the full compile, hygiene, the extension tests and the real-CLI tests against the new pin.
4. **What fails a test rather than a user** on a CLI move: the error strings in `test/fixtures/agentErrors.json`, the model list's shape (`realAgentModels.test.ts`), the `session/load` replay count (`realAgentSessions.test.ts`), the admin policy (`realAgentPolicy.test.ts`), Rewind (`realRewind.test.ts`) and a failing MCP server's report (`realAgentMcp.test.ts`).

**Open:** the branch-protection rule that requires **Gemini CI** and the upstream job to be green before a merge is a repository setting, not something a commit sets. A signed-in smoke run of models and modes needs a machine with a seat; hosted CI cannot sign in.

### What an upstream move costs

The move from 1.141.0 to 1.142.0 merged 593 upstream commits. Two of the 74 patches needed a hand merge, both files the fork edits at one point (`build/lib/preLaunch.ts`, `src/vs/platform/dialogs/electron-browser/dialog.ts`), and the series stayed at 74 patches. Electron stayed at 43.7.7, and the type check, the build and the tests passed on the merge.

### Backward compatibility

The `gemini.*` settings keys, the policy names, `chatProtocolVersion`, the transcript file format, the agent records in global state and `.gemini/geminicode-tools.json` are the contract with existing users. A change keeps them, and a migration reads the old key and writes the new one, with a test in `test/acp` ([ADR 0008](adr/0008-storage-compatibility.md)).

## 3. One integration layer for the agent and the UI

### Which MCP servers are usable

| Tool | Official MCP server | Usable here | How GeminiCode reaches it |
| --- | --- | --- | --- |
| Jira Cloud | The Atlassian Remote MCP Server (`mcp.atlassian.com`), which is Rovo's; OAuth 2.1 | **No**: Rovo is off [A: confirm with the Atlassian admin] | The team's own `mcp-atlassian` container as a child of the adapter, with the in-process REST connector (`jira.ts`) for the calls it has no counterpart for and as the fallback |
| GitLab (self-managed) | The GitLab MCP server (`<instance>/api/v4/mcp`), Premium or Ultimate, beta, needs **Duo** | **No**: Duo is off [A: confirm `/api/v4/mcp` is refused on the instance] | The team's own `gitlab-mcp` container as a child, with the in-process REST connector (`gitlab.ts`) the same way |
| Figma | The Dev Mode MCP server in the desktop app, `http://127.0.0.1:3845/mcp`, Dev or Full seat; remote `mcp.figma.com` | **Yes** [SRC `figma.ts`] | A small MCP client in the adapter. Comments are not a tool of the Dev Mode server [A: check on the current release]; the REST API `GET /v1/files/:key/comments` with a `file_comments:read` token reads them when the review flow needs them |
| Snyk | `snyk mcp -t stdio`, part of the Snyk CLI, on the CLI's sign-in | **Yes** | A stdio child of the adapter, one per folder, with the CLI (`snyk.ts`) as the fallback |
| SonarQube Server | `sonarsource/sonarqube-mcp` (container), user token, needs SonarQube Server 2025.1+ | **Yes on 2025.1 or later** [A: check `GET /api/system/status` on the instance] | A container child of the adapter, one per folder, with the Web API client (`sonar.ts`) as the fallback and for older servers |

### The team's own servers

The team's `.gemini/settings.json` runs Jira and GitLab as MCP servers of the CLI itself. Starting each with its published package and the file's own include and exclude lists, then calling `tools/list`:

| Server | Image in the file | Advertised | After the file's filter | Schema bytes sent per request | About |
| --- | --- | --- | --- | --- | --- |
| `jira` | `ghcr.io/sooperset/mcp-atlassian:latest` (0.23.1) | 63 tools | 48 | 37,550 | 9,400 tokens |
| `gitlab` | `zereight050/gitlab-mcp:latest` (2.3.3) | 124 tools | 58 | 78,544 | 19,600 tokens |
| `geminicode-tools`, its Jira and GitLab tools | in-process | 11 | 11 | 4,665 | 1,200 tokens |

The CLI sends every tool declaration with every model call [F], so the two servers add about 29,000 input tokens to every request of every turn, before any ticket or diff is read: more than twice the CLI's own 11,882 [M-01]. Other facts from the file:

- Docker starts the servers on each Mac (`docker run -i --rm … :latest`), so Docker is a prerequisite of those machines, and `:latest` lets the tools change under the team without a commit.
- Their tokens come from the user's shell environment (`$GITLAB_PERSONAL_ACCESS_TOKEN`, `$JIRA_API_TOKEN`), and `security.environmentVariableRedaction.allowed` tells the CLI not to redact those two names. The agent's shell runs in that environment, so `env` in a turn would show the model both tokens (section 4).
- `trust: false` on both servers, so every call asks unless a project policy in `.gemini/policies/` allows it.
- The GitLab filter already leaves out merging and approving, and the Jira filter deletes, edits, moves and sprint changes, which matches the confirm class. A settings file in the repository is editable by anyone with write access, so the same rule is in GeminiCode's admin policy, which holds whatever the file says.
- `mcp.allowed` lists `gitlab`, `jira` and GeminiCode's servers, so an agent sees two sets of Jira and GitLab tools until the team's servers are taken over.

### The adapter

```
                      ┌──────────────────────── adapter (extension host) ────────────────────────┐
  agent (ACP session) ─▶ geminicode-tools MCP (127.0.0.1, HMAC per agent) ─▶ team tools ─▶ connector
  UI (Home, MR panel, flows) ──────────────────────────── teamWrite ─────▶ team tools ─▶ connector
                                                                           │ read / write / confirm class
                                                                           │ audit log · timeouts · read cache
  Connectors: Jira, GitLab (team's servers as children, REST in-process) · Figma (MCP client)
              Snyk (stdio child, CLI fallback) · SonarQube (container child, Web API fallback)
```

- **One call path.** `geminicode-tools` (`teamToolsMcp.ts`) is a local MCP server with one URL and HMAC bearer token per agent, given to every session in `session/new`'s `mcpServers`, built on the same local server as the browser's and a project's (`localMcpServer.ts`). The pages' writes (Move, Log Time, Reassign, Open Merge Request, the review's comments, Approve, Request Changes and Merge) go through `teamWrite` (`TeamConnections.write`), the same code, checks and audit record as an agent's call; `test/acp/teamWrite.test.ts` checks that the two records match but for the caller [SRC].
- **The team's servers as children.** **Take Over Both Servers...** on Connections' card for the settings file reads each server's address, account and token (from the environment GeminiCode started in, or asks), connects both accounts, then removes the two entries, their names from `mcp.allowed` and their tokens from the redaction allowance. A file with comments is opened for the user to edit instead [SRC `teamTakeover.ts`].
  - The images run as `ghcr.io/sooperset/mcp-atlassian:0.23.1` and `zereight050/gitlab-mcp:2.3.3`, pinned by digest. Docker gets each variable's name, and the value goes only into the child's environment, so no token is in a process list. Each container is started with only the 7 tools the adapter calls [SRC `teamContainers.ts`].
  - A container starts on its first call, starts again after it exits, and stops after 10 idle minutes; a stop waits for any call in flight. `gemini.team.runTeamServers`, which the take-over turns on when Docker is installed, decides whether they run at all [SRC `mcpStdio.ts`].
  - The calls that map one to one go through the containers: reading a ticket or a GitLab issue, search, comment, log time, assign, move, open a merge request, reply, resolve, approve, merge. The adapter keeps its own checks around them: the merge readiness check and the head the user saw, picking a transition by status, the team's comment visibility.
  - What has no counterpart stays in-process: a merge request's summary with its threads, diffs and failed jobs, job logs, the merge request lists, assignable people, comments on a line, requesting changes.
  - When a container can't start (Docker not running), the call goes to the in-process connector and the log says so. A container that stops during a call is an error, never a retry, so a write cannot happen twice.
  - **Open:** a run against the real images. The argument names and result fields were read from the two packages' sources at those versions, and `test/acp/teamContainers.test.ts` checks the mapping against a scripted server.
- **Snyk and SonarQube as children.** The CLI loads MCP servers only in trusted folders and only from settings or the session [F]; servers put in `~/.gemini/settings.json` would be out of the UI's reach, keep their tokens in the agent's environment, and follow the CLI's permissions. So the adapter starts them, behind the same setting:
  - **SonarQube:** `sonarsource/sonarqube-mcp:2026.5.0`, pinned by digest, one container per folder with the folder mounted read-only at `/app/mcp-workspace` and only the analysis, issues, quality gates, hotspots and projects toolsets. `sonar_quality_gate` and `sonar_issues` read through it, and any failure falls back to `sonar.ts`, since a read can run twice.
  - **Snyk:** `snyk mcp -t stdio` from the user's own Snyk CLI, one per folder with `TRUSTED_FOLDERS` set to that folder only. `snyk_test` and `snyk_code_test` go through `snyk_sca_scan` and `snyk_code_scan`, with the CLI as the fallback.
  - **Checks, on this Mac:** a SonarQube row analyses the files the branch changed since it left its target, plus what isn't committed, at most 25, with `analyze_code_snippet` and each file's path in the mounted folder, so no file's text passes through a message. Its findings join the list Fix With Agent sends. `analyze_file_list` needs SonarQube for IDE beside the server, which GeminiCode doesn't ship.
  - **Open:** a run against a live SonarQube and Snyk account. The arguments and result fields were read from the servers' sources.
- **Thin means thin.** The adapter adds the tool list, the permission class, the audit log, timeouts that name a cause the user can act on (`teamHttp.ts`), and a short read cache. Workflow logic lives in `teamFlowLogic.ts`, which is pure and tested.
- **Rate limits and scopes**, to check against the team's tenants:
  - Jira Cloud: cost-based budgets per tenant, `429` with `Retry-After`; exponential backoff with jitter [A: Atlassian's rate-limiting page]. A **scoped** API token with `read:jira-work`, `write:jira-work`, `read:jira-user` rather than an unscoped one [A: check scoped tokens are on for the site].
  - GitLab: per instance, set by its admin, with `RateLimit-*` headers [A: read the instance's values]. A PAT with `api` is needed for writes, and Connections checks the scope and shows the expiry [SRC `teamConnections.ts`]. There is no narrower write scope [A].
  - Figma: `429` with `Retry-After`, by seat; the Dev Mode server has no published limits [A].
  - Snyk REST: 1,620 requests per minute per API key [A: Snyk's docs]. The MCP server uses the CLI's sign-in.
  - SonarQube: no published API limit; user token [A].

### The "my work" panel

Home's sections, each named by the query that fills it, so a card's number can be checked against the tool [SRC `homeDashboard.ts`, `teamData.ts`]:

| Section | Source | Shows |
| --- | --- | --- |
| Needs you | an agent waiting; a review request; a failed pipeline on my merge request; a reopened ticket; a merge request of mine GitLab says can merge (`detailed_merge_status = "mergeable"`, approvals complete) | one line and one primary action each |
| My tickets | `assignee = currentUser() AND statusCategory != Done AND (sprint in openSprints() OR sprint is EMPTY)` | key, summary, status coloured by `statusCategory`, my logged time |
| Pending on me | `reviewer_id = me AND state = opened`, and `assignee_id = me` | merge request, author, pipeline, approvals `given of required` from `/approval_state` |
| Mine | `author_id = me AND state = opened` | pipeline, approvals, `detailed_merge_status`, open threads |
| Quality | the SonarQube gate on the newest release branch; Snyk high and critical | as read |

**Actions, bound to the schema.** The Jira workflow and the GitLab approval rules were not provided, so each action is defined by the API object that carries the rule, and the panel reads the rule at run time rather than assuming it. Attach the exports when they are available: `GET /rest/api/3/workflow/search?expand=transitions,statuses` (or the project's `/statuses`) and `GET /projects/:id/approval_rules` with the project's merge settings.

| Action | How it is bound to the schema | Audit evidence |
| --- | --- | --- |
| Comment | `POST /issue/{key}/comment`, ADF from plain text, the team's role visibility from `jira.commentVisibility` [SRC `jira.ts`] | the comment in the issue's activity under the user [AUDIT] |
| Transition | `GET /issue/{key}/transitions?expand=transitions.fields` lists only the moves the workflow allows from the current status, with each one's required fields and allowed values; the UI offers exactly those and refuses to submit without a required field. The moves GeminiCode suggests (start, review, done) use `jira.transitions` in `geminicode-tools.json` when the team sets the ids, else match by status name [SRC `suggestedTransition`] | the status change and its fields in the issue history [AUDIT] |
| Reassign | `GET /user/assignable/search?issueKey={key}&query=` for the candidates, then `PUT /issue/{key}/assignee` with `accountId` (`jira_assign`, Reassign… on a ticket row) | the assignee change in the history [AUDIT] |
| Log time | `POST /issue/{key}/worklog?adjustEstimate=auto` with `timeSpentSeconds` and `started` | the worklog entry [AUDIT] |
| Open merge request | `POST /projects/:id/merge_requests` with `reviewer_ids`, `remove_source_branch`, `draft`; the target offered from release branches and the ticket's fix version [SRC `teamFlowLogic.ts` `targetChoices`] | the merge request, created by the user [AUDIT] |
| Review | `POST .../approve`; `PUT .../reviewers/:id` with `state=requested_changes` on GitLab 17.2+, else unapprove and a note [SRC `gitlab.ts`] | the approval or reviewer state in the activity [AUDIT] |
| Comment on a merge request | `POST .../notes`, `POST .../discussions` with a `position` on the diff, replies, `PUT .../discussions/:id?resolved=true` | the note in the activity [AUDIT] |
| **Merge** | Read live and shown as a checklist before the button turns on: `detailed_merge_status == "mergeable"`; every rule of `GET .../approval_state` with `approved_by.length >= approvals_required`, by name; the project's `only_allow_merge_if_pipeline_succeeds` and `only_allow_merge_if_all_discussions_are_resolved`. Then `PUT .../merge` with `sha` (the head the user saw), the project's squash option and `should_remove_source_branch`. GitLab enforces the same rules, so a stale view fails with 405 or 406, never a wrong merge (`gitlab_merge`, the merge request panel) | "merged by" the user in the activity, with the `sha` [AUDIT] |

## 4. Threat model for the agent's tool permissions

**Assets.** The user's Jira and GitLab identity (API token, PAT), the Google sign-in in `~/.gemini/oauth_creds.json`, the repository and worktrees, the Figma seat, and the audit trails in Jira and GitLab.

**Actors.** The user; the agent (model output); anyone who can write to a Jira issue, a merge request's description or threads, a GitLab issue, a CI job log or a Figma file the agent reads; a repository author whose `.gemini/` folder the CLI loads in a trusted folder.

**Untrusted text reaches the model through** `jira_get_issue` (description and the last five comments, up to 12,000 characters), `jira_search`, `gitlab_get_mr` (description, open threads, diff up to 30,000 characters), `gitlab_job_log` (8,000 to 12,000 characters), `gitlab_get_issue`, `figma_design` (up to 40,000 characters), the prompts the flows build from them (`mrFixPrompt`, `reviewPrompt`, `checksFixPrompt`), and the browser's page snapshots [SRC `teamTools.ts`, `teamFlowLogic.ts`].

| Threat | Control in place [SRC] | What is left |
| --- | --- | --- |
| Injected text makes the agent write to Jira or GitLab | Write tools always reach a permission card with the exact text; only reads are answered at once. The CLI's "Allow for this session" covers all of a server's tools, so the **confirm class** (a ticket's status, a time log, a new merge request, a merge, and the same actions in a team's own `jira` and `gitlab` servers) goes through `PermissionBroker.confirmOnly`, which leaves only Allow once and Reject; `test/acp/permissions.test.ts` checks that no allow-always option reaches the webview for them [CI] | The admin policy names the team's servers' tools under the server names `jira` and `gitlab`; a team that names its servers otherwise needs its own rules |
| Injected text makes the agent run a command or read a secret | Shell commands ask in Default mode; session approvals never cover network programs, wrappers, interpreters or redirections, and task-runner approvals lapse when the agent writes a build file; file requests refuse secrets (`.env`, keys, credential files, cloud and cluster configs), git-ignored reads and paths outside the folder, following links | Reads through `grep`, `glob`, `ls` and the shell run inside the CLI and are not covered; a build file changed through the shell does not end task-runner approvals; YOLO and Auto Edit are removed only by policy. Evaluate `--sandbox` after the pilot |
| The model cannot tell tool text from the user's | Tool results that carry other people's text are wrapped in `<external source=… ref=… trust="untrusted">`, and the server's instructions say text inside it is data [SRC `teamTools.ts` `external`] | The CLI's own content-security check (`gemini_cli.conseca.verdict` in its telemetry) is not read yet [A: check what it covers] |
| Tokens readable by the model | GeminiCode's connectors keep tokens in SecretStorage, never in settings or the agent's environment. The take-over moves the team servers' tokens out of the shell environment. `gemini.tools.denyEnvironmentCommands` (on by default, lockable as `GeminiDenyEnvironmentCommands`) refuses `env`, `printenv`, and `set` or `export` alone, inside longer commands too, through the admin policy | Until the take-over, the team's settings file still passes both tokens through the environment |
| Over-privileged tokens | GitLab token scopes and expiry are checked and shown; Connections links the token page with the name and scope filled in | The Jira API token is unscoped and GitLab `api` is the whole account; use a scoped Jira token and a `GeminiCode` PAT with an expiry of 90 days or less. Server-side approval rules stay the floor |
| Supply chain of the team's servers | Images pinned by digest; the confirm class asks in every mode through the admin policy; `GeminiAllowedMcpServers` passes `--allowed-mcp-server-names`, which outranks any settings file's `mcp.allowed` | Mirroring the images to the team's registry is the team's [A] |
| Repository-supplied MCP servers, hooks and skills run in a trusted folder | Folder trust is the CLI's, and GeminiCode asks before trusting; Project Helpers list the servers and hooks; `GeminiAllowedMcpServers` can pin the servers to GeminiCode's own, which `gemini/pilot/GeminiCode-pilot.mobileconfig` does | |
| Exfiltration through the browser or `web_fetch` | Other origins ask per agent and site; `gemini.browser.allowedOrigins` (`GeminiBrowserAllowedOrigins`) can pin them, and the pilot profile pins them to the GitLab, Jira, SonarQube and `http://localhost:*` origins; the CLI's `web_fetch` refuses private hosts | |
| No record of what the agent did on the user's behalf | **Audit log:** append-only JSON lines in `<globalStorage>/audit/YYYY-MM-DD.jsonl`: time, agent, caller (`agent` or `ui`), tool, a hash of the arguments, the approved text's hash, the permission outcome and who answered, and the remote id returned (comment, worklog, note, merge request, merge `sha`). **Gemini: Open Audit Log** shows it [SRC `auditLog.ts`, `auditPage.ts`] | The join against Jira and GitLab history in the pilot [AUDIT] |
| A merge, a status change or a time log without a person | The flows need a button that names the effect; the tools are the confirm class (first row), never answered at once, never allowed for the session, with the remote effect on the card and the user's choice in the audit record | |
| Local state on a lost or shared Mac | Tokens in the keychain; transcripts, checkpoints, team snapshots and the audit log in the user's Library, the log keeping only hashes of arguments and text | Transcripts carry ticket text and diffs in clear: require FileVault through the device policy that deploys the app's profile |
| A restart during a write leaves it half done | Intent and result records; Home's Unfinished card; flows check the remote before redoing (an existing merge request before creating one) [SRC `teamFlows.ts`] | |
| A project's coordinator acting on its own | Its project tools are allowed and hidden, every other tool is refused, and merging is a button, not a tool | |

## 5. Evaluation harness

### Benchmark from closed Jira tickets

- **Selection** (`gemini/bench/select.mts`, with the user's Jira and GitLab tokens): tickets with `statusCategory = Done` in the last six months whose linked merge request merged, with a diff of 20 to 400 lines and at least one test file touched. Target 30 tasks across the repositories the pilot uses, refreshed each quarter.
- **Task record**, `gemini/bench/tasks/<KEY>.json`: `{ key, repo, baseSha, prompt, grader: { command, timeoutMs }, touchedFiles }`, where the prompt is the ticket as the agent would read it through `jira_get_issue`, and the grader is the merge request's own test command at the merge commit, run against the agent's working tree, plus the repository's lint ([bench/README.md](../bench/README.md)).
- **Runner:** **Gemini: Run Benchmark...** in the status menu, and `extensions/gemini/scripts/bench-run.mts`, share `src/acp/benchmark.ts`. Each task gets a fresh clone at `baseSha` and a session of the CLI the app runs, admin policy included, in Auto Edit with shell on and every request answered allow-once, on one model per run, with a 20-minute cap. The results go to `<GeminiCode>-<CLI>-<model>.json` in `results/` beside the tasks folder.
- **Metrics per task and per release:** completion (the grader passes), tokens (`_meta.quota.token_count` per turn), time to the first token and to completion, permission cards, and Undo actions.
- **When and where:** hosted runners cannot sign in to Code Assist, and the project owns no always-on machine, so the benchmark runs on a developer's Mac, from the release build, under their own seat, on release day. The release workflow opens an issue titled `Benchmark <version>` for each release that is not a prerelease, and the docs site's **Benchmark** page (`gemini/site/bench.mts`) is built from the results files. Quota: 30 tasks × two models × about 15 requests each is about 900 requests, under the 2,000 per user per day [LIC pending: confirm the seat's edition, and that benchmark use is allowed].
- **Open:** no task is selected or run yet; the task set needs the team's Jira and GitLab, and the first run needs a seat. Holding a release's announcement until its results file merges is a repository setting.

### Checks on any branch, before the merge request

- **Run Checks on a Branch...** (a Home quick action and a command) lists the branch checked out here, agents' branches, local branches and the remote's, and runs the checks on a checkout of the chosen one. A branch not checked out anywhere gets a worktree under `~/.geminicode/worktrees/<repository>/checks/`, the repository's `gemini.agents.worktreeSetup` runs in it once, and later runs reuse it; the user's own checkout never moves [SRC `checksBranch.ts`, `test/acp/checksBranch.test.ts`].
- Snyk scans dependencies and code there. SonarQube's gate and new-code issues come from the server's last analysis of the branch, which needs a push; with the SonarQube server running locally, the changed files are also analysed on the Mac before any push (section 3).
- **Fix** sends the findings to the agent working on the branch, or starts one in that checkout with them as its first prompt.
- Evidence that it matters: the share of merge requests whose first pipeline fails a quality job, before and after the pilot [PILOT].

### Gates on this repository

- **Snyk:** the `Snyk on the fork's code` job in `gemini-ci.yml` runs `snyk test --severity-threshold=high` and `snyk code test` on `extensions/gemini` and `gemini/site`. Without a `SNYK_TOKEN` secret it says so and passes, so adding the secret turns it into a gate.
- **SonarQube:** `sonar-scanner` on `extensions/gemini` with the new-code gate needs the server, which is behind the VPN where GitHub's runners cannot reach it. It belongs in the team's GitLab CI on a mirror of this repository, posting its result to the GitHub commit [A: depends on the team's GitLab CI]. Until then, **Gemini: Run Checks** on this repository from a developer's Mac is the gate, recorded in the release pull request.
- **The docs site:** `gemini/site/check-a11y.mts` runs axe-core on every built page and fails on any violation; `check-lighthouse.mts` serves the site gzipped, as Pages does, and fails under accessibility 100, performance 90, best practices 90 or SEO 90. Both run in `gemini-ci.yml` on a sample build and in `gemini-pages.yml` before anything is uploaded.

## 6. Decisions, non-goals and the pilot

### Decisions

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-fork-not-extension.md) | Fork VS Code as a branded app; do not ship as an extension |
| [0002](adr/0002-official-cli-over-acp.md) | The official Gemini CLI over ACP is the only agent; never patch the CLI |
| [0003](adr/0003-patch-series-over-pinned-tag.md) | Upstream edits are a patch series over a pinned release tag, with a job that moves the tag and the CLI pin together |
| [0004](adr/0004-one-tool-adapter.md) | One local adapter serves the agent and the UI; the tools' own servers run as its children |
| [0005](adr/0005-user-tokens-only.md) | Every action runs with the user's own tokens from the keychain; no service accounts in the IDE |
| [0006](adr/0006-confirm-class.md) | Merge, status change, time log and merge request creation are a confirm class that is never approved automatically |
| [0007](adr/0007-telemetry-and-audit.md) | Telemetry is the CLI's own export to a local file, opt-in, without prompts; the audit log is append-only and joined to Jira and GitLab by remote ids |
| [0008](adr/0008-storage-compatibility.md) | Settings keys, policy names and storage formats are a versioned contract |
| [0009](adr/0009-desktop-only.md) | Desktop only: no server; all state on the Mac; every flow resumable from disk; a restart never answers for the user |

### Non-goals

- Windows, Intel Mac and Linux builds before the pilot ends.
- In-app auto-update, which needs an update server.
- Sandboxing the agent by default: `--sandbox` needs a container runtime on every Mac.
- Reimplementing any part of the agent, sign-in or licensing outside the CLI.
- Anything that depends on Rovo or Duo, including their MCP servers and Duo code review.
- Jira Server or Data Center; only Jira Cloud's REST v3.
- A relay, hosted agent, always-on runner or any server owned by this project.
- Writing back to Figma.
- Replacing GitLab CI, SonarQube or Snyk's own scanning with the agent's.
- Fine-tuning a model or tuning prompts for the benchmark.

### Pilot: three developers, two weeks

- **Who:** three developers on repositories with an open Jira sprint, merge requests flowing in GitLab, a SonarQube project and Snyk, so every card on Home has data, on a signed and notarised release build so no one has to approve the app by hand. `gemini/pilot/GeminiCode-pilot.mobileconfig` sets the pilot's admin policy ([pilot/README.md](../pilot/README.md)).
- **Baseline, the week before:** the same measures with the tools they use today.
- **Measures, from the tools' own records rather than self-report:**
  - **Time to the first merge request per ticket:** from the Jira changelog entry that moved the ticket into its first `indeterminate` status (`GET /issue/{key}/changelog`) to the merge request's `created_at` with the ticket key in its branch or title, against the previous sprint [AUDIT].
  - **Context switches per hour:** application activations away from and back to GeminiCode while a ticket is in progress, from a small opt-in macOS script (`NSWorkspace.didActivateApplicationNotification` to a local CSV), and inside the app, team links opened (leaving for Jira or GitLab) against panel actions that did the same in place [PILOT].
  - **Restart cost:** launches per day and, for each, the time from launch to the first accepted prompt and whether anything was listed under Unfinished.
  - **Secondary:** requests per day from the usage meter, permission cards per turn, Undo and Rewind per turn, first prompts that waited for their agent, and team tool errors by kind (VPN off, 401, 429).
- **Recording:** with `gemini.pilot.record` on (off by default), GeminiCode counts launches, each prompt's wait for its agent, each turn's permission cards, length and first text, Undo of a change, file or turn, Rewind, what Home listed as unfinished after a launch, team tool errors by kind, team links opened, page and agent writes, and each quota reading, in a file per day in its storage: counts and times only, no prompt, reply, file or ticket text. **Gemini: Export Pilot Data** writes them with the audit log to `~/geminicode-pilot/`, with a line per launch giving its time to the first prompt and what was unfinished. Nothing leaves the Mac on its own; developers hand the folder over at the end [SRC `pilotLog.ts`, `pilot.ts`].
- **Exit criteria:** median time to the first merge request down by a quarter against the baseline, with no rise in reopened tickets; context switches per hour down by a third; no confirm-class action in the audit log without a matching permission outcome; no Jira or GitLab write without a matching entry in the tool's own history.

## 7. Ambitious additions

Only once sections 1 to 6 hold. Each names the evidence that motivates it.

1. **A resident CLI process per user, bounded by the desktop.** The agent process lives per window and ends with the extension host on a reload, costing 2.9 s to `initialize` and 280 MB per window [M-01]. One `gemini --acp` per user as a launchd agent, reached over a local socket, would turn every window's first prompt into a `session/new` or `session/load` and survive window reloads and app quits, though never a reboot or a log-out. Waits on T-11 showing reloads and several windows are common enough to matter. Metric: cold starts per developer per day; memory per window.
2. **Cache-hit accounting on every turn.** Show the cached share of input tokens in the usage ring, from `cached_content_token_count`, and take the numbers upstream if Code Assist's caching misses the CLI's stable prefix. Motivated by 11,882 input tokens per call and 43,174 per coordinator turn [M-01, M-06]. Metric: the cached share; requests per ticket.
3. **Review in GitLab CI without Duo.** The Review flow's `reviewPrompt`, run headless (`gemini -p --output-format json --approval-mode plan`) in the merge request's pipeline on the team's runners, posting draft comments a person must publish. It needs a Code Assist seat on a runner, which is a service account and goes against ADR 0005, so it is listed to make the decision explicit; it also needs evidence from reviewers that they want it. Metric: review turnaround; findings reviewers accept.
4. **Plan on assignment.** When a ticket is assigned to the user and enters the sprint, start an agent in Plan mode on its own branch and hold the plan for approval; the ticket does not move until the user clicks. Motivated by Start Agent on a ticket and the pilot's time to the first merge request. Metric: that time; plans discarded.

## Where the evidence stands

| Claim | Evidence in hand | Still needed |
| --- | --- | --- |
| A named Flash default saves Auto's routing call on every prompt | M-01 (3.5 s against 8.1 s), M-02 | T-12 from a working session |
| The spare session hides `session/new` | M-01 (0.8 s per session), SRC | The pilot's first-prompt wait counter |
| Token volume per request | M-01, M-06; Record Performance Trace reads the cached tokens per call | The cached share from a real session (T-12) |
| One CLI process holds a project | M-07 | |
| A Flash coordinator keeps to its role | M-06 | Pilot use |
| Audit log | `auditLog.ts`, intent and result records for every agent and page write, Open Audit Log | The pilot's join against Jira and GitLab history |
| Fork confinement | The diff by area; 74 patches over 1.142.0 and their CI check | |
| The CLI that ships is the one tested | `bundledCli` checksum; the real-CLI tests pass against 0.64.0 | |
| Official Jira and GitLab servers are unusable | The vendors' pages | The admins' confirmation on both tenants |
| My work panel, merge and reassign | `homeDashboard.ts`, `mrPanel.ts`, `gitlab_merge`, `jira_assign`, tests against fake servers | AUDIT entries from the pilot |
| The confirm class is never approved automatically | `PermissionBroker.confirmOnly`, `teamConfirmTools`, `permissions.test.ts`, `realAgentPolicy.test.ts` | Pilot audit records with an outcome on every confirm-class action |
| The team's servers as children | `teamContainers.ts`, `mcpStdio.ts`, `teamContainers.test.ts` against a scripted server | A run against the real images and a live SonarQube and Snyk |
| Quota headroom for the benchmark | The public quota page | The license |
| Benchmark | `select.mts`, the runner, Run Benchmark, the release-day issue, the Benchmark page | A task set from the team's Jira and GitLab, then the first results file |
| Site gates | `check-a11y.mts` and `check-lighthouse.mts` in both workflows | |
| Snyk gate | The job in `gemini-ci.yml` | The `SNYK_TOKEN` secret |
