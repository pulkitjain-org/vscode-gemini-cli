/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Follow the agent: which file, and where, to show as the agent works.

import * as path from 'node:path';
import { isInside, secretPathReason } from './fileAccess';
import type { ToolCallModel } from './sessionUpdates';

export interface FollowTarget {
	readonly path: string;
	/** 1-based, as ACP sends it. */
	readonly line?: number;
}

/**
 * Picks what to show for each tool call: a file being read as soon as the
 * call names it, and an edited file once the edit is written, so the editor
 * shows the result. Calls that only list or search folders, run commands or
 * fetch pages show nothing. Each call is shown at most once.
 */
export class FollowTracker {

	private readonly shown = new Set<string>();

	/** What to show for this update of `call`, if anything. */
	next(call: ToolCallModel): FollowTarget | undefined {
		if (this.shown.has(call.id) || !call.locations.length || call.status === 'failed') {
			return undefined;
		}
		const ready = call.kind === 'read' ? true
			: call.kind === 'edit' || call.kind === 'move' ? call.status === 'completed'
				: false;
		if (!ready) {
			return undefined;
		}
		this.shown.add(call.id);
		if (this.shown.size > maxRemembered) {
			this.shown.delete(this.shown.values().next().value!);
		}
		// A move names the old path first; the file is at the last one.
		const location = call.kind === 'move' ? call.locations[call.locations.length - 1] : call.locations[0];
		return typeof location.line === 'number' && location.line > 0 ? { path: location.path, line: location.line } : { path: location.path };
	}
}

const maxRemembered = 500;

/**
 * The file to show for `target` in an agent working in `cwd`, resolved from
 * there; undefined for a file outside the folder or one that may hold secrets.
 */
export function followablePath(cwd: string, target: FollowTarget): string | undefined {
	const root = path.resolve(cwd);
	const file = path.resolve(root, target.path);
	return isInside(root, file) && !secretPathReason(path.relative(root, file)) ? file : undefined;
}
