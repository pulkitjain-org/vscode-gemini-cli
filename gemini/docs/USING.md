# Using GeminiCode

How the parts of GeminiCode that differ from VS Code behave day to day. For setup, see [Getting started](../README.md#getting-started).

## Agents and Editor modes

The switch at the top of the window, or ⌥⌘M, changes the layout:

- **Agents mode** (the default) is for working with agents: your agents on the left, the agent's chat in the middle, and its changes on the right. When no tab is open, **Agent Home** shows: describe a task and press Return to start an agent on it, tick **On its own branch** to give it a branch of its own, and see each agent's status, changes and next step as a card. Agents mode always shows Gemini on the left and Changes on the right; opening Explorer, Search or any other view switches to Editor mode with that view open.
- **Editor mode** is the classic VS Code layout, with Explorer, Search and Source Control, for hands-on coding.

Each mode remembers which panels you had open. An agent's tab shows what it is doing (a spinner while it works, an amber dot when it needs you, a tick when it has finished) and how many lines it has changed. On a Mac, right-click GeminiCode in the Dock for **New Agent**. Agents that are working or waiting for you show as pills in the title bar in both modes; click one to open that agent.

In the **Changes** panel, hover over a change to **Keep** or **Undo** it. **Keep All** accepts everything, **Undo All** puts the files back, and **Commit** commits the agent's files on a new branch (an agent on its own branch has **Merge Back** instead).

An agent on its own branch can get a ready folder: set **Gemini › Agents: Worktree Setup** to a command (such as `npm ci`), or commit `.gemini/worktree-setup.sh` to the repository, and it runs in the new branch's folder before the agent starts. `GEMINI_SOURCE_REPOSITORY` names the repository it came from, to copy files Git does not carry, such as `.env`. Its output is in the **Gemini Worktree Setup** output; if it fails, the agent starts anyway.

## Keyboard shortcuts

⌘ is Command, ⌥ is Option, ⇧ is Shift, ↩ is Return and ⌫ is Delete.

| Keys | What it does |
| --- | --- |
| ⌥⌘M | Switch between Agents and Editor mode |
| ⌘L | Open the chat; with a selection, add it to the chat |
| ⌥⌘N | New agent |
| ⌘N (in the chat) | New chat |
| ↩ / ⇧↩ (in the chat input) | Send, or start a new line |
| esc (in the chat input) | Stop the agent, or cancel Enhance prompt |
| ⌥⌘E | Enhance prompt (the draft in the chat in front) |
| ↑ / ↓ (empty chat input) | Bring back an earlier prompt |
| ⌘I | Inline edit |
| ⌘↩ / ⌘⌫ | Keep or undo the agent's changes to the file you're in |
| ⌥] / ⌥[ | Next or previous agent change in the file |
| ↩ / ⌘↓ / ⌘⌫ (Agents pane) | Rename, open or remove the selected agent |

## Make it yours

Run **Make It Yours** from the Command Palette, or open the step of the same name in Get Started, to pick:

- a theme: Glass Dark and Glass Light (the defaults: see-through side bars over an aurora wallpaper, with the Gemini gradient round the chat input), Dark, Midnight (true black), Dusk (warm greys) or Light;
- an accent colour for selection, focus, links and the chat's Send button: the theme's own, Blue, Violet, Rose, Teal, Amber or the Gemini gradient. It applies to the GeminiCode themes only, through `workbench.colorCustomizations`, and is kept in `gemini.appearance.accent`;
- a code font: JetBrains Mono (the default) and Geist Mono ship with GeminiCode; SF Mono and Menlo come with macOS;
- file icons: GeminiCode's own, Seti, or none;
- chat text size: 13 to 16 px (14 px by default), kept in `gemini.chat.fontSize`.

Each choice applies at once. To change the themes or icons, edit the sources and rerun `node extensions/gemini/scripts/build-themes.mts` or `python3 extensions/gemini/scripts/build-file-icons.py`; a unit test fails when the generated themes are out of date.

## Enhance prompt

Write what you want in plain words, then click **Enhance**, which follows the end of your text (or press **⌥⌘E**). Gemini rewrites the draft as a clearer, more precise prompt: what to do, where, and how to tell it is done, with open questions where your draft leaves something out. It keeps your `@` mentions, a leading `/command`, file names and code as you wrote them, and uses the files you attached, the open file and the chat so far.

The text shimmers while Gemini works, usually for about three seconds; **Enhance** turns into **Cancel**, and esc stops it too. The rewrite replaces your draft for you to read and change before sending: **Revert**, beside **Enhance** (or ⌘Z), puts your draft back, and **Enhance** rewrites it again. Nothing is sent to the agent until you press Send.

The rewrite is one quick request to Gemini Flash, like inline edit. When inline edit is turned off, or that request fails, the Gemini CLI does it instead, in Plan mode so it cannot change anything. It does not go into the chat, and it works while the agent is busy.

## Inline edit and commit messages

Select some code (or put the cursor on a line), press **⌘I**, and say what to change. Gemini rewrites just those lines in a second or two, and the change shows in the file with **Keep** and **Undo**, like an agent's. The request box remembers your last request, so a retry is ⌘I and Return. Inline edit doesn't save the file and doesn't start an agent.

In the Source Control view, the sparkle button writes a commit message for the staged changes (or, with nothing staged, all changes) into the message box.

Both send the selected lines (or the diff) straight to a fast Gemini model with the sign-in the Gemini CLI saved. They work with Google sign-in and with a Gemini API key, not yet with Vertex AI. They use the newest Flash model, for speed. `gemini.inlineEdit.model` can switch them to the model you last picked in chat (`sameAsChat`) or any model you name, and `gemini.inlineEdit.enabled` turns them off.

## Approval modes

Pick a mode from the composer. The list comes from the Gemini CLI, minus any mode your admin turned off.

| Mode | What the agent does |
| --- | --- |
| **Default** | Asks before every edit and every command. Proposed edits open as a diff first. |
| **Auto Edit** | Edits files without asking, but still asks before commands. |
| **Plan** | Reads and proposes a plan without making changes. The CLI can turn this mode off in its own settings. |
| **YOLO** | Runs everything without asking. Off unless your admin enables it. |

Permission cards show the CLI's own choices, such as **Allow**, **Allow for this session** and **Reject**. <kbd>esc</kbd> rejects. Stopping a turn cancels any open request. When an agent asks for permission, its tab comes to the front and the proposed edit opens as a diff; in the Agents pane its row shows a bell.

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

## Agents on their own branch

Two agents in the same folder can trip over each other's edits. **New Agent on Its Own Branch** (the branch icon next to **+** on a workspace in a Git repository) asks for a branch name and gives the agent its own copy of the repository on that new branch, in `~/.geminicode/worktrees/<repository>/` (a Git worktree). The agent reads, edits and runs commands there, so your folder and other agents are untouched. Its row in the Agents pane shows the branch.

When it's done, **Merge Back** (the merge icon on the agent's row) commits anything the agent left uncommitted, using the agent's name as the message, and merges its branch into the branch your folder has checked out. If the merge conflicts, it stops for you to finish in Source Control. After a clean merge it offers to remove the agent with its branch and folder. Removing such an agent asks whether to keep its branch, and says what is on it that isn't merged yet.

