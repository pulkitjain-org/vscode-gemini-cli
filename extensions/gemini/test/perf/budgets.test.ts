/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Performance budgets. Each check times the work GeminiCode does on the path a
// user waits on (a keystroke, a streamed chunk, switching agents) and fails
// when it is over budget, so a change that slows one down shows up in CI
// rather than in use. Budgets are well above what a laptop measures, so a slow
// CI runner stays green; what they catch is work growing with the transcript
// or the bundle growing by a library. The agent start, which runs the real CLI,
// is timed by scripts/perf-first-reply.mts.

import { existsSync, readdirSync, statSync } from 'node:fs';
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

/**
 * Bundle size budgets in bytes, minified: every script in media/ and dist/ has one. KaTeX and the
 * highlighter load on demand and are not part of the chat view's first paint. Sizes in the comments
 * are as of the latest change to a budget.
 */
export const bundleBudgets: Readonly<Record<string, number>> = {
	// The chat view: about 238 KB, all GeminiCode's own code apart from the Markdown splitter it shares.
	// Writing the bundles as UTF-8 rather than escaping non-ASCII text took about 21 KB off; reactions,
	// the queue strip and the trace readout added most of what came after. The review fixes took it to about
	// 255 KB: notices with Retry and the stall notice, prefix approvals answered from the keyboard, trimmed tool
	// output, the mode, Build and Commit menus, the context breakdown and the @ picker's new groups. The project
	// settings panel (about 9 KB, project chats only) is the next candidate for a chunk of its own.
	'media/chat.js': 260_000,
	// Home's startup script, about 26 KB: Preview's renderer, the menus and the popups are files of their own.
	// The dashboard (cards, Needs you, banners), the composer and the themed tooltips take most of it.
	'media/home.js': 30_000,
	// The Changes panel, about 12 KB.
	'media/changes.js': 16_000,
	// The team flows, about 32 KB: Open Merge Request, Move Ticket and Log Time, Review and Checks, with the
	// review's comments, threads and suggested changes. Loaded only with a flow's page.
	'media/teamFlow.js': 36_000,
	// Project Helpers, about 17.3 KB: the Storage section added about 1.4 KB.
	'media/settings.js': 19_000,
	// Connections, about 13.5 KB.
	'media/connections.js': 16_000,
	// The audit log page, about 8 KB.
	'media/auditLog.js': 10_000,
	// The Index page, about 19 KB: workspaces' indexes, attached docs, the Add Docs and Files Left Out popups,
	// with the shared select menu and tooltips.
	'media/indexPage.js': 22_000,
	// The rich Jira comment box, about 22.5 KB, loaded the first time a page opens one.
	'media/commentBox.js': 26_000,
	// About 158 KB.
	'media/highlight.js': 180_000,
	// About 265 KB, loaded only when a reply has math.
	'media/katex.js': 290_000,
	// About 110 KB, loaded the first time a draft is shown as Markdown.
	'media/draftMarkdown.js': 140_000,
	// Home's Show All list and Customize menu, loaded the first time either opens.
	'media/homePopups.js': 5_000,
	// Home's menus (+, folder, mode, From Your Tools, a row's "...") with the menu class, about 7.6 KB, loaded once
	// Home has settled or on the first click on a menu's button.
	'media/homeMenus.js': 9_000,
	// The emoji picker, about 97 KB, loaded the first time a reaction button is hovered or focused: about 88 KB
	// of emoji data (1,923 emoji with their names and three search words each) and its own code.
	'media/emojiPicker.js': 105_000,
	// The extension host's bundle, about 1,061 KB: GeminiCode's own code, the ACP SDK and zod with its English
	// messages only (esbuild.mts). Project Helpers, Connections, the audit log, Run Benchmark, the pilot and the
	// trace recorder moved to dist/pages.js and dist/onDemand.js, about 60 KB.
	'dist/extension.js': 1_200_000,
	// Project Helpers and Connections, about 96 KB, loaded the first time one is opened (src/pages.ts): their own code
	// and their copy of jsonc-parser (about 17 KB), which edits the Gemini CLI's settings files keeping their comments.
	// Project Helpers' Storage section, with the storage measuring and Clean Up's list, is about 9 KB of it.
	'dist/pages.js': 105_000,
	// The audit log, Run Benchmark, the pilot's export and the trace recorder, about 31 KB, loaded the first time
	// one of their commands runs (src/onDemand.ts).
	'dist/onDemand.js': 40_000,
	// The indexer process, about 66 KB: parsing, SQLite queries and docs conversion, forked on first use, never
	// loaded in the extension host.
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
	// Locally a bundle that is not built is skipped; CI builds them all first (gemini-ci.yml), so there a missing one fails.
	const ci = !!process.env.CI;
	for (const [file, budget] of Object.entries(bundleBudgets)) {
		const full = path.join(root, file);
		it.skipIf(!ci && !existsSync(full))(`${file} is within ${budget / 1000} KB`, () => {
			expect(existsSync(full), `${file} is not built: run node esbuild.mts and node esbuild.webview.mts`).toBe(true);
			expect(statSync(full).size).toBeLessThanOrEqual(budget);
		});
	}

	it.skipIf(!ci && !['media', 'dist'].every(dir => existsSync(path.join(root, dir))))('has a budget for every script in media/ and dist/', () => {
		const built = ['media', 'dist'].flatMap(dir => existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir)).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`) : []);
		expect(built.filter(file => !Object.hasOwn(bundleBudgets, file))).toEqual([]);
	});
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
