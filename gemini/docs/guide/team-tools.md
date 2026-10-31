# Team tools

GeminiCode connects to Jira, Confluence, GitLab, SonarQube, Snyk and Figma with your own account. Agents read tickets, pages, merge requests, CI logs, quality checks and designs, draft Confluence pages for you to review, and you can go from a ticket to a merged merge request without leaving the app.

Everything runs from your Mac, over your VPN. Nothing goes through a GeminiCode or Google service except what an agent reads, which goes to Gemini as part of its prompt. Nothing is written to Jira, Confluence or GitLab without your click or your approval on a permission card.

## Connect your tools

Open **Connections** from the Command Palette (**Gemini: Connections**), the **Gemini** status bar item's menu (its tooltip lists each connected tool's state), or the Agents pane's **...** menu. The actions Home's cards offer, Open Merge Request, Run Checks, Run Checks on a Branch, Move, Log Time and Reassign, are one Command Palette entry, **Gemini: Jira and GitLab Actions...**, which asks what to do and then which ticket, agent or branch. Each tool shows who you're signed in as, the server and when the token expires.

| Tool | How it connects | What you need |
| --- | --- | --- |
| Jira (Cloud) | REST API, your email and an API token | A token from id.atlassian.com; **Create Token** opens the page. **Add Another Jira** connects more sites. |
| Confluence (Cloud) | REST API, with the account of a Jira site you connected | Nothing to paste: **Use My … Jira Account** turns it on for that site. |
| GitLab | REST API v4, a personal access token | Scope `api` to open merge requests and comment (`read_api` can only read). **Create Token** opens GitLab's page with the name and scope filled in. VPN on. |
| SonarQube | Web API, a user token | VPN on. |
| Snyk | Your Snyk CLI | `snyk` installed, `snyk config set endpoint=<your Snyk>` and `snyk auth` once. VPN on. |
| Figma | The Figma desktop app's Dev Mode MCP server | A Dev or Full seat, with the Dev Mode MCP server turned on in Figma's preferences. |

Tokens go to the macOS keychain only, never to settings files or an agent's environment, and each is checked as you paste it. When a VPN-only tool doesn't answer, GeminiCode says "Can't reach … Check that your VPN is on" instead of waiting; the rest keep working. An outage is reported once: for a while after a server stops answering (30 s, then 1, 2 and up to 5 minutes), calls to it fail at once, and agents read one line, such as "GitLab is unreachable right now (VPN?)". GeminiCode tries the server again when the wait ends, so it comes back by itself once your VPN is on. When a tool refuses your token, GeminiCode stops calling it with that token, and Connections asks you to replace it.

A read that meets a busy server (it answers 429, 502, 503 or 504) is tried once more, after the wait the server asks for when that is 5 seconds or less. A write is never sent twice. A write may take 20 seconds; one that gets no answer in that time says it may have gone through, and stays open in the audit log until you check.

### Several Jira sites

If you work with more than one Jira, such as two client teams' sites, connect the first as usual, then choose **Add Another Jira** under Jira in Connections. Give each site a **Name**, such as the team or client: Home shows it above that site's tickets. **Remove** disconnects a site and deletes its token from the keychain.

With several sites:

- **My tickets** on Home groups your tickets by site, each with its own sprint. A site that can't be reached keeps its last tickets, dimmed, and says so.
- A ticket goes to the site it belongs to. A link goes by its address. A key goes to the site its project was read from, and a key never seen before is looked for on every site.
- A key that two sites both have is refused rather than guessed, and the agent is asked for the ticket's link instead.
- A search runs on every site, and its result says which sites didn't answer or had more matches than it shows.
- The audit log names the site of each write.

### Confluence

Confluence on Atlassian Cloud shares one account and token with Jira on the same site, so there is nothing to paste. Connect Jira first, then under **Connect Confluence** choose **Use My … Jira Account**. **Turn On for Another Site** does the same for another Jira site you connected.

## Team defaults

A checked-in `.gemini/geminicode-tools.json` saves everyone typing addresses. It never holds tokens.

```json
{
  "jira": { "site": "https://acme.atlassian.net", "projects": ["ACME"] },
  "gitlab": { "url": "https://gitlab.acme.internal", "releaseBranches": "release/*", "defaultTarget": "develop" },
  "sonar": { "url": "https://sonar.acme.internal", "projectKey": "acme-checkout" },
  "figma": { "viewports": ["Mobile", "Tablet", "Desktop"] }
}
```

