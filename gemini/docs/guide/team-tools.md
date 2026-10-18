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
- `jira.commentVisibility` (a project role, such as `Developers`) limits who sees comments agents add.
- `gitlab.releaseBranches` is the pattern of your release branches.
- `sonar.projectKey` can also come from the repository's `sonar-project.properties`.

> [!IMPORTANT]
> If your team's `.gemini/settings.json` has an `mcp.allowed` list, add `geminicode-tools` to it (Connections offers to). Once you've connected, remove any older `jira` and `gitlab` entries from `mcp.allowed` and `mcpServers` yourself; until then agents see two sets of Jira and GitLab tools. The terminal's `gemini` doesn't get these tools.

## Home

**Home** opens in front of your restored tabs every time GeminiCode starts. Under the **Start Agent** composer and quick actions, **Needs you** lists what waits on you across the tools: an agent asking permission, a review request, a failed pipeline on your merge request, a reopened ticket.

Cards follow:

- **Agents.**
- **My tickets**: the current sprint's tickets assigned to you, with **Start**, **Move** and **Log Time**.
- **Merge requests**: those waiting for your review, and yours with their pipeline and approvals.
- **Quality** on the release branch: the SonarQube gate and Snyk, with **Fix**.
- **Gemini.**

**Customize** hides and reorders cards and picks the release branch. Home shows the last data at once and refreshes each tool in the background; with the VPN off, VPN-only cards keep their last results, dimmed. Turn off opening it at start-up with `gemini.home.openOnStartup`; <kbd>⇧⌘H</kbd> or **Gemini: Home** brings it back.

## In chat

Paste a Jira key or link, a GitLab merge request or issue link, or a Figma link with a node, and it becomes a chip with the tool's logo; sending attaches the ticket, merge request or a hint to read the design. **From your tools** in the **+** menu picks a ticket, merge request or Figma frame. Tool calls show the tool's logo and what they did, such as "Read ACME-412".

## From ticket to merge request

1. **Start Agent on a ticket** (on Home, or **Gemini: Start Agent on Jira Ticket**) starts an agent on its own branch named after the ticket. It reads the ticket and plans first, and offers to move the ticket to In Progress.
2. **Run Checks** runs Snyk on dependencies and code, and SonarQube's new-code issues for the agent's branch, each finding with **Fix**, or **Fix All with This Agent**. **Run Checks on a Branch…** (on Home, or from the Command Palette) does the same for any branch before a merge request exists: the branch checked out here, an agent's, a local one or one on origin. A branch that isn't checked out gets a checkout of its own under `~/.geminicode/worktrees/<repository>/checks/`, with your `gemini.agents.worktreeSetup` command run in it once, and later runs reuse it; your own checkout never moves. SonarQube's gate comes from the server's last analysis of the branch, so it needs one push. With no agent on the branch, **Fix** starts one in that checkout with the findings as its first prompt.
3. **Open Merge Request** (beside Merge back in Changes) asks for the target branch, with release branches first and the one matching the ticket's fix version suggested. Then the title, a description Gemini drafts that you edit, the files to attach, reviewers, and draft and delete-branch options. It pushes the branch, opens the merge request and offers to move the ticket.
4. **The merge request panel** in Changes shows the pipeline (failed jobs with **Fix**), the SonarQube gate, Snyk and open review threads. **Fix Pipeline and N Comments** sends them to the agent.

**Move Ticket** shows the moves your Jira workflow allows, any field a move needs, and a comment Gemini drafts that you edit. **Log Time** records time spent, such as "1h 30m", on its own or with a move.

## Review a merge request

**Review** on a merge request waiting for you checks it out in its own worktree, and Gemini reviews it against the ticket, listing findings with a draft comment each. Tick and edit them, then **Post Comments and Request Changes**, **Post Comments** or **Approve**.

Clicking a merge request asks whether to open it in GeminiCode's browser or your default browser; **Always Use…** stops asking, and `gemini.team.openMergeRequestsIn` changes it later.

## What agents get

Every agent session gets a `geminicode-tools` MCP server with tools only for the tools you connected, such as `jira_get_issue`, `gitlab_get_mr`, `gitlab_job_log`, `sonar_quality_gate`, `snyk_test` and `figma_design`. Reading runs without asking. A Jira comment, status change or time log, a new merge request and a comment on one always show you a permission card with the exact text first.
