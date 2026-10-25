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
| 2026-10-25 | The demo repository | `reactions` (the reaction bar on a reply) and `run-command` (a reply's shell block with Run and its result), both for the Chat and review feature page |
| 2026-10-23 | The demo repository | `fork-dialog`, `queue`, `compact-line` |
| 2026-10-23 | A demo Jira, GitLab and SonarQube with made-up people and tickets, signed in as the demo's Sam Rivera | The feature pages' shots `home`, `index-page`, `files`, `docs/plus-menu`, `mr-review-diff` and `jira-comment`, and the `showcase-work` and `showcase-mr-review` clips |
| 2026-10-19 | | Everything else |

The clips' dates are also in `clipDates` in `build.mts`, which the site's video data uses. Keep the two in step.

## Not yet pictured anywhere

- The Agents pane with five agents in different states, for the landing page's Agents section ("Agents side by side" tile).
- Enhance prompt before and after, as a still. The `showcase-enhance` clip shows it.
- Forks listed under their agent, with the fork card in its chat. On the Agents feature page, "Fork an agent" shows only the Fork dialog.

The link preview images in `media/og/` (1200 × 630 JPEG) are crops of the light shots named in `ogImages` in `build.mts`. Remake one when its shot is retaken; [RELEASING.md](../docs/RELEASING.md#search-engines-link-previews-and-ai-tools) has the command.
