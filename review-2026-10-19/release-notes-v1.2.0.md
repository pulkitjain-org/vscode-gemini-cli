<!--
Draft for the next GitHub release (v1.2.0, after v1.1.0). Images are the existing site assets in gemini/site/media, linked from the published site so the links don't expire.
None of the existing assets shows a connected team tool (chips, Connections, the merge request panel); consider capturing one from the real app.
-->

v1.2.0 brings your team's tools into GeminiCode. Connect **Jira, GitLab, SonarQube, Snyk and Figma** with your own account, and go from a ticket to a merged merge request without leaving the app: start an agent on a ticket, run checks, open the merge request, fix its pipeline and comments, and merge. **Home** becomes a dashboard of what needs you. Each finished turn **folds under one line**. A turn cut off by a quit says so and can be picked up. Every write to Jira or GitLab is recorded in an **audit log** on your Mac. Waiting agents no longer pull you out of the chat you are typing in. GeminiCode now builds on Code - OSS 1.142.0.

- **Platform**: Mac with Apple silicon and **macOS 26 or later**. The app now refuses to open on older macOS releases and on Intel Macs, where it was never supported.
- **Built on**: Code - OSS 1.142.0 (Electron 43.7.7) and Gemini CLI 0.64.0 (included).

<img width="1600" height="1000" alt="Home in GeminiCode Dark" src="https://pulkitjain-org.github.io/vscode-gemini-cli/media/home-dark.webp" />

### What's new

