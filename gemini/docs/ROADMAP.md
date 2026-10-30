# Roadmap

This page lists the work that is still open, now and later, and the known risks. What is built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

GeminiCode ships as a Mac app for Apple silicon with the Gemini CLI bundled. Builds come from GitHub Releases and the download page, and the app shows a notice when a newer release is out ([RELEASING.md](RELEASING.md)).

## Open now

### Google Cloud prerequisites

Confirm with the admin of the Google Cloud project:

- Gemini Code Assist seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
- Users have IAM access on the project.
- VPC Service Controls allow `cloudcode-pa.googleapis.com`. If they don't, the account silently drops to the standard tier.
- Whether the tenant asks for account validation.
- Whether a proxy or custom CA is needed.

### Signed releases

Add the six Apple secrets ([RELEASING.md](RELEASING.md#apple-setup)), then cut a release. The release workflow signs with the Developer ID and notarises whenever the secrets are present. Without them, each user has to approve the app in **Privacy & Security** on first launch, and managed Macs may block it.

### Browser sign-in in ACP mode

Check on a desktop that the CLI's browser sign-in, which runs while the agent starts, writes nothing to standard output. Standard output is the protocol stream.

### The team's servers, for real

Run the Jira and GitLab containers, the SonarQube server and Snyk's server against the team's tenants. Their arguments and results were read from the servers' sources, and so far they are tested only against scripted servers.

### Linked rules in project threads

Projects are on by default (`gemini.projects.enabled`). Check in a signed-in session that thread worktrees load the repository's linked rules.

### Real-session traces

Record a Chromium profile, an extension-host profile and a CLI telemetry file (**Gemini: Record or Stop Performance Trace**) from real working sessions. They time the fork's own steps on a real account: Enter to send, rendering, the extension host's share of tool calls, and a cold start after a reboot. [FINDINGS.md](FINDINGS.md) has the timings for the agent and the model.

### Build clean-up

- Regenerate the policy templates (`policyData.jsonc`) so the templates admins deploy include the Gemini settings. This needs a built app.
- Release builds leave out upstream's `extensions/copilot`. Leave it out of dev builds too.
- Trim `defaultChatAgent` in `product.json` to a stub. Removing it outright would touch about 45 upstream files.
- Hide upstream's **Welcome Onboarding 2026** developer command, which opens upstream's onboarding.

### Organisation default project

The app reads `geminiDefaultProjectId` from `product.json`, but no build sets it. If an organisation wants a default, add it to the release workflow, for example from a repository variable.

### Repository settings

- A ruleset on `main` that accepts pull requests only, requires Gemini CI's **Policy**, **Checks**, **Real CLI (bundled)** and **Compile & hygiene** jobs, and allows no bypass outside pull requests ([README](../README.md#ci)). Today it requires one approval and no checks, and the owner can bypass it.
- The owner's GitHub commit email set to the address in AGENTS.md, with **Keep my email addresses private** off for this repository's commits, so commits made on GitHub pass the Policy job.
- Deleting the old `claude/*` branches once their work is merged; new branches start with `task/`, `feature/` or `bugfix/`.
- The `GEMINI_UPSTREAM_TOKEN` secret. Without it the upstream job cannot push an upstream move ([README](../README.md#upstream-releases)).
- The `SNYK_TOKEN` secret, which turns the Snyk job into a gate.

## Known gaps

### Workspaces opened through a symbolic link

Closed in 1.7: GeminiCode opens every session on the folder's real path, as a terminal's CLI does (`realFolder` in `agentRuntime.ts`), so the two share one key; it still reads the linked path's key for chats saved before, which can go a release later ([FINDINGS.md](FINDINGS.md#reopening-a-session-sessionload)).

### Fork cards, and the bar back to what started a chat

Thread cards and Home's cards draw their buttons from the one action set (`branchAgentActions` in `agentRow.ts`); a fork's card in its parent's chat still offers only Open and Try. The bar at the top of a thread's chat back to its project is not yet the one "Started from" bar a fork would get too, and the project's Clean Up Folders is not yet Agent Setup's one Clean Up for every merged agent.

### Pinning a page's remote reads

An agent's browser page can fetch from any site its policy allows; the platform's fetch gives no way to pin a request to the address the policy checked, so a site that redirects elsewhere is checked by its first address only.

### Sessions are never closed

gemini-cli 0.66.0 offers no `session/close`, so a long-lived agent process keeps every session it opened, a few MB each. That includes Enhance prompt's fallback sessions and hidden command sessions. GeminiCode closes sessions as soon as a CLI advertises `sessionCapabilities.close`. Until a CLI does, restart idle processes to free them, and show in the pane when an agent's process was stopped.

### Build files changed through the shell

"Allow for this session" approvals of task runners (`npm`, `make`, `gradle` and the like) lapse when the agent writes a build file through the editor. They do not lapse when a shell command changes one.

### Team server names

The confirm-class policy rules name the team's own servers `jira` and `gitlab`. A team that names them otherwise needs its own rules.

## Later

### Semantic search for the index

Deferred by decision: the index is lexical (BM25), symbols and grep. The cheapest local route measured so far is to re-rank `code_search`'s candidates with a small local embedding model at query time, caching chunk embeddings as they come up. It would be judged by the same real-session comparison as the index ([FINDINGS.md](FINDINGS.md#workspace-index)).

### Docs behind a sign-in

Fetch them through the built-in browser's session, which already holds the user's sign-ins.

### Ripgrep in signed releases

Check that the release's signing step signs the `rg` binaries added to the bundled CLI (`bundle/vendor/ripgrep/`) before notarisation.

### More platforms

Windows first: one more runner in the release workflow and a code-signing certificate. Then Intel Macs and Linux if users ask. Bring this forward when Windows users join.

### Auto-update

The update notice links to the download page. Upstream's updater needs a server that answers per build, which a static GitHub Pages site cannot be, so full auto-update needs a small update server.

### Compat CI

CI runs the real-CLI tests against the bundled, `latest` and `preview` CLI. Add `latest-1` and `nightly`, run them on a schedule, and diff the capabilities the CLI reports. A scheduled run on a machine with a seat should also make a signed-in smoke test of models and modes, which hosted CI cannot do.

### Containment

Evaluate the CLI's `--sandbox` mode as an admin option.

### Per-project processes

Agents in other folders share the window's project ID. Add a process per project ID when someone needs it.

### Workbench text

Reword the rest of upstream's welcome text. Only the product name in its setup walkthrough is changed so far. This needs a workbench change.

### Upstream's Agents window

At each upstream move, check whether `src/vs/sessions` has gained an extension API for agent providers. If it has, move the Agents pane onto it.

## Ideas from upstream 1.144

Upstream's 1.142 to 1.144 releases have these for Copilot's agents. Each could be built on what GeminiCode has:

- Move a chat to a new worktree: start a branch and worktree from a running chat and carry the conversation over, as an agent's own branch does at start, using the conversation hand-over a new session already gets.
- Stop a background shell command: a control on a long-running command's row that cancels it without ending the turn.
- Thinking level and context window in the model picker. This needs the CLI to offer `session/set_config_option`, which 0.66.0 does not.
- Permission modes as separate policies. Upstream lets an admin allow or remove each permission mode on its own, as GeminiCode's `GeminiAllowAutoEdit` and `GeminiAllowYolo` do. Follow upstream's naming if it settles.

The 1.142 and 1.144 bases also bring upstream's Markdown editor (pasting images, renaming links, an outline and breadcrumbs, copying code blocks), `editor.occurrencesHighlightFromAllProviders`, and many leak fixes.

## Risks

| Risk | Notes |
| --- | --- |
| Error-string coupling: error classification breaks silently when the CLI rewords a message. | Fixture tests, and showing an unknown message as it is. |
| No sandbox: safety depends on the approval mode and the admin policy. | The UI must always make the current mode obvious. |
| Upstream moves: a monthly upstream move needs a named owner. | Keeping work in the extension, marking every upstream edit, and CI's check of the patch series. |
| Build resources: a packaged Mac build takes 40 to 60 minutes on GitHub's hosted Apple silicon runner (`macos-15`), which is free only while the repository is public. | A private repository, or Windows and Linux builds, would need paid or larger runners (about 16 GB of RAM). |
