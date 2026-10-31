/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Move to its own branch's decisions, apart from git and the editor
// (`src/host/agents/agentForks.ts` does both): which agents it applies to,
// what the dialog offers, the steps in order, the new branch's name and the
// note the moved agent reads first.

import type { AgentRecord } from './agents';
import { branchNameFrom } from './branchNames';

/** Why Move to its own branch doesn't apply to an agent. */
export type MoveRefusal =
	/** No such agent, or none chosen. */
	| 'gone'
	/** A project chat has no code of its own to move. */
	| 'project'
	/** A thread in several repositories. */
	| 'repos'
	/** Already on a branch of its own. */
	| 'ownBranch'
	/** Its folder is not in a Git repository. */
	| 'noGit'
	/** A turn runs, whose work would be lost. */
	| 'busy';

/** The dialog's buttons: move, or move and take the agent's changes out of this checkout. */
export type MoveChoice = 'move' | 'moveAndUndo';

/** What a move does, in order: the fork path with the whole session, Undo All here, then the original is archived. */
export type MoveStep = 'move' | 'undo' | 'archive';

/** Where the agent stands, besides its record. */
export interface MovePlace {
	/** Its folder is in a Git repository. */
	readonly git: boolean;
	/** A turn is running. */
	readonly busy: boolean;
}

/** Why the agent can't move to its own branch, or undefined when it can. */
export function moveRefusal(record: Pick<AgentRecord, 'worktree' | 'repos' | 'project'> | undefined, place: MovePlace): MoveRefusal | undefined {
	if (!record) {
		return 'gone';
	}
	if (record.project?.role === 'coordinator') {
		return 'project';
	}
	if (record.repos?.length) {
		return 'repos';
	}
	if (record.worktree) {
		return 'ownBranch';
	}
	if (!place.git) {
		return 'noGit';
	}
	return place.busy ? 'busy' : undefined;
}

/** Whether the agent's row and tab offer Move to its own branch: it works in the user's checkout of a Git folder. A running turn is refused when the command runs. */
export function canMoveToBranch(record: Pick<AgentRecord, 'worktree' | 'repos' | 'project'> | undefined, git: boolean): boolean {
	return moveRefusal(record, { git, busy: false }) === undefined;
}

/** The dialog's buttons: Move, and Move and undo here when the agent changed files that can still be undone. */
export function moveChoices(undoableFiles: number): readonly MoveChoice[] {
	return undoableFiles > 0 ? ['move', 'moveAndUndo'] : ['move'];
}

/** The steps of `choice`, in order; the agent's changes are undone here only once they are on the new branch. */
export function moveSteps(choice: MoveChoice): readonly MoveStep[] {
	return choice === 'moveAndUndo' ? ['move', 'undo', 'archive'] : ['move', 'archive'];
}

/** The branch the agent moves to, named after the agent, under the repository's prefix. */
export function moveBranchName(title: string, prefix?: string): string {
	return branchNameFrom(title, prefix);
}

/** The note the moved agent reads with its first prompt: where it works now, and that the old folder is not its to change. */
export function moveNote(folderBefore: string, folder: string, branch: string): string {
	return `This agent was moved to its own branch ${branch}: you now work in ${folder}, a copy of ${folderBefore} with its uncommitted changes. Files the earlier messages name under ${folderBefore} are under ${folder} now: read and change them there, never in ${folderBefore}, which is the user's own checkout.`;
}
