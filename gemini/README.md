# GeminiCode

GeminiCode is a fork of VS Code (Code - OSS) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

The repository's top-level README, SECURITY and AGENTS files point here. CONTRIBUTING.md and the `.github` agent instructions are upstream's and stay unchanged, so upstream merges stay clean. This folder is where the fork's own docs live:

- [docs/USING.md](docs/USING.md): approval modes, folder trust, attachments, long conversations and troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how GeminiCode works and why, including the security model and admin policies.
- [docs/FINDINGS.md](docs/FINDINGS.md): Gemini CLI behaviour and measurements the design relies on.
- [docs/RELEASING.md](docs/RELEASING.md): versions, cutting a release, the download page, and the Apple signing setup.
- [docs/ROADMAP.md](docs/ROADMAP.md): open work and risks.
- [branding/](branding/): icon sources.
- [site/](site/): the download page generator (`build.mts`), which the Pages workflow runs.
- [scripts/list-fork-touches.sh](scripts/list-fork-touches.sh): lists every upstream file the fork changes.
- [scripts/notarize.sh](scripts/notarize.sh): sends a signed build to Apple's notary service, for the release workflow.

The product code is in [`../extensions/gemini/`](../extensions/gemini/).

## Features

- **Chat-first layout.** The agent's chat is the main editor tab; files and diffs it opens go in the editor group beside it, so the conversation stays in view. One side bar card holds the Agents pane, the agent's Changes and Quick Chat; every pane is a normal, resizable VS Code view or editor group.
- **Agents pane.** Run several agents side by side. Each one opens as an editor tab with its own chat, and can work in the open folder or any folder you add. Each row shows the agent's status (working, waiting for your permission, done, needs attention), its changed lines, when it was last active and its git branch. Rename, stop or remove an agent from its context menu.
- **Quick Chat.** A chat in the Gemini side bar for the open folder, collapsed below the Agents pane until you open it. **New Chat** in its title bar starts a fresh session.
- **Ask before acting.** Permission requests show the agent's own options, such as Allow, Allow for this session and Reject. Proposed edits open in a diff editor first.
- **Edits through the editor.** Agent edits can be undone, and the agent reads your unsaved changes. The agent cannot read secret files such as `.env` and private keys, or git-ignored files.
- **Enhance prompt.** Write what you want in plain words and choose **Enhance prompt** (⌥⌘E): Gemini rewrites it as a precise prompt for you to review, with **Revert** to undo.
- **Context.** Type `@` to attach workspace files. Press <kbd>⌘L</kbd> to add the editor selection. You can also attach or drop files and images from anywhere.
- **Changes view.** Below the Agents pane, see every file the agent in front has changed, one diff at a time or all together with **Open All Changes**. **Clear List** empties it.
- **Branches and commits.** A branch pill in each chat's composer switches or creates a branch. In an agent's chat, **Create Branch & Commit** commits just the files that agent changed to a new branch, and warns first if other files are staged.
- **Glass Dark and Glass Light.** The default colour themes: see-through side bars and floating cards over an aurora wallpaper, with the Gemini gradient for Gemini's own moments. GeminiCode Dark, Light, Midnight and Dusk are there too. GeminiCode also defaults to the view icons at the top of the side bar, pill-shaped tabs, and no minimap or breadcrumbs; change any of these in Settings.
- **Modes and models.** Pick an approval mode and a model from the composer. The lists come from the agent. The model you picked last is used for new and reopened agents too.
- **Conversations persist.** Agents keep their conversation across reloads and restarts, and resume their CLI session when the CLI supports it.
- **Managed CLI.** GeminiCode ships with a tested Gemini CLI, and can install, update and switch between newer versions in its own storage, without touching your system.
- **Update notice.** Once a day GeminiCode checks its download page. When a newer version is out it says so, with **Download** and **Release Notes** buttons; it downloads nothing on its own.
- **Admin policy.** Organisations can lock the CLI path or version, remove Auto Edit or YOLO, turn off shell commands, and turn off the CLI update offers and the update notice.

> [!IMPORTANT]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## Getting started