The new copy has no `node_modules` or build output, so an agent that runs tests may need to install dependencies first. To start every new agent this way, turn on `gemini.agents.ownBranch`.

## Attaching context

- **Workspace files.** Type `@` or use the **@** button. The agent gets a link and reads the file itself, including unsaved changes.
- **The selection.** <kbd>⌘L</kbd> adds the editor selection with its line numbers.
- **Files from anywhere.** Use the paperclip, paste, or drop files from Finder. Hold <kbd>⇧</kbd> when dropping from the Explorer.
  - Text and code files up to 1 MB are sent with their contents.
  - Images and PDFs up to about 7 MB are sent inline.
  - Other files outside the workspace are sent as links. The CLI then asks once per file before reading it.

The agent cannot read secret files such as `.env` and private keys, or git-ignored files, through the editor.

## Replies

Code in replies is coloured like the editor, in your colour theme. The button at the top of a code block copies it. A file name in a reply, such as `src/cart/total.ts:11`, opens the file at that line; when only the name is given, GeminiCode looks for it in the agent's folder. Notes, tips and warnings show as coloured callouts.

Messages you send show Markdown the way replies do: bold, lists, `code`, code blocks and links, with your line breaks kept. In the composer, ⌘B makes the selection bold and ⌘E makes it code, typing a backtick over a selection wraps it in code, and ⇧↩ on a list line starts the next item; on an empty item it ends the list. The **Write** and **Preview** tabs at the top of the input (or ⇧⌘V) switch between your draft and how it will look once sent; typing in Preview goes back to Write.

Each message you send shows the time you sent it and a **Copy** button when you point at it. Under each reply, next to how long the agent worked, is the time it finished, with the same **Copy** button. The pill next to the branch in the composer names the agent's workspace (and its worktree, when it has one); click it to copy the path, reveal the folder in Finder or show the Agents pane.

## Restoring a Gemini CLI session

A new, empty agent lists the three sessions the Gemini CLI saved most recently for its folder, including ones started with `gemini` in the terminal, with a link to show them all. Pick one to continue it in that agent: its conversation appears in the chat, and the agent takes the session's title. `/resume` in the composer opens the same list at any time. Sessions open in another agent are left out. GeminiCode reads the list from the CLI's own files in `~/.gemini/tmp` and never changes them.

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

## MCP servers and rules

**Gemini: MCP Servers and Rules** (also in the Agents pane's **...** menu) lists the MCP servers in your personal `~/.gemini/settings.json` and in each open folder's `.gemini/settings.json`. Each has a switch that turns it on or off, the same way the CLI's `/mcp enable` and `/mcp disable` do, so the `gemini` command in your terminal sees the change too. **Add Server** asks for a name and the command that starts the server, or its URL, and adds it to your personal settings. The page also opens or creates your project's rules (`GEMINI.md`, or the name in `context.fileName`) and your personal rules (`~/.gemini/GEMINI.md`). Changes apply to agents started afterwards; **Restart Agent** applies them now.

When an MCP server cannot start, GeminiCode shows a warning naming the server and the reason, marks it on the MCP Servers and Rules page, and writes it to the Gemini log (**Gemini: Show Log**). The CLI does not report these over ACP, so GeminiCode reads them from the CLI's debug log, which it keeps under 1 MB in its own storage. If you set `GEMINI_DEBUG_LOG_FILE` yourself, GeminiCode leaves it alone and shows no warnings.

## Review my changes

**Review My Changes**, in the Source Control title bar and the Agents pane's **...** menu, starts an agent in Plan mode with your uncommitted diff attached and new files listed. It reads the code around the changes and replies with a summary and its findings, most serious first, without editing anything. Ask it to fix one when you agree.

## Today's use

Hover the **Gemini** item in the status bar to see how much of today's quota each model has used and when it resets. Once a model passes 80%, the item shows the percentage. Turn this off with `gemini.usageMeter.enabled`.

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
