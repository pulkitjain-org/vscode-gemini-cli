/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A version per prompt GeminiCode writes for the model, bumped when its
// wording changes, so a benchmark result or a trace says which wording it
// measured and two runs can be compared. The benchmark records them
// (`BenchSummary.promptVersions`); nothing else reads them.

export const promptVersions = {
	/** The turn's content around the user's message (turnContent.ts) and the notes it carries. */
	turn: 1,
	/** Review Changes and the merge request review (reviewPrompt.ts, teamFlowLogic.ts). */
	review: 1,
	/** A project's coordinator wake and its threads' briefs (projectHub.ts). */
	project: 1,
	/** Research's planner and workers (research.ts). */
	research: 1,
	/** Prompt enhancement (promptEnhancer.ts) and the quick edits (quickPrompts.ts). */
	enhance: 1,
} as const;

export type PromptVersions = typeof promptVersions;
