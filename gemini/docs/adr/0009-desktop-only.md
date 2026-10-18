# ADR 0009: Desktop only, no server component

**Status:** accepted: a product constraint, recorded so designs never assume otherwise.

## Context

GeminiCode is a Mac app. When the app quits or the laptop restarts, the extension host, the `gemini --acp` sidecar, the local MCP servers and any child servers end. There is no relay, no hosted agent and no always-on runner owned by this project. The team's existing GitHub Actions and GitLab CI are the only automation, and neither can hold a user's sign-in.

## Decision

- Nothing runs or continues while the app is closed. Work in a turn that was running is lost and said so; it is never replayed on the user's behalf.
- All state is on the Mac: agent records, transcripts, checkpoints, team snapshots and the audit log in the user's Library; tokens in the keychain; worktrees under `~/.geminicode`.
- Every flow that spans a model turn or a remote write keeps a record on disk at each step and registers a serializer, so a restart reopens it where it stopped, and Home lists what is unfinished.
- A write records its intent before the call and its result after. After a restart, an intent without a result is shown, and the flow re-checks the remote before redoing anything.
- A restart never answers a permission request or reuses a session approval; both end with the process.
- Measurement, benchmarks and gates that need a seat run from a developer's Mac by a command; CI runs only what needs no sign-in.

## Consequences

- Cold start after a reboot is a first-class row of the latency budget.
- A resident per-user CLI process, if one is ever built, is bounded to one login; it is never a server.
- The last check results and the flow panels' fields are kept on disk, so Home's Unfinished card can reopen a flow from the same inputs.

## Evidence

The [Restarts](../ARCHITECTURE.md#restarts) table in ARCHITECTURE.md, from `teamFlows.ts`, `flowRecords.ts`, `sessionApprovals.ts`, `agentsView.ts` and `auditLog.ts`.
