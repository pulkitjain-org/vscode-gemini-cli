# ADR 0006: A confirm class of actions that can never be auto-approved

**Status:** accepted on 2026-10-18.

## Context

The Gemini CLI's permission card for an MCP tool offers "Allow for this session" (`proceed_always`), which the CLI applies to every tool of that server. One click on a harmless comment would make later status changes and time logs silent. Merge requests are the team's gate of record.

## Decision

`gitlab_merge`, `jira_transition`, `jira_log_time` and `gitlab_create_mr`, and the same actions in a team's own `jira` and `gitlab` servers, form the confirm class. For these actions:

- The broker strips every option except allow-once and reject.
- It never answers at once, not even in YOLO mode.
- The card shows the exact remote effect, and the user's choice is written to the audit log.
- The admin policy makes the CLI ask for them in every mode.
- The UI flows for the same actions need a click on a button that names the effect.

A test asserts that no allow-always option reaches the webview for the class.

## Consequences

- Repeated transitions in one session each ask. That is the point.
- The class is extended, never shortened, without a new ADR.

## Evidence

`extensions/gemini/src/acp/permissions.ts` (`confirmOnly`) and [FINDINGS.md](../FINDINGS.md#file-requests-and-permissions) on `proceed_always`; `test/acp/permissions.test.ts` and `realAgentPolicy.test.ts`; in the pilot, audit records with a permission outcome for every confirm-class action.
