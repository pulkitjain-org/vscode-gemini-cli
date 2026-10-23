# Findings against the real CLI

What GeminiCode's design relies on about the Gemini CLI, and what it costs. [ARCHITECTURE.md](ARCHITECTURE.md) explains how each finding is used.

Every entry is one of two kinds:

- **Measured.** Taken on 18 Oct 2026 on an Apple M3 Pro Mac (12 cores, 36 GB, macOS 26.7) with gemini-cli 0.64.0, the version GeminiCode bundles. *Real account* means a Google sign-in with a Gemini Code Assist license, billed to a Google Cloud project, over the network. *Stand-in* means a local fake of the Gemini API that answers each model call after a fixed delay, with an API key and no network, so it measures everything but the model and the sign-in. Each table names the script in `extensions/gemini/scripts/` that takes it again.
- **Read from the CLI.** Behaviour read from the 0.64.0 bundle (`extensions/gemini/cli/0.64.0/bundle/`). Where a real-CLI test (`extensions/gemini/test/acp/real*.test.ts`) checks it, the test is named. All of those tests pass against 0.64.0.

Re-check both kinds when GeminiCode moves to a new CLI version.

## At a glance

| | Real account | Stand-in |
| --- | --- | --- |
| Agent start, to the `initialize` answer | 2.9 s | 0.75 to 0.81 s |
| A session, `session/new` | 0.8 s (a second one 1.1 s) | 53 to 97 ms |
| First text of a reply, Flash picked | 3.5 s | 0.32 s (model 0.3 s) |
| First text of a reply, model on Auto | 8.1 s | 0.68 s |
| Input tokens per model call, one-line prompt | 11,882 | |
| Agent memory after `initialize` | 280 MB | |
| Enhance prompt, direct request, p50 / p95 | 2.8 s / 4.7 s | |
| Enhance prompt through the CLI, Flash-Lite, p50 / p95 | 4.8 s / 15.7 s | |

## Starting the agent

`perf-real.mts --project <id> --runs 3`, real account, median of three (range in brackets). The agent ran in this repository, which the CLI did not trust, so it loaded no context files, MCP servers or hooks.

| Step | Time or size |
| --- | --- |
| `initialize`, with `GEMINI_CLI_NO_RELAUNCH=true` | 2,906 ms (2,598 to 3,170) |
| `initialize`, with the CLI relaunching itself | 3,314 ms (3,144 to 3,451) |
| Memory after `initialize` | 280 MB |

`perf-first-reply.mts --runs 3`, stand-in, median of three: 745 ms in an empty folder, 812 ms in this repository, trusted.

