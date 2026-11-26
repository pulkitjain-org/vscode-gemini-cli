/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ToolCallModel } from '../../src/acp/sessionUpdates';
import { isBlockedWebFetch } from '../../src/acp/webFetchHint';

function call(status: ToolCallModel['status'], text: string): ToolCallModel {
	return { id: 't1', title: 'Processing URLs and instructions from prompt', kind: 'fetch', status, locations: [], content: [{ type: 'content', content: { type: 'text', text } }] };
}

describe('isBlockedWebFetch', () => {
	it('spots the CLI refusing a private host, as gemini-cli 0.63 words it', () => {
		expect(isBlockedWebFetch(call('failed', 'All requested URLs were skipped: [Blocked Host] https://qa02.example.technology/au/en/home.html'))).toBe(true);
		expect(isBlockedWebFetch(call('failed', 'Access to blocked or private host http://10.0.0.5/ is not allowed.'))).toBe(true);
	});

	it('leaves other results alone', () => {
		expect(isBlockedWebFetch(call('completed', '[Blocked Host] https://x/'))).toBe(false);
		expect(isBlockedWebFetch(call('failed', 'Request failed with status code 404'))).toBe(false);
		expect(isBlockedWebFetch({ ...call('failed', ''), content: [] })).toBe(false);
	});
});
