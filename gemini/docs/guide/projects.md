# Projects

A project hands a larger piece of work to a team of agents. You talk to a **coordinator**, which splits the work into **threads**: each an agent on its own branch, in one or more repositories. You review and merge each thread when it's right.

![A project chat where the coordinator answers with a plan of two threads](../../site/media/project-chat-dark.webp)

## Start a project

1. Choose **+** next to **Projects** in the agent list, or on Home.
2. Pick a folder in a Git repository: an open workspace or any other folder.
3. The project chat opens at once, named after the repository. Describe the work and press Return.

The coordinator plans the work and starts a thread for each part.

> [!NOTE]
> A project needs a repository the Gemini CLI trusts, since the CLI loads a project's tools only in trusted folders. The first time you pick a folder for agents, GeminiCode asks once (see [Folder trust](review.md#folder-trust)). Coordinators run in `~/.geminicode/projects`, which GeminiCode trusts itself, and threads check out their branches in `~/.geminicode/worktrees/<repository>`, which is trusted along with the repository.

![The coordinator starting two threads, whose cards update as they work](../../site/media/showcase-projects-dark.webp "clip")

## Talk to the coordinator

The coordinator never edits files or reads the code itself. It plans, starts threads, passes your follow-ups to them and answers questions about their progress. It runs on a Flash model in an empty folder of its own, and reads the repository's context files, such as `GEMINI.md` and `AGENTS.md`. Once a repository's [index](agents.md#workspace-index-and-docs) is built, the coordinator also gets its outline (folders, languages and public definitions), so the threads it starts are pointed at the right parts of the code.

Only your messages wake the coordinator. When a thread finishes, asks something or fails, you take it up in that thread; the coordinator sees what changed the next time you write to it. A follow-up on work a thread already has goes to that thread, whether it's working, waiting or done.

You can write while the coordinator works. Your message shows above the input as **Goes to the coordinator after this turn**, with **Edit** and **Remove**, and goes as soon as the turn ends. Return and ⌘Return both wait: the coordinator's turn is never stopped for a message. If you stop the coordinator, your messages stay there until you choose **Send now**.

If a coordinator turn fails, for example on a quota or network error, its error offers **Retry**, which sends the coordinator what that turn was given again. Your next message carries it too, so nothing you wrote is lost.

**Compress** works in the project chat as in any chat: type `/compress`, use the **Compress** link in the usage popover, or the card offered once the context passes 40%. The coordinator's summary lists its threads, and its next turn gets its role and the project memory again.

## Threads

Each thread shows as a card in the project chat with its state, branch, changed lines and time, and updates in place. Click its title, or **Open**, to open its chat in a tab of its own. A thread's questions and permission requests stay in its own chat (**Open to Answer**). A line of three steps on the card, **In the thread**, **Trying in your workspace** and **Kept**, shows where its work is.

![Thread cards in the project chat, with the side panel counting threads by state](../../site/media/project-threads-dark.webp)

Threads run in the repository's worktrees with all of its rules, and a thread's agent starts while its folder is set up. If you quit while a thread is still being set up, it keeps its brief: when the project opens again, the setup runs again and the thread gets its brief then. In the agent list, the **Projects** section lists each project with its threads below it.

When the coordinator passes a thread a note while the thread is working, the note shows above the thread's input as **From coordinator: goes after this turn**. It goes when the turn ends; **Send now** gives it to the thread after its current step instead, and **Remove** drops it. A note held while a thread is still being set up survives quitting, and goes when the project opens again.

### How many threads run at once

At most four of a project's threads work at once (`gemini.projects.maxRunningThreads`, which your administrator can lock). A thread started beyond that, by you or the coordinator, waits: the side panel lists it as waiting, with **Starts when a running thread finishes** and how many run, and it starts on its own when one finishes its turn, is merged or is removed. Notes the coordinator sends it meanwhile wait with it. A thread that is planned or done doesn't count as running.

When today's Gemini quota is over 90% used, as the usage meter in the status bar reads it, new threads wait too: a banner in the side panel says how many it holds and when the quota resets. They start when it resets, or at once with **Start Anyway**. A sign-in with an API key has no quota to read, so nothing waits for it.

## Start a thread yourself

Choose **New thread** in the project chat's **+** menu, or **New Thread** on the project's row in the agent list. Give it a title, what it should do, a branch and a model. It starts at once, and the coordinator hears about it afterwards.

Tick **Plan first** to have it write a short plan and wait for **Approve Plan** before changing files.

![The New thread dialog with a title, a brief, a branch and Plan first](../../site/media/project-new-thread-dark.webp)

## Fork a thread

**Fork Agent** works on a thread too: the split-arrows icon on its row, the row's right-click menu, the **+** menu, `/fork`, or **Fork** at the end of any reply. The fork is a new thread in the same project, on a new branch made from the thread's branch with its uncommitted changes, and starts with the thread's conversation (whole, compacted or the conversation only). It gets a card in the project chat, and the coordinator is told about it with your next message. A thread that works in several repositories can't be forked.

## Try, keep or take back

When a thread finishes with changes, its card offers **Try in Workspace** and **Review Changes**. **Review Changes** opens the thread's changes as a diff and leaves your workspace alone.

**Try in Workspace** copies the thread's changes into your own checkout of the repository as unstaged files, so your local server and tests run with them. Nothing is committed, staged or merged: your branch, its index and HEAD stay as they are. The card's line says how many files are in your workspace, and the status bar shows **Trying:** and the thread's name; click it for the same choices as the card. In Source Control, the tried files carry a **T**.

![A thread's card while its work is tried in your workspace, with Keep Changes and Take Back](../../site/media/try-workspace-dark.webp)

While you try a thread's work:

- **Ask for changes in the thread.** When its turn ends, your workspace updates by itself, and the card counts the updates.
- **Edit the files yourself.** Your edits stay. **Send My Edits to the Thread** copies them into the thread's folder, so its next turn builds on them.
- **Keep Changes** makes the changes yours and finishes the thread. They stay unstaged; commit them when you're ready. Committing the tried files yourself keeps them too.
- **Take Back** removes the thread's changes from your workspace. Edits you made yourself stay, and **Try in Workspace** brings the changes back.

When the thread and you changed the same lines of a file, the file gets conflict markers and updating pauses: **Open the Conflict** opens it, and updating carries on once it's resolved. A file that can't be merged with yours (a binary file, a link, or one deleted on one side) is left as you have it, and the card names it. A file with unsaved edits updates when you save it. One agent's work is tried in a workspace at a time: trying another offers **Take Back and Try**.

The card's **More** menu holds **How Trying Works**, **Open Terminal in Thread Folder**, **Run Checks There**, **Discard Changes…**, **Restore Discarded Work** and **Remove Thread…**. **Discard Changes…** puts the thread's folder back where it started and takes its changes out of your workspace; the work is saved in git, under `refs/geminicode/discarded/`, so **Restore Discarded Work** brings it back until you remove the thread. **Remove Thread…** deletes the thread with its folder and branch; while you try its work, it asks first whether to keep the changes or take them back.

A thread that finished without changes, such as an assessment, offers **Open** to read its answer. Once a thread is kept, the coordinator starts a new thread for further work, and reopens a resolved one only when you ask.

### Merge commits instead

The chevron beside the card's **Try in Workspace** offers **Merge Back** and, with GitLab connected, **Open Merge Request**, and remembers your pick for the repository. Merge Back commits the thread's work on its branch and merges the branch into the branch your folder has checked out, and the thread is then resolved.

![A finished thread card with Merge back, Review changes and Undo thread](../../site/media/project-merge-dark.webp)

## Several repositories

A project can hold more than one repository, such as a content site and the app that reads it. Add one with **Add repository** in the project's settings.

- Each thread gets a worktree of each repository it needs, side by side in its folder, on the same branch name.
- The coordinator picks the repositories for each thread from what you asked, and asks you when it can't tell. A thread can also add another repository itself mid-task.
- When you start a thread yourself, tick the repositories it works in.
- **Try in Workspace** tries each repository's work in your checkout of that repository. With Merge Back remembered for the repository, each repository has its own **Merge Back** on the card, and the thread stays open until every repository with changes is merged.

## Project settings and memory

Open the project's settings with the gear at the top of the project chat.

**General** shows the project's open threads, merged threads, lines changed and repositories, and holds:

- **Name**, shown in the Projects list and the project chat's tab.
- **Repositories**, to add or remove one.
- **Defaults for new threads**: the thread model, **Plan first**, and a **Branch prefix** put before each thread's branch name.
- **Clean Up Folders...**, which removes the folders of threads whose work is all merged. Each thread keeps its branch and chat, and its folder comes back when you open it.

![Project settings, General, with two repositories and defaults for new threads](../../site/media/docs/project-settings-dark.webp)

**Memory** holds what every thread and the coordinator read:

- **How the repositories connect**: what each repository owns and where they meet, such as APIs, data models, URLs and release order.
- **Project instructions**: conventions and anything you'd otherwise repeat.
- **Context files**: Markdown files kept in the project's folder, each with who reads it, the coordinator, threads or both.

For a new project, Gemini drafts this from the repositories for you to review; **Draft with Gemini** drafts it again. Saved changes apply to new threads and the coordinator's next turn.

![Project settings, Memory, with project instructions and context files](../../site/media/docs/project-memory-dark.webp)

## The side panel

When the project chat is at least 1000 px wide, a panel on its right lists the threads by state (click one to open it), with how many requests each thread's chat has made and the project's total, the Conductor tracks the coordinator reads from a `conductor/` folder, and the coordinator's model. A request is one prompt the thread was sent, with its answer: the Gemini CLI doesn't say how many model calls a turn made. Drag its left edge to resize it; double-click the edge to reset it.

## Turn Projects off

Projects are on by default. To hide them, turn off `gemini.projects.enabled` in Settings. **New Project** then offers to turn them back on.
