# Troubleshooting

What to do when something doesn't work. Most fixes are one command away in the **Gemini** item in the status bar.

## Common problems

| Symptom | What to do |
| --- | --- |
| The status bar says sign-in is needed | Run **Gemini: Sign In with Google**. If it needs a step the editor can't show, run **Gemini: Complete Setup in Terminal**, finish it, and exit with `/quit`. |
| "is a project number" | Set the project ID, such as `my-project-123`, with **Gemini: Set Google Cloud Project ID**. |
| No Gemini CLI found | Only in a build without the bundled CLI. Choose **Install Gemini CLI** in the message, or set `gemini.cliPath`. |
| A program the agent runs cannot find a token that is set in your shell (`GITHUB_TOKEN`, `NPM_TOKEN`) | GeminiCode leaves every variable whose name looks like a credential out of the agent's environment, except the CLI's own `GEMINI_*` and `GOOGLE_*`. Give the program its token another way, such as its own sign-in (`gh auth login`) or a file it reads. |
| "older than 0.66.0" | The CLI in use is too old. Choose **Install Latest**, or pick **Install or Change Gemini CLI Version...** from the Gemini status bar item's menu. |
| Not sure the CLI starts at all | Run **Gemini: Check Agent Connection**. It starts the CLI on its own and reports its version and protocol, or the error. |
| The agent stops or misbehaves | Click the **Gemini** status bar item and choose **Restart Agent**. Open agents resume their sessions. |
| Auto Edit or YOLO is refused | The Gemini CLI won't use them in a folder it doesn't trust. Pick the mode again and trust the folder when asked. |
| An MCP server doesn't load | Check the warning and the server's mark in **Agent Setup**, and **Gemini: Show Log**. A project's servers load only in a trusted folder. |
| Agents are slow on a big project | Open **Agent Setup** and choose **Measure** under **Context per model call**. MCP servers with many tools and long rules files are sent with every step; turn off the servers agents don't need, or trim their `includeTools`. |
| The workspace isn't indexed, or agents don't use the index | Open **Index** on Home. An untrusted folder gets no index tools: choose **Trust Folder**. Check that `gemini.index.enabled` is on. The `gemini` command in your terminal loads the index only if the project's `mcp.allowed` lists `geminicode-index`. |
| A file is missing from the index | **Files Left Out** on the Index page says why; **Index Anyway** adds it, unless it is a secret file or binary. |
| A docs source failed | The Index page names the reason. Pages behind a sign-in can't be indexed, and a site outside `gemini.docs.allowedDomains` can't be added. |
| A reply's commands have no **Run** | Run shows only on shell blocks (`bash`, `sh`, `zsh`, `console`, PowerShell), and not when `gemini.chat.runCommands` is `off`, which your administrator may have set. |
| Run doesn't show how a command ended, or Send Last Command has nothing to send | The terminal's shell has no shell integration. Use zsh, bash, fish or PowerShell, or select the output and use **Send to Gemini**. See [Terminal](terminal.md#send-terminal-output-to-gemini). |
| "Gemini's context for this chat filled up" | A turn sent more than the model can read, usually one very large tool output. The chat carries on in a new session that is given the conversation without the tool outputs: send your message again. Ask for big diffs or logs a few files at a time. |
| "Where is your copy of …?" when reviewing or fixing a merge request | GeminiCode found no clone of the repository among your folders. Choose **Choose Folder...** for a clone you have, whose remote is on your GitLab server, or **Clone It...** to clone it. GeminiCode remembers the clone for that project. |
| A thread's or agent's changes didn't update in your workspace | Updating pauses while a tried file has conflict markers: resolve them, or use **Open the Conflict** on the thread's card. A file with unsaved edits updates when you save it. |
| Agents ignore a folder's MCP servers, hooks or settings | The folder isn't trusted. Choose **Trust...** on Home, or add it under **Trusted Folders** in **Agent Setup**. See [Folder trust](review.md#folder-trust). |
| "Can't reach … Check that your VPN is on" | A team tool behind your VPN didn't answer. Connect the VPN; the other tools keep working. |
| The macOS build won't open | See the note under [Install](getting-started.md#install). |

## Record a performance trace

When a turn feels slow, **Record Performance Trace...** in the Gemini status bar item's menu (or **Gemini: Record or Stop Performance Trace**, with `gemini.developer.showTools` on) restarts the agent with the Gemini CLI's own telemetry writing to a file in GeminiCode's own storage, `geminicode-trace-<date>.jsonl`; the notification shows where. Use the agent as usual, then run the command again or press **Stop Recording**. The agent restarts without telemetry once it is idle, and a summary opens: for each turn, the routing call if the model was on Auto, the first model reply, the model and tool time, and the input tokens with how many were cached.

The file stays on your Mac. It holds timings, token counts, the CLI's own system prompt and tool declarations. It holds no prompt or reply text. Attach the `.md` summary to an issue; keep the `.jsonl` unless someone asks for it.

## Report a problem

Click the **Gemini** status bar item and choose **Report an Issue...**, which opens a new issue with the GeminiCode, VS Code, Gemini CLI and OS versions filled in. Run **Gemini: Show Log** and include the relevant lines, with account names and project IDs removed. Every GeminiCode error message has a **Show Log** button too, and writes its text to the log first. **Gemini CLI Docs** in the same menu opens the CLI's own documentation.

Report security problems privately through [GitHub's vulnerability reporting](https://github.com/pulkitjain-org/vscode-gemini-cli/security/advisories/new), never in a public issue.
