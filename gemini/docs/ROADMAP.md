# Roadmap

This page lists the work that is still open, now and later, and the known risks. What is built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

GeminiCode ships as a Mac app for Apple silicon with the Gemini CLI bundled. Builds come from GitHub Releases and the download page, and the app shows a notice when a newer release is out ([RELEASING.md](RELEASING.md)).

## Open now

### Google Cloud prerequisites

Confirm with the Google Cloud project's owner:

- Gemini Code Assist seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
- Users have IAM access on the project.
- VPC Service Controls allow `cloudcode-pa.googleapis.com`. If they don't, the account silently drops to the standard tier.
- Whether the tenant asks for account validation.
- Whether a proxy or custom CA is needed.

### Browser sign-in in ACP mode

Check on a desktop that the CLI's browser sign-in, which runs while the agent starts, writes nothing to standard output. Standard output is the protocol stream.

### The team's servers, for real

Run the Jira and GitLab containers, the SonarQube server and Snyk's server against the team's tenants. Their arguments and results were read from the servers' sources, and so far they are tested only against scripted servers.

### Linked rules in project threads

Projects are on by default (`gemini.projects.enabled`). Check in a signed-in session that thread worktrees load the repository's linked rules.

### Real-session traces

Record a Chromium profile, an extension-host profile and a CLI telemetry file (**Gemini: Record or Stop Performance Trace**) from real working sessions. They time the fork's own steps on a real account: Enter to send, rendering, the extension host's share of tool calls, and a cold start after a reboot. [FINDINGS.md](FINDINGS.md) has the timings for the agent and the model.

### Build clean-up

- Release builds leave out upstream's `extensions/copilot`. Leave it out of dev builds too.
- Trim `defaultChatAgent` in `product.json` to a stub. Removing it outright would touch about 45 upstream files.
- Hide upstream's **Welcome Onboarding 2026** developer command, which opens upstream's onboarding.

### Organisation default project

The app reads `geminiDefaultProjectId` from `product.json`, but no build sets it. If an organisation wants a default, add it to the release workflow, for example from a repository variable.

### Repository settings

- A ruleset on `main` that accepts pull requests only, requires Gemini CI's **Policy**, **Checks**, **Real CLI (bundled)** and **Compile & hygiene** jobs, and allows no bypass outside pull requests ([README](../README.md#ci)). Today it requires one approval and no checks, and the owner can bypass it.
- The owner's GitHub commit email set to the address in AGENTS.md, with **Keep my email addresses private** off for this repository's commits, so commits made on GitHub pass the Policy job.
- The `GEMINI_UPSTREAM_TOKEN` secret. Without it the upstream job cannot push an upstream move ([README](../README.md#upstream-releases)).
- The `SNYK_TOKEN` secret, which turns the Snyk job into a gate.

## Known gaps

### Fork cards, and the bar back to what started a chat

A fork's card in its parent's chat offers only Open and Try in Workspace. A thread's card in its project chat also offers the Try button's other choices, Keep Changes, Take Back, Review Changes, Discard Changes and Remove Thread. A thread's chat has a bar back to its project chat and a fork's chat a "Forked from" line, where both could have one "Started from" bar. The project's **Clean Up Folders** and Agent Setup's **Clean Up** could be one Clean Up for every merged agent.

### Pinning a page's remote reads

An agent's browser page can fetch from any site its policy allows; the platform's fetch gives no way to pin a request to the address the policy checked, so a site that redirects elsewhere is checked by its first address only.

### Sessions are never closed

gemini-cli 0.66.0 offers no `session/close`, so a long-lived agent process keeps every session it opened, a few MB each. That includes Enhance prompt's fallback sessions and hidden command sessions. GeminiCode closes sessions as soon as a CLI advertises `sessionCapabilities.close`. Until a CLI does, a process holding eight or more sessions that has served no prompt for half an hour is restarted (`agentService.ts`, `recycleIfIdle`); its chats reopen their sessions by id on their next prompt, and the status bar's menu shows the count and the last such restart.

### Stopping one shell command

Upstream's agents can stop a background shell command without ending the turn. The Gemini CLI runs shell commands itself (GeminiCode reports `terminal: false` in `clientCapabilities`, `agentConnection.ts`), and offers no way to stop one of them over ACP; only `session/cancel`, which ends the whole turn. Build it when the CLI runs commands through the client's terminals or offers a stop.

### Build files changed through the shell

"Allow for this session" approvals of task runners (`npm`, `make`, `gradle` and the like) lapse when the agent writes a build file through the editor. They do not lapse when a shell command changes one.

### Team server names

The confirm-class policy rules name the team's own servers `jira` and `gitlab`. A team that names them otherwise needs its own rules.

## Later

### Semantic search for the index

Deferred by decision: the index is lexical (BM25), symbols and grep. The cheapest local route measured so far is to re-rank `code_search`'s candidates with a small local embedding model at query time, caching chunk embeddings as they come up. It would be judged by the same real-session comparison as the index ([FINDINGS.md](FINDINGS.md#workspace-index)).

### Docs behind a sign-in

Fetch them through the built-in browser's session, which already holds the user's sign-ins.

### More platforms

Windows first: one more runner in the release workflow and a code-signing certificate. Then Intel Macs and Linux if users ask. Bring this forward when Windows users join.

### Compat CI

CI runs the real-CLI tests against the bundled, `latest` and `preview` CLI. Add `latest-1` and `nightly`, run them on a schedule, and diff the capabilities the CLI reports. A scheduled run on a machine with a seat should also make a signed-in smoke test of models and modes, which hosted CI cannot do.

### Containment

Evaluate the CLI's `--sandbox` mode as an option.

### Per-project processes

Agents in other folders share the window's project ID. Add a process per project ID when someone needs it.

### Workbench text

Reword the rest of upstream's welcome text. Only the product name in its setup walkthrough is changed so far. This needs a workbench change.

### Upstream's Agents window

At each upstream move, check whether `src/vs/sessions` has gained an extension API for agent providers. If it has, move the Agents pane onto it.

## Ideas from upstream 1.144

Upstream's 1.142 to 1.144 releases put a thinking level and the context window in the model picker for Copilot's agents. GeminiCode could offer them once the CLI offers `session/set_config_option`, which 0.66.0 does not.

## Risks

| Risk | Notes |
| --- | --- |
| Error-string coupling: error classification breaks silently when the CLI rewords a message. | Fixture tests, and showing an unknown message as it is. |
| No sandbox: safety depends on the approval mode and the tool policy. | The UI must always make the current mode obvious. |
| Upstream moves: a monthly upstream move needs a named owner. | Keeping work in the extension, marking every upstream edit, and CI's check of the patch series. |
| Build resources: a packaged Mac build takes 40 to 60 minutes on GitHub's hosted Apple silicon runner (`macos-15`), which is free only while the repository is public. | A private repository, or Windows and Linux builds, would need paid or larger runners (about 16 GB of RAM). |
