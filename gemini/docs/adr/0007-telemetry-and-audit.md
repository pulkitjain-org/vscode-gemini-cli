# ADR 0007: Telemetry is the CLI's OpenTelemetry export; audit is an append-only local log

**Status:** accepted.

## Context

The pinned CLI emits OpenTelemetry metrics and events (`gemini_cli.api.request.latency`, `gemini_cli.model_routing.latency`, `gemini_cli.tool.call.latency`, `gemini_cli.token.usage` with a `cache` type, `gemini_cli.api_response` with `cached_content_token_count`) to a local file or an OTLP endpoint. The fork emits no telemetry of its own, and nothing ties a Jira or GitLab change to the agent turn and the approved text.

## Decision

- Performance traces are the CLI's export to a local file, turned on by a command for one agent restart, with `logPrompts` off. No collector and no cloud target without a separate decision.
- The client audit log is append-only JSONL per day in global storage: time, agent, caller, tool, argument hash, approved-text hash, permission outcome, remote id. It is readable from the app and exported for the pilot by hand.
- No data leaves the Mac on its own.

## Consequences

- The latency budget's "real" column comes from the same export every time, so numbers are comparable across releases.
- The audit log is evidence only when joined to the tool's own history by remote id.

## Evidence

The events and metrics in a file gemini-cli 0.64.0 wrote ([FINDINGS.md](../FINDINGS.md#the-telemetry-file)), which `traceRecording.ts` reads; `auditLog.ts` and its tests.
