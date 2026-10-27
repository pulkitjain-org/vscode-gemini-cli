# GeminiCode

GeminiCode is a code editor built on [VS Code (Code - OSS)](https://github.com/microsoft/vscode) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

- **Agents side by side.** Run several agents at once, each in its own tab and folder, optionally on a branch of its own, and try its work in your workspace before you keep it. Fork one to split its work without starting over. Home shows each agent's status, changes and next step.
- **Chat that asks first.** Every command and edit asks before it runs unless you pick a looser mode, and each change can be kept or undone in the file. Edit and comment on a plan before it is built. Steer an agent while it works or queue your next message, answer a reply with an emoji, and compact long chats.
- **A terminal per agent.** Run the commands Gemini suggests with one click, in the agent's own terminal, and send a failed command's output straight back to it.
- **Context.** `@` to mention files, <kbd>Cmd</kbd>+<kbd>L</kbd> to add the selection, and drag in files, images and PDFs from anywhere. A local workspace index lets agents find code in one step.
- **Projects.** A coordinator splits larger work into threads, each an agent on its own branch, whose work you try in your workspace and keep, or take back.
- **A browser agents can use.** Agents open your app, click, type and read the console; point at an element to add it to a prompt.
- **Team tools.** Jira (one site or several), Confluence, GitLab, SonarQube, Snyk and Figma with your own account: start from a ticket, open and fix the merge request, review others' merge requests with Gemini's draft and your own comments, merge when GitLab's checks pass, and publish the Confluence pages agents draft once you've reviewed them.
- **Managed CLI and admin policy.** GeminiCode installs and updates its own Gemini CLI, and organisations can lock the CLI version, approval modes and shell access.

## Get GeminiCode

Download GeminiCode for Mac (Apple silicon, macOS 26 or later) from the [download page](https://pulkitjain-org.github.io/vscode-gemini-cli/), which always points at the newest build on this repository's [Releases](https://github.com/pulkitjain-org/vscode-gemini-cli/releases) page. Windows, Linux and Intel Mac builds are not published yet; on those, build it from source as described in [gemini/README.md](gemini/README.md#developing).

You need a Google account with a Gemini Code Assist license and a Google Cloud project.

## Documentation

- [gemini/README.md](gemini/README.md): what is in the fork, building it, and contributing.
- [GeminiCode docs](https://pulkitjain-org.github.io/vscode-gemini-cli/docs/) (source in [gemini/docs/guide/](gemini/docs/guide/)): every feature and how to use it, from approval modes and projects to settings and troubleshooting.
- [gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md): how GeminiCode works, its security model and admin policies.
- [gemini/docs/RELEASING.md](gemini/docs/RELEASING.md): versions, releases and the download page.
- [gemini/docs/ROADMAP.md](gemini/docs/ROADMAP.md): open work and risks.

## License

GeminiCode is released under the [MIT license](LICENSE.txt), like Code - OSS. It is not affiliated with or endorsed by Microsoft or Google. Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
