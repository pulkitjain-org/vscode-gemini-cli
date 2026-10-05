# Findings against the real CLI

What GeminiCode's design relies on, checked against `@google/gemini-cli@0.62.0` on 2 Oct 2026. Re-check these when moving to a new CLI version; [ARCHITECTURE.md](ARCHITECTURE.md) explains how each one is used.

## `session/new` without credentials

With no `security.auth.selectedType` in `~/.gemini/settings.json`, `session/new` defaults to the API-key auth type and fails with `-32000 "Gemini API key is missing or not configured."`. The client treats that error, and `-32000 "Authentication required."`, as `auth-required`. It then calls `authenticate("oauth-personal")` once and retries. CI checks this against the `latest` and `preview` CLI in `extensions/gemini/test/acp/realAgent.test.ts`.

## OAuth with no browser

With `selectedType` set to `oauth-personal` and no cached credentials, the CLI starts the login while it is still starting up, before it answers `initialize`. With no browser available (a headless or SSH session), it falls back to the user-code flow and reads the code from **stdin**. That is the JSON-RPC stream, so it consumes protocol messages, reports `invalid_grant`, and exits with code **41** (`FatalAuthenticationError`). The sidecar treats exit code 41 as fatal and does not restart. The IDE offers **Complete Setup in Terminal**, which runs the interactive `gemini` with the same environment and restarts the agent when the terminal closes.

Still to verify on a desktop: the browser flow in ACP mode, and that it writes nothing to stdout ([ROADMAP.md](ROADMAP.md)).

## Error strings

The project messages come from `packages/core/src/code_assist/setup.ts`. The fixtures are in `extensions/gemini/test/fixtures/agentErrors.json`.

