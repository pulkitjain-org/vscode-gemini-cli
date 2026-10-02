# GeminiCode fork

This repository is a hard fork of [microsoft/vscode](https://github.com/microsoft/vscode) that integrates the Gemini CLI as a built-in agent over the Agent Client Protocol (ACP).

- [docs/PLAN.md](docs/PLAN.md): the build plan (rev 3).
- `../extensions/gemini/`: the built-in Gemini extension (ACP client, host UI, fake agent for tests).
- [scripts/list-fork-touches.sh](scripts/list-fork-touches.sh): lists every upstream file the fork changes. Run it before each upstream merge.

## Rules for touching upstream files

Edit upstream files only at registration points (`product.json`, the build lists that register built-in extensions, and later the workbench contribution list). Mark every such edit with a `GEMINI-FORK` comment. JSON files and icons cannot carry a marker, so `list-fork-touches.sh <upstream-ref>` also diffs against upstream.

## Upstream

The fork tracks upstream `main` as of 1.141.0-dev. Add the remote once:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags
```

Upstream bumps are merges of a release tag (`git merge 1.141.0`), never rebases.

## Dev loop

```sh
nvm use            # Node from .nvmrc
npm ci
npm run watch
./scripts/code.sh  # launches the branded dev build with the Gemini extension
```

Gemini extension unit tests: `cd extensions/gemini && npm test`. Set `GEMINI_CLI_PATH` to a Gemini CLI (its `gemini` executable or `bundle/gemini.js`) to also run the real `initialize` check.
