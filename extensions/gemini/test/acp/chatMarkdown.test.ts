/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { chatToMarkdown, type ChatMarkdownLabels } from '../../src/acp/chatMarkdown';
import type { TranscriptItem } from '../../src/acp/chatTranscript';

const labels: ChatMarkdownLabels = {
	you: 'You', gemini: 'Gemini', thought: 'Thought', plan: 'Plan', attached: 'Attached',
	workedFor: 'Worked for {0}', permission: '{0}: {1}', cancelled: 'Cancelled',
};

describe('chatToMarkdown', () => {
	it('writes prompts, replies, tool calls and turn ends', () => {
		const items: TranscriptItem[] = [
			{ id: '1', kind: 'user', text: 'Fix the\nrounding', attachments: [{ kind: 'file', label: 'total.ts' }] },
			{ id: '2', kind: 'thought', text: 'Cents.' },
			{ id: '3', kind: 'agent', text: 'Reading it.' },
			{ id: '4', kind: 'toolCall', title: 'Read total.ts', toolKind: 'read', status: 'completed', locations: [], details: [] },
			{ id: '5', kind: 'toolCall', title: 'npm test', toolKind: 'execute', status: 'failed', locations: [], details: [] },
			{ id: '6', kind: 'permission', title: 'Edit total.ts', options: [], diffPaths: [], answer: { kind: 'selected', name: 'Allow' } },
			{ id: '7', kind: 'agent', text: 'Done.' },
			{ id: '8', kind: 'turnEnd', durationMs: 72_000 },
			{ id: '9', kind: 'user', text: 'Thanks' },
			{ id: '10', kind: 'notice', text: 'Stopped', severity: 'info' },
		];
		expect(chatToMarkdown('Cart  totals', items, labels)).toBe([
			'# Cart totals',
			'## You', 'Fix the\nrounding', '*Attached: `total.ts`*',
			'<details><summary>Thought</summary>\n\nCents.\n\n</details>',
			'## Gemini', 'Reading it.',
			'- ✓ Read total.ts\n- ✗ npm test',
			'*Edit total.ts: Allow*',
			'Done.',
			'*Worked for 1m 12s*', '---',
			'## You', 'Thanks',
			'> Stopped',
		].join('\n\n') + '\n');
	});

	it('drops a trailing rule and shows plans as task lists', () => {
		const items: TranscriptItem[] = [
			{ id: '1', kind: 'plan', entries: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'pending' }] },
			{ id: '2', kind: 'turnEnd', durationMs: 500 },
		];
		expect(chatToMarkdown('T', items, labels)).toBe('# T\n\n**Plan**\n\n- [x] Read\n- [ ] Fix\n\n*Worked for 1s*\n');
	});
});