- `ProjectIdRequiredError`: "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var. …"
- `InvalidNumericProjectIdError`: "Invalid Google Cloud Project ID: "…". The GOOGLE_CLOUD_PROJECT …". The CLI checks this before any network call.
- A failed user-code sign-in: "Failed to authenticate with user code …" (or "authorization code").
- From 0.62.0, picking Auto Edit or YOLO in a folder the CLI does not trust fails with "Cannot enable privileged approval modes in an untrusted folder." The IDE offers to trust the folder ([USING.md](USING.md#folder-trust)).
- Outside `authenticate` and `session/new`, the CLI answers a failure with a generic "Internal error" and puts its own message in `data.details`, which the IDE reads instead.
- `IneligibleTierError` and `ValidationRequiredError` carry server-provided text, so they cannot be matched by pattern yet. They fall back to the raw message until a licensed smoke run captures them.

The CLI reads `GOOGLE_CLOUD_PROJECT`, then `GOOGLE_CLOUD_PROJECT_ID`. It does not read `GOOGLE_CLOUD_QUOTA_PROJECT`. The IDE resolves the project itself and always passes `GOOGLE_CLOUD_PROJECT`.

## File requests and permissions

From `AcpFileSystemService` and the tool-confirmation code in 0.62.0:

- The CLI calls `fs/read_text_file` and `fs/write_text_file` only for the `read_file`, `write_file` and `edit` tools, and only for paths inside the session `cwd` and outside `~/.gemini`. Everything else reads the disk directly.
- It never sends `line` or `limit`. The IDE honours them anyway.
- A client error does **not** fall back to the disk; it fails the tool call with the error's message, which the model sees.
- **CLI bug, 0.62.0 through 0.64.0 nightly:** `normalizeFileSystemError` is meant to turn "Resource not found" into `ENOENT`, but the CLI's connection rejects with the raw JSON-RPC error object, so the check sees `[object Object]` and never matches. `write_file` then fails to create any new file ("Error checking existing file: Resource not found"). The IDE therefore answers a read of a missing file with empty content. This is safe because `read_file` checks the disk for existence before it asks the client, so only `write_file` and `edit` see the empty text. One side effect: `edit` with an empty `old_string` reports "already exists" for a missing file instead of creating it, and the model falls back to `write_file`. So the IDE's access policy (secrets denylist, `.gitignore` for reads, workspace folders only) holds for these three tools. It does not cover shell, `grep`, `glob` or `ls`, which run inside the sidecar.
- Before an edit, the CLI sends a `tool_call` and then `session/request_permission` whose `toolCall.content` holds a `diff` (`path`, `oldText`, `newText`; `oldText` is empty for a new file). The options come from `toPermissionOptions`: `proceed_once`, `proceed_always` ("Allow for this session"), `proceed_always_and_save` only when permanent approval is enabled, and `cancel` (reject). The IDE renders whatever options arrive.

## Agent startup time

Measured with gemini-cli 0.62.0 on a 4-core Linux machine, three runs each, from spawning the agent to the `initialize` response (`session/new` adds about 75 ms):

| Launch | `initialize` |
| --- | --- |
| Default: the CLI's entry point starts a second Node process to raise its heap limit | 1.75–1.97 s |
| `GEMINI_CLI_NO_RELAUNCH=true`, so one process | 1.10–1.21 s |
| One process plus `NODE_COMPILE_CACHE` | 1.25–1.28 s (no gain) |

The relaunch always happens unless `GEMINI_CLI_NO_RELAUNCH` is set, even when the heap is already large enough. So the agent is started with `GEMINI_CLI_NO_RELAUNCH=true` and the heap the CLI would pick (half the machine's memory, unless `advanced.autoConfigureMemory` is false in `~/.gemini/settings.json`). For a JavaScript entry point the heap flag goes on the Node command line. For a `gemini` executable it goes in `NODE_OPTIONS`, as the CLI does for its single-file binary. That saves about 0.65 s, roughly a third of startup.

Without the wrapper process, two things change. The CLI asks its wrapper to restart it by exiting with code 199, so the sidecar now restarts it at once on that code (at most three times before the normal crash handling). The wrapper also forwards admin settings over IPC between relaunches; the CLI only does that when `process.send` exists, so it is skipped. The interactive terminal used for sign-in keeps the CLI's default behaviour.

## Attached context

gemini-cli 0.62.0 advertises `promptCapabilities` `image`, `audio` and `embeddedContext`. A `resource_link` with a `file://` URI is resolved like an `@path` in the terminal: the CLI reads the file itself (skipping git-ignored files, and asking permission for files outside the workspace), so attaching a file sends only its path. An embedded `resource` is added as context and shown to the model as `@<uri>`, so selections carry a `#L<start>-L<end>` fragment in their URI. `image` blocks become inline data.

## Several sessions in one agent process

Measured with gemini-cli 0.62.0 on a 4-core Linux machine, with an API-key auth type and a placeholder key so `session/new` succeeds without the network:

| Step | Time | Memory (RSS) |
| --- | --- | --- |
| New process, to the `initialize` response | 1.12–1.23 s | about 230 MB |
| Each further `session/new` in that process | 25–41 ms | about 2.5 MB more per session |

Twenty sessions alternating between two folders took 25–41 ms each, and the process grew from about 231 MB to 274 MB. Each session loads the settings of its own `cwd`, so one process serves agents in different folders. The process environment (such as `GOOGLE_CLOUD_PROJECT`) is shared, so agents that need another project ID need another process.

gemini-cli 0.62.0 advertises `loadSession` but implements neither `session/list` nor `session/close` over ACP. Sessions stay in the process until it exits, and a resumable list has to come from the client.

## Reopening a session (`session/load`)

Read from the gemini-cli 0.62.0 bundle:

- `session/load` takes `sessionId`, `cwd` and `mcpServers` and finds the session among the chat files the CLI saves under its project temp folder (`chats/session-*-<short id>.json`). A chat is saved only once it has messages, so an empty session cannot be reopened.
- It needs `security.auth.selectedType` in the user's settings, like `session/new`; without it the request fails with auth required.
- It replays the history as `session/update` notifications (user and agent messages, thoughts, tool calls) without waiting for them, so some can arrive after the response. The reply carries modes and models but not the session id.
- Tool calls replay with title, kind, locations, diffs and text only, so a client cannot rebuild its own view from the replay.

GeminiCode therefore keeps its own copy of each agent's conversation for display and uses `session/load` only so the agent remembers it. The replay arrives outside a turn and the chat ignores it. If the user sends a prompt while a long replay is still streaming, the tail of the replay could show in that turn; it has not been seen in practice.

## Prompt enhancement: direct requests or the CLI

Measured on 5 Oct 2026 on a Gemini Code Assist account (Google sign-in) with `extensions/gemini/scripts/probe-enhance.mts`: twelve sample drafts, one every 10 seconds, then five at once.

| Route | Answered | p50 / p95 |
| --- | --- | --- |
| Direct request (`DirectClient`), Flash | 2 of 12 | n/a |
| Direct request, Flash-Lite or Pro | 2 of 12 each | n/a |
| The CLI over ACP, Flash, session in the repository | 12 of 12, first try | 12.3 s / 16.5 s |
| The CLI over ACP, Flash-Lite, session in an empty folder | 12 of 12, first try | 5.0 s / 9.4 s |
| Direct request with the CLI's User-Agent, prompt id and session id, Flash (gemini-3.8-flash) | 12 of 12, first try | 3.4 s / 4.8 s |

- Direct requests to Code Assist were refused with 429 `RATE_LIMIT_EXCEEDED` ("Your quota will reset after N s") after about one request a minute, in each quota bucket: every Flash model shares one, and Flash-Lite and Pro have their own. Daily use stayed under 1%. The CLI's own requests on the same account were not limited this way. The CLI names itself on each request (User-Agent `GeminiCLI-<client>/<version>/<model> (…)`, `user_prompt_id`, `session_id`), and direct requests did not.
- With those three added (`DirectClient` now sends them, naming the CLI version GeminiCode runs), the same account answered 12 of 12 spaced direct requests on the first try, including on gemini-3.8-flash, which had refused direct requests before. A burst of five at once was answered too, three after a 429 that asked for under 2 s. So the fields, not the route, decide the limit. Inline edit and commit messages, which use the same client, get the same lift. Measured on 5 Oct 2026 with `probe-enhance.mts`.
- The CLI retries a refused request itself: after the delay the server names for `RATE_LIMIT_EXCEEDED` (up to 300 s, ten attempts), or 1 s then 3 s when the model is out of capacity (`MODEL_CAPACITY_EXHAUSTED`). One of five rewrites sent at once took 43 s while it waited.
- Of a rewrite through the CLI, about 1 s was opening the session and setting its mode and model, which GeminiCode now does ahead of the click; the rest was the model call, slower with Flash because the CLI asks for thinking level HIGH. A session in an empty folder carries no folder context.
- No rewrite used a tool when told not to. Two of twelve began with a `/command` the draft did not have; the prompt now forbids it and the cleanup removes one.
- gemini-cli 0.62.0 implements no `session/close`, so each rewrite's session stays in the agent process until it restarts. GeminiCode closes it when the CLI offers `sessionCapabilities.close`. Measured against a stand-in API, 40 rewrite sessions left the agent's memory flat (162 MB) and 228 KB of chat files on disk: the empty folder is untrusted, so the CLI starts no MCP servers, hooks or project agents there, and a session opens in about 40 ms. (A chat session in a real repository is larger, about 2.5 MB.)
- Each rewrite through the CLI sends about 47 KB: the CLI's agent system prompt (32,500 characters) and 12 tool declarations, with `thinkingLevel: HIGH` even on Flash-Lite. A direct request sends 1 to 2 KB with little thinking, so Enhance prompt now uses one and keeps the CLI for when it fails.
- Setting a session's mode makes gemini-cli 0.62.0 send `[MODE_UPDATE] <mode>` as `agent_message_chunk` text, outside any turn. The rewrite listens only while its prompt runs, and `cleanEnhancedPrompt` strips the notice too.

## Where a prompt's time goes

Measured on 2 Oct 2026 with gemini-cli 0.62.0 in `--acp` mode against a local stand-in for the Gemini API (`GOOGLE_GEMINI_BASE_URL`) that answers at once. The scripts are not in the repo; the method is enough to redo it.

- The CLI adds about 15 ms from `session/prompt` to the first `agent_message_chunk`, and answers `session/prompt` about 3 ms after the stream ends. The first turn of a process is 60 to 80 ms slower.
- With the model on Auto, every prompt first makes a non-streaming routing call to Flash-Lite (JSON output, thinking level HIGH) to choose Pro or Flash. The reply waits for it: a 500 ms delay on that call delayed the first chunk by exactly 500 ms. With a model picked, through `session/set_model` or settings, the call is skipped. Tool-result follow-ups within a turn never make it.
- The main request uses thinking level HIGH. No other model calls happen in a plain turn: in ACP mode the next-speaker check is off, the LLM loop check only starts after 30 model turns, and compression only starts past its threshold.
- The routing call's thinking can only be lowered through `modelConfigs.customOverrides` that match the concrete model (`gemini-3.5-flash-lite`), in user or workspace settings. Matching the `classifier` alias has no effect. GeminiCode cannot supply this through `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, because the CLI ignores system settings and defaults files that fail its ownership check (not admin-owned), so it is left to admins.
- With usage statistics on, the CLI posts to `play.googleapis.com` in the background. These posts never delayed a turn, even when the network blocked them.
- Per prompt, the CLI appends four small lines to its chat file under `~/.gemini/tmp/<project>/chats/`.

In the chat view, re-rendering a whole streaming reply on every update cost about 25 ms per update at 30 KB. Rendering only the blocks after the last finished one costs about 2 ms.
