# Chat and prompting

Everything you need to talk to an agent sits in the composer's **+** menu. Attach the files that matter, turn a rough request into a precise prompt, and let the agent plan before it builds.

![The composer's + menu with the mode, files, context, Follow the agent, the model, usage and skills](../../site/media/docs/plus-menu-dark.webp)

## The + menu

The **+** menu at the bottom left of the composer holds:

- **Mode**: Default, Auto Edit, Plan and, if your admin allows it, YOLO. See [Approval modes](review.md#approval-modes).
- **Files** and **Context**: attach files from anywhere, or workspace files with `@`.
- **Follow the agent**: open each file the agent reads or edits.
- **Model**: the models the terminal's `/model` shows, in the same order. The model you pick is used for every new or reopened agent.
- **Fork**: start a new agent from this conversation. See [Fork an agent](agents.md#fork-an-agent).
- **Open Terminal**: the agent's own terminal, in its folder. See [Terminals](agents.md#terminals).
- **Usage and quota**: how full the chat is and today's quota.
- **Skills and commands**: the same list as typing `/`.

A mode other than Default shows as a chip beside **+**; click its × to go back.

## Attaching context

- **Workspace files.** Type `@`, or choose **Context** in the **+** menu. The agent gets a link and reads the file itself, including unsaved changes.
- **The selection.** <kbd>⌘L</kbd> adds the editor selection with its line numbers, to the agent in front or to a new agent.
- **Files from anywhere.** Choose **Files** in the **+** menu, paste, or drop files from Finder. Hold <kbd>⇧</kbd> when dropping from the Explorer. Text and code files up to 1 MB are sent with their contents; images and PDFs up to about 7 MB are sent inline; other files outside the workspace are sent as links, and the CLI asks once before reading each.
- **Your team's tools.** Paste a Jira key, a GitLab merge request or a Figma link, or choose **From your tools** in the **+** menu. See [Team tools](team-tools.md#in-chat).

The agent can't read secret files such as `.env` and private keys, or git-ignored files.

## Slash commands and skills

Type `/` at the start of the composer, or choose **Skills and commands** in the **+** menu, to list commands: team commands first, then skills, then the CLI's own. Keep typing to filter, then press <kbd>Tab</kbd> or <kbd>Enter</kbd> to complete the name and add arguments.

- **Gemini CLI commands** such as `/init`, `/memory` and `/restore` run in the CLI.
- **GeminiCode's own**: `/resume` reopens a saved session, `/compact` compacts the chat (below), and `/fork` forks the agent.
- **Team commands** are TOML files in `.gemini/commands/` in the workspace, or in `~/.gemini/commands/` for your own. It's the Gemini CLI's own format, so the same files work in the terminal: `git/commit.toml` becomes `/git:commit`.
- **Skills** are folders with a `SKILL.md`, in `.gemini/skills/` (or `.agents/skills/`) in the workspace, or in `~/.gemini/skills/` for your own. Picking one asks the agent to load it, with what you typed after the name as the task.

```toml
description = "Review a file for bugs"
prompt = "Review {{args}} for bugs and suggest fixes."
```

In a team command, `{{args}}` is replaced by what you typed after the name, `@{path}` puts a file's text in the prompt, and `!{command}` the output of a shell command run in the agent's folder. Before any `!{command}` runs, GeminiCode shows every command and asks.

## Enhance prompt

Write what you want in plain words, then click **Enhance** at the end of your text, or press <kbd>⌥⌘E</kbd>. Gemini rewrites the draft as a clearer prompt: what to do, where, and how to tell it's done, with open questions where your draft leaves something out. It keeps your `@` mentions, a leading `/command`, file names and code as you wrote them. In a workspace with an index, the rewrite also sees an outline of the project and the files most likely involved, so it can name the right ones.

![A short request rewritten by Enhance into a precise prompt](../../site/media/showcase-enhance-dark.webp "clip")

The rewrite replaces your draft as Gemini writes it; **Cancel** or <kbd>esc</kbd> stops it. **Revert** (or <kbd>⌘Z</kbd>) puts your draft back. Nothing is sent to the agent until you press Send, and Enhance works while the agent is busy.

## Plan, then build

In **Plan** mode the agent reads and proposes a plan without changing anything. When a reply ends in Plan mode, **Build This Plan** under it switches the chat to Default mode and asks Gemini to carry out the plan.

![An agent in Plan mode writing a plan that ends with Build This Plan](../../site/media/showcase-plan-dark.webp "clip")

With the model on Auto, Gemini plans with Pro and builds with Flash. Turn off **Plan with Pro, build with Flash** in [Project Helpers](helpers.md#gemini-cli-settings) to keep one model throughout.

## Watching the agent work

While the agent works, its thoughts and steps show under a **Working** line, with steps of one kind (nine searches, five commands) as one line that opens to each step.

When the turn ends they fold under one line, such as **Worked for 3m 12s · read 14 files, searched 11 patterns, ran 9 commands**, with the answer below it. The files the turn changed stay in sight as chips that open their diffs, and so does any step that failed, with **Show output**. Click the line to open the turn again. Turn folding off with `gemini.chat.foldFinishedWork`.

![A finished turn opened, with its thoughts, searches, reads, commands and edits](../../site/media/docs/folded-turn-dark.webp)

### Sending while the agent works

You don't have to wait for the agent to finish. While it works, the composer says **↩ to send, ⌘↩ to queue for later**:

- **↩ sends now.** The message shows above the input as **Sending after the current step**. As soon as no command or edit is running (straight away while the agent is thinking or writing, or at a permission card), the chat stops the turn and sends your message at once, telling the agent to adjust its plan and carry on. Use it to steer, such as "use pnpm, not npm" or "leave the tests alone".
- **⌘↩ queues.** The message shows as **Queued: goes after this turn**, and is sent when the turn finishes. Several queued messages go together as one.

Each waiting message has **Send now**, **Edit** and **Remove**. <kbd>↑</kbd> in the empty input takes the last queued one back to edit. If you stop the agent (<kbd>esc</kbd> <kbd>esc</kbd>), or the turn fails, nothing goes by itself: the messages stay queued until you send them.

In a project's thread, notes the coordinator passes on while the thread works wait in the same place, as **From coordinator: goes after this turn**. In the project chat itself, ↩ and ⌘↩ both wait for the coordinator's turn to end: see [Projects](projects.md#talk-to-the-coordinator).

Sending now stops the turn between steps rather than mid-command, so a running command or edit always finishes. The turn you steered gets its own end line and **Undo**, and the steered message starts a new turn. The Gemini CLI can't add a message to a turn that is running in GeminiCode, so this costs one more model request, mostly from its cache.

When the agent hands part of the work to one of the Gemini CLI's subagents (such as the Codebase Investigator, or your own in `.gemini/agents/`), the chat shows a **Subagent** row with its name and how long it has worked. Click it to read the subagent's report.

## Replies

- Code is coloured like the editor, and the button at the top of a code block copies it. A shell command also has **Run**, which runs it in the agent's terminal; see [Terminals](agents.md#terminals).
- A file name in a reply, such as `src/cart/total.ts:11`, opens the file at that line.
- Math written as `$...$`, `$$...$$`, `\(...\)` or `\[...\]` is typeset; prices and shell variables stay plain text.
- Notes, tips and warnings show as coloured callouts.

![A reply with typeset math and coloured code](../../site/media/replies-dark.webp)

Each message you send shows the time you sent it, **Rewind** and **Copy**. Under each reply is how long the agent worked, the time it finished and **Copy**.

## Writing in the composer

Messages you send show Markdown the way replies do. In the composer, <kbd>⌘B</kbd> makes the selection bold and <kbd>⌘E</kbd> makes it code, and <kbd>⇧↩</kbd> on a list line starts the next item. The **Write** and **Preview** tabs (or <kbd>⇧⌘V</kbd>) switch between your draft and how it will look.

The composers underline misspelt words; right-click a word for suggestions or **Add to Dictionary**. Turn it off with `gemini.chat.spellCheck`.

## Usage and quota

The ring at the bottom right of the composer shows how full this chat's context window is. It turns amber at 50%, where Gemini starts summarising older messages, and red at 90%. Click it, or choose **Usage and quota** in the **+** menu, for:

- **Context window**: the tokens in the latest request out of the model's limit.
- **Today's quota**: how much of today's quota each model has used for your account, and when it resets. **All models** shows the rest.
- **This chat**: input, cached and output tokens over the chat's replies, with **Details by model**.

Hover the **Gemini** item in the status bar to see today's quota too; once a model passes 80% it shows the percentage, and the popover offers **Get higher limits**. The quota needs a Google sign-in. Turn it off with `gemini.usageMeter.enabled`.

## Long conversations

When a session's history reaches half of the model's context window, the Gemini CLI summarises the older part and keeps the most recent 30% as it was. It does that only in memory, though: when the session is reopened, after a restart for example, it comes back whole.

**Compact** does the same on request, and keeps it. Type `/compact`, or choose **Compact** in the usage popover, which offers it once the agent has answered and is idle; once the context passes 40%, the chat also offers it once. Gemini writes a summary of the work so far (goal, decisions, files, current state, next steps), and the chat moves to a new session made of that summary and your latest messages, as they were. A line across the chat shows the tokens before and after, with **View Summary** and **Undo**, which goes back to the full session. The conversation above stays in the chat either way.

- The thin outline of your prompts down the chat's right edge jumps to each one; <kbd>⌥⌘↑</kbd> and <kbd>⌥⌘↓</kbd> do the same.
- **Latest** above the input takes you back to the newest message.
- **Open Chat as Markdown** (in an agent's right-click menu, or the Command Palette) opens the whole conversation as a document you can search, save or share.

For a fresh session, start a new agent. Removing an agent you no longer need also deletes its saved conversation.
