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
- A client error does **not** fall back to the disk. A message containing "Resource not found" becomes `ENOENT`, and any other error fails the tool call with that message, which the model sees. So the IDE's access policy (secrets denylist, `.gitignore` for reads, workspace folders only) holds for these three tools. It does not cover shell, `grep`, `glob` or `ls`, which run inside the sidecar.
- Before an edit, the CLI sends a `tool_call` and then `session/request_permission` whose `toolCall.content` holds a `diff` (`path`, `oldText`, `newText`; `oldText` is empty for a new file). The options come from `toPermissionOptions`: `proceed_once`, `proceed_always` ("Allow for this session"), `proceed_always_and_save` only when permanent approval is enabled, and `cancel` (reject). The IDE renders whatever options arrive.
