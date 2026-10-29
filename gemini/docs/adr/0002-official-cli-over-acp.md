# ADR 0002: The official Gemini CLI over ACP is the only model path

**Status:** accepted on 2026-10-18, restating [ARCHITECTURE.md](../ARCHITECTURE.md#decisions) and design rule 8. Amended on 2026-10-20: GeminiCode makes one change to the CLI copies it runs, the ACP output cap in `extensions/gemini/src/acp/cliPatches.ts`, and adds the app's ripgrep beside them (`cliRipgrep.ts`) without changing a CLI file. See [Amendment](#amendment).

## Context

Sign-in, the Gemini Code Assist license and billing by project ID live in the CLI. The Gemini API SDK cannot use a Code Assist license. Patching the CLI would make every CLI release a merge.

## Decision

- Run the pinned `gemini --acp` as a child process and implement only the ACP client.
- Direct requests (inline edit, Enhance prompt, commit messages) reuse the CLI's saved sign-in and identify themselves as the CLI. When they cannot, they fall back to a CLI session.
- Never modify the CLI. Speed comes from the client side: process reuse, spare sessions, batching and caching.

## Consequences

- Behaviour that only the CLI can change, such as routing by thinking level or prefix order for caching, becomes an upstream request with a trace attached, not a patch.
- Every CLI release is re-checked by the real-CLI tests and the FINDINGS list.

## Evidence

`extensions/gemini/package.json` pins `bundledCli` 0.64.0 with its npm SHA-512, and the real-CLI tests pass against it. [FINDINGS.md](../FINDINGS.md#prompt-enhancement-direct-requests-or-the-cli): direct requests carrying the CLI's headers answered 12 of 12 on a real account, in 2.8 s at the median against 4.8 s through the CLI.

## Amendment

In ACP mode the CLI hands a tool's whole output to the model, skipping the 40,000-character cap its scheduler applies elsewhere. One large `git diff` could take an agent past the model's 1,048,576-token limit, after which every turn failed on the same history. A client cannot fix that, so `cliPatches.ts` puts the cap back on the ACP path. It is the only change to the CLI's code:

- It is applied to the bundled copy (`npm run bundle-cli`), to each copy GeminiCode installs, and at launch to older installs.
- `npm run bundle-cli` fails when the patch does not match the CLI, so an uncapped CLI is never shipped.
- A CLI the user picks (`gemini.cliPath`, `PATH`) is never patched.

The npm CLI ships no ripgrep, so `grep_search` falls back to the slower `git grep`. `cliRipgrep.ts` copies the app's ripgrep into `bundle/vendor/ripgrep/` of the bundled and installed copies, where the CLI looks for its own. No CLI file changes.

The rest of the decision stands: everything else that only the CLI can change is an upstream request.

Running the official CLI also means using its vocabulary. Where the app and the terminal do the same thing, the app uses the CLI's name, choices and keys: `/compress`, `/rewind` with its three choices, `/resume` and `/chat`, the plan approval dialog's four answers, the mode names and order the CLI sends, its `general.defaultApprovalMode` and `model.name` settings, and sessions keyed on the folder's real path, as `process.cwd()` keys them in a terminal. A user who moves between the two meets one set of words, and a CLI release that renames or adds one changes it in one place. Where ACP carries less than the terminal shows (the saved sessions, a permanent approval's scope), the app reads the CLI's own files rather than keeping a second copy.
