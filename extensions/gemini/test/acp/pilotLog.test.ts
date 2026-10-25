/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PilotLog, pilotExport, PilotRecord, recordPilot, setPilotSink } from '../../src/acp/pilotLog';
import { teamRequest } from '../../src/acp/teamHttp';

const dirs: string[] = [];
afterEach(async () => {
	setPilotSink(undefined);
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-pilot-'));
	dirs.push(dir);
	return dir;
}

describe('pilot log', () => {
	it('records nothing until the pilot is recording', () => {
		const seen: PilotRecord[] = [];
		recordPilot({ kind: 'launch' });
		setPilotSink(record => seen.push(record));
		recordPilot({ kind: 'rewind' });
		expect(seen.map(r => r.kind)).toEqual(['rewind']);
	});

	it('keeps events one file per day and reads them back in order', async () => {
		const dir = await tempDir();
		const log = new PilotLog(dir);
		log.add({ kind: 'launch', at: '2026-10-17T08:00:00.000Z' });
		log.add({ kind: 'prompt', waitedMs: 40, at: '2026-10-18T08:00:05.000Z' });
		await log.flush();
		log.add({ kind: 'turn', permissions: 2, durationMs: 9000, at: '2026-10-18T08:00:20.000Z' });
		expect([(await fs.readdir(dir)).sort(), (await log.readAll()).map(r => r.kind)]).toEqual([['2026-10-17.jsonl', '2026-10-18.jsonl'], ['launch', 'prompt', 'turn']]);
	});

	it('exports events, each launch\'s restart cost and the audit log, one object per line', () => {
		const records: PilotRecord[] = [
			{ kind: 'launch', at: '2026-10-18T08:00:00.000Z' },
			{ kind: 'unfinished', flows: 1, writes: 0, at: '2026-10-18T08:00:10.000Z' },
			{ kind: 'prompt', waitedMs: 1200, at: '2026-10-18T08:02:00.000Z' },
			{ kind: 'prompt', waitedMs: 0, at: '2026-10-18T08:05:00.000Z' },
			{ kind: 'launch', at: '2026-10-18T13:00:00.000Z' },
		];
		const lines = pilotExport(records, [{ id: 'a1', phase: 'intent', tool: 'jira_transition' }]).trim().split('\n').map(line => JSON.parse(line) as { type: string });
		expect(lines.filter(l => l.type !== 'event')).toEqual([
			{ type: 'launch', at: '2026-10-18T08:00:00.000Z', msToFirstPrompt: 120_000, unfinished: { flows: 1, writes: 0 } },
			{ type: 'launch', at: '2026-10-18T13:00:00.000Z', msToFirstPrompt: null, unfinished: null },
			{ type: 'audit', id: 'a1', phase: 'intent', tool: 'jira_transition' },
		]);
		expect(lines.filter(l => l.type === 'event')).toHaveLength(5);
	});

	it('counts a team tool error by kind and status', async () => {
		const seen: PilotRecord[] = [];
		setPilotSink(record => seen.push(record));
		const tooMany = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
		const offVpn = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
		await teamRequest('jira', 'https://acme.atlassian.net/rest/api/3/myself', {}, tooMany).catch(() => undefined);
		await teamRequest('gitlab', 'https://gitlab.acme.internal/api/v4/user', {}, offVpn).catch(() => undefined);
		expect(seen.map(({ at: _at, ...rest }) => rest)).toEqual([
			{ kind: 'teamToolError', tool: 'jira', error: 'failed', status: 429 },
			{ kind: 'teamToolError', tool: 'gitlab', error: 'unreachable' },
		]);
	});
});
