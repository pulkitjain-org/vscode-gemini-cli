/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's exit_plan_mode tool. At the end of a Plan mode turn some
// models call it to ask for the plan's approval. Over ACP the CLI sends that as
// a plain permission request with Allow and Reject, titled with the plan file's
// full path, and Allow leaves Plan mode for Default and starts building at once.
// GeminiCode approves plans itself, with Approve Plan under the reply and its
// choices of mode, so it declines the CLI's request without a card (the session
// stays in Plan mode and the turn ends with the plan), and shows the step as the
// plan being ready, named by its file alone, rather than as a failure.
//
// The request carries no tool name, only the CLI's display title, so the title
// is what identifies it.

import type * as acp from '@agentclientprotocol/sdk';
import type { InstantAnswer } from './permissions';

/**
 * Sent with each Plan mode turn, so the model ends its turn with the plan
 * rather than asking the CLI, which GeminiCode would decline.
 */
export const planModeNote = 'You are in Plan mode. The user approves your plan with the Approve Plan button under your reply, so do not call exit_plan_mode: write the plan, then end your turn.';

const planApprovalPrefix = 'Requesting plan approval for:';
/** The title GeminiCode gives the step, which a later update without a title of its own keeps. */
const planReadyPrefix = 'Plan ready for review:';

/** The plan file a title of the CLI's exit_plan_mode names, or undefined for any other tool. */
export function planApprovalFile(title: string | undefined | null): string | undefined {
	if (!title?.startsWith(planApprovalPrefix)) {
		return undefined;
	}
	const filePath = title.slice(planApprovalPrefix.length).trim();
	return filePath || undefined;
}

/** For the CLI's request to approve a plan: its Reject option, answered with no card. */
export function planApprovalAnswer(request: acp.RequestPermissionRequest): InstantAnswer | undefined {
	if (planApprovalFile(request.toolCall.title) === undefined) {
		return undefined;
	}
	const reject = request.options.find(option => option.kind === 'reject_once') ?? request.options.find(option => option.kind === 'reject_always');
	return reject ? { optionId: reject.optionId, quiet: true } : undefined;
}

/** The plan file's name, from the full path the CLI gives. */
function fileName(filePath: string): string {
	const parts = filePath.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? filePath;
}

/**
 * The title and status a plan approval step shows: "Plan ready for review",
 * with the file's name, and done rather than failed when declined. Undefined
 * for any other tool. Tool titles are the CLI's, in English, and so is this one.
 */
export function planApprovalStep(title: string | undefined | null, status: acp.ToolCallStatus): { readonly title: string; readonly status: acp.ToolCallStatus } | undefined {
	const done = status === 'failed' ? 'completed' : status;
	if (title?.startsWith(planReadyPrefix)) {
		return { title, status: done };
	}
	const filePath = planApprovalFile(title);
	if (filePath === undefined) {
		return undefined;
	}
	return { title: `${planReadyPrefix} ${fileName(filePath)}`, status: done };
}
