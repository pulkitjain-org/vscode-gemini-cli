# Media still needed for the site

The redesign shipped with the screenshots and clips that were already in `gemini/site/media/` as placeholders. They come from an earlier build of the app, so every one of them should be retaken from the current desktop app, in both themes, at 2x, with the window at 1440 × 900 points unless a row says otherwise. Each product shot needs a `-dark.webp` and a `-light.webp`; `build.mts` shows the one that matches the page's theme, and a missing file leaves a labelled placeholder frame in the page's own style. The row says what the page's copy promises, so the shot has to show that.

Capture from the real app: never redraw or reuse a shot from this folder for a different purpose (see the project memory note on site screenshots).

## Landing page

| File (dark and light) | Where it appears | What it must show | Size |
| --- | --- | --- | --- |
| `showcase-work-<theme>.webp` plus `showcase-work-<theme>-1000.webp` | The showcase card under the headline, and the first capability card's thumbnail is not it (see `files-*`) | Agents mode: the agent list on the left with several agents and their status dots, a chat in the middle, the Changes panel on the right. This is the page's largest paint. Make the 1000px copy with `cwebp -q 82 -resize 1000 0 in.webp -o out-1000.webp`. | 2000 × 1250 and 1000 × 625 |
| `showcase-work-<theme>.mp4` | The Play button on the showcase card | A 20 to 40 second tour: describe a task on Home, press Return, the agent reads and edits, Keep and Undo on a change. Silent. Its last frame should match the still above. | 2000 × 1250, H.264, under 1.5 MB |
| `files-<theme>.webp` | Hero capability card "Agents side by side" (thumbnail, cropped top left) | An agent's chat with the files it opened in a group beside it | 1400 × 1000 |
| `showcase-review-<theme>.webp` | Hero capability card "Review and safety" (thumbnail) and the Review section's picture | A file an agent changed, with Keep and Undo above a change and the file's keep-all line at the top | 2000 × 1250 |
| `project-threads-<theme>.webp` | Hero capability card "Projects" (thumbnail) and the Projects card's bleeding picture | A project chat with the coordinator's reply and three thread cards in different states, the side panel counting threads | 1600 × 1000 |
| `browser-page-<theme>.webp` | Hero capability card "Agent browser" (thumbnail) and the Browser tile | GeminiCode's browser open beside a chat on a local app, Add to Gemini in the toolbar | 1600 × 1000 |

## Docs

The guide pages name their images in Markdown (`gemini/docs/guide/*.md`). All of these exist as placeholders from the earlier build and should be retaken:

| File | Page | What it must show |
| --- | --- | --- |
| `showcase-work-<theme>.webp` + `.mp4` ("clip") | Getting started | An agent starting on a task, with its changes in the Changes panel |
| `files-<theme>.webp` | Agents | An agent's chat with the files it opened in a group beside it |
| `docs/plus-menu.webp` (one file, used in both themes) | Chat and prompting | The composer's + menu: mode, files, context, Follow the agent, model, usage, skills |
| `showcase-enhance-<theme>.webp` + `.mp4` | Chat and prompting | A short request rewritten by Enhance into a precise prompt |
| `showcase-plan-<theme>.webp` + `.mp4` | Chat and prompting | An agent in Plan mode writing a plan that ends with Build This Plan |
| `docs/folded-turn-<theme>.webp` | Chat and prompting | A finished turn opened: thoughts, searches, reads, commands and edits |
| `replies-<theme>.webp` | Chat and prompting | A reply with typeset math and coloured code |
| `showcase-wait-<theme>.webp` + `.mp4` | Review and safety | An agent asking to run npm test, the run after Allow once, and its summary |
| `showcase-review-<theme>.webp` + `.mp4` | Review and safety | Keeping an agent's edits one by one, with Keep and Undo above each change |
| `project-chat-<theme>.webp` | Projects | A project chat where the coordinator answers with a plan of two threads |
| `showcase-projects-<theme>.webp` + `.mp4` | Projects | The coordinator starting two threads, whose cards update as they work |
| `project-threads-<theme>.webp` | Projects | Thread cards in the project chat, the side panel counting threads by state |
| `project-new-thread-<theme>.webp` | Projects | The New thread dialog: title, brief, branch, Plan first |
| `project-merge-<theme>.webp` | Projects | A finished thread card with Merge back, Review changes and Undo thread |
| `docs/project-settings.webp`, `docs/project-memory.webp` (one file each) | Projects | Project settings, General and Memory |
| `browser-page-<theme>.webp` | Browser | A cart page in GeminiCode's browser beside the chat, Add to Gemini in the toolbar |
| `showcase-notes-<theme>.webp` + `.mp4` | Browser | Notes pinned on elements of a page and sent to Gemini |
| `showcase-console-<theme>.webp` + `.mp4` | Browser | An agent reading a page's console errors and fixing the code |
| `docs/project-helpers.webp` (one file) | Project Helpers and settings | Project Helpers with MCP servers and skills, each with a switch |

Not referenced by any page any more, safe to delete once the above are retaken: `browser-check-*.webp`, `browser-notes-*.webp`, `showcase-thread-*`.

## Not yet pictured anywhere

These features are described on the landing page with drawn mocks, not screenshots. A real shot of each would let the mock go:

- Home with the Start Agent composer, the Get started card and the Needs you list (Agents bento, "Home" tile).
- The Agents pane with five agents in different states (Agents bento, "Agents side by side" tile).
- Enhance prompt before and after (Agents bento, "Enhance prompt" tile).
- Home's My tickets and Merge requests cards (Beyond the editor, "From ticket to merge request" tile).
