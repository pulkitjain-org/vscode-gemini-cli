# Using GeminiCode

How the parts of GeminiCode that differ from VS Code behave day to day. For setup, see [Getting started](../README.md#getting-started).

## Agents and Editor modes

The switch at the top of the window, or ⌥⌘M, changes the layout:

- **Agents mode** (the default) is for working with agents: your agents on the left, the agent's chat in the middle, and its changes on the right. When no tab is open, **Agent Home** shows: describe a task and press Return to start an agent on it, tick **On its own branch** to give it a branch of its own, and see each agent's status, changes and next step as a card. Agents mode always shows Gemini on the left and Changes on the right, unless you put another view on the right; opening Explorer, Search or any other view switches to Editor mode with that view open.
- **Editor mode** is the classic VS Code layout, with Explorer, Search and Source Control, for hands-on coding.

Files, diffs and pages an agent opens go in an editor group beside its chat, with VS Code's own tab row so you can close them. Each agent has its own group: switching agents hides the others' groups without closing them, so coming back to an agent shows its files as you left them. Closing an agent's tab, or removing the agent, closes its files, except those with unsaved changes.

In Agents mode the top of the window is one row: the **Agents | Editor** switch, then your open tabs — agents, Agent Home, files and browser pages — in one capsule, then a globe for the integrated browser, a magnifier that opens Quick Open and the layout buttons. Editor mode keeps the classic tab row under the title bar, because split editors need it, and shows the search box in the middle again.

Each mode remembers which panels you had open. An agent's tab shows what it is doing (a spinner while it works, an amber dot when it needs you, a tick when it has finished) and how many lines it has changed. In the Agents pane, each agent's row has the same signal (a spinner, an amber dot when it needs you, a green dot when it has finished, a red dot when something went wrong, grey otherwise) and, on the right, how long it has been working, "waiting", the lines it added, or how long ago it was last active; point at a row for its branch and folder. On a Mac, right-click GeminiCode in the Dock for **New Agent**. Agents that are working, waiting for you, finished but not yet read, or need attention show as pills in Editor mode's title bar; click one to open that agent. In Agents mode the tabs and the agent list already carry those signals, so there are no pills. The foot of the agent list shows the branch of the agent you selected.

In the **Changes** panel, hover over a change to **Keep** or **Undo** it. **Keep All** accepts everything, **Undo All** puts the files back, and **Commit** commits the agent's files on a new branch (an agent on its own branch has **Merge Back** instead).

An agent on its own branch can get a ready folder: set **Gemini › Agents: Worktree Setup** to a command (such as `npm ci`), or commit `.gemini/worktree-setup.sh` to the repository, and it runs in the new branch's folder before the agent starts. A project's thread doesn't wait for it: the thread's agent starts while setup runs, and gets its brief when setup ends. `GEMINI_SOURCE_REPOSITORY` names the repository it came from, to copy files Git does not carry, such as `.env`. Its output is in the **Gemini Worktree Setup** output; if it fails, the agent starts anyway.

**Follow the agent.** Turn on **Follow the agent** in the composer's **+** menu, or run **Gemini: Follow the Agent**, to watch the agent work: each file it reads opens at the line it is on, and each file it edits opens once the edit is written. The file it opened last is named under the composer; click the name to show it, or **×** to close it. Files outside the agent's folder, and files that may hold secrets such as `.env` or anything under `.ssh`, are not opened. Focus stays in the chat. New chats start the way you left the last one.

**Keep awake.** While any agent works, GeminiCode keeps the Mac from going to sleep, so a long task carries on when you step away. The display can still sleep, and the Mac may sleep again as soon as no agent is working. Turn it off with `gemini.keepAwake`.

## Keyboard shortcuts

⌘ is Command, ⌥ is Option, ⇧ is Shift, ↩ is Return and ⌫ is Delete.

| Keys | What it does |
| --- | --- |
| ⌥⌘M | Switch between Agents and Editor mode |
| ⌘L | Add the selection to the agent in front, or to a new agent |
| ⌥⌘N | New agent |
| ⌘N (in the chat) | New chat |
| ↩ / ⇧↩ (in the chat input) | Send, or start a new line |
| esc (in the chat input) | Stop the agent, or cancel Enhance prompt |
| ⌥⌘E | Enhance prompt (the draft in the chat in front) |
| ↑ / ↓ (empty chat input) | Bring back an earlier prompt |
| ⌥⌘↑ / ⌥⌘↓ (in the chat) | Jump to your previous or next prompt |
| ⌘I | Inline edit |
| ⌘↩ / ⌘⌫ | Keep or undo the agent's changes to the file you're in |
| ⌥] / ⌥[ | Next or previous agent change in the file |
| ↩ / ⌘↓ / ⌘⌫ (Agents pane) | Rename, open or remove the selected agent |

## Make it yours

Run **Make It Yours** from the Command Palette, or open the step of the same name in Get Started, to pick:

- a theme: GeminiCode Dark or GeminiCode Light (the defaults follow your system), or any other installed theme with **More themes**;
- a code font: JetBrains Mono (the default) and Geist Mono ship with GeminiCode; SF Mono and Menlo come with macOS;
- file icons: GeminiCode's own, Seti, or none.

Each choice applies at once, and the page marks what the window shows now. When the window follows your system's light or dark appearance, it marks the theme in use, and picking a theme on the page stops following the system so your pick holds.

GeminiCode Dark and Light share one calm look: soft greys with a faint graphite tint at the top of the window, panels as cards with a hairline border, and solid menus and pop-ups. Blue is the one accent (Send, primary buttons, links and the context ring). Selected rows, menu highlights and your own messages in the chat are graphite greys, not blue. The Gemini colours are kept for the sparkle, the bar that runs along the chat input while an agent works, the active tab's underline and the focused chat input. Chat text is 14 px. To change the file icons, edit the sources and rerun `python3 extensions/gemini/scripts/build-file-icons.py`.

## Enhance prompt

Write what you want in plain words, then click **Enhance**, which follows the end of your text (or press **⌥⌘E**). Gemini rewrites the draft as a clearer, more precise prompt: what to do, where, and how to tell it is done, with open questions where your draft leaves something out. It keeps your `@` mentions, a leading `/command`, file names and code as you wrote them, and uses the files you attached, the open file and the chat so far.

The rewrite appears in place of your draft as Gemini writes it; **Enhance** turns into **Cancel**, and esc stops it too. The finished rewrite stays for you to read and change before sending: **Revert**, beside **Enhance** (or ⌘Z), puts your draft back, and **Enhance** rewrites it again. Nothing is sent to the agent until you press Send.

The rewrite is one quick request to Gemini Flash, like inline edit. When inline edit is turned off, or that request fails, the Gemini CLI does it instead, in Plan mode so it cannot change anything. It does not go into the chat, and it works while the agent is busy.

## Inline edit and commit messages

Select some code (or put the cursor on a line), press **⌘I**, and say what to change. Gemini rewrites just those lines in a second or two, showing the new lines above the old ones as they arrive, and the change shows in the file with **Keep** and **Undo**, like an agent's. The request box remembers your last request, so a retry is ⌘I and Return. Inline edit doesn't save the file and doesn't start an agent.

In the Source Control view, the sparkle button writes a commit message for the staged changes (or, with nothing staged, all changes) into the message box.

Both send the selected lines (or the diff) straight to a fast Gemini model with the sign-in the Gemini CLI saved. They work with Google sign-in and with a Gemini API key, not yet with Vertex AI. They use the newest Flash model, for speed. `gemini.inlineEdit.model` can switch them to the model you last picked in chat (`sameAsChat`) or any model you name, and `gemini.inlineEdit.enabled` turns them off.

## Approval modes

Pick a mode from the composer's **+** menu. The list comes from the Gemini CLI, minus any mode your admin turned off. A mode other than the first shows as a chip beside **+**; click its × to go back.

| Mode | What the agent does |
| --- | --- |
| **Default** | Asks before every edit and every command. Proposed edits open as a diff first. |
| **Auto Edit** | Edits files without asking, but still asks before commands. |
| **Plan** | Reads and proposes a plan without making changes. The CLI can turn this mode off in its own settings. |
| **YOLO** | Runs everything without asking. Off unless your admin enables it. |

Permission cards show the CLI's own choices, such as **Allow**, **Allow for this session** and **Reject**. **Allow for this session** on a shell command covers the programs it runs for the rest of that chat's session, so a later command that runs the same programs doesn't ask again. A command that reaches the network, writes through a redirection or runs code it builds still asks each time, and so does one that runs another program or code it is given, such as `env`, `xargs`, `sudo`, `python -c`, `npx`, `find -exec` or `git -c`. **Gemini: Commands Allowed for This Session...** lists what the chat in front allowed, and lets you forget any of it. Turn on **Allow for all future sessions** in Project Helpers and they also offer to allow a tool or command from now on, in every new chat and in the terminal CLI. <kbd>esc</kbd> rejects. Stopping a turn cancels any open request. When an agent asks for permission, its tab comes to the front and the proposed edit opens as a diff; in the Agents pane its row shows an amber dot and "waiting".

The model picker lists the models the terminal's `/model` shows, in the same order: preview models first, then the stable ones, with Pro left out when your account can't use it. The model you pick is remembered and used for every new or reopened agent, in any window, when the agent offers it. Until you pick one, agents use Flash, which answers sooner than Auto because Auto first asks a smaller model which one to use.

Changing `gemini.cliPath`, `gemini.cli.version`, `gemini.projectId`, or an approval or shell setting restarts the agent so the change applies. Open agents resume their sessions.

The agent is not sandboxed. Its shell and search tools run with your permissions, so use Auto Edit and YOLO only in folders you trust.

When a reply ends in Plan mode, **Build This Plan** under it switches the chat to Default mode and asks Gemini to carry out the plan. With the model on Auto, Gemini plans with Pro and builds with Flash; turn off **Plan with Pro, build with Flash** in Project Helpers to keep one model throughout.

In a window with several folders, each agent keeps to the folder it works in. To let every agent read and edit all of them, turn on `gemini.agents.allWorkspaceFolders` (the CLI's `--include-directories`); then adding or removing a folder restarts the agent once no agent is working.

## Folder trust

The Gemini CLI refuses Auto Edit and YOLO in a folder it does not trust. When you pick one of those modes in such a folder, GeminiCode asks whether to trust it. Trusting a folder also lets the CLI load that folder's own Gemini settings and MCP servers, which can run programs. The CLI remembers the choice in `~/.gemini/trustedFolders.json`, and the terminal `gemini` sees it too.

Projects need trust as well: the CLI loads a project's tools only in a trusted folder. Opening or starting a project asks once to trust the folders its agents run in (see [Projects](#projects-preview)).

## Agent changes and commits

The **Changes** panel (on the right in Agents mode, below the Agents pane in Editor mode) lists the files the agent in front has edited. Click a file for a diff against its text before the agent's first edit, or use **Open All Changes** for one multi-diff editor. **Clear List** forgets them without touching the files.

Open a file an agent changed and its changes show in place: added lines are tinted, a rule marks removed lines (hover to see them), and **Keep** and **Undo** sit above each change. The line at the top of the file keeps or undoes them all and moves to the agent's next file, and the arrows in the editor's title bar step through the changes. Keeping a change takes it off the Changes list; undoing one puts the old lines back and saves the file.

Each reply that changed files ends with **Undo**, which puts back every file it changed. Undoing an earlier reply also undoes the replies after it, and GeminiCode asks first when that happens or when a file changed after Gemini wrote it. The next message tells Gemini which files went back, so it reads them again. The last 100 replies of each agent can be undone (up to 20 MB of file text), and they stay undoable after the window reloads or the agent sleeps; they are deleted with the agent. **Retry** under the latest reply sends the same message again.

**Rewind** goes back to before one of your messages, as the CLI's `/rewind` does: click the clock icon under the message, or press Esc twice in an empty message box and pick one. That message and everything after it go from the chat and from Gemini's context, so Gemini forgets them, and the files Gemini changed since go back to how they were. The message goes back in the message box, to edit and send again. A message that ran a team command or skill can't be found in the CLI's session, so for it Rewind offers to undo the code only.

The branch under a chat's composer switches to another branch or creates one. In an agent's chat, **Create Branch & Commit** creates a branch, stages only the files that agent changed, and commits them. If other files are already staged it warns first, because they would be committed too. After the commit the agent's Changes list is cleared.

## Agents on their own branch

Two agents in the same folder can trip over each other's edits. **New Agent on Its Own Branch** (the branch icon next to **+** on a workspace in a Git repository) asks for a branch name and gives the agent its own copy of the repository on that new branch, in `~/.geminicode/worktrees/<repository>/` (a Git worktree). The agent reads, edits and runs commands there, so your folder and other agents are untouched. Point at its row in the Agents pane to see the branch.

When it's done, **Merge Back** (the merge icon on the agent's row) commits anything the agent left uncommitted, using the agent's name as the message, and merges its branch into the branch your folder has checked out. If the merge conflicts, it stops for you to finish in Source Control. After a clean merge it offers to remove the agent with its branch and folder. Removing such an agent asks whether to keep its branch, and says what is on it that isn't merged yet.

The new copy has no `node_modules` or build output, so an agent that runs tests may need to install dependencies first. To start every new agent this way, turn on `gemini.agents.ownBranch`.

## Projects (preview)

A project hands a larger piece of work to a team of agents. Its chat is a **coordinator**: you describe the work, and it splits it into **threads**, each an agent on a new branch in its own worktree (as in [Agents on their own branch](#agents-on-their-own-branch)). The coordinator never edits files or reads the code itself; it plans, starts threads, passes your follow-ups to them and answers questions about their progress. Projects are off by default; turn them on with `gemini.projects.enabled`, or choose **New Project** and say yes when it asks.

**Starting one.** Choose **+** next to **Projects** in the agent list or on Agent Home, and pick a folder in a Git repository: an open workspace or any other folder. The project chat opens at once, named after the repository. The first time, GeminiCode asks to trust two folders, because the Gemini CLI loads the project's tools only in trusted folders: `~/.geminicode/projects`, where coordinators run, and `~/.geminicode/worktrees/<repository>`, where threads check out their branches. The tools arrive when the agent restarts, once no agent is working.

**Where it runs.** The coordinator works in an empty folder of its own, so it has nothing to read but what you and its threads tell it. It does get the repository's context files (`GEMINI.md`, `AGENTS.md` and any file `context.fileName` names), but not its `.gemini` or `.agents` folders, whose skills, commands and servers are for doing the work. Threads run in the repository's worktrees with all of its rules; rules the repository's `.gitignore` leaves out, such as a local `.gemini` folder, are linked in, so threads load them too. The coordinator runs on a Flash model; if it asks to use any tool besides its own, the request is refused automatically and the chat says so.

**Threads.** Each thread shows as a card in the project chat, with its state, branch, changed lines and time, and updates in place. Click its title, or **Open**, to open its chat in a tab of its own; a bar at the top of a thread's chat leads back to the project chat on the left and names its project on the right. A thread's questions and permission requests stay in its own chat (**Open to answer**). When a thread finishes with changes, its card offers **Merge back** (into the branch your folder has checked out), **Review changes** and **Undo thread**, which removes its branch and folder; a thread that finished without changes, such as an assessment, offers **Open** to read its answer.

To start a thread yourself, choose **New thread** in the project chat's **+** menu, or **New Thread** on the project's row in the agent list: give it a title, what it should do, a branch name and a model, and tick **Plan first** to have it write a plan and wait for **Approve plan** before changing files. It starts at once, and the coordinator hears about it afterwards.

**Talking to the coordinator.** Only your messages wake the coordinator. When a thread finishes, asks something or fails, you take it up in that thread; the coordinator sees what changed the next time you write to it. A follow-up on work a thread already has goes to that thread, whether it is working, waiting or done. Once you merge a thread back, it is resolved, also after a reload: the coordinator starts a new thread for further work and reopens a resolved one only when you ask it to. Opening a project chat starts the agents of all its threads that aren't resolved, one after another and without opening their tabs, so their chats are ready and the coordinator can reach them.

**The side panel.** When the project chat is at least 1000 px wide, a panel on its right lists the threads by state (click one to open it), the Conductor tracks the coordinator reads from a `conductor/` folder, and the coordinator's model. Drag its left edge to resize it, or focus the edge and use the arrow keys; double-click the edge to reset it.

In the agent list, the **Projects** section lists each project with its threads below it, above the **Agents** section; each section has its own **+**. Agent Home lists projects apart from agents too.

## Attaching context

- **Workspace files.** Type `@`, or choose **Context** in the composer's **+** menu. The agent gets a link and reads the file itself, including unsaved changes.
- **The selection.** <kbd>⌘L</kbd> adds the editor selection with its line numbers.
- **Files from anywhere.** Choose **Files** in the **+** menu, paste, or drop files from Finder. Hold <kbd>⇧</kbd> when dropping from the Explorer.
  - Text and code files up to 1 MB are sent with their contents.
  - Images and PDFs up to about 7 MB are sent inline.
  - Other files outside the workspace are sent as links. The CLI then asks once per file before reading it.

The agent cannot read secret files such as `.env` and private keys, or git-ignored files, through the editor.

## Replies

Code in replies is coloured like the editor, in your colour theme. The button at the top of a code block copies it. A file name in a reply, such as `src/cart/total.ts:11`, opens the file at that line; when only the name is given, GeminiCode looks for it in the agent's folder. Notes, tips and warnings show as coloured callouts. Math written as `$...$`, `$$...$$`, `\(...\)` or `\[...\]` is typeset; prices and shell variables stay plain text.

Messages you send show Markdown the way replies do: bold, lists, `code`, code blocks and links, with your line breaks kept. In the composer, ⌘B makes the selection bold and ⌘E makes it code, typing a backtick over a selection wraps it in code, and ⇧↩ on a list line starts the next item; on an empty item it ends the list. The **Write** and **Preview** tabs at the top of the input (or ⇧⌘V) switch between your draft and how it will look once sent; typing in Preview goes back to Write. Agent Home's composer has the same tabs.

The chat and Agent Home composers underline misspelt words with your system's spell checker; right-click a word for suggestions or **Add to Dictionary**. Turn it off with `gemini.chat.spellCheck`.

While the agent works, its thoughts and steps show under a **Working** line, with steps of one kind in a row (nine searches, five commands) as one line that opens to each step. When the turn ends they fold under one line, such as **Worked for 3m 12s · read 14 files, searched 11 patterns, ran 9 commands**, with the answer below it. The files the turn changed stay in sight as chips that open their diffs, and so does any step that failed, with **Show output**; the line says **1 failed, fixed** when the same step later got through, and **Stopped after** in red when the turn ended on an error. A step that fails while the agent works opens its output by itself. Click the line to open the turn again. Turn folding off with `gemini.chat.foldFinishedWork`.

When the agent hands part of the work to one of the Gemini CLI's subagents (such as the Codebase Investigator, or your own in `.gemini/agents/`), the chat shows a **Subagent** row with its name and how long it has been working, then its time or **Failed**. Click it to read the subagent's report. The CLI doesn't send the subagent's own steps, so only the report shows.

Each message you send shows the time you sent it, **Rewind** and **Copy**. Under each reply, next to how long the agent worked, is the time it finished, with the same **Copy** button. The folder next to the branch under the composer names the agent's workspace (and its worktree, when it has one); click it to copy the path, reveal the folder in Finder or show the Agents pane.

## Restoring a Gemini CLI session

A new, empty agent lists the three sessions the Gemini CLI saved most recently for its folder, including ones started with `gemini` in the terminal, with a link to show them all. Pick one to continue it in that agent: its conversation appears in the chat, and the agent takes the session's title. `/resume` in the composer opens the same list at any time. Sessions open in another agent are left out. GeminiCode reads the list from the CLI's own files in `~/.gemini/tmp`, and changes them only to rewind a session, with the same record the CLI's `/rewind` writes. The CLI deletes saved sessions after 30 days; the list says when, and **Keep saved chats for** in Project Helpers changes it.

## Slash commands

Type `/` at the start of the composer, or choose **Skills and commands** in the **+** menu, to list commands: team commands first, then skills, then the CLI's own. Keep typing to filter, then press <kbd>Tab</kbd> or <kbd>Enter</kbd> to complete the name and add arguments.

- **Gemini CLI commands** such as `/init`, `/memory` and `/restore` come from the CLI and run in the CLI.
- **Team commands** are TOML files in `.gemini/commands/` in the workspace, or in `~/.gemini/commands/` for your own. This is the Gemini CLI's own format, so the same files work in the terminal. `git/commit.toml` becomes `/git:commit`. GeminiCode sends the file's `prompt`, with `{{args}}` replaced by what you typed after the name. `@{path}` puts a file's text in the prompt, and `!{command}` the output of a shell command run in the agent's folder. A workspace command replaces a personal one with the same name, and a CLI command wins over both.
- **Skills** are folders with a `SKILL.md`, in `.gemini/skills/` (or `.agents/skills/`) in the workspace or in `~/.gemini/skills/` (or `~/.agents/skills/`) for your own. Picking one asks the agent to load it, with what you typed after the name as the task. A team command or CLI command with the same name wins. A workspace's skills are offered only once you trust the folder.

```toml
description = "Review a file for bugs"
prompt = "Review {{args}} for bugs and suggest fixes."
```

`@{path}` reads a file in the workspace, following the same rules as the agent's file tools (no secrets, nothing git ignores, no folders), and leaves the placeholder with a note in the chat when it cannot. Before any `!{command}` runs, GeminiCode shows every command the team command will run and asks; inside `!{...}`, `{{args}}` is quoted for the shell. Commands need shell access (`gemini.tools.allowShell`), stop after a minute, and their output is cut at 100,000 characters. A file's text or a command's output is never searched for more commands.

## Updates

**GeminiCode: Check for Updates…** (also in the GeminiCode menu, under About GeminiCode) checks for a newer GeminiCode now and says whether you are up to date. GeminiCode also checks by itself every few hours and offers the download; turn that off with `gemini.app.checkForUpdates`.

## Notifications

When an agent finishes or needs your permission while GeminiCode is in the background, a system notification appears and the Dock icon bounces. Click it to open the agent. The Dock icon and the Agents pane show how many agents are waiting for you. Turn both off with `gemini.notifications.enabled`. macOS asks once whether GeminiCode may show notifications.

## Project Helpers: MCP servers, skills, hooks, extensions, memory and rules

**Gemini: Project Helpers** (also in the Agents pane's **...** menu) shows what every agent loads when it starts. Its **MCP servers** section lists the MCP servers in your personal `~/.gemini/settings.json` and in each open folder's `.gemini/settings.json`. Each has a switch that turns it on or off, the same way the CLI's `/mcp enable` and `/mcp disable` do, so the `gemini` command in your terminal sees the change too. A server reached by URL also has **Sign In**, for servers that need an OAuth sign-in: it runs the CLI's `/mcp auth` in a terminal, which opens your browser; type `/quit` when it is done and restart the agent. The CLI keeps the sign-in, so every agent can use the server. **Add Server** asks for a name and the command that starts the server, or its URL, and adds it to your personal settings. The page also opens or creates your project's rules (`GEMINI.md`, or the name in `context.fileName`) and your personal rules (`~/.gemini/GEMINI.md`). Changes apply to agents started afterwards; **Restart Agent** applies them now.

- **Skills** are folders with a `SKILL.md` that teaches Gemini a task, such as cutting a release. The page lists your own (`~/.gemini/skills`) and each project's (`.gemini/skills`, and `.agents/skills` in both places); a project's skills are listed only once you trust the folder, as the CLI loads them only then. **New Skill** (or **Gemini: New Skill**) makes one from a template and opens it. Gemini loads a skill by itself when a task calls for it; to use one now, pick it from the `/` menu, optionally followed by what to do. Each skill has a switch, like the CLI's `/skills enable` and `/skills disable`: it writes `skills.disabled` in the settings file of the skill's scope, and a skill that is off leaves the `/` menu. Turning on a project skill also removes it from your personal list, since the CLI keeps a skill off when either file does.
- **Hooks** are commands the CLI runs at set points: before or after a tool, when a turn starts or ends, and so on. Each has a switch, and **Add Hook** asks when it runs, which tools it applies to, the command and whether it is yours or the project's, then adds it to that `settings.json`. Turning on a project hook that your personal settings turn off also removes it from your personal list, since the CLI keeps a hook off when either file does. A project's hooks run only in trusted folders.
- **Extensions** lists the Gemini CLI extensions installed, as the CLI's own `/extensions list` reports them, with a switch to turn each on or off. **Install**, **Update** and **Uninstall** run the CLI's installer in a terminal, because it shows a security warning and may ask you questions; the page updates when it finishes.
- **Memory** lists the `GEMINI.md` files the CLI loads for the folder (`/memory list`), including those in subfolders and extensions. **Add Memory** adds a line under "Gemini Added Memories" in your own or the project's `GEMINI.md`; **Refresh** asks the CLI again.
- **Gemini CLI settings** are four of the CLI's own settings, in your personal `~/.gemini/settings.json`: **Allow for all future sessions** (`security.enablePermanentToolApproval`, off by default), **Plan with Pro, build with Flash** (`general.plan.modelRouting`, on), **Send usage statistics** (`privacy.usageStatisticsEnabled`, on) and **Keep saved chats for** (`general.sessionRetention`: 7, 30 or 90 days, or until you delete them; 30 days by default). A project's `.gemini/settings.json` can still override them, as in the CLI.

A settings file with comments is never rewritten: GeminiCode opens it at the right place instead, so you can make the change yourself.

Opening the page never starts the Gemini CLI. Extensions and memory are asked for when the agent is already running (and again when it starts); otherwise the page says so, and **Refresh** starts the agent and asks. A CLI without the `/extensions` or `/memory` command says so instead of a list.

When an MCP server cannot start, GeminiCode shows a warning naming the server and the reason, marks it on the Project Helpers page, and writes it to the Gemini log (**Gemini: Show Log**). The CLI does not report these over ACP, so GeminiCode reads them from the CLI's debug log, which it keeps under 1 MB in its own storage. If you set `GEMINI_DEBUG_LOG_FILE` yourself, GeminiCode leaves it alone and shows no warnings.

## The GeminiCode browser

Agents can open the web app they are working on in GeminiCode's browser and check their own work: read the page, click, type, press keys and take screenshots, while you watch. Ask, for example, "open http://localhost:5173 and check the cart total". Each agent gets its own tab beside its chat, with a **Gemini is using this page** bar; **Stop** on it stops the agent's turn. Pages on this machine (`localhost`, `127.0.0.1`) open freely, and local files follow the same rules as the agent's file tools. Any other site asks you first, once per agent and site, because a page can contain instructions aimed at the agent. That check uses the page's real address after every step, so a redirect or a link the agent clicks can't skip it. The tab opens beside the chat without taking focus. Default mode still asks before each browser action, like any other tool.

To let an agent use a page you opened yourself (a page you are signed in to, say), click the sparkle **Let Gemini Use This Page** in the page's toolbar, or run **Browser: Let Gemini Use This Page** from the Command Palette. Pick the agent (the open agents in this window, most recent first; with just one, it is used; with none, open an agent first). The page gets the **Gemini is using this page** bar, and the agent's chat comes to the front with the page attached, so you can say what to do with it; its browser tools then act on that page. The agent can read and use the page as you, signed in, so share only pages you trust it with. Your choice counts as allowing that site for that agent, files still follow its file rules, and the `gemini.browser.allowOtherSites` policy still applies. A page belongs to one agent at a time. While a page is shared, the agent's composer shows a **Shared page** chip, each message you send shows it too, and every message reminds the agent which page it is, so it checks its work there. Click the chip to go to the page's tab. The share lasts until you end it: the chip's ×, **Stop Sharing** on the bar (or **Browser: Stop Sharing This Page with Gemini**), closing the page or removing the agent gives it back to you; the page stays open. It survives the agent sleeping and the window reloading. Pages are never shared any other way.

Agents also read the page's console (`browser_console`, every level, filtered by text or level) and its requests (`browser_network`: method, URL, status and time, or just the failed ones), go forward and reload, right-click, answer a page's alert, confirm or prompt dialog, and list the web servers already running on this machine (`browser_dev_servers`), so they open yours instead of starting another. For a page on your network or behind your sign-in, such as a QA or intranet site, ask Gemini to open it in the browser or share it with **Let Gemini Use This Page**: the CLI's own web fetch can't reach private addresses, and when it refuses one the chat says so.

**Add to Gemini** in a page's toolbar puts the page into your prompt, for the agent using the page or else the chat in front. Its left side picks one element (or **Browser: Add Element to Gemini**, Cmd+Shift+C): click it and a chip with its place in the page, HTML and styles (and a picture of it) joins the composer. **Leave Notes for Gemini** (Cmd+Alt+C) lets you click elements and write a change on each, such as "make this button primary"; the notes stay pinned on the page, and **Send to Gemini** on the bar sends them as one numbered list, each with its element. The menu also adds a screenshot of the page or of an area you drag out, and the page's console.

With `gemini.browser.keepSignIns` on, agents' pages keep cookies and storage between sessions, separately for each workspace, so an agent signs in to a QA site once. They never share your own pages' storage: where your pages keep theirs per workspace too (remote windows, or `workbench.browser.dataStorage` set to workspace), and in untrusted windows, agents' pages stay in memory as before. An admin can limit agents to a list of sites with `gemini.browser.allowedOrigins` (`*` for all, `https://*.example.com` for a domain and its subdomains); agents' tools then stop on any other site, including local ones, though you can still open any site yourself.

Links to `localhost` from the terminal and chat also open in GeminiCode's browser. Turn the agent's browser off with `gemini.browser.enabled`; it stops at once for running agents, and turning it back on reaches each agent from its next new session; `gemini.browser.allowOtherSites` (also an admin policy) limits agents to local pages.

## Team tools: Jira, GitLab, SonarQube, Snyk and Figma

GeminiCode connects to your team's tools with your own account, so agents can read tickets, merge requests, CI logs, quality checks and designs, and you can run the whole cycle from a ticket to a merged merge request without leaving the app. Everything runs from your Mac, over your VPN; nothing goes through a GeminiCode or Google service except what an agent reads, which goes to Gemini as part of its prompt.

**Connect.** Open **Connections** (Command Palette: **Gemini: Connections**, or the tools item in the status bar). Each tool shows who you're signed in as, the server and when the token expires.

| Tool | How it connects | What you need |
| --- | --- | --- |
| Jira (Cloud) | REST API, your email and an API token | Create a token at id.atlassian.com (**Create Token** opens the page). |
| GitLab | REST API v4, a personal access token | Scope `api` to open merge requests and comment (`read_api` can only read). **Create Token** opens GitLab's page with the name and scope filled in. VPN on. |
| SonarQube | Web API, a user token | VPN on. |
| Snyk | Your Snyk CLI | `snyk` installed, `snyk config set endpoint=<your Snyk>` and `snyk auth` once. VPN on. |
| Figma | The Figma desktop app's Dev Mode MCP server | A Dev or Full seat; turn on the Dev Mode MCP server in Figma's preferences. |

Tokens go to the macOS keychain only, never to settings files or an agent's environment, and each is checked as you paste it. When a VPN-only tool doesn't answer, GeminiCode says "Can't reach … Check that your VPN is on" instead of waiting; the rest keep working.

**Team defaults.** A checked-in `.gemini/geminicode-tools.json` saves everyone typing addresses. It never holds tokens:

```json
{
  "jira": { "site": "https://acme.atlassian.net", "projects": ["ACME"] },
  "gitlab": { "url": "https://gitlab.acme.internal", "releaseBranches": "release/*", "defaultTarget": "develop" },
  "sonar": { "url": "https://sonar.acme.internal", "projectKey": "acme-checkout" }
}
```

`jira.projects` lets lower-case branch names such as `acme-412-gift` count as tickets; `gitlab.releaseBranches` is the pattern of your release branches; `sonar.projectKey` can also come from the repository's `sonar-project.properties`. `jira.commentVisibility` (a project role, such as `Developers`) limits who sees comments agents add.

**What agents get.** Every agent session gets a `geminicode-tools` MCP server with tools only for the tools you connected: `jira_get_issue`, `jira_search`, `jira_comment`, `jira_transition`, `jira_log_time`, `gitlab_get_mr`, `gitlab_list_mrs`, `gitlab_job_log`, `gitlab_get_issue`, `gitlab_create_mr`, `gitlab_reply`, `sonar_quality_gate`, `sonar_issues`, `snyk_test`, `snyk_code_test`, `figma_design` and `figma_screenshot`. Reading runs without asking. A Jira comment, status change or time log, a new merge request and a comment on one always show you a permission card with the exact text first.

**Home.** Home replaces Agent Home and opens in front of your restored tabs every time GeminiCode starts, in Agents and Editor mode (turn that off with `gemini.home.openOnStartup`; the Home button at the left of the status bar, the Home icon in an agent tab's toolbar, Cmd+Shift+H or **Gemini: Home** bring it back). Under the Start Agent composer and quick actions, **Needs you** lists what waits on you across the tools: an agent asking permission, a review request, a failed pipeline on your merge request, a reopened ticket. Six cards follow: Agents, My tickets (the current sprint's tickets assigned to you, with Start, Move, Log Time), Merge requests (waiting for your review, and yours with pipeline and approvals), Quality on the release branch (SonarQube gate and Snyk, with Fix), Releases (commits to merge forward) and Gemini. **Customize** hides and reorders cards and picks the release branch. Home shows the last data at once and refreshes each tool in the background; with the VPN off, VPN-only cards keep their last results, dimmed, and Jira keeps working. It never starts the Gemini CLI.

**In chat.** Paste a Jira key or link, a GitLab merge request or issue link, or a Figma link with a node and it becomes a chip with the tool's logo; sending attaches the ticket, merge request or a hint to read the design. The **+** menu's **From your tools** picks a ticket, merge request or Figma frame. Tool calls show the tool's logo and what they did ("Read ACME-412", "Comment on !318").

**From ticket to merge.**
- **Start Agent on a ticket** (Home, or **Gemini: Start Agent on Jira Ticket**): a new agent on its own branch named after the ticket, which reads the ticket and plans first; it offers to move the ticket to In Progress.
- **Run Checks**: Snyk on dependencies and code, and SonarQube's new-code issues for the agent's branch, each finding with **Fix**, or **Fix All with This Agent**.
- **Open Merge Request** (beside Merge back in Changes): first the target branch, always asked, with release branches first and the one matching the ticket's fix version suggested; then the title, a description Gemini drafts that you edit (or Regenerate), the files you choose to attach, reviewers, and draft and delete-branch options. It pushes the branch and opens the merge request, then offers to move the ticket.
- **Move Ticket** shows the moves your Jira workflow allows, any field a move needs, and a comment Gemini drafts that you edit, with who can see it. **Log Time** records time spent ("1h 30m"), the day and an optional comment, on its own or with a move.
- **The merge request panel** in Changes shows the pipeline (failed jobs with **Fix**), the SonarQube gate, Snyk and open review threads; **Fix Pipeline and N Comments** sends them to the agent.
- **Review** a merge request waiting for you: it is checked out in its own worktree and Gemini reviews it against the ticket, listing findings with a draft comment each. Tick and edit them, then **Post Comments and Request Changes**, **Post Comments** or **Approve**.
- **Merge Release Branch Forward**: pick a release branch and the later ones to merge it into. Each shows whether it merges cleanly; GeminiCode makes a merge branch and a merge request for each, and where files conflict an agent resolves them in its own worktree and shows you the result before anything is pushed.

Clicking a merge request asks whether to open it in GeminiCode's browser or your default browser; pick **Always Use…** to stop asking, or change `gemini.team.openMergeRequestsIn` later.

Nothing is written to Jira or GitLab without your click or your approval on a permission card.

**Config to change.** If your team's `.gemini/settings.json` has an `mcp.allowed` list, add `geminicode-tools` to it (Connections offers to). Remove the old `jira` and `gitlab` entries from `mcp.allowed` and `mcpServers` yourself once you've connected; until then agents see two sets of Jira and GitLab tools. The terminal `gemini` doesn't get the new tools.

## Review my changes

**Review My Changes**, in the Source Control title bar and the Agents pane's **...** menu, starts an agent in Plan mode with your uncommitted diff attached and new files listed. It reads the code around the changes and replies with a summary and its findings, most serious first, without editing anything. Ask it to fix one when you agree.

## Usage and quota

The ring at the bottom right of the composer shows how full this chat's context window is: the tokens in the latest request out of the model's 1M, as the Gemini CLI footer counts them. It turns amber at 50%, where Gemini starts summarising older messages, and red at 90%. Click it, choose **Usage and quota** in the **+** menu, or run **Gemini: Show Usage and Quota** to open the popover. **Context window** repeats that figure. **Today's quota** is for your account: how much of today's quota each model has used and when it resets; GeminiCode reads it when you open the popover, unless it read it in the last minute. It lists the four models with the most use; **All models** shows the rest. **This chat** totals the input, cached and output tokens over the chat's replies, as the Gemini CLI reports them with each reply; **Details by model** splits them by model. Input counts the conversation again for every model call within a reply, as the CLI's `/stats` does, so a reply with many tool calls counts more. Replies saved before GeminiCode kept these counts have none. Escape or a click outside closes it.

Once a model passes 80% of today's quota, the popover also offers **Get higher limits**, the page the CLI's `/upgrade` opens.

You can also hover the **Gemini** item in the status bar to see today's quota. Once a model passes 80%, the item shows the percentage. Turn the quota off in both places with `gemini.usageMeter.enabled`. The quota needs a Google sign-in; API keys have none to read.

## Long conversations

The Gemini CLI manages the model's context. When a session's history reaches half of the model's context window, the CLI summarises the older part and keeps the most recent 30% as it was. Large tool outputs are cut to 40,000 characters. Both limits come from the CLI's own settings (`model.compressionThreshold` and `tools.truncateToolOutputThreshold` in `~/.gemini/settings.json`).

GeminiCode keeps its own share small:

- Saved conversations keep the last 300 messages, each cut to 20,000 characters.
- Messages scrolled out of view are not laid out, and streaming sends only new text.
- Proposed edits are remembered for the last 200 tool calls. Older diff links open the file as it is now.

When you scroll up in a chat, **Latest** above the input takes you back to the newest message.

To find your way round a long chat, use the thin outline of your prompts down the chat's right edge: point at a tick to see the prompt, click it to jump there. ⌥⌘↑ and ⌥⌘↓ jump to your previous and next prompt. **Open Chat as Markdown** (in an agent's right-click menu in the Agents pane, or the Command Palette for the chat in front) opens the whole conversation as a Markdown document you can search, save or share. For an agent that is not running, it opens the saved copy, which keeps the last 300 messages.

Every agent in a window shares one Gemini CLI process, and that process keeps each session's history until it restarts. For a fresh session, start a new agent. If an old agent is no longer needed, remove it from the Agents pane, which also deletes its saved conversation.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The status bar says sign-in is needed | Run **Gemini: Sign In with Google**. If it needs a step the editor cannot show, run **Gemini: Complete Setup in Terminal**, finish it, and exit with `/quit`. |
| "is a project number" | Set the project ID, such as `my-project-123`, with **Gemini: Set Google Cloud Project ID**. |
| No Gemini CLI found | Only in a build without the bundled CLI. Run **Gemini: Install Latest Gemini CLI**, or set `gemini.cliPath`. |
| "older than 0.64.0" | The CLI in use is too old. Choose **Install Latest**, or run **Gemini: Install or Change Gemini CLI Version...**. |
| Not sure the CLI starts at all | Run **Gemini: Check Agent Connection**. It starts the CLI on its own and reports its version and protocol, or the error. |
| The agent stops or misbehaves | Click the **Gemini** status bar item and choose **Restart Agent**. Open agents resume their sessions. |
| Something else | Click the **Gemini** status bar item and choose **Report an Issue...**, which opens a new issue with the GeminiCode, VS Code, Gemini CLI and OS versions filled in. Run **Gemini: Show Log** and include the relevant lines, with account names and project IDs removed. **Gemini CLI Docs** in the same menu opens the CLI's documentation. |
