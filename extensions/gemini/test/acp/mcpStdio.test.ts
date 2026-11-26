/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { McpStdioClient } from '../../src/acp/mcpStdio';

/** A server that answers `initialize` and then ignores both the end of its input and SIGTERM, like a hung container client. */
const stubborn = `
process.on('SIGTERM', () => undefined);
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => undefined);
process.stdin.on('data', chunk => {
	for (const line of chunk.split('\\n').filter(Boolean)) {
		const message = JSON.parse(line);
		if (message.method === 'initialize') {
			process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stubborn', version: '1' } } }) + '\\n');
		}
	}
});
setInterval(() => undefined, 1000);
`;

describe('McpStdioClient', () => {
	let client: McpStdioClient | undefined;
	afterEach(() => client?.close());

	it('kills a server that ignores being asked to stop', async () => {
		client = await McpStdioClient.start({ command: process.execPath, args: ['-e', stubborn], env: process.env }, 10_000);
		const child = (client as unknown as { child: import('node:child_process').ChildProcess }).child;
		const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
		client.close();
		expect(client.alive).toBe(false);
		expect(await exited).toBe('SIGKILL');
	}, 10_000);
});
