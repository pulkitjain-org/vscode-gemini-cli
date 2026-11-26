/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A scripted MCP server over stdio for tests, standing in for the team's own servers
// (mcp-atlassian, gitlab-mcp) that the team tools run as children:
//
//   node test/fake-mcp/fakeMcpServer.ts <script.json> <calls.jsonl>
//
// Each tool call is appended to calls.jsonl as {"name", "arguments"} and answered from the script.

import { appendFileSync, readFileSync } from 'node:fs';

export interface FakeMcpScript {
	/** Exit with this code before answering anything, like a container that can't start. */
	readonly exitCode?: number;
	/** Answers `initialize` after this long, like a container starting or an image downloading. */
	readonly initializeDelayMs?: number;
	/** Each tool's answer: text, or JSON sent as text as the real servers do, or an error. */
	readonly tools: Readonly<Record<string, { readonly text?: string; readonly json?: unknown; readonly isError?: boolean; /** Answers after this long, like a scan. */ readonly delayMs?: number }>>;
	/** Exit while answering this tool, after the call arrived. */
	readonly exitDuring?: string;
}

const [scriptPath, callsPath] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as FakeMcpScript;
if (script.exitCode !== undefined) {
	process.exit(script.exitCode);
}

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let end: number;
	while ((end = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (line) {
			handle(JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
		}
	}
});
process.stdin.on('end', () => process.exit(0));

function handle(message: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }): void {
	if (message.id === undefined) {
		return;
	}
	switch (message.method) {
		case 'initialize':
			// A stray log line on stdout, as some servers print; the client skips it.
			process.stdout.write('starting fake server\n');
			return void setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }), script.initializeDelayMs ?? 0);
		case 'tools/list':
			return send({ jsonrpc: '2.0', id: message.id, result: { tools: Object.keys(script.tools).map(name => ({ name, inputSchema: { type: 'object' } })) } });
		case 'tools/call': {
			const name = message.params?.name ?? '';
			appendFileSync(callsPath, `${JSON.stringify({ name, arguments: message.params?.arguments ?? {} })}\n`);
			if (script.exitDuring === name) {
				process.exit(3);
			}
			const answer = script.tools[name];
			if (!answer) {
				return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
			}
			const text = answer.text ?? JSON.stringify(answer.json ?? {});
			const result = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], ...answer.isError ? { isError: true } : {} } };
			return void setTimeout(() => send(result), answer.delayMs ?? 0);
		}
		default:
			return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `No method ${message.method}` } });
	}
}
