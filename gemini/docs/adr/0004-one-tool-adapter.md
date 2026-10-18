# ADR 0004: One local adapter serves the agent and the UI

**Status:** proposed.

## Context

Atlassian Rovo and GitLab Duo are disabled, so the Atlassian Remote MCP Server and the GitLab MCP server (both gated on those products) cannot be used. Figma (desktop Dev Mode MCP), Snyk (`snyk mcp -t stdio`) and SonarQube (`sonarsource/sonarqube-mcp`, SonarQube Server 2025.1+) have official servers that need no such product. The fork already serves a local MCP server (`geminicode-tools`) with per-agent tokens and calls the same connectors from Home and the flows.

## Decision

- One `TeamAdapter` in the extension host: a tool registry, a permission class per tool, an audit log, a rate limiter and a short read cache.
- The agent reaches it through `geminicode-tools` over ACP `mcpServers`; the UI calls the same registry in-process. One call path, one audit record.
- Official servers run as children of the adapter (stdio), never from the CLI's settings files, so tokens stay out of the agent's environment and the UI can call them. A curated subset of their tools is re-exposed to keep tool schemas, which every turn pays for, small.
- Jira and GitLab stay as in-process REST connectors behind the same interface; the day an official server becomes usable without Rovo or Duo, it slots in as another child.
- Tool names, `.gemini/geminicode-tools.json` and the SecretStorage keys do not change.

## Consequences

- Java 21 or a container runtime is needed on the Mac for the SonarQube server; the REST fallback stays for machines without it.
- Every write to Jira or GitLab has one audit record joined to the tool's own history by the id the tool returned.

## Evidence

`extensions/gemini/src/acp/teamToolsMcp.ts`, `teamConnections.ts`; official server facts from the vendors' pages via search on 18 Oct 2026 (to be confirmed against each tenant).
