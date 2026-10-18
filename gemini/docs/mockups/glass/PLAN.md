# Glass: a visual design pass on GeminiCode

A plan and mockups for review, nothing built yet. Two themes stay, GeminiCode Dark and GeminiCode Light; this changes how their surfaces are drawn, borrowing from Apple's Liquid Glass where it costs nothing at runtime, and it moves the Home button to the top left.

| Mockup | What it shows |
| --- | --- |
| `Dark.dc.html`, `Light.dc.html` | Home in both themes, with the Home button in the title bar and the From Your Tools menu open |
| `AgentPane.dc.html` | An agent's chat with the Changes pane, the composer after Enhance prompt, and the composer's three other states: a draft with the Enhance pill, the rewrite streaming in, and the agent working |
| `Dialogs.dc.html` | New thread, New agent, Connect a tool, and the merge confirmation |
| `Menus.dc.html` | The model picker, the **+** menu, usage with quota and context, branches, an agent row's context menu, and the **/** commands |
| `Details.dc.html` | Each piece side by side in dark and light, with its values |

Add `#light` to the address of `AgentPane`, `Dialogs` and `Menus` to see them in GeminiCode Light. `glass.css` holds the tokens and treatments the mockups use; the app would take the same values.

## What Liquid Glass is, and what we take from it

Apple's material does four things: a surface lets what is behind it show through, blurred; light catches its edge (a bright rim on the lit side); layers sit at clear depths; and controls move like a fluid, the lens sliding rather than switching.

GeminiCode takes the last three and not the first. The rim, the depth and the sliding lens are static paint or a compositor animation. The see-through blur is the only part with a running cost, and in this app it would show almost nothing: the title bar sits over a flat backdrop, so a blur there blurs a flat colour, and a menu has to stay about 92% opaque for its text to read, so only 8% of the blur would ever be visible. So nothing blurs.

| Element | Treatment |
| --- | --- |
| Home button, Agents / Editor switch, agent pills (title bar) | Glass: a translucent fill over the static title bar, a rim highlight; the switch's lens slides between the two words |
| Menus, pop-ups, quick input, hovers, toasts, dialogs | Opaque glass: the pop-up colour with a light sheen across its top, a rim highlight and one shadow |
| Side panes (Agents, Changes), Home's cards, the composer, the permission and confirm cards, the merge request panel's cards | Frost: a graphite or white tint with a 1px rim along the top edge and a hairline; drawn as a pre-blended opaque colour wherever content scrolls (below) |
| Title bar and status bar | The window's backdrop shows through as today; a rim under the title bar |
| Buttons and pills | A translucent fill with a rim highlight; the primary button keeps the solid accent with a light rim |
| Dialogs | Over a dim scrim, without a blur |

What we do not take:

- **Any `backdrop-filter`**, for the reasons above and the costs below.
- **Window vibrancy** (the desktop showing through the window). It costs on every repaint of the whole window and has known artefacts on external displays.
- **Refraction and distortion**, and any animated gradient.
- **A third theme.** The treatments are tokens on top of the two themes; the theme picker does not change.

## Performance

The short answer: built as below, the design adds no running cost. Everything it changes is either paint that happens once when a surface is drawn, or a single compositor animation on a mode switch. The one technique that would cost on every frame, the blur, is out.

### What each change costs

| Change | Cost when drawn | Cost while the chat streams or scrolls | Verdict |
| --- | --- | --- | --- |
| Home button in the title bar, status bar item removed | One button | None | Build |
| Fills, rims (inset shadows), radii, the sheen | Static paint, the same work as today's borders and backgrounds | None | Build |
| Translucent fill on the title bar controls | Static; the title bar already blends over the backdrop today | A working agent's spinner sits inside its pill; it already repaints that pill today, and the fill adds a blend, not a filter | Build |
| The switch's sliding lens | A `transform` transition, 160 ms, run by the compositor off the main thread, and only when the mode changes | None | Build; off with reduced motion |
| Frost on panes and cards | Static paint | **Only if left translucent**: a scrolling list over a translucent background loses Chromium's opaque-scroller fast path and repaints more per scroll frame. So every scrolling surface (the transcript, the Agents list, the Changes list, the editor) takes the frost as a pre-blended opaque colour, which looks the same because the backdrop under it never moves | Build, pre-blended |
| Opaque pop-ups with sheen and shadow | One shadow per pop-up, as today | None | Build |
| Dialog scrim | One translucent full-window layer while a dialog is open | None: it does not blur, so a chat streaming under it repaints only its own text | Build |
| Blur on title bar controls | A compositing layer and a blur pass per control | A working agent's spinner would re-run the blur 60 times a second for as long as it works | Skip: over a flat backdrop it shows nothing |
| Blur on menus and pop-ups | A layer and a blur pass when it opens | Over a streaming chat, a blur pass on every chunk while the menu is open | Skip: at the opacity text needs, it shows almost nothing |
| Blur on panes or cards | A large blur layer | A blur pass on every scroll frame | Skip |

### Rules for the build

