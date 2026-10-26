# Settings

Every GeminiCode setting, by area. Open Settings with <kbd>⌘,</kbd> and type `gemini` to see them all, or type a setting's name to go straight to it. The Gemini CLI's own settings are in [Project Helpers](helpers.md#gemini-cli-settings).

A setting in a workspace's settings applies only to that folder, and is shared with everyone who opens it when the folder's `.vscode/settings.json` is checked in.

## Sign-in and the Gemini CLI

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.projectId` | empty | The Google Cloud project ID to bill. Use the ID, such as `my-project-123`, not the project number. A workspace value wins over your own, and the Gemini log warns when one does. An admin policy wins over both. |
| `gemini.cliPath` | empty | A `gemini` executable or a CLI's `bundle/gemini.js` to run instead of GeminiCode's own copies. |
| `gemini.cli.version` | empty | Which of GeminiCode's own CLI copies to run, such as `0.64.0`. Empty runs the newest. |
| `gemini.cli.checkForUpdates` | on | Offer newer Gemini CLI releases, at most once a day. Nothing installs without your click. |
| `gemini.cli.registry` | empty | The npm registry, such as your organisation's mirror, that GeminiCode installs and updates its copy of the Gemini CLI from. Empty uses the public registry. |
| `gemini.app.checkForUpdates` | on | Say when a newer GeminiCode is out, checking every few hours. GeminiCode never downloads it by itself. |
| `gemini.agents.startEarly` | on | Start the Gemini CLI a few seconds after GeminiCode opens, once you're signed in, so your first prompt doesn't wait for it. |

## Approvals and tools

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.approval.allowAutoEdit` | on | Offer the Auto Edit mode, which edits files without asking. |
| `gemini.approval.allowYolo` | off | Offer the YOLO mode, which runs everything without asking. |
| `gemini.tools.allowShell` | on | Let agents run shell commands. Each command still asks first, except in YOLO. |
| `gemini.tools.denyEnvironmentCommands` | on | Refuse the commands that print the environment (`env`, `printenv`, `declare -x`, `export -p`, `ps eww`, and `set` or `export` alone), where a token could show. |
| `gemini.mcp.allowedServers` | empty | The only MCP servers agents may use, besides GeminiCode's own. Empty leaves it to the CLI's `mcp.allowed`. Usually set by your organisation. |

See [Review and safety](review.md) for how approvals work.

## Agents and layout

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.agents.ownBranch` | off | Start every new agent on its own branch, in its own folder under `~/.geminicode/worktrees`. |
| `gemini.agents.defaultMode` | `default` | The approval mode new agents start in: `default`, `autoEdit`, `plan` or `yolo`. Agent Home's mode picker starts on it too. A mode your administrator turns off falls back to Default. |
| `gemini.agents.worktreeSetup` | empty | A command run in each new agent branch's folder before the agent starts, such as `npm ci`. |
| `gemini.agents.allWorkspaceFolders` | off | Let every agent read and edit all folders of a multi-folder window, not only its own. |
| `gemini.projects.enabled` | on | [Projects](projects.md): a coordinator that splits larger work into threads. |
| `gemini.home.openOnStartup` | on | Open Home in front of your restored tabs each time GeminiCode starts. |
| `gemini.layout.showAgentsInNewWorkspaces` | on | Show the Agents pane, with Changes below it, the first time a workspace opens. After that, your layout is kept. |
| `gemini.notifications.enabled` | on | Notify you, and badge the Dock, when an agent finishes or needs you while GeminiCode is in the background. |
| `gemini.keepAwake` | on | Keep the Mac from sleeping while any agent works. The display can still sleep. |

## Chat

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.chat.followAgent` | off | Open each file the agent reads or edits as it works. The switch in the composer's **+** menu sets it too. |
| `gemini.chat.foldFinishedWork` | on | Fold each finished turn under one "Worked for" line. Off shows every step as its own row. |
| `gemini.chat.spellCheck` | on | Underline misspelt words in the chat and Home composers. |
| `gemini.chat.sendWith` | `enter` | Which key sends: `enter` (Return sends, Shift+Return makes a new line, ⌘Return queues while the agent works) or `cmdEnter` (⌘Return sends, Return makes a new line, Shift+⌘Return queues). Ctrl takes ⌘'s place on Windows and Linux. |
| `gemini.chat.runCommands` | `askWhenRisky` | How **Run** on a reply's shell commands behaves: `askWhenRisky`, `alwaysAsk`, or `off` to leave only Copy. See [Terminal](terminal.md#run-a-command-from-a-reply). |
| `gemini.usageMeter.enabled` | on | Show today's quota in the Gemini status bar item and the chat's usage popover. |

## Quick requests

Inline edit (<kbd>⌘I</kbd> in the editor), commit messages, Enhance prompt's rewrite and asking for a command in a terminal send their text straight to a fast model, without starting an agent.

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.inlineEdit.enabled` | on | Turn quick requests on or off. |
| `gemini.inlineEdit.model` | `latestFlash` | The model they use: the newest Flash, the chat's model, or one you name. |

## Browser

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.browser.enabled` | on | Let agents open and use pages in GeminiCode's browser. |
| `gemini.browser.allowOtherSites` | on | Let agents open sites other than local ones, after asking once per site. Off limits them to local pages. |
| `gemini.browser.allowedOrigins` | empty | The only sites agents may open, such as `https://*.example.com`. Empty allows every site. |
| `gemini.browser.keepSignIns` | off | Keep agents' browser cookies and storage between sessions, per workspace, so they stay signed in. |

## Workspace index and docs

`gemini.index.enabled`, `gemini.index.buildOn`, `gemini.index.exclude`, `gemini.index.include`, `gemini.index.maxFileSizeKb`, `gemini.docs.enabled`, `gemini.docs.allowedDomains` and `gemini.docs.refresh` are described in [Index settings](agents.md#index-settings).

## Team tools

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.team.openMergeRequestsIn` | `ask` | Where a merge request opens when you click it: GeminiCode's browser or your default browser. |
| `gemini.team.runTeamServers` | off | Run the tools' own MCP servers behind the team tools: the team's Jira and GitLab servers and SonarQube's in Docker, and Snyk's from your Snyk CLI. **Take Over Both Servers** in Connections turns it on. See [Your team's own servers](team-tools.md#your-teams-own-servers). |

## Advanced

These are under **Gemini › Advanced** in Settings.

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.chat.reactions.enabled` | on | React to replies with an emoji. See [Reacting to replies](chat.md#reacting-to-replies). |
| `gemini.chat.reactions.agentReactions` | on | Let Gemini react to your messages when it has something to add. Costs about 50 tokens per session. |
| `gemini.chat.reactions.meanings` | `{}` | What an emoji asks Gemini to do, such as `{ "🚀": "Go ahead, then commit with a short message." }`. An entry can change a built-in meaning (👍 👎 ❓ ❤️) or add one. |
| `gemini.pilot.record` | off | Count the pilot's measures on your Mac: launches, waits, permission cards, Undo and Rewind, team tool errors and links that leave the app, with times and no text. |
| `gemini.developer.showTools` | off | Show GeminiCode's developer tools in the Command Palette: Run Benchmark, Record or Stop Performance Trace, Export Pilot Data, Show Status Menu, New Skill, and installing a Gemini CLI version. They still run from the Gemini status bar menu, Project Helpers and the messages that offer them. |

If you are in the pilot, turn `gemini.pilot.record` on. At the end, run **Gemini: Export Pilot Data**, which the Command Palette shows while it is on, and hand over the `geminicode-pilot` folder in your home folder.

## Storage

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.storage.keepLogsDays` | 90 | How many days of the audit log and the pilot's counters to keep. Older days are removed in the background after GeminiCode starts. At least 7 days are kept; 0 keeps everything. |

## When a change applies

Changing the CLI path or version, the project, or an approval or shell setting restarts the agent so the change takes effect, and open agents resume their sessions. Other settings apply at once, or to the next agent you start.

## Settings your administrator can lock

An organisation can lock these settings through VS Code's policy system: a macOS configuration profile, Group Policy on Windows, or a JSON policy file on Linux. A locked setting shows its value in Settings but can't be changed there.

| Setting | Policy |
| --- | --- |
| `gemini.cliPath` | `GeminiCliPath` |
| `gemini.cli.version` | `GeminiCliVersion` |
| `gemini.cli.checkForUpdates` | `GeminiCliCheckForUpdates` |
| `gemini.cli.registry` | `GeminiCliRegistry` |
| `gemini.app.checkForUpdates` | `GeminiCodeCheckForUpdates` |
| `gemini.approval.allowAutoEdit` | `GeminiAllowAutoEdit` |
| `gemini.approval.allowYolo` | `GeminiAllowYolo` |
| `gemini.tools.allowShell` | `GeminiAllowShell` |
| `gemini.tools.denyEnvironmentCommands` | `GeminiDenyEnvironmentCommands` |
| `gemini.mcp.allowedServers` | `GeminiAllowedMcpServers` |
| `gemini.inlineEdit.enabled` | `GeminiInlineEdit` |
| `gemini.usageMeter.enabled` | `GeminiUsageMeter` |
| `gemini.chat.runCommands` | `GeminiChatRunCommands` |
| `gemini.browser.enabled` | `GeminiBrowser` |
| `gemini.browser.allowOtherSites` | `GeminiBrowserOtherSites` |
| `gemini.browser.allowedOrigins` | `GeminiBrowserAllowedOrigins` |
| `gemini.index.enabled` | `GeminiIndex` |
| `gemini.docs.enabled` | `GeminiDocs` |
| `gemini.docs.allowedDomains` | `GeminiDocsAllowedDomains` |
| `gemini.projectId` | `GeminiProjectId` |
| `gemini.projects.enabled` | `GeminiProjects` |
| `gemini.team.runTeamServers` | `GeminiRunTeamServers` |
| `gemini.agents.worktreeSetup` | `GeminiWorktreeSetup` |
| `gemini.agents.allWorkspaceFolders` | `GeminiAllWorkspaceFolders` |
| `gemini.agents.defaultMode` | `GeminiAgentsDefaultMode` |
| `gemini.browser.keepSignIns` | `GeminiBrowserKeepSignIns` |
| `gemini.pilot.record` | `GeminiPilotRecord` |

To pin one CLI version for everyone, lock `GeminiCliPath` to an empty string and `GeminiCliVersion` to the version. How each policy reaches the Gemini CLI is described in [the architecture notes](https://github.com/pulkitjain-org/vscode-gemini-cli/blob/main/gemini/docs/ARCHITECTURE.md#security-model).
