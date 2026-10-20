*GeminiCode v1.2.0, and the idea behind it: Harness Engineering* :gear:

Until now my updates have been lists of features. This time I want to share the idea that ties them together.

An agent is a model plus a *harness*. The model is the engine. The harness is everything around it: what context goes in, which tools it can reach, what it may do without asking, how its work is checked, what gets recorded, and how it recovers when something breaks. Two products on the same model can feel completely different, and the difference is almost entirely the harness.

GeminiCode is a harness. We don't patch or fork the Gemini CLI: we run the official `gemini --acp`, unchanged, with your own sign-in and Code Assist license, and engineer everything around it. Here is how this release fills in each part of the harness:

• *Context in:* paste a Jira key or a GitLab/Figma link and it becomes a chip the agent reads. A checked-in `.gemini/geminicode-tools.json` gives every agent the team's defaults. Ticket and MR text is marked as information from other people, never as instructions.
• *Tools:* one `geminicode-tools` MCP server for Jira, GitLab, SonarQube, Snyk and Figma, using your own tokens from the macOS keychain. Reads run freely, and writes go through you.
• *Guardrails:* moving a ticket, logging time, opening and merging an MR always ask, even in YOLO. Secret files stay unreadable, commands that print the environment are refused, and admins can allow-list MCP servers.
• *Feedback loops:* Run Checks → Fix. A failed pipeline and review threads → "Fix Pipeline and N Comments". Merge turns on only when every GitLab check holds.
• *Observability:* every Jira or GitLab write is in a local audit log, before and after the call. A performance trace shows where each turn's time went.
• *Recovery:* a turn cut off by a quit says so and offers Retry. Unfinished flows wait on Home. Nothing is redone on its own.

*A harness shouldn't slow the engine down.* The Gemini CLI has its own response time, so our rule is to add none of our own. On the way from Enter to the first streamed chunk, GeminiCode adds about *0.2 ms*. Keystrokes and streamed chunks cost tens of microseconds. CI fails the build if any of those paths, or the bundle sizes, go over budget. Agents start on a session that's already open, and the agent process is shared, so a new chat waits for no process start.

The result: the same Gemini, with the context, tools, guardrails and feedback a real team workflow needs, from ticket to merged MR without leaving the editor.

:inbox_tray: Download: https://pulkitjain-org.github.io/vscode-gemini-cli/
:books: Team tools guide: https://pulkitjain-org.github.io/vscode-gemini-cli/docs/team-tools.html

I'd love to hear which part of the harness you'd want tightened next. Reply in thread :thread:
