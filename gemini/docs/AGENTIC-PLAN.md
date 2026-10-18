# Agentic development plan

A working plan for bringing agentic development into GeminiCode (this fork of VS Code with the Gemini CLI embedded, Gemini Code Assist enterprise licensing and Google Cloud project-ID billing), for a team on Jira, GitLab, Figma, Snyk and SonarQube with Atlassian Rovo and GitLab Duo turned off.

Every recommendation names the evidence that confirms it, with one of these tags. An item with no evidence is tagged **[A]** and is an assumption until the named check is done.

| Tag | What counts |
| --- | --- |
| **[T]** | A trace number from this document's trace log, or from the three session traces once they are in |
| **[CI]** | A named CI job that is green on the commit |
| **[AUDIT]** | An action visible in Jira's issue history or GitLab's merge request activity |
| **[BENCH]** | A score from the benchmark set in section 5 |
| **[PILOT]** | Pilot telemetry from section 6 |
| **[LIC]** | A clause of the Gemini Code Assist license or the published quota page |
| **[SRC]** | Code or a measurement in this repository, by file |
| **[A]** | Assumption. The check that would turn it into evidence is named |

## Removed on 18 Oct 2026

**Merge Release Branch Forward** (the Home card, quick action, command and flow) was removed from the code at your request; it was not working for the team. Open Merge Request still offers release branches first, and Quality still reads the newest release branch.

## 0. Inputs: what was inspected and what is still missing

| Input | State | Where |
| --- | --- | --- |
| Fork repo and `git diff --stat` against the tracked upstream tag | **Inspected.** The fork tracks `1.141.0` (merged 8 Oct 2026, commit `df56848b`). `git diff --stat 1.141.0 HEAD`: 727 files, +74,458 / −205. By area: `extensions/gemini` 528 files (+65,300), `gemini/` 96 files (+4,335), `src/vs/workbench` 44 files (+3,604 / −30), `src/vs/platform` 8 files, `product.json`, `build/` 12 files, `resources/` 30 icons, `eslint.config.js`, three top-level Markdown files. | `gemini/scripts/list-fork-touches.sh 1.141.0` |
| Gemini CLI version, changelog, surface | **Inspected and verified against the bits.** `extensions/gemini/package.json` pins `@google/gemini-cli@0.64.0` with an npm SHA-512; the tarball downloaded from npm on 18 Oct 2026 matches that checksum. `npm view` says 0.64.0 is also the newest release. The v0.64.0 release (13 Oct 2026) lists: ACP usage data and `usage_update` notifications, sessions resolved by exact id and cleaned up on failure, folder trust propagated in headless mode, append-only delta patching of chat records. `gemini --help` from that bundle: `--acp`, `-p/--prompt` headless, `-o/--output-format text\|json\|stream-json`, `--resume`, `--session-id`, `--list-sessions`, `--approval-mode default\|auto_edit\|yolo\|plan`, `--policy`, `--admin-policy`, `--sandbox`, `--allowed-mcp-server-names`, `--include-directories`. The bundle carries ACP dispatchers for `session/new`, `load`, `list`, `close`, `fork`, `resume`, `set_model`, `set_mode`, `set_config_option`, `cancel`; MCP transports `command` (stdio), `sse` and `url`/HTTP; telemetry switches `GEMINI_TELEMETRY_ENABLED`, `_TARGET`, `_OTLP_ENDPOINT`, `_OTLP_PROTOCOL`, `_OUTFILE`, `_LOG_PROMPTS`, `_TRACES_ENABLED`. | scratchpad download; `FINDINGS.md` |
| Three performance traces (Chromium profile, extension-host CPU profile, CLI OpenTelemetry export) | **Not provided.** In their place: the measurements in `FINDINGS.md` (2 to 15 Oct 2026, CLI 0.62 to 0.64) and a trace I took on this machine on 18 Oct 2026 against the pinned 0.64.0 (trace log below). Both use a local stand-in for the Gemini API, so they measure everything except the model and the Code Assist auth call. Section 1 says exactly which rows of the budget the real traces must fill. | `extensions/gemini/scripts/perf-first-reply.mts` |
| Jira workflow schema, GitLab approval rules and CI config | **Not provided and not in the repo** (no `.gitlab-ci.yml`, no `.gemini/geminicode-tools.json`). Section 3 is written against the Jira and GitLab objects that carry the schema (`/transitions?expand=transitions.fields`, `/approval_state`, `/approval_rules`) and names the export to attach. | |
| Rate limits and OAuth scopes for the five tools | **Partly.** Vendor documentation hosts are unreachable from this environment; the figures in section 3 come from web search and are tagged for verification. | |
| Gemini Code Assist enterprise license and quota terms | **Not provided.** The public quota page (via search) says Enterprise agent mode and Gemini CLI: 2,000 requests per user per day, 120 per minute, aggregated across models; the license text itself was not available. | [LIC] pending |
| Desktop only, no cloud infrastructure | **Taken as a hard constraint.** GeminiCode is a Mac app. When the app quits or the laptop restarts, every process (the extension host, the `gemini --acp` sidecar, the local MCP servers, the Snyk and SonarQube children) is gone and comes back only when a window opens. There is no relay, no server, no always-on runner owned by this project. Section 1 has the restart model: what survives on disk, what is lost, and what every flow must do about it. Sections 5 and 6 use only the team's existing CI (GitHub Actions for this repository, the team's GitLab CI) and developers' Macs. |
| Rovo and Duo disabled | **Taken as a hard constraint.** Consequence in section 3: the Atlassian Remote MCP Server and the GitLab MCP server are both gated on those products, so there is no usable official MCP server for Jira or GitLab. | |

### Mockups

Eight screens of the IDE as the plan describes it, drawn in the GeminiCode Dark look, are on a design canvas: <https://claude.ai/artifact/AhrcijLGwyyuG5kQJvQWUS> (private until shared from its Share menu). Each is tied to a section:

