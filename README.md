# GeminiCode

GeminiCode is a code editor built on [VS Code (Code - OSS)](https://github.com/microsoft/vscode) with the [Gemini CLI](https://github.com/google-gemini/gemini-cli) built in as its coding agent. It runs the official `gemini` CLI over the [Agent Client Protocol](https://agentclientprotocol.com), so you get the CLI's agent, sign-in and Gemini Code Assist license inside a full editor.

You describe a task, an agent does the work in your repository, and nothing it does lands without you seeing it.

- **Agents side by side.** Each agent has its own tab, chat, files and terminal. Run several at once, give one its own branch so it can't trip over the others, and try its work in your checkout before you keep it. When an agent's work splits in two, fork it and both carry on from the same conversation.
- **You approve, you review.** Commands and edits ask before they run, unless you choose a looser mode. Every change shows in its file with **Keep** and **Undo**, and **Rewind** takes the chat and the code back to any message. Plans can be edited and commented on before a line of code changes, and so can the reports and other Markdown files an agent writes.
- **Talk to it while it works.** Steer an agent mid-task, queue the next message, ask a side question without interrupting it, or answer a reply with an emoji.
- **It finds the code.** A local index of each workspace, the editor's language servers and the documentation you attach let agents go straight to the right code instead of reading file by file. Nothing leaves your Mac.
- **Projects for bigger work.** A coordinator splits a larger job into threads, each an agent on its own branch, possibly across several repositories. You try each thread's work and keep it, or take it back.
- **A browser your agents can use.** Agents open your app, click, type and read the console. Point at an element or pin notes on the page to show them what to change.
- **Your team's tools.** Jira, Confluence, GitLab, SonarQube, Snyk and Figma, with your own account: start from a ticket, open the merge request, fix the pipeline and the review comments, review a teammate's merge request with Gemini, and publish the Confluence pages agents draft once you've reviewed them.
- **The Gemini CLI included.** GeminiCode ships with the CLI and offers its updates once a day. Your terminal's `gemini` shares its settings, sign-in and saved sessions.

## Get GeminiCode

Download GeminiCode for Mac (Apple silicon, macOS 26 or later) from the [download page](https://pulkitjain-org.github.io/vscode-gemini-cli/), which always points at the newest build on this repository's [Releases](https://github.com/pulkitjain-org/vscode-gemini-cli/releases) page. Windows, Linux and Intel Mac builds are not published yet; on those, build it from source as described in [gemini/README.md](gemini/README.md#developing).

You need a Google account with a Gemini Code Assist license and a Google Cloud project.

## Documentation

- [gemini/README.md](gemini/README.md): what is in the fork, building it, and contributing.
- [GeminiCode docs](https://pulkitjain-org.github.io/vscode-gemini-cli/docs/) (source in [gemini/docs/guide/](gemini/docs/guide/)): every feature and how to use it, from approval modes and projects to settings and troubleshooting.
- [gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md): how GeminiCode works, its security model and its design rules.
- [gemini/docs/RELEASING.md](gemini/docs/RELEASING.md): versions, releases and the download page.
- [gemini/docs/ROADMAP.md](gemini/docs/ROADMAP.md): open work and risks.

## License

GeminiCode is released under the [MIT license](LICENSE.txt), like Code - OSS. It is not affiliated with or endorsed by Microsoft or Google. Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
