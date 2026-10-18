# ADR 0005: Every action runs with the user's own tokens

**Status:** accepted (current practice, made a rule).

## Context

Jira, GitLab and SonarQube actions must show in those tools' histories under the person who did them. A shared service account would hide who approved what and would need a relay.

## Decision

Tokens are the user's own, stored in VS Code SecretStorage (the macOS keychain), never in settings, repositories or the agent's environment. The Jira token is scoped when the site allows it; the GitLab token is a named PAT with an expiry; Snyk and Figma use the user's signed-in CLI and desktop app. The IDE never holds a service account, and the benchmark runs on a developer's Mac under their own seat.

## Consequences

- Audit evidence is the tool's own history under the user's account.
- Least privilege is bounded by what each vendor offers; server-side rules (approval rules, project permissions) remain the floor.

## Evidence

`extensions/gemini/src/host/teamConnections.ts` (SecretStorage, scope and expiry checks); Jira issue history and GitLab MR activity for actions taken during the pilot.
