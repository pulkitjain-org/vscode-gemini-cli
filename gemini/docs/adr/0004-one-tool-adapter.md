# ADR 0004: One local adapter serves the agent and the UI

**Status:** accepted.

## Context

Atlassian Rovo and GitLab Duo are disabled, so the Atlassian Remote MCP Server and the GitLab MCP server (both gated on those products) cannot be used. Figma (desktop Dev Mode MCP), Snyk (`snyk mcp -t stdio`) and SonarQube (`sonarsource/sonarqube-mcp`, SonarQube Server 2025.1+) have official servers that need no such product. The fork already serves a local MCP server (`geminicode-tools`) with per-agent tokens and calls the same connectors from Home and the flows.

## Decision

- One adapter in the extension host (`TeamConnections`, `teamTools.ts`): the tool list, a permission class per tool, the audit log, timeouts and a short read cache.
- The agent reaches it through `geminicode-tools` over ACP `mcpServers`; the UI calls the same registry in-process. One call path, one audit record.
- Official servers run as children of the adapter (stdio), never from the CLI's settings files, so tokens stay out of the agent's environment and the UI can call them. A curated subset of their tools is re-exposed to keep tool schemas, which every turn pays for, small.
- Jira and GitLab are the community containers the team already runs (`mcp-atlassian`, `gitlab-mcp`), started by the adapter with digests pinned, tokens passed from the keychain into the child's environment only, and only the 14 tools the adapter calls, behind `geminicode-tools`. The agent sees GeminiCode's own tools rather than the 106 the team's filters leave, whose schemas (37,550 + 78,544 bytes) every request would carry. The in-process REST connectors stay behind the same interface for what the containers lack and as the fallback; the day an official server becomes usable without Rovo or Duo, it slots in as another child.
- Tool names, `.gemini/geminicode-tools.json` and the SecretStorage keys do not change.

## Consequences

- Docker is needed on the Mac for the team's servers and SonarQube's; without it the in-process connectors answer.
- Every write to Jira or GitLab has one audit record joined to the tool's own history by the id the tool returned.

## Evidence

`extensions/gemini/src/acp/teamToolsMcp.ts`, `teamContainers.ts`, `mcpStdio.ts`, `src/host/teamConnections.ts`; `test/acp/teamWrite.test.ts` (a page's write and an agent's produce the same audit record) and `teamContainers.test.ts`. The official servers' requirements are from the vendors' pages, to be confirmed against each tenant.
