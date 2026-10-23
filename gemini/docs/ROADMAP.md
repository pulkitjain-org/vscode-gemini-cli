# Roadmap

What is still open, before and after the pilot. What is built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

GeminiCode ships as a Mac app for Apple silicon with the Gemini CLI bundled, from GitHub Releases and its download page, with an in-app notice when a newer release is out ([RELEASING.md](RELEASING.md)).

## Before the pilot

- **Google Cloud prerequisites.** Confirm with the admin of the pilot project:
  - Gemini Code Assist seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
  - Users have IAM access on the project.
  - VPC Service Controls allow `cloudcode-pa.googleapis.com`. If they don't, the account silently drops to the standard tier.
  - Whether the tenant asks for account validation.
  - Whether a proxy or custom CA is needed.
- **Signed releases.** Add the six Apple secrets ([RELEASING.md](RELEASING.md#apple-setup)) so release builds are signed with the Developer ID and notarised, then cut a release. Until then each user approves the app in **Privacy & Security** on first launch, and managed Macs may block it. The workflow signs and notarises whenever the secrets are present.
- **The browser sign-in in ACP mode.** Check on a desktop that the CLI's browser sign-in, run while the agent starts, writes nothing to standard output, which is the protocol stream.
- **The team's servers, for real.** Run the Jira and GitLab containers, the SonarQube server and Snyk's server against the team's tenants. Their arguments and results were read from the servers' sources and are tested against scripted servers only.
- **Real-session traces.** A Chromium profile, an extension-host profile and a CLI telemetry file (**Gemini: Record or Stop Performance Trace**) from real working sessions, to time the fork's own hops on a real account: Enter to send, rendering, the extension host's share of tool calls, and a cold start after a reboot. [FINDINGS.md](FINDINGS.md) has the agent's and the model's.
- **Pilot build clean-up.**
  - Regenerate the policy templates (`policyData.jsonc`), which need a built app, so the templates admins deploy include the Gemini settings.
  - Release builds leave out upstream's `extensions/copilot`; leave it out of dev builds too.
  - Trim `defaultChatAgent` in `product.json` to a stub. Removing it outright would touch about 45 upstream files.
  - Hide upstream's **Welcome Onboarding 2026** developer command, which still opens upstream's onboarding.
- **Organisation default project.** The app reads `geminiDefaultProjectId` from `product.json`, but no build sets it. Add it to the release workflow, for example from a repository variable, if the pilot organisation wants one.
- **Repository settings.** Branch protection that requires Gemini CI on `main`, its three `Gemini extension` jobs included; the `GEMINI_UPSTREAM_TOKEN` secret, without which the upstream job cannot push an upstream move ([README](../README.md#upstream-releases)); the `SNYK_TOKEN` secret, which turns the Snyk job into a gate.
- **Pilot.** Three developers for two weeks, with the pilot's admin profile ([pilot/README.md](../pilot/README.md)) and `gemini.pilot.record` on, then **Gemini: Export Pilot Data** from each Mac.

## Known gaps

- **Workspaces opened through a symbolic link.** The CLI keys a folder's chats by the path it is given, and the terminal always gives the real path, so in a workspace opened through a link, chats started in the terminal are saved under another key, and **Pick Up a Gemini CLI Session** does not find them ([FINDINGS.md](FINDINGS.md#reopening-a-session-sessionload)). Running every session on the folder's real path would fix it, but chats saved under the linked path would then need a migration.
- **Sessions are never closed.** gemini-cli 0.64.0 offers no `session/close`, so a long-lived agent process keeps every session it opened, a few MB each, including Enhance prompt's fallback sessions and hidden command sessions. GeminiCode closes sessions as soon as a CLI advertises `sessionCapabilities.close`. Until then, restart idle processes to free them, and show in the pane when an agent's process was stopped.
- **Build files changed through the shell.** "Allow for this session" approvals of task runners (`npm`, `make`, `gradle` and the like) lapse when the agent writes a build file through the editor, but not when a shell command changes one.
- **Team server names.** The confirm-class policy rules name the team's own servers as `jira` and `gitlab`; a team that names them otherwise needs its own rules.
- **A large file.** `agentsView.ts` (about 2,400 lines) holds several jobs; split it along its seams (tree data, the panels, persistence, worktrees and Projects, the spare session) before it grows further, as `chatController.ts` was split into `src/host/chat/`.

## After the pilot

- **Semantic search for the index.** Deferred by decision: the index is lexical (BM25), symbols and grep. The cheapest local route measured so far is re-ranking `code_search`'s candidates with a small local embedding model at query time, caching chunk embeddings as they come up, judged by the same real-session comparison as the index ([FINDINGS.md](FINDINGS.md#workspace-index)).
- **Docs behind a sign-in.** Fetch them through the built-in browser's session, which already holds the user's sign-ins.
- **Ripgrep in signed releases.** Check that the release's signing signs the `rg` binaries added to the bundled CLI (`bundle/vendor/ripgrep/`) before notarisation.

- **More platforms.** Windows (one more runner in the release workflow and a code-signing certificate), then Intel Macs and Linux if pilot users ask. Bring this forward if the pilot includes Windows users.
- **Auto-update.** The update notice links to the download page. Upstream's updater needs a server that answers per build, which a static GitHub Pages site cannot be, so full auto-update needs a small update server.
- **Compat CI.** CI runs the real-CLI tests against the `latest` and `preview` CLI. Add `latest-1` and `nightly`, run it on a schedule, and diff the capabilities the CLI reports. A scheduled run on a machine with a seat should also make a signed-in smoke test of models and modes, which hosted CI cannot do.
- **Containment.** Evaluate the CLI's `--sandbox` mode as an admin option.
- **Per-project processes.** Agents in other folders share the window's project ID. Add a process per project ID when someone needs it.
- **Projects out of preview.** Check that thread worktrees load the linked rules in a signed-in session, then turn `gemini.projects.enabled` on by default.
- **Workbench text.** Reword the rest of upstream's welcome text; only the product name in its setup walkthrough is changed. This needs a workbench change.
- **Upstream's Agents window.** At each upstream move, check whether `src/vs/sessions` gained an extension API for agent providers; if it has, move the Agents pane onto it.

## Ideas from upstream 1.142

Upstream's 1.142 release shipped these for Copilot's agents; each could be built on what GeminiCode has:

- **Move a chat to a new worktree.** Start a branch and worktree from a running chat and carry the conversation over, as an agent's own branch does at start, using the conversation hand-over a new session already gets.
- **Stop a background shell command.** A control on a long-running command's row that cancels it without ending the turn.
- **Thinking level and context window in the model picker.** Needs the CLI to offer `session/set_config_option`, which 0.64.0 does not.
- **Permission modes as separate policies.** Upstream now lets an admin allow or remove each permission mode on its own, as GeminiCode's `GeminiAllowAutoEdit` and `GeminiAllowYolo` already do; follow its naming if it settles.

The merge itself brought upstream's Markdown editor (pasting images, renaming links, an outline and breadcrumbs, copying code blocks), `editor.occurrencesHighlightFromAllProviders`, and many fixes for leaks.

## Risks

- **Error-string coupling.** Error classification breaks silently when the CLI rewords a message. Fixture tests and showing an unknown message as it is limit the damage.
- **No sandbox.** Safety depends on the approval mode and the admin policy, so the UI must always make the current mode obvious.
- **Upstream moves.** A monthly upstream move needs a named owner. Keeping work in the extension, marking every upstream edit and the patch series' CI check are the controls.
- **Build resources.** A packaged Mac build takes 40 to 60 minutes on GitHub's hosted Apple silicon runner (`macos-15`), which is free only while the repository is public. A private repository, or Windows and Linux builds, would need paid or larger runners (about 16 GB of RAM).
