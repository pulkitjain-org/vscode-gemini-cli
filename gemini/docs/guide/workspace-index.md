# Workspace index and docs

Agents in GeminiCode keep an index of the code in each workspace, and of the documentation you attach, so they can find code in one step instead of searching file by file. The index stays on your Mac, in `~/.geminicode/index`, and is built in a separate process at low priority, so it never slows the editor.

Open it from **Index** on Home, beside Project Helpers, or with **Gemini: Manage Index**. Beside the workspace in Home's composer, a drum icon shows the workspace's index: full when it is indexed, half full while indexing, empty when it isn't indexed yet. Point at it for which, and click it to open the Index page.

## What agents get

Every agent's session gets the `geminicode-index` tools for the folder it works in:

- **code_search** returns the best-matching code for words, a name in any case (`applyDiscount`, `apply_discount`) or a short description. A result is a whole function or class where possible, with its path and line numbers.
- **find_symbol** says where a function, method, class or type is defined, with its first line, and optionally every line that uses it. Use `Container.name` for a method.
- **related_files** lists a file's imports, the files that import it, its tests, and the files most often changed in the same commits.
- **repo_map** outlines the folder or a subfolder: what the project says it is, its languages, its folders and the public definitions in each.
- **docs_search** searches the documentation attached to the workspace, when it has some.

Each session also starts with a short outline of the folder, so the agent knows its way around before its first search. In the chat the calls read as "Search code for …", "Look up …" and so on.

An agent only uses the tools in a folder the Gemini CLI trusts. The Index page says when a workspace isn't trusted, with **Trust Folder**.

## Workspaces

Each workspace has its own index, and an agent's own branch (its worktree) starts from a copy of its workspace's index, so it is ready at once. Indexes never mix, and two GeminiCode windows on one folder share one index that only one of them writes.

A workspace's index is built the first time an agent starts there. Until it is ready, the tools answer from a plain text search and say so. Change when indexes are built with `gemini.index.buildOn`: when an agent starts (the default), when the window opens, or only when you choose **Index Now**.

After that the index keeps itself up to date: saved, added and deleted files a second after you change them, a checkout or pull when the branch moves, and an agent's edits in its worktree as it makes them.

Left out of every index: files git ignores, entries in `.geminiignore`, secret files such as `.env` and keys, binaries, lock files, minified code and files over 1 MB. Add your own exclusions with `gemini.index.exclude`, in `.gitignore` syntax.

**Files Left Out** opens a list of them, grouped by reason, with a filter. **Index Anyway** on a file adds it to `gemini.index.include`, and it is indexed a moment later without a rebuild; **Index All Anyway** does it for a whole group of up to 50 files. For more, add a pattern such as `src/generated/**` with **Edit Included Files**. Included files are indexed even if they are generated or minified, are lock files, are listed in `.geminiignore` or `gemini.index.exclude`, or are larger than the size limit (up to 16 MB). Secret files and files with binary content are never indexed. **Open .geminiignore** opens (or creates) the folder's ignore file, which the Gemini CLI reads too.

For each workspace the page shows its state and size, with:

- **Index Now**, for a workspace without an index.
- **Rebuild**, to start its index again from scratch.
- **Pause** and **Resume**, while a build runs.
- The trash icon, to remove the index. The next agent that starts there builds a new one.

The status bar shows **Indexing N%** while a large build runs; small updates never show.

## Docs

Attach a library's documentation and agents search it with `docs_search` instead of fetching pages from the web.

1. Choose **Add Docs**, or **Add** on a suggestion.
2. Enter the address, such as `https://react.dev/reference`.
3. Choose what to fetch: only that page, the pages under that address, or the whole site. GeminiCode uses the site's `llms.txt` or sitemap when it has one, and otherwise follows links under the address.
4. Pick how many pages at most, how often to refresh, and which workspaces can search it.

Pages are fetched from your Mac, through its network settings, and stored once however many workspaces use them. Fetching respects the site's `robots.txt`. A page that needs you to sign in is reported rather than stored; pages behind a sign-in aren't supported yet. Fetched pages are treated as reference material, never as instructions.

Each source refreshes daily by default (`gemini.docs.refresh`, or per source); a page that hasn't changed costs one small request. The switch on a source detaches it from the workspace without deleting it.

**Suggested from your dependencies** offers the documentation of libraries your `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `build.gradle` names, for the version you use. The list ships with GeminiCode; nothing is looked up.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gemini.index.enabled` | on | Keep indexes and give agents the index tools. |
| `gemini.index.buildOn` | `agentStart` | When a workspace's index is first built. |
| `gemini.index.exclude` | empty | Extra files and folders to leave out, in `.gitignore` syntax. |
| `gemini.index.include` | empty | Files to index even though they would be left out, in `.gitignore` syntax. |
| `gemini.index.maxFileSizeKb` | 1024 | Larger files are left out. |
| `gemini.docs.enabled` | on | Allow attaching documentation from the web. |
| `gemini.docs.allowedDomains` | empty | The only sites docs may come from, such as `react.dev` or `*.example.com`. Empty allows any. |
| `gemini.docs.refresh` | `daily` | How often attached docs are fetched again. |

An administrator can lock `gemini.index.enabled`, `gemini.docs.enabled` and `gemini.docs.allowedDomains` as policies.
