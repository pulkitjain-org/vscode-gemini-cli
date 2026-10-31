# Review and safety

Agents ask before they act, and every change they make can be kept, undone or rewound. This page covers approvals, reviewing changes, and what agents can't reach.

![An agent asking to run npm test, the test run after Allow once, and its summary](../../site/media/showcase-wait-dark.webp "clip")

> [!WARNING]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## Approval modes

Pick a mode from the composer's **+** menu, or press <kbd>⇧Tab</kbd> in an agent's tab (**Gemini: Cycle Approval Mode**, also <kbd>⌘.</kbd>) to step through Default, Auto Edit and Plan as the CLI's own <kbd>⇧Tab</kbd> does: it never picks YOLO, and skips Plan while a turn runs. <kbd>⌘Y</kbd> toggles YOLO (**Gemini: Toggle YOLO**), as the CLI's <kbd>Ctrl+Y</kbd> does, where your admin allows it. The list and its names come from the Gemini CLI (Default "Prompts for approval", Auto Edit "Auto-approves edit tools", YOLO "Auto-approves all tools", Plan "Read-only mode"), minus any mode your admin turned off; Home and the New Agent dialog show the same list. When the CLI switches to Auto Edit by itself after an edit is allowed for the session, GeminiCode puts your YOLO back and says so in the chat.

| Mode | What the agent does |
| --- | --- |
| Default | Asks before every edit and every command. Proposed edits open as a diff first. |
| Auto Edit | Edits files without asking, but still asks before commands. |
| Plan | Reads and proposes a plan without making changes. |
| YOLO | Runs everything without asking. Off unless your admin enables it. |

## Permission requests

A permission card shows the CLI's own choices: **Allow once**, **Allow for this session** and **Reject**. You can answer the newest card without leaving the chat box: <kbd>⌥⌘↩</kbd> allows once, <kbd>⌥⌘S</kbd> allows for this session and <kbd>esc</kbd> rejects (Ctrl+Alt+Enter and Ctrl+Alt+S on Windows and Linux). The card lists the keys under its buttons. While a card waits, <kbd>⌥⌘S</kbd> in the chat box answers it rather than saving all files. An agent that asks never takes over the chat you're typing in: its tab isn't brought forward. If its chat is in view, the proposed edit opens as a diff. In the Agents pane its row shows an amber dot and "waiting", and the Dock badge and a notification say it waits.

**Allow for this session** on a shell command covers the command prefixes it runs for the rest of that chat's session: the program, and for programs with subcommands the subcommand, as the button says (**Allow `git status`, `grep` for this session**). GeminiCode keeps these prefixes and answers the session's repeats itself; the Gemini CLI is told "once", because its own session rule would cover the whole program. Allowing `git status` never covers `git push` or `git grep`, and allowing `npm run lint` never covers `npm run deploy`. A redirect is allowed for the file it wrote only. Some commands ask every time anyway, because allowing them once would allow far more than you saw:

- a command that reaches the network, installs a package by name (`npm install left-pad`, `pip install requests`), or runs code it builds
- a redirect into a file outside the agent's folder
- a command that runs another program or code it is given, such as `env`, `xargs`, `sudo`, `python -c`, `npx`, `npm exec`, `yarn dlx`, `make -f`, `awk -f`, `sed -f`, `find -exec`, `git -c`, `git grep -O`, `git fetch --upload-pack`, `git config` that sets a value, `git rebase -x` or `rg --pre`
- `docker` and the like, since `docker inspect` shows a container's settings
- a script the agent could have written, by relative or absolute path, and a program named by a variable or a pattern, such as `$EDITOR`
- a command that writes a build file, a git hook, anything under `.git`, `.gemini/settings.json`, a `.gemini/*.sh` script or `.vscode/settings.json` or `tasks.json`, through `>`, `tee`, `cp`, `mv` or `sed -i`, for example

A few test and read-only commands whose programs otherwise always ask can still be allowed for the session: `npx vitest`, `npx tsc --noEmit`, `npx eslint`, `python -m pytest` and `./gradlew test`.

