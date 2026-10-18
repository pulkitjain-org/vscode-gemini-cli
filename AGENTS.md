# GeminiCode fork

This repository is GeminiCode, a fork of VS Code with the Gemini CLI built in. Before changing anything, read [gemini/README.md](gemini/README.md) and the [design rules](gemini/docs/ARCHITECTURE.md#design-rules). In short:

- Put new code in `extensions/gemini/`. Edit an upstream file only when the extension API cannot do the job, and mark the edit with a `GEMINI-FORK` comment.
- Never modify the Gemini CLI itself. Performance and response time come first.
- Before a pull request, run the checks in [gemini/README.md](gemini/README.md#developing).

## Commits, comments and pull requests

- Every commit is authored and committed by the repository's git user, Pulkit Jain <er.pulkit@gmail.com>. Set `user.name` and `user.email` to that before committing; never commit as a tool or a bot.
- No commit message, code comment, review comment or pull request description names an AI tool or carries a tool's trailer or footer. Write them the way a developer on the team would: what changed and why, nothing about how it was written.
- The checked-in docs follow the same rule.

The upstream instructions below still apply to upstream code.

# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