1. No `backdrop-filter` and no `filter: blur()` in the fork's workbench CSS or the webviews' CSS. `extensions/gemini/test/themes/noBlur.test.ts` fails CI on either (a test rather than a rule in upstream's `build/stylelint.ts`, so no upstream file changes). Upstream's own frosted pop-ups stay turned off, as they are today.
2. Every surface that scrolls has an opaque background colour.
3. Every animation is a `transform` or `opacity`, 160 ms or less, and off under `prefers-reduced-motion`.
4. No new compositing layers in the chat: the transcript, the composer and the cards change colour and edges only.
5. Text always sits on a known, opaque colour, so `test/themes/contrast.test.ts` keeps measuring what the user sees. The new tokens join its pairs.

### How it is checked

The extension's budgets (`test/perf/budgets.test.ts`) stay as they are; the CSS goes in its own files, so the chat bundle's size does not change. Before and after, the same scenario is profiled with **Developer: Toggle Developer Tools → Performance**: an agent streaming a long reply while the chat scrolls, a menu opened over it, and a switch between Agents and Editor. The numbers compared are paint and composite time per frame and dropped frames. If any step shows more than 1 ms per frame over today, the treatment responsible is taken back to flat colour before the work merges.

### Measured, 18 Oct 2026

The scenario above, on a dev build on an Apple silicon Mac, three runs each, before and after the build, medians. Frames are the compositor's own frame reports across every renderer; the times are the totals over the whole scenario (about 10 s and 500 frames), not per frame.

| | Before | After |
| --- | --- | --- |
| Frames presented | 510 | 497 |
| Frames dropped | 0 | 0 |
| Frame time, p50 / p95 | 16.9 / 28.2 ms | 17.5 / 27.6 ms |
| Style | 142.4 ms | 139.0 ms |
| Layout | 173.1 ms | 178.3 ms |
| Paint | 107.1 ms | 105.4 ms |
| Raster | 132.2 ms | 134.4 ms |
| Composite | 95.7 ms | 94.1 ms |

Every difference is within the spread between runs of the same build (layout, for one, ranged 162 to 179 ms after), and the largest, raster at +2.2 ms over 497 frames, is under 0.01 ms per frame against the 1 ms rule. No treatment was taken back.

## The Home button

Today a house icon sits in the status bar at the bottom. It moves to the title bar, first after the macOS window controls and before the Agents | Editor switch, as a glass button with its ⇧⌘H tooltip. The status bar item goes. The title bar's switch is drawn by `ModeSwitcher` in `src/vs/workbench/contrib/gemini/electron-browser/geminiModes.ts`, fork-only code, so no upstream file changes.

## Tokens

All treatments come from a handful of values, defined once for each theme (`geminiSoft.css` for the workbench, `panels.css` and `chat.css` for the webviews, as `--gemini-glass-*`):

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `glass-fill` | white 4% | black 4% | the switch, pills, buttons |
| `glass-fill-strong` | white 7% | black 7% | the lens, a hovered pill, the selected row |
| `glass-rim` | white 14% (top), white 6% (sides) | white 80% (top), black 6% (sides) | the 1px edge highlight, as `box-shadow: inset 0 1px 0` |
| `frost` | graphite at 88% over the backdrop, pre-blended where content scrolls | white at 90%, pre-blended likewise | panes and cards |
| `frost-raised` | 92% | 94% | the composer, the permission cards, the merge request panel's cards |
| `popover` | `#262626`, opaque | `#FFFFFF`, opaque | menus, quick input, hovers, dialogs |
| `sheen` | white 5% fading over 48px | white 90% fading over 48px | the top of every pop-up |
| `shadow` | black 36% | black 14% | one soft shadow per floating element, as today |

Everything else keeps its value: text, the accent, the Gemini gradient (still only the sparkle, the working bar and the focused composer), the warn, error and ok colours, the fonts, the spacing.

## Area by area

1. **Title bar.** Backdrop as today. Left: Home as a glass button, then the switch as a glass capsule whose lens slides, then the agent pills as smaller glass pills with their dots. Right: the browser, search and layout buttons unchanged. A rim along the title bar's bottom edge.
2. **Side panes.** Frost, pre-blended; the Agents pane's selected row takes the lens fill. The Changes pane's cards are frost-raised.
3. **Home.** The composer is frost-raised with a rim; the cards are frost with the same rim; the tool logos sit directly on the page; pills keep their hairline in the state's colour.
4. **Chat.** The user bubble is frost; the agent's text sits on the page; the permission card is frost-raised and the confirm card keeps its warm rim; the composer as on Home.
5. **Enhance prompt.** The Enhance pill after the draft's last character, Cancel while it rewrites and Revert after, become glass pills; the rewrite streams in a muted colour under the working bar on the composer's top edge; the note under the composer keeps its words. The behaviour does not change.
6. **Menus and pickers.** One look for all of them: the model picker, the **+** menu, the mode, branch and folder menus, usage and quota, the **@** and **/** pickers, and upstream's quick input, context menus, hovers and toasts. Rows have an icon, a name, a detail and an end note; the chosen row has the lens fill and a tick in the accent.
7. **Dialogs.** New thread, New agent, Connect, and the workbench's own dialogs (the merge confirmation among them) share one panel: the pop-up glass, a 14px corner, glass wells for fields with an accent ring on focus, the actions at the bottom right.
8. **Status bar.** As today, with the glass fill behind an item on hover.
9. **Light theme.** The same treatments with the light values; the rim is a white highlight, the frost a white tint, so panes read as paper over a pale graphite backdrop.

## Build order, once approved

1. Move the Home button.
2. Tokens in `geminiSoft.css`; the glass switch with its lens, the pills and the Home button; the no-blur test.
3. Menus and pop-ups, in the workbench and the webviews.
4. Dialogs.
5. Frost on panes and the webview surfaces, pre-blended where they scroll.
6. Enhance's pills and the composer.
7. Light theme values, and the new pairs in the contrast test.
8. The before-and-after profile.

## User impact

The Home button moves from the status bar to the title bar. Dialogs, the merge confirmation among them, were already drawn in-app (the fork defaults `window.dialogStyle` to `custom`); they only take the glass. Nothing else moves, no setting changes, and no user configuration needs updating.
