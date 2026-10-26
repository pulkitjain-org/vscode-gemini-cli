/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan Review's state in files: read again before each change, gone when
// there is nothing to keep, pruned once a month old unless it holds unsent
// comments on a plan that is there, and a revision undone when its comments
// never reached the agent.

import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keepPlanReviewMs, keptPlan, PlanReviewStore, unsentReview } from '../../src/acp/planReviewStore';

let folder: string | undefined;

afterEach(() => {
	if (folder) {
		rmSync(folder, { recursive: true, force: true });
		folder = undefined;
	}
});

function setUp(): { plan: string; storage: string; store: PlanReviewStore } {
	folder = mkdtempSync(path.join(tmpdir(), 'plan-review-store-'));
	const plan = path.join(folder, 'plan.md');
	writeFileSync(plan, '# Plan');
	const storage = path.join(folder, 'state');
	return { plan, storage, store: new PlanReviewStore(storage) };
}

const comment = { id: 'c1', section: 'h:plan', quote: 'Plan', text: 'Shorter.', createdAt: 1 };

describe('PlanReviewStore', () => {
	it('changes the state as it is in the file, and forgets a plan with nothing to keep', async () => {
		const { plan, storage, store } = setUp();
		await store.update(plan, () => ({ comments: [comment] }));
		// Another window adds its own comment meanwhile.
		await new PlanReviewStore(storage).update(plan, saved => ({ comments: [...saved.comments, { ...comment, id: 'c2' }] }));
		const both = (await store.read(plan)).comments.map(each => each.id);
		await store.update(plan, () => ({ comments: [] }));
		expect({ both, files: await fs.readdir(storage) }).toEqual({ both: ['c1', 'c2'], files: [] });
	});

	it('prunes state a month old, but not unsent comments on a plan that is there, nor a gone plan\'s recent state', async () => {
		const { plan, storage, store } = setUp();
		const now = Date.now();
		const old = now - keepPlanReviewMs - 1;
		const at = (name: string) => path.join(path.dirname(plan), name);
		writeFileSync(at('sent.md'), '# Sent');
		await store.write(plan, { comments: [comment], edited: [] }, old);
		await store.write(at('sent.md'), { comments: [{ ...comment, sentAt: 2 }], edited: [] }, old);
		await store.write(at('gone.md'), { comments: [comment], edited: [] }, old);
		await store.write(at('recent.md'), { comments: [], edited: ['h:plan'], plan: '# Recent' }, now);
		writeFileSync(path.join(storage, 'stray.json'), '{');
		const removed = await store.prune(now);
		const kept = await Promise.all([plan, at('sent.md'), at('gone.md'), at('recent.md')].map(async file => (await store.read(file)).comments.length + (await store.read(file)).edited.length));
		expect({ removed, kept }).toEqual({ removed: 3, kept: [1, 0, 0, 1] });
	});

	it('undoes a revision whose comments never went, putting back what was there before', () => {
		const sent = { ...comment, sentAt: 7 };
		const earlier = { ...comment, id: 'c0', sentAt: 3 };
		expect(unsentReview({ comments: [earlier, sent], edited: [], before: '# Plan', revising: true, changed: [], unsend: { sentAt: 7, edited: ['h:plan'], before: '# Older', changed: ['h:plan'] } })).toEqual({
			comments: [earlier, comment], edited: ['h:plan'], before: '# Older', changed: ['h:plan'], revising: false, unsend: undefined,
		});
	});

	it('hands a rebuild the plan the user edited, with when it was seen', async () => {
		const { plan, storage, store } = setUp();
		await store.write(plan, { comments: [], edited: ['h:plan'], plan: '# Plan, edited', planAt: 5 });
		expect({ kept: await keptPlan(storage, plan), none: await keptPlan(storage, `${plan}.other`) }).toEqual({ kept: { text: '# Plan, edited', at: 5 }, none: undefined });
	});
});
