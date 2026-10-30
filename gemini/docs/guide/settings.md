# Settings

Every GeminiCode setting, by area, as the Settings editor lists them (<kbd>⌘,</kbd>, then type `gemini`). The Gemini CLI's own settings are in [Agent Setup](helpers.md#gemini-cli-settings).

A setting in a workspace's settings applies only to that folder, and is shared with everyone who opens it when the folder's `.vscode/settings.json` is checked in. Settings marked *machine* are set per Mac, never by a workspace.

<!-- Generated from extensions/gemini/package.json by `node scripts/settings-doc.mts` in extensions/gemini. Edit the descriptions there. -->

## Account and CLI

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.projectId` | empty | The Google Cloud project the agent bills to (its ID, such as `my-project-123`, not its number), passed to the CLI as `GOOGLE_CLOUD_PROJECT`. Changing this restarts the agent. |
| `gemini.cliPath` *(machine)* | empty | A `gemini` executable or a CLI's `bundle/gemini.js` to run instead of GeminiCode's own copies. Changing this restarts the agent. |
| `gemini.cli.version` *(machine)* | empty | Which of GeminiCode's own Gemini CLI copies to run, such as `0.66.0`; empty runs the newest. Changing this restarts the agent. |
| `gemini.cli.checkForUpdates` *(machine)* | on | Once a day, check the npm registry for a newer Gemini CLI and offer to install it. Nothing installs without your click. |
| `gemini.app.checkForUpdates` *(machine)* | on | Every few hours, check the GeminiCode download page for a newer GeminiCode and say so. GeminiCode downloads nothing itself. |
| `gemini.agents.startEarly` *(machine)* | on | Start the Gemini CLI as soon as GeminiCode opens, once you have signed in, so the first prompt does not wait for it. It uses about 230 MB of memory before the first chat. |
| `gemini.cli.registry` *(machine)* | empty | The npm registry GeminiCode installs its Gemini CLI copies from, such as your organisation's mirror; empty uses the public registry. It must be an `https` address without credentials, and downloads are still checked against the registry's SHA-512 checksum. |

## Agents

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.agents.defaultMode` *(machine)* | Default (`default`) | The approval mode new agents start in; an agent started with a mode of its own starts in that one, and the Gemini CLI's own `general.defaultApprovalMode` applies when this is left at Default. A mode ``gemini.approval.allowAutoEdit`` or ``gemini.approval.allowYolo`` turns off falls back to Default. Choices: Default (`default`), Auto Edit (`autoEdit`), Plan (`plan`), YOLO (`yolo`). |
| `gemini.agents.ownBranch` | off | Start every new agent in a Git repository on its own branch, in its own folder under `~/.geminicode/worktrees`, so agents working side by side never edit the same files. Off, agents work in the workspace folder, and On a Branch does this for one agent. See [Agents on their own branch](agents.md#agents-on-their-own-branch). |
| `gemini.agents.worktreeSetup` *(machine)* | empty | A shell command run in each new agent branch's folder before the agent starts, such as `npm ci && cp "$GEMINI_SOURCE_REPOSITORY/.env" .`; empty runs the repository's own `.gemini/worktree-setup.sh` if it has one. Runs only in trusted workspaces, and only your user settings or an administrator's policy set it. Before a repository's script runs the first time, GeminiCode shows it and asks; the command can use `GEMINI_SOURCE_REPOSITORY`, the repository the copy came from, to copy files Git doesn't carry. |
| `gemini.agents.allWorkspaceFolders` | off | Let every agent read and edit all folders of a multi-root window, not only the folder it works in. Changing this restarts the agent. |
| `gemini.projects.enabled` *(machine)* | on | Projects: a project chat whose coordinator splits work into threads, each an agent on its own branch, shown as cards you can open, try in your workspace and keep. Off, New Project and the Projects section are hidden. |
| `gemini.projects.maxRunningThreads` *(machine)* | `4` | How many of a project's threads may work at once; a thread started beyond it waits for a running one to finish. Above 90% of today's Gemini quota, new threads wait too, until the reset or **Start Anyway**. |
| `gemini.notifications` | Every finish and every wait (`all`) | System notifications while GeminiCode is in the background: when an agent needs your permission, and also when one finishes. The Dock icon counts the agents waiting either way. Choices: Every finish and every wait (`all`), Only when an agent needs you (`needsYou`), Off (`off`). On macOS, GeminiCode asks the system for permission the first time. |
| `gemini.keepAwake` *(machine)* | on | Keep the Mac from sleeping while any agent is working; the display can still sleep. Ends as soon as no agent is working. |
| `gemini.home.openOnStartup` *(machine)* | on | Open Home in front of your restored tabs every time GeminiCode starts. Off, Home shows when no tab is open in the Agents layout, or from the Agents pane. |
| `gemini.agents.branchDefaults` | empty | Defaults for every agent started on a branch, by New Agent on a Branch, Fork and New thread: `prefix` for the branch name (`gemini/` unless set), `model`, and `planFirst`. A project's own defaults override it for its threads. A project's settings page sets the same three for its threads. |

## Chat

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.chat.sendWith` *(machine)* | Return (`enter`) | Which key sends a message in the chat's composer; the other one adds a line. Choices: Return (`enter`), ⌘Return (`cmdEnter`). |
| `gemini.chat.foldFinishedWork` *(machine)* | on | Fold each finished turn's thoughts and steps under one line, with the files it changed and any failed step kept in sight. Off shows every step as it happened. |
| `gemini.chat.runCommands` *(machine)* | Ask when risky (`askWhenRisky`) | Run on a reply's shell blocks: the command runs in the agent's own terminal, in its folder. Commands that delete work, force-push, run as root, download, write a disk or write outside the folder ask first, as do blocks of several commands. Choices: Ask when risky (`askWhenRisky`), Always ask (`alwaysAsk`), Off (`off`). See [Running commands from a reply](chat.md#replies). |
| `gemini.chat.reactions.enabled` *(machine)* | on | React to Gemini's replies with an emoji (👍 goes ahead, 👎 stops and asks what to change, ❓ asks for a simpler explanation, ❤️ is a thanks), and let Gemini react to your messages when it has something to add. Off hides the reaction button and chips. |
| `gemini.chat.reactions.meanings` | empty | What an emoji reaction asks Gemini to do, by emoji, such as `{ "🚀": "Go ahead, then commit with a short message." }`; an entry changes a built-in meaning or adds one. Set it in a workspace's settings to share it with the team. |
| `gemini.usageMeter.enabled` *(machine)* | on | Show today's Gemini quota use in the Gemini status bar item and the chat's usage popover, read every 10 minutes at most with the sign-in the Gemini CLI saved. Google sign-in only. |
| `gemini.inlineEdit.enabled` *(machine)* | on | Quick requests to a fast Gemini model with the sign-in the Gemini CLI saved, without an agent: inline edit (⌘I on a selection), Write Commit Message with Gemini, Enhance Prompt and side questions. |
| `gemini.inlineEdit.model` *(machine)* | `latestFlash` | The model quick requests use: `latestFlash`, the newest Flash model the installed Gemini CLI knows (or the one before it when your account can't use it yet); `sameAsChat`, the model last picked in chat; or a model name such as `gemini-2.5-pro`. Side questions and Enhance Prompt use it too; with a sign-in that can't make quick requests, a session on the Gemini CLI answers instead. |

## Browser

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.browser.enabled` *(machine)* | on | Let agents open and use a page in the GeminiCode browser, to check the web app they work on; each agent gets a tab of its own, marked as theirs. Applies to agents started afterwards. |
| `gemini.browser.allowOtherSites` *(machine)* | on | Let agents open sites other than this machine's (`localhost`, `127.0.0.1`, files), after asking you once per site. Off, agents can only open local pages. |
| `gemini.browser.keepSignIns` *(machine)* | off | Keep the cookies and storage of agents' browser pages between sessions, separately for each workspace, so agents stay signed in to the sites they use. Off, agents' pages forget everything when GeminiCode quits; they never share your own pages' storage either way. In remote and untrusted windows, or when `workbench.browser.dataStorage` keeps your own pages' data per workspace, agents' pages stay in memory whatever this says. |

## Workspace Index and Docs

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.index.enabled` *(machine)* | on | Keep an index of the code in each folder agents work in, with the documentation you attach, and give agents tools to search it in one step instead of file by file. It stays on this machine, in `~/.geminicode/index`, built in a separate process at low priority; applies to agents started afterwards. The tools are `code_search`, `find_symbol`, `related_files`, `repo_map` and `docs_search`; see [Workspace index and docs](agents.md#workspace-index-and-docs). |
| `gemini.index.buildOn` *(machine)* | When an agent starts (`agentStart`) | When a folder's index is first built. After that it is kept up to date as files change, whichever you pick. Choices: When an agent starts (`agentStart`), When the workspace opens (`workspaceOpen`), Manually (`manual`). |
| `gemini.index.include` | empty | Files to index even though they would be left out, in `.gitignore` syntax, such as `src/generated/**` or `docs/large-spec.md`. Secret files such as `.env` and files with binary content are never indexed. **Index Anyway** on the Index & Docs tab adds a file here for you. |
| `gemini.index.exclude` | empty | Files and folders to leave out of the index, in `.gitignore` syntax, such as `fixtures/` or `**/*.snap`. Files git ignores, `.geminiignore` entries, secret files, binaries and lock files are always left out. |
| `gemini.docs.enabled` *(machine)* | on | Let you attach documentation from the web to a folder's index, for agents to search with `docs_search`. Pages are fetched from this machine, through its network settings. |

## Team Tools

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.team.openMergeRequestsIn` | GeminiCode's browser (`geminicode`) | Where a merge request opens when you click it on Home, in the merge request panel or in a team page. **Open in GitLab** in a card's menu always uses the default browser. Choices: GeminiCode's browser (`geminicode`), Default browser (`browser`). |
| `gemini.team.runTeamServers` *(machine)* | off | Run the tools' own MCP servers for the team tools' calls: the Jira, GitLab and SonarQube servers in Docker at pinned versions with your keychain tokens, and Snyk's from your Snyk CLI. Each stops when idle; while one is still starting, calls go to the tool's API directly. Jira's and GitLab's servers start when an agent's session opens, the others on their first call. |
| `gemini.figma.viewports` | empty | The screen sizes **Add Figma Design** asks a frame for, such as `["Mobile", "Tablet", "Desktop"]`; empty uses XS, S, M and L. A repository's `figma.viewports` in `.gemini/geminicode-tools.json` outranks it. |

## Administration

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.approval.allowAutoEdit` *(machine)* | on | Offer the Auto Edit approval mode, which applies the agent's file edits without asking. Changing this restarts the agent. |
| `gemini.approval.allowYolo` *(machine)* | off | Offer the YOLO approval mode, which runs every tool, shell commands included, without asking. Changing this restarts the agent. |
| `gemini.tools.allowShell` *(machine)* | on | Let the agent run shell commands; each still asks first unless YOLO is on. Changing this restarts the agent. |
| `gemini.tools.denyEnvironmentCommands` *(machine)* | on | Refuse the shell commands that print the environment (`env`, `printenv`, and `set` or `export` alone), which would show an agent any token a server passes through it. Changing this restarts the agent. |
| `gemini.mcp.allowedServers` *(machine)* | empty | The only MCP servers agents may use, besides GeminiCode's own; empty leaves it to the CLI's `mcp.allowed` setting, and a name here outranks any repository's settings file. Changing this restarts the agent. |
| `gemini.browser.allowedOrigins` *(machine)* | empty | The only sites agents may open in the GeminiCode browser, such as `http://localhost:*` or `https://*.example.com` (`*` allows all); empty allows every site the other browser settings allow. You can still open any site yourself. |
| `gemini.docs.allowedDomains` *(machine)* | empty | The only sites documentation may be fetched from, such as `react.dev` or `*.example.com`. Empty allows every site. |
| `gemini.index.maxFileSizeKb` *(machine)* | `1024` | Files larger than this, in KB, are left out of the index. ``gemini.index.include`` can still add one, up to 16 MB. |
| `gemini.audit.keepDays` *(machine)* | `90` | How many days of the audit log to keep; older days are removed in the background after GeminiCode starts. At least 7 days are kept, and `0` keeps everything. The Storage section of Agent Setup's Storage & Audit tab sets it too. |

## Developer

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.developer.showTools` *(machine)* | off | Show GeminiCode's developer tools: Run Benchmark, Record Performance Trace, Show Status Menu, New Skill, Check Agent Connection, Sync Design System and installing a CLI version in the Command Palette, the status bar menu's trace and benchmark entries, Agent Setup's Measure buttons and Home's startup card. They are for working on GeminiCode itself. |
| `gemini.layout.showAgentsInNewWorkspaces` *(machine)* | on | Show the Agents pane, with the agent's Changes below it, the first time a workspace opens. Afterwards the layout you arrange is kept. |

## Renamed and removed

These names are still read for a release, so nothing you set is lost; the editor marks them.

| Setting | What happened |
| --- | --- |
| `gemini.agent.startEarly` | Renamed to gemini.agents.startEarly in 1.6; this name is read until 1.8. |
| `gemini.notifications.enabled` | Replaced by gemini.notifications in 1.7: true is "all", false is "off". Read until 1.8. |
| `gemini.agents.mergeBack` | Removed in 1.7: the Try button's chevron offers Merge Back and Open Merge Request and remembers your pick per repository. |
| `gemini.storage.keepLogsDays` | Renamed to gemini.audit.keepDays in 1.7, since it keeps the audit log only; this name is read until 1.8. |

## When a change applies

A description that ends in "Changing this restarts the agent" takes effect through a restart: open agents resume their sessions. "Applies to agents started afterwards" means running agents keep what they had. Everything else applies at once.

## Settings your administrator can lock

An organisation can lock these settings through VS Code's policy system: a macOS configuration profile, Group Policy on Windows, or a JSON policy file on Linux. A locked setting shows its value in Settings but can't be changed there.

| Setting | Policy |
| --- | --- |
| `gemini.cliPath` | `GeminiCliPath` |
| `gemini.cli.version` | `GeminiCliVersion` |
| `gemini.cli.checkForUpdates` | `GeminiCliCheckForUpdates` |
| `gemini.cli.registry` | `GeminiCliRegistry` |
| `gemini.inlineEdit.enabled` | `GeminiInlineEdit` |
| `gemini.usageMeter.enabled` | `GeminiUsageMeter` |
| `gemini.app.checkForUpdates` | `GeminiCodeCheckForUpdates` |
| `gemini.approval.allowAutoEdit` | `GeminiAllowAutoEdit` |
| `gemini.approval.allowYolo` | `GeminiAllowYolo` |
| `gemini.tools.allowShell` | `GeminiAllowShell` |
| `gemini.browser.enabled` | `GeminiBrowser` |
| `gemini.browser.allowOtherSites` | `GeminiBrowserOtherSites` |
| `gemini.tools.denyEnvironmentCommands` | `GeminiDenyEnvironmentCommands` |
| `gemini.mcp.allowedServers` | `GeminiAllowedMcpServers` |
| `gemini.browser.allowedOrigins` | `GeminiBrowserAllowedOrigins` |
| `gemini.index.enabled` | `GeminiIndex` |
| `gemini.docs.enabled` | `GeminiDocs` |
| `gemini.docs.allowedDomains` | `GeminiDocsAllowedDomains` |
| `gemini.chat.runCommands` | `GeminiChatRunCommands` |
| `gemini.projectId` | `GeminiProjectId` |
| `gemini.projects.enabled` | `GeminiProjects` |
| `gemini.team.runTeamServers` | `GeminiRunTeamServers` |
| `gemini.agents.worktreeSetup` | `GeminiWorktreeSetup` |
| `gemini.agents.defaultMode` | `GeminiAgentsDefaultMode` |
| `gemini.agents.allWorkspaceFolders` | `GeminiAllWorkspaceFolders` |
| `gemini.projects.maxRunningThreads` | `GeminiProjectsMaxRunningThreads` |
| `gemini.browser.keepSignIns` | `GeminiBrowserKeepSignIns` |

To pin one CLI version for everyone, lock `GeminiCliPath` to an empty string and `GeminiCliVersion` to the version. How each policy reaches the Gemini CLI is described in [the architecture notes](https://github.com/pulkitjain-org/vscode-gemini-cli/blob/main/gemini/docs/ARCHITECTURE.md#security-model).
