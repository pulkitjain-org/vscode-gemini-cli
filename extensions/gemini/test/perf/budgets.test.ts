/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Performance budgets. Each check times the work GeminiCode does on the path a
// user waits on (a keystroke, a streamed chunk, switching agents) and fails
// when it is over budget, so a change that slows one down shows up in CI
// rather than in use. Budgets are well above what a laptop measures, so a slow
// CI runner stays green; what they catch is work growing with the transcript
// or the bundle growing by a library. The agent start, which runs the real CLI,
// is timed by scripts/perf-first-reply.mts.

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, type AgentClientState } from '../../src/acp/agentClient';
import { AgentsModel, archiveAfterMs, isArchived, warmThreads } from '../../src/acp/agents';
import { wakeThreadLines, type ThreadInfo } from '../../src/acp/projectHub';
import { AgentRuntime } from '../../src/acp/agentRuntime';
import { AgentSidecar } from '../../src/acp/sidecar';
import { ChatTranscript, type TranscriptItem } from '../../src/acp/chatTranscript';
import { SessionUpdateAdapter } from '../../src/acp/sessionUpdates';
import { TextDeltas } from '../../src/acp/textDeltas';
import { matchCommands, mentionAt, slashQuery } from '../../webview-src/chatLogic';
import { scanStreaming } from '../../webview-src/streaming';
import { fakeAgentCommand, waitFor } from '../helpers';

/** Bundle size budgets in bytes, minified. KaTeX and the highlighter load on demand and are not part of the chat view's first paint. */
export const bundleBudgets: Readonly<Record<string, number>> = {
	// 1.1.0's Rewind, Subagent rows and the Shared page chip took it just past 215 KB; folding finished work
	// (work.ts, workFold.ts) took it to about 225 KB, all GeminiCode's own code. The team tools' chips,
	// + menu section and tool rows with logos took it to about 237 KB; the confirm-class card's effect,
	// the cut-off card and the turn's trace readout to about 241 KB.
	'media/chat.js': 250_000,
	// Home's startup script: Preview's renderer is its own file. The dashboard (cards, Needs you,
	// Customize) and the tools' logos took it to about 25 KB, and Show All's popup to about 28 KB.
	'media/home.js': 30_000,
	'media/changes.js': 16_000,
	// The team flows: Open Merge Request, Move Ticket and Log Time, Review and Checks.
	'media/teamFlow.js': 32_000,
	'media/settings.js': 16_000,
	// The Index page: workspaces' indexes, attached docs, the Add Docs and Files Left Out popups, with the shared select menu and tooltips.
	'media/indexPage.js': 22_000,
	'media/highlight.js': 180_000,
	// Loaded only when a reply has math.
	'media/katex.js': 290_000,
	'media/draftMarkdown.js': 140_000,
	// Projects' settings, memory and threads across repositories took it from 887 KB to 913 KB, all GeminiCode's own code.
	// 1.1.0's saved checkpoints, Rewind, Check for Updates and browser fixes took it to 941 KB, all its own code too.
	// The team tools (five connectors, the geminicode-tools server, Connections, Home's dashboard and the
	// merge request, review, release, Jira and checks flows) took it to about 1,090 KB, all its own code, no libraries.
	// The pages' writes through the agents' tools, the audit log page and keeping flows across a quit took it to
	// about 1,137 KB; loading the ACP SDK only when an agent starts wraps its modules, about 6 KB more, and takes
	// about 12 ms off the bundle's load time. Run Benchmark, the pilot's counters, and the team's own Jira and
	// GitLab servers as children (the stdio MCP client, the take-over) took it to about 1,172 KB, its own code.
	// The workspace index's host side (its client, the geminicode-index server, the docs fetcher, the Index page's host
	// and the status bar) added about 56 KB, all its own code, no libraries.
	'dist/extension.js': 1_200_000,
	// The indexer process: parsing, SQLite queries and docs conversion, forked on first use, never loaded in the extension host.
	'dist/indexer.js': 120_000,
};

/** Median time of `run` over `rounds` runs, in ms. */
function median(rounds: number, run: () => void): number {
	const times: number[] = [];
	for (let i = 0; i < rounds; i++) {
		const start = performance.now();
		run();
		times.push(performance.now() - start);
	}
	return times.sort((a, b) => a - b)[Math.floor(rounds / 2)];
}

describe('bundle size', () => {
	const root = path.join(__dirname, '..', '..');
	for (const [file, budget] of Object.entries(bundleBudgets)) {
		const full = path.join(root, file);
		it.skipIf(!existsSync(full))(`${file} is within ${budget / 1000} KB`, () => {
			expect(statSync(full).size).toBeLessThanOrEqual(budget);
		});
	}
});

