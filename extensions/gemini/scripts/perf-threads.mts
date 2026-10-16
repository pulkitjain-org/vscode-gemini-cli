/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Measures what keeping a project's threads warm costs, with the real Gemini
// CLI, your own sign-in and a real repository:
//
// - the agent starting (`initialize`), once per window;
// - each new session (`session/new`) in the repository, one after another,
//   against one in an empty folder that loads no MCP servers or rules, so the
//   difference is what the repository's MCP servers and rules add;
// - the agent's memory, with the MCP server processes it started, after each;
// - reopening saved chats (`session/load`), longest first, and how many
//   updates each replays.
//
//   node --experimental-transform-types --no-warnings extensions/gemini/scripts/perf-threads.mts \
//     --cli <gemini.js or gemini> --repo <folder> [--load <folder>]... [--sessions 8] [--reopen 3] [--out results.json]
//
// It works on a copy of ~/.gemini in a temporary folder (GEMINI_CLI_HOME), so
// it never changes your saved chats or settings. It sends no prompts, so it
// uses no quota beyond the sign-in refresh each session makes.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { chatsFolder, listCliSessions } from '../src/acp/cliSessions.ts';
import { isOlderThan } from '../src/acp/cliResolution.ts';

const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' },
		repo: { type: 'string' },
		load: { type: 'string', multiple: true },
		sessions: { type: 'string', default: '8' },
		reopen: { type: 'string', default: '3' },
		out: { type: 'string' },
	},
});
if (!args.cli || !args.repo) {
	console.log('Pass --cli with the Gemini CLI (its bundle/gemini.js, or the gemini executable) and --repo with a repository folder.');
	process.exit(1);
}
const cli = path.resolve(args.cli);
const repo = path.resolve(args.repo);
const loadFolders = (args.load?.length ? args.load : [repo]).map(folder => path.resolve(folder));
const sessionCount = Number(args.sessions);
const reopenCount = Number(args.reopen);

// A copy of ~/.gemini without its chats, then the chats of the folders to reopen.
const realHome = path.join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
if (!existsSync(realHome)) {
	console.log(`No ${realHome}: sign in with the Gemini CLI first.`);
	process.exit(1);
}
const cliHomeRoot = mkdtempSync(path.join(tmpdir(), 'perf-threads-'));
const cliHome = path.join(cliHomeRoot, '.gemini');
cpSync(realHome, cliHome, { recursive: true, filter: source => source !== path.join(realHome, 'tmp') });
for (const folder of loadFolders) {
	const chats = await chatsFolder(folder, realHome);
	if (chats) {
		cpSync(path.dirname(chats), path.join(cliHome, 'tmp', path.basename(path.dirname(chats))), { recursive: true });
	} else {
		console.log(`No saved chats for ${folder}; nothing to reopen there.`);
	}
}
const empty = path.join(cliHomeRoot, 'empty');
mkdirSync(empty);

const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_CLI_HOME: cliHomeRoot, GEMINI_CLI_NO_RELAUNCH: 'true' };
const [command, commandArgs] = /\.[cm]?js$/.test(cli) ? [process.execPath, [cli, '--acp']] : [cli, ['--acp']];
const started = performance.now();
const child = spawn(command, commandArgs, { cwd: repo, env, stdio: 'pipe', shell: process.platform === 'win32' && !/\.[cm]?js$/.test(cli) });
let stderr = '';
child.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-4000));
// Only one request runs at a time, so all updates since it started are its own.
let updates = 0;
let lastUpdateAt = 0;
const connection = acp.client({ name: 'perf-threads' })
	.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' as const } }))
	.onNotification('session/update', () => {
		updates++;
		lastUpdateAt = performance.now();
	})
	.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));

/** The agent's process and every process under it (its MCP servers): their count and memory in MB. Unknown on Windows. */
function memory(): { processes: number; mb: number } | undefined {
	if (process.platform === 'win32' || !child.pid) {
		return undefined;
	}
	const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
	const tree = new Set([child.pid]);
	for (let grew = true; grew;) {
		grew = false;
		for (const [pid, ppid] of rows) {
			if (tree.has(ppid) && !tree.has(pid)) {
				tree.add(pid);
				grew = true;
			}
		}
	}
	const kb = rows.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0);
	return { processes: tree.size, mb: Math.round(kb / 1024) };
}

