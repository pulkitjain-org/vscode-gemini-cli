# Site media

This file records where the screenshots and clips in `gemini/site/media/` came from, and what is still not pictured.

## How the media are made

Every screenshot and clip comes from the real app, except `showcase-console-*`, which is kept from an earlier build by choice.

- Each was taken in GeminiCode Dark and GeminiCode Light, with the window filling the built-in display at 2x, and exported at 2000 × 1250.
- Each product shot has a `-dark.webp` and a `-light.webp` copy, and the site shows the one that matches the page's theme.
- Every screenshot and clip still also has a 1000-pixel-wide copy (`<name>-<theme>-1000.webp`), which phones get instead. Make one for each new or retaken shot ([RELEASING.md](../docs/RELEASING.md#screenshots-and-clips) has the command).
- A shot that is missing leaves a labelled placeholder frame on the page.

Capture from the real app, against demo data, so no real account, ticket, name or path shows. Never redraw a shot, and never reuse one from this folder for a different purpose.

## When each was taken

| Taken on | Against | Media |
| --- | --- | --- |
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

## Needs retaking for 1.6

These show the app before 1.6 and are still on the site:

- `project-threads` (landing page, Projects): thread cards with **Merge back** and a side panel saying "1 merged back". 1.6 offers **Try in Workspace**, and the side panel counts each thread's requests.
- `project-merge` (Projects guide): a finished thread card with **Merge back**, **Review changes** and **Undo thread**. Retake it with the 1.6 card, and change its alt text in `gemini/docs/guide/projects.md`.
- The `showcase-projects` clip (Projects guide and feature page): ends on a **Merge back** card.
- The `showcase-plan` clip (Chat guide and feature page): the reply ends with only **Build This Plan**. 1.6 adds **Review Plan** beside it, and Build This Plan has a ⌄.

Possibly out of date, to check when retaking the ones above: `project-chat` (no request counts in the side panel), the `showcase-wait` clip's permission card, and `docs/project-settings` and `docs/project-memory`.

### For the next capture

- Record clips with the window right of the Dock (it sits on the left): x 96, 1960 × 1225 points. A screen recording picks up the Dock over the window; window stills don't.
- Turn off `gemini.chat.reactions.agentReactions` in the capture profile. Agents otherwise start a later message with `<react>X</react>`, which shows as text.
- Park the pointer over the empty sidebar, not the status bar, whose items show a hover card.
- Agent Setup lists the Mac's trusted folders below Rules; keep the shot above them.

The link preview images in `media/og/` (1200 × 630 JPEG) are crops of the light shots named in `ogImages` in `build.mts`. Remake one when its shot is retaken; [RELEASING.md](../docs/RELEASING.md#search-engines-link-previews-and-ai-tools) has the command.
