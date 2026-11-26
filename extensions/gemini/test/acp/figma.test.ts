/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { figmaDesignLimit, FigmaDesktop, FigmaTimeoutError, isCodeConnectPrompt, topLevelParts } from '../../src/acp/figma';

type Call = { readonly method: string; readonly session?: string; readonly name?: string; readonly args?: Record<string, unknown> };
type ToolAnswer = { readonly text?: string; readonly isError?: boolean; readonly status?: number; readonly image?: boolean };

const link = 'https://www.figma.com/design/KEY/Shop?node-id=17924-40596&m=dev';
const outline = '<frame id="17924:40596" name="S" x="0" y="0" width="768" height="1642">\n  <instance id="17924:40597" name="header" x="0" y="0" width="768" height="60" />\n  <frame id="17924:40598" name="settings" x="0" y="60" width="768" height="1500" />\n</frame>';

/**
 * A fake Figma Dev Mode server: a session per initialize, and tool answers
 * from `answer`, called with the tool's name and arguments. Records every
 * request, and how many tool calls overlapped.
 */
function fakeFigma(answer: (name: string, args: Record<string, unknown>, calls: readonly Call[]) => ToolAnswer | Promise<ToolAnswer>) {
	const calls: Call[] = [];
	let sessions = 0;
	let running = 0;
	let overlapped = 0;
	const fetcher = (async (_url: string, init: RequestInit) => {
		const session = (init.headers as Record<string, string>)['Mcp-Session-Id'];
		if (init.method === 'DELETE') {
			calls.push({ method: 'DELETE', session });
			return new Response(null, { status: 200 });
		}
		const body = JSON.parse(String(init.body));
		const call: Call = { method: body.method, ...session ? { session } : {}, ...body.params?.name ? { name: body.params.name, args: body.params.arguments } : {} };
		calls.push(call);
		const event = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
		switch (body.method) {
			case 'initialize':
				sessions++;
				return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { version: '1.0.0' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': `s${sessions}` } });
			case 'notifications/initialized':
				return new Response(null, { status: 202 });
			case 'tools/list':
				return event({ tools: ['get_design_context', 'get_variable_defs', 'get_screenshot', 'get_metadata'].map(name => ({ name })) });
			default: {
				running++;
				overlapped = Math.max(overlapped, running);
				await new Promise(resolve => setTimeout(resolve, 5));
				const reply = await answer(call.name!, call.args ?? {}, calls);
				running--;
				if (reply.status) {
					return new Response(null, { status: reply.status });
				}
				return event({ content: reply.image ? [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] : [{ type: 'text', text: reply.text ?? '' }], ...reply.isError ? { isError: true } : {} });
			}
		}
	}) as typeof fetch;
	return { fetcher, calls, overlapped: () => overlapped };
}

/** Plain answers: design code, variables, an outline, a screenshot. */
function figmaAnswers(name: string, args: Record<string, unknown>): ToolAnswer {
	switch (name) {
		case 'get_design_context': return { text: `<div>${String(args.nodeId)}</div>` };
		case 'get_variable_defs': return { text: '{"type/body":"Font(family: Maison Neue, size: 16)"}' };
		case 'get_metadata': return { text: outline };
		case 'get_screenshot': return { image: true };
		default: return { isError: true, text: 'unknown' };
	}
}

describe('FigmaDesktop', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('stops one read after its deadline, and leaves the sections it didn\'t reach for later', async () => {
		vi.useFakeTimers();
		const figma = fakeFigma(figmaAnswers);
		// Figma never finishes a design read; it answers the rest.
		const fetcher = ((url: string, init: RequestInit) => {
			const body = init.body ? JSON.parse(String(init.body)) : {};
			if (body.params?.name === 'get_design_context') {
				return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
			}
			return figma.fetcher(url, init);
		}) as typeof fetch;
		const started = Date.now();
		const read = new FigmaDesktop('http://figma', fetcher).designContext(link);
		await vi.advanceTimersByTimeAsync(181_000);
		const content = await read;
		expect({ intro: content[0], seconds: Math.round((Date.now() - started) / 1000) }).toEqual({
			intro: { type: 'text', text: 'GeminiCode stopped waiting for Figma\'s tools/call after 120 s. Here are its outline and design variables instead. GeminiCode stopped waiting for Figma\'s tools/call after 60 s. The other sections weren\'t read. Not read yet: 17924:40597 "header", 17924:40598 "settings". Call figma_design with a link to one of these node ids (node-id=17924-40597) to read it.' },
			seconds: 181,
		});
	});

	it('reads a frame without its screenshot or Code Connect, and reuses the answer', async () => {
		const figma = fakeFigma(figmaAnswers);
		const desktop = new FigmaDesktop('http://figma', figma.fetcher);
		const first = await desktop.designContext(link);
		const again = await desktop.designContext(link);
		const design = figma.calls.find(call => call.name === 'get_design_context');
		expect({ first, same: again, args: design?.args, reads: figma.calls.filter(call => call.name === 'get_design_context').length }).toEqual({
			first: [{ type: 'text', text: '<div>17924:40596</div>' }, { type: 'text', text: '{"type/body":"Font(family: Maison Neue, size: 16)"}' }],
			same: first,
			args: { nodeId: '17924:40596', clientFrameworks: 'React', clientLanguages: 'TypeScript,CSS', excludeScreenshot: true, disableCodeConnect: true },
			reads: 1,
		});
	});

	it('asks again without Code Connect when Figma asks about it instead of answering', async () => {
		const figma = fakeFigma((name, args) => name === 'get_design_context' && !args.disableCodeConnect
			? { text: 'Components in the design the user selected is missing code connect mappings. Please ask the user...' }
			: figmaAnswers(name, args));
		const content = await new FigmaDesktop('http://figma', figma.fetcher).designContext(link, { codeConnect: true });
		expect({ text: content[0], designCalls: figma.calls.filter(call => call.name === 'get_design_context').map(call => call.args?.disableCodeConnect ?? false) }).toEqual({
			text: { type: 'text', text: '<div>17924:40596</div>' },
			designCalls: [false, true],
		});
	});

	it('answers a frame Figma stopped reading with its sections, read one at a time', async () => {
		const figma = fakeFigma((name, args) => name === 'get_design_context' && args.nodeId === '17924:40596'
			? { isError: true, text: 'This operation was aborted' }
			: figmaAnswers(name, args));
		const content = await new FigmaDesktop('http://figma', figma.fetcher).designContext(link);
		expect(content).toEqual([
			{ type: 'text', text: 'Figma didn\'t finish reading this frame (Figma reported: This operation was aborted). It was read one section at a time instead.' },
			{ type: 'text', text: 'Section "header" (17924:40597):\n<div>17924:40597</div>' },
			{ type: 'text', text: 'Section "settings" (17924:40598):\n<div>17924:40598</div>' },
			{ type: 'text', text: '{"type/body":"Font(family: Maison Neue, size: 16)"}' },
		]);
	});

	it('splits a large design into parts the CLI won\'t cut, and reads a very large one in sections', async () => {
		const line = `${'x'.repeat(99)}\n`;
		const figma = fakeFigma((name, args) => name === 'get_design_context' ? { text: line.repeat(args.nodeId === '17924:40596' ? 465 : 1700) } : figmaAnswers(name, args));
		const large = await new FigmaDesktop('http://figma', figma.fetcher).designContext(link);
		// A page past the limit: its first section fits the answer, and the next, which would pass the limit, is named to read later.
		const lines: Record<string, number> = { '17924:40596': 1700, '17924:40597': 300, '17924:40598': 400 };
		const page = fakeFigma((name, args) => name === 'get_design_context' ? { text: line.repeat(lines[String(args.nodeId)]) } : figmaAnswers(name, args));
		const sections = await new FigmaDesktop('http://figma', page.fetcher).designContext(link);
		const texts = sections.map(c => c.type === 'text' ? c.text : '');
		expect({
			large: large.map(c => c.type === 'text' ? c.text.length : c.type),
			intro: texts[0],
			read: texts.filter(text => text.startsWith('Section')).map(text => text.split('\n')[0]),
			longest: Math.max(...texts.map(text => text.length)),
		}).toEqual({
			large: [38_000, 8_500, 51],
			intro: 'This frame\'s design is larger than one answer. It was read one section at a time instead. Not read yet: 17924:40598 "settings". Call figma_design with a link to one of these node ids (node-id=17924-40598) to read it.',
			read: ['Section "header" (17924:40597):'],
			longest: 30_032,
		});
		expect(texts.join('').length).toBeLessThan(figmaDesignLimit + 1000);
	});

	it('keeps a design by its file, node, frameworks and languages, and never keeps the selection', async () => {
		const figma = fakeFigma(figmaAnswers);
		const desktop = new FigmaDesktop('http://figma', figma.fetcher);
		await desktop.designContext(link);
		await desktop.designContext(link);
		await desktop.designContext(link.replace('/KEY/', '/OTHER/'));
		await desktop.designContext(link, { languages: 'JavaScript,CSS' });
		const selection = 'https://www.figma.com/design/KEY/Shop';
		await desktop.designContext(selection);
		await desktop.designContext(selection);
		expect(figma.calls.filter(call => call.name === 'get_design_context').map(call => `${String(call.args?.nodeId ?? 'selection')} ${String(call.args?.clientLanguages)}`)).toEqual([
			'17924:40596 TypeScript,CSS',
			'17924:40596 TypeScript,CSS',
			'17924:40596 JavaScript,CSS',
			'selection TypeScript,CSS',
			'selection TypeScript,CSS',
		]);
	});

	it('doesn\'t keep Figma\'s Code Connect question when it asks it again', async () => {
		const figma = fakeFigma((name, args) => name === 'get_design_context' ? { text: 'Components in the design the user selected is missing code connect mappings.' } : figmaAnswers(name, args));
		const desktop = new FigmaDesktop('http://figma', figma.fetcher);
		await desktop.designContext(link, { codeConnect: true });
		await desktop.designContext(link, { codeConnect: true });
		expect(figma.calls.filter(call => call.name === 'get_design_context').length).toBe(4);
	});

	it('stops a call waiting behind a stuck read once its own time is up, without sending it', async () => {
		vi.useFakeTimers();
		const figma = fakeFigma(figmaAnswers);
		const fetcher = ((url: string, init: RequestInit) => {
			const body = init.body ? JSON.parse(String(init.body)) : {};
			if (body.params?.name === 'get_design_context') {
				return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
			}
			return figma.fetcher(url, init);
		}) as typeof fetch;
		const desktop = new FigmaDesktop('http://figma', fetcher);
		const stuck = desktop.designContext(link);
		await vi.advanceTimersByTimeAsync(1000);
		const shot = desktop.screenshot(link).then(() => 'answered', (err: Error) => err.message);
		await vi.advanceTimersByTimeAsync(91_000);
		const waited = await shot;
		await vi.advanceTimersByTimeAsync(200_000);
		await stuck;
		expect({ waited, sent: figma.calls.filter(call => call.name === 'get_screenshot').length }).toEqual({
			waited: 'GeminiCode stopped waiting for Figma\'s get_screenshot behind another Figma read after 90 s.',
			sent: 0,
		});
	});

	it('doesn\'t keep an answer Figma didn\'t finish', async () => {
		let failing = true;
		const figma = fakeFigma((name, args) => failing && name === 'get_design_context' && args.nodeId === '17924:40596'
			? { isError: true, text: 'This operation was aborted' }
			: figmaAnswers(name, args));
		const desktop = new FigmaDesktop('http://figma', figma.fetcher);
		const degraded = await desktop.designContext(link);
		failing = false;
		const whole = await desktop.designContext(link);
		const again = await desktop.designContext(link);
		expect({ degraded: degraded.length, whole, again, reads: figma.calls.filter(call => call.name === 'get_design_context' && call.args?.nodeId === '17924:40596').length }).toEqual({
			degraded: 4,
			whole: [{ type: 'text', text: '<div>17924:40596</div>' }, { type: 'text', text: '{"type/body":"Font(family: Maison Neue, size: 16)"}' }],
			again: whole,
			reads: 2,
		});
	});

	it('opens the connection again after Figma restarted, and calls once more', async () => {
		const figma = fakeFigma((name, args, calls) => calls.filter(call => call.name === 'get_screenshot').length === 1 && name === 'get_screenshot' ? { status: 400 } : figmaAnswers(name, args));
		const content = await new FigmaDesktop('http://figma', figma.fetcher).screenshot(link);
		expect({ content, sessions: figma.calls.filter(call => call.name === 'get_screenshot').map(call => call.session) }).toEqual({
			content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
			sessions: ['s1', 's2'],
		});
	});

	it('checks Figma on a connection of its own, and sends reads one at a time', async () => {
		const figma = fakeFigma(figmaAnswers);
		const desktop = new FigmaDesktop('http://figma', figma.fetcher);
		await desktop.screenshot(link);
		const status = await desktop.status();
		await Promise.all([desktop.screenshot(link), desktop.designContext(link), desktop.screenshot(link)]);
		expect({ status, toolSessions: [...new Set(figma.calls.filter(call => call.name).map(call => call.session))], closed: figma.calls.filter(call => call.method === 'DELETE').map(call => call.session), overlapped: figma.overlapped() }).toEqual({
			status: { running: true, version: '1.0.0' },
			toolSessions: ['s1'],
			closed: ['s2'],
			overlapped: 1,
		});
	});

	it('says whose limit a timeout was, and finds the parts and Code Connect questions it needs', () => {
		expect({
			timeout: new FigmaTimeoutError('tools/call', 120_000).message,
			parts: topLevelParts(outline),
			prompt: isCodeConnectPrompt([{ type: 'text', text: 'run the tool get_code_connect_suggestions with fileKey' }]),
		}).toEqual({
			timeout: 'GeminiCode stopped waiting for Figma\'s tools/call after 120 s.',
			parts: [{ id: '17924:40597', name: 'header', type: 'instance' }, { id: '17924:40598', name: 'settings', type: 'frame' }],
			prompt: true,
		});
	});
});