**Team tools**
- **Connections** (**Gemini: Connections**, or the tools item in the status bar) connects Jira Cloud, GitLab, SonarQube, Snyk (through your Snyk CLI) and Figma (through the desktop app's Dev Mode server). Each tool shows who you are signed in as, the server, and when the token expires. **Create Token** opens the right page with the name and scope filled in where the tool allows.
- Tokens go to the macOS keychain only, never to settings files or an agent's environment, and each is checked as you paste it. When a VPN-only tool doesn't answer, GeminiCode says "Can't reach … Check that your VPN is on" straight away; the other tools keep working.
- A checked-in `.gemini/geminicode-tools.json` holds the team's addresses, Jira projects, workflow transitions, release branch pattern and SonarQube project key, so nobody types them. It never holds tokens.
- Every agent gets a `geminicode-tools` MCP server with tools for what you connected, such as `jira_get_issue`, `gitlab_get_mr`, `gitlab_job_log`, `sonar_quality_gate`, `snyk_test` and `figma_design`. Reads run without asking. Text an agent reads from a ticket, merge request, job log or design is marked as information from other people, never as instructions.

**From ticket to merge request**
- **Start Agent on Jira Ticket** starts an agent on its own branch named after the ticket. It reads the ticket, plans first, and offers to move the ticket to In Progress.
- **Run Checks** runs Snyk on dependencies and code, and SonarQube's new-code issues, for the agent's branch, each finding with **Fix** or **Fix All with This Agent**. **Run Checks on a Branch…** does the same for any branch, in a checkout of its own, before a merge request exists.
- **Open Merge Request** (beside **Merge back** in Changes) suggests the target branch from the ticket's fix version, drafts the description for you to edit, then pushes and opens the merge request.
- The **merge request panel** in Changes shows the pipeline (failed jobs with **Fix**), the SonarQube gate, Snyk and open review threads. **Fix Pipeline and N Comments** hands them all to the agent.
- **Merge…** turns on only when every check GitLab applies holds: pipeline, each approval rule by name, threads resolved, no conflicts and GitLab's own verdict. It names the commit it read, so a push in between makes GitLab refuse rather than merge something else.
- **Review a Merge Request…** checks it out in its own worktree, and Gemini reviews it against the ticket with a draft comment per finding. Tick and edit them, then **Post Comments and Request Changes**, **Post Comments** or **Approve**.
- **Move Ticket**, **Log Time** and **Reassign…** show the moves your workflow allows, any fields a move needs, and a comment Gemini drafts for you to edit.

**Home**
- Home now opens in front of your restored tabs every time GeminiCode starts (⇧⌘H brings it back). **Needs you** lists what waits on you across your agents and tools: an agent asking permission, a failed pipeline, a merge request that can merge, a review request, a reopened ticket.
- Cards for **Agents**, **My tickets** (this sprint first), **Merge requests** (Pending on me, Mine), **Quality** on the release branch, and **Gemini**. **Show All** opens a card's whole list; **Customize** hides and reorders cards and picks the release branch.
- Home shows the last data at once and refreshes in the background only while you look at it. With the VPN off, VPN-only cards keep their last results, dimmed.

**In chat**
- Paste a Jira key or link, a GitLab merge request or issue link, or a Figma link, and it becomes a chip with the tool's logo. Sending it attaches the ticket, merge request or design. **From your tools** in the **+** menu picks one. Tool calls show the tool's logo and what they did, such as "Read ACME-412".

**Ask every time for what's hard to take back**
- Moving a ticket, logging time, opening a merge request and merging one always show a card with **Allow once** and **Reject** only, also in YOLO. A Jira comment, a reassignment and a merge request comment show the exact text first.

**Audit log**
- Every write GeminiCode makes to Jira or GitLab for you, by an agent or by a button, is recorded on your Mac before and after the call, with the id the tool gave back. It records what changed and where, never the text.
- **Gemini: Open Audit Log** (or **Audit: N actions today** in the status bar) shows the log by day and tool. **Export the Day…** writes it as Markdown.

**Finished work folds away**
- Each finished turn's thoughts and steps fold under one line, such as "Worked for 2m 48s · read 5 files, ran 5 commands, edited 2 files", with the files it changed as chips and any failed step kept in sight. Click the line to see every step. Runs of the same kind of step share a line. Turn it off with `gemini.chat.foldFinishedWork`.

<img width="1600" height="1000" alt="A folded turn with its changed files" src="https://pulkitjain-org.github.io/vscode-gemini-cli/media/docs/plus-menu-dark.webp" />

**Pick up after a quit**
- A chat whose agent was working when GeminiCode quit now says so under the last message, with **Retry the Turn** or **Keep and Continue**. Nothing is sent to Gemini on its own.
- Home lists a team flow that was open (Move, Open Merge Request, Review) under **Unfinished**, to **Reopen** or **Discard**. A Jira or GitLab write whose result never came back is listed too, so you can check it in the tool before doing it again (**Mark as Checked**).

**Calmer agents**
- An agent that asks for permission no longer brings its chat forward. Its status dot, the Dock badge and the notification say it waits, so it never takes over the chat you are typing in.
- **Esc twice** stops a working agent, so an Esc meant for a menu or pop-up doesn't.
- Switching to YOLO while requests wait answers them at once, except the confirm-class actions above.
- Changing a Gemini setting no longer restarts a working agent mid-turn: the restart waits until no agent is working. A change that takes a permission away still applies at once.
- A project's coordinator keeps the model you pick in its chat, also after a reload.

**Agent browser**
- Agents keep working on a page whose tab is behind another tab or in a hidden group; clicks and hovers there no longer time out.
- When an agent goes to a new address on one of its pages, the page's tab comes forward without taking your focus.
- A localhost link in a Gemini chat opens beside the chat, not as a tab hidden behind it.

<img width="1600" height="1000" alt="An agent reading a local page in GeminiCode's browser" src="https://pulkitjain-org.github.io/vscode-gemini-cli/media/browser-page-light.webp" />

**See where the time goes**
- Each turn's end shows how long the model took to respond ("first token"): its first thought, step or words, not just its final answer.
- **Gemini: Record or Stop Performance Trace** records the CLI's own OpenTelemetry trace. While it records, each turn shows where its time went (starting the session, sending the prompt, the model, tools), with the tokens in and out.
- **Gemini: Run Benchmark…** runs a folder of benchmark tasks against the agent and reports the results.

**For admins**
- `gemini.tools.denyEnvironmentCommands` (on by default) refuses shell commands that print the environment, such as `env` and `printenv`, which could show an agent a token.
- `gemini.mcp.allowedServers` lists the only MCP servers agents may use besides GeminiCode's own; it outranks any repository's settings file.
- `gemini.team.runTeamServers` runs the team's own Jira and GitLab servers (mcp-atlassian, gitlab-mcp) and SonarQube's server in Docker at pinned versions, and Snyk's server from the Snyk CLI. **Take Over Both Servers…** in Connections moves a repository's Jira and GitLab server tokens into the keychain, so an agent's shell can no longer read them.
- An MCP server that can't be reached now says so plainly: "Gemini could not reach the MCP server…".

**New look**
- A new app icon, the Aperture mark, with a layered macOS 26 icon.
- A first launch opens on Home, without upstream's onboarding.

**New commands**

| Command | What it does |
| --- | --- |
| Gemini: Home | Open Home |
| Gemini: Connections | Connect Jira, GitLab, SonarQube, Snyk and Figma |
| Gemini: Start Agent on Jira Ticket... | Start an agent on its own branch for a ticket |
| Gemini: Run Checks | Run Snyk and SonarQube on the agent's branch |
| Gemini: Run Checks on a Branch... | Run them on any branch, before a merge request |
| Gemini: Open Merge Request... | Push the agent's branch and open a merge request |
| Gemini: Fix Merge Request Pipeline and Comments | Send failed jobs and open threads to the agent |
| Gemini: Merge Merge Request... | Merge once every GitLab check holds |
| Gemini: Review a Merge Request... | Review a merge request against its ticket |
| Gemini: Move Jira Ticket... | Move a ticket, with a drafted comment |
| Gemini: Log Time on Jira Ticket... | Log time spent on a ticket |
| Gemini: Reassign Jira Ticket... | Reassign a ticket |
| Gemini: Reopen Unfinished Flow | Reopen a flow a quit cut off |
| Gemini: Discard Unfinished Flow | Discard it |
| Gemini: Mark Unfinished Change as Checked | Settle a write whose result never came back |
| Gemini: Open Audit Log | See every write made to Jira or GitLab for you |
| Gemini: Record or Stop Performance Trace | Record the CLI's trace and see where each turn's time went |
| Gemini: Run Benchmark... | Run benchmark tasks against the agent |
| Gemini: Export Pilot Data | Write the pilot's counters and the audit log to ~/geminicode-pilot/ |

**New keyboard shortcuts**

| Keys | What it does |
| --- | --- |
| Shift+Cmd+H | Open Home |
| Esc Esc | Stop a working agent (was Esc) |

**New settings**

| Setting | Default | What it does |
| --- | --- | --- |
| gemini.chat.foldFinishedWork | true | Fold each finished turn's steps under one line |
| gemini.home.openOnStartup | true | Open Home in front of your restored tabs at start-up |
| gemini.team.openMergeRequestsIn | ask | Open merge requests in GeminiCode's browser or your default browser |
| gemini.team.runTeamServers | false | Run the tools' own MCP servers (Docker, Snyk CLI) behind the team tools |
| gemini.tools.denyEnvironmentCommands | true | Refuse shell commands that print the environment |
| gemini.mcp.allowedServers | (empty) | The only MCP servers agents may use, besides GeminiCode's own |
| gemini.pilot.record | false | Count launches, waits and team tool errors for the pilot, with no text, on this Mac only |

**Fixes**

- A permission card left open when the window closed shows as cancelled after a reload, instead of offering buttons nothing can answer.
- A new permission card after an agent restart no longer takes an earlier card's place in the chat.
- An agent's browser console tool works again.
- With an editor group maximized, switching agents no longer shows or hides the wrong groups, and moving between groups never lands on a hidden one.

**Known limitations**

- Team tools support Jira Cloud. The terminal's `gemini` doesn't get the `geminicode-tools` server.
- If your team's `.gemini/settings.json` has an `mcp.allowed` list, add `geminicode-tools` to it (Connections offers to).
- With `gemini.team.runTeamServers` on, the team's Jira and GitLab servers start in Docker when an agent's session opens. A call waits at most 8 seconds for one still starting, and after a failed start calls go to Jira and GitLab directly for a few minutes.
