/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addHook, disabledHooks, hooksIn, setHookEnabled } from '../../src/acp/hooks';
import { readSettingsFile } from '../../src/acp/projectSettings';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('hooks', () => {
	it('lists command hooks with their matcher and whether they are on', () => {
		const settings = {
			hooks: {
				AfterTool: [{ matcher: 'write_file|replace', hooks: [{ type: 'command', command: 'npx prettier --write .' }, { type: 'command', name: 'lint', command: 'npm run lint' }] }],
				SessionStart: [{ hooks: [{ type: 'runtime', name: 'internal' }, { type: 'command', command: 'echo hi' }] }],
				NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
				BeforeTool: 'broken',
			},
			hooksConfig: { disabled: ['lint', 3] },
		};
		const off = disabledHooks(settings);
		expect([...off]).toEqual(['lint']);
		expect(hooksIn(settings, 'f', off)).toEqual([
			{ event: 'AfterTool', matcher: 'write_file|replace', command: 'npx prettier --write .', name: 'npx prettier --write .', enabled: true, file: 'f' },
			{ event: 'AfterTool', matcher: 'write_file|replace', command: 'npm run lint', name: 'lint', enabled: false, file: 'f' },
			{ event: 'SessionStart', command: 'echo hi', name: 'echo hi', enabled: true, file: 'f' },
		]);
	});

	it('adds hooks and switches them off and on', async () => {
		const file = path.join(dir, '.gemini', 'settings.json');
		await fs.mkdir(path.dirname(file));
		await fs.writeFile(file, JSON.stringify({ model: { name: 'x' }, hooks: { AfterTool: [{ hooks: [{ type: 'command', command: 'a' }] }] } }));
		expect(await addHook(file, 'AfterTool', 'b', 'replace')).toBe(true);
		expect(await setHookEnabled(file, 'b', false)).toBe(true);
		let settings = await readSettingsFile(file);
		expect(settings.model).toEqual({ name: 'x' });
		expect(hooksIn(settings, file, disabledHooks(settings)).map(h => [h.command, h.matcher, h.enabled])).toEqual([['a', undefined, true], ['b', 'replace', false]]);
		await setHookEnabled(file, 'b', true);
		settings = await readSettingsFile(file);
		expect(settings.hooksConfig).toEqual({ disabled: [] });
	});

	it('leaves a settings file with comments alone', async () => {
		const file = path.join(dir, 'settings.json');
		await fs.writeFile(file, '{\n  // mine\n}\n');
		expect(await addHook(file, 'SessionStart', 'echo')).toBe(false);
		expect(await fs.readFile(file, 'utf8')).toBe('{\n  // mine\n}\n');
	});
});
