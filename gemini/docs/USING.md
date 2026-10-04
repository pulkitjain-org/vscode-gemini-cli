# Using GeminiCode

How the parts of GeminiCode that differ from VS Code behave day to day. For setup, see [Getting started](../README.md#getting-started).

## Make it yours

Run **Make It Yours** from the Command Palette, or open the step of the same name in Get Started, to pick:

- a theme: GeminiCode Dark (the default), Midnight (true black), Dusk (warm greys) or Light;
- an accent colour for selection, focus, links and the chat's Send button: the theme's own, Blue, Violet, Rose, Teal, Amber or the Gemini gradient. It applies to the GeminiCode themes only, through `workbench.colorCustomizations`, and is kept in `gemini.appearance.accent`;
- a code font: JetBrains Mono (the default) and Geist Mono ship with GeminiCode; SF Mono and Menlo come with macOS;
- file icons: GeminiCode's own, Seti, or none.

Each choice applies at once. To change the themes or icons, edit the sources and rerun `node extensions/gemini/scripts/build-themes.mts` or `python3 extensions/gemini/scripts/build-file-icons.py`; a unit test fails when the generated themes are out of date.

## Inline edit and commit messages

Select some code (or put the cursor on a line), press **Cmd+I**, and say what to change. Gemini rewrites just those lines in a second or two, and the change shows in the file with **Keep** and **Undo**, like an agent's. The request box remembers your last request, so a retry is Cmd+I and Enter. Inline edit doesn't save the file and doesn't start an agent.

In the Source Control view, the sparkle button writes a commit message for the staged changes (or, with nothing staged, all changes) into the message box.

Both send the selected lines (or the diff) straight to a fast Gemini model with the sign-in the Gemini CLI saved. They work with Google sign-in and with a Gemini API key, not yet with Vertex AI. `gemini.inlineEdit.enabled` turns them off and `gemini.inlineEdit.model` picks the model.

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

Open a file an agent changed and its changes show in place: added lines are tinted, a rule marks removed lines (hover to see them), and **Keep** and **Undo** sit above each change. The line at the top of the file keeps or undoes them all and moves to the agent's next file, and the arrows in the editor's title bar step through the changes. Keeping a change takes it off the Changes list; undoing one puts the old lines back and saves the file.

Each reply that changed files ends with **Undo**, which puts back every file it changed. Undoing an earlier reply also undoes the replies after it, and GeminiCode asks first when that happens or when a file changed after Gemini wrote it. The next message tells Gemini which files went back, so it reads them again. The last 20 replies of each chat can be undone, until the window closes. **Retry** under the latest reply sends the same message again.

The branch pill in a chat's composer switches to another branch or creates one. In an agent's chat, **Create Branch & Commit** creates a branch, stages only the files that agent changed, and commits them. If other files are already staged it warns first, because they would be committed too. After the commit the agent's Changes list is cleared.

## Attaching context

- **Workspace files.** Type `@` or use the **@** button. The agent gets a link and reads the file itself, including unsaved changes.
- **The selection.** <kbd>Cmd</kbd>+<kbd>L</kbd> adds the editor selection with its line numbers.
- **Files from anywhere.** Use the paperclip, paste, or drop files from Finder. Hold <kbd>Shift</kbd> when dropping from the Explorer.
  - Text and code files up to 1 MB are sent with their contents.
  - Images and PDFs up to about 7 MB are sent inline.
  - Other files outside the workspace are sent as links. The CLI then asks once per file before reading it.

The agent cannot read secret files such as `.env` and private keys, or git-ignored files, through the editor.

## Slash commands

Type `/` at the start of the composer to list commands, with team commands first. Keep typing to filter, then press <kbd>Tab</kbd> or <kbd>Enter</kbd> to complete the name and add arguments.

- **Gemini CLI commands** such as `/init`, `/memory` and `/restore` come from the CLI and run in the CLI.
- **Team commands** are TOML files in `.gemini/commands/` in the workspace, or in `~/.gemini/commands/` for your own. This is the Gemini CLI's own format, so the same files work in the terminal. `git/commit.toml` becomes `/git:commit`. GeminiCode sends the file's `prompt`, with `{{args}}` replaced by what you typed after the name. A workspace command replaces a personal one with the same name, and a CLI command wins over both.

```toml
description = "Review a file for bugs"
prompt = "Review {{args}} for bugs and suggest fixes."
```

Prompts that use `!{...}` (run a shell command) or `@{...}` (read a file) are not offered yet; the Gemini log says which files were skipped.

## Notifications

When an agent finishes or needs your permission while GeminiCode is in the background, a system notification appears and the Dock icon bounces. Click it to open the agent. The Dock icon and the Agents pane show how many agents are waiting for you. Turn both off with `gemini.notifications.enabled`. macOS asks once whether GeminiCode may show notifications.

## MCP servers

The Gemini CLI starts the MCP servers in its `settings.json` files. When one cannot start, GeminiCode shows a warning naming the server and the reason, and writes it to the Gemini log (**Gemini: Show Log**). The CLI does not report these over ACP, so GeminiCode reads them from the CLI's debug log, which it keeps under 1 MB in its own storage. If you set `GEMINI_DEBUG_LOG_FILE` yourself, GeminiCode leaves it alone and shows no warnings.

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