const timed = async <T,>(work: () => Promise<T>): Promise<[T, number]> => {
	const at = performance.now();
	const result = await work();
	return [result, Math.round(performance.now() - at)];
};

const results: Record<string, unknown> = { cli, repo, platform: `${process.platform} ${process.arch}`, at: new Date().toISOString() };
try {
	const init = await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
	const version = (init as { agentInfo?: { version?: string } }).agentInfo?.version ?? '';
	results.version = version;
	results.initializeMs = Math.round(performance.now() - started);
	results.memoryAfterStart = memory();
	console.log(`Gemini CLI ${version || '(version unknown)'}: agent started in ${results.initializeMs} ms`);

	const [, emptyMs] = await timed(() => connection.agent.request('session/new', { cwd: empty, mcpServers: [] }));
	results.emptyFolderSessionMs = emptyMs;
	console.log(`Session in an empty folder (no MCP servers or rules): ${emptyMs} ms`);

	const sessions: { ms: number; memory?: { processes: number; mb: number } }[] = [];
	for (let i = 0; i < sessionCount; i++) {
		const [, ms] = await timed(() => connection.agent.request('session/new', { cwd: repo, mcpServers: [] }));
		// MCP servers may still be starting once the answer comes; give them a moment before reading memory.
		await new Promise(resolve => setTimeout(resolve, 1_000));
		sessions.push({ ms, memory: memory() });
		const mem = sessions[i].memory;
		console.log(`Session ${String(i + 1).padStart(2)} in the repository: ${String(ms).padStart(5)} ms${mem ? `, ${mem.processes} processes, ${mem.mb} MB in all` : ''}`);
	}
	results.repoSessions = sessions;

	// The CLI answers `session/load` and then replays the chat as updates, so a
	// chat is reopened once the updates stop (nothing for 2 s).
	const replayEnd = async (from: number): Promise<number> => {
		while (performance.now() - Math.max(lastUpdateAt, from) < 2_000) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return Math.round(Math.max(lastUpdateAt, from) - from);
	};
	const reopened: { folder: string; prompts: number; replayUpdates: number; answerMs: number; replayDoneMs?: number; error?: string }[] = [];
	const byNumber = !!version && isOlderThan(version, '0.63.0');
	for (const folder of loadFolders) {
		const saved = (await listCliSessions(folder, { home: cliHome })).sort((a, b) => b.replayUpdates - a.replayUpdates).slice(0, reopenCount);
		for (const session of saved) {
			const id = byNumber ? String(session.index) : session.id;
			const from = performance.now();
			const before = updates;
			try {
				const [, answerMs] = await timed(() => connection.agent.request('session/load', { sessionId: id, cwd: folder, mcpServers: [] }));
				const replayDoneMs = Math.max(answerMs, await replayEnd(from));
				reopened.push({ folder, prompts: session.messages, replayUpdates: updates - before, answerMs, replayDoneMs });
			} catch (err) {
				reopened.push({ folder, prompts: session.messages, replayUpdates: session.replayUpdates, answerMs: -1, error: err instanceof Error ? err.message : JSON.stringify(err) });
			}
			const last = reopened[reopened.length - 1];
			console.log(`Reopen a chat with ${String(last.prompts).padStart(3)} prompts: ${last.error ? `failed, ${last.error}` : `answered in ${last.answerMs} ms, ${last.replayUpdates} updates replayed by ${last.replayDoneMs} ms`}`);
		}
	}
	results.reopened = reopened;
	results.memoryAtEnd = memory();
} catch (err) {
	console.log(`Stopped: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
	console.log(stderr.trim());
	results.error = String(err);
} finally {
	child.kill();
	rmSync(cliHomeRoot, { recursive: true, force: true, maxRetries: 3 });
}

const out = path.resolve(args.out ?? `perf-threads-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(out, `${JSON.stringify(results, undefined, '\t')}\n`);
console.log(`\nSaved to ${out}. Send that file back.`);
