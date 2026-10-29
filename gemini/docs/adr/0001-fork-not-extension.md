# ADR 0001: Fork VS Code as a branded app, not an extension

**Status:** accepted on 2026-10-18. It restates the decision in [ARCHITECTURE.md](../ARCHITECTURE.md#decisions).

## Context

The product owns the shell, the branding, the first-run flow, the admin policy and the Agents layout. An extension cannot change the title bar, editor groups, menus or policy templates. A fork can, at the cost of a monthly upstream move.

## Decision

Ship GeminiCode as a hard fork of Code - OSS. Keep fork code in `extensions/gemini/`, and fork-only workbench files under `src/vs/workbench/contrib/gemini/`. Edit upstream files only at registration points, and mark each edit `GEMINI-FORK`.

## Consequences

- An upstream move every month, owned by the job in ADR 0003.
- Mac builds only; other platforms are a non-goal until after the pilot.

## Evidence

`git diff --shortstat 1.142.0 HEAD`, when this was written: 71,947 of 100,364 added lines were in `extensions/gemini`, with 21 modified workbench files and 5 platform files, each marked.
