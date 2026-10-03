# Security

## Reporting a vulnerability

Do not report security problems in public issues. Use [GitHub's private vulnerability reporting](https://github.com/pulkitjain-org/vscode-gemini-cli/security/advisories/new) for this repository. Include the steps to reproduce, the affected version, and the impact you expect.

Some problems belong upstream:

- If the problem also affects VS Code, report it to Microsoft as described in [microsoft/vscode's SECURITY.md](https://github.com/microsoft/vscode/blob/main/SECURITY.md).
- If it is in the Gemini CLI itself, report it to [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli/security).

## Security model

GeminiCode runs the Gemini CLI as a child process with your user's permissions. The CLI is **not sandboxed**. These controls keep you in control of it:

- **Default** approval mode asks before every edit and shell command.
- An administrator can remove the **Auto Edit** and **YOLO** modes and the shell tool. GeminiCode passes these choices to the CLI as its admin policy, so the CLI enforces them as well.
- File requests that go through the editor are limited to the agent's folder. Reads skip git-ignored files, and secret files such as `.env` and private keys are refused. The CLI's own shell and search tools are not covered by these checks.

[gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md#security-model) describes the security model in full.
