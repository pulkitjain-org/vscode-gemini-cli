# GeminiCode

GeminiCode is a fork of VS Code (Code - OSS) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

The repository's top-level README, SECURITY and AGENTS files point here. CONTRIBUTING.md and the `.github` agent instructions are upstream's and stay unchanged, so upstream merges stay clean. This folder is where the fork's own docs live:

- [docs/USING.md](docs/USING.md): approval modes, folder trust, attachments, long conversations and troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how GeminiCode works and why, including the security model and admin policies.
- [docs/FINDINGS.md](docs/FINDINGS.md): Gemini CLI behaviour and measurements the design relies on.
- [docs/ROADMAP.md](docs/ROADMAP.md): open work and risks.
- [branding/](branding/): icon sources.
- [scripts/list-fork-touches.sh](scripts/list-fork-touches.sh): lists every upstream file the fork changes.

The product code is in [`../extensions/gemini/`](../extensions/gemini/).

## Features

- **Agents pane.** Run several agents side by side. Each one opens as an editor tab with its own chat, and can work in the open folder or any folder you add. Each row shows the agent's status, branch and changed lines.
- **Quick Chat.** A chat in the Gemini sidebar for the open folder.
- **Ask before acting.** Permission requests show the agent's own options, such as Allow, Allow for this session and Reject. Proposed edits open in a diff editor first.
- **Edits through the editor.** Agent edits can be undone, and the agent reads your unsaved changes. The agent cannot read secret files such as `.env` and private keys, or git-ignored files.
- **Context.** Type `@` to attach workspace files. Press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>L</kbd> to add the editor selection. You can also attach or drop files and images from anywhere.
- **Changes view.** See every file the agent in front has changed, as diffs or all together. **Create Branch & Commit** commits just that agent's files.
- **Modes and models.** Pick an approval mode and a model from the composer. The lists come from the agent.
- **Conversations persist.** Agents keep their conversation across reloads and restarts, and resume their CLI session when the CLI supports it.
- **Managed CLI.** GeminiCode can install, update and switch between Gemini CLI versions in its own storage, without touching your system.
- **Admin policy.** Organisations can lock the CLI version, remove Auto Edit or YOLO, and turn off shell commands.

> [!IMPORTANT]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## Getting started

You need a Google account with a **Gemini Code Assist** license and a **Google Cloud project** to bill usage to. Your organisation may set the project for you.

The **Get Started with GeminiCode** walkthrough opens on first launch, and again from **Gemini: Get Started**. It walks through four steps:

1. **Gemini CLI.** GeminiCode uses `gemini.cliPath`, then its own copy, then `gemini` on your `PATH`. If none is found, run **Gemini: Install Latest Gemini CLI**.
2. **Sign in.** Run **Gemini: Sign In with Google**. If your account needs a one-time step that the editor cannot show, run **Gemini: Complete Setup in Terminal**.
3. **Project.** Run **Gemini: Set Google Cloud Project ID**. Enter the project ID, not the project number.
4. **First agent.** Choose **New Agent** in the Agents pane.

The **Gemini** status bar item shows the agent's state. Hover over it to see the account, project and CLI version. Click it to restart the agent, change the project or CLI version, or open the log.

## Settings

| Setting | What it does |
| --- | --- |
| `gemini.projectId` | Google Cloud project ID to bill. A workspace value overrides a user value. |
| `gemini.cliPath` | Path to a `gemini` executable or `bundle/gemini.js`. Overrides GeminiCode's own copy. |
| `gemini.cli.version` | Which of GeminiCode's own CLI copies to run. Empty means the newest. |
| `gemini.cli.checkForUpdates` | Offer newer CLI releases, at most once a day. |
| `gemini.approval.allowAutoEdit` | Offer the Auto Edit mode. |
| `gemini.approval.allowYolo` | Offer the YOLO mode, which runs everything without asking. Off by default. |
| `gemini.tools.allowShell` | Let the agent run shell commands. Each command still asks first. |
| `gemini.layout.showAgentsInNewWorkspaces` | Open the Agents pane and Changes view the first time a workspace opens. |

Admins can lock all of these except the project and layout settings through policy; see [Security model](docs/ARCHITECTURE.md#security-model).

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

[`gemini-ci.yml`](../.github/workflows/gemini-ci.yml) runs on pull requests and pushes to `main`. It does three things:

- It lints and hygiene-checks the fork files.
- It builds and type-checks the extension and webview, then runs the unit tests and real-CLI tests against the `latest` and `preview` CLI.
- It compiles the whole fork and runs upstream's hygiene check.

It does not produce packaged builds yet.

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
