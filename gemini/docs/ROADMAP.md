# Roadmap

What is left before and after the pilot. The design that is already built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Before the pilot

- **Google Cloud prerequisites.** Confirm these with the admin of the pilot project:
  - Gemini Code Assist seats are assigned and `cloudaicompanion.googleapis.com` is enabled.
  - Users have IAM access on the project.
  - VPC Service Controls allow `cloudcode-pa.googleapis.com`. If they don't, the account silently drops to the standard tier.
  - Whether the tenant asks for account validation.
  - Whether a proxy or custom CA is needed.
- **Signed sign-in check.** On a desktop, verify the browser sign-in flow in ACP mode, and that it never writes to stdout.
- **Compat CI.** Run `initialize` against `latest`, `latest-1`, `preview` and `nightly`, and diff the reported capabilities. A scheduled job on a machine that holds a seat should also run a signed-in smoke test of models and modes, because hosted CI cannot sign in.
- **Pilot builds.** Produce packaged, branded builds for the pilot platforms, signed when the Apple Developer ID and Windows code-signing certificates are in hand. Regenerate the policy templates (`policyData.jsonc`), which need a built app. Stop shipping upstream's `extensions/copilot`, and trim `defaultChatAgent` to a stub.
- **Pilot.** Collect feedback on sign-in, approvals, attached context and the agent workspace.

## After the pilot

- **Distribution.** Ship macOS on Apple silicon first, signed with an individual Apple Developer ID and notarised, from GitHub Releases, with a download page on GitHub Pages. Bundle a known-good CLI in the app and show a notice when a newer GeminiCode is out. Windows comes later.
- **Workbench work.** Order the activity bar so the Gemini sidebar comes first, and reword upstream's welcome text. Both need workbench changes.
- **Containment.** Evaluate the CLI's `--sandbox` mode as an admin option.
- **Idle processes.** gemini-cli cannot close a session, so a long-lived process keeps every session it opened (about 2.5 MB each). Restart idle processes to free them, and show in the pane when an agent's process was stopped.
- **Per-project processes.** Agents in other folders share this window's project ID today. Add a process per project ID when someone needs it.
- **Upstream Agents window.** At each upstream merge, check whether `src/vs/sessions` gained an extension API for agent providers. If it has, move the Agents pane onto it.

## Risks

- **Error-string coupling.** Error classification breaks silently when the CLI rewords a message. Fixture tests and the raw-message fallback limit the damage.
- **No sandbox.** Safety depends on the approval mode and admin policy, so the UI must always make the current mode obvious.
- **Upstream merges.** A monthly upstream merge needs a named owner. Keeping work in the extension and marking every upstream edit are the main controls.
- **Build resources.** Full packaged builds need large CI runners (about 16 GB of RAM) and an ARM64 macOS runner.
