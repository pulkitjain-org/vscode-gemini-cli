# Agents

An agent is a Gemini CLI session with a tab of its own: its chat, the files it opened, the changes it made and its own [terminal](terminal.md). You can run several at once, one fixing a bug while another writes tests, and switch between them as you would between files. When agents might trip over each other's edits, give one its own branch; when one agent's work splits in two, fork it. Every agent finds code through a local index of its workspace, and searches the documentation you attach.

![An agent's chat with the files it opened in a group beside it](../../site/media/files-dark.webp)

## Agents and Editor layouts

GeminiCode has two layouts. Switch between them with the **Agents | Editor** switch at the top of the window, or <kbd>⌥⌘M</kbd>.

- **Agents layout**, the default, is for working with agents: your agents on the left and the chat in the middle. The agent's changes open on the right when the agent in front starts changing files; the window opens with them closed, and if you close them during a turn they stay closed until the next turn changes something. Opening Explorer, Search or any other view switches to the Editor layout with that view open.
- **Editor layout** is the classic VS Code layout, with Explorer, Search and Source Control, for hands-on coding. The agent's changes sit below the Agents pane.

In the Agents layout the top of the window is a single row: the Home button, the layout switch, your open tabs (agents, Home, files and browser pages) in one capsule, then a globe for the browser, a magnifier for Quick Open, and the layout buttons. Each layout remembers which panels you had open.

## Home

**Home** is where you start agents and see what needs you. It opens when no tab is open in the Agents layout, and in front of your restored tabs each time GeminiCode starts. It greets you, and below that come one composer and a few cards.

To start an agent, describe the task and press Return (or **Start agent**). You can also paste a Jira, GitLab or Figma link as the task. Under the task, choose where the agent works:

- **Here**: in this folder, on your current branch.
- **On a branch**: a new branch in a folder of its own (see [Agents on their own branch](#agents-on-their-own-branch)).

Hold the pointer over a choice to see what it does. A branch needs a Git repository; in a folder outside one the choice isn't shown and the agent works here.

While Projects are on (`gemini.projects.enabled`, on by default), the chevron beside **On a branch** offers **On its own branch** or a project: the projects of the folder's repository first, then those of other repositories, and **New Project in** the folder. A task sent to a project goes to its coordinator, which makes it a thread or passes it on (see [Projects](projects.md)). The choice then shows the project's name, and the button reads **Send to Project**, or **Start Project** for a new one.

The bar under the composer has:

- the folder the agent works in. The folder picker marks each folder **Trusted**, **Trusted by parent** or **Needs trust**, and **Open Folder...** adds a folder for agents without adding it to the window.
- the approval mode the agent starts in.
- the model it starts with.
- **From your tools...**, which lists your Jira tickets and GitLab merge requests so you can start on one. Until you connect Jira or GitLab it says so.

**On a branch**, alone or in a project, needs a trusted folder. In one that isn't trusted, Home says so in place, with **Trust...**. See [Folder trust](review.md#folder-trust).

The composer's **+** menu has the actions for this folder, **Review** and, once Snyk or SonarQube is connected, **Run checks...**, then **Files** to attach files or images.

Cards follow the composer:

- **Pending on you**: GitLab merge requests waiting for your review or assigned to you, and your own with their pipeline, approvals and whether they can merge.
- **Your tickets**: your open Jira tickets, this sprint's first, with **Start** on each one not yet begun or reopened.
- **Agents**: the agents at work, each with its state and **Review** on one whose changes are ready, then your projects. **All agents** shows the Agents pane, and **Show all** lists earlier agents too.
- **Gemini**: how much of today's quota you have used, the GeminiCode and Gemini CLI versions and the project, and a link to the audit log.

Until you connect GitLab and Jira, their cards offer to connect. See [Team tools](team-tools.md#home). A card's title shows, as its tooltip, the query that fills it, so you can check its numbers against the tool.

**Refresh**, beside the gear at the top right, reads Jira, GitLab, SonarQube and Snyk again; it spins until they answer, and its tooltip says when the cards were last updated. **Customize**, the gear, holds **Settings** ([The Settings page](helpers.md)), turns each card on or off and moves it up. The **Quality** card, with SonarQube's quality gate and Snyk's issues on a release branch, is off until you turn it on there; the same menu picks its release branch.

If GeminiCode quit while a Jira or GitLab change was running, **Unfinished when GeminiCode last quit** comes first, listing the flows to reopen and any write whose result never came back. In the chat, a turn that was cut off shows a card with **Retry the Turn**.

To get back to Home, click the house at the start of the title bar, press <kbd>⇧⌘H</kbd> (outside the editor, where it is Replace in Files), or run **Gemini: Home**. To stop it opening at start-up, turn off `gemini.home.openOnStartup`.

In the Agents layout the agent list highlights the agent, project or thread whose tab is in front. The status bar leaves out the window's repository, branch and problem counts, because each agent's own folder and branch show under its composer. The Editor layout keeps them.

## Agents side by side

The Agents pane lists your agents under the folder each works in. A folder's projects come first, each a row you can expand to see its threads, then its agents, most recently used first. A fork hangs under the agent it came from, joined to it by a line, and the agents you archived are under an **Archived** row.

![The Agents pane with one agent working, the others done, and a fork under the agent it came from](../../site/media/agents-pane-dark.webp)

A row has a mark only when the agent is busy or wants you: a spinner while it works, a yellow dot when it needs you, a green dot when it has finished and you haven't looked yet, and a red dot when something went wrong. An agent with nothing to tell you has no mark, so the quiet ones stay out of your way. On the right the row shows how long the current turn has run, "needs you", the lines the agent added, or when it was last active. Point at a row to see its state, its changes, and its branch and folder.

Click an agent to show it. Agents you click share one tab: the next agent you click takes its place there, and the one it showed carries on with its turn. An agent gets a tab of its own once you send it a message, or when you choose **Keep in own tab** in the tab's title bar or under **More** in the row's right-click menu.

Each agent's tab shows the same: a spinner while it works, an amber dot when it needs you, a red mark when something went wrong, a tick when it has finished, and how many lines it has added and removed.

Hovering over a row shows buttons for **Open Changes**, **Fork Agent**, **Try in Workspace** (on its own branch) and **Stop Agent** (while it works). The row's right-click menu has **Open Agent**, **Rename...**, **Fork Agent**, **Stop Agent**, **More** and **Remove Agent** (**Remove Project** on a project's row; see [Remove a project](projects.md#remove-a-project)). **More** holds the rest: **Open Changes**, **Merge Back**, **Try in Workspace**, **Take Back**, **Move to its own branch**, **Open Terminal**, **Open Chat as Markdown** and **Keep in own tab**, and for a project **New Thread** and **Project Settings**. A folder's right-click menu starts agents and projects there, holds its **Index** commands, and **Remove Workspace from List**.

**Gemini: Stop Agent** (<kbd>⌘esc</kbd>) stops the agent in front. Removing an agent deletes its conversation and undo history, and the question names any files whose changes you haven't reviewed yet. **Archive**, in the same question, keeps all of that and moves the agent under **Archived**, out of the list and off Home; its next prompt brings it back.

- In the Editor layout, agents that are working, waiting, finished but not yet read, or stopped by an error show as pills in the title bar.
- Right-click GeminiCode in the Dock for **New Agent**.
- In a window with several folders, each agent keeps to the folder it works in, and **@** in its composer offers only that folder's files. Turn on `gemini.agents.allWorkspaceFolders` to let every agent use all of them.

A new agent starts on your task as soon as you press Return, because GeminiCode keeps a session open and ready.

## Files beside each agent

Files, diffs, pages and terminals an agent opens go in an editor group beside its chat, with a tab row so you can close them. Each agent has its own group. Switching agents hides the other groups without closing them, so when you come back to an agent its files are as you left them. Closing an agent's tab, or removing the agent, closes its files, except those with unsaved changes.

To give a page more room, such as Plan Review, a diff or the browser, click **Expand** at the top right of the group. The page opens over the whole window, with the chat dimmed behind it. **Back Beside the Chat**, Escape or a click outside it puts the page back where it was, with nothing lost.

![An agent's chat with the column in its right margin: where it works, Changes with the lines added and removed, Browser, Terminal and Files](../../site/media/agent-links-dark.webp)

The right margin of an agent's or a thread's chat has a column of links, so what the agent has made is one click away:

- **On** names where the agent works: the folder, or its branch.
- **Changes** opens what the agent changed, with the lines added and removed beside it.
- **Browser** shows the page the agent has open, or opens a new one in its group.
- **Terminal** opens the agent's terminal. See [The agent's terminal](terminal.md#the-agents-terminal).
- **Files** opens the agent's Files page.

The column never moves the chat. In a narrower chat it becomes a row of icons, and it hides when there is no room. A project's coordinator has none, since it changes no files itself.

### The Files page

The Files page lists the agent's folder, which is its own branch's folder for an agent on its own branch. It has a search for files and folders, **New File**, the files you recently opened from it, and the folder as a tree, with ignored files dimmed.

![An agent's Files page beside its chat, with the search, New File, recent files and the folder tree](../../site/media/agent-files-dark.webp)

Opening a file shows it in the agent's group and moves the page into a narrow column beside it, showing only the tree, so you can open the next file from there. The column keeps its width when you switch agents and back, and when you close the last file, the page takes its place again.

![A file open in an agent's group, with the Files page as a narrow tree beside it](../../site/media/agent-files-beside-dark.webp)

## Follow the agent

To watch an agent work, turn on **Follow the agent** in the composer's **+** menu. Each file the agent reads opens at the line it is on, and each file it edits opens once the edit is written. Focus stays in the chat.

The file opened last is named under the composer. Click the name to show it, or **×** to close it.

Files outside the agent's folder, and files that may hold secrets, such as `.env` or anything under `.ssh`, are never opened this way.

## Agents on their own branch

Two agents in the same folder can trip over each other's edits. To keep them apart, give an agent its own branch: choose **New Agent on Its Own Branch** (the branch icon next to **+** on a workspace in a Git repository) and enter a branch name. The agent gets its own copy of the repository, on that new branch, in `~/.geminicode/worktrees/<repository>/`. It reads, edits and runs commands there, so your folder and other agents are untouched.

An agent already at work in your folder can move to a branch of its own: choose **Move to its own branch** in its tab's title bar, or under **More** in its row's right-click menu. Its chat and your uncommitted changes go to a new branch in a folder of their own, and the original agent is archived. The changes stay in your folder too, unless you choose **Move and undo here**, which takes the agent's changes out of your folder once they are on the new branch. Wait for the agent's turn to end, or stop it, before moving it.

When the work is done, **Try in Workspace** (the beaker icon on the agent's row, under **More** in its right-click menu, or in the Changes panel) copies the agent's changes into your checkout of the repository as unstaged files, so your local server and tests run with them. Nothing is committed, staged or merged: your branch, its index and HEAD stay as they are. Each time the agent finishes a turn, your workspace updates with what it changed. The status bar shows **Trying:** and the agent's name, and in Source Control the tried files carry a **T**.

![An agent's changes tried in the workspace: Source Control lists them unstaged with a T, the diff of one is open, and the status bar says Trying](../../site/media/try-scm-dark.webp)

While you try it, the Changes panel offers **Keep Changes** and **Take Back**:

- **Keep Changes** makes the changes yours, unstaged; commit them when you're ready. Committing the tried files yourself keeps them too.
- **Take Back** removes the agent's changes from your workspace. Edits you made yourself stay.

Edits you make to the tried files stay through every update. To hand them to the agent, tick **Include your edits to** the files above its message box: they are copied into its folder before your message, so it builds on them. When you and the agent changed the same lines, the file gets conflict markers, and updating waits until you resolve them. A file with unsaved edits updates when you save it. One agent's work is tried in a workspace at a time. Removing an agent whose work you are trying asks first: **Keep Changes and Remove** or **Take Back and Remove**.

The chevron beside **Try in Workspace** in the Changes panel offers the other ways to take the work. It remembers your pick for the repository, and the button then does that:

- **Merge Back** commits anything the agent left uncommitted, with a message written from its diff, and merges its branch into the branch your folder has checked out. If the merge conflicts, it stops so you can finish it in Source Control; after a clean merge, it offers to remove the agent with its branch and folder. Merge Back is also under **More** in the agent's right-click menu.
- **Open Merge Request**, with GitLab connected, pushes the branch and opens a merge request. See [Team tools](team-tools.md#the-open-merge-request-page).

A new copy has no `node_modules` or build output. To get it ready before the agent starts, set **Gemini › Agents: Worktree Setup** in your user settings to a command such as `npm ci` (a repository's own settings can't set it), or commit a `.gemini/worktree-setup.sh` to the repository. Before a repository's script runs the first time, GeminiCode shows it and asks: **Don't Run**, **Run Once** or **Run and Remember**. It asks again whenever the script changes, and runs none in a workspace you haven't trusted. The command can use `GEMINI_SOURCE_REPOSITORY`, the repository the copy came from, to copy files Git doesn't carry, such as `.env`. If setup fails, the agent starts anyway, and the output is in the **Gemini Worktree Setup** output channel.

To start every new agent on its own branch, turn on `gemini.agents.ownBranch`: Home's chooser then starts on **On a branch**.

## Fork an agent

When an agent's work splits in two, fork it. The fork is a new agent that starts from the same conversation, so it already knows what the agent read, decided and planned. It works on its part while the original carries on.

There are two ways to fork:

- **Fork Agent** forks the conversation as it is. It is the split-arrows icon on an agent's row (on hover), **Fork Agent** in the row's right-click menu and **Fork** in the composer's **+** menu, and you can type `/fork`.
- **Fork**, beside Retry at the end of any reply, forks the conversation as it was at the end of that reply.

![The Fork dialog with Whole session, Compressed and Conversation only, and a new branch or the same folder](../../site/media/fork-dialog-dark.webp)

In the Fork dialog, **Context** is what the fork takes with it. Each choice shows about how many tokens it sends with every request.

- **Whole session** is an exact copy of the agent's session, tool output included.
- **Compressed** has Gemini summarise the older work first and keeps the latest messages as they were. It is much smaller, and waits for the agent to finish its turn. Large sessions start on this choice.
- **Conversation only** has your messages and the agent's replies, without tool output.

**Where it works** is one of:

- A **new branch** off the agent's branch, in its own copy of the repository, with the agent's uncommitted changes copied in. The agent's own folder is left as it is.
- The **same folder** as the agent. This suits questions, reviews and plans, but both agents change the same files.

The dialog also asks for a name, a model (the agent's own unless you pick another) and an optional first message.

A fork is listed under the agent it came from, and the agent's chat gets a card for it with **Open** and, for a fork on its own branch, **Try in Workspace**. That button does what the Try button does for the repository: it tries the fork's work in your checkout, or merges it back when you picked **Merge Back**. When the agent itself works on its own branch, Merge Back asks whether to merge the fork into the agent's branch or into the branch your folder has checked out. Removing an agent that has forks asks whether to remove them too; forks you keep stay as agents of their own.

![A fork listed under its agent in the Agents pane, and the fork's card in the agent's chat with Open and Try in Workspace](../../site/media/fork-list-dark.webp)

## Workspace index and docs

GeminiCode keeps an index of the code in each workspace, and of any documentation you attach. With it, an agent finds the code it needs in one step instead of searching file by file. The index stays on your Mac, in `~/.geminicode/index`, and is built in a separate process at low priority, so it never slows the editor.

![The Index page with the workspace indexed and the Vitest docs attached](../../site/media/index-page-dark.webp)

The index has its own page, the **Index & Docs** tab of Settings. Open it with **Gemini: Manage Index**, **Manage Index** in the **Gemini** status bar item's menu, or the tab at the top of the Settings page.

### Index tools for agents

Every agent's session gets the `geminicode-index` tools for the folder it works in:

| Tool | What it answers |
| --- | --- |
| `code_search` | The code that best matches some words, a name in any case (`applyDiscount`, `apply_discount`) or a short description. Results are whole functions or classes where possible, with path and line numbers. |
| `find_symbol` | Where a function, method, class or type is defined, with its first line, and optionally every line that uses it. Use `Container.name` for a method. |
| `related_files` | A file's imports, the files that import it, its tests, and the files most often changed in the same commits. |
| `repo_map` | An outline of the folder or a subfolder: what the project says it is, its languages, its folders and the public definitions in each. |
| `docs_search` | The documentation attached to the workspace, when there is some. |
| `code_type` | A function's, variable's or class's type and documentation, from the editor's language server: what hovering shows. |
| `code_diagnostics` | Errors and warnings in the files the agent changed, or the files it names, from the language servers: a check after an edit without running a build. |
| `code_calls` | What calls a function, or what it calls, as the language server resolves them. |
| `research` | A broad question that needs many parts of the code read, such as "where are auth tokens read, stored or logged?". Several read-only readers each read one area at once, and the agent gets one report with `path:line` evidence. It takes a few minutes, and stops after eight minutes with what its readers found by then. |

GeminiCode is an editor, so its language servers are running already: agents ask them through the same tools. `find_symbol` with references lists the exact uses of a symbol, through imports and aliases, where a language server covers the file, instead of every line that shares its name. Where none answers (a language with no extension, a server still loading, or an agent's own branch outside the workspace), the index answers alone and the result says so. When a turn changes files and the language servers report errors in the folder's changed files, a notice under the turn lists them, with **Fix**, which asks the agent to fix them and check again. Agents only reach files in their own folder that are neither secret nor ignored by git.

Each session also starts with a short outline of the folder, so the agent knows its way around before its first search. Once the index is built, the session's first prompt asks the agent to use these tools before searching file by file. Results rank the code above its tests, unless you ask about tests, and say when they are complete, so the agent reads only what they point to. In the chat, the calls read as "Search code for ...", "Look up ..." and so on.

GeminiCode also gives the Gemini CLI the app's own ripgrep, so the agent's plain text searches are fast too, with or without an index.

An agent uses these tools only in a folder the Gemini CLI trusts. The Index page says when a workspace isn't trusted, and offers **Trust Folder**, which asks first, as Chat does, since trust also lets the Gemini CLI load the folder's MCP servers, hooks and project settings.

### One index per workspace

Each workspace has its own index. An agent on its own branch starts from a copy of its workspace's index, so it is ready at once. Indexes never mix, and two GeminiCode windows on the same folder share one index that only one of them writes.

By default a workspace is indexed the first time an agent starts there. Until the index is ready, the tools answer from a plain text search and say so. `gemini.index.buildOn` changes when the first build happens: when an agent starts (the default), when the window opens, or only when you choose **Index Now**.

After that, the index keeps itself up to date:

- a file you save, add or delete, about a second later
- a checkout or a pull, when the branch moves
- an agent's edits in its own worktree, as it makes them

The **Gemini** status bar item shows **Indexing N%** while a large build runs; hover it for each folder's progress. Small updates don't show.

For each workspace, the Index page shows its state and size, with:

- **Index Now**, for a workspace that has no index yet
- **Rebuild**, to build the index again from scratch
- **Pause** and **Resume**, while a build runs
- the trash icon, to remove the index; the next agent that starts there builds a new one

### What is left out

By default, an index leaves out files git ignores, entries in `.geminiignore`, secret files such as `.env` and private keys, binaries, lock files, minified code and files over 1 MB. Add exclusions of your own with `gemini.index.exclude`, in `.gitignore` syntax.

**Files Left Out**, on the Index page, lists the files that were skipped, grouped by reason, with a filter. To index one anyway:

- **Index Anyway** on a file adds it to `gemini.index.include`. It is indexed a moment later, without a rebuild.
- **Index All Anyway** does the same for a whole group, up to 50 files.
- For more than that, add a pattern such as `src/generated/**` with **Edit Included Files**.

Included files are indexed even when they are generated, minified or lock files, are listed in `.geminiignore` or `gemini.index.exclude`, or are over the size limit (up to 16 MB). Secret files and files with binary content are never indexed.

**Open .geminiignore** opens the folder's ignore file, creating it if needed. The Gemini CLI reads the same file.

### Attach documentation

Attach a library's documentation, and agents search it with `docs_search` instead of fetching pages from the web.

1. Choose **Add Docs**, or **Add** on a suggestion.
2. Enter the address, such as `https://react.dev/reference`.
3. Choose what to fetch: only that page, the pages under that address, or the whole site. GeminiCode uses the site's `llms.txt` or sitemap when it has one, and otherwise follows links under the address.
4. Pick how many pages to fetch at most, how often to refresh them, and which workspaces can search them.

Pages are fetched from your Mac, through its network settings, and stored once however many workspaces use them. Fetching follows the site's `robots.txt`. Pages behind a sign-in can't be indexed: a page that asks you to sign in is reported rather than stored. Agents treat fetched pages as reference material, never as instructions.

Each source is refreshed daily unless its own row says otherwise. A page that hasn't changed costs one small request. The switch on a source detaches it from the workspace without deleting it.

**Suggested from your dependencies** offers the documentation of the libraries your `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `build.gradle` names, for the versions you use. The list ships with GeminiCode, so nothing is looked up to make it.

### Index settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.index.enabled` | on | Keep indexes and give agents the index tools, which ask the editor's language servers too. |
| `gemini.index.buildOn` | `agentStart` | When a workspace's index is first built. |
| `gemini.index.exclude` | empty | Extra files and folders to leave out, in `.gitignore` syntax. |
| `gemini.index.include` | empty | Files to index even though they would be left out, in `.gitignore` syntax. |
| `gemini.index.maxFileSizeKb` | 1024 | Larger files are left out. |
| `gemini.docs.enabled` | on | Allow attaching documentation from the web. |
| `gemini.docs.allowedDomains` | empty | The only sites docs may come from, such as `react.dev` or `*.example.com`. Empty allows any site. |

See [Settings](settings.md) for the rest.

## Pick up a Gemini CLI session

A new, empty agent lists the three sessions the Gemini CLI saved most recently for its folder, including ones you started with `gemini` in a terminal, with a link to show them all. Pick one to continue it: its conversation appears in the chat, and the agent takes the session's title.

Type `/resume` (or `/chat`, as the CLI also calls it) in the composer to open the session browser at any time. It lists each session's first prompt, how many prompts it has and when it was last used, newest first; type to search them. The trash icon on a row deletes the session's files, as the CLI's `--delete-session` does. GeminiCode opens sessions on the folder's real path, as a terminal does, so the two share one list.

The CLI deletes saved sessions after 30 days. The list says when each one goes, and **Keep saved chats for** in [Settings](helpers.md#gemini-cli-settings) changes how long they are kept.

## Notifications and keeping awake

When an agent finishes, or needs your permission, while GeminiCode is in the background, a notification appears and the Dock icon bounces. Click the notification to open the agent. The Dock icon and the Agents pane show how many agents are waiting for you. `gemini.notifications` keeps the notifications to the agents that need you, or turns them off; the Dock icon counts either way.

While any agent works, GeminiCode keeps the Mac from going to sleep, so a long task carries on when you step away. The display can still sleep. Turn this off with `gemini.keepAwake`.

