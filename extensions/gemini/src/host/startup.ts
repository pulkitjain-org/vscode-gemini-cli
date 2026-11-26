/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The launch's startup marks (startupMarks.ts), shared by the host modules
// that set them: activation in extension.ts, Home when it shows, the first
// chat when it sends and gets its first reply text.

import { StartupMarks, type StartupMarkName } from '../acp/startupMarks';

let marks: StartupMarks | undefined;
let onFirstText: (() => void) | undefined;

/** Starts the launch's marks at `origin` (ms since the epoch); `firstText` runs once the first reply's text arrives. */
export function beginStartup(origin: number, firstText?: () => void): StartupMarks {
	marks = new StartupMarks(origin);
	onFirstText = firstText;
	return marks;
}

/** Sets `name` now, if this launch hasn't set it yet. */
export function markStartup(name: StartupMarkName): void {
	if (marks?.mark(name) && name === 'first text') {
		onFirstText?.();
	}
}
