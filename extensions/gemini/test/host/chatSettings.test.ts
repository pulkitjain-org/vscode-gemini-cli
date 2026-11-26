/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { AgentError } from '../../src/acp/errors';
import { refusalText } from '../../src/host/chat/chatSettings';

describe('refusalText', () => {
	it('words a refused mode or model change, by its cause when known', () => {
		const refused = new AgentError({ kind: 'unknown', message: 'Invalid params: mode "x"', code: -32602 });
		expect([
			refusalText('mode', 'YOLO', refused),
			refusalText('model', 'Gemini 2.5 Pro', refused),
			refusalText('mode', 'Plan', new AgentError({ kind: 'agent-restarted', message: 'closed' })),
			refusalText('model', 'Flash', new AgentError({ kind: 'network', message: 'ECONNRESET' })),
			refusalText('model', 'Flash', new Error('boom')),
		]).toEqual([
			'The agent refused the switch to YOLO mode: Invalid params: mode "x"',
			'The agent refused the switch to Gemini 2.5 Pro: Invalid params: mode "x"',
			'The agent restarted before it could switch to Plan mode. Pick it again.',
			'Can\'t reach Google to switch to Flash. Check your connection, VPN or proxy.',
			'The agent refused the switch to Flash: boom',
		]);
	});
});
