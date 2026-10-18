# ADR 0006: A confirm class of actions that can never be auto-approved

**Status:** proposed.

## Context

The Gemini CLI's permission card for an MCP tool offers "Allow for this session" (`proceed_always`), which the CLI applies to every tool of that server. One click on a harmless comment would make later status changes and time logs silent. Merge requests are the team's gate of record.

## Decision

`gitlab_merge`, `jira_transition`, `jira_log_time` and `gitlab_create_mr` form the confirm class. For them the broker strips every option except allow-once and reject, never answers at once, shows the exact remote effect on the card, and writes the user's choice to the audit log. The UI flows for the same actions require a click on a button that names the effect. A test asserts that no allow-always option reaches the webview for the class.

## Consequences

- Repeated transitions in one session each ask. That is the point.
- The class is extended, never shortened, without a new ADR.

## Evidence

`extensions/gemini/src/acp/permissions.ts` and `FINDINGS.md` on `proceed_always`; the test that closes the hole; audit records with a permission outcome for every confirm-class action in the pilot.
