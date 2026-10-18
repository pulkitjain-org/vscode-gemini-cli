# ADR 0001: Fork VS Code as a branded app, not an extension

**Status:** accepted (restates the decision in [ARCHITECTURE.md](../ARCHITECTURE.md#decisions)).

## Context

The product owns the shell, branding, first-run flow, admin policy and the Agents layout. An extension cannot change the title bar, editor groups, menus or policy templates. The cost is a monthly upstream move.

## Decision

Ship GeminiCode as a hard fork of Code - OSS. Keep fork code in `extensions/gemini/` and fork-only workbench files under `src/vs/workbench/contrib/gemini/`; edit upstream files only at registration points, marked `GEMINI-FORK`.

## Consequences

- An upstream move every month, owned by the job in ADR 0003.
- Mac-only signed builds for now; other platforms are a non-goal until after the pilot.

## Evidence

`git diff --stat 1.141.0 HEAD` on 18 Oct 2026: 65,300 of 74,458 added lines in `extensions/gemini`; 20 modified workbench files and 5 platform files, each marked.
