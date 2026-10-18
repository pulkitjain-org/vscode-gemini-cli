# GeminiCode

GeminiCode is a fork of VS Code (Code - OSS) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

The repository's top-level README, SECURITY and AGENTS files point here. CONTRIBUTING.md and the `.github` agent instructions are upstream's and stay unchanged, so upstream merges stay clean. This folder is where the fork's own docs live:

- [docs/guide/](docs/guide/): the user docs, published as the [GeminiCode docs](https://pulkitjain-org.github.io/vscode-gemini-cli/docs/). Every feature and how to use it: agents, chat, review, Projects, the browser, team tools, settings, shortcuts and troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how GeminiCode works and why, including the security model and admin policies.
- [docs/PROJECTS.md](docs/PROJECTS.md): how Projects work: the coordinator and its threads, how prompts move between them, and what drives the coordinator's decisions.
- [docs/FINDINGS.md](docs/FINDINGS.md): Gemini CLI behaviour and measurements the design relies on.
- [docs/RELEASING.md](docs/RELEASING.md): versions, cutting a release, the download page, and the Apple signing setup.
- [docs/ROADMAP.md](docs/ROADMAP.md): open work and risks.
- [docs/AGENTIC-PLAN.md](docs/AGENTIC-PLAN.md): the agentic development plan: latency budget, fork hygiene, the team-tools adapter, threat model, evaluation harness, pilot. Its decisions are in [docs/adr/](docs/adr/).
- [docs/mockups/](docs/mockups/README.md): the plan's screens, and the glass look's before and after.
- [bench/](bench/README.md): the benchmark's tasks and results. [pilot/](pilot/README.md): the pilot's admin profile.
- [branding/](branding/): icon sources.
- [site/](site/): the generator (`build.mts`) for the download page and the docs, which the Pages workflow runs.
- [patches/](patches/) and [upstream.json](upstream.json): the fork's edits to upstream files, as a patch series over the pinned upstream tag.
- [scripts/upstream-series.sh](scripts/upstream-series.sh): lists, regenerates, applies and checks the patch series.
- [scripts/list-fork-touches.sh](scripts/list-fork-touches.sh): lists every `GEMINI-FORK` marker in upstream files.
- [scripts/notarize.sh](scripts/notarize.sh): sends a signed build to Apple's notary service, for the release workflow.

The product code is in [`../extensions/gemini/`](../extensions/gemini/).

## Features

- **Agents and Editor modes.** Agents mode (the default) puts the agent list on the left, the chat in the middle and its Changes on the right, with each agent as a tab in the title bar. Editor mode is the classic layout, with Changes under the Agents pane. Switch with the Agents | Editor switch or ⌥⌘M; every pane is a normal, resizable VS Code view or editor group.
- **Agent Home.** Describe a task and press Return to start an agent on it, optionally on its own branch, and see each agent's status, changes and next step as a card.
- **Agents pane.** Run several agents side by side. Each one opens as a tab with its own chat, keeps to the folder it works in (the open folder or any folder you add), and opens its files in a group of its own beside the chat. Each row shows a status dot (a spinner while it works, amber when it waits for you, green when done, red when something went wrong, grey otherwise) and one short note, such as how long it has worked or the lines it added; point at it for the line counts and branch. Rename, stop or remove an agent from its context menu.
- **Projects (preview).** A project chat whose coordinator splits larger work into threads, each an agent on its own branch, and passes your follow-ups to them. Threads show as cards you can open, merge back, review or undo. Turn it on with `gemini.projects.enabled`.
- **Ask before acting.** Permission requests show the agent's own options, such as Allow, Allow for this session and Reject. Proposed edits open in a diff editor first.
- **Edits through the editor.** Agent edits can be undone, and the agent reads your unsaved changes. The agent cannot read secret files such as `.env` and private keys, or git-ignored files, including through a symbolic link.
- **Enhance prompt.** Write what you want in plain words and choose **Enhance prompt** (⌥⌘E): Gemini rewrites it as a precise prompt for you to review, with **Revert** to undo.
- **Context.** Type `@` to attach workspace files. Press <kbd>⌘L</kbd> to add the editor selection. You can also attach or drop files and images from anywhere.
- **Changes.** See every file the agent in front has changed, one diff at a time or all together with **Open All Changes**. **Clear List** empties it.
- **Branches and commits.** The branch under each chat's composer opens a list in the chat to switch or create a branch. In an agent's chat, **Create Branch & Commit** commits just the files that agent changed to a new branch, and warns first if other files are staged.
- **GeminiCode Dark and Light.** Calm, functional themes with a touch of glass: soft greys, panels as cards whose top edge catches the light, glass controls in the title bar with an Agents | Editor switch that slides, opaque pop-ups with a soft sheen, one blue accent with graphite selections, and the Gemini colours only for Gemini's own moments. Nothing blurs, so the look costs no performance. The model, branch and folder menus open in the chat, not as system menus. GeminiCode also defaults to the view icons at the top of the side bar, pill-shaped tabs, and no minimap or breadcrumbs; change any of these in Settings.
- **Agent browser.** The globe in the title bar opens GeminiCode's browser. Agents can open and use pages in it, and **Let Gemini Use This Page** hands one of your own tabs to an agent.
- **Follow the agent.** A switch in the composer's **+** menu opens each file the agent reads or edits as it works, and names the file it opened last under the composer with a button to close it.
- **Keep the Mac awake.** While any agent works, the Mac doesn't go to sleep.
- **Replies.** Code is coloured like the editor, math is typeset, and the composers check spelling and preview your Markdown.
- **Long chats.** Jump between your prompts with ⌥⌘↑ and ⌥⌘↓, return to the newest message with **Latest**, or open the whole chat as Markdown.
- **Modes and models.** Pick an approval mode and a model from the composer. The lists come from the agent. The model list matches the terminal's `/model`, and the model you picked last is used for new and reopened agents too.
- **Composer.** The **+** menu holds the approval mode, files, `@` context, Follow the agent, the model, usage and the slash commands, so the composer shows only the input, its Write and Preview tabs, the model and Send. A mode other than Default shows as a chip beside **+**.
- **Usage and quota.** The ring under the composer shows how full the chat's context window is. Click it for today's quota per model for your account, and the tokens each model used in the chat.
- **Conversations persist.** Agents keep their conversation across reloads and restarts, and resume their CLI session when the CLI supports it.
- **Managed CLI.** GeminiCode ships with a tested Gemini CLI, and can install, update and switch between newer versions in its own storage, without touching your system.
- **Update notice.** Once a day GeminiCode checks its download page. When a newer version is out it says so, with **Download** and **Release Notes** buttons; it downloads nothing on its own.
- **Admin policy.** Organisations can lock the CLI path or version, remove Auto Edit or YOLO, turn off shell commands, and turn off the CLI update offers and the update notice.

> [!IMPORTANT]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## Getting started

Download GeminiCode for Mac (Apple silicon, macOS 26 or later) from the [download page](https://pulkitjain-org.github.io/vscode-gemini-cli/), open the `.dmg` and drag GeminiCode to Applications.

You need a Google account with a **Gemini Code Assist** license and a **Google Cloud project** to bill usage to. Your organisation may set the project for you.

GeminiCode opens on Agent Home. **Gemini: Get Started** opens the **Get Started with GeminiCode** walkthrough, which walks through five steps:

1. **Gemini CLI.** GeminiCode comes with a tested Gemini CLI, so there is nothing to install. It uses `gemini.cliPath`, then a copy you installed from GeminiCode, then the bundled copy, then `gemini` on your `PATH`.
2. **Sign in.** Run **Gemini: Sign In with Google**. If your account needs a one-time step that the editor cannot show, run **Gemini: Complete Setup in Terminal**.
3. **Project.** Run **Gemini: Set Google Cloud Project ID**. Enter the project ID, not the project number.
4. **Make it yours.** Pick a theme, a code font and file icons.
5. **First agent.** Choose **New Agent** in the Agents pane.

The **Gemini** status bar item shows the agent's state. Hover over it to see the account, project and CLI version, and where that CLI came from. Click it to start or restart the agent, change the project or CLI version, sign in or finish setup in a terminal, open the chat, or open the log.

## Settings

| Setting | What it does |
| --- | --- |
| `gemini.projectId` | Google Cloud project ID to bill. A workspace value overrides a user value. |
| `gemini.cliPath` | Path to a `gemini` executable or `bundle/gemini.js`. Overrides GeminiCode's own copies. |
| `gemini.cli.version` | Which of GeminiCode's own CLI copies to run. Empty means the newest. |
| `gemini.cli.checkForUpdates` | Offer newer CLI releases, at most once a day. |
| `gemini.app.checkForUpdates` | Say when a newer GeminiCode is out, checking every few hours. **Check for Updates…** checks now. |
| `gemini.approval.allowAutoEdit` | Offer the Auto Edit mode. |
| `gemini.approval.allowYolo` | Offer the YOLO mode, which runs everything without asking. Off by default. |
| `gemini.tools.allowShell` | Let the agent run shell commands. Each command still asks first. |
| `gemini.browser.enabled` | Let agents open and use a page in the GeminiCode browser. On by default. |
| `gemini.browser.allowOtherSites` | Let agents open sites other than local ones, after asking. On by default. |
| `gemini.browser.allowedOrigins` | The only sites agents may open, such as `https://*.example.com`. Empty allows every site. |
| `gemini.browser.keepSignIns` | Keep agents' browser cookies and storage between sessions, per workspace, so they stay signed in. Off by default. |
| `gemini.usageMeter.enabled` | Show today's quota in the Gemini status bar item and the chat's Usage and quota popover. On by default. |
| `gemini.agent.startEarly` | Start the agent a few seconds after the window opens, so the first chat doesn't wait for it. Only when GeminiCode was set up before and the sign-in is saved. On by default. |
| `gemini.keepAwake` | Keep the Mac awake while any agent works. On by default. |
| `gemini.chat.followAgent` | Open each file the agent reads or edits as it works. The switch in the composer's + menu toggles it. Off by default. |
| `gemini.agents.ownBranch` | Start every new agent on its own branch, in its own worktree. Off by default. |
| `gemini.agents.worktreeSetup` | A command run in each new agent branch's folder before the agent starts, such as `npm ci`. |
| `gemini.agents.allWorkspaceFolders` | Let every agent read and edit all folders of a multi-root window, not only its own. Off by default. |
| `gemini.projects.enabled` | Projects (preview). Off by default. |
| `gemini.inlineEdit.enabled` | Inline edit, Enhance prompt's quick rewrite and commit messages, which send the code or diff straight to a fast Gemini model. On by default. |
| `gemini.inlineEdit.model` | The model those use: the newest Flash (the default), the chat's model, or one you name. |
| `gemini.chat.spellCheck` | Check spelling in the chat and Agent Home composers. On by default. |
| `gemini.chat.foldFinishedWork` | Fold each finished turn's thoughts and steps under one "Worked for" line in the chat. On by default; off shows every step as its own row. |
| `gemini.notifications.enabled` | Notify you, and badge the Dock, when an agent finishes or needs you while GeminiCode is in the background. On by default. |
| `gemini.layout.showAgentsInNewWorkspaces` | Show the Gemini side bar rather than Explorer the first time a workspace opens in Editor mode. |
| `gemini.team.runTeamServers` | Run the tools' own MCP servers for the team tools' calls: the team's Jira and GitLab servers and SonarQube's in Docker at pinned versions, and Snyk's from the Snyk CLI. Checks then also analyses changed files with SonarQube on this Mac. Off by default; **Take Over Both Servers** in Connections turns it on. |
| `gemini.tools.denyEnvironmentCommands` | Refuse the shell commands that print the environment (`env`, `printenv`, and `set` or `export` alone), which could show an agent a token. On by default. |
| `gemini.mcp.allowedServers` | The only MCP servers agents may use, besides GeminiCode's own. Empty by default, which leaves it to the CLI's `mcp.allowed`. |
| `gemini.pilot.record` | Count the pilot's measures (launches, waits, permission cards, Undo and Rewind, team tool errors), with times and no text, for **Gemini: Export Pilot Data**. Off by default. |

Changing the CLI path or version, the project, or an approval or shell setting restarts the agent so the change applies. Admins can lock the CLI, update, approval, shell, inline edit, usage and browser settings through policy; see [Security model](docs/ARCHITECTURE.md#security-model).

## Issues and security

Report bugs in [GitHub Issues](https://github.com/pulkitjain-org/vscode-gemini-cli/issues). Include the GeminiCode and Gemini CLI versions and the relevant lines from **Gemini: Show Log**, with account names and project IDs removed. Report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/pulkitjain-org/vscode-gemini-cli/security/advisories/new), never in a public issue.

## Contributing

Put new code in `extensions/gemini/`, follow the [design rules](docs/ARCHITECTURE.md#design-rules), and keep `src/acp` free of `vscode` imports. If you change the messages between the chat view and its webview (`src/host/chatProtocol.ts`), bump `chatProtocolVersion`. Before a pull request, run the checks under [Developing](#developing) and `npx eslint --max-warnings 0 extensions/gemini` from the repository root.

## Developing

```sh
nvm use                  # Node from .nvmrc
npm ci
npm run watch            # keep running; rebuilds the workbench, extensions and the chat webview
./scripts/code.sh        # launches the branded dev build
```

To run the dev build on the bundled CLI, as a release does, run `npm run bundle-cli --prefix extensions/gemini` once. Without it the dev build uses an installed copy or `gemini` on your `PATH`.

The Gemini extension on its own:

```sh
cd extensions/gemini
npm test                 # Vitest unit tests
npm run typecheck-tests
npx tsc -p webview-src/tsconfig.json
```

The tests run against a scripted fake ACP agent. To also run the real-CLI tests (the `initialize` handshake and admin policy), set `GEMINI_CLI_PATH` to a Gemini CLI, either its `gemini` executable or its `bundle/gemini.js`.

If the chat view warns that its script is out of date, the webview bundle in `media/` is older than the extension. Run `npm run gulp compile-extension-media`, or keep `npm run watch` running, then reload the window.

## CI

[`gemini-ci.yml`](../.github/workflows/gemini-ci.yml) runs on pull requests and pushes to `main`, and can be run by hand. It does four things:

- It checks that the Gemini workflow files parse, lints and hygiene-checks the fork files (the fork's own files beside upstream's, listed in `gemini/patches/ADDED`, included), and checks that the patch series matches `HEAD` and that every upstream code file it edits is marked.
- It builds and type-checks the extension and webview, builds the download page from a sample release, then runs the unit tests and real-CLI tests against three CLIs: the version the app bundles (downloaded and checked as a release build does), and npm's `latest` and `preview`.
- It runs Snyk on the fork's own code when the repository has a `SNYK_TOKEN` secret, and passes with a note when it has none.
- It compiles the whole fork and runs upstream's hygiene check. A pull request that only changes `extensions/gemini/`, `gemini/`, the Gemini workflows or top-level Markdown files skips this step, because the extension job already covers those files; a skipped job counts as passing. The step restores `node_modules` from a cache keyed on the lockfiles, so it reinstalls only when dependencies change.

Packaged builds come from [`gemini-release.yml`](../.github/workflows/gemini-release.yml), which a version tag starts, and the download page from [`gemini-pages.yml`](../.github/workflows/gemini-pages.yml); see [RELEASING.md](docs/RELEASING.md).

## Touching upstream files

Keep fork code in `extensions/gemini/`. Edit an upstream file only to register the extension, rebrand, or do something the extension API cannot, and mark the edit with a `GEMINI-FORK` comment. JSON files and icons cannot carry a marker, so the fork also keeps every such edit as a patch:

```sh
gemini/scripts/upstream-series.sh files        # the upstream files the fork modifies, and the files it adds beside them
gemini/scripts/upstream-series.sh regenerate   # rewrite gemini/patches/ from HEAD against the pinned tag
gemini/scripts/upstream-series.sh check        # what CI runs: every patch still matches HEAD, and every upstream code file it edits has a GEMINI-FORK marker
```

After editing an upstream file, run `regenerate` and commit `gemini/patches/` with the change; Gemini CI fails otherwise. `gemini/scripts/list-fork-touches.sh` prints the markers.

## Upstream releases

The fork is built on one upstream release tag, pinned in `gemini/upstream.json` (`1.142.0`). Its edits to upstream files are the patch series in `gemini/patches/`, one patch per file, binaries included; everything else the fork owns lives in `extensions/gemini/`, `gemini/`, the `gemini-*.yml` workflows and the files listed in `gemini/patches/ADDED`, which apply to any base.

[`gemini-upstream.yml`](../.github/workflows/gemini-upstream.yml) runs once a week and by hand. It fetches upstream's tags, takes the newest release above the pin, checks it out, applies the series with a three-way merge, copies the fork's own files over from `main`, moves the pin, regenerates the series against the new tag, bumps the bundled Gemini CLI to the newest release with its checksum from npm, and opens one pull request, committing as the repository's git user. Gemini CI builds and tests that pull request like any other, and `main` is protected so it has to be green before it merges. A patch that does not apply leaves conflict markers in the branch, and the pull request names it; finish it on that branch, run `regenerate`, and push. While that branch exists, later runs leave it alone.

Pushing an upstream move needs the `GEMINI_UPSTREAM_TOKEN` repository secret: a fine-grained token for this repository with contents, pull requests and workflows write access. GitHub refuses a push that changes `.github/workflows` from a workflow's own token, and upstream's commits do. A pull request opened with that token starts Gemini CI by itself. Without the secret, a CLI-only bump still goes through, and the job starts Gemini CI on its branch, since a pull request opened with a workflow's own token starts no workflows.

To do the same by hand:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream tag 1.143.0
git checkout -b upstream/1.143.0 1.143.0
FROM=main gemini/scripts/upstream-series.sh apply 1.143.0
# resolve anything it names, then:
gemini/scripts/upstream-series.sh regenerate
```

After each move:

1. Re-check the items in [FINDINGS.md](docs/FINDINGS.md) that name a CLI version, and the fixtures in `extensions/gemini/test/fixtures/`.
2. Check whether upstream's Agents window (`src/vs/sessions`) gained an extension API for agent providers ([ROADMAP.md](docs/ROADMAP.md)).
3. Let Gemini CI run the extension tests and the full compile on the pull request.
