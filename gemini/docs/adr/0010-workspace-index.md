# ADR 0010: A local workspace index, served to agents over MCP

**Status:** accepted on 2026-10-22.

## Context

The Gemini CLI finds code by agentic search: the model calls `glob`, `grep_search`, `list_directory` or `read_file`, reads the result, and picks the next call. Each call is a model round trip that resends the CLI's prompt (about 11,900 tokens) and the conversation, and every new session rediscovers the same layout. GeminiCode can't change the CLI (ADR 0002), and can't call Gemini's embedding API with a Code Assist license, since every model call goes through the CLI.

## Decision

- An index per folder, on the Mac. Each folder an agent works in gets its own SQLite file under `~/.geminicode/index/code/<hash of its real path>/`, through `node:sqlite`. The app's Node (Electron 43, Node 24) ships it with FTS5, so no native module is needed. Worktrees get their own file, seeded from their workspace's with `VACUUM INTO`. One window writes an index (a lock with its pid); others read it.
- Lexical search and line-pattern symbols, with no embeddings yet. Chunks are cut at definitions and searched with BM25, names and paths weighted above body text, with the chunk defining a queried name first. Definitions come from per-language line patterns, not tree-sitter: the release build keeps only six tree-sitter grammars (`build/.moduleignore`), and a line scan is far faster than a parse.
- A separate process. All reading, parsing and writing runs in `dist/indexer.js`, forked with the app's Node at the lowest priority on first use and stopped after ten idle minutes. The extension host only forwards requests.
- Delivery over MCP. A fourth local server, `geminicode-index`, gives each session `code_search`, `find_symbol`, `related_files`, `repo_map` and `docs_search`, with one route and token per agent bound to its folder, and a short outline of the folder in its instructions. It is always allowed, like GeminiCode's other servers.
- Docs from URLs. They are fetched in the extension host, so the Mac's proxy and certificates apply, then converted to Markdown and stored once per source in the indexer process, and attached to folders.

## Consequences

- One tool call answers "where is X" or "what uses Y", where the CLI alone takes several.
- The CLI loads MCP servers only in trusted folders, so untrusted folders don't get the tools; the Index page says so.
- The model may still prefer `grep_search`. The tool descriptions, the server's instructions and a hint sent with a session's first prompt once the folder's index is built (`indexHint` in `workspaceIndex.ts`) steer it. The CLI's own tools stay available.
- Semantic search can be added later as another column and a hybrid rank, without changing the store's shape or the tools.

## Evidence

`extensions/gemini/src/acp/index/` and `src/acp/docs/` with their tests in `test/acp/index/` and `test/acp/docs/`; measurements in [FINDINGS.md](../FINDINGS.md#workspace-index).
