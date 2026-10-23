# Agents

Run several Gemini agents side by side, each with its own chat, files and changes. Give one its own branch when agents might trip over each other's edits. Every agent finds code through a local index of its workspace, and searches the documentation you attach.

![An agent's chat with the files it opened in a group beside it](../../site/media/files-dark.webp)

## Agents and Editor modes

The switch at the top of the window, or <kbd>⌥⌘M</kbd>, changes the layout:

- **Agents mode** (the default) is for working with agents: your agents on the left, the agent's chat in the middle, and its changes on the right. Opening Explorer, Search or any other view switches to Editor mode with that view open.
- **Editor mode** is the classic VS Code layout, with Explorer, Search and Source Control, for hands-on coding. Changes sits below the Agents pane.

In Agents mode the top of the window is one row: the Home button, the **Agents | Editor** switch, your open tabs (agents, Home, files and browser pages) in one capsule, then a globe for the browser, a magnifier for Quick Open and the layout buttons. Each mode remembers which panels you had open.

## Home

**Home** opens when no tab is open in Agents mode, and in front of your restored tabs each time GeminiCode starts. Describe a task in **Start Agent** and press Return to start an agent on it; tick **On its own branch** to give it a branch of its own. The drum icon beside the workspace shows its [index](#workspace-index-and-docs): full when indexed, half full while indexing, empty when not; click it to open the Index page.

The composer's bar shows the folder, the branch switch, the mode and the model the agent starts on; **From Your Tools…** lists your tickets and merge requests to start on one. **Project Helpers**, at the right under the composer, opens the MCP servers, rules and hooks of your projects. Below it, **Needs you** lists what waits on you, such as an agent asking permission. Cards follow for your agents and, once you connect them, your tickets, the merge requests pending on you and yours, quality checks and Gemini's usage (see [Team tools](team-tools.md#home)). Each card names the query that fills it beside its title, so its numbers can be checked against the tool. **Customize** hides and reorders cards.

After GeminiCode quits while something was running, two cards come first: **Unfinished when GeminiCode last quit**, with the flows to reopen and the writes whose result never came, and **What came back, and when**, which stays for a few minutes and says what is already back and what is still starting. In the chat, a turn that was cut off shows a card with **Retry the Turn**.

The house at the start of the title bar, before the Agents | Editor switch, <kbd>⇧⌘H</kbd> or **Gemini: Home** brings it back. In Agents mode the agent list highlights the agent, project or thread whose tab is in front, and the status bar leaves out the window's repository, branch and problem counts: each agent's own folder and branch show under its composer. Editor mode keeps them. To stop it opening at start-up, turn off `gemini.home.openOnStartup`.

## Agents side by side

Each agent opens as a tab with its own chat. Its tab shows what it is doing: a spinner while it works, an amber dot when it needs you, a tick when it has finished, and how many lines it has changed.

In the Agents pane, each agent's row has the same signal (green when finished, red when something went wrong, grey otherwise) and, on the right, how long it has been working, "waiting", the lines it added, or when it was last active. Point at a row for its branch and folder. Rename, stop or remove an agent from its right-click menu, which is drawn in GeminiCode's own theme.

- In Editor mode, agents that are working, waiting, or finished but not yet read show as pills in the title bar.
- On a Mac, right-click GeminiCode in the Dock for **New Agent**.
- In a window with several folders, each agent keeps to the folder it works in. Turn on `gemini.agents.allWorkspaceFolders` to let every agent use all of them.

A new agent starts on your task as soon as you press Return, because GeminiCode keeps a session open and ready.

## Files beside each agent

Files, diffs and pages an agent opens go in an editor group beside its chat, with a tab row so you can close them. Each agent has its own group: switching agents hides the others' groups without closing them, so coming back to an agent shows its files as you left them. Closing an agent's tab, or removing the agent, closes its files, except those with unsaved changes.

## Follow the agent

Turn on **Follow the agent** in the composer's **+** menu, or run **Gemini: Follow the Agent**, to watch the agent work. Each file it reads opens at the line it is on, and each file it edits opens once the edit is written. The file it opened last is named under the composer; click the name to show it, or **×** to close it.

Files outside the agent's folder, and files that may hold secrets such as `.env` or anything under `.ssh`, are not opened. Focus stays in the chat.

## Agents on their own branch

Two agents in the same folder can trip over each other's edits. **New Agent on Its Own Branch** (the branch icon next to **+** on a workspace in a Git repository) asks for a branch name and gives the agent its own copy of the repository on that new branch, in `~/.geminicode/worktrees/<repository>/`. The agent reads, edits and runs commands there, so your folder and other agents are untouched.

When it's done, **Merge Back** (the merge icon on the agent's row) commits anything the agent left uncommitted and merges its branch into the branch your folder has checked out. If the merge conflicts, it stops for you to finish in Source Control. After a clean merge it offers to remove the agent with its branch and folder.

The new copy has no `node_modules` or build output. To get it ready before the agent starts, set **Gemini › Agents: Worktree Setup** to a command (such as `npm ci`), or commit `.gemini/worktree-setup.sh` to the repository. `GEMINI_SOURCE_REPOSITORY` names the repository it came from, to copy files Git doesn't carry, such as `.env`. If setup fails, the agent starts anyway; its output is in the **Gemini Worktree Setup** output.

To start every new agent on its own branch, turn on `gemini.agents.ownBranch`.

## Workspace index and docs

Agents in GeminiCode keep an index of the code in each workspace, and of the documentation you attach, so they can find code in one step instead of searching file by file. The index stays on your Mac, in `~/.geminicode/index`, and is built in a separate process at low priority, so it never slows the editor.

Open it from **Index** on Home, beside Project Helpers, or with **Gemini: Manage Index**. Beside the workspace in Home's composer, a drum icon shows the workspace's index: full when it is indexed, half full while indexing, empty when it isn't indexed yet. Point at it for which, and click it to open the Index page.

### Index tools for agents

Every agent's session gets the `geminicode-index` tools for the folder it works in:

- **code_search** returns the best-matching code for words, a name in any case (`applyDiscount`, `apply_discount`) or a short description. A result is a whole function or class where possible, with its path and line numbers.
- **find_symbol** says where a function, method, class or type is defined, with its first line, and optionally every line that uses it. Use `Container.name` for a method.
- **related_files** lists a file's imports, the files that import it, its tests, and the files most often changed in the same commits.
- **repo_map** outlines the folder or a subfolder: what the project says it is, its languages, its folders and the public definitions in each.
- **docs_search** searches the documentation attached to the workspace, when it has some.

Each session also starts with a short outline of the folder, so the agent knows its way around before its first search, and once the index is built the agent's first prompt asks it to use these tools before searching file by file. Results rank the code itself above its tests (unless you ask about tests) and say they are complete, so the agent reads only what they point to. In the chat the calls read as "Search code for …", "Look up …" and so on.

GeminiCode also gives the Gemini CLI the app's own ripgrep, so the agent's text searches are fast too, with or without the index.

An agent only uses the tools in a folder the Gemini CLI trusts. The Index page says when a workspace isn't trusted, with **Trust Folder**.

### One index per workspace

Each workspace has its own index, and an agent's own branch (its worktree) starts from a copy of its workspace's index, so it is ready at once. Indexes never mix, and two GeminiCode windows on one folder share one index that only one of them writes.

A workspace's index is built the first time an agent starts there. Until it is ready, the tools answer from a plain text search and say so. Change when indexes are built with `gemini.index.buildOn`: when an agent starts (the default), when the window opens, or only when you choose **Index Now**.

After that the index keeps itself up to date: saved, added and deleted files a second after you change them, a checkout or pull when the branch moves, and an agent's edits in its worktree as it makes them.

Left out of every index: files git ignores, entries in `.geminiignore`, secret files such as `.env` and keys, binaries, lock files, minified code and files over 1 MB. Add your own exclusions with `gemini.index.exclude`, in `.gitignore` syntax.

**Files Left Out** opens a list of them, grouped by reason, with a filter. **Index Anyway** on a file adds it to `gemini.index.include`, and it is indexed a moment later without a rebuild; **Index All Anyway** does it for a whole group of up to 50 files. For more, add a pattern such as `src/generated/**` with **Edit Included Files**. Included files are indexed even if they are generated or minified, are lock files, are listed in `.geminiignore` or `gemini.index.exclude`, or are larger than the size limit (up to 16 MB). Secret files and files with binary content are never indexed. **Open .geminiignore** opens (or creates) the folder's ignore file, which the Gemini CLI reads too.

For each workspace the page shows its state and size, with:

- **Index Now**, for a workspace without an index.
- **Rebuild**, to start its index again from scratch.
- **Pause** and **Resume**, while a build runs.
- The trash icon, to remove the index. The next agent that starts there builds a new one.

The status bar shows **Indexing N%** while a large build runs; small updates never show.

### Attach documentation

Attach a library's documentation and agents search it with `docs_search` instead of fetching pages from the web.

1. Choose **Add Docs**, or **Add** on a suggestion.
2. Enter the address, such as `https://react.dev/reference`.
3. Choose what to fetch: only that page, the pages under that address, or the whole site. GeminiCode uses the site's `llms.txt` or sitemap when it has one, and otherwise follows links under the address.
4. Pick how many pages at most, how often to refresh, and which workspaces can search it.

Pages are fetched from your Mac, through its network settings, and stored once however many workspaces use them. Fetching respects the site's `robots.txt`. A page that needs you to sign in is reported rather than stored; pages behind a sign-in can't be indexed. Fetched pages are treated as reference material, never as instructions.

Each source refreshes daily by default (`gemini.docs.refresh`, or per source); a page that hasn't changed costs one small request. The switch on a source detaches it from the workspace without deleting it.

**Suggested from your dependencies** offers the documentation of libraries your `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `build.gradle` names, for the version you use. The list ships with GeminiCode; nothing is looked up.

### Index settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.index.enabled` | on | Keep indexes and give agents the index tools. |
| `gemini.index.buildOn` | `agentStart` | When a workspace's index is first built. |
| `gemini.index.exclude` | empty | Extra files and folders to leave out, in `.gitignore` syntax. |
| `gemini.index.include` | empty | Files to index even though they would be left out, in `.gitignore` syntax. |
| `gemini.index.maxFileSizeKb` | 1024 | Larger files are left out. |
| `gemini.docs.enabled` | on | Allow attaching documentation from the web. |
| `gemini.docs.allowedDomains` | empty | The only sites docs may come from, such as `react.dev` or `*.example.com`. Empty allows any. |
| `gemini.docs.refresh` | `daily` | How often attached docs are fetched again. |

An administrator can lock `gemini.index.enabled`, `gemini.docs.enabled` and `gemini.docs.allowedDomains` as policies.

## Pick up a Gemini CLI session

A new, empty agent lists the three sessions the Gemini CLI saved most recently for its folder, including ones started with `gemini` in the terminal, with a link to show them all. Pick one to continue it: its conversation appears in the chat and the agent takes the session's title. `/resume` in the composer opens the same list at any time.

The CLI deletes saved sessions after 30 days; the list says when, and **Keep saved chats for** in [Project Helpers](helpers.md#gemini-cli-settings) changes it.

## Notifications and keeping awake

When an agent finishes or needs your permission while GeminiCode is in the background, a system notification appears and the Dock icon bounces. Click it to open the agent. The Dock icon and the Agents pane show how many agents are waiting for you. Turn both off with `gemini.notifications.enabled`.

While any agent works, GeminiCode keeps the Mac from going to sleep, so a long task carries on when you step away. The display can still sleep. Turn it off with `gemini.keepAwake`.
