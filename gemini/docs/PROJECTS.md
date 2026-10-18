# Projects: a coordinator and its threads

Projects (preview, `gemini.projects.enabled`) let one chat run a team of agents. You talk to a **coordinator**, which splits the work into **threads**: each thread is an ordinary GeminiCode agent on its own branch, in its own worktree. This page explains the idea, how the parts fit, how prompts move between them, and what drives the coordinator's decisions. How to use it is in [the Projects guide](guide/projects.md); the short version for the code is in [ARCHITECTURE.md](ARCHITECTURE.md#the-agent-workspace); the measurements behind it are in [FINDINGS.md](FINDINGS.md#a-projects-coordinator-and-threads-in-one-process).

## The idea

A project follows the hub-and-spoke pattern used by multi-agent tools:

- **The coordinator (hub)** is one long-lived agent session. It plans, starts threads, passes your follow-ups on, and answers questions about progress. It never reads or changes code.
- **Threads (spokes)** do the work. Each starts with a brief, has its own context, branch and approvals, and knows nothing about the other threads.
- **The platform** sits between them. It is plain code, not a model: it serves the coordinator's tools, turns what happens into prompts, delivers them when a session is free, and keeps the records. In GeminiCode the extension host plays this part.

The models never talk to each other directly. The coordinator acts only by calling tools; threads report only by calling a tool; everything else is the extension.

