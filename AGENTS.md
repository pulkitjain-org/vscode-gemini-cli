# Agents Instructions

This file gives instructions to AI coding agents working in this repository.

## GeminiCode fork

This repository is GeminiCode, a fork of VS Code with the Gemini CLI built in. Most fork work happens in `extensions/gemini/`.

- Read [gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md) first. Follow its design rules: `src/acp` never imports `vscode`, model and mode IDs are never hardcoded, and the Gemini CLI is never patched.
- Edit upstream files only at registration points, and mark each edit with a `GEMINI-FORK` comment ([gemini/README.md](gemini/README.md)).
- To validate a change to the extension, run `npx eslint --max-warnings 0 extensions/gemini`, then, in `extensions/gemini`, `npm run typecheck-tests`, `npx tsc -p webview-src/tsconfig.json` and `npm test`.
- If you change messages between the chat view and its webview (`src/host/chatProtocol.ts`), bump `chatProtocolVersion`.

## Upstream VS Code code

For upstream's overview, architecture, coding guidelines and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
