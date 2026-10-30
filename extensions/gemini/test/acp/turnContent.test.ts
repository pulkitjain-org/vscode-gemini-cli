/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { assembleTurnContent } from '../../src/acp/turnContent';

describe('assembleTurnContent', () => {
	it('puts the notes before the message, in order, and what the agent reads last after it', () => {
		const blocks = assembleTurnContent({
			content: [{ type: 'text', text: 'the ask' }, { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' }],
			steering: 'steer',
			notes: ['note 1', 'note 2'],
			reactionRule: 'rule',
			context: 'context',
			carried: 'carried',
			undoNote: 'undo',
			hint: 'hint',
			design: 'design',
			page: 'page',
		});
		expect(blocks.map(block => block.type === 'text' ? block.text : block.type)).toEqual(['steer', 'note 1', 'note 2', 'rule', 'context', 'carried', 'undo', 'the ask', 'resource_link', 'hint', 'design', 'page']);
	});

	it('sends only the message when nothing else applies', () => {
		expect(assembleTurnContent({ content: [{ type: 'text', text: 'hi' }], notes: [], steering: undefined, hint: '' })).toEqual([{ type: 'text', text: 'hi' }]);
	});
});