Download GeminiCode for Mac (Apple silicon) from the [download page](https://pulkitjain-org.github.io/vscode-gemini-cli/), open the `.dmg` and drag GeminiCode to Applications.

You need a Google account with a **Gemini Code Assist** license and a **Google Cloud project** to bill usage to. Your organisation may set the project for you.

The **Get Started with GeminiCode** walkthrough opens on first launch, and again from **Gemini: Get Started**. It walks through four steps:

1. **Gemini CLI.** GeminiCode comes with a tested Gemini CLI, so there is nothing to install. It uses `gemini.cliPath`, then a copy you installed from GeminiCode, then the bundled copy, then `gemini` on your `PATH`.
2. **Sign in.** Run **Gemini: Sign In with Google**. If your account needs a one-time step that the editor cannot show, run **Gemini: Complete Setup in Terminal**.
3. **Project.** Run **Gemini: Set Google Cloud Project ID**. Enter the project ID, not the project number.
4. **First agent.** Choose **New Agent** in the Agents pane.

The **Gemini** status bar item shows the agent's state. Hover over it to see the account, project and CLI version, and where that CLI came from. Click it to start or restart the agent, change the project or CLI version, sign in or finish setup in a terminal, open the chat, or open the log.

## Settings

| Setting | What it does |
| --- | --- |
| `gemini.projectId` | Google Cloud project ID to bill. A workspace value overrides a user value. |
| `gemini.cliPath` | Path to a `gemini` executable or `bundle/gemini.js`. Overrides GeminiCode's own copies. |
| `gemini.cli.version` | Which of GeminiCode's own CLI copies to run. Empty means the newest. |
| `gemini.cli.checkForUpdates` | Offer newer CLI releases, at most once a day. |
| `gemini.app.checkForUpdates` | Say when a newer GeminiCode is out, at most once a day. |
| `gemini.approval.allowAutoEdit` | Offer the Auto Edit mode. |
| `gemini.approval.allowYolo` | Offer the YOLO mode, which runs everything without asking. Off by default. |
| `gemini.tools.allowShell` | Let the agent run shell commands. Each command still asks first. |
| `gemini.browser.enabled` | Let agents open and use a page in the GeminiCode browser. On by default. |
| `gemini.browser.allowOtherSites` | Let agents open sites other than local ones, after asking. On by default. |
| `gemini.keepAwake` | Keep the Mac awake while any agent works. On by default. |
| `gemini.chat.followAgent` | Open each file the agent reads or edits as it works. The eye in the composer toggles it. Off by default. |
| `gemini.layout.showAgentsInNewWorkspaces` | Open the Agents pane, with the agent's Changes below it, the first time a workspace opens. |

Changing the CLI path or version, the project, or an approval or shell setting restarts the agent so the change applies. Admins can lock all of these except the project and layout settings through policy; see [Security model](docs/ARCHITECTURE.md#security-model).

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

[`gemini-ci.yml`](../.github/workflows/gemini-ci.yml) runs on pull requests and pushes to `main`, and can be run by hand. It does three things:

- It lints and hygiene-checks the fork files.
- It builds and type-checks the extension and webview, builds the download page from a sample release, then runs the unit tests and real-CLI tests against the `latest` and `preview` CLI.
- It compiles the whole fork and runs upstream's hygiene check. A pull request that only changes `extensions/gemini/`, `gemini/`, the Gemini workflows or top-level Markdown files skips this step, because the extension job already covers those files; a skipped job counts as passing. The step restores `node_modules` from a cache keyed on the lockfiles, so it reinstalls only when dependencies change.

Packaged builds come from [`gemini-release.yml`](../.github/workflows/gemini-release.yml), which a version tag starts, and the download page from [`gemini-pages.yml`](../.github/workflows/gemini-pages.yml); see [RELEASING.md](docs/RELEASING.md).

## Touching upstream files

Keep fork code in `extensions/gemini/`. Edit an upstream file only to register the extension, rebrand, or do something the extension API cannot, and mark the edit with a `GEMINI-FORK` comment. JSON files and icons cannot carry a marker, so the script also diffs against upstream:

```sh
gemini/scripts/list-fork-touches.sh upstream/main
```

Its output is the checklist for each upstream merge.

## Upstream merges

The fork branched from upstream `main` at 1.141.0-dev (1 Oct 2026). Add the remote once:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags
```

Bring upstream in by merging a release tag (`git merge 1.141.0`), never by rebasing, so every merge stays three-way. After each merge:

1. Re-check every file that `list-fork-touches.sh` lists.
2. Check whether upstream's Agents window (`src/vs/sessions`) gained an extension API for agent providers ([ROADMAP.md](docs/ROADMAP.md)).
3. Run the extension tests and the full compile.
