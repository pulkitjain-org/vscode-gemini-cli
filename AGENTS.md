# GeminiCode fork

This repository is GeminiCode, a fork of VS Code with the Gemini CLI built in. Before changing anything, read [gemini/README.md](gemini/README.md) and the [design rules](gemini/docs/ARCHITECTURE.md#design-rules). In short:

- Put new code in `extensions/gemini/`. Edit an upstream file only when the extension API cannot do the job, and mark the edit with a `GEMINI-FORK` comment.
- Never modify the Gemini CLI itself. Performance and response time come first.
- Before a pull request, run the checks in [gemini/README.md](gemini/README.md#developing).

The upstream instructions below still apply to upstream code.

# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
