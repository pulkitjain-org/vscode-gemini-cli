# Contributing to GeminiCode

Thanks for helping. GeminiCode is a fork of VS Code, so most of this repository is upstream code. This guide covers the parts that are specific to the fork.

## Reporting issues

Search the [existing issues](https://github.com/pulkitjain-org/vscode-gemini-cli/issues) first. If you open a new one, include:

- the GeminiCode version (**Help > About**) and the Gemini CLI version (hover over the **Gemini** status bar item);
- what you did, what you expected, and what happened;
- the relevant lines from **Gemini: Show Log**, with account names and project IDs removed.

If a problem also happens in VS Code without GeminiCode's changes, report it to [microsoft/vscode](https://github.com/microsoft/vscode/issues) instead. Report security problems as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Changing code

1. Read [gemini/docs/ARCHITECTURE.md](gemini/docs/ARCHITECTURE.md). The [design rules](gemini/docs/ARCHITECTURE.md#design-rules) are the ones reviewers check.
2. Put new code in `extensions/gemini/`. Edit an upstream file only when the extension API cannot do the job, and mark the edit with a `GEMINI-FORK` comment (see [gemini/README.md](gemini/README.md)).
3. Keep `extensions/gemini/src/acp` free of `vscode` imports. Test what you add there against the fake agent in `extensions/gemini/test/fake-agent`.
4. Put user-facing strings in `vscode.l10n.t(...)` or `package.nls.json`. Never hardcode model or mode IDs.

Before you open a pull request, run the same checks as CI:

```sh
npx eslint --max-warnings 0 extensions/gemini
cd extensions/gemini
npm run typecheck-tests
npx tsc -p webview-src/tsconfig.json
npm test
```

Follow upstream's [coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines): tabs, single quotes for code strings, double quotes for user-facing strings, and arrow functions.
