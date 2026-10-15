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
	'media/chat.js': 215_000,
	// Agent Home's startup script: Preview's renderer is its own file.
	'media/home.js': 16_000,
	'media/changes.js': 16_000,
	'media/settings.js': 16_000,
	'media/highlight.js': 180_000,
	// Loaded only when a reply has math.
	'media/katex.js': 290_000,
	'media/draftMarkdown.js': 140_000,
	'dist/extension.js': 900_000,
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
