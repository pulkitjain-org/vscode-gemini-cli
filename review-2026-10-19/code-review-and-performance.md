# GeminiCode: code review and performance assessment

**Scope:** `main` at `2c8db47ae36` against the last release, `v1.1.0` (`e749bc5044b`). That covers 12 merged PRs (#71 to #82). **Date:** 19 October 2026.

## Summary

GeminiCode adds almost no time of its own. On the path from pressing Enter to the first streamed chunk, its overhead measures **about 0.2 ms**, and that includes a stdio round trip to a stand-in agent. Keystrokes, streamed chunks and switching agents each cost **tens of microseconds**. In this release cycle, every remaining synchronous file or process call in the extension host was made asynchronous, and nothing new runs on the prompt's critical path. The new team tools stay off the activation path and fail fast when the VPN is off.

The review found **no blocking regressions**. Three findings are worth fixing before the release:

1. The turn footer's **"first token"** figure measures the wrong thing. It shows values like *49.5 s* in a 51 s turn, which reads as a slow model or a slow GeminiCode. The shipped site screenshots show it too.
2. With **Run Team Servers** on, the first Jira or GitLab call after 10 idle minutes pays a cold `docker run`, inside the agent's turn. A failed start can hold each call for up to 120 s before falling back.
3. The **audit log's write queue** never recovers from a single failed append. After one, every later Jira or GitLab write fails until the window reloads.

The rest are low-severity tuning items and nits.

## What changed since v1.1.0

| PR | Change | Product code touched |
| --- | --- | --- |
| #71 | Fold each turn's work under one line | webview transcript, `workFold.ts`, `work.ts` |
| #72 | Team tools (Jira, GitLab, SonarQube, Snyk, Figma), Connections, Home dashboard | about 10.7k lines, mostly new files under `src/acp`, `src/host` and `webview-src` |
| #75 | Upstream sync to VS Code 1.142.0; audit log, confirm class, cut-off turns, trace readout, benchmark, pilot, team servers in Docker, admin policy | 2,388 files, mostly upstream |
| #82 | Agent browser, permission and layout defect fixes | 55 files |
| #73, #74, #76 to #81 | Site, docs, icon and release tooling | not on the app's runtime path |

About 15k lines of product code were added in `extensions/gemini`. This review read the runtime paths in full (activation, agent start, sessions, sending a prompt, streaming, permissions, the transcript webview, Home, team tool calls, the browser tools, the audit and pilot logs) and skimmed the rest.

## How it was measured

- Ran the repository's performance budgets (`test/perf/budgets.test.ts`) and recorded the measured values, not just pass or fail: 3 runs, medians shown.
- Benchmarked the new fold layout logic (`turnLayout`, `workSummary`, `foldGroups`) on turns of 50, 300 and 1,000 steps. The budget suite does not cover this yet.
- Rebuilt `dist/extension.js` and the webview bundles from `main`, then measured their sizes and V8 compile time.
- Grepped `src/` for synchronous I/O and timers, and read every new interval and polling loop.
- Ran 167 tests across the perf, webview, permissions, runtime and transcript suites. All passed.

### Measured overhead (Apple silicon, medians)

| Path the user waits on | Budget | Measured |
| --- | --- | --- |
| Enter → first streamed chunk (GeminiCode + stdio round trip, fake agent) | 30 ms | **0.22 ms** |
| Keystroke: `/` command and `@` mention matching | 2 ms | 0.03 ms |
| Streamed chunk of a long reply | 2 ms | 0.05 ms |
| Agent switch: snapshot of a 150-turn transcript | 25 ms | 0.13 ms |
| 500-thread project: open, wake, save | 2 to 10 ms | 0.02 to 0.04 ms |
| Fold layout per update, 50 / 300 / 1,000-step turn | none | 0.02 / 0.06 / 0.20 ms |
| `dist/extension.js` V8 compile at activation | none | about 14 ms |

The fold layout is linear in the turn's length. Even a 1,000-step turn adds about 0.2 ms per tool-call update.

### Bundle sizes

| Bundle | v1.1.0 | main | Budget | Used |
| --- | --- | --- | --- | --- |
| `dist/extension.js` | about 941 KB | 1,184 KB | 1,200 KB (was 950 KB) | 98.6% |
| `media/chat.js` | about 215 KB | 241 KB | 250 KB (was 220 KB) | 96% |
| `media/home.js` | under 16 KB | 28 KB | 30 KB (was 16 KB) | 93% |

## What is done well

- **No synchronous I/O on the extension host.** `grep 'Sync('` over `src/` finds nothing. This cycle made `trustFolder`, `getAgentCommand`, `resolveCli`, `mcpDiagnostics.reset` and `completeSetupInTerminal` asynchronous.
- **Heavy code loads late.** The ACP SDK and zod load when the agent starts (`agentRuntime.ts`, `connect`), not at activation, which saves about 12 ms. The benchmark runner loads only when it runs.
- **Team tools stay off the critical path.** The first tool check runs 3 s after start-up (`teamStatusBar.ts`), all tools are checked in parallel, HTTP calls time out after 8 s (`teamHttp.ts`), and the last known state is cached in global state so pages draw at once.
- **Home is well-mannered.** It refreshes only while visible, coalesces updates for 200 ms, skips posting a view identical to the last one, and runs its 5-minute refresh only while shown (`agentHome.ts`).
- **The new logs cost nothing on the hot path.** `recordPilot` does nothing when the pilot is off. The pilot log buffers for 2 s and appends asynchronously. Audit writes are one async append each.
- **Session reuse got tighter.** A replaced spare session is now closed when the CLI supports closing sessions. `refreshSpare` reopens the spare only when its key changes.
- **No mid-turn restarts.** Settings changes that don't take a permission away now wait until no agent is working (`agentService.ts`, `takesAway`).
- **Folding costs little.** A collapsed fold drops its steps' DOM nodes. Fold and run headers are memoised by a key and rebuilt only when that key changes. Streaming reply text takes its existing fast path and never triggers a layout. A transcript reset lays out whole turns once, not once per item.
- **Permissions stay fast.** The confirm-class check is a cheap predicate in front of the existing path. Switching to YOLO answers waiting requests at once, except the confirm class.

## Findings

Ranked by severity. Line numbers refer to `main`.

### 1. Medium: "first token" is the time to the first reply text, not the first token

[chatController.ts:364](../extensions/gemini/src/host/chatController.ts:364) stamps `firstText` on the first `text` event with `role === 'agent'`. In an agentic turn, thoughts and tool calls stream first, and the agent's own text usually comes last, as the answer. The turn footer then shows **"first token 49.5 s"** on a 51 s turn, and **"first token 165.8 s"** on a 2 m 48 s one. Both are visible in `gemini/site/media/showcase-wait-*.webp` and `docs/plus-menu-*.webp`.

- **User impact:** the figure reads as the model, or GeminiCode, taking most of a minute to respond. That is the opposite of what we want to show.
- **Data impact:** the pilot's `turn.firstTextMs` is skewed the same way, so pilot latency numbers will overstate the wait.
- **Fix:** stamp "first token" on the first `session/update` of any kind after the prompt is sent (a thought chunk, a tool call or a plan). If the time to the answer's first words is still wanted, keep it as a separate figure with a different label. Then recapture the affected screenshots.

### 2. Medium (opt-in): team servers' cold start runs inside the agent's turn

With `gemini.team.runTeamServers` on, a Jira, GitLab or SonarQube call goes through a `docker run` child (`ChildServer`, [mcpStdio.ts:177](../extensions/gemini/src/acp/mcpStdio.ts:177)):

- The child starts **on the first call**, and stops after **10 minutes idle**, so the first call of every working session pays container start-up, typically 1 to 3 s. The very first call also pays an image pull.
- `startTimeoutMs` is **120 s**. When a start hangs (a slow pull, or a VPN or registry stall), the agent's tool call waits up to two minutes before `readThrough` and `through` fall back to the in-process connector.
- A failed start isn't remembered. **Every** later call tries again, so each can wait out the full timeout.

**Fix:** warm the children (and `docker pull` the pinned images) in the background when the setting turns on, when a tool connects, and when a session starts. Give the call that is waiting a short start budget (5 to 10 s) and then fall back while the start carries on. Remember a failed start for a few minutes. Consider a longer idle stop, or idle stops tied to the agent being idle.

### 3. Medium-low: one failed audit append blocks every later team write

`AuditLog.append` ([auditLog.ts:149](../extensions/gemini/src/acp/auditLog.ts:149)) chains appends as `this.queue = this.queue.then(...)` with no `catch`. If one append rejects (disk full, permissions, the storage folder removed), `this.queue` stays rejected, and every later `then` callback is skipped. `record()` awaits `intent()` before the write, so every later Jira or GitLab write, from an agent or a page, then fails until the window reloads. `PilotLog.flush` already guards against this with `.catch(() => undefined)`.

**Fix:** keep the queue alive and report the error only to the caller of the append that failed:

```ts
const run = this.queue.then(async () => { /* mkdir + appendFile + fire */ });
this.queue = run.catch(() => undefined);
return run;
```

### 4. Low: agents' browser pages are never throttled

#82 calls `setBackgroundThrottling(false)` for every agent-owned page ([browserView.ts:617](../src/vs/platform/browserView/electron-main/browserView.ts:617)) so Playwright's stability checks pass while the page is behind another tab. That fixes the defect, but it lasts for the page's whole life. A hidden agent page with animations or polling keeps running at full rate after the agent has finished, which costs CPU and battery for each page left open.

**Fix:** turn throttling back on once the agent's turn ends or the page has had no browser-tool call for a while, and turn it off again on the next call.

### 5. Low: browser `goto` waits for the tab to come forward

[browserMcp.ts:458](../extensions/gemini/src/acp/browserMcp.ts:458) awaits `reveal`, an IPC round trip plus an editor open, before navigating an existing page. That is a few to a few tens of milliseconds on every navigation. Start it without waiting (`void this.backend.reveal?.(...)`), or run it alongside the navigation.

### 6. Low: bundle budgets are raised with every feature

`dist/extension.js` grew 26% (941 KB to 1,184 KB), and its budget went from 950 KB to 1,200 KB in the same cycle. `chat.js` and `home.js` followed the same pattern. Measured compile cost is still small (about 14 ms, since V8 parses lazily), so users don't see this today. But a budget that rises with each feature no longer catches growth.

Most of the growth is team tools code: the five connectors, the flows, the stdio MCP client, the containers and the pages. Users who never connect a tool still load and evaluate all of it at activation. **Fix:** load the team tools modules behind a dynamic `import()` once a tool is connected or a team page opens, as the ACP SDK and the benchmark already do. Then set the budgets back to just above the measured sizes, and require a stated reason for any future increase.

### 7. Low: activation reads five keychain entries one after another

`TeamConnections.load` ([teamConnections.ts:303](../extensions/gemini/src/host/teamConnections.ts:303)) awaits `secrets.get` for each tool in turn. Each read goes through the main process to the keychain. Reading them with `Promise.all` overlaps the five round trips. This runs off the critical path, but it delays the first tool state and the team server's start.

### 8. Low: Jira key detection scans the whole text before the caret on each keystroke

[toolChips.ts:89](../extensions/gemini/webview-src/toolChips.ts:89) copies everything before the caret and runs a regular expression anchored at its end. That costs microseconds for normal prompts and grows with very large pasted prompts. Only the last ~32 characters can match, so slice those.

### 9. Nit: the audit log's "today" is the UTC day

`AuditLog.read()` ([auditLog.ts:104](../extensions/gemini/src/acp/auditLog.ts:104)) and `auditFileName` use UTC dates. In India (UTC+5:30), writes made between midnight and 05:30 count as yesterday in **Audit: N actions today** and on the audit page. Use the local date, or say "UTC" in the page.

### 10. Nit: the trace readout re-parses the whole trace file every turn

[chatController.ts:787](../extensions/gemini/src/host/chatController.ts:787) reads and parses the entire OpenTelemetry file after each turn while a trace is recording, so the cost grows with the length of the recording. It runs only while recording and off the critical path. Tracking a read offset would make it constant per turn.

### Already present in v1.1.0 (not regressions)

- `indexOfItem` ([chatLogic.ts:60](../extensions/gemini/webview-src/chatLogic.ts:60)) scans the whole transcript for each new item. It is fine at today's lengths. An id-to-index map would make it constant.
- `ChatTranscript.restore` spreads every item into `Math.max(...)` ([chatTranscript.ts:336](../extensions/gemini/src/acp/chatTranscript.ts:336)), which throws `RangeError` beyond roughly 100k items. A loop avoids that.
- `runTurn` waits for `refreshSharedPage()` before sending whenever a page is shared. It reads the page over IPC. The wait is bounded, but it is the one awaited step between Enter and the prompt that isn't the CLI.

## Correctness notes from the #82 review

- The `_gemini.browser.console` fix (taking every service from the accessor before the first `await`) is right. The same pattern is worth checking in the other `_gemini.browser.*` commands that await before calling `accessor.get`.
- `allowPending()` on switching to YOLO correctly leaves confirm-class cards alone. It runs only after `setMode` confirms the mode is now `yolo`.
- Hidden editor groups now ignore maximize and keep the neighbour search away from groups with no width. This is consistent, and it is re-applied when a maximize ends.
- Marking restored permission cards as cancelled is right: nothing can answer their buttons after a reload.

## Not covered

- Real-account timings (`scripts/perf-real.mts`): this needs a signed-in CLI. The figures above are GeminiCode's own overhead against a stand-in agent, which is exactly the part we control.
- Profiling inside the running app (renderer frame timing, memory over a long session).
- The VS Code 1.142.0 merge beyond the fork's `GEMINI-FORK` edits, and the site redesign's CSS.

## Recommended before the release

1. Fix finding 1, then recapture `showcase-wait` and `plus-menu` (the "first token" figures in them).
2. Fix finding 3 (a few lines, with a unit test that fails one append).
3. Fix finding 2, or document it: "the first call after a pause can take a few seconds while the server starts".
4. Add a perf budget for the fold layout on a 1,000-step turn, so the linear cost stays linear.
