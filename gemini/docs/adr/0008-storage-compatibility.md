# ADR 0008: Settings and storage formats are a versioned contract

**Status:** accepted on 2026-10-18.

## Context

The fork's own code may be rewritten, but existing team members must keep their settings, saved agents, transcripts, checkpoints, tokens and `.gemini/geminicode-tools.json`.

## Decision

These are a contract:

- the `gemini.*` settings keys;
- `chatProtocolVersion`;
- the transcript and checkpoint file formats;
- the agent records in global state;
- the SecretStorage keys;
- the team defaults file, `.gemini/geminicode-tools.json`.

A change adds a version, reads the old form and writes the new one, with a unit test for the migration. Removing a key needs a release note and one release of deprecation.

## Consequences

- Rewrites are internal; nothing a user set or saved is lost or renamed without a migration.

## Evidence

`extensions/gemini/src/host/chatProtocol.ts` (`chatProtocolVersion`); `src/acp/transcriptStore.ts`, `checkpointStore.ts` and `agents.ts`; the migration tests added with each change.
