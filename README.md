# GeminiCode

GeminiCode is a code editor with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It is a fork of [Visual Studio Code](https://github.com/microsoft/vscode) (Code - OSS). It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license, inside a full editor.

## Features

- **Agents pane.** Run several agents side by side. Each one opens as an editor tab with its own chat, and can work in the open folder or any folder you add. Each row shows the agent's status, branch and changed lines.
- **Quick Chat.** A chat in the Gemini sidebar for the open folder.
- **Ask before acting.** Permission requests show the agent's own options, such as Allow, Allow for this session and Reject. Proposed edits open in a diff editor first.
- **Edits through the editor.** Agent edits can be undone, and the agent reads your unsaved changes. The agent cannot read secret files such as `.env` and private keys, or git-ignored files.
- **Context.** Type `@` to attach workspace files. Press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>L</kbd> to add the editor selection. You can also attach or drop files and images from anywhere.
- **Changes view.** See every file the agent in front has changed, as diffs or all together. **Create Branch & Commit** commits just that agent's files.
- **Modes and models.** Pick an approval mode (**Default**, **Auto Edit**, **Plan**) and a model from the composer. The lists come from the agent.
- **Conversations persist.** Agents keep their conversation across reloads and restarts, and resume their CLI session when the CLI supports it.
- **Managed CLI.** GeminiCode can install, update and switch between Gemini CLI versions in its own storage, without touching your system.
- **Admin policy.** Organisations can lock the CLI version, remove Auto Edit or YOLO, and turn off shell commands.

## Getting started

You need a Google account with a **Gemini Code Assist** license and a **Google Cloud project** to bill usage to. Your organisation may set the project for you.

The **Get Started with GeminiCode** walkthrough opens on first launch. You can reopen it any time with **Gemini: Get Started**. It walks through four steps:

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

Admins can lock all of these except the project and layout settings through policy. See [Architecture: Security model](gemini/docs/ARCHITECTURE.md#security-model).

> [!IMPORTANT]
> The agent is not sandboxed. Its shell and search tools run with your permissions. **Default** mode asks before every change and command; use **Auto Edit** and **YOLO** only in folders you trust.

## Building from source

```sh
nvm use              # Node version from .nvmrc
npm ci
npm run watch        # keep running
./scripts/code.sh    # on Windows: .\scripts\code.bat
```

To run the extension's tests:

```sh
cd extensions/gemini
npm test
```

For upstream merges, CI and the rules for editing upstream files, see [gemini/README.md](gemini/README.md).

## Repository layout

| Path | Contents |
| --- | --- |
| [`extensions/gemini/`](extensions/gemini/) | The built-in Gemini extension: the ACP client, chat, Agents pane and Changes view. |
| [`gemini/`](gemini/) | Fork docs ([architecture](gemini/docs/ARCHITECTURE.md), [CLI findings](gemini/docs/FINDINGS.md), [roadmap](gemini/docs/ROADMAP.md)), icon sources and maintainer scripts. |
| everything else | Upstream VS Code, changed only at the points marked `GEMINI-FORK`. |

## Feedback and security

Report bugs and requests in [GitHub Issues](https://github.com/pulkitjain-org/vscode-gemini-cli/issues). For vulnerabilities, see [SECURITY.md](SECURITY.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GeminiCode is licensed under the [MIT License](LICENSE.txt). It is based on Code - OSS, Copyright (c) Microsoft Corporation, and is not affiliated with or endorsed by Microsoft or Google. Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
