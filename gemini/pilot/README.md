# Pilot policy

`GeminiCode-pilot.mobileconfig` is the admin policy for the pilot's Macs ([AGENTIC-PLAN.md](../docs/AGENTIC-PLAN.md), sections 4 and 6). Install it with your device management. It is a macOS configuration profile for the app's own preferences domain, `com.pulkitjainorg.geminicode`, which GeminiCode reads as VS Code reads its policies, so each setting it sets is locked in the app.

| Policy | Value | What it does |
| --- | --- | --- |
| `GeminiAllowedMcpServers` | GeminiCode's own three servers | Agents get no other MCP server, whatever a repository's `.gemini/settings.json` adds. GeminiCode passes the list to the CLI with `--allowed-mcp-server-names`. Take over a repository's Jira and GitLab servers in Connections first, or their tools go away. |
| `GeminiDenyEnvironmentCommands` | on | The CLI refuses `env`, `printenv`, and `set` or `export` alone, even inside a longer command, so no agent can print a token from the environment. `set -e` and other commands still run. |
| `GeminiBrowserAllowedOrigins` | the team's Jira, GitLab and SonarQube, and local dev servers | Agents can open only these sites in the GeminiCode browser. `http://localhost:*` is localhost on any port. Replace the example addresses before you deploy the profile. |
| `GeminiAllowYolo` | off | Every tool that changes something asks. |
| `GeminiPilotRecord` | on | Counts the pilot's measures on the Mac for **Gemini: Export Pilot Data**. |

Two rules hold without a policy, on every Mac. Merging, opening a merge request, moving a ticket and logging time ask every time, with Allow once only, in every mode including YOLO: GeminiCode's admin policy file tells the CLI so, and the chat never answers those for the user. A system policy directory on the Mac, which the CLI also reads, outranks GeminiCode's file.

To check a Mac after installing the profile, open **Settings** and search for `gemini`: each locked setting says it is managed by your organisation.
