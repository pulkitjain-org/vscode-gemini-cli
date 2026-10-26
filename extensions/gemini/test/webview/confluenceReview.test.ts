/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Review Page: Publish waits until each of the draft's changes is kept or
// undone and sends only the kept ones; saving never rebuilds the editor.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLButtonElement } from 'happy-dom';
import type { AdfDocument, AdfNode } from '../../src/acp/confluence';
import { blockChanges } from '../../src/acp/blockMerge';
import { publishBlocks } from '../../src/acp/draftReview';
import { page, posted, sendToPage, showConfluenceReviewPage, startScript } from './pages';

const { document } = page;
const p = (text: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const macro: AdfNode = { type: 'extension', attrs: { extensionKey: 'toc' } };
const base: AdfDocument = { type: 'doc', version: 1, content: [macro, p('Run the tests.'), p('Check sizes.')] };

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function buttonFor(label: string): HTMLButtonElement {
	return Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
}

beforeAll(async () => {
	await showConfluenceReviewPage();
	await startScript('confluenceReview');
	sendToPage({
		type: 'view', view: {
			id: 'd1', title: 'Checklist', kind: 'edit', where: ['acme.atlassian.net', 'Checklist'], url: 'https://acme.atlassian.net/wiki/pages/42', baseVersion: 14, base,
			saved: { type: 'doc', version: 1, content: [macro, p('Run all the tests.'), p('Check sizes.'), p('Ship it.')] },
			review: { held: [0] },
			createdAt: '2026-10-26T10:00:00Z',
		},
	});
	await tick();
});

describe('confluenceReview', () => {
	it('publishes only once each change is kept or undone, and then only the kept ones', () => {
		const before = { disabled: buttonFor('Publish Changes').disabled, why: document.querySelector('.review-foot-reason')?.textContent, held: !!document.querySelector('.review-held') };
		buttonFor('Keep').click();
		buttonFor('Undo').click();
		const ready = !buttonFor('Publish Changes').disabled;
		buttonFor('Publish Changes').click();
		const sent = posted.find(m => m.type === 'publish') as unknown as { document: AdfDocument; review: { kept: string[] } };
		expect({ before, ready, published: publishBlocks(blockChanges(base.content, sent.document.content), new Set(sent.review.kept)) }).toEqual({
			before: { disabled: true, why: 'Keep or undo each change before publishing: 2 left.', held: true },
			ready: true,
			published: [macro, p('Run all the tests.'), p('Check sizes.')],
		});
	});

	it('keeps the editor when a save comes back', () => {
		sendToPage({ type: 'error', message: 'Offline' });
		buttonFor('Edit').click();
		const editor = document.querySelector('.review-content[contenteditable="true"]');
		sendToPage({ type: 'saved' });
		sendToPage({ type: 'error', message: 'Offline' });
		expect([document.querySelector('.review-content[contenteditable="true"]') === editor, document.querySelector('.review-status')?.textContent]).toEqual([true, 'Offline']);
	});

	it('shows the places left to pick when reopened, and picks one where it now stands', async () => {
		const latest: AdfDocument = { type: 'doc', version: 1, content: [p('A'), p('B theirs'), p('C')] };
		sendToPage({
			type: 'view', view: {
				id: 'd1', title: 'Checklist', kind: 'edit', where: [], baseVersion: 15, base: latest, saved: latest,
				review: { conflicts: [{ at: 1, theirs: [p('B theirs')], mine: [p('B mine')] }] },
				createdAt: '2026-10-26T10:00:00Z',
			},
		});
		await tick();
		const banner = !!document.querySelector('.review-banner.warn');
		// The user adds a line at the top before picking.
		const editor = document.querySelector('.review-content[contenteditable="true"]')!;
		const added = document.createElement('p');
		added.textContent = 'New';
		editor.prepend(added);
		buttonFor('Keep Mine').click();
		buttonFor('Save Draft').click();
		const saved = posted.filter(m => m.type === 'save').pop() as unknown as { document: AdfDocument; review: { conflicts: unknown[] } };
		expect({ banner, content: saved.document.content.map(n => n.content?.[0]?.text), conflicts: saved.review.conflicts }).toEqual({ banner: true, content: ['New', 'A', 'B mine', 'C'], conflicts: [] });
	});

	it('leaves the agent\'s rewrite of a part it can\'t write out of Keep All, and takes it only when chosen', async () => {
		const bob: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'b0b', text: '@Bob' } }] };
		const published: AdfNode[][] = [];
		for (const choice of ['Keep All', 'Use the Agent\'s Version']) {
			sendToPage({ type: 'error', message: '' });
			sendToPage({
				type: 'view', view: {
					id: 'd2', title: 'Welcome', kind: 'edit', where: [], baseVersion: 3, base: { type: 'doc', version: 1, content: [bob] },
					saved: { type: 'doc', version: 1, content: [bob, p('Hi @Bob, welcome')] }, review: { held: [0] }, createdAt: '2026-10-26T10:00:00Z',
				},
			});
			await tick();
			buttonFor(choice).click();
			buttonFor('Publish Changes').click();
			const sent = posted.filter(m => m.type === 'publish').pop() as unknown as { document: AdfDocument; review: { kept: string[] } };
			published.push(publishBlocks(blockChanges([bob], sent.document.content), new Set(sent.review.kept)));
		}
		expect(published).toEqual([[bob], [p('Hi @Bob, welcome')]]);
	});
});
