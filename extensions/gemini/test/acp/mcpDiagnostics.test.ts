/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpDiagnostics, McpProblem, parseMcpProblems } from '../../src/acp/mcpDiagnostics';
import { waitFor } from '../helpers';

// Copied from gemini-cli 0.62's debug log with two broken servers configured.
const log = [
	`[2026-10-04T10:36:51.904Z] [DEBUG] Ignore file not found: /work/.geminiignore, continue without it.`,
	`[2026-10-04T10:36:51.939Z] [DEBUG] Experiments loaded {`,
	`  experimentIds: [],`,
	`}`,
	`[2026-10-04T10:36:52.038Z] [LOG] [MCP error] Error during discovery for MCP server 'broken': spawn /nonexistent/server ENOENT Error: spawn /nonexistent/server ENOENT`,
	`    at ChildProcess._handle.onexit (node:internal/child_process:285:19)`,
	`  code: 'ENOENT',`,
	`}`,
	`[2026-10-04T10:36:52.082Z] [LOG] [MCP error] Error during discovery for MCP server 'badhttp': fetch failed TypeError: fetch failed`,
	`    at node:internal/deps/undici/undici:14902:13`,
	`[2026-10-04T10:36:52.082Z] [LOG] Scheduling MCP context refresh...`,
	`[2026-10-04T10:36:53.000Z] [LOG] [MCP warning] MCP server 'jira' requires authentication using: /mcp auth jira`,
].join('\n') + '\n';

describe('parseMcpProblems', () => {
	it('finds each MCP problem, its server and the reason without the stack', () => {
		expect(parseMcpProblems(log.split('\n'))).toEqual([
			{ severity: 'error', server: 'broken', message: 'spawn /nonexistent/server ENOENT' },
			{ severity: 'error', server: 'badhttp', message: 'fetch failed' },
			{ severity: 'warning', server: 'jira', message: 'MCP server \'jira\' requires authentication using: /mcp auth jira' },
		]);
	});

	it('ignores MCP text that is not the start of an entry', () => {
		expect(parseMcpProblems(['    [MCP error] in a stack trace', '[MCP error] no timestamp'])).toEqual([]);
	});
});

describe('McpDiagnostics', () => {
	let dir: string | undefined;
	let diagnostics: McpDiagnostics | undefined;

	afterEach(async () => {
		diagnostics?.dispose();
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('reports each problem once, across partial writes, until reset', async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'gemini-mcp-'));
		const file = path.join(dir, 'logs', 'cli-debug.log');
		diagnostics = new McpDiagnostics(file);
		const seen: McpProblem[] = [];
		diagnostics.onDidReport(problem => seen.push(problem));

		expect(diagnostics.reset()).toBe(true);
		const [head, tail] = [log.slice(0, 300), log.slice(300)];
		await appendFile(file, head);
		await diagnostics.read();
		await appendFile(file, tail + tail);
		await diagnostics.read();
		expect(seen.map(p => p.server)).toEqual(['broken', 'badhttp', 'jira']);

		diagnostics.reset();
		expect(await readFile(file, 'utf8')).toBe('');
		await appendFile(file, log);
		await diagnostics.read();
		expect(seen).toHaveLength(6);
	});

	it('reads the log when the CLI writes to it', async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'gemini-mcp-'));
		const file = path.join(dir, 'cli-debug.log');
		diagnostics = new McpDiagnostics(file);
		const reported = waitFor(diagnostics.onDidReport);
		diagnostics.reset();
		await appendFile(file, log);
		expect(await reported).toMatchObject({ server: 'broken' });
	});
});
