/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A session's plans survive the CLI deleting the session's folder on
// `session/load`, and a plan lost before that comes back from the session's
// saved calls.

import { chmodSync, mkdirSync, mkdtempSync, promises as fs, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionMessages } from '../../src/acp/cliSessions';
import { PlanReviewStore } from '../../src/acp/planReviewStore';
import { keepSessionFolder, removeKeptSessionFolders, sessionFolder } from '../../src/acp/sessionFolder';
import { rebuildSessionFile, replayWrites, SessionReader } from '../../src/acp/sessionReplay';

const line = (value: unknown) => JSON.stringify(value);
const id = '9b4ec912-ffbc-4c44-9459-995d379aef73';

let home: string | undefined;

afterEach(() => {
	if (home) {
		rmSync(home, { recursive: true, force: true });
		home = undefined;
	}
});

/** A CLI home with folder `shop` registered as project `shop`; resolves with the folder and its session's folder. */
function setUp(): { home: string; work: string; folder: string; chats: string } {
	home = realpathSync(mkdtempSync(path.join(tmpdir(), 'session-folder-')));
	const work = path.join(home, 'work', 'shop');
	mkdirSync(work, { recursive: true });
	writeFileSync(path.join(home, 'projects.json'), line({ projects: { [work]: 'shop' } }));
	const chats = path.join(home, 'tmp', 'shop', 'chats');
	mkdirSync(chats, { recursive: true });
	return { home, work, folder: path.join(home, 'tmp', 'shop', id), chats };
}

const read = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined);

/** The reader the chat passes in, from the extension bundle. */
function reader(work: string, home: string): SessionReader {
	return { home, folder: id => sessionFolder(work, id, home), messages: async id => (await readSessionMessages(work, id, home))?.messages };
}

describe('keepSessionFolder', () => {
	it('puts back the plans a load removed, and keeps what the CLI wrote since', async () => {
		const { home, work, folder } = setUp();
		mkdirSync(path.join(folder, 'plans'), { recursive: true });
		writeFileSync(path.join(folder, 'plans', 'plan.md'), '# Plan');
		const putBack = await keepSessionFolder(work, id, home);
		// What gemini-cli 0.64 does on `session/load`, then a plan written after.
		rmSync(folder, { recursive: true });
		mkdirSync(path.join(folder, 'plans'), { recursive: true });
		writeFileSync(path.join(folder, 'plans', 'next.md'), '# Next');
		await putBack();
		expect({
			plan: await read(path.join(folder, 'plans', 'plan.md')),
			next: await read(path.join(folder, 'plans', 'next.md')),
		}).toEqual({ plan: '# Plan', next: '# Next' });
	});

	it('puts back what it could copy when a file can\'t be read', async () => {
		const { home, work, folder } = setUp();
		mkdirSync(path.join(folder, 'plans'), { recursive: true });
		writeFileSync(path.join(folder, 'plans', 'locked.md'), '# Locked');
		writeFileSync(path.join(folder, 'plans', 'plan.md'), '# Plan');
		chmodSync(path.join(folder, 'plans', 'locked.md'), 0o000);
		const putBack = await keepSessionFolder(work, id, home);
		rmSync(folder, { recursive: true, force: true });
		await putBack();
		expect(await read(path.join(folder, 'plans', 'plan.md'))).toBe('# Plan');
	});

	it('does nothing for a session without a folder, or an id that names none', async () => {
		const { home, work, folder } = setUp();
		await (await keepSessionFolder(work, id, home))();
		await (await keepSessionFolder(work, 'chats', home))();
		await (await keepSessionFolder(work, '../shop', home))();
		expect(await fs.stat(folder).catch(() => undefined)).toBeUndefined();
	});
});

