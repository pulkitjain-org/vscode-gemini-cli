/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When an agent wants the user back: it asks for permission, or finishes a turn.

export interface Activity {
	readonly busy: boolean;
	readonly needsPermission: boolean;
}

/** What changed between two activity states that is worth telling the user about, if anything. */
export function attentionChange(before: Activity, after: Activity): 'permission' | 'done' | undefined {
	if (after.needsPermission && !before.needsPermission) {
		return 'permission';
	}
	if (before.busy && !after.busy && !after.needsPermission) {
		return 'done';
	}
	return undefined;
}

/** How many agents wait on the user: for permission, or with a reply not yet seen. */
export function waitingCount(agents: Iterable<{ readonly activity: Activity; readonly unread: boolean }>): number {
	let count = 0;
	for (const agent of agents) {
		if (agent.activity.needsPermission || agent.unread) {
			count++;
		}
	}
	return count;
}
