# ADR 0008: Settings, policy names and storage formats are a versioned contract

**Status:** proposed.

## Context

The fork's custom code may be rewritten, but existing team members keep their settings, saved agents, transcripts, checkpoints, tokens and `.gemini/geminicode-tools.json`.

## Decision

The `gemini.*` settings keys, the policy names in `product.json`, `chatProtocolVersion`, the transcript and checkpoint file formats, the agent records in global state, the SecretStorage keys and the team defaults file are a contract. A change adds a version, reads the old form and writes the new one, with a unit test for the migration. Removing a key needs a release note and one release of deprecation.

## Consequences

- Rewrites are internal; nothing a user set or saved is lost or renamed without a migration.

## Evidence

`extensions/gemini/src/host/chatProtocol.ts` (`chatProtocolVersion`), `transcriptStore.ts`, `checkpointStore.ts`, `agents.ts`; the migration tests added with each change.
