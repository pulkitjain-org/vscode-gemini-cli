/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditFileName, auditHash, AuditLog, renderAudit } from '../../src/acp/auditLog';

describe('the audit log', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('appends an intent and a result with the same id, and keeps only hashes of the text', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'audit-'));
		let t = Date.parse('2026-10-18T14:12:31Z');
		const log = new AuditLog(dir, () => new Date(t));
		const intent = { caller: 'agent' as const, agent: 'a1', tool: 'jira_transition', ref: 'ACME-412', effect: 'ACME-412 In Progress → In Review', args: { key: 'ACME-412', to: 'In Review', comment: 'secret text' } };
		const value = await log.record(intent, async () => { t += 1000; return { changelog: '54821' }; }, v => `changelog ${v.changelog}`);
		expect(value).toEqual({ changelog: '54821' });
		const text = readFileSync(path.join(dir, auditFileName(new Date(t))), 'utf8');
		expect(text).not.toContain('secret text');
		const entries = await log.read(new Date(t));
		expect(entries.map(e => e.phase)).toEqual(['intent', 'result']);
		expect(entries[0].id).toBe(entries[1].id);
		expect(entries[0].argsHash).toBe(auditHash(intent.args));
		expect(entries[1].remote).toBe('changelog 54821');
		expect(await log.unfinished()).toEqual([]);
	});

	it('lists intents that never got a result, and settles one by hand', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'audit-'));
		const log = new AuditLog(dir, () => new Date('2026-10-18T14:31:02Z'));
		await log.intent({ caller: 'ui', tool: 'openMergeRequest', ref: 'ACME-398-flaky', effect: 'ACME-398-flaky → release/2026.11' });
		await expect(log.record({ caller: 'ui', tool: 'jira_log_time', ref: 'ACME-1', effect: '1h on ACME-1' }, async () => { throw new Error('401'); })).rejects.toThrow('401');
		const open = await log.unfinished();
		expect(open.map(e => e.tool)).toEqual(['openMergeRequest']);
		await log.settle(open[0], '!321');
		expect(await log.unfinished()).toEqual([]);
		const md = renderAudit([{ day: '2026-10-18', entries: await log.read() }], []);
		expect(md).toContain('| `jira_log_time` | 1h on ACME-1 | failed: 401 |');
		expect(md).toContain('| `openMergeRequest` | ACME-398-flaky → release/2026.11 | result | !321 |');
	});
});