- `jira.projects` lets lower-case branch names such as `acme-412-gift` count as tickets.
- `jira.commentVisibility` (a project role, such as `Developers`) limits who sees comments agents add, and the comment a move posts, whether you move the ticket or an agent does.
- `jira.transitions` names your workflow's transition ids for the moves GeminiCode suggests: `{ "start": 21, "review": 31, "done": 41 }` for starting on a ticket, opening its merge request and merging it. Without them, GeminiCode looks for the In Progress, In Review and Done statuses by name. Jira lists a workflow's ids under its transitions in the workflow editor.
- `gitlab.releaseBranches` is the pattern of your release branches.
- `sonar.projectKey` can also come from the repository's `sonar-project.properties`.
- `figma.viewports` names the screen sizes **Add Figma Design** asks a frame for, such as `["Mobile", "Tablet", "Desktop"]`. Without it, your own `gemini.figma.viewports` setting names them, and without that the sizes are XS, S, M and L.
- `figma.designSystem` names your team's design system in Figma, for [Sync Design System](#your-design-system).

> [!IMPORTANT]
> GeminiCode's own servers (`geminicode-tools`, `geminicode-project`, `geminicode-browser`) are always allowed, even when your Gemini settings have an `mcp.allowed` list without them; only `mcp.excluded` keeps them out. Once you've connected, remove any older `jira` and `gitlab` entries from `mcp.allowed` and `mcpServers` yourself; until then agents see two sets of Jira and GitLab tools. The terminal's `gemini` doesn't get these tools.

## Home

**Home** opens in front of your restored tabs every time GeminiCode starts. Under the **Start Agent** composer and quick actions, cards follow:

- **Agents.**
- **My tickets**: every open ticket assigned to you. The current sprint's come first, under the sprint's name with how many are done, then the rest under **Not in this sprint**. With several Jira sites, each site has its own group. Each has **Start**, and in its menu **Add Comment…**, **Log Time…**, **Move…** and **Reassign…**.
- **Merge requests**: **Pending on me** (asked to review, or assigned to finish) and **Mine**, each with its pipeline and approvals; one that can merge shows **Merge…**. Reviews you started come first, then those where you are the only reviewer, then the longest waiting; one the author must fix first, with conflicts or a failing pipeline, goes after them, and drafts and reviews you already gave go last. One of yours with unresolved threads says so, with **Reply**.
- **Quality** on the release branch: the SonarQube gate and Snyk, with **Fix**.
- **Gemini.**

**Unfinished** appears only after GeminiCode quit while something was running: a flow tab (Move, Open Merge Request, Review) to **Reopen** from the same inputs or **Discard**, and a write whose result never came back, to check in the tool before doing it again (**Mark as Checked** once you have). Nothing is redone on its own. A chat whose agent was working when the app quit says so under the last message.

A card shows its first few items. When it has more, **Show All** opens the whole list in a popup, with a filter for long lists: click an item to open it, as on the card. In the merge requests' popup each row also names its repository after the `!number` (point at it for the full `group/repo` path), and the filter matches it, so merge requests with the same title in different repositories stay apart. A ticket or merge request opens in your browser and leaves the list open; an agent opens in its tab.

**Customize** hides and reorders cards and picks the release branch. Home shows the last data at once and refreshes each tool in the background; with the VPN off, VPN-only cards keep their last results, dimmed, with their time. One banner per server says so, such as "GitLab is unreachable, probably the VPN. Showing results from 10:42.", with **Retry**, and it clears by itself once the server answers. When a server refuses your token, a banner says so, such as "Jira rejected your token.", with **Replace Token...**, which opens Connections. Turn off opening it at start-up with `gemini.home.openOnStartup`; <kbd>⇧⌘H</kbd> or **Gemini: Home** brings it back.

## In chat

Paste a Jira key or link, a GitLab merge request or issue link, a Figma link with a node, or a Confluence page link, and it becomes a chip with the tool's logo; sending attaches the ticket, merge request or page, or a hint to read the design. Click a chip, in the composer or in a message you sent, to open its ticket, merge request or frame. **From your tools** in the **+** menu picks a ticket or merge request, or takes a Confluence page's link. Tool calls show the tool's logo and what they did, such as "Read ACME-412".

**Figma Design...**, under **From your tools**, opens **Add Figma Design**: a frame link for each screen size, as designers lay a design's sizes out side by side. Paste several links at once and they fill the rows in order; **Add Size** adds a row. The design becomes one chip, and clicking it opens the dialog again to change the sizes. Figma reads one open file at a time, so a frame from another file makes the agent ask you to switch files when it gets there.