- Unless `GEMINI_CLI_NO_RELAUNCH` is set, the CLI's entry point starts a second Node process to raise its heap limit, even when the heap is already large enough. That costs about 0.4 s of every start. In a trial run before these, a relaunched CLI never answered `initialize` at all, which is why `perf-real.mts` gives it 30 s.
- So GeminiCode starts the agent with `GEMINI_CLI_NO_RELAUNCH=true` and the heap the CLI would pick for itself (half the machine's memory, unless `advanced.autoConfigureMemory` is off in `~/.gemini/settings.json`). For a JavaScript entry point the heap flag goes on Node's command line; for a `gemini` executable it goes in `NODE_OPTIONS`, as the CLI does for its single-file binary.
- Without the wrapper process, two things change. The CLI asks its wrapper to restart it by exiting with code 199 (`RELAUNCH_EXIT_CODE`), so the sidecar restarts it at once on that code, at most three times in a row. The wrapper also forwards admin settings over IPC between relaunches; the CLI does that only when `process.send` exists, so it is skipped. The interactive terminal used for sign-in keeps the CLI's own behaviour.
- The real start takes about 2.1 s longer than the stand-in's. The stand-in uses an API key, so the difference is the Google sign-in's own work at start (inferred from the two setups, not traced). GeminiCode hides it by starting the agent a few seconds after the window opens when a sign-in is saved.

## Sessions

Same runs as above.

| Step | Real account | Stand-in, empty folder | Stand-in, this repository |
| --- | --- | --- | --- |
| First `session/new` | 780 ms (543 to 787) | 53 ms | 97 ms |
| Next `session/new` in the same process | 1,063 ms (808 to 1,293) | 53 ms | 89 ms |
| Memory after two sessions | 285 MB (284 to 298) | | |

- With a Google sign-in a session costs most of a second, against well under 100 ms with an API key. GeminiCode hides it behind a spare session opened while the user types.
- One process serves any number of sessions, each with its own `cwd`, and each session loads the settings of its own folder, so one process serves agents in different folders. The process environment, such as `GOOGLE_CLOUD_PROJECT`, is shared, so agents that need another project need another process.
- Over ACP, gemini-cli 0.64.0 implements `initialize`, `authenticate`, `session/new`, `session/load`, `session/cancel`, `session/prompt`, `session/set_mode` and `session/set_model`. It advertises `loadSession`, `promptCapabilities` (`image`, `audio`, `embeddedContext`) and `mcpCapabilities` (`http`, `sse`), and no `sessionCapabilities`: there is no `session/close`, `session/list`, `session/fork`, `session/resume` or `session/set_config_option`. A session therefore stays in the process until it exits. GeminiCode closes the sessions it leaves only when a CLI advertises `sessionCapabilities.close`.

## A prompt's first reply

`perf-real.mts`, real account, median of three. The prompt asks for a one-word reply and no tools, so the time is almost all the model's.

| Model | First text | Whole turn | Model calls reported | Input tokens per call |
| --- | --- | --- | --- | --- |
| Auto | 8,114 ms (7,593 to 8,231) | 8,297 ms | 1 | 11,882 |
| `gemini-3.8-flash`, picked | 3,450 ms (3,059 to 7,101) | 3,661 ms | 1 | 11,882 |

`perf-first-reply.mts`, stand-in with 300 ms per model call: 676 ms to the first text on Auto, 318 ms with Flash picked.

- With the model on Auto, every prompt first makes a routing call that picks the model, and the reply waits for it. On the stand-in that is exactly one more model call; on the real account Auto took 4.7 s longer than Flash for the same one-word reply. With a model picked, through `session/set_model` or settings, there is no routing call. Tool-result follow-ups within a turn never make one.
- The routing call is not reported: an Auto turn's `usage_update` and `usage` count one model call.
- So GeminiCode opens new agents on the first Flash model the agent lists, never Flash-Lite, until the user picks a model, and remembers the user's pick.
- On the stand-in the CLI adds under 20 ms between `session/prompt` and the first text, around a 300 ms model call.

## Tokens

- A one-line prompt in a folder the CLI does not trust costs 11,882 input tokens per model call, on Auto and on Flash. That is the CLI's own system prompt and tool declarations, which every model call of a turn sends again. In a trusted folder, context files (`GEMINI.md`), MCP servers' tools and skills add to it.
- The `session/prompt` answer carries the standard `usage` (`inputTokens`, `outputTokens`) for the turn, and `_meta.quota` with `token_count` and `model_usage`, one entry per model. A `usage_update` session update follows each model call. A slash command the CLI answers itself reports zeros.
- The counts are each call's prompt and candidate tokens summed over the turn's calls, so a turn with tool calls counts the conversation once per call, as the terminal's `/stats` does.
- Over ACP the CLI answers only `/memory`, `/extensions`, `/init`, `/restore`, `/about` and `/help` itself (their subcommands included); anything else, `/stats` among them, would reach the model as a prompt. GeminiCode keeps the counts itself, on each turn's end in the transcript.

## Prompt enhancement: direct requests or the CLI

`probe-enhance.mts --project <id>`, real account: twelve sample drafts one every 10 seconds, then five at once.

| Route | Answered on the first try | p50 / p95 | Burst of five, slowest |
| --- | --- | --- | --- |
| Direct request, `gemini-3.8-flash` | 12 of 12 | 2.8 s / 4.7 s | 6.2 s |
| Through the CLI, `gemini-3.1-flash-lite`, empty folder (`--via acp --empty-cwd --models gemini-3.1-flash-lite`) | 12 of 12 | 4.8 s / 15.7 s | 22.1 s |
| Through the CLI, `gemini-3.8-flash`, empty folder (`--via acp --empty-cwd`) | 12 of 12 | 10.0 s / 11.5 s | 29.8 s |

- A direct request sends about 1 KB: the draft, a few recent messages and the instructions. A request through the CLI carries its agent prompt and tools as well, about 12,000 tokens, and the CLI opens a session for it first.
- Direct requests carry a User-Agent in the CLI's form (`GeminiCLI-geminicode/<CLI version>/<model> (<platform>; <arch>; acp)`), `user_prompt_id` and `session_id`, as the CLI's own requests do. In the burst Code Assist refused four of them with 429 `RATE_LIMIT_EXCEEDED`, each naming a delay of about a second; the client waited that long and retried, as the CLI does, and all five were answered.
- No rewrite used a tool. Flash-Lite once dropped an `@` mention from its rewrite, which GeminiCode's cleanup puts back; every other automatic check passed on every route.
- Each run, about twenty requests, moved the day's Flash quota by about one percentage point.

So Enhance prompt is a direct request on the inline-edit model, and goes through the CLI (Flash-Lite in an empty folder) only when direct requests are off, cannot use the sign-in, or failed in the last five minutes.

## A project's coordinator and threads

All of a project's sessions share one `gemini --acp` process, which runs on one thread, so the question is whether a busy thread's stream holds up the others. `npm run spike-coordinator` (in `extensions/gemini`), stand-in, each chunk carrying the time it was sent:

| Load, 40 chunks 25 ms apart, three rounds | Delay from send to arrival, median | p95 |
| --- | --- | --- |
| One session alone | 2 ms | 3 ms |
| A coordinator and five threads at once | 2 ms | 8 ms |

That is 5 ms extra per chunk at p95, against a budget of 50 ms, so one CLI process holds a project.

How well a Flash model keeps to the coordinator's role needs a real account. `npm run spike-coordinator -- --real --model gemini-3.8-flash` sends a coordinator five scripted asks in a small git repository in a temporary folder, lets the threads it starts work in their own worktrees, and prints a go or no-go. On the real account:

| Measure | Result |
| --- | --- |
| Kept to its role: no edits or commands of its own | yes |
| Asks handled as expected (one thread; a status answer; two threads; a note to the running thread; a thread for a question that needs the code read) | 5 of 5 |
| Coordinator turns before each thread started | 1 |
| Time from an ask to its thread starting | 39.3 s (the first, with the session's start) and 9.9 s |
| Coordinator turn, median | 12.7 s |
| Tokens per coordinator turn, median | 43,174 in, 138 out |
| All five coordinator turns | 208,036 tokens |
| Threads that called `report` | 4 of 4 |

- A coordinator turn makes several model calls (the wake, each tool call, the closing post), and each sends the CLI's prompt, the project's tools and the conversation again, so its input is several times a plain prompt's 11,882. That makes the coordinator cheap per turn in time and costly in tokens. A thread's `report` therefore does not wake it: only the user's messages do, and reports reach it as context with the next one.
- The CLI titles an MCP tool's permission request by the tool and its arguments only, without the server's name; GeminiCode tells the project's tools apart by name.

Verdict: go. Projects ship as a preview behind `gemini.projects.enabled`.

## Reopening a session (`session/load`)

Read from the CLI and checked by `realAgentSessions.test.ts`:

- `session/load` takes `sessionId`, `cwd` and `mcpServers` and finds the session among the chat files the CLI saves for the folder: `~/.gemini/tmp/<project>/chats/session-<time>-<first 8 characters of the id>.jsonl`, where `<project>` is the short name `~/.gemini/projects.json` gives the folder (older CLIs used a SHA-256 of its path). The CLI matches the exact id and does not reset the session, so the same session reopens again and again.
- A chat is saved only once it has messages, so an empty session cannot be reopened. Like `session/new`, it needs `security.auth.selectedType` in the user's settings.
- It replays the history as `session/update` notifications without waiting for them, so some arrive after the answer, which carries the modes and models but not the session id. Each saved message becomes text through the CLI's verbose converter, so thoughts, tool calls and tool results come through as markers (`[Thought: true]`, `[Function Call: replace]`, and tool results, which the CLI saves as user messages, as user messages such as `[Function Response: run_shell_command]`). A pasted image is `[Image: image/png, 45.2 KB]`.
- It sends one update per user message with any text or part, and per model message one per thought, one for its text or parts and one per tool call. GeminiCode works the count out from the session file (`replayUpdateCount`), holds a prompt until the counted replay is over (or no update came for 250 ms), keeps replayed updates apart from the new turn, and strips the markers wherever the replay is shown.
- Tool calls replay with title, kind, locations, diffs and text only, so a client cannot rebuild its own view from the replay. GeminiCode keeps its own copy of each conversation for display and uses `session/load` only so the agent remembers it.
- The chat file is append-only JSON lines. When the conversation changes in place, the CLI appends a `$patch` record (new content for messages, tool results, `removeIds` and `orderIds`) rather than rewriting it, and `/rewind` appends `{"$rewindTo": <message id>}`. GeminiCode applies both when it reads a file.
- The CLI keys a folder in `projects.json` by its path as given (`path.resolve`, not the real path). The terminal's folder is its process's working folder, which is always the real path; an ACP session's is the `cwd` the client sends. For a workspace opened through a symbolic link the two differ, so sessions started in the terminal there are saved under another key, and neither the CLI over ACP nor **Pick Up a Gemini CLI Session** finds them. Found when `realAgentSessions.test.ts` failed in macOS's temporary folder, which is a link; the test now works in the real path.

## Signing in

- With no `security.auth.selectedType` in `~/.gemini/settings.json`, `session/new` falls back to the API-key auth type and fails with `-32000 "Gemini API key is missing or not configured."`. The client treats that error, and `-32000 "Authentication required."`, as sign-in required, calls `authenticate("oauth-personal")` once and retries. `realAgent.test.ts` checks this.
- `authenticate` writes `security.auth.selectedType` into the user's settings, so GeminiCode calls it only when a session says sign-in is required.
- With `oauth-personal` selected and no saved credentials, the CLI starts signing in while it starts, before it answers `initialize`. With no browser (a headless or SSH session) it falls back to a user code read from standard input, which over ACP is the protocol stream: it reads protocol messages as the code, fails ("Failed to authenticate with user code"), and exits with code 41 (`FATAL_AUTHENTICATION_ERROR`). The sidecar does not restart after code 41, and the IDE offers **Complete Setup in Terminal**, which runs the interactive `gemini` with the same environment and restarts the agent when the terminal closes.
- Not yet checked: that the browser sign-in in ACP mode writes nothing to standard output.

## Error strings

The CLI turns setup failures into JSON-RPC error `-32000` with a message string. The fixtures are in `extensions/gemini/test/fixtures/agentErrors.json`.

- No project: "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var. …". The real account above gives exactly this without `--project`.
- A project number: "Invalid Google Cloud Project ID: "…". …", checked before any network call.
- A failed user-code sign-in: "Failed to authenticate with user code" (or "with authorization code").
- Auto Edit or YOLO in a folder the CLI does not trust: "Cannot enable privileged approval modes in an untrusted folder."
- Outside `authenticate` and `session/new`, a failure is a generic "Internal error" with the CLI's message in `data.details`, which the IDE reads instead.
- `IneligibleTierError` and `ValidationRequiredError` carry text from the server, so they cannot be matched by pattern; they show as they come.

The CLI reads `GOOGLE_CLOUD_PROJECT`, then `GOOGLE_CLOUD_PROJECT_ID`, and not `GOOGLE_CLOUD_QUOTA_PROJECT`. GeminiCode resolves the project itself and always passes `GOOGLE_CLOUD_PROJECT`.

## File requests and permissions

Read from `AcpFileSystemService` and the tool-confirmation code:

- The CLI sends `fs/read_text_file` and `fs/write_text_file` only for its `read_file`, `write_file` and `edit` tools, and only for paths inside the session's `cwd` and outside `~/.gemini`. Its shell, `grep`, `glob` and `ls` tools read the disk themselves. It never sends `line` or `limit`; GeminiCode honours them anyway.
- A client error does not fall back to the disk: the tool call fails with the error's message, which the model sees.
- `normalizeFileSystemError` is meant to turn "Resource not found" into `ENOENT`, but the CLI's connection rejects with the plain JSON-RPC error object, so the check reads `[object Object]` and never matches. `write_file` would then fail to create any new file ("Error checking existing file: Resource not found"). GeminiCode therefore answers a read of a missing file with empty text. That is safe because `read_file` checks the disk for the file before it asks the client, so only `write_file` and `edit` see the empty text. One side effect: `edit` with an empty `old_string` reports "already exists" for a missing file instead of creating it, and the model falls back to `write_file`.
- Before an edit, the CLI sends a `tool_call` and then `session/request_permission` whose `toolCall.content` holds a `diff` (`path`, `oldText`, `newText`; `oldText` is empty for a new file). The options come from `toPermissionOptions`: `proceed_once`, `proceed_always` ("Allow for this session"), `proceed_always_and_save` only when permanent approval is on, and `cancel`. The IDE shows whatever options arrive.
- For an MCP tool, "Allow for this session" covers every tool of that server. The title of an MCP tool's request names the tool and its arguments, not the server.

## Approval modes and the CLI's own changes

- The CLI tells the client about a mode change it makes itself with message text, `[MODE_UPDATE] <mode>` (`handleApprovalModeChanged`), not with `current_mode_update`. It does that when it leaves Plan once a plan is approved, and when an edit is allowed for the session: `updatePolicy` then switches to Auto Edit even from YOLO (`isAutoEditTransition`), so YOLO would start asking again. GeminiCode reads the exact text, follows the change and puts the user's YOLO straight back; a permission request that still arrives in YOLO is allowed at once, except for the confirm class.
- Switching to or from YOLO or Plan clears the turn's routed model (`clearCurrentSequenceModel`), so on Auto the rest of the turn is routed again. GeminiCode therefore sends a YOLO picked during a turn on Auto to the CLI when the turn ends, and allows requests itself until then.
- Before every shell command the CLI runs a taint check (`hasTaintedOrBuildFileRisk`): a command that reuses a path or a flag's value seen in earlier tool output, or a build command after build files changed, always asks, and its "Allow for this session" is accepted but not kept. ACP still offers the option and sends no taint details. GeminiCode keeps its own session approvals of shell programs (`sessionApprovals.ts`), which lapse for task runners when the agent writes a build file.
- A shell request's title is the whole command.
- The CLI reads its trusted folders once per process (`loadTrustedFolders`), so a folder trusted while it runs counts only after a restart.

## The model list

The CLI builds the models it sends in `session/new` (`buildAvailableModels`) apart from the terminal's `/model` dialog, from the same groups: Auto, the preview models, then 2.5 Pro and the default Flash and Flash-Lite. The real account's list:

```
auto, gemini-3.1-pro-preview, gemini-3.8-flash, gemini-2.5-pro, gemini-3.8-flash, gemini-3.1-flash-lite
```

- The app list never removes a repeat. With the newest Flash on a Google sign-in, the preview Flash and the default Flash are the same model (`setFlashModels`), so it is listed twice. The terminal keeps the first.
- The terminal lists the default Flash-Lite before Flash; the app list has them the other way round.
- The terminal adds the Gemma models unless `experimental.gemma` is off, and hides Pro models from an account without Pro access (`getProModelNoAccess`). The app list does neither, and `session/set_model` accepts any of them.

`modelList.ts` applies these rules so the picker lists what the terminal does, reading Pro access from the quota. `realAgentModels.test.ts` checks the shaped list against the real CLI with an API key.

## MCP servers, folder trust and policies

- In a folder the CLI does not trust, a session loads no MCP servers at all, not even those the client passes in `session/new`'s `mcpServers`, and no project settings or skills. That is why a project asks to trust its coordinators' and threads' folders.
- Trust follows the longest matching rule in `~/.gemini/trustedFolders.json` (`TRUST_FOLDER`, `TRUST_PARENT` or `DO_NOT_TRUST`), so trusting `~/.geminicode/projects` and `~/.geminicode/worktrees/<repository>` covers every coordinator and thread folder under them.
- An MCP server that cannot start is reported with the reason; `realAgentMcp.test.ts` checks it.
- A policy rule with `mcpName` does not match a server the session brings in `mcpServers`, so rules for those servers name each tool as the model calls it, `mcp_<server>_<tool>`. `realAgentPolicy.test.ts` checks GeminiCode's admin policy against the CLI: modes turned off, shell off, the environment commands refused, and the confirm class asking in every mode.
- `--allowed-mcp-server-names` outranks `mcp.allowed` in any settings file.

## Workspace index

The index (ADR 0010) relies on these, measured on 22 Oct 2026 on the development Mac with the indexer process GeminiCode ships (`dist/indexer.js`):

- **Read from the build.** The app's runtime (Electron 43.7.7, Node 24.21.0) has `node:sqlite` with SQLite 3.53.4, FTS5, WAL, `VACUUM INTO` and `backup()`, so the index needs no native module. The release build keeps only six tree-sitter grammars (TypeScript, CSS, Bash, INI, PowerShell, regex; `build/.moduleignore`), which is why definitions come from line patterns. The app's ripgrep (`@vscode/ripgrep-universal`) is unpacked from the archive, so the indexer can run it while a build is under way.
- **Measured, this repository** (20,227 indexed files, 181,000 definitions): a first build took 26 s in the background at nice 19 and wrote 314 MB; a reconcile with nothing changed took 0.85 s; warm searches answered in 1 to 30 ms and symbol lookups in under 10 ms; the process used about 330 MB. Before chunk text was compressed the file was 537 MB, and checking it with `PRAGMA quick_check` on open took 5 s, which is why opening checks only the schema.
- **Measured, a typical folder** (`extensions/gemini`, 519 files): built in 0.6 s into 7 MB; searches answered in about 1 ms.
- **Ranking.** Without word positions (`detail=column`) the file was 31 MB smaller here, but BM25 then counts a word only once per column and ranked short Markdown chunks above definitions, so positions stay, and the chunk that defines a queried name is put first.
- **Ripgrep.** The CLI's `grep_search` uses `bundle/vendor/ripgrep/rg-<platform>-<arch>` or an `rg` in a system folder (`/usr/bin`, `/opt/homebrew/bin` and the like), and falls back to `git grep` otherwise ("Ripgrep is not available. Falling back to GrepTool."). The npm package ships neither, so GeminiCode's copies always fell back. On `cms-vca2` (19,800 files) one search took 2.4 to 7.3 s with `git grep` and 0.6 to 2.2 s with ripgrep; an agent runs 5 to 10 a question. GeminiCode now copies the app's ripgrep there (`cliRipgrep.ts`).
- **Agents with and without the index** (real sessions, `gemini-3.8-flash`, `cms-vca2`, four questions with checked answers, every answer correct in every setup). With the tools listed but no nudge, the model mostly kept to `grep_search`; median 60 s with no index, 58 s with it. Sending one line asking it to use the index tools first (`indexHint`) made it call `code_search` or `find_symbol` first every time: median 36 s against 60 s in one round, and fewer tool calls (5.8 against 7.3) and input tokens (469k against 614k, a quarter less) in another, where the medians matched. Each model call carried about 70,000 tokens of the repository's own context files, which dominates time and cost either way. The model often re-reads and re-greps what the index found, which results now advise against; an open-ended question ("where is the front-end wishlist code?") ran past four minutes in every setup.
- **What a model call carries.** One "reply OK" prompt with `gemini-3.8-flash` in `cms-vca2`: 63,547 input tokens with its GitLab (58 tools) and Jira MCP servers, 32,209 with neither, 9,620 in an empty folder. So the CLI's own prompt and tools were 15%, the context files (`GEMINI.md` importing nine rule files, 68 KB, and the skills list) 36%, GitLab's tools 32% and Jira's 17%; GeminiCode's own servers added about 4,200. Every step of an agent sends all of it again. Project Helpers' **Measure** (`contextCost.ts`) repeats this measurement for any folder.
- **Read from the CLI.** In ACP mode the CLI finds code with `glob`, `grep_search` (ripgrep), `list_directory`, `read_file` and `read_many_files`, plus the `codebase_investigator` subagent, one model call each; nothing indexes the codebase. MCP tools from `mcpServers` reach the model as `mcp_<server>_<tool>` only in trusted folders (above).

## Attached context and tool images

- A `resource_link` with a `file://` URI is read like an `@path` in the terminal: the CLI reads the file itself, skipping git-ignored files and asking before files outside the workspace, so attaching a file sends only its path. An embedded `resource` is added as context and shown to the model as `@<uri>`, so selections carry a `#L<start>-L<end>` fragment. `image` blocks become inline data.
- For a model whose name starts with `gemini-3-` (`supportsMultimodalFunctionResponse`), the CLI puts a tool's image inside the function response rather than beside it. Whether those models see the image was not checked against the real service, so for them, and on Auto, `browser_screenshot` also returns the page's text snapshot.

## Forking and compacting a session

Read from gemini-cli 0.64.0's bundle and checked by `realSessionSnapshot.test.ts`:

- **No fork over ACP.** The ACP library the CLI bundles routes `session/fork` to `agent.unstable_forkSession`, which the Gemini agent does not implement, so the call fails as an unknown method; `sessionCapabilities` advertises neither fork nor resume.
- **ACP's commands.** ACP mode registers six commands: `memory`, `extensions`, `init`, `restore`, `about` and `help`. `/chat save` and `/chat resume` (chat checkpoints) and `/compress` exist only in the terminal UI.
- **`/restore` over ACP** needs `general.checkpointing.enabled`, under which the CLI writes a checkpoint (a shadow Git commit plus the history) before each tool call that edits files. Restoring puts the files back but only reports "Loaded history with N messages": the history never reaches the session. Checkpoints are kept per folder, so a session in another folder can't see them.
- **Compression** runs when a request would pass `model.compressionThreshold` of the model's limit (0.5 by default): it truncates large tool output, summarises the oldest 70% into a `<state_snapshot>` with the model, and keeps the newest 30%. The result replaces the history in memory only; no record of it is written to the chat file, so `session/load` rebuilds the whole history. Across 30 saved sessions over 50k tokens, the file's history was up to 7.6M tokens while the last request sent 60k: a session reopened, or copied whole, starts far larger than it last ran.
- **A copied chat file loads.** A copy with a new `sessionId` (and the target folder's `projectHash`) in another registered folder's chats folder opens there with `session/load`, tool calls replayed, and the next request carries its history. A folder is registered in `projects.json` when the CLI first opens a session there.
- **The session context is rebuilt.** On load the CLI drops saved user messages that start with `<session_context>` and puts a fresh one first, for the folder the session opens in, so a copy's workspace paths are the new folder's.
- **Paths outside the folder are refused.** In the copy, a write to the parent's folder fails with "Path not in workspace ... resolves outside the allowed workspace directories".
- A loaded session starts on Auto unless a model is set, so its first request routes through Flash-Lite first.

## Steering a running turn

Read from gemini-cli 0.64.0's bundle and the 0.67.0 nightly of 2026-10-23 (the ACP loop is the same in both):

- **The terminal UI queues by default.** A message typed while the agent works waits and goes as the next prompt once the turn ends.
- **Steering mid-turn is terminal-only and experimental.** With `experimental.modelSteering` on (off by default), a message typed while tools run is kept as a `user_steering` injection (`injectionService.addInjection`) and put in front of the next tool results as "User steering update", with `USER_STEERING_INSTRUCTION` telling the model to change only the tasks it affects. That happens in the terminal UI's `useGeminiStream`, not in core.
- **ACP has neither.** The ACP session's `prompt()` sends each round's tool results straight back (`currentParts = toolResponseParts`) without reading injections, and the agent has no extension method or notification for a client to add one. A second `session/prompt` while one runs aborts the running one first (`pendingPrompt.abort()`).
- **Hooks are no way in.** `BeforeAgent` fires once per prompt id, `AfterTool` does not run on the ACP tool path (`runTool` calls `invocation.execute` directly), and `BeforeModel` changes only the one request.

So the chat steers by stopping at a point where no tool runs and sending the message straight away, with the CLI's own steering wording as a hidden note (`promptQueue.ts`).

## Subagents

The CLI's `invoke_agent` tool reaches ACP as one `think` tool call titled `Delegating to agent '<name>'` and its final report. The subagent's own steps are not sent.

## The telemetry file

With `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OUTFILE=<file>` and `GEMINI_TELEMETRY_LOG_PROMPTS=false`, the CLI writes JSON objects back to back, not one per line. A one-prompt run against the stand-in wrote the events `gemini_cli.config`, `gemini_cli.startup_stats` (the start-up phases, each with `duration_ms`), `gemini_cli.user_prompt`, `gemini_cli.model_routing` (`routing_latency_ms`, `decision_model`), `gemini_cli.api_request` and `gemini_cli.api_response` (`model`, `duration_ms`, `input_token_count`, `cached_content_token_count`, `output_token_count`, `thoughts_token_count`, `role`), and the metrics `gemini_cli.startup.duration`, `gemini_cli.api.request.latency`, `gemini_cli.model_routing.latency` and `gemini_cli.token.usage`. A turn with tools adds `gemini_cli.tool_call`. GeminiCode's trace reader (`parseTraceFile`, `summarizeTrace` in `traceRecording.ts`) reads that file. With prompts off it still carries the CLI's system prompt and tool declarations as span attributes, but no prompt or reply text.

## Usage statistics and chat files

- With usage statistics on, the CLI posts to `play.googleapis.com` in the background.
- The CLI appends a few lines per prompt to the session's chat file, and by default deletes chats older than 30 days (`general.sessionRetention`).

## The chat view and bundles

Measured with GeminiCode's own code, not the CLI:

- Re-rendering only the blocks of a streaming reply after its last finished one keeps an update at about 2 ms for a 30 KB reply; re-rendering the whole reply cost about 25 ms. `test/perf/budgets.test.ts` times this and the other paths a user waits on (a keystroke, a streamed chunk, switching agents, Enter to the first chunk, a 500-thread project) and fails CI past each budget; all 16 checks pass.
- Production bundles: `dist/extension.js` 1,178,837 bytes, `media/chat.js` 240,543, `media/draftMarkdown.js` 126,052, `media/home.js` 25,894, `media/teamFlow.js` 25,130. KaTeX (271,660) and the highlighter (158,012) load only when a reply needs them. The ACP SDK and zod are in `extension.js` but run only when the first agent starts, not at activation.