describe('rebuildSessionFile', () => {
	it('writes a lost plan from its last write and the replaces after it', async () => {
		const { home, work, folder, chats } = setUp();
		const plan = path.join(folder, 'plans', 'plan.md');
		// The model gives the path from the session's folder, as the CLI saves it.
		const given = path.relative(work, plan);
		writeFileSync(path.join(chats, `session-2026-10-26T14-21-${id.slice(0, 8)}.jsonl`), [
			line({ sessionId: id, projectHash: 'h' }),
			line({ id: 'u1', type: 'user', content: 'Plan the MCP integrations' }),
			line({ id: 'g1', type: 'gemini', content: '', toolCalls: [
				{ name: 'write_file', status: 'success', args: { file_path: given, content: '# Old plan' } },
				{ name: 'write_file', status: 'success', args: { file_path: given, content: '# Plan\n\n## Steps\nOne.\n' } },
			] }),
			line({ id: 'g2', type: 'gemini', content: '', toolCalls: [
				{ name: 'replace', status: 'success', args: { file_path: plan, old_string: 'One.', new_string: 'One.\nTwo.' } },
				{ name: 'replace', status: 'error', args: { file_path: plan, old_string: 'Two.', new_string: 'Three.' } },
			] }),
		].join('\n'));
		expect({
			rebuilt: await rebuildSessionFile(work, plan, reader(work, home)),
			text: await read(plan),
			// Never over a file that is there, nor outside a session's folder.
			again: await rebuildSessionFile(work, plan, reader(work, home)),
			outside: await rebuildSessionFile(work, path.join(work, 'plan.md'), reader(work, home)),
		}).toEqual({ rebuilt: 'history', text: '# Plan\n\n## Steps\nOne.\nTwo.\n', again: undefined, outside: undefined });
	});

	it('prefers the plan as the user edited it in Plan Review, unless the agent wrote it after', async () => {
		const { home, work, folder, chats } = setUp();
		const plan = path.join(folder, 'plans', 'plan.md');
		const reviews = path.join(home, 'reviews');
		const session = (at: string) => writeFileSync(path.join(chats, `session-2026-10-26T14-21-${id.slice(0, 8)}.jsonl`), [
			line({ sessionId: id, projectHash: 'h' }),
			line({ id: 'u1', type: 'user', content: 'Plan it' }),
			line({ id: 'g1', type: 'gemini', content: '', timestamp: at, toolCalls: [{ name: 'write_file', status: 'success', args: { file_path: plan, content: '# Agent\'s plan' } }] }),
		].join('\n'));
		await new PlanReviewStore(reviews).write(plan, { comments: [], edited: ['h:plan'], plan: '# My plan', planAt: Date.parse('2026-10-26T15:00:00Z') });
		session('2026-10-26T14:30:00Z');
		const before = { rebuilt: await rebuildSessionFile(work, plan, { ...reader(work, home), reviews }), text: await read(plan) };
		rmSync(plan);
		session('2026-10-26T15:30:00Z');
		const after = { rebuilt: await rebuildSessionFile(work, plan, { ...reader(work, home), reviews }), text: await read(plan) };
		expect({ before, after }).toEqual({ before: { rebuilt: 'review', text: '# My plan' }, after: { rebuilt: 'history', text: '# Agent\'s plan' } });
	});
});

describe('removeKeptSessionFolders', () => {
	it('removes copies a load left behind more than a day ago', async () => {
		const tmp = home = realpathSync(mkdtempSync(path.join(tmpdir(), 'kept-')));
		for (const name of ['geminicode-session-old', 'geminicode-session-new', 'other-old']) {
			mkdirSync(path.join(tmp, name));
		}
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		utimesSync(path.join(tmp, 'geminicode-session-old'), old, old);
		utimesSync(path.join(tmp, 'other-old'), old, old);
		expect({ removed: await removeKeptSessionFolders(tmp), left: (await fs.readdir(tmp)).sort() }).toEqual({ removed: 1, left: ['geminicode-session-new', 'other-old'] });
	});
});

describe('replayWrites', () => {
	const file = '/work/plans/plan.md';
	const call = (name: string, args: Record<string, unknown>) => ({ id: name, toolCalls: [{ name, status: 'success', args: { file_path: file, ...args } }] });

	it('creates from an empty replace, replaces every match when asked, and gives up on a change that no longer applies', () => {
		expect({
			created: replayWrites([call('replace', { old_string: '', new_string: 'a a' }), call('replace', { old_string: 'a', new_string: 'b', allow_multiple: true })], '/work', file),
			stale: replayWrites([call('write_file', { content: 'a' }), call('replace', { old_string: 'z', new_string: 'b' })], '/work', file),
			none: replayWrites([call('replace', { old_string: 'a', new_string: 'b' })], '/work', file),
		}).toEqual({ created: 'b b', stale: undefined, none: undefined });
	});
});
