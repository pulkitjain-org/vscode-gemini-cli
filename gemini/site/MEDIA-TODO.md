# Site media

This file records where the screenshots and clips in `gemini/site/media/` came from, and what is still not pictured.

## How the media are made

Every screenshot and clip comes from the real app, except `showcase-console-*`, which is kept from an earlier build by choice.

- Each was taken in GeminiCode Dark and GeminiCode Light, with the window filling the built-in display at 2x, and exported at 2000 × 1250.
- Each product shot has a `-dark.webp` and a `-light.webp` copy, and the site shows the one that matches the page's theme.
- Every screenshot and clip also has a 1000-pixel-wide copy (`<name>-<theme>-1000.webp`), which phones get instead. Make one for each new or retaken shot ([RELEASING.md](../docs/RELEASING.md#screenshots-and-clips) has the command).
- A shot that is missing leaves a labelled placeholder frame on the page.

Capture from the real app, against demo data, so no real account, ticket, name or path shows. Never redraw a shot, and never reuse one from this folder for a different purpose.

## When each was taken

| Taken on | Against | Media |
| --- | --- | --- |
| 2026-10-28 | The demo repositories, and a demo Jira (two sites), Confluence, GitLab and SonarQube signed in as Sam Rivera, in a build of `feature/folder-own-agent-settings` (7a78aa0efd1) ahead of 1.6.1 | New: `agent-links` (the column beside an agent's chat: where it works, Changes with its line counts, Browser, Terminal, Files), `agent-files` (the Files page), `agent-files-beside` (a file open with the Files page as a narrow tree) and `prompt-outline` (the outline at the chat's left edge with a tick's card). Retaken for the column, the outline on the left and terminals beside the chat: `agents-pane`, `replies`, `reactions`, `run-command`, `queue`, `compact-line`, `enhance-before`, `enhance-after`, `fork-dialog`, `fork-list`, `docs/folded-turn` and `docs/plus-menu`, and the `showcase-work`, `showcase-wait`, `showcase-plan`, `showcase-plan-review` and `showcase-enhance` clips. Retaken for 1.6's thread cards: `project-chat`, `project-threads`, `project-merge`, `project-new-thread`, `docs/project-settings`, `docs/project-memory` and the `showcase-projects` clip (and `og/projects.jpg`). Retaken for Agent Setup's new measuring note: `docs/project-helpers` |
| 2026-10-27 | The demo repository and a demo Jira (two sites), GitLab and SonarQube signed in as Sam Rivera, in the installed GeminiCode 1.6.0 | The `showcase-work` clip (a Jira ticket's task typed on Home, the agent at work, and Keep in the Changes panel) and its Home poster, and `docs/project-helpers` (Agent Setup) |
| 2026-10-27 | The demo repository, in the installed GeminiCode 1.6.0 | `agents-pane` (the Agents pane with agents working, waiting, finished and idle, and a fork), `fork-list` (a fork under its agent, with its card in the agent's chat), `try-scm` (an agent's changes tried in the workspace, with **T** in Source Control and Trying in the status bar), `enhance-before` and `enhance-after` (a draft, and the prompt Enhance wrote from it, with Revert) |
| 2026-10-27 | The demo repository, and a demo Jira (two sites), Confluence, GitLab and SonarQube signed in as Sam Rivera | `plan-review` and the `showcase-plan-review` clip (Plan Review with comments, sent and revised), `try-workspace` (a project thread tried in the workspace), `confluence-review` (a Confluence draft on the Review Page), and `home` retaken for the Here / On Its Own Branch / To a Project chooser and both Jira sites |
| 2026-10-25 | The demo repository | `reactions` (the reaction bar on a reply) and `run-command` (a reply's shell block with Run and its result), both for the Chat and review feature page |
| 2026-10-23 | The demo repository | `fork-dialog`, `queue`, `compact-line` |
| 2026-10-23 | A demo Jira, GitLab and SonarQube with made-up people and tickets, signed in as the demo's Sam Rivera | The feature pages' shots `index-page`, `files`, `docs/plus-menu`, `mr-review-diff` and `jira-comment`, and the `showcase-work` and `showcase-mr-review` clips |
| 2026-10-19 | | Everything else |

The clips' dates are also in `clipDates` in `build.mts`, which the site's video data uses. Keep the two in step.

## Not yet pictured anywhere

Nothing at the moment.

## Needs retaking for 1.7

The 1.7 release renames and moves what these show, so each is retaken from the 1.7 dev build before the site is rebuilt:

- `docs/plus-menu` (Chat guide): the model menu ends in **Set as Default for the CLI**.
- `compact-line` (Chat guide): the line reads **Compressed**, and the command is `/compress`.
- The `showcase-plan` clip and `docs/plan-review` (Chat guide, feature pages): **Build This Plan** is **Approve Plan**, with the CLI's four answers on its chevron.
- Every Home shot (`showcase-work` poster, the Home shots in the Agents guide and the landing page): the chooser is **Here** / **On a Branch** with a chevron, the quick actions are New Agent, Review and Run Checks, there is no Index button, and the tool logos are one line.
- `agents-pane` (Agents guide): rows say "needs you", "done", "kept" and "merged", not "waiting" and "idle".
- `docs/project-helpers`, `index-page` and the Connections shot (Agent Setup, Agents and Team tools guides): Agent Setup has a tab strip (Loads, Index & Docs, Connections, Storage & Audit), with Storage on the Storage & Audit tab.
- Any shot with the status bar: one **Gemini** item carries the team tools, the index and the audit count.
- `fork-list`, `try-scm` and `try-workspace` (Agents guide): the Try button carries a chevron.
- The side question shot, if one is taken: **Read the code too** beside **Ask**.

## Checked and kept

These show a page or diff beside an agent's chat. With a side group open the chat is narrower than the column needs, so it shows no column, and they have one prompt each, so no outline: `files`, `browser-page`, `confluence-review`, `plan-review`, `mr-review-diff`, `try-workspace`, and the `showcase-notes` and `showcase-mr-review` clips. `home`, `index-page`, `jira-comment`, `try-scm` and `showcase-review` show no agent chat.

## Notes for the next capture

- Record clips with the window right of the Dock (it sits on the left): x 96, 1960 × 1225 points. A screen recording picks up the Dock over the window; window stills don't.
- Turn off `gemini.chat.reactions.enabled` in the capture profile, except for shots of reactions. Agents otherwise start a later message with `<react>X</react>`, which shows as text. The setting also hides the reaction button and chips.
- Park the pointer over the empty sidebar, not the status bar, whose items show a hover card.
- Agent Setup lists the Mac's trusted folders below Rules; keep the shot above them.
- If the Mac locks during a capture, the window can't take focus: its traffic lights turn grey, keys and typing must go through the debugger, and screen recording shows the lock screen. The 2026-10-28 clips were recorded as `capturePage` frames of the window, with the (grey) traffic lights laid over from a still of the same window, since `capturePage` leaves them out. Keep the display awake (`caffeinate -d`) to avoid this.
- A chat that isn't in front stops updating while the window is hidden, so bring an agent's tab forward before reading its state.
- Give the capture profile's terminal a neutral prompt (`terminal.integrated.env.osx` with `ZDOTDIR` pointing at a `.zshrc` that sets `PROMPT='%1~ %# '`), or the agent's terminal shows the Mac's user and host name.
- Plan mode replies can print the plan file's full path; ask for the plan only. A coordinator's failed `list_directory` calls show home-folder paths while it works; cut that stretch from a clip.
- Project settings' **Add repository** opens the native folder picker: add the second repository before the screen can lock.

The link preview images in `media/og/` (1200 × 630 JPEG) are crops of the light shots named in `ogImages` in `build.mts`. Remake one when its shot is retaken; [RELEASING.md](../docs/RELEASING.md#search-engines-link-previews-and-ai-tools) has the command.