When the agent edits a build file, such as `package.json`, a `Makefile` or `build.gradle`, the task runners you allowed (`npm`, `make`, `gradle` and the like) and the git commands that run hooks (`git commit`, `git push`) ask again, since their next run would run what the agent wrote. When it edits a git hook or a hook manager's settings (`.husky/`, `.pre-commit-config.yaml`, `.lintstagedrc`), every git command asks again.

In Auto Edit, an edit to a file that decides what runs next still shows a card first: a git hook or a hook manager's settings, a build file such as `package.json`, the worktree setup script (`.gemini/*.sh`), the CLI's project settings (`.gemini/settings.json`), the folder's `.vscode/settings.json` and `.vscode/tasks.json`, and the ignore files (`.gitignore`, `.geminiignore`), which decide what the agent may read. The commits GeminiCode makes for an agent (Try in Workspace, Open Merge Request) run none of the checkout's hooks.

**Gemini: Commands Allowed for This Session...** lists the command prefixes the chat in front allowed, and lets you forget any of them. Turn on **Allow for all future sessions** in [Settings](helpers.md#gemini-cli-settings) to also be offered the CLI's permanent allow. The Gemini CLI saves that rule for the whole program (`npx`, not `npx vitest`) and for every folder, in `~/.gemini/policies/auto-saved.toml`, so the card shows it with the CLI's own wording, **Allow this command for all future sessions**.

## Folder trust

In a folder it trusts, the Gemini CLI loads the folder's own Gemini settings, hooks and MCP servers, which can run programs on your Mac, and allows Auto Edit and YOLO. Agents on their own branch, projects and Auto Edit need a trusted folder.

GeminiCode asks once per repository, the first time you choose a folder for agents anywhere: on Home, for a new agent, a project or a team flow, on the Index page, or for a mode that needs it. The question, **Let agents work in** the folder, offers:

- **Trust This Folder**, for the repository.
- **Trust Everything in** its parent folder, offered when that folder holds other repositories too.
- **Not Now**, which is remembered, so later starts don't ask again. Agents still work there **Here**, in Default and Plan mode; Auto Edit falls back to Default. Home says in place what needs trust, with **Trust...** to be asked again.

A trusted repository's agent branches, in `~/.geminicode/worktrees/<repository>`, are trusted with it. Merge request reviews check out in `~/.geminicode/reviews`, which is never trusted, so a merge request's own settings, hooks and MCP servers never run. The choice is saved in `~/.gemini/trustedFolders.json`, and the terminal's `gemini` sees it too. [Settings](helpers.md#trusted-folders) lists every rule and changes them.

When trust changes elsewhere, in the terminal, Settings or another window, agents pick it up once they finish their current work. While some are working, a notice says so and offers **Restart Agents Now**.

## Review changes in place

The **Changes** panel lists the files the agent in front has edited. Click a file for a diff, or use **Open All Changes** for one multi-diff editor. Hover over a change to **Keep** or **Undo** it; **Keep All** accepts everything and **Undo All** puts the files back.

![Keeping an agent's edits one by one, with Keep and Undo above each change](../../site/media/showcase-review-dark.webp "clip")

Open a file an agent changed and its changes show in place: added lines are tinted, a rule marks removed lines, and **Keep** and **Undo** sit above each change. The line at the top of the file keeps or undoes them all and moves to the agent's next file.

| Keys | What it does |
| --- | --- |
| <kbd>⌥⌘↩</kbd> / <kbd>⇧⌥⌘⌫</kbd> | Keep or undo the agent's changes to the file you're in |
| <kbd>⌥F5</kbd> / <kbd>⇧⌥F5</kbd> | Next or previous agent change in the file |

Only the agent's own changes show. What you type in the file afterwards isn't counted as the agent's, and Keep or Undo on a change leaves your edits alone. **Undo All** restores the file as it was before the agent, so when the file also has edits that aren't the agent's, it asks first: they would go too.

When two agents in one folder changed the same file, the changes of the one that edited it last show first; the other's show once those are kept or undone.

So that their edits don't mix unnoticed, an agent's edit card warns when another live agent in the folder has changes to that file still waiting for Keep or Undo: **"Login fix" also has unreviewed changes in this file**. **Show Its Changes** opens the other agent's changes. In Auto Edit, where edits don't ask, the same warning is a line under the edit's row. To keep two agents apart, give one its own branch.

Changes you commit leave the list by themselves, however you commit: from the chat, Source Control, the terminal, or by asking the agent. Once a file is what the latest commit has, its changes count as kept.

## Undo or retry a reply

Each reply that changed files ends with **Undo**, which puts back every file it changed. Undoing an earlier reply also undoes the replies after it, and GeminiCode asks first when that happens or when a file changed after Gemini wrote it. The next message tells Gemini which files went back, so it reads them again. **Retry** under the latest reply sends the same message again.

The last 100 replies of each agent can be undone, and they stay undoable after the window reloads or the agent sleeps.

## Rewind

**Rewind** goes back to before one of your messages, as the CLI's `/rewind` does. Click the clock icon under the message, type `/rewind`, or press <kbd>esc</kbd> twice in an empty message box, and pick a message: each shows when it was sent and how many files changed since.

Then choose, in the CLI's own words: **Rewind conversation and revert code changes**, **Rewind conversation**, or **Revert code changes** (the code choices appear only when code changed since). Rewinding the conversation removes that message and everything after it from the chat and from Gemini's context, so Gemini forgets them, and the message returns to the message box, to edit and send again. Reverting the code puts back what Gemini's edit tools changed since; as in the CLI, your own edits and what shell commands changed stay as they are. **Undo changes** on a reply is the short way to revert one turn's code.

The CLI's own checkpointing (`general.checkpointing.enabled`, off by default) keeps a shadow Git commit before each edit, for its `/restore`; GeminiCode's checkpoints are its own, per turn, and need nothing turned on. Turn the CLI's on only when you also use `/restore` from a terminal in the same folder.

## Commit the agent's work

The branch under a chat's composer switches to another branch or creates one. On a branch other than the repository's default (origin's HEAD, else `main` or `master`), the composer offers **Commit to** that branch: a box opens with a message written from the agent's changes, for you to edit, and **Commit** (or <kbd>⌘↩</kbd>) commits only the files that agent changed; its chevron offers **Create Branch and Commit…**. On the default branch, **Create Branch & Commit** creates a branch, stages only the files that agent changed, and commits them. Both warn first if other files are already staged. The commit message is written from the agent's diff, as the Source Control sparkle writes one, for you to edit; the agent's name is used when it can't be (inline edit turned off, or a sign-in that can't make direct requests). An agent on its own branch has **Try in Workspace** instead, or **Merge Back** with `gemini.agents.mergeBack` set to `commit`, which commits its leftovers with a message written the same way. See [Agents on their own branch](agents.md#agents-on-their-own-branch).

In the Source Control view, the sparkle button writes a commit message for the staged changes (or, with nothing staged, all changes).

## Inline edit

Select some code (or put the cursor on a line), press <kbd>⌘I</kbd> and say what to change. Gemini rewrites just those lines in a second or two, and the change shows in the file with **Keep** and **Undo**, like an agent's. The request box remembers your last request, so a retry is <kbd>⌘I</kbd> and Return. Inline edit doesn't save the file or start an agent.

Inline edit and commit messages use the newest Flash model for speed. `gemini.inlineEdit.model` can switch them to the chat's model or one you name, and `gemini.inlineEdit.enabled` turns them off. They work with Google sign-in or a Gemini API key, but not with Vertex AI.

## Review

**Review**, on Home and in the Command Palette (**Gemini: Review...**), asks what to review: **My Changes**, **An Agent's Changes** (the diff of an agent that changed files), **A Merge Request** with GitLab connected ([Review a merge request](team-tools.md#review-a-merge-request)), or **Run Checks on a Branch** with Snyk or SonarQube connected.

**My Changes** (also **Review My Changes** in the Source Control title bar and the Agents pane's **...** menu) starts an agent in Plan mode with your uncommitted diff attached. It reads the code around the changes and replies with a summary and its findings, most serious first, without editing anything. Ask it to fix one when you agree.

## What agents can't reach

- Secret files, such as `.env`, private keys, cloud credentials (`gcloud`, service account keys) and cluster and registry configs (`.kube`, `.docker`), and git-ignored files, including through a link or a symbolic link.
- Other folders in a multi-folder window, unless you turn on `gemini.agents.allWorkspaceFolders`.
- Sites other than local ones in the browser, until you allow each one. See [Browser](browser.md#which-sites-agents-can-open).