## Your design system

When your team's design system is a Figma file of its own, GeminiCode can read it once into the repository, so agents build every design with your tokens and components and nobody has to share the design system again.

Name the file in the team defaults:

```json
{
  "figma": {
    "designSystem": {
      "name": "Acme DS",
      "file": "https://www.figma.com/design/AbC123/Acme-DS",
      "pages": ["Foundations", "Components"],
      "tokens": "src/styles/tokens.css",
      "codeConnect": true
    }
  }
}
```

Then open the design-system file in the Figma desktop app and run **Sync Design System** on Figma's row in Connections (or **Gemini: Sync Design System** from the Command Palette, with `gemini.developer.showTools` on). Until the team file names one, **Add Figma Design** offers **Set Up Your Design System**, which says what to add. GeminiCode reads each page you named (every visible page when `pages` is left out, as long as the file has no more than eight; Figma limits how many reads its Dev Mode server answers a day, so a larger file has to name its pages), says what changed since the last sync, such as "4 new tokens, 1 component removed", and offers **Review Changes**, which shows each file's diff, and **Write Files**. It writes:

- a skill in `.gemini/skills/design-system/` (or the folder `skill` names), with the rules for using the design system;
- `references/tokens.md`, every variable with its value, and `references/components.md`, every component with its variants;
- the tokens as CSS custom properties, when `tokens` names a file.

Commit them like any other change. Syncing again keeps the rules you wrote in the skill's **Rules** section.

Once the skill is there, a prompt with a Figma design asks the agent to load it and build with its tokens and components. Colours in the design that are tokens come to the agent with their names, such as `#2F5BD3 (color/brand/primary)`. `codeConnect` turns Code Connect on for this repository; it is off unless the file says so.

Figma gives each variable's value in the mode the file shows, and only the variables a page uses, so sync the pages that show the whole design system, such as its foundations.

## From ticket to merge request

A ticket's whole journey can happen in GeminiCode:

1. **Start an agent on the ticket.** **Start** on Home, or **Gemini: Start Agent on Jira Ticket**, starts an agent on its own branch named after the ticket. It reads the ticket and plans first, and offers to move the ticket to In Progress.
2. **Run the checks.** **Run Checks** runs Snyk on the dependencies and code, and lists SonarQube's issues in new code on the agent's branch. Each finding has **Fix**, and **Fix All with This Agent** hands them all over. When SonarQube has more issues than the page lists, the row says so, such as "50 of 312 issues shown", with **Open in SonarQube** for the rest.
3. **Open the merge request.** **Open Merge Request**, beside Merge back in Changes, pushes the branch and opens the merge request.
4. **Fix what comes back.** The merge request panel in Changes shows the pipeline, the quality gate and open review threads. **Fix Pipeline and N Comments** sends them to the agent on the merge request's branch, in a clone of the same project. The agent commits its fix; when its turn ends, GeminiCode pushes the commits (an agent's shell can't sign in to GitLab) and asks it to reply to each thread. Without an agent on the branch, Fix starts one: where the branch is checked out already, in that checkout; otherwise in a worktree of its own. Fix never resets your branch: when your local copy has commits that aren't pushed, it says how many and stops.
5. **Merge.** **Merge…** turns on when every one of GitLab's checks passes.

### Checks on any branch

**Run Checks on a Branch…**, on Home or under **Gemini: Jira and GitLab Actions...** in the Command Palette, runs the same checks on any branch before a merge request exists: the branch checked out here, an agent's, a local one or one on origin. In a window with several folders it works in the repository of the agent in front, else of the active editor; when neither says which, it asks, with the agent last in front first, then each folder. Start on Ticket and Move's team defaults pick their folder the same way. A window with one folder never asks.

A branch that isn't checked out gets a checkout of its own under `~/.geminicode/worktrees/<repository>/checks/`, with your `gemini.agents.worktreeSetup` command, or the repository's own setup script once you allow it, run in it once. Later runs reuse it, and your own checkout never moves. SonarQube's gate comes from the server's last analysis of the branch, so it needs one push first. With no agent on the branch, **Fix** starts one in that checkout, with the findings as its first prompt.

### The Open Merge Request page

**Merge into** is a searchable menu of the repository's branches, in four groups: **Suggested** (the release branch that matches the ticket's fix version, or the project's default), **Recently used here**, **Release branches** and **Other branches**. A target that is a feature branch, rather than `main`, `develop` or a release, is flagged with how many commits and files it is behind.

