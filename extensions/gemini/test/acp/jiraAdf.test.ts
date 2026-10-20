/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { appendAttachments, isAdfDocument } from '../../src/acp/jiraAdf';

describe('comment documents', () => {
	it('lists the attached files at the end, each linked when Jira gave its address, and knows a document from anything else', () => {
		const doc = { type: 'doc' as const, version: 1 as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fails' }] }] };
		expect({
			appended: appendAttachments(doc, [{ name: 'cart.png', url: 'https://jira.example/rest/api/3/attachment/content/1' }, { name: 'log.txt' }]).content[1],
			unchanged: appendAttachments(doc, []) === doc,
			documents: [doc, { type: 'doc', version: 1 }, { type: 'paragraph', version: 1, content: [] }, 'doc', undefined].map(isAdfDocument),
		}).toEqual({
			appended: {
				type: 'paragraph', content: [
					{ type: 'text', text: 'Attached: ' },
					{ type: 'text', text: 'cart.png', marks: [{ type: 'link', attrs: { href: 'https://jira.example/rest/api/3/attachment/content/1' } }] },
					{ type: 'text', text: ', ' },
					{ type: 'text', text: 'log.txt' },
				],
			},
			unchanged: true,
			documents: [true, false, false, false, false],
		});
	});
});
