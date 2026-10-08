# Roadmap

What is left before and after the pilot. The design that is already built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

Distribution is done: release builds for Mac (Apple silicon) with the bundled Gemini CLI, published to GitHub Releases, the download page, and the in-app update notice ([RELEASING.md](RELEASING.md)). Releases have shipped since `v0.1.0`; the current one is 0.4.0. What remains of distribution is listed below: signing before the pilot, and other platforms and auto-update after it.

## Before the pilot

- **Google Cloud prerequisites.** Confirm these with the admin of the pilot project:
  - Gemini Code Assist seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
  - Users have IAM access on the project.
  - VPC Service Controls allow `cloudcode-pa.googleapis.com`. If they don't, the account silently drops to the standard tier.
  - Whether the tenant asks for account validation.
  - Whether a proxy or custom CA is needed.
- **Signed sign-in check.** On a desktop, verify the browser sign-in flow in ACP mode, and that it never writes to stdout.
- **Compat CI.** CI already runs the real-CLI tests (`initialize`, the sign-in-required path and the admin policy) against `latest` and `preview`. Left: add `latest-1` and `nightly`, run it on a schedule, and diff the reported capabilities. A scheduled job on a machine that holds a seat should also run a signed-in smoke test of models and modes, because hosted CI cannot sign in.
- **Signed releases.** Add the six Apple secrets ([RELEASING.md](RELEASING.md#apple-setup)) so release builds are signed with the Developer ID and notarised, then cut a new release. Until then each pilot user has to approve the app in **Privacy & Security** on first launch, and managed Macs may block it. The workflow already signs and notarises whenever the secrets are present.
- **Pilot build clean-up.** Regenerate the policy templates (`policyData.jsonc`), which need a built app, so the templates admins deploy include the Gemini settings. Release builds already leave out upstream's `extensions/copilot` (upstream ships it from a prebuilt package its own pipeline makes); remove it from dev builds too, and trim `defaultChatAgent` to a stub.
- **Organisation default project.** The app reads `geminiDefaultProjectId` from `product.json`, but no build sets it yet. Add it to the release workflow (for example from a repository variable) if the pilot organisation wants one.
- **Pilot.** Collect feedback on sign-in, approvals, attached context and the agent workspace.

## After the pilot

- **More platforms.** Windows (one more runner in the release workflow and a code-signing certificate), then Intel Macs and Linux if pilot users ask for them. Bring this forward if the pilot includes Windows users.
- **Auto-update.** Today the update notice only links to the download page. Upstream's updater needs a server that answers per build, which a static GitHub Pages site cannot do, so full auto-update needs a small update server.
- **Workbench work.** Reword the rest of upstream's welcome text (only the product name in its setup walkthrough is changed). This needs a workbench change.
- **Containment.** Evaluate the CLI's `--sandbox` mode as an admin option.
- **Idle processes.** gemini-cli cannot close a session, so a long-lived process keeps every session it opened (about 2.5 MB each). Restart idle processes to free them, and show in the pane when an agent's process was stopped.
- **Per-project processes.** Agents in other folders share this window's project ID today. Add a process per project ID when someone needs it.
- **Upstream Agents window.** At each upstream merge, check whether `src/vs/sessions` gained an extension API for agent providers. If it has, move the Agents pane onto it.

## Risks

- **Error-string coupling.** Error classification breaks silently when the CLI rewords a message. Fixture tests and the raw-message fallback limit the damage.
- **No sandbox.** Safety depends on the approval mode and admin policy, so the UI must always make the current mode obvious.
- **Upstream merges.** A monthly upstream merge needs a named owner. Keeping work in the extension and marking every upstream edit are the main controls.
- **Build resources.** A packaged Mac build takes 40 to 60 minutes on GitHub's hosted Apple silicon runner (`macos-15`), which is free only while the repository is public. A private repository, or Windows and Linux builds, would need paid or larger runners (about 16 GB of RAM).
