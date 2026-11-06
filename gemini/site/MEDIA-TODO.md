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
| 2026-11-06 | The demo repositories `acme-checkout` and `billing-api`, and a demo Jira (two sites), Confluence, GitLab and SonarQube signed in as Sam Rivera, in a dev build of `main` at 411fd00c87d, with agents on gemini-3.1-pro-preview | Everything, including the link preview images in `og/` |

The clips' dates are also in `clipDates` in `build.mts`, which the site's video data uses. Keep the two in step.

## Not yet pictured anywhere

Nothing at the moment.

## Notes for the next capture

- Home's **Gemini** card shows the Cloud project ID and the app's version. A local build reports a `0.0.0-dev` version, so shots of Home and the Settings page need both replaced with demo values before they are taken.
- The demo repositories' git identity is Sam Rivera, and their history must not carry a real name: the status bar's blame and the Source Control graph show it. Turn commit signing off in them, or agents' commits fail.
- GeminiCode opens the Changes panel by itself whenever an agent edits a file. Close it before each shot that isn't about changes, and keep closing it while a clip records.
- Agents wander. Approve only commands inside the demo repositories, and reject anything that reads the capture profile, log files or folders outside the repository.
- Closing every editor while an agent's browser group is open can leave the editor area's group at zero size, so the chat draws in a corner. **View: Single Column Editor Layout** puts it back.
- Record clips with the window right of the Dock (it sits on the left): x 96, 1960 × 1225 points. A screen recording picks up the Dock over the window; window stills don't.
- Turn off `gemini.chat.reactions.enabled` in the capture profile, except for shots of reactions. Agents otherwise start a later message with `<react>X</react>`, which shows as text. The setting also hides the reaction button and chips.
- Park the pointer over the empty sidebar, not the status bar, whose items show a hover card.
- The Settings page lists the Mac's trusted folders below Rules; keep the shot above them.
- If the Mac locks during a capture, the window can't take focus: its traffic lights turn grey, keys and typing must go through the debugger, and screen recording shows the lock screen. The 2026-10-28 clips were recorded as `capturePage` frames of the window, with the (grey) traffic lights laid over from a still of the same window, since `capturePage` leaves them out. Keep the display awake (`caffeinate -d`) to avoid this.
- A chat that isn't in front stops updating while the window is hidden, so bring an agent's tab forward before reading its state.
- Give the capture profile's terminal a neutral prompt (`terminal.integrated.env.osx` with `ZDOTDIR` pointing at a `.zshrc` that sets `PROMPT='%1~ %# '`), or the agent's terminal shows the Mac's user and host name.
- Plan mode replies can print the plan file's full path; ask for the plan only. A coordinator's failed `list_directory` calls show home-folder paths while it works; cut that stretch from a clip.
- Project settings' **Add repository** opens the native folder picker, which the capture scripts can't drive. Add the second repository to `~/.geminicode/projects/<id>/project.json` instead and reload the window; the app keeps the project in memory until then.
- With a Pro model, Plan mode ends by asking for plan approval through the Gemini CLI's own permission card, whose text holds the plan file's full path under the home folder. Ask the agent to end its turn once the plan is written, so the reply ends with **Approve Plan** and **Review Plan**, and rewrite the home folder to `~` in the webviews while recording.
- The rich Markdown editor keeps its own selection: select text for a comment with the keyboard (Shift and the arrow keys), not a scripted selection. It also reads `$5 … $20` as inline math, so keep dollar amounts out of a report you comment on.
- A merge request review in a checkout without `node_modules` can sit on `npx tsc`; reject commands other than the reviewer's git reads.
- The Index & Docs page shows documentation sources shared with every folder on the Mac. Don't remove one to tidy a shot.

The link preview images in `media/og/` (1200 × 630 JPEG) are crops of the light shots named in `ogImages` in `build.mts`. Remake one when its shot is retaken; [RELEASING.md](../docs/RELEASING.md#search-engines-link-previews-and-ai-tools) has the command.
