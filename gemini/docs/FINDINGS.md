# Findings against the real CLI

Checked against `@google/gemini-cli@0.62.0` on 2 Oct 2026. Each item says which plan correction it informs.

## `session/new` without credentials (C3, C4)

With no `security.auth.selectedType` in `~/.gemini/settings.json`, `session/new` defaults to the API-key auth type and fails with `-32000 "Gemini API key is missing or not configured."`. The client treats that error, and `-32000 "Authentication required."`, as `auth-required`. It then calls `authenticate("oauth-personal")` once and retries. CI checks this against the `latest` and `preview` CLI in `extensions/gemini/test/acp/realAgent.test.ts`.

## OAuth with no browser (C4)

With `selectedType` set to `oauth-personal` and no cached credentials, the CLI starts the login while it is still starting up, before it answers `initialize`. With no browser available (a headless or SSH session), it falls back to the user-code flow and reads the code from **stdin**. That is the JSON-RPC stream, so it consumes protocol messages, reports `invalid_grant`, and exits with code **41** (`FatalAuthenticationError`). The sidecar treats exit code 41 as fatal and does not restart. The IDE offers **Complete Setup in Terminal**, which runs the interactive `gemini` with the same environment and restarts the agent when the terminal closes.

Still to verify on a maintainer desktop: the browser flow in ACP mode, and that it writes nothing to stdout.

## Error strings (C3)

These messages come from `packages/core/src/code_assist/setup.ts`. The fixtures are in `extensions/gemini/test/fixtures/agentErrors.json`.

- `ProjectIdRequiredError`: "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var. …"
- `InvalidNumericProjectIdError`: "Invalid Google Cloud Project ID: "…". The GOOGLE_CLOUD_PROJECT …". The CLI checks this before any network call.
- `IneligibleTierError` and `ValidationRequiredError` carry server-provided text, so they cannot be matched by pattern yet. They fall back to the raw message until a licensed smoke run captures them.

The CLI reads `GOOGLE_CLOUD_PROJECT`, then `GOOGLE_CLOUD_PROJECT_ID`. It does not read `GOOGLE_CLOUD_QUOTA_PROJECT`. The IDE resolves the project itself and always passes `GOOGLE_CLOUD_PROJECT`.

## File requests and permissions (C1, C5)

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
