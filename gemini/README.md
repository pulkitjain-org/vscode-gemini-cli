# Maintaining the GeminiCode fork

This folder holds fork material that is not shipped: docs, icon sources and maintainer scripts. The product code is in [`../extensions/gemini/`](../extensions/gemini/).

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how GeminiCode works and why.
- [docs/FINDINGS.md](docs/FINDINGS.md): Gemini CLI behaviour and measurements the design relies on.
- [docs/ROADMAP.md](docs/ROADMAP.md): open work and risks.
- [branding/](branding/): icon sources.
- [scripts/list-fork-touches.sh](scripts/list-fork-touches.sh): lists every upstream file the fork changes.

## Developing

```sh
nvm use                  # Node from .nvmrc
npm ci
npm run watch            # keep running; rebuilds the workbench, extensions and the chat webview
./scripts/code.sh        # launches the branded dev build
```

The Gemini extension on its own:

```sh
cd extensions/gemini
npm test                 # Vitest unit tests
npm run typecheck-tests
npx tsc -p webview-src/tsconfig.json
```

The tests run against a scripted fake ACP agent. To also run the real-CLI tests (the `initialize` handshake and admin policy), set `GEMINI_CLI_PATH` to a Gemini CLI, either its `gemini` executable or its `bundle/gemini.js`.

If the chat view warns that its script is out of date, the webview bundle in `media/` is older than the extension. Run `npm run gulp compile-extension-media`, or keep `npm run watch` running, then reload the window.

## CI

[`gemini-ci.yml`](../.github/workflows/gemini-ci.yml) runs on pull requests and pushes to `main`. It does three things:

- It lints and hygiene-checks the fork files.
- It builds and type-checks the extension and webview, then runs the unit tests and real-CLI tests against the `latest` and `preview` CLI.
- It compiles the whole fork and runs upstream's hygiene check.

It does not produce packaged builds yet.

## Touching upstream files

Keep fork code in `extensions/gemini/`. Edit an upstream file only to register the extension, rebrand, or do something the extension API cannot, and mark the edit with a `GEMINI-FORK` comment. JSON files and icons cannot carry a marker, so the script also diffs against upstream:

```sh
gemini/scripts/list-fork-touches.sh upstream/main
```

Its output is the checklist for each upstream merge.

## Upstream merges

The fork branched from upstream `main` at 1.141.0-dev (1 Oct 2026). Add the remote once:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags
```

Bring upstream in by merging a release tag (`git merge 1.141.0`), never by rebasing, so every merge stays three-way. After each merge:

1. Re-check every file that `list-fork-touches.sh` lists.
2. Check whether upstream's Agents window (`src/vs/sessions`) gained an extension API for agent providers ([ROADMAP.md](docs/ROADMAP.md)).
3. Run the extension tests and the full compile.