Below it are the title, a description Gemini drafts against that target for you to edit (pick another target and it offers to write it again), the files to attach (up to 100 MB each, GitLab's own limit), reviewers, and the draft and delete-branch options. Opening the merge request commits what isn't committed, pushes the branch, and then offers to move the ticket. While the agent is in the middle of a turn it waits: pushing then would push half its edits.

A push, a fetch and other git commands that talk to the server give up after a minute, and say "Check your VPN" or "Sign in with git once in a terminal" for the usual problems.

An agent that is reviewing someone else's merge request works on a local copy of that branch, so its Open Merge Request button points to the merge request under review instead.

### The merge request panel

The panel in Changes shows the pipeline, with **Fix** on each failed job, the SonarQube gate, Snyk and the open review threads.

It also lists the checks GitLab applies before a merge, read live: the merge request is open and not a draft, the pipeline, each approval rule by name with who approved, resolved threads, no conflicts, and GitLab's own verdict. A check GitLab didn't answer for counts as pending ("couldn't read, counted as pending"), never as passed, with **Retry** to read it again; the review page's Approvals row and the merge dialog say the same. **Merge…** is on only when every line holds.

Merge asks once more, naming the commit it read and whether the commits are squashed and the branch deleted, as the project's settings say. GitLab checks again as it merges, so if someone pushes in between, GitLab refuses rather than merging something you didn't see. Afterwards it offers to move the ticket.

**Gemini: Merge Merge Request…** does the same for the agent in front, and so does **Merge…** on Home for a merge request listed as ready.

### Move, reassign and log time

- **Move Ticket** shows the moves your Jira workflow allows, any field a move needs, and a comment Gemini drafts for you to edit. With **Log time** ticked as well, a failure in one step says which went through; pressing again does only the step that's left.
- **Log Time** records time spent, such as "1h 30m", on its own or with a move.
- **Reassign…**, on Home or with **Gemini: Reassign Jira Ticket…**, lists the people Jira lets take the ticket, plus you and nobody.

## Comment on a ticket

**Add Comment…** on a ticket (in its menu on Home) opens a comment box over Home, and the comment is posted to Jira as you, with Jira's own formatting:

- Write in Markdown, or use the toolbar: bold, italic, strikethrough, code, links, bulleted, numbered and task lists, quotes, info panels (`> [!NOTE]`), code blocks, tables and dividers. **Preview** shows it as Jira will.
- Type `@` to mention someone who can see the ticket; Jira notifies them.
- Paste or drop files, or use **Attach Files**. They are uploaded to the ticket and linked from the comment.
- **Who can see this comment in Jira** limits it to one of the project's roles or one of your groups. With `jira.commentVisibility` set in the team defaults, that role is picked for you.

What you wrote stays in the box until Home closes, so closing it by mistake loses nothing. Agents' comments, and the comment a move posts, are plain text.

## Draft Confluence pages

Agents search Confluence and read the pages a ticket links to (`confluence_search`, `confluence_get_page`). Ask an agent to write a page, or a new version of one, and it drafts it (`confluence_draft_page`). The draft stays on your Mac and opens in the **Review Page**, in the agent's side group when its tab is in front. Nothing reaches Confluence until you publish it. **Gemini: Confluence Drafts** lists the drafts waiting for review and opens one.

![The Review Page with an agent's changes to a Confluence page marked, each with Keep and Undo](../../site/media/confluence-review-dark.webp)

A new version of a page opens on the page as it is in Confluence now, with the agent's changes marked. **Page as It Is Now**, **With Changes Marked** and **Changes Only** switch the view, and **Edit** edits the page as it will look, with a toolbar for headings, lists, links and inline styles.

- **Keep** or **Undo** each change, or **Keep All** and **Undo All**. Every change needs one before you publish.
- What Markdown can't write, such as mentions, macros, tables, images and files, inline comments, status lozenges and panels, is kept as it is on the page. When the agent's draft removed or rewrote a part that holds such things, the page keeps that part and shows the agent's version under it, with **Keep the Page's Version** and **Use the Agent's Version**.
- **Publish Changes** publishes a new version: the page as it is now, with only the changes you kept and your own edits. A new page has **Publish to Confluence** instead.
- When someone saved the page after the draft was made, nothing is published. The page combines your draft with the latest version, keeping each side's change where only one side changed a part, and asks **Keep Theirs** or **Keep Mine** only where you both changed the same part.

**Save Draft** keeps your edits for later, and **Discard Draft** deletes the draft and your edits. Publishing is recorded in the [audit log](#audit-log), as you; **Open in Confluence** opens the page once it is published.

## Review a merge request

**Review** on a merge request waiting for you (on Home, or **A Merge Request** under **Gemini: Review...**) starts a reviewer agent in a checkout of its own, which reads the merge request against its ticket. The reviewer's team tools only read: it can't comment, move a ticket or merge, since you choose what to post. Reviewing the same merge request again, after its author pushes or with **Start a New Review…**, reuses the reviewer and its worktree, moved to the new commits. A merge request with more than 100 changed files is read whole, up to 1,000. Its findings become the first comments of your review, each marked **Bug**, **Should fix**, **Question** or **Nit**. Your review is a draft: nothing reaches GitLab until you post it. Your own checkout is never changed.

A review checks the branch out from your clone of the repository. GeminiCode looks for one in the clone it remembers for the project, the window's folders, the folders agents have used and your recent folders, and remembers what it finds. When there is none, it asks **Where is your copy of** the project: **Choose Folder...** picks a clone, and **Clone It...** clones the repository, over HTTPS or SSH when GitLab offers both, into a folder you pick, in a terminal where you answer git's questions. **Fix Pipeline and N Comments** asks the same way.

The reviewer's checkout is in `~/.geminicode/reviews`, which the Gemini CLI never trusts, so nothing in the merge request (its Gemini settings, hooks or MCP servers) runs on your Mac. It also means the reviewer can't call the index tools, so when your clone's index is built, the prompt lists what the index knows around each changed file: its tests, the files that use it and the files usually changed with it. The merge request's description and the ticket's text go in the reviewer's first prompt instead, and GeminiCode answers its read-only `git status`, `diff`, `log` and `show` itself.

The **Review** page lists the merge request's files, its threads and your draft.

- **Your review.** Tick the comments to post, edit or delete any of them, and **Add Comment** for a general one. The page counts what is ticked: Gemini's, yours and replies in threads.
- **Comments in the diff.** **Open in Diff** opens a file at the two commits GitLab compares, read from your clone. Gemini's comments sit on their lines, and the **+** in the gutter adds your own, on one line or on the lines you select. **Edit**, **Delete** and **Save** work in place. The page and the diff show the same draft, and the page can stay open beside the diff.
- **Threads.** The merge request's GitLab threads show on their lines and under **Threads** on the page, open and resolved. **Reply**, **Resolve** and **Add Reply and Resolve** go into your draft and are posted with it. Gemini reads the open threads too, and can draft a reply for you to edit.
- **Suggested changes.** Any line comment can carry a suggestion that the author applies in GitLab with one click. Write it with **Add Suggestion** (**Suggest Change** in the diff), keep the one Gemini wrote with its finding, or press **Ask Gemini to Suggest**.

When you are done, **Post N Comments**, **Post N Comments and Approve** or **Post N Comments and Request Changes** posts the ticked comments as you, on their lines, against the version you reviewed. **Approve** on its own approves without comments. Afterwards the page says the reviewer agent and its checkout are still on your Mac: **Remove Reviewer and Checkout** removes both, and **Keep for Re-review** leaves them, so the next review of that merge request reuses the checkout. **Discard Draft…** offers the same. Reviewers' checkouts of reviews that ended also show in Settings' **Clean Up**.

The draft is saved as it changes, so closing the page or quitting GeminiCode loses nothing. **Continue Review** on Home, the **Review !N** chip in the reviewer's chat and **Gemini: Open Merge Request Review** (reviews in progress, the last changed first) open it again where you left it. **Ask Gemini Again** reviews the merge request once more and replaces Gemini's comments you haven't touched; yours, and Gemini's that you edited, stay. **Start a New Review…** starts over without the draft, and **Discard Draft…** throws it away. A draft nobody opens for two weeks is removed.

When the source branch gets new commits during a review, the page says so. **Refresh** reads the new version and moves each comment to its line there; a comment whose line changed is marked **Line changed** and unticked, so you check it before it is posted.

The page shortens long paths and tells apart files with the same name, such as two `index.ts`.

Clicking a merge request opens it in GeminiCode's browser; `gemini.team.openMergeRequestsIn` makes it your default browser instead, and **Open in GitLab** in a card's menu always uses the default browser.

## Audit log

Every write GeminiCode makes to Jira, Confluence or GitLab for you is recorded on your Mac, whether an agent asked for it or you pressed a button: a comment, a move, a time log, a reassignment, a published page, a merge request, a review comment, an approval, a merge. With several Jira or Confluence sites, the record names the site. Each write gets two lines in a file per day under GeminiCode's storage, one before the call and one after, with what the tool gave back (a comment id, a worklog id, `!321`, the merge commit). The lines hold what changed and where, not the text; the text is in the chat.

**Gemini: Open Audit Log** (also in the **Gemini** status bar item's menu; its tooltip counts today's actions and any left unfinished) shows the log as a page: one row per write with the time, who asked (an agent or a button of yours), the action, its effect, how you answered, the id the tool gave back and the state. Pick a day, a tool, or only the intents without a result. A row with no result is a write that was running when GeminiCode last quit; it is highlighted, and Home lists it under **Unfinished**. Check the tool before doing it again, then **Mark as Checked**. **Export the Day…** writes the day as Markdown to your home folder, and **Open Folder** shows the files.

## Your team's own servers

Some teams already run Jira and GitLab MCP servers (mcp-atlassian and gitlab-mcp) from the repository's `.gemini/settings.json`. When yours does, Connections shows a card for them, with **Take Over Both Servers...**. It:

1. moves the servers' tokens into the keychain
2. removes the two servers from the settings file
3. runs the same servers in Docker, at pinned versions, behind GeminiCode's team tools

Agents then see one set of Jira and GitLab tools, and an agent's shell can't read the tokens. The settings file is shared, so commit the change, or ask whoever owns the file. Without Docker, the team tools call Jira and GitLab directly.

The same setting, **Gemini › Team: Run Team Servers** (`gemini.team.runTeamServers`), also runs SonarQube's own server in Docker and Snyk's own server from your Snyk CLI. With SonarQube's server running, **Checks** adds a row that analyses the files your branch changed, on your Mac, before you push.

## What agents get

Every agent session gets a `geminicode-tools` MCP server. It lists no tools until the agent's task needs them, since their definitions were about half of every model call on a team repository: a ticket, merge request, page or design in a message or an attachment, a flow such as a review, or **Use team tools** in the composer's + menu turns them on for that agent, for good, and a running chat gets them without a restart. The tools are only for the tools you connected, such as `jira_get_issue`, `confluence_get_page`, `gitlab_get_mr`, `gitlab_job_log`, `sonar_quality_gate`, `snyk_test` and `figma_design`. Reading runs without asking, except Snyk's tests: `snyk_test` runs your project's build tools to resolve its dependencies and `snyk_code_test` uploads your source to Snyk, so each shows a permission card, and both are off while your admin has shell commands turned off. Home's Snyk card refreshes on its own only in a folder that both GeminiCode and the Gemini CLI trust, while shell commands are allowed; elsewhere it shows results once Snyk has run from a chat. A Jira comment, a reassignment and a comment on a merge request show you a permission card with the exact text first, and you can allow the rest of the session.

Four actions are harder to take back, so they ask every time, with Allow once and Reject only: moving a ticket (`jira_transition`), logging time (`jira_log_time`), opening a merge request (`gitlab_create_mr`) and merging one (`gitlab_merge`, which needs the merge request named). The same goes for the matching tools of a `jira` or `gitlab` MCP server your team runs beside GeminiCode. `gitlab_merge` reads GitLab's own checks first (pipeline, approval rules, threads, conflicts, GitLab's mergeable verdict) and refuses when any fails, saying which; when it merges, it names the commit it read, so a push in between makes GitLab refuse rather than merge something else.

`figma_design` reads a large frame a section at a time, so no single answer is cut short, and names the parts not read yet for the agent to ask for next. A read Figma gives up on comes back as the frame's outline and design variables. A frame read in the last ten minutes is answered from memory. Figma's Code Connect lookups are off unless the repository's `.gemini/geminicode-tools.json` sets `codeConnect`, since Figma answers faster without them.

Text an agent reads from a ticket, a page, a merge request, a job log or a design comes wrapped in an `<external>` tag, and the server tells the model to read it as information from other people, never as instructions. The prompts Fix and Review write wrap the job logs, review threads and merge request titles they quote the same way.

When a write has two steps and only the second fails, such as a reply whose thread then wasn't resolved, it reports the first as done with the failure beside it, so trying again doesn't post twice. A line comment becomes a general comment only when GitLab says the line isn't in the diff. A list cut to its first page says so, such as "50 of 312".
