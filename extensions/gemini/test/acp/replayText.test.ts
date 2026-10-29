/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { hasReplayMarkers, withoutReplayMarkers } from '../../src/acp/replayText';

describe('withoutReplayMarkers', () => {
	it('drops text made only of the CLI\'s markers', () => {
		for (const text of ['[Thought: true][Function Call: replace]', '[Function Response: run_shell_command]', ' [Image: image/png, 45.2 KB] ', '[Executable Code][Code Execution Result]', '[File Data]', '[Video Metadata]']) {
			expect(withoutReplayMarkers(text)).toBe('');
		}
	});

	it('takes markers off the start and end of real text', () => {
		expect(withoutReplayMarkers('[Thought: true]Fixed it.[Function Call: replace][Function Call: run_shell_command]')).toBe('Fixed it.');
		expect(withoutReplayMarkers('[Image: image/png, 1.0 KB]What is this?')).toBe('What is this?');
	});

	it('keeps text that only looks like a marker, and markers in the middle', () => {
		for (const text of ['[x] done', '[Thought: this is a long thought that is not the marker]', 'See [Function Call: replace] above', '[Image: a cat]']) {
			expect(withoutReplayMarkers(text)).toBe(text);
			expect(hasReplayMarkers(text)).toBe(false);
		}
	});
});
