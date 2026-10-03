# GeminiCode

GeminiCode is a code editor built on [VS Code (Code - OSS)](https://github.com/microsoft/vscode) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

- **Agents pane.** Run several agents side by side, each in its own editor tab, in the open folder or any folder you add.
- **Chat that asks first.** Proposed edits open as diffs, and every command asks before it runs unless you pick a looser mode.
- **Context.** `@` to mention files, <kbd>Cmd</kbd>+<kbd>L</kbd> to add the selection, and drag in files, images and PDFs from anywhere.
- **Managed CLI and admin policy.** GeminiCode installs and updates its own Gemini CLI, and organisations can lock the CLI version, approval modes and shell access.

## Get GeminiCode

Packaged macOS (Apple silicon) builds will be published on this repository's [Releases](https://github.com/pulkitjain-org/vscode-gemini-cli/releases) page. Until then, build it from source as described in [gemini/README.md](gemini/README.md#developing).

You need a Google account with a Gemini Code Assist license and a Google Cloud project.

## Documentation

- [gemini/README.md](gemini/README.md): features, getting started, settings, building and contributing.
- [gemini/docs/USING.md](gemini/docs/USING.md): approval modes, folder trust, attachments, long conversations and troubleshooting.
- [gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md): how GeminiCode works, its security model and admin policies.
- [gemini/docs/ROADMAP.md](gemini/docs/ROADMAP.md): open work and risks.

## License

GeminiCode is released under the [MIT license](LICENSE.txt), like Code - OSS. It is not affiliated with or endorsed by Microsoft or Google. Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