describe('a project with 500 threads', () => {
	// A project used for a long time: 500 threads, all but 20 merged, most of those long ago.
	let now = 1_000;
	const model = new AgentsModel(undefined, () => now);
	const workspace = model.addWorkspace('/work/shop').id;
	model.addAgent(workspace, 'Shop', undefined, 'c', { role: 'coordinator' });
	const threads: ThreadInfo[] = [];
	for (let i = 0; i < 500; i++) {
		now += 60 * 60 * 1000;
		const id = model.addAgent(workspace, `Thread ${i} with a title of usual length`, { folder: `/w/t${i}`, cwd: `/w/t${i}`, branch: `gemini/thread-${i}`, base: 'main' }, `t${i}`, { role: 'thread', coordinator: 'c', byCoordinator: true }).id;
		model.recordPrompt(id, 'Do the work');
		model.setChanges(id, { files: 3, added: 40, removed: 12 });
		if (i < 480) {
			model.setThreadResolved(id, true);
		}
		threads.push({ id, title: `Thread ${i}`, state: 'done', byCoordinator: true, ...(i < 480 ? { resolved: true } : {}) });
	}
	now += archiveAfterMs;

	it('opens it starting only a few threads, and lists the rest quickly', () => {
		expect(warmThreads(model.threadsOf('c'))).toHaveLength(6);
		const ms = median(51, () => {
			const all = model.threadsOf('c');
			warmThreads(all);
			all.filter(record => !isArchived(record, now));
		});
		expect(ms).toBeLessThan(5);
	});

	it('keeps the coordinator\'s wake short', () => {
		const lines = wakeThreadLines(threads);
		expect(lines.length).toBeLessThanOrEqual(20 + 10 + 1);
		expect(median(51, () => wakeThreadLines(threads))).toBeLessThan(2);
	});

	it('saves the agent list quickly', () => {
		const json = JSON.stringify(model.snapshot());
		expect(json.length).toBeLessThan(250_000);
		expect(median(21, () => {
			model.recordPrompt('t499', 'One more note');
			JSON.stringify(model.snapshot());
		})).toBeLessThan(10);
	});
});

describe('keystroke', () => {
	it('matches "/" commands and "@" mentions in well under a frame', () => {
		const commands = Array.from({ length: 600 }, (_, i) => ({ name: `command-${i}-${i % 7 ? 'review' : 'deploy'}` }));
		const text = 'Please look at this file and then '.repeat(40) + '/rev';
		const ms = median(201, () => {
			slashQuery(text, text.length, text.length);
			mentionAt(text, text.length, text.length);
			matchCommands(commands, 'rev');
		});
		expect(ms).toBeLessThan(2);
	});
});

describe('streaming', () => {
	it('handles a chunk of a long reply without redoing the whole reply', () => {
		const transcript = new ChatTranscript(() => 0);
		const adapter = new SessionUpdateAdapter();
		const deltas = new TextDeltas();
		transcript.addPrompt('Explain the code');
		const paragraph = 'Some words in a paragraph of the reply, with `code` and **bold**. '.repeat(4) + '\n\n';
		// Grow the reply to about 60 KB first, then time single chunks.
		for (let i = 0; i < 200; i++) {
			transcript.apply(adapter.adapt({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: paragraph } }));
		}
		deltas.reset(transcript.items);
		const reply = () => transcript.items[transcript.items.length - 1] as Extract<TranscriptItem, { kind: 'user' | 'agent' | 'thought' }>;
		let scanned = scanStreaming(reply().text);
		const ms = median(201, () => {
			transcript.apply(adapter.adapt({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one more chunk ' } }));
			deltas.toUpdates([reply()]);
			scanned = scanStreaming(reply().text, scanned.stableEnd);
		});
		expect(ms).toBeLessThan(2);
	});
});

describe('agent switch', () => {
	it('snapshots a long transcript for the view quickly', () => {
		const transcript = new ChatTranscript(() => 0);
		const adapter = new SessionUpdateAdapter();
		for (let turn = 0; turn < 150; turn++) {
			transcript.addPrompt(`Question ${turn}`);
			transcript.apply(adapter.adapt({ sessionUpdate: 'tool_call', toolCallId: `t${turn}`, title: 'Read file', kind: 'read', status: 'completed' }));
			transcript.apply(adapter.adapt({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'An answer of moderate length. '.repeat(40) } }));
		}
		const deltas = new TextDeltas();
		const ms = median(51, () => {
			deltas.reset(transcript.items);
			JSON.stringify(transcript.items);
		});
		expect(ms).toBeLessThan(25);
	});
});

describe('enter to send', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	let client: AgentClient | undefined;
	afterEach(() => {
		client?.dispose();
		runtime?.dispose();
		sidecar?.dispose();
	});

	it('gets a prompt to the agent and its first chunk back with little overhead', async () => {
		const chunk = { step: 'update' as const, update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: 'ok' } } };
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ turns: Array.from({ length: 12 }, () => [chunk]) }), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar, {});
		client = new AgentClient(runtime, { cwd: process.cwd(), requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		const ready = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		const times: number[] = [];
		for (let i = 0; i < 11; i++) {
			const start = performance.now();
			const first = waitFor(client.onDidReceiveEvent, e => e.kind === 'text');
			const turn = client.prompt(`prompt ${i}`);
			await first;
			times.push(performance.now() - start);
			await turn;
		}
		// The fake agent answers at once, so this is GeminiCode's own overhead plus one round trip over stdio.
		expect(times.sort((a, b) => a - b)[5]).toBeLessThan(30);
	});
});