Nothing in the Gemini CLI is changed. A project uses what the CLI already offers over the [Agent Client Protocol](https://agentclientprotocol.com): several sessions in one process, MCP servers passed per session, and permission requests the client answers.

```mermaid
flowchart TB
    U([You])
    subgraph EXT[GeminiCode extension: the platform]
        HUB[ProjectHub<br/>wake loop and tools]
        MCP[geminicode-project<br/>MCP server]
        REC[(Agent records<br/>and transcripts)]
    end
    C{{Coordinator session<br/>Flash, empty folder}}
    T1[Thread A<br/>own branch and worktree]
    T2[Thread B<br/>own branch and worktree]

    U -- writes in the project chat --> HUB
    U -- writes, approves, merges --> T1
    U -- writes, approves, merges --> T2
    HUB -- wake prompt --> C
    C -- tool calls --> MCP
    MCP --> HUB
    HUB -- brief or note --> T1
    HUB -- brief or note --> T2
    T1 -- report --> MCP
    T2 -- report --> MCP
    HUB <--> REC
```

## What runs where

All of a project's sessions run in the one `gemini --acp` process that serves every agent in the window. Each is its own ACP session with its own folder.

| Part | Runs in | Model | Code |
| --- | --- | --- | --- |
| Coordinator | An empty folder of its own, `~/.geminicode/projects/<id>` | The newest named Flash model the agent offers (never Auto, Flash-Lite, image or live models) | `coordinatorModel` in `src/acp/projectHub.ts` |
| Thread | A worktree in `~/.geminicode/worktrees/<repository>/<branch>` | The model picked in New thread, else the usual default | `startThread` in `src/host/agentsView.ts` |
| Hub | The extension host, one per open project | None | `src/acp/projectHub.ts` |
| Tool server | The extension host, 127.0.0.1, one for all projects | None | `src/acp/projectMcp.ts` |
| Glue to the UI | The extension host | None | `src/host/projects.ts` |

**Why the coordinator's folder is empty.** With no code to read, the coordinator has nothing to do but route. It still gets the repository's context files (`GEMINI.md`, `AGENTS.md` and any file `context.fileName` names) as links, so it knows the project's rules. It does not get the `.gemini` or `.agents` folders, whose skills, commands and MCP servers are for doing the work (`src/acp/projectRules.ts`).

**Why threads get links to ignored rules.** A worktree has only what Git tracks, so a local `.gemini` folder the repository ignores would be missing. A thread's worktree links whatever rules the repository has there, so threads load the same settings, skills and commands as the main checkout.

**Why the folders must be trusted.** The CLI loads no MCP servers in a folder it does not trust, not even ones the client passes in `session/new`. Opening or starting a project asks once to trust `~/.geminicode/projects` and the repository's worktrees folder, then waits for the agent to restart, because the CLI reads its trust list once per process ([FINDINGS.md](FINDINGS.md#folder-trust-and-a-sessions-mcp-servers)).

## The tools

The `geminicode-project` MCP server has the same shape as the browser's server: Streamable HTTP with plain JSON replies on 127.0.0.1, one URL per caller, and a bearer token that is an HMAC of its path. The token decides who is calling, so a thread's token cannot act as the coordinator, and a caller from one project cannot touch another.

| Tool | Caller | What it does |
| --- | --- | --- |
| `start_thread(title, brief, planFirst?, track?)` | Coordinator | Creates a worktree and a thread agent, returns its id as soon as the worktree exists, and sends the brief when the repository's setup ends |
| `message_thread(thread, text, reopen?)` | Coordinator | Sends a note now if the thread is idle, or after its current turn or setup; refuses a resolved thread unless `reopen` is true |
| `list_threads()` | Coordinator | The thread list, the same one every wake already carries |
| `read_thread(thread, last?)` | Coordinator | A thread's latest messages as text (10 by default, at most 50) |
| `post(text)` | Coordinator | A message in the project chat |
| `report(kind, text)` | Thread | A result, blocker or question, kept as context for the coordinator's next wake |

**Permissions.** The CLI asks the client before any MCP tool call, because servers passed over ACP carry no `trust`. GeminiCode answers those requests itself (`Projects.instantAnswer`):

- The coordinator's calls of its own tools are allowed at once and hidden from the chat.
- Any other tool the coordinator asks for (a file read, a shell command, a search) is refused at once, and the chat says so.
- A thread's `report` is allowed at once. Everything else a thread does asks you, as any agent does.

The CLI titles an MCP permission request by the tool and its arguments, without the server's name. Only MCP calls offer "Allow all server tools", so that option together with the tool's name tells the project's tools apart from your own servers.

## How prompts are orchestrated

Every prompt a model sees in a project comes from one of four places: you, the hub's wake, a thread's brief, or a note to a thread. The hub decides when each is sent; the models decide nothing about timing.

### What wakes the coordinator

Only your messages in the project chat wake it. Everything else is queued as context and goes out with your next message:

| Event | Wakes the coordinator | Where it comes from |
| --- | --- | --- |
| You write in the project chat | Yes | `ProjectHub.post` |
| A thread calls `report` | No, context only | The thread's `report` tool |
| A thread ends a turn without reporting | No, context only | `Projects.threadTurnEnded`, which adds a report with the thread's last reply |
| You start a thread yourself with New thread | No, context only | `ProjectHub.startThread` |
| A thread works, waits for you or finishes | No; its card shows it | The thread's activity |

This is deliberate. A thread's result, question or failure is yours to take up in that thread, where its card leads you. Waking the coordinator for each one cost a model turn that only restated what the card already showed: in the spike, half of the coordinator's turns answered reports ([FINDINGS.md](FINDINGS.md#a-projects-coordinator-and-threads-in-one-process)).

### The wake loop

An ACP session runs one prompt at a time, so the hub keeps a queue (`ProjectHub.wake`):

1. An event is added to the queue.
2. If the coordinator is idle and the queue holds one of your messages, the hub takes everything queued and sends it as one wake prompt.
3. Events that arrive while the coordinator is mid-turn wait. When the turn ends, the hub checks the queue again and sends the next wake if your message is in it.
4. There is no timer. A wake goes out the moment the coordinator is free, never later.

If a turn fails, the project chat says the coordinator could not answer and the loop carries on with the next message.

```mermaid
sequenceDiagram
    autonumber
    actor U as You
    participant H as ProjectHub
    participant C as Coordinator
    participant S as Tool server
    participant A as Agents (extension)
    participant T as Thread

    U->>H: "Add dark mode to the settings page"
    H->>C: wake: threads, Conductor tracks, events
    C->>S: start_thread(title, brief)
    S->>H: call(coordinator, start_thread)
    H->>A: start(request)
    A->>A: add worktree and branch, link rules, add agent
    A-->>H: thread id
    H-->>C: "Started thread <id>."
    C->>S: post("Started a thread for dark mode")
    H-->>U: coordinator line and thread card
    A->>A: run repository setup
    A->>T: brief + how to report
    T->>T: works, asks you for approvals
    T->>S: report(result, "Done, tests pass")
    S->>H: queued as context, no wake
```

### What a wake prompt contains

A wake carries everything the coordinator needs for one turn, so it never has to fetch anything first (`ProjectHub.wakePrompt`). The first wake of a new session starts with the role brief; every wake then holds:

```xml
<wake>
<threads>
- 7f3c… "Dark mode": done, Finished its turn. It last said: Done, tests pass
- 91ab… "Fix login redirect": working, Running npm test (started by the user)
- 2d40… "Upgrade router": resolved (merged)
</threads>
<conductor>
Product (conductor/product.md):
…

Open tracks (start a thread for one with start_thread and its track id):
- settings-redesign: Settings page redesign (in progress)
</conductor>
<event kind="report" thread="7f3c…" report="result">
Done, tests pass
</event>
<event kind="user">
Also make the toggle remember its last value
</event>
</wake>
```

- **Threads:** one line each, with id, title, state (or "resolved (merged)"), its last line of activity cut to 160 characters, and whether you started it.
- **Conductor:** when the repository has a `conductor/` folder ([Conductor](https://github.com/gemini-cli-extensions/conductor)), its product and tech-stack notes and its open tracks. Files are cached until they change, so this costs a stat per file (`src/acp/conductor.ts`).
- **Events:** everything queued since the last wake, oldest first: your messages, thread reports, and threads you started.

The wake is sent with `sendUnseen`, so it reaches the model without showing in the project chat; you see your own message and the coordinator's posts and thread cards.

### What a thread is told

A thread's first prompt is built by `threadPrompt`:

1. The brief, as the coordinator wrote it or as you typed it in New thread. A brief taken from a Conductor track adds that track's spec and plan.
2. With Plan first, an instruction to write a short plan and stop. The session also opens in the CLI's Plan mode, which refuses edits until you choose **Approve plan**.
3. An instruction to call `report` once, with one or two sentences, when the work is done, it is blocked, or only you can answer something.

The brief is sent only when the worktree's setup script ends, so the thread never starts on a half-installed checkout. Later notes from the coordinator (`message_thread`) are delivered the same way: at once if the thread is idle, otherwise queued and sent together when its turn or setup ends (`Projects.deliver`). A note is never dropped because the thread was busy.

## How the coordinator decides

The coordinator is a language model, so its choices are not hard-coded. What GeminiCode controls is what it is told, what it can see, and what it is able to do. Those three together make the intended choice the easy one, and the wrong ones impossible or refused.

### What it is told: the role brief

`coordinatorBrief` in `src/acp/projectHub.ts` is short on purpose, because the wake carries the facts. It sets these rules:

1. Never read code, write code, edit files or run commands, even to look before starting a thread.
2. Use `start_thread` for any request that needs code read or changed, one thread per independent piece of work, with a brief that says everything the thread needs.
3. Answer directly with `post` only when the wake already holds the answer.
4. Send anything that continues or extends a thread's work to that thread with `message_thread`, whatever its state. Start a new thread only for separate work, or when the related thread is resolved.
5. Never reopen a resolved thread unless you ask for it.
6. Never answer approvals; you answer them in the thread that asked.
7. Treat thread results, questions and failures as context; they need no post of their own.
8. Act on the events in one turn, then stop. Keep posts to a line or two.

### What it can see: the inputs

| Input | What it tells the coordinator | Where it comes from |
| --- | --- | --- |
| Your message | What you want now | The project chat |
| Thread list | Which work already exists, its state, and whether it is resolved | The hub's records, rebuilt from the agent list on reload |
| Thread reports | What each thread finished, or is stuck on, since the last wake | `report`, or the thread's last reply when it ended a turn without one |
| Conductor tracks | Planned work and the project's product and tech-stack notes | `conductor/` in the repository |
| Context files | The repository's own rules | `GEMINI.md`, `AGENTS.md` and `context.fileName`, linked into its folder |
| Its own history | Earlier asks and what it did about them | Its session, resumed with `session/load` |
| `read_thread` | A thread's recent messages, when a line is not enough | The thread's transcript |

### The decision, in practice

With those rules and inputs, each message usually resolves to one of these:

```mermaid
flowchart TD
    M[Your message arrives in a wake] --> Q1{Can the wake answer it?<br/>status, what a thread is waiting on}
    Q1 -- yes --> P[post: a line or two]
    Q1 -- no --> Q2{Does it continue or extend<br/>an existing thread's work?}
    Q2 -- yes --> Q3{Is that thread resolved?}
    Q3 -- no --> MT[message_thread to it<br/>whatever its state]
    Q3 -- yes --> Q4{Did you ask to reopen it?}
    Q4 -- yes --> RO[message_thread with reopen]
    Q4 -- no --> ST
    Q2 -- no --> Q5{Is it about approving,<br/>merging or a thread's question?}
    Q5 -- yes --> PT[post: point you to that thread]
    Q5 -- no --> ST[start_thread: one per<br/>independent piece of work]
```

The diagram describes the brief's rules, not code: the model applies them. The checks below are code, and hold whatever the model does.

### What it can do: the guardrails

| Guardrail | What it prevents | Where |
| --- | --- | --- |
| An empty folder | Reading code instead of handing it to a thread | `coordinatorHome`, `projectRules.ts` |
| Every non-project tool refused at once | Edits, commands and searches by the coordinator | `Projects.instantAnswer` |
| Tools chosen by token | A thread starting or steering threads | `ProjectMcpServer`, `ProjectHub.call` |
| `message_thread` refuses a resolved thread without `reopen` | Piling new work onto merged work | `ProjectHub.call` |
| `message_thread` fails for a removed thread | Sending to a thread whose agent is gone | `Projects.message` |
| `start_thread` needs a title and a brief | Threads with nothing to do | `ProjectHub.call` |
| Notes queue while a thread is busy | Lost follow-ups | `Projects.deliver` |
| Approvals stay with the thread | The coordinator approving for you | Permission requests go to the thread's own chat |
| Merging is yours | The coordinator merging or undoing work | Merge back, Review changes and Undo thread are buttons on the card, not tools |
| A named Flash model | An extra routing call per wake, and a slower, costlier hub | `coordinatorModel` |

The spike measured how well this holds on a real account: on `gemini-3.8-flash`, the coordinator did no edits or commands of its own and handled all five scripted asks as expected ([FINDINGS.md](FINDINGS.md#a-projects-coordinator-and-threads-in-one-process)).

## A thread's life

A thread's state lives in the hub (`ThreadState`) and is set from the thread's own activity, never by the coordinator.

```mermaid
stateDiagram-v2
    [*] --> starting: start_thread or New thread
    starting --> working: brief sent after setup
    working --> waiting: asks you for permission
    waiting --> working: you answer
    working --> planned: Plan first, plan written
    planned --> working: Approve plan
    working --> done: turn ends
    done --> working: a note or your message
    done --> resolved: Merge back
    resolved --> working: reopened on your request
    done --> [*]: Undo thread or Remove
    resolved --> [*]: Remove with its branch
```

- **Resolved** is kept on the agent's record, so a merged thread stays resolved after a reload.
- **Undo thread** removes the thread's branch and worktree; its card says it was removed and the hub stops listing it.
- **Merge back** checks the thread is idle before and after its dialog, and runs once per thread at a time.

## Restarts and what is kept

GeminiCode runs on your machine, so nothing in a project runs while the app is closed. Work stops when the app quits and continues when it opens again.

| What | Kept in | On reopen |
| --- | --- | --- |
| The project and its threads | The agent records in global state: each thread's record names its coordinator, who started it, Plan first, its Conductor track and whether it is resolved | The hub rebuilds its thread list from them (`Projects.openProject`) |
| Each conversation | GeminiCode's transcript per agent, and the CLI's own chat file | Shown at once; the session resumes with `session/load` |
| Threads that aren't resolved | Their worktrees | Their sessions start one at a time, 1.5 s apart and without opening tabs, so the coordinator can reach them; a thread whose worktree is gone is skipped |
| The coordinator's role brief | Its session history | Not sent again when the session was reopened with its history |

## Measurements

From [FINDINGS.md](FINDINGS.md#a-projects-coordinator-and-threads-in-one-process), gemini-cli 0.63.0, 14 Oct 2026:

- One process holds a project. With a coordinator and 10 threads streaming at once, a chunk arrived at most 7 ms later at p95 than with one session alone, against a 50 ms budget.
- On `gemini-3.8-flash` the median coordinator turn took 9.4 s, all of it the model's time.
- Each coordinator turn read a median of 28,807 input tokens for 58 output tokens. Most of that is the CLI's own system prompt and tool list, sent again every turn. That is why only your messages wake the coordinator.

## Known limits

- **Restored threads start as done.** On reopen, every thread that isn't resolved is listed as done until its session reports activity, including one that was mid-turn when the app quit. That turn is lost with the process and is not marked or resumed.
- **A fresh coordinator session may miss its brief.** The hub decides whether to send the role brief from whether the coordinator had a saved session. If that session can't be loaded (the CLI deletes chats after 30 days without updates, by default), the agent opens a fresh one, but the hub still counts it as briefed. The tool guardrails still hold; the role rules would not be restated. Inferred from reading the code, not observed.
- **Project notes are not wired yet.** The hub can put project memory in each wake (`ProjectContext.memory`), and has `failed` and `thread-user` events, but the extension does not supply them yet.
- **One project ID per window.** All sessions share the process's Google Cloud project.

## Code map

| File | Role |
| --- | --- |
| `src/acp/projectHub.ts` | Wake loop, wake prompt, role brief, thread prompt, tool handling, coordinator model choice |
| `src/acp/projectMcp.ts` | The `geminicode-project` MCP server, its tools and the permission check |
| `src/acp/projectRules.ts` | Links context files into the coordinator's folder, and ignored rules into a thread's worktree |
| `src/acp/conductor.ts` | Reads `conductor/` for wakes and track briefs |
| `src/acp/worktrees.ts` | Worktrees, branches, `coordinatorHome` |
| `src/acp/agents.ts` | Agent records, including the project role |
| `src/host/projects.ts` | Glue: opens a project's hub, answers permissions, tracks thread activity, delivers notes, cards and the side panel |
| `src/host/agentsView.ts` | Starts threads (worktree, setup, brief), resumes them, Merge back and Undo thread |
| `webview-src/project.ts` | The project chat's side panel |
