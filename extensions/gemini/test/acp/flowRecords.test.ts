/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowRecordStore } from '../../src/acp/flowRecords';

describe('flow records', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps a record while a flow is open, and lists what was left open', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'flows-'));
		let t = Date.parse('2026-10-18T14:31:02Z');
		const store = new FlowRecordStore(dir, () => new Date(t));
		const move = await store.open({ command: 'gemini.team.moveTicket', args: ['ACME-412'], title: 'Move ACME-412', about: 'ACME-412' });
		t += 1000;
		const mr = await store.open({ command: 'gemini.team.openMergeRequest', args: ['agent-1'], title: 'Open Merge Request', about: 'ACME-412-gift' });
		expect((await store.list()).map(r => r.command)).toEqual(['gemini.team.moveTicket', 'gemini.team.openMergeRequest']);
		await store.close(move);
		const left = await store.list();
		expect(left).toHaveLength(1);
		expect(left[0]).toMatchObject({ id: mr, command: 'gemini.team.openMergeRequest', args: ['agent-1'], title: 'Open Merge Request', startedAt: '2026-10-18T14:31:03.000Z' });
		expect(await store.get(mr)).toEqual(left[0]);
		await store.close(mr);
		await store.close('never-opened');
		expect(await store.list()).toEqual([]);
	});
});
