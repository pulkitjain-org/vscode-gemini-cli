/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliPatchMarker, patchAcpToolOutput, patchCliBundle } from '../../src/acp/cliPatches';

const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'acp-run-tool.txt'), 'utf8');
const bundledCli = path.join(__dirname, '..', '..', 'cli');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-patch-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface FakeSession {
	runTool(invocation: { execute(options: unknown): Promise<unknown> }, fc: { id: string; name: string }): Promise<{ llmContent: unknown; content: unknown }>;
}

/** The fixture with the patch applied, loaded as a module, and a session whose CLI caps at `limit` characters. */
async function patchedSession(limit: number): Promise<FakeSession> {
	const file = path.join(dir, 'gemini-TEST.mjs');
	fs.writeFileSync(file, patchAcpToolOutput(fixture)!);
	const module = await import(pathToFileURL(file).href) as { Session: new (id: string, config: unknown) => FakeSession };
	return new module.Session('s-1', { getTruncateToolOutputThreshold: () => limit, storage: { getProjectTempDir: () => dir } });
}

function returning(llmContent: unknown) {
	return { execute: async () => ({ llmContent, returnDisplay: 'shown in the chat' }) };
}

describe('the ACP tool output cap', () => {
	it('saves an output past the threshold and gives the model its head and tail, as the CLI does elsewhere', async () => {
		const session = await patchedSession(100);
		const output = `${'a'.repeat(20)}${'b'.repeat(1000)}${'c'.repeat(80)}`;
		const result = await session.runTool(returning(output), { id: 'call-7', name: 'run_shell_command' });
		const saved = path.join(dir, 'tool-outputs', 'session-s-1', 'run_shell_command_call-7.txt');
		expect({ ...result, saved: fs.readFileSync(saved, 'utf8') === output }).toEqual({
			llmContent: `Output too large. Showing first 20 and last 80 characters. For full output see: ${saved}\n${'a'.repeat(20)}\n\n... [1,000 characters omitted] ...\n\n${'c'.repeat(80)}`,
			content: 'shown in the chat',
			saved: true,
		});
	});

	it('caps each long text part of an MCP result and leaves short outputs alone', async () => {
		const session = await patchedSession(10);
		const parts = [{ text: 'short' }, { text: 'x'.repeat(30) }, { inlineData: { data: 'img' } }];
		const capped = (await session.runTool(returning(parts), { id: 'c', name: 'gitlab_get_mr' })).llmContent as { text?: string }[];
		expect(capped.map(part => part.text?.split('\n')[0] ?? 'binary')).toEqual([
			'short',
			`Output too large. Showing first 2 and last 8 characters. For full output see: ${path.join(dir, 'tool-outputs', 'session-s-1', 'gitlab_get_mr_c_1.txt')}`,
			'binary',
		]);
		expect((await session.runTool(returning('fine'), { id: 'd', name: 'run_shell_command' })).llmContent).toBe('fine');
	});

	it('applies once, and only to the code it knows', async () => {
		const bundle = path.join(dir, 'bundle');
		fs.mkdirSync(bundle);
		fs.writeFileSync(path.join(bundle, 'gemini-ABC123.js'), fixture);
		fs.writeFileSync(path.join(bundle, 'chunk-ABC123.js'), fixture);
		const results = [await patchCliBundle(bundle), await patchCliBundle(bundle)];
		const other = path.join(dir, 'other');
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, 'gemini-XYZ.js'), fixture.replace('await invocation.execute', 'await invocation.run'));
		expect({
			results,
			unrecognized: await patchCliBundle(other),
			patchedOnce: fs.readFileSync(path.join(bundle, 'gemini-ABC123.js'), 'utf8').split(cliPatchMarker).length - 1,
			chunkUntouched: fs.readFileSync(path.join(bundle, 'chunk-ABC123.js'), 'utf8') === fixture,
		}).toEqual({ results: ['patched', 'unchanged'], unrecognized: 'unrecognized', patchedOnce: 1, chunkUntouched: true });
	});

	it.skipIf(!fs.existsSync(bundledCli))('fits the CLI bundled with the app', () => {
		const version = fs.readdirSync(bundledCli).find(name => /^\d/.test(name))!;
		const bundle = path.join(bundledCli, version, 'bundle');
		const sources = fs.readdirSync(bundle).filter(name => /^gemini-[A-Za-z0-9]+\.js$/.test(name)).map(name => fs.readFileSync(path.join(bundle, name), 'utf8'));
		// Already patched by scripts/bundle-cli.mts, or patchable now.
		const patched = sources.map(source => source.includes(cliPatchMarker) ? source : patchAcpToolOutput(source));
		expect(patched.every(source => source !== undefined)).toBe(true);
		const file = path.join(dir, 'gemini-check.mjs');
		fs.writeFileSync(file, patched[0]!);
		execFileSync(process.execPath, ['--check', file]);
	});
});
