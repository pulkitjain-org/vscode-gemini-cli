# Capturing the site's screenshots and clips

Every screenshot and clip on the site comes from the real app, running on a Mac against a demo: two small repositories, and a stand-in Jira, GitLab and SonarQube with made-up people and tickets. No real account, ticket, name or path reaches the public site.

The files here:

- `setup-demo.sh` creates the demo repositories, the workspace and a clean GeminiCode profile.
- `demo-tools.mts` is the demo Jira (port 8781), GitLab (8782) and SonarQube (8783). It answers the calls GeminiCode's connectors make and serves the repositories over git, so fetching, pushing and opening a merge request all work.
- `shots.sh` sizes the window, switches the theme, takes shots and records clips, and exports them in the site's format.

## Set up once

You need git, node, npm, python3, and `brew install webp ffmpeg` for the export.

1. From the repository root, create the demo:

   ```sh
   bash gemini/site/demo/setup-demo.sh
   ```

   It goes in `/Users/Shared/geminicode-shots` (set `DEMO_ROOT` to change it), a path without your user name. `--reset` deletes it and starts again, keeping shots.

2. In a terminal of its own, start the demo tools and leave them running:

   ```sh
   bash gemini/site/demo/shots.sh tools
   ```

3. In another, start the app on the demo workspace and profile, then size the window to 1440 × 900 points:

   ```sh
   bash gemini/site/demo/shots.sh launch-dev   # the dev build of this checkout
   bash gemini/site/demo/shots.sh size
   ```

   `launch-app` does the same with `/Applications/GeminiCode.app`. The first `size` asks to let Terminal control the computer and record the screen: allow both in **System Settings › Privacy & Security**.

4. In GeminiCode, open **Connections** and connect each tool. The addresses are already filled in from the demo repositories' `.gemini/geminicode-tools.json`; paste any text as the token, and any email for Jira. You are signed in as Sam Rivera.

5. When a shot needs the cart page, serve it: `python3 -m http.server 5173 -d /Users/Shared/geminicode-shots/acme-checkout/web`.

Sign in to Gemini with an account whose name you are happy to show, or keep the account menu out of frame.

## What's in the demo

| Item | State |
| --- | --- |
| ACME-412, Retry invoice uploads with backoff | Sam's !412 in billing-api: approved, pipeline passed, ready to merge |
| ACME-418, Cart totals show fractions of a cent | Priya's !418 in acme-checkout, waiting for Sam's review |
| ACME-421, Apply TAKE5 before SAVE10 | Sam's !421: the pipeline failed on one test, `test/discount.test.ts:11` |
| ACME-409, Invoice PDF footer is cut off | Mei's draft !409, asking Sam to review |
| ACME-424, ACME-427, ACME-405 | Tickets to start agents from |

Release branches `release/1.4`, `release/1.5` and `release/2.3` fill the merge request's "Merge into" menu.

## Taking a shot or a clip

- `bash shots.sh pair <name>` waits five seconds for you to switch to GeminiCode, then saves the window in dark and light: `<name>-dark.png` and `<name>-light.png`.
- `bash shots.sh record <name>-dark <seconds>` records the window; switch the theme with `shots.sh theme light` and record `<name>-light` the same way. Keep a finished clip to about 30 seconds and move the pointer slowly.
- `bash shots.sh export` turns every shot into the site's 2000 × 1250 `.webp`, and every clip into an `.mp4` with a `.webp` poster.

Files go to `/Users/Shared/geminicode-shots/shots`. Copy the exported files into `gemini/site/media/` (or `media/docs/` for the docs' images) under the names below, then build the site with `node gemini/site/build.mts /tmp/site --sample`; it lists any media still missing.

## The capture list

Each item is a pair, dark and light. Clips are marked.

| Name | Where it shows | What to show |
| --- | --- | --- |
| `home` | Connected tools page | Home connected to the demo: Needs you with the failed !421 pipeline, !412 ready to merge and Priya's review request, My tickets by sprint, and Merge requests with pipelines and approvals. |
| `index-page` | Agents page | The Index page: both workspaces indexed, one documentation source attached (the TypeScript handbook), and Vitest suggested from the dependencies below it. |
| `showcase-work` (clip) | Landing page, Agents page | ACME-424 typed into Home's composer with **On its own branch** off, the agent working in YOLO, Changes filling in, and Keep. Also export a 1000-wide copy of the poster: `cwebp -resize 1000 625`. |
| `files` | Landing page, Agents page, Agents guide | An agent's chat with the files it changed open in a group beside it. |
| `docs/plus-menu` | Chat and review page, Chat guide | The composer's + menu open in an agent's chat. |
| `showcase-mr-review` (clip) | Connected tools page | **Review** on !418 from Home, Gemini's comments in the diff, one of your own with a suggested change, then **Post N Comments**. |
| `mr-review-diff` | Connected tools page | !418's diff with Gemini's comments on their lines, a comment of yours with a suggested change, and Jonas's open thread with Gemini's draft reply. |
| `jira-comment` | Connected tools page | **Add Comment…** on ACME-421: a formatted comment, an @mention of Priya, a pasted screenshot and the visibility picked. |

`showcase-review`, `showcase-enhance`, `showcase-plan`, `showcase-wait`, `showcase-notes`, `showcase-console`, `showcase-projects`, `project-threads`, `project-new-thread`, `project-merge`, `browser-page` and the other `docs/` images were taken earlier. Retake one when its screen changes.

## Agent runs

- Allow YOLO in the demo profile (`"gemini.approval.allowYolo": true` in `profile/User/settings.json`) and switch each chat to YOLO from the composer's **+** menu, so a run never stops to ask. Set `gemini.projectId` there too if your Gemini account needs a Google Cloud project.
- A run takes several minutes. Record all of it, then cut the clip: keep the start and the end at normal speed and speed up the middle.
- Name the files in the task, as in "Create `src/cart/gift.ts` with …". A vague task can spend minutes reading the repository before it edits anything.
- Between takes, remove the agent, and put the repository back with `git checkout -- . && git clean -fd`. Discard a review's draft from the merge request's menu on Home, and restart `shots.sh tools` so the demo GitLab forgets posted comments.

## Keeping your own details out

- An agent on its own branch works in `~/.geminicode/worktrees/…`, a path with your user name. Start agents with **On its own branch** off. A merge request review always gets a worktree: if the reviewer opens the cart page in the browser, its address bar shows that path, so cut those frames.
- The Gemini card on Home names your Google Cloud project. Keep it out of frame, or put the demo's name in its place before the shot.

## Before you commit media

- Check every shot for a real name, email, path or ticket. The demo uses Sam Rivera, Priya Nair, Jonas Weber, Mei Chen and Diego Alvarez, and `/Users/Shared/geminicode-shots`.
- Every menu in a shot is GeminiCode's own themed menu, never a native macOS one.
- Update `gemini/site/MEDIA-TODO.md`.
