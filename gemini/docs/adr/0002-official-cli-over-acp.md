# ADR 0002: The official Gemini CLI over ACP is the only model path

**Status:** accepted (restates [ARCHITECTURE.md](../ARCHITECTURE.md#decisions) and design rule 8).

## Context

Sign-in, the Gemini Code Assist license and the project-ID billing live in the CLI. The Gemini API SDK cannot use a Code Assist license. Patching the CLI would make every CLI release a merge.

## Decision

Run the pinned `gemini --acp` as a child process and implement only the ACP client. Direct requests (inline edit, Enhance prompt, commit messages) reuse the CLI's saved sign-in and identify themselves as the CLI, and fall back to a CLI session. Never modify the CLI. Speed comes from process reuse, spare sessions, batching and caching on the client side.

## Consequences

- Behaviour that only the CLI can change (routing thinking level, prefix order for caching) becomes an upstream request with a trace attached, not a patch.
- Every CLI release is re-checked by the real-CLI tests and the FINDINGS list.

## Evidence

`extensions/gemini/package.json` pins `bundledCli` 0.64.0 with its npm SHA-512, and the real-CLI tests pass against it. [FINDINGS.md](../FINDINGS.md#prompt-enhancement-direct-requests-or-the-cli): direct requests carrying the CLI's headers answered 12 of 12 on a real account, in 2.8 s at the median against 4.8 s through the CLI.
