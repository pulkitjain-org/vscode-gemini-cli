# Using GeminiCode

How the parts of GeminiCode that differ from VS Code behave day to day. For setup, see [Getting started](../README.md#getting-started).

## Approval modes

Pick a mode from the composer. The list comes from the Gemini CLI, minus any mode your admin turned off.

| Mode | What the agent does |
| --- | --- |
| **Default** | Asks before every edit and every command. Proposed edits open as a diff first. |
| **Auto Edit** | Edits files without asking, but still asks before commands. |
| **Plan** | Reads and proposes a plan without making changes. The CLI can turn this mode off in its own settings. |
| **YOLO** | Runs everything without asking. Off unless your admin enables it. |

Permission cards show the CLI's own choices, such as **Allow**, **Allow for this session** and **Reject**. <kbd>Esc</kbd> rejects. Stopping a turn cancels any open request. When an agent asks for permission, its tab comes to the front and the proposed edit opens as a diff; in the Agents pane its row shows a bell.

The model picker works the same way. The model you pick is remembered and used for every new or reopened agent, in any window, when the agent offers it.

Changing `gemini.cliPath`, `gemini.cli.version`, `gemini.projectId`, or an approval or shell setting restarts the agent so the change applies. Open agents resume their sessions.

The agent is not sandboxed. Its shell and search tools run with your permissions, so use Auto Edit and YOLO only in folders you trust.

## Folder trust

The Gemini CLI refuses Auto Edit and YOLO in a folder it does not trust. When you pick one of those modes in such a folder, GeminiCode asks whether to trust it. Trusting a folder also lets the CLI load that folder's own Gemini settings and MCP servers, which can run programs. The CLI remembers the choice in `~/.gemini/trustedFolders.json`, and the terminal `gemini` sees it too.

## Agent changes and commits

The **Changes** view below the Agents pane lists the files the agent in front has edited. Click a file for a diff against its text before the agent's first edit, or use **Open All Changes** for one multi-diff editor. **Clear List** forgets them without touching the files.

The branch pill in a chat's composer switches to another branch or creates one. In an agent's chat, **Create Branch & Commit** creates a branch, stages only the files that agent changed, and commits them. If other files are already staged it warns first, because they would be committed too. After the commit the agent's Changes list is cleared.

## Attaching context

- **Workspace files.** Type `@` or use the **@** button. The agent gets a link and reads the file itself, including unsaved changes.
- **The selection.** <kbd>Cmd</kbd>+<kbd>L</kbd> adds the editor selection with its line numbers.
- **Files from anywhere.** Use the paperclip, paste, or drop files from Finder. Hold <kbd>Shift</kbd> when dropping from the Explorer.
  - Text and code files up to 1 MB are sent with their contents.
  - Images and PDFs up to about 7 MB are sent inline.
  - Other files outside the workspace are sent as links. The CLI then asks once per file before reading it.

The agent cannot read secret files such as `.env` and private keys, or git-ignored files, through the editor.

## Long conversations

The Gemini CLI manages the model's context. When a session's history reaches half of the model's context window, the CLI summarises the older part and keeps the most recent 30% as it was. Large tool outputs are cut to 40,000 characters. Both limits come from the CLI's own settings (`model.compressionThreshold` and `tools.truncateToolOutputThreshold` in `~/.gemini/settings.json`).

GeminiCode keeps its own share small:

- Saved conversations keep the last 300 messages, each cut to 20,000 characters.
- Messages scrolled out of view are not laid out, and streaming sends only new text.
- Proposed edits are remembered for the last 200 tool calls. Older diff links open the file as it is now.

Every agent in a window shares one Gemini CLI process, and that process keeps each session's history until it restarts. In Quick Chat, **New Chat** starts a fresh session; for agents, start a new agent. If an old agent is no longer needed, remove it from the Agents pane, which also deletes its saved conversation.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The status bar says sign-in is needed | Run **Gemini: Sign In with Google**. If it needs a step the editor cannot show, run **Gemini: Complete Setup in Terminal**, finish it, and exit with `/quit`. |
| "is a project number" | Set the project ID, such as `my-project-123`, with **Gemini: Set Google Cloud Project ID**. |
| No Gemini CLI found | Only in a build without the bundled CLI. Run **Gemini: Install Latest Gemini CLI**, or set `gemini.cliPath`. |
| "older than 0.61.0" | The CLI in use is too old. Choose **Install Latest**, or run **Gemini: Install or Change Gemini CLI Version...**. |
| Not sure the CLI starts at all | Run **Gemini: Check Agent Connection**. It starts the CLI on its own and reports its version and protocol, or the error. |
| The agent stops or misbehaves | Click the **Gemini** status bar item and choose **Restart Agent**. Open agents resume their sessions. |
| Something else | Run **Gemini: Show Log** and include the relevant lines, with account names and project IDs removed, when you [report an issue](https://github.com/pulkitjain-org/vscode-gemini-cli/issues). |
