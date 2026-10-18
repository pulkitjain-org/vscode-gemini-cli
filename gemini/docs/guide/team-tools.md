# Team tools

GeminiCode connects to Jira, GitLab, SonarQube, Snyk and Figma with your own account. Agents read tickets, merge requests, CI logs, quality checks and designs, and you can go from a ticket to a merged merge request without leaving the app.

Everything runs from your Mac, over your VPN. Nothing goes through a GeminiCode or Google service except what an agent reads, which goes to Gemini as part of its prompt. Nothing is written to Jira or GitLab without your click or your approval on a permission card.

## Connect your tools

Open **Connections** from the Command Palette (**Gemini: Connections**), the tools item in the status bar, or the Agents pane's **...** menu. Each tool shows who you're signed in as, the server and when the token expires.

| Tool | How it connects | What you need |
| --- | --- | --- |
| Jira (Cloud) | REST API, your email and an API token | A token from id.atlassian.com; **Create Token** opens the page. |
| GitLab | REST API v4, a personal access token | Scope `api` to open merge requests and comment (`read_api` can only read). **Create Token** opens GitLab's page with the name and scope filled in. VPN on. |
| SonarQube | Web API, a user token | VPN on. |
| Snyk | Your Snyk CLI | `snyk` installed, `snyk config set endpoint=<your Snyk>` and `snyk auth` once. VPN on. |
| Figma | The Figma desktop app's Dev Mode MCP server | A Dev or Full seat, with the Dev Mode MCP server turned on in Figma's preferences. |

Tokens go to the macOS keychain only, never to settings files or an agent's environment, and each is checked as you paste it. When a VPN-only tool doesn't answer, GeminiCode says "Can't reach … Check that your VPN is on" instead of waiting; the rest keep working.

## Team defaults

A checked-in `.gemini/geminicode-tools.json` saves everyone typing addresses. It never holds tokens.

```json
{
  "jira": { "site": "https://acme.atlassian.net", "projects": ["ACME"] },
  "gitlab": { "url": "https://gitlab.acme.internal", "releaseBranches": "release/*", "defaultTarget": "develop" },
  "sonar": { "url": "https://sonar.acme.internal", "projectKey": "acme-checkout" }
}
```

- `jira.projects` lets lower-case branch names such as `acme-412-gift` count as tickets.
- `jira.commentVisibility` (a project role, such as `Developers`) limits who sees comments agents add, and the comment a move posts, whether you move the ticket or an agent does.
- `jira.transitions` names your workflow's transition ids for the moves GeminiCode suggests: `{ "start": 21, "review": 31, "done": 41 }` for starting on a ticket, opening its merge request and merging it. Without them, GeminiCode looks for the In Progress, In Review and Done statuses by name. Jira lists a workflow's ids under its transitions in the workflow editor.
- `gitlab.releaseBranches` is the pattern of your release branches.
- `sonar.projectKey` can also come from the repository's `sonar-project.properties`.

> [!IMPORTANT]
> If your team's `.gemini/settings.json` has an `mcp.allowed` list, add `geminicode-tools` to it (Connections offers to). Once you've connected, remove any older `jira` and `gitlab` entries from `mcp.allowed` and `mcpServers` yourself; until then agents see two sets of Jira and GitLab tools. The terminal's `gemini` doesn't get these tools.

## Home

**Home** opens in front of your restored tabs every time GeminiCode starts. Under the **Start Agent** composer and quick actions, **Needs you** lists what waits on you across the tools: an agent asking permission, a failed pipeline on your merge request, a merge request of yours that GitLab says can merge, a review request, a reopened ticket.

Cards follow:

- **Agents.**
- **My tickets**: the current sprint's tickets assigned to you, with **Start**, **Move**, **Log Time** and **Reassign**.
- **Merge requests**: **Pending on me** (asked to review, or assigned to finish) and **Mine**, each with its pipeline and approvals; one that can merge shows **Merge…**.
- **Quality** on the release branch: the SonarQube gate and Snyk, with **Fix**.
- **Gemini.**

**Unfinished** appears only after GeminiCode quit while something was running: a flow tab (Move, Open Merge Request, Review) to **Reopen** from the same inputs or **Discard**, and a write whose result never came back, to check in the tool before doing it again (**Mark as Checked** once you have). Nothing is redone on its own. A chat whose agent was working when the app quit says so under the last message.

**Customize** hides and reorders cards and picks the release branch. Home shows the last data at once and refreshes each tool in the background; with the VPN off, VPN-only cards keep their last results, dimmed. Turn off opening it at start-up with `gemini.home.openOnStartup`; <kbd>⇧⌘H</kbd> or **Gemini: Home** brings it back.

## In chat

Paste a Jira key or link, a GitLab merge request or issue link, or a Figma link with a node, and it becomes a chip with the tool's logo; sending attaches the ticket, merge request or a hint to read the design. **From your tools** in the **+** menu picks a ticket, merge request or Figma frame. Tool calls show the tool's logo and what they did, such as "Read ACME-412".

## From ticket to merge request

