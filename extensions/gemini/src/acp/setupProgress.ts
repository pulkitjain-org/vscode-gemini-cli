/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How far first-run setup has got, read from the agent's status so the
// walkthrough ticks itself off. Each step stays done once reached, even if the
// agent later restarts.

import type { AgentStatus } from './status';

export interface SetupProgress {
	/** The CLI started and answered `initialize`. */
	readonly cliReady: boolean;
	/** The CLI accepted the user's Google sign-in. */
	readonly signedIn: boolean;
	/** A session opened, so the license and project are in order. */
	readonly projectReady: boolean;
}

export const noSetupProgress: SetupProgress = { cliReady: false, signedIn: false, projectReady: false };

export function advanceSetupProgress(previous: SetupProgress, status: AgentStatus): SetupProgress {
	const kind = status.phase === 'error' ? status.error?.kind : undefined;
	const ready = status.phase === 'ready';
	// Only a CLI that is running can ask for a project or for sign-in.
	const projectMissing = kind === 'project-id-required' || kind === 'project-id-numeric';
	const signedIn = ready || projectMissing;
	const cliReady = signedIn || kind === 'auth-required' || kind === 'auth-failed';
	return {
		cliReady: previous.cliReady || cliReady,
		signedIn: previous.signedIn || signedIn,
		projectReady: previous.projectReady || ready,
	};
}