| Screen | Section | What it shows |
| --- | --- | --- |
| Home: my work | 3 | Needs you with the ready-to-merge row, My tickets, Pending on me, Mine, Quality, Gemini; every card named by the query that fills it; the row menu with Start Agent, Move, Log Time, Reassign |
| Merge request panel | 3 | The merge checklist read live from GitLab (pipeline, approval rules by name, approvals valid after push, threads resolved, mergeable, author rule), the exact request it will make, and a Merge button that stays off until every line is green |
| Confirm-class card | 4 | A `jira_transition` card with the transition id, the required Fix version and the comment, offering only Allow once and Reject; a queued `jira_log_time` card; the read rows that ran with no card |
| Audit log | 4 | One row per write with caller, effect, who answered, the remote id, and an intent without a result highlighted |
| After a restart | 1 | Home's Unfinished card (a pushed branch with no MR, a review with unposted comments, a move whose comment did not post, an interrupted turn), the chat's interrupted-turn notice with Retry and Undo, and the cold-start rows |
| Connections | 3, 4 | The five tools with their logos, which of them run as the team's MCP containers, where each token lives, the measured tool-schema cost per turn, and the take-over offer |
| Checks on a branch | 5 | The branch picker (checked out here, agents', local, on origin), the checks on a checkout of their own, and Fix starting an agent there |
| Latency readout | 1 | Where this turn's time went, hop by hop against the budget, and the status menu's Record Performance Trace, Open Audit Log and Run Benchmark commands |

### Trace log

| Trace | Taken | Setup | Result |
| --- | --- | --- | --- |
| **T-01** | 18 Oct 2026, this container, 4 cores, 16 GB | gemini-cli 0.64.0, `perf-first-reply.mts`, empty untrusted folder, API-key auth, stand-in API 300 ms per model call, median of 3 | initialize 1184 ms · `session/new` 42 ms · spare `session/new` 33 ms · first text on Auto 694 ms · first text with Flash picked 311 ms |
| **T-02** | same | same, but `--repo` this repository, trusted | initialize 1207 ms · `session/new` 66 ms · spare 59 ms · first text on Auto 679 ms · Flash picked 310 ms |
| **T-03** | same | `vitest run test/perf/budgets.test.ts` | 7 passed, 9 skipped (bundles not built here). "Enter to send" p5 < 30 ms budget held |
| **F-01..F-12** | 2 to 15 Oct 2026, see `FINDINGS.md` | CLI 0.62 to 0.64, 4-core Linux, stand-in API or a real Code Assist account where stated | Cited by section below |
| **T-10, T-11, T-12** | **Pending: your three real sessions** | Chromium profile, extension-host CPU profile (`code --inspect-extensions`), CLI OTel export (`GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local GEMINI_TELEMETRY_OUTFILE=…`, `GEMINI_TELEMETRY_LOG_PROMPTS=false`) | Fill the budget's "real" column |

## 1. Latency budget

### The hops

```
UI (chat webview) ─postMessage─▶ extension host (ChatController → AgentClient → AgentRuntime)
   ─stdio JSON-RPC─▶ gemini --acp (session) ─▶ Code Assist auth refresh ─▶ model (routing call, main call)
   ─▶ tool calls (permission card ⇄ user; fs/* via IDE; shell inside CLI) ─▶ session/update ─▶ render
```

### Budget table

Values are p50 unless marked. "Stand-in" means the model answered in 300 ms, so the hop's own cost is the value minus 300 ms where a model call is involved. The **real** column is what T-10 to T-12 must provide.

| Hop | Stand-in p50 (evidence) | Real p50 / p95 | Owner |
| --- | --- | --- | --- |
| UI → extension host, Enter to `session/prompt` sent | < 30 ms budget, held [T-03]; webview batching adds up to 33 ms per update (30 Hz) [SRC `chatController.ts`] | fill from Chromium profile (T-10) | fork |
| Extension host → CLI process, start | 1,207 ms to `initialize` [T-02]; 1,512 ms on 14 Oct with 0.63 [F]; hidden from the user by `AgentWarmup` 3 s after the window opens when a sign-in is saved [SRC `agentWarmup.ts`] | fill: how often a user's first prompt still waits for it (T-11) | fork |
| Cold start after an app quit or a reboot | window restore (upstream's startup, not measured here) + extension activation (about 130 ms bundle load [F]) + the 3 s `AgentWarmup` delay + 1,207 ms to `initialize` [T-02] + `session/load` of the tab in front, replayed from the CLI's chat file, deferred for other tabs [SRC `agentsView.ts` `openLater`]; Home shows the last team snapshot at once and refreshes behind it [SRC `teamData.ts`] | **fill from T-11 taken on a launch after a reboot: time from app icon to the first prompt accepted** | fork |
| `session/new` | 66 ms with an API key [T-02]; 25 to 41 ms per extra session [F]; **with Google sign-in it also runs the Code Assist auth refresh and starts the session's MCP servers, which `FINDINGS.md` attributes "a start of several seconds" to** | **fill from OTel `gemini_cli.startup.duration` and the first `gemini_cli.api_request` of the session (T-12)** | CLI, hidden by the fork's spare session |
| Auth | Not measurable with a stand-in. The CLI refreshes the OAuth token at `session/new`; direct requests refresh in memory [SRC `directRequest.ts`] | fill (T-12) | CLI |
| Model, first token, Auto | 694 ms = routing call to Flash-Lite (300 ms + overhead) + main call; a 500 ms delay on the routing call delayed the first chunk by exactly 500 ms [F] | fill from `gemini_cli.model_routing.latency` and `gemini_cli.api.request.latency` (T-12) | CLI, avoided by picking a model |
| Model, first token, Flash picked | 310 ms, so the CLI adds about 10 to 15 ms around the model call [T-02][F] | fill (T-12) | model |
| Tool calls | Permission card round trip is user time; `fs/read_text_file` through the IDE; `git check-ignore` cached 30 s [SRC `fileAccess.ts`, `gitIgnore.ts`]. Streaming 10 sessions at once adds ≤ 7 ms per chunk at p95 [F] | fill from `gemini_cli.tool.call.latency` (T-12) and the extension-host profile (T-11) | fork and CLI |
| Render | 2 ms per update re-rendering only the unfinished tail; 25 ms when the whole reply was re-rendered (fixed) [F] | fill (T-10) | fork |
| Whole turn, Enhance prompt through the CLI | p50 12.3 s / p95 16.5 s on Flash, 5.0 / 9.4 s on Flash-Lite; as a direct request 3.4 / 4.8 s [F-real account, 5 Oct] | this is the only real p50/p95 pair on file | model |
| Whole turn, coordinator | median 9.4 s, all model time, 28,807 input tokens per turn [F-real account, 14 Oct] | | model |

### Top three contributors and the fix for each

1. **Model time, inflated by the Auto routing call and thinking level HIGH.** Every prompt on Auto first makes a non-streaming Flash-Lite call before the real one, and the main request runs at thinking HIGH even on Flash [F]. The fork already defaults new agents to a named Flash model [SRC `agentClient.ts` `defaultModel`], which is why T-02 shows 679 ms against 310 ms. What is left: lower the routing call's thinking for users who do pick Auto, which only an admin-owned `modelConfigs.customOverrides` for the concrete `gemini-3.5-flash-lite` can do [F]. Expected saving: one model call per prompt on Auto, 370 ms with the stand-in and the real Flash-Lite latency from T-12 in production; zero for the default path. Evidence that it worked: `gemini_cli.model_routing.latency` absent or halved in T-12 after the override.
2. **Session cost with a Google sign-in: auth refresh plus MCP server start on every `session/new`.** With an API key the session is 66 ms; with a Google sign-in `FINDINGS.md` attributes the seconds-long start to the auth call and MCP servers, both outside the stand-in. The fork hides this behind one spare session per folder and per server set [SRC `agentRuntime.ts` `prepareSession`]. Fix: keep the spare but make it fit more cases. Today a project's coordinator and threads never take one because their server set differs, and the team tools server adds one more variant of the key [SRC `teamConnections.ts` `spareServers`]. Make the key the folder only and bind servers after the fact through the existing slot mechanism (`TeamToolsMcpServer.configForSlot`, `bind`), which already exists for this purpose. Expected saving: the whole `session/new` off the first prompt of every new agent, thread and review. Evidence: T-12's per-session `startup` span compared before and after; the "first prompt waited for session" counter from the pilot [PILOT].
3. **Input tokens per turn.** The CLI resends its 32,500-character system prompt and every tool declaration on each turn; a coordinator turn reads 28,807 tokens for 58 out [F]. Time to first token grows with input, and quota is per request, not per token [LIC pending]. Three fixes, all on the fork's side: (a) keep the team tools server listing only connected tools (already so) and trim the SonarQube and Snyk tool sets when the official servers come in (section 3), since each tool schema is paid for on every turn; (b) read `cached_content_token_count` from the OTel `gemini_cli.api_response` event and `gemini_cli.token.usage{type="cache"}` to see whether Code Assist's implicit caching is hitting at all for the CLI's prefix; (c) if cache hits are low, nothing in the fork can reorder the CLI's prefix (design rule 8: never patch the CLI), so the item becomes an upstream request with the trace attached. Expected saving: unknown until T-12; the measurement itself is the deliverable here.

Two smaller, already-fixed contributors stay in the budget as regressions to watch: the CLI's own relaunch to raise its heap (0.65 s, avoided with `GEMINI_CLI_NO_RELAUNCH`) [F] and whole-reply re-rendering (25 ms per update, now 2 ms) [F]. Loading zod and the ACP SDK lazily would take about 60 ms off the 130 ms extension bundle load [F]; worth doing, not a top three.

**"Think out of the box" is held back** until T-10 to T-12 show the three fixes above exhausted. The candidate is in section 7 (a per-user resident CLI daemon that survives window reloads).

### Restart model: what a quit or a reboot costs, and what survives

The app has no server, so the question for every piece of state is where it lives and what the user sees when a window opens again. This table is from the code as of 18 Oct 2026.

| State | Lives in | Survives a quit or reboot | What the user sees after | Change |
| --- | --- | --- | --- | --- |
| Agent list, workspaces, project and thread records | global state | yes | the same list and cards [SRC `agents.ts`] | none |
| Each agent's conversation | one JSON per agent in global storage, plus the CLI's own chat file under `~/.gemini/tmp/<project>/chats/` | yes | shown at once; the CLI session resumes with `session/load` by id (0.63+) [SRC `cliSessions.ts`] | none |
| Undo and Rewind checkpoints | `<globalStorage>/checkpoints/<agent>.json`, written when a turn ends | yes, up to the last finished turn | Undo works for finished turns | a turn that was running when the app quit is lost; say so in the chat (today only Projects' docs note it) |
| A turn that was running | the sidecar process | **no** | the reply stops mid-way; the CLI's chat file keeps what was streamed | done 18 Oct 2026: the chat says the agent was cut off and that the message can be sent again (`wasCutOff` in `chatController.ts`) |
| Pending permission cards | memory | **no**: cancelled | the card is gone; the turn ended | correct as is: a restart must never auto-answer |
| "Allow for this session" shell approvals | memory [SRC `sessionApprovals.ts`] | **no** | the next command asks again | correct as is |
| Google sign-in | `~/.gemini/oauth_creds.json` | yes | `AgentWarmup` starts the agent 3 s after the window opens | measure the 3 s against T-11 and shorten it on a restored window |
| Team tool tokens and accounts | macOS keychain (SecretStorage) and global state | yes | Connections shows the last state as stale, then re-checks | none |
| Home's team data | global state snapshot [SRC `teamData.ts`] | yes | cards at once, dimmed until refreshed | none |
| Worktrees and branches | `~/.geminicode/worktrees/` and the repository | yes | restored or recreated from the branch [SRC `restoreWorktree`] | none |
| Folder trust | `~/.gemini/trustedFolders.json` | yes | | none |
| The spare session, the slot bindings, the Snyk and SonarQube child servers | memory and child processes | **no** | the first new agent pays `session/new`; the adapter restarts its children on first use | restart children lazily, not at activation |
| A flow tab (Open Merge Request, Move Ticket, Review) | a webview panel with its fields in memory [SRC `teamFlowPanel.ts`] | **no** | the tab is gone, typed text with it | done 18 Oct 2026: each flow keeps a record in `<globalStorage>/flows/` while open (`flowRecords.ts`), Home's Unfinished card offers Reopen from the same inputs and Discard; typed text is still lost, and reopening at the exact step is a later refinement |
| Last check results per agent | `checkResults`, memory | no | Open Merge Request no longer offers the checks attachment | keep in the agent's record |
| A write that was in flight (branch pushed, MR not yet created; transition done, comment not yet posted) | nothing | **no** | possible double action on retry | done 18 Oct 2026: the audit log records the intent before the call and the result after; Home's Unfinished card lists intents without a result with Open Audit Log and Mark as Checked, and nothing is redone on its own |
| The audit log (section 4) | append-only JSONL on disk | yes | | new |

Two rules follow from the table and go into ADR 0009: **every flow that spans a model turn or a remote write is resumable from a record on disk**, and **a restart never answers a question the user did not answer**. Mid-turn loss is accepted; silent completion is not.

### What the traces must be taken with

- CLI: **Gemini: Record or Stop Performance Trace** (shipped 18 Oct 2026) sets `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OUTFILE=~/geminicode-trace-<date>.jsonl`, `GEMINI_TELEMETRY_LOG_PROMPTS=false` and `GEMINI_TELEMETRY_TRACES_ENABLED=true` for one agent process and renders the summary on Stop. Checked against a file 0.64.0 wrote: the records are `gemini_cli.api_response` (model, `duration_ms`, `input_token_count`, `cached_content_token_count`, `output_token_count`, `thoughts_token_count`, `role` main or `utility_router`), `gemini_cli.model_routing` (`routing_latency_ms`, `decision_model`), `gemini_cli.tool_call` and `gemini_cli.startup_stats` (phases with `duration_ms`). With prompts off the file still carries the CLI's system prompt and tool declarations as span attributes, and no prompt or reply text.
- Extension host: start with `--inspect-extensions=9333` and record a CPU profile over one turn; or **Developer: Start Extension Host Profile**.
- Chromium: **Developer: Toggle Developer Tools → Performance**, record from Enter to the end of the reply.

## 2. Fork hygiene

### Where the fork stands

- Custom code is already confined: 65,300 of the 74,458 added lines are in `extensions/gemini`, and `src/acp` never imports `vscode` (ESLint rule) [SRC]. The workbench part is 24 fork-only files under `src/vs/workbench/contrib/gemini/` plus `geminiTabRows.ts`, and three fork-only files under `src/vs/platform/`.
- Upstream files **modified** (the ones that conflict on an upstream move): 20 under `src/vs/workbench` (`layout.ts`, `editorPart.ts`, `editorTitleControl.ts`, `paneCompositeBar.ts`, `viewsExtensionPoint.ts`, `workbench.desktop.main.ts`, theme services, `commandsQuickAccess.ts`, `webviewEditorInput.ts`, `gettingStartedContent.ts`, `desktop.contribution.ts`, `extensionEnablementService.ts` and its test, `chatSetupContributions.ts`, `browserEditorChatFeatures.ts`, four letterpress SVGs, the code icon), 5 under `src/vs/platform` (`windowImpl.ts`, `windows.ts`, `menubar.ts`, `dialog.ts`, `browserViewMainService.ts`), `product.json`, 12 build files, `eslint.config.js`, 28 icon resources. Each code edit carries a `GEMINI-FORK` marker [SRC `list-fork-touches.sh`].
- Upstream is merged, not rebased (`git merge 1.141.0`), on purpose, so every merge is three-way [SRC `gemini/README.md`]. Upstream tags: 1.141.0 on 6 Oct 2026, 1.142.0 on 14 Oct 2026 (fetched). The fork is one release behind.
- CI: `gemini-ci.yml` lints and hygiene-checks fork files, builds the extension and webview, runs the unit tests and the real-CLI tests against the npm `latest` and `preview` CLI, and compiles the whole fork when upstream files change [SRC]. There is no job that moves the upstream base or the CLI pin.

### Design: patches over a pinned tag

1. **Pin.** `gemini/upstream.json` holds `{ "tag": "1.141.0" }`. `main` is that tag plus the fork's commits. The history stays merge-based (no history rewrite for existing team members), but the **set of upstream edits** becomes a patch series: `gemini/patches/NNNN-<area>.patch`, generated with `git format-patch` from the fork's commits that touch files outside the fork-owned paths. The series today would be about 35 patches (one per modified upstream file or coherent group). Fork-only added files (`contrib/gemini/`, `extensions/gemini/`, `gemini/`) are not patches: they apply to any base.
2. **Rule of confinement, enforced.** `build/hygiene.ts` already runs on fork files; add a hygiene check that fails when a file outside the fork-owned paths changes without a `GEMINI-FORK` marker, and when `gemini/patches/` is stale against `git diff <tag> HEAD -- <non-fork paths>`. Evidence: [CI] the `Hygiene (fork files)` step.
3. **The monthly job, `gemini-upstream.yml`.** Runs on a schedule (daily is fine; it is a no-op when nothing moved) and by hand:
   - Fetch upstream tags. The newest `1.N.0` above the pin is the candidate (release tags are what upstream stabilises; `1.141.1`, `1.141.2` are patch releases and are taken too).
   - Check out the candidate tag, `git am -3 gemini/patches/*.patch`, then copy the fork-only paths from `main`. A conflict fails the job with the conflicting patch names and the `list-fork-touches.sh` checklist in the job summary, and opens a draft PR for a person.
   - `npm run bundle-cli` is not needed here; run the same steps as `gemini-ci.yml` plus the full compile and `npm run hygiene`.
   - Check the Agents window: `grep` for an extension-facing provider API in `src/vs/sessions/SESSIONS.md` (today providers register in core through `ISessionsProvidersService`; no extension API) and add a line to the PR when that changes [SRC `ROADMAP.md`].
   - Bump the CLI pin in the same PR: `npm view @google/gemini-cli version` and `dist.integrity`, write `bundledCli` in `extensions/gemini/package.json`, raise `MIN_CLI_VERSION` only by a separate human decision. Run the real-CLI tests (`realAgent*.test.ts`, 6 files) against that exact version, not `latest`, so the PR tests the bits it pins. Add a signed-in smoke run on the self-hosted runner from section 5 (hosted CI cannot sign in [SRC `ROADMAP.md`]).
   - The PR title is `Upstream 1.N.0 + Gemini CLI x.y.z`. Branch protection on `main` requires **Gemini CI / Gemini extension (latest)**, **Gemini CI / Gemini extension (preview)**, **Gemini CI / Compile & hygiene** and **Gemini Upstream / rebase-and-pin** to be green. "Both green to merge" is then a repository setting, not a convention. Evidence: [CI] the four required checks on the merged PR.
4. **Re-check list that the job prints** (from `FINDINGS.md`): error strings in `test/fixtures/agentErrors.json`, the model list shape (`realAgentModels.test.ts`), `session/load` replay count (`realAgentSessions.test.ts`), the admin policy (`realAgentPolicy.test.ts`), the `[MODE_UPDATE]` text, the `write_file` ENOENT bug (0.62 to 0.64). A changed CLI that moves any of these fails a test rather than a user.

### Dry run against 1.142.0

Done on 18 Oct 2026 with the series as committed: a checkout of upstream `1.142.0`, `FROM=main gemini/scripts/upstream-series.sh apply 1.142.0`.

| Result | Count |
| --- | --- |
| Patches applied cleanly | 72 of 74 |
| Patches with conflicts to finish by hand | 2 (`build/lib/preLaunch.ts`, `src/vs/platform/dialogs/electron-browser/dialog.ts`) |
| Fork-only files copied over | 750 |

So one month's upstream move is two small conflicts, both in files the fork edits at one point each. That is the shape the upstream job's pull request will have; the full compile and the extension tests on that pull request are the rest of the evidence [CI].

### Backward compatibility

The settings keys (`gemini.*`), policy names, `chatProtocolVersion`, the transcript file format, agent records in global state and `.gemini/geminicode-tools.json` are the contract with existing users. Any rewrite in sections 3 and 4 keeps them, and the migration is a read of the old key with a write of the new one, tested in `test/acp`.

## 3. One integration layer for the agent and the UI

### Which MCP servers are usable

| Tool | Official MCP server | Usable here | Decision |
| --- | --- | --- | --- |
| Jira Cloud | Official: the Atlassian Remote MCP Server (`mcp.atlassian.com`), which is the **Rovo** MCP server; OAuth 2.1 | **No**: Rovo is disabled. [A: confirm with the Atlassian admin] | **In use today:** the community `ghcr.io/sooperset/mcp-atlassian` container (Jira over REST with the user's email and API token) in the team's `.gemini/settings.json` (see below). Keep it as the agent's Jira server behind the adapter; the fork's `jira.ts` stays for the UI until the adapter can call the container |
| GitLab (self-managed) | Official: the GitLab MCP server (`<instance>/api/v4/mcp`), Premium/Ultimate, Beta, requires **GitLab Duo** | **No**: Duo is disabled. [A: confirm `/api/v4/mcp` is refused on the instance] | **In use today:** the community `zereight050/gitlab-mcp` container (REST v4 with a PAT) in the same settings file. Same treatment as Jira |
| Figma | Dev Mode MCP server in the desktop app, `http://127.0.0.1:3845/mcp`, Dev or Full seat on Professional, Organization or Enterprise; remote server `mcp.figma.com` | **Yes**, already used [SRC `figma.ts`] | Keep. Comments are not a tool of the Dev Mode server [A: verify on the current beta]; read them through the REST API `GET /v1/files/:key/comments` with a `file_comments:read` scoped token when the review flow needs them |
| Snyk | `snyk mcp -t stdio`, shipped in the Snyk CLI, uses the CLI's sign-in; no hosted server | **Yes** | Replace `snyk.ts`'s `execFile` of `snyk test` with the official stdio server, started by the adapter |
| SonarQube Server | `sonarsource/sonarqube-mcp` (container) or jar, Java 21+, stdio or Streamable HTTP, `SONARQUBE_TOKEN` (user token), `SONARQUBE_URL`; needs SonarQube Server 2025.1+ | **Yes if the server is 2025.1 or later** [A: check `GET /api/system/status` on your instance] | Run it as a stdio child of the adapter with only the `issues`, `quality gates`, `security hotspots`, `projects and branches` toolsets on; keep `sonar.ts` as the fallback for older servers |

### What the team's `.gemini/settings.json` already does

The settings file attached on 18 Oct 2026 runs Jira and GitLab as MCP servers of the CLI itself, not of GeminiCode. Measured on the same day by starting each server with its published package and the file's own include and exclude lists, then calling `tools/list`:

| Server | Image in the file | Advertised | After the file's filter | Schema bytes sent per turn | About |
| --- | --- | --- | --- | --- | --- |
| `jira` | `ghcr.io/sooperset/mcp-atlassian:latest` (mcp-atlassian 0.23.1) | 63 tools | 48 (15 excluded) | 37,550 | 9,400 tokens |
| `gitlab` | `zereight050/gitlab-mcp:latest` (@zereight/mcp-gitlab 2.3.3) | 124 tools | 58 (includeTools) | 78,544 | 19,600 tokens |
| `geminicode-tools` (the fork's own, Jira and GitLab tools only) | in-process | 11 | 11 | 4,665 | 1,200 tokens |

The CLI sends every tool declaration with every model call [F: "the CLI's agent system prompt (32,500 characters) and 12 tool declarations"]. So the two containers add roughly **29,000 input tokens to every request** of every turn, twenty-five times the fork's own Jira and GitLab tools (all 17 of the fork's tools together are 6,559 bytes), before any ticket or diff is read. At 28,807 tokens per coordinator turn today [F] that doubles the per-request cost, and Enterprise quota counts requests, not tokens [LIC pending], so the cost shows as time to first token, not as quota. **This is the first number to confirm in T-12** (`gemini_cli.token.usage{type="input"}` per request with and without the two servers).

Other facts from the file that the plan now takes as given:

- The servers are started by Docker on each Mac (`docker run -i --rm … :latest`). Docker is therefore a prerequisite of the pilot machines, and `:latest` means the tool set and behaviour can change under the team without a commit; the adapter pins a digest.
- Tokens reach the containers from the user's shell environment (`$GITLAB_PERSONAL_ACCESS_TOKEN`, `$JIRA_API_TOKEN`), and `security.environmentVariableRedaction.allowed` tells the CLI **not** to redact those two names. The agent's shell tool runs in that environment, so `env` or `printenv` in a turn shows the model both tokens in clear. This is the first row of the threat model's token section.
- `trust: false` on both servers, so every call asks unless `.gemini/policies/vca-qa-automation.toml` allows it (that file was not attached; it is a project policy, which `--admin-policy` outranks).
- The GitLab filter already excludes `merge_merge_request`, `approve_merge_request` and `unapprove_merge_request`; the Jira filter excludes deletes, edits, moves and sprint changes. That matches the confirm class in section 4, but a settings file in the repository is editable by anyone with write access; the same rule belongs in GeminiCode's admin policy so it holds whatever the file says.
- `mcp.allowed` lists `gitlab`, `jira` and the three GeminiCode servers, so agents today see **two** sets of Jira and GitLab tools (the containers' and `geminicode-tools`'), which the team-tools guide already warns about.

### The adapter

Keep what exists and give it one shape. `geminicode-tools` is already an MCP server on `127.0.0.1` with one URL and HMAC bearer token per agent, passed to every session in `session/new`'s `mcpServers`, and the Home dashboard, the merge request panel and the flows already call the same connector classes [SRC `teamToolsMcp.ts`, `teamConnections.ts`, `homeDashboard.ts`, `mrPanel.ts`, `teamFlows.ts`]. The missing piece is that the UI and the agent reach the connectors through two different paths with two different permission and error paths.

```
                      ┌───────────────────────── TeamAdapter (extension host) ─────────────────────────┐
  agent (ACP session) ─▶ geminicode-tools MCP (127.0.0.1, HMAC per agent) ─▶ ToolRegistry ─▶ Provider
  UI (Home, MR panel, flows) ─────────────────────────────────────────────▶ ToolRegistry ─▶ Provider
                                                                              │ permission class (read / write / confirm)
                                                                              │ audit log · rate limiter · cache
  Providers: Jira (REST, in-process) · GitLab (REST, in-process) · Figma (HTTP MCP passthrough)
             Snyk (stdio MCP child) · SonarQube (stdio MCP child)
```

- **One registry, one call path.** `callTeamTool(context, agent, name, args)` is already the one entry for the agent; make the UI call it too (with `agent = 'ui'`), so Home's "Move" and an agent's `jira_transition` run the same code, the same precondition checks and the same audit record. Evidence that it is one layer: a unit test that the UI and agent calls produce byte-identical audit records for the same action [CI].
- **The two containers become children of the adapter.** The adapter starts `mcp-atlassian` and `gitlab-mcp` itself (same images, pinned by digest), injects the tokens from the keychain into the child's environment only, and re-exposes a curated subset through `geminicode-tools`: the tools the flows need (`jira_get_issue`, `jira_search`, `jira_transition`, `jira_comment`, `jira_log_time`, `jira_assign`; `gitlab_get_mr`, `gitlab_list_mrs`, `gitlab_job_log`, `gitlab_get_issue`, `gitlab_create_mr`, `gitlab_reply`, `gitlab_merge`) mapped onto the containers' tools (`jira_get_issue` → `jira_get_issue`, `jira_transition` → `jira_get_transitions` + `jira_transition_issue`, `gitlab_merge` → `merge_merge_request` behind the confirm class, and so on). The agent then sees one server with 17 tools instead of two servers with 106. Migration: the fork detects `mcpServers.jira` and `mcpServers.gitlab` in the workspace settings and offers to take them over (moving the tokens into the keychain and removing the two entries and the redaction allowance), and until the user says yes nothing changes. Evidence: T-12 input tokens per request before and after; the containers' own logs showing the calls arrive with the same arguments.
- **Official servers as children of the adapter, not of the CLI.** The CLI only loads MCP servers in trusted folders and only those passed per session or in settings files [F]; if the Snyk and SonarQube servers were put in `~/.gemini/settings.json` the UI could not call them, tokens would sit in the agent's environment, and the permission policy would be the CLI's. Instead the adapter starts them (`snyk mcp -t stdio`; the SonarQube jar or container) and re-exposes a curated subset through `geminicode-tools`. The agent sees one server, as today.
- **Thin means thin.** The adapter adds exactly: tool registry, permission class, audit, rate limiting with `Retry-After`, a 60-second read cache keyed by URL (the MR panel already does this per agent [SRC `mrPanel.ts`]). No workflow logic lives in it; that stays in `teamFlowLogic.ts`, which is pure and tested.
- **Rate limits and scopes** (to verify against your tenants; the tags say where the number came from):
  - Jira Cloud: cost-based budgets per tenant, `429` with `Retry-After` and `X-RateLimit-NearLimit`; Atlassian's guidance is exponential backoff with jitter [A: web, Atlassian community; verify on the rate-limiting page]. Token: a **scoped** API token with `read:jira-work`, `write:jira-work`, `read:jira-user` rather than an unscoped one [A: verify scoped tokens are enabled on the site].
  - GitLab: per-instance, admin-configured under Admin Area → Settings → Network; `RateLimit-*` headers since 13.8 [A: web; read the values from your instance]. Token: a PAT with `api` is needed for writes (`read_api` cannot comment or open MRs) [SRC `teamConnections.ts` checks the scope]; expiry shown in Connections. There is no narrower write scope [A: verify against your GitLab version].
  - Figma: `429` with `Retry-After`, tier by seat ("high" for Dev and Full seats); the Dev Mode MCP server is in open beta with no published limits [A: web].
  - Snyk REST: 1,620 requests per minute per API key [A: web, Snyk docs]. The MCP server uses the CLI's own sign-in.
  - SonarQube: no published API rate limit; user token [A].

### The "my work" panel

Today's Home shows **My tickets** (`assignee = currentUser() AND sprint in openSprints()`), **Merge requests** (`reviewer_id = me`, `created_by_me`) and **Needs you** (agent waiting, review request, failed pipeline on my MR, reopened ticket) [SRC `homeDashboard.ts`, `teamData.ts`]. Turn it into "my work" with these sections, each named by its source query so the number on the card can be checked against the tool:

| Section | Source | Shows |
| --- | --- | --- |
| Needs you | as today, plus: MR of mine with `detailed_merge_status = "mergeable"` and approvals complete (ready to merge); MR where a thread I started was answered; ticket moved to a status whose category is `indeterminate` and assigned to me | one line and one primary action each |
| My tickets | `assignee = currentUser() AND statusCategory != Done AND (sprint in openSprints() OR sprint is EMPTY) ORDER BY status, updated` | key, summary, status pill coloured by `statusCategory`, time logged by me (`/worklog`) |
| Pending on me | `reviewer_id = me AND state = opened` and `assignee_id = me` | MR, author, pipeline, approvals `given of required` from `/approval_state` |
| Mine | `author_id = me AND state = opened` | pipeline, approvals, `detailed_merge_status`, unresolved threads count |
| Quality | SonarQube gate on the release branch; Snyk high and critical | as today |

**Actions, in terms of the real schema.** The Jira workflow schema and the GitLab approval rules were not provided, so each action below is defined by the API object that carries the rule, and the panel reads the rule at runtime rather than assuming it. Attach the exports when you have them: `GET /rest/api/3/workflow/search?expand=transitions,statuses` (or the project's `GET /rest/api/3/project/{key}/statuses`) and `GET /projects/:id/approval_rules` plus the project's merge settings.

| Action | How it is bound to the schema | Status today | Audit evidence |
| --- | --- | --- | --- |
| Comment | `POST /issue/{key}/comment`, ADF built from plain text, optional role visibility from `jira.commentVisibility` | Implemented [SRC `jira.ts`] | Comment visible in the issue's activity with the user's account [AUDIT] |
| Transition | `GET /issue/{key}/transitions?expand=transitions.fields` lists only the moves the workflow allows from the current status, with each move's required fields and allowed values; the UI offers exactly those and refuses to submit without a required field. The flows that *suggest* a move ("In Progress" when starting on a ticket, "In Review" after opening an MR) today match by **name** [SRC `teamFlows.ts` `moveTicket(key, id, 'In Progress')`], which is an assumption about your workflow. Replace with `jira.transitions` in `geminicode-tools.json`: `{ "start": "<transition id>", "review": "<id>", "done": "<id>" }`, falling back to name matching only when unset [A → removed once the schema is in] | Implemented, name-bound | Issue history shows the status change and the transition's screen fields [AUDIT] |
| Reassign | `GET /user/assignable/search?issueKey={key}&query=` for the candidates (Jira applies the project's assignable-user permission), then `PUT /issue/{key}/assignee` with `accountId` | **Not implemented** | Assignee change in issue history [AUDIT] |
| Log time | `POST /issue/{key}/worklog?adjustEstimate=auto`, `timeSpentSeconds`, `started` | Implemented | Worklog entry [AUDIT] |
| Open MR | `POST /projects/:id/merge_requests` with `reviewer_ids`, `remove_source_branch`, `draft`; target chosen from release branches and the ticket's fix version [SRC `teamFlowLogic.ts` `targetChoices`] | Implemented | MR created by the user [AUDIT] |
| Review | `POST .../approve`, `PUT .../reviewers/:id` with `state=requested_changes` (GitLab 17.2+; older gets unapprove + note) [SRC `gitlab.ts`] | Implemented | Approval or reviewer state in MR activity [AUDIT] |
| Comment on MR | `POST .../notes`, `POST .../discussions` with a `position` on the diff, `POST .../discussions/:id/notes` to reply, `PUT .../discussions/:id?resolved=true` | Implemented | Note in MR activity [AUDIT] |
| **Merge** | Preconditions read live and shown as a checklist before the button is enabled: `detailed_merge_status == "mergeable"`; `GET .../approval_state` → every rule's `approved_by.length >= approvals_required`, listing the rule names (code owners, "any eligible", named groups) and eligible approvers; project settings `only_allow_merge_if_pipeline_succeeds` and `only_allow_merge_if_all_discussions_are_resolved` [A: GitLab REST field names from memory, verify against your version]. Then `PUT .../merge` with `sha` (the head the user saw), `squash` per the project's squash option, `should_remove_source_branch`. GitLab enforces the same rules server-side, so a stale view fails with 405/406, never a wrong merge | **Not implemented** | "merged by <user>" in MR activity, with the `sha` [AUDIT] |

## 4. Threat model for the agent's tool permissions

**Assets.** The user's Jira and GitLab identity (API token, PAT), the Google sign-in in `~/.gemini/oauth_creds.json`, the repository and worktrees, the Figma seat, and the audit trails in Jira and GitLab.

**Actors.** The user; the agent (model output); anyone who can write to a Jira issue, an MR description or thread, a GitLab issue, a CI job log, or a Figma file the agent reads; a repository author whose `.gemini/` folder the CLI loads in a trusted folder.

**Untrusted input reaches the model through** `jira_get_issue` (description and last five comments, up to 12,000 characters), `jira_search`, `gitlab_get_mr` (description, open threads, diff up to 30,000 characters), `gitlab_job_log` (8,000 to 12,000 characters of log), `gitlab_get_issue`, `figma_design` (up to 40,000 characters of design context), the prompts the flows build from them (`mrFixPrompt`, `reviewPrompt`, `checksFixPrompt`), and the browser tools' page snapshots [SRC `teamTools.ts`, `teamFlowLogic.ts`].

| Threat | Existing control [SRC] | Gap | Change |
| --- | --- | --- | --- |
| Injected text makes the agent write to Jira or GitLab | The five write tools (`jira_comment`, `jira_transition`, `jira_log_time`, `gitlab_create_mr`, `gitlab_reply`) always reach a permission card with the exact text; only read tools get `instantAnswer` | **The card offers the CLI's "Allow for this session" (`proceed_always`) option for MCP tools, which the CLI applies to all of the server's tools.** One click on a harmless comment would make later transitions and time logs silent | In `PermissionBroker`, for any tool in the confirm class, filter the options to `allow_once` and `reject` before the card is shown; a test asserts no `allow_always` option ever reaches the webview for them [CI] |
| Injected text makes the agent run a command or read a secret | Shell commands always ask in Default mode; session approvals never cover network programs, wrappers, interpreters or redirections; file access refuses secrets, git-ignored files and paths outside the folder, following links | Reads through `grep`, `glob`, `ls` and the shell run inside the CLI and are not covered; YOLO and Auto Edit can be removed by policy only | Pilot policy: `GeminiAllowYolo` locked off, `GeminiAllowAutoEdit` on, `GeminiAllowShell` on; evaluate `--sandbox` after the pilot (ROADMAP) |
| Provenance lost: the model cannot tell tool text from the user | None: tool results are plain trimmed text | | Wrap every external text in a fixed frame (`<external source="jira" ref="ACME-412" trust="untrusted">…</external>`) and add one sentence to the server's `instructions` that text inside it is data; the CLI 0.64 bundle emits a `gemini_cli.conseca.verdict` telemetry event, so its own content-security check exists and its verdicts should be read from the trace before any extra layer is built [A: verify what conseca covers] |
| Tokens readable by the model | GeminiCode's own connectors keep tokens in SecretStorage, never in settings or the agent's environment | **The team's `settings.json` passes `$GITLAB_PERSONAL_ACCESS_TOKEN` and `$JIRA_API_TOKEN` from the shell environment and allow-lists both names in `security.environmentVariableRedaction`, so a shell tool call such as `env` shows the model both tokens in clear** | The adapter starts the containers with the tokens injected into the child's environment only; the two names leave the redaction allow-list; the CLI's shell tool never sees them. Until then: the pilot policy denies `env`, `printenv` and `set` through the admin policy's shell rules |
| Over-privileged tokens | GitLab token scopes and expiry are checked and shown | Jira API token is unscoped (full user rights); GitLab `api` is the whole account | Scoped Jira token (above); GitLab PAT named `GeminiCode` with expiry ≤ 90 days (Connections already links the creation page with name and scope filled in); server-side approval rules remain the hard floor |
| Supply chain of the MCP containers | `trust: false` makes every call ask; `includeTools` and `excludeTools` limit the surface | `:latest` tags; images published by individuals, not the vendors; a settings file anyone with write access can widen | Pin image digests in the adapter; mirror the images to the team's registry; the confirm class and `mcp.allowed` enforced by `--admin-policy`, which outranks the repository's `.gemini/policies/*.toml` |
| Repository-supplied MCP servers, hooks and skills run when a folder is trusted | Folder trust is the CLI's; GeminiCode asks before trusting; Project Helpers show the servers and hooks | A trusted repository's `.gemini/settings.json` can add servers that run programs | Admin policy `mcp.allowed` naming `geminicode-tools`, `geminicode-project` and the browser server only, through `--admin-policy` [SRC `adminPolicy.ts` pattern]; the docs already tell teams to add `geminicode-tools` to `mcp.allowed` |
| Exfiltration through the browser or `web_fetch` | Other origins ask per agent and site; `gemini.browser.allowedOrigins` can pin them; `web_fetch` refuses private hosts | | Pilot policy: `GeminiBrowserAllowedOrigins` = the GitLab, Jira, SonarQube and localhost origins |
| No record of what the agent did on the user's behalf | Jira and GitLab keep their own history under the user's account | Nothing on the client ties a Jira change to the agent turn and the text the user approved | **Audit log:** append-only JSONL in `<globalStorage>/audit/YYYY-MM-DD.jsonl`: time, agent id, caller (`agent` or `ui`), tool, a hash of the arguments, the approved text's hash, the permission outcome and who answered, the remote id returned (Jira comment id, worklog id, GitLab note id, MR iid, merge `sha`). **Gemini: Open Audit Log** shows it. The remote id is the join key to the Jira or GitLab history [AUDIT] |
| A merge, a status change or a time log without a person | The flows require a button; the tools require a card | The card can be auto-allowed (first row) | **Confirm class** = `gitlab_merge` (new), `jira_transition`, `jira_log_time`, plus `gitlab_create_mr`. Rules: never `instantAnswer`, never `allow_always`, the card shows the exact remote effect (status from → to with the fields; `Xh Ym on KEY`; `!N into target at sha`), and the audit record stores the option the user picked. Enforced in `PermissionBroker`, tested [CI] |
| Local state on a lost or shared Mac | Tokens in the keychain; transcripts, checkpoints, team snapshots and the audit log in the user's Library | Transcripts carry ticket text and diffs in clear | Require FileVault through the same device policy that deploys the app's policy template; keep the audit log hash-only for arguments and text, as section 4 defines it |
| A restart during a write leaves a half-done action | Flows check for an existing MR before creating one [SRC `teamFlows.ts` `existing`] | Transition plus comment, push plus MR, and worklog have no such check | Intent and result audit records; **Unfinished** on Home; re-check the remote before any redo (restart model, section 1) |
| Project coordinator acting on its own | Coordinator tools are allowed and hidden, every other tool refused; merging is a button, not a tool | | Keep; add the audit record for `start_thread` and `message_thread` |

## 5. Evaluation harness

### Benchmark from closed Jira tickets

- **Selection** (`gemini/bench/select.mts`, shipped 18 Oct 2026, run against Jira and GitLab with the user's tokens): tickets with `statusCategory = Done` in the last six months whose linked MR merged, with a diff of 20 to 400 lines and at least one test file touched. Target 30 tasks across the repositories the pilot uses; refresh quarterly.
- **Task record**, `gemini/bench/tasks/<KEY>.json`: `{ key, repo, baseSha, prompt: <ticket summary + description as the agent would read it through jira_get_issue>, grader: { command, timeoutMs }, touchedFiles }` (the shape `select.mts` writes and `bench-run.mts` reads; `gemini/bench/README.md` has an example). The grader is the MR's own test command at the merge commit, run against the agent's working tree (the "does the author's test pass" check), plus the repository's lint.
- **Runner**, `extensions/gemini/scripts/bench-run.mts` (shipped 18 Oct 2026): drives the CLI over ACP the way the app does (`gemini --acp`, `GEMINI_CLI_NO_RELAUNCH`, a session per task in a fresh clone at `baseSha`, Auto Edit, shell on, every permission request answered allow-once), with one model per run (`--model`), so a Flash run and a Pro run are two result files, and a 20-minute cap per task. It is a script rather than the app's own `AgentClient`, so the admin policy and the file handlers are not in the measurement; the prompt path and the CLI are. Headless `gemini -p --output-format stream-json` is the fallback for a run outside the app, and its `result` event carries the stats.
- **Metrics per task and per release:** completion (grader pass), tokens (the `_meta.quota.token_count` per turn that the CLI already returns and the fork already stores per turn [SRC `turnUsage.ts`]; cached tokens from telemetry), wall-clock latency to first token and to completion, number of permission cards, number of Undo actions. Report: `gemini/bench/results/<geminiCodeVersion>-<cliVersion>.json` and a page on the docs site.
- **When and where:** there is no always-on machine owned by this project, and hosted runners cannot sign in to Code Assist [SRC `ROADMAP.md`]. So the benchmark runs **on a developer's Mac, from the release build, under their own seat**, on release day. Today that is the script above by hand, with the results file added to `gemini/bench/results/` by pull request. Still to build [A]: a **Gemini: Run Benchmark** command that wraps the script, a last step in the release workflow that opens an issue titled `Benchmark <version>` as the reminder, and a page on the docs site rendered from the results files. Once the page exists, the release is not announced on the download page until the results PR is merged, as a branch-protection rule on `gemini-pages.yml`'s source, not a convention. Quota: 30 tasks × two models × roughly 15 requests per task is about 900 requests, under the 2,000 per user per day Enterprise limit, so the developer who runs it should not also plan a full day's work on that seat [LIC pending: confirm the seat's edition and that benchmark use is allowed]. Evidence that it ran: [BENCH] the results file for the version, signed by the commit that added it; [CI] the pages job that rendered it. No task has been run yet: the task set needs the team's Jira and GitLab, and the first run needs a seat.

### Checks on any branch, before the merge request

Developers run the quality checks themselves before raising a merge request, on whatever branch they are about to raise it from. Shipped on 18 Oct 2026 [SRC `checksBranch.ts`, `teamFlows.ts`, `test/acp/checksBranch.test.ts`]:

- **Run Checks on a Branch…** (Home's quick action, the Command Palette) lists the branch checked out here, agents' branches, local branches and the remote's, picks one, and runs Snyk (dependencies and code) on a checkout of it. A branch not checked out anywhere gets a worktree under `~/.geminicode/worktrees/<repository>/checks/`, the repository's `gemini.agents.worktreeSetup` command runs in it once, and later runs reuse it; the user's own checkout never moves (the test asserts both).
- SonarQube's gate and new-code issues come from the server's last analysis of the branch, so they need one push; until then the row says so.
- **Fix** sends the findings to the agent working on the branch, or starts one in that checkout with the findings as its first prompt.

Next: local SonarQube analysis of the changed files, without a push, through the official SonarQube MCP server's `analyze_file_list` (connected to the server's quality profile; needs SonarQube Server 2025.1+ [A]), so the Sonar row is live for an unpushed branch too. Evidence that the feature matters: [PILOT] the share of merge requests whose first pipeline fails a quality job, before and after; [AUDIT] checks runs recorded per branch against the MR's creation time.

### Gates on the IDE repository

- **Snyk**: the `Snyk on the fork's code` job in `gemini-ci.yml` (shipped 18 Oct 2026) runs `snyk test --severity-threshold=high` on `extensions/gemini` and `snyk code test` on `extensions/gemini` and `gemini/site`. It needs `SNYK_TOKEN` as a repository secret and says so and passes without one, so adding the secret is what turns it into a gate. Upstream's own tree keeps its own process.
- **SonarQube**: `sonar-scanner` on `extensions/gemini` with the new-code quality gate. The server is behind the VPN and GitHub-hosted runners cannot reach it, so this runs in the **team's existing GitLab CI** on a mirror of this repository (existing infrastructure, nothing new), and its gate result is posted back to the GitHub commit status by the pipeline [A: depends on the GitLab CI config you have, not yet provided]. Until the mirror exists, **Gemini: Run Checks** on this repository from a developer's Mac is the gate, recorded in the release PR.
- **axe and Lighthouse on the GitHub Pages site** (shipped 18 Oct 2026): `gemini/site/check-a11y.mjs` runs axe-core on every built page and fails on any violation; `gemini/site/check-lighthouse.mjs` serves the site gzipped, as Pages does, and fails under accessibility 100, performance 90, best practices 90 or SEO 90. Both run in `gemini-ci.yml` on the sample build and in `gemini-pages.yml` before anything is uploaded. First run here on the sample site: axe found low-contrast captions and the SHA line, unlabelled side landmarks, links in body text told apart only by colour, callout titles too faint, code blocks that scroll but cannot take keyboard focus, and the release page's side column marked as a landmark inside another; all fixed in `gemini/site/`. Lighthouse then gave the landing page performance 95 and accessibility 100, and the docs home 100 and 100. The landing page's remaining opportunity is the hero image's size.

## 6. ADRs, non-goals, pilot

### ADRs

Irreversible decisions get a record in [`adr/`](adr/). Two restate decisions already made and documented; the rest are new.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-fork-not-extension.md) | Fork VS Code as a branded app; do not ship as an extension (existing) |
| [0002](adr/0002-official-cli-over-acp.md) | The official Gemini CLI over ACP is the only model path; never patch the CLI (existing) |
| [0003](adr/0003-patch-series-over-pinned-tag.md) | Upstream edits are a patch series over a pinned release tag, with a CI job that moves the tag and the CLI pin together |
| [0004](adr/0004-one-tool-adapter.md) | One local adapter serves the agent and the UI; official MCP servers run as its children; Jira and GitLab stay in-process because their official servers need Rovo and Duo |
| [0005](adr/0005-user-tokens-only.md) | Every action runs with the user's own tokens from the OS keychain; no service accounts in the IDE |
| [0006](adr/0006-confirm-class.md) | Merge, status transition, time logging and MR creation are a confirm class that can never be auto-approved |
| [0007](adr/0007-telemetry-and-audit.md) | Telemetry is the CLI's OpenTelemetry export to a local file, opt-in, prompts never logged; the client audit log is append-only JSONL joined to Jira and GitLab history by remote ids |
| [0008](adr/0008-storage-compatibility.md) | Settings keys, policy names, transcript and state formats are a versioned contract; rewrites migrate, never break |
| [0009](adr/0009-desktop-only.md) | Desktop only: no server component; all state on the Mac; every flow resumable from a record on disk; a restart never answers for the user |

### Non-goals

- Windows, Intel Mac and Linux builds before the pilot ends (ROADMAP).
- In-app auto-update (needs an update server).
- Sandboxing the agent by default (`--sandbox` needs a container runtime on every Mac).
- Reimplementing any part of the agent, sign-in or licensing outside the CLI.
- Anything that depends on Rovo or Duo, including their MCP servers and Duo code review.
- Jira Server or Data Center; only Jira Cloud REST v3.
- A relay service, hosted agent, always-on runner, or any server owned by this project: everything runs on the user's Mac over the VPN, and nothing continues while the app is closed (ADR 0009).
- Writing back to Figma.
- Replacing GitLab CI, SonarQube or Snyk's own scanning with the agent's.
- Model fine-tuning or prompt-tuning for the benchmark.

### Pilot: three developers, two weeks

- **Who:** three developers on repositories that have an open sprint in Jira, MRs flowing in GitLab, a SonarQube project and Snyk, so every card on Home has data. Enrol with the release build signed and notarised (the Apple secrets, ROADMAP) so no one approves the app by hand.
- **Baseline, the week before:** the same two measures taken with the tools they use today.
- **Measures, both from the tools' own records rather than self-report:**
  - **Time-to-first-MR per ticket:** from the Jira changelog entry that moved the ticket into the first `indeterminate` status (`GET /issue/{key}/changelog`) to the MR's `created_at` with the ticket key in its branch or title. Baseline from the same two sources for the previous sprint. [AUDIT]
  - **Context switches per hour:** count of application activations away from and back to GeminiCode while a ticket is in progress, from a tiny opt-in macOS script (`NSWorkspace.didActivateApplicationNotification` to a local CSV) the developer runs, and, inside the app, the count of `openTeamLink` calls (leaving the app for Jira or GitLab) against panel actions that did the same thing in place. [PILOT]
  - **Restart cost:** app launches per day and, for each, time from launch to the first accepted prompt and whether anything was listed under **Unfinished** (restart model, section 1).
  - **Secondary:** requests per day from the usage meter, permission cards per turn, Undo and Rewind per turn, first-prompt waits on `session/new` (section 1, fix 2), `TeamToolError` counts by kind (VPN off, 401, 429).
- **Telemetry mechanics:** `gemini.pilot.export` writes the audit log, the usage meter samples and the counters above to `~/geminicode-pilot/<date>.jsonl`; developers hand the folder over at the end. Nothing leaves the Mac on its own.
- **Exit criteria:** median time-to-first-MR down by 25% against baseline with no rise in reopened tickets; context switches per hour down by a third; zero confirm-class actions in the audit log without a matching permission outcome; no Jira or GitLab write without a matching entry in the tool's own history.

## 7. Ambitious additions, each with its evidence and metric

Only after sections 1 to 6 are green. Each item names the evidence that motivates it; where that evidence is a trace or shadowing session not yet taken, it says so.

1. **A per-user resident CLI process, bounded by the desktop.** Today the process lives per window and dies with the extension host on reload, costing 1.2 s to `initialize` and about 230 MB per window [T-02][F]. One `gemini --acp` per user as a launchd user agent, reached over a local socket, would make every window's first prompt a `session/new` or `session/load` and survive window reloads and app quits. It cannot survive a reboot or a log-out, and there is no server to move it to, so the ceiling is "one cold start per login". Blocked until T-11 shows reloads and multi-window use are frequent enough to matter. Metric: cold `initialize` per developer per day → 1; memory per window.
2. **Cache-hit accounting on every turn.** Read `cached_content_token_count` per turn from telemetry, show it in the usage ring, and file the numbers upstream if Code Assist's implicit caching misses the CLI's stable prefix. Motivated by 28,807 input tokens per coordinator turn [F]. Metric: cached share of input tokens; requests per ticket.
3. **Review in GitLab CI without Duo.** The same `reviewPrompt` the Review flow uses [SRC `teamFlowLogic.ts`], run headless (`gemini -p --output-format json --approval-mode plan`) in the MR pipeline on the team's existing GitLab runners, posting findings as draft comments that a human must publish. This needs a Code Assist seat on a runner, which is a service account and contradicts ADR 0005; it is listed so the decision is explicit, not implied. Motivated by the Review flow already producing parseable findings. Needs user-shadowing evidence that reviewers want it before any MR is touched. Metric: review turnaround time; findings accepted by reviewers.
4. **Plan on assignment.** When a ticket is assigned to me and moves to the sprint, start an agent in Plan mode on its own branch and hold the plan for approval; the ticket is not moved until the person clicks. Motivated by `Start Agent on a ticket` existing and by the pilot's time-to-first-MR measure. Metric: time-to-first-MR; plans discarded.
5. **Lazy zod and ACP SDK loading** in `extension.js`: 60 of 130 ms of bundle load [F]. Metric: extension activation time in T-11.

## Where the evidence stands today

| Claim | Evidence in hand | Still needed |
| --- | --- | --- |
| Named Flash default saves one model call per prompt | T-01, T-02, F | T-12 with real Flash-Lite latency |
| Spare session hides `session/new` | SRC, F | T-12 session span with Google sign-in; pilot counter |
| Token volume per turn | F (real account); the Record Performance Trace command (shipped 18 Oct 2026) reads `cached_content_token_count` per call from the CLI's file | T-12 cached share from a real session |
| Audit log | Shipped 18 Oct 2026: `auditLog.ts`, intent and result records for every agent and page write, Open Audit Log | pilot join against Jira and GitLab history |
| Fork confinement | SRC diff by area; the patch series (74 patches over 1.141.0, `gemini/patches/`) and its CI check shipped 18 Oct 2026 | the first green `Patch series matches HEAD` step on a pull request |
| CLI pin is what ships | checksum match, release notes; `gemini-upstream.yml` written 18 Oct 2026 | the upstream job's first pull request, with the dry run below as the expected shape |
| Official MCP servers for Jira and GitLab unusable | web (secondary) | admin confirmation on both tenants |
| My work panel | Shipped 18 Oct 2026: Needs you lists a merge request of mine GitLab says can merge; Pending on me adds merge requests assigned to me; the merge request panel shows the live merge checks with Merge on only when all hold; Reassign on tickets | AUDIT entries from the pilot |
| Merge, reassign | Shipped 18 Oct 2026 as `gitlab_merge` (reads `approval_state`, project merge settings, threads and GitLab's verdict first; merges at the head it read) and `jira_assign`; tests against a fake server | AUDIT entries from the pilot |
| Auto-approval hole for confirm-class tools | Closed 18 Oct 2026: `PermissionBroker.confirmOnly`, `teamConfirmTools`, `test/acp/permissions.test.ts` | pilot audit records showing an outcome on every confirm-class action |
| Quota headroom for the benchmark | public quota page via search | the license document |
| Benchmark | `gemini/bench/select.mts` and `extensions/gemini/scripts/bench-run.mts` written 18 Oct 2026; no task selected or run yet | a task set from the team's Jira and GitLab, then the first results file under a real seat |
| Site gates | `check-a11y.mjs` and `check-lighthouse.mjs` pass on the sample site, 18 Oct 2026; both wired into `gemini-ci.yml` and `gemini-pages.yml` | the first green run of each on GitHub's runner |
| Snyk gate | the job is in `gemini-ci.yml`, 18 Oct 2026 | the `SNYK_TOKEN` secret, then its first run |