1. **Start Agent on a ticket** (on Home, or **Gemini: Start Agent on Jira Ticket**) starts an agent on its own branch named after the ticket. It reads the ticket and plans first, and offers to move the ticket to In Progress.
2. **Run Checks** runs Snyk on dependencies and code, and SonarQube's new-code issues for the agent's branch, each finding with **Fix**, or **Fix All with This Agent**. **Run Checks on a Branch…** (on Home, or from the Command Palette) does the same for any branch before a merge request exists: the branch checked out here, an agent's, a local one or one on origin. A branch that isn't checked out gets a checkout of its own under `~/.geminicode/worktrees/<repository>/checks/`, with your `gemini.agents.worktreeSetup` command run in it once, and later runs reuse it; your own checkout never moves. SonarQube's gate comes from the server's last analysis of the branch, so it needs one push. With no agent on the branch, **Fix** starts one in that checkout with the findings as its first prompt.
3. **Open Merge Request** (beside Merge back in Changes) asks for the target branch, with release branches first and the one matching the ticket's fix version suggested. Then the title, a description Gemini drafts that you edit, the files to attach, reviewers, and draft and delete-branch options. It pushes the branch, opens the merge request and offers to move the ticket.
4. **The merge request panel** in Changes shows the pipeline (failed jobs with **Fix**), the SonarQube gate, Snyk and open review threads. **Fix Pipeline and N Comments** sends them to the agent.
5. **Merge.** The same panel lists the checks GitLab applies to the merge request, read live: open and not a draft, the pipeline, each approval rule by name with who approved, threads resolved, no conflicts, and GitLab's own verdict. **Merge…** is on only when every line holds. It asks once more, naming the commit it read and whether the commits are squashed and the branch deleted (the project's settings), and GitLab checks again when it merges, so a push in between makes it refuse rather than merge something else. Afterwards it offers to move the ticket. **Gemini: Merge Merge Request…** does the same for the agent in front, and **Merge…** on Home for a merge request listed as ready.

**Reassign…** on a ticket (on Home, or **Gemini: Reassign Jira Ticket…**) lists the people Jira lets take it, plus you and nobody.

**Move Ticket** shows the moves your Jira workflow allows, any field a move needs, and a comment Gemini drafts that you edit. **Log Time** records time spent, such as "1h 30m", on its own or with a move.

## Review a merge request

**Review** on a merge request waiting for you checks it out in its own worktree, and Gemini reviews it against the ticket, listing findings with a draft comment each. Tick and edit them, then **Post Comments and Request Changes**, **Post Comments** or **Approve**.

Clicking a merge request asks whether to open it in GeminiCode's browser or your default browser; **Always Use…** stops asking, and `gemini.team.openMergeRequestsIn` changes it later.

## Audit log

Every write GeminiCode makes to Jira or GitLab for you is recorded on your Mac, whether an agent asked for it or you pressed a button: a comment, a move, a time log, a reassignment, a merge request, a review comment, an approval, a merge. Each write gets two lines in a file per day under GeminiCode's storage, one before the call and one after, with what the tool gave back (a comment id, a worklog id, `!321`, the merge commit). The lines hold what changed and where, not the text; the text is in the chat.

**Gemini: Open Audit Log** (also in the Gemini status bar menu, and behind **Audit: 14 actions today** at the right of the status bar) shows the log as a page: one row per write with the time, who asked (an agent or a button of yours), the action, its effect, how you answered, the id the tool gave back and the state. Pick a day, a tool, or only the intents without a result. A row with no result is a write that was running when GeminiCode last quit; it is highlighted, and Home lists it under **Unfinished**. Check the tool before doing it again, then **Mark as Checked**. **Export the Day…** writes the day as Markdown to your home folder, and **Open Folder** shows the files.

If your repository's `.gemini/settings.json` runs the team's own Jira and GitLab servers (mcp-atlassian and gitlab-mcp), Connections shows a card for them. **Take Over Both Servers...** moves their tokens into the keychain, removes the two servers from the file, and runs the same servers in Docker behind GeminiCode's team tools, at pinned versions. Agents then see one set of Jira and GitLab tools, and an agent's shell can no longer read the tokens. The file is shared, so commit the change or ask whoever owns it. Without Docker, the team tools call Jira and GitLab directly. The same **Gemini › Team: Run Team Servers** setting also runs SonarQube's own server in Docker and Snyk's own server from your Snyk CLI; with SonarQube's, **Checks** adds a row that analyses the files your branch changed, on your Mac, before you push.

If you are in the pilot, turn on the **Gemini › Pilot: Record** setting. GeminiCode then counts launches, waits, permission cards, Undo and Rewind, team tool errors and links that leave the app, with times and no text, on your Mac only. At the end of the pilot, run **Gemini: Export Pilot Data** and hand over the `geminicode-pilot` folder in your home folder.

## What agents get

Every agent session gets a `geminicode-tools` MCP server with tools only for the tools you connected, such as `jira_get_issue`, `gitlab_get_mr`, `gitlab_job_log`, `sonar_quality_gate`, `snyk_test` and `figma_design`. Reading runs without asking. A Jira comment, a reassignment and a comment on a merge request show you a permission card with the exact text first, and you can allow the rest of the session.

Four actions are harder to take back, so they ask every time, with Allow once and Reject only: moving a ticket (`jira_transition`), logging time (`jira_log_time`), opening a merge request (`gitlab_create_mr`) and merging one (`gitlab_merge`). The same goes for the matching tools of a `jira` or `gitlab` MCP server your team runs beside GeminiCode. `gitlab_merge` reads GitLab's own checks first (pipeline, approval rules, threads, conflicts, GitLab's mergeable verdict) and refuses when any fails, saying which; when it merges, it names the commit it read, so a push in between makes GitLab refuse rather than merge something else.

Text an agent reads from a ticket, a merge request, a job log or a design comes wrapped in an `<external>` tag, and the server tells the model to read it as information from other people, never as instructions.
