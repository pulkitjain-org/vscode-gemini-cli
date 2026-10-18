# Troubleshooting

What to do when something doesn't work. Most fixes are one command away in the **Gemini** item in the status bar.

## Common problems

| Symptom | What to do |
| --- | --- |
| The status bar says sign-in is needed | Run **Gemini: Sign In with Google**. If it needs a step the editor can't show, run **Gemini: Complete Setup in Terminal**, finish it, and exit with `/quit`. |
| "is a project number" | Set the project ID, such as `my-project-123`, with **Gemini: Set Google Cloud Project ID**. |
| No Gemini CLI found | Only in a build without the bundled CLI. Run **Gemini: Install Latest Gemini CLI**, or set `gemini.cliPath`. |
| "older than 0.64.0" | The CLI in use is too old. Choose **Install Latest**, or run **Gemini: Install or Change Gemini CLI Version...**. |
| Not sure the CLI starts at all | Run **Gemini: Check Agent Connection**. It starts the CLI on its own and reports its version and protocol, or the error. |
| The agent stops or misbehaves | Click the **Gemini** status bar item and choose **Restart Agent**. Open agents resume their sessions. |
| Auto Edit or YOLO is refused | The Gemini CLI won't use them in a folder it doesn't trust. Pick the mode again and trust the folder when asked. |
| An MCP server doesn't load | Check the warning and the server's mark in **Project Helpers**, and **Gemini: Show Log**. A project's servers load only in a trusted folder. |
| "Can't reach … Check that your VPN is on" | A team tool behind your VPN didn't answer. Connect the VPN; the other tools keep working. |
| The macOS build won't open | See the note under [Install](getting-started.md#install). |

## Report a problem

Click the **Gemini** status bar item and choose **Report an Issue...**, which opens a new issue with the GeminiCode, VS Code, Gemini CLI and OS versions filled in. Run **Gemini: Show Log** and include the relevant lines, with account names and project IDs removed. **Gemini CLI Docs** in the same menu opens the CLI's own documentation.

Report security problems privately through [GitHub's vulnerability reporting](https://github.com/pulkitjain-org/vscode-gemini-cli/security/advisories/new), never in a public issue.
