/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { fitConversation, sideChatPrompt, sideQuestionOf, sideSteeringDraft } from '../../src/acp/sideChat';

const items: TranscriptItem[] = [
	{ id: 'u1', kind: 'user', text: 'Move the cart totals to the pricing service.' } as TranscriptItem,
	{ id: 't1', kind: 'toolCall', title: 'read_file src/api/http.ts', toolKind: 'read', status: 'completed', locations: [{ path: 'src/api/http.ts' }], details: [{ type: 'text', text: 'x'.repeat(3000) }] } as TranscriptItem,
	{ id: 't2', kind: 'toolCall', title: 'edit src/cart/total.ts', toolKind: 'edit', status: 'completed', locations: [], details: [{ type: 'diff', path: 'src/cart/total.ts', added: 3, removed: 1 }] } as TranscriptItem,
	{ id: 'a1', kind: 'agent', text: 'I added axios for retries.' } as TranscriptItem,
	{ id: 'th', kind: 'thought', text: 'hidden thinking' } as TranscriptItem,
];

describe('side questions', () => {
	it('takes the question from /btw, and nothing else', () => {
		expect(['/btw why axios?', '/btw', '  /btw  what changed? ', '/btwx', 'btw why'].map(sideQuestionOf)).toEqual(['why axios?', '', 'what changed?', undefined, undefined]);
	});

	it('gives the conversation with tool outputs cut, and drops outputs, then the oldest messages, to fit', () => {
		const whole = fitConversation(items);
		const outputsGone = fitConversation(items, 300);
		const tight = fitConversation(items, 60);
		expect({
			whole: { cut: whole.cut, readCut: whole.text.includes('… (1000 more characters)'), diff: whole.text.includes('Changed src/cart/total.ts (+3 -1)'), thought: whole.text.includes('hidden thinking') },
			outputsGone,
			tight,
		}).toEqual({
			whole: { cut: false, readCut: true, diff: true, thought: false },
			outputsGone: {
				cut: true,
				text: 'Developer: Move the cart totals to the pricing service.\n\n[Tool call: read_file src/api/http.ts (completed), src/api/http.ts]\n\n[Tool call: edit src/cart/total.ts (completed)]\nChanged src/cart/total.ts (+3 -1)\n\nGemini: I added axios for retries.',
			},
			tight: { cut: true, text: 'Gemini: I added axios for retries.' },
		});
	});

	it('asks with the conversation, the earlier side answers and the question, and drafts a steering message', () => {
		const { system, prompt } = sideChatPrompt({ items: items.slice(3, 4), question: ' why axios? ', earlier: [{ question: 'what changed?', answer: 'total.ts' }], busy: true });
		expect({ tools: system.includes('You have no tools.'), prompt, draft: sideSteeringDraft({ question: 'Why axios?', answer: 'Nothing asked for it.' }) }).toEqual({
			tools: true,
			prompt: '<conversation status="the agent is still working">\nGemini: I added axios for retries.\n</conversation>\n\n<earlier_side_questions>\nQ: what changed?\nA: total.ts\n</earlier_side_questions>\n\nSide question: why axios?',
			draft: 'Why axios?\n\n(I asked this on the side, and got this answer: Nothing asked for it.)',
		});
	});
});
