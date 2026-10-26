/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Figma through the Figma desktop app's Dev Mode MCP server on this Mac
// (127.0.0.1:3845), so it uses the user's signed-in Figma and their Dev seat
// and needs no token. GeminiCode is a small MCP client of it: it asks for a
// frame's design context (code hints, variables) and screenshot by link.
//
// Figma takes several seconds for a frame's design context, and may give up
// on one by itself, so a read is kept small and never fails outright: the
// screenshot and Code Connect are left out of design context (the agent asks
// for a screenshot on its own), a frame too large for one answer is read a
// section at a time, and a read Figma stops is answered with the frame's
// outline and design variables instead. Requests go one at a time, results
// are kept for a while, and a connection Figma forgot (after it restarted)
// is opened again.

import { Fetch } from './teamHttp';

export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';

/** How long one design context read may take before GeminiCode stops waiting; Figma takes about 6 s for a phone-sized frame. */
export const figmaReadTimeoutMs = 120_000;
/** How long one figma_design call may take in all, its sections included: Figma reads one thing at a time, and screenshots and other reads wait behind it. */
export const figmaDesignDeadlineMs = 180_000;
/** How long any other call may wait for its turn behind other Figma reads, more than its own time. */
export const figmaQueueWaitMs = 30_000;
/**
 * The most design code one answer carries, about 16,000 tokens; a larger
 * frame is read a section at a time, and the rest named for later calls.
 * Kept well under the size of a few of the CLI's 40,000-character parts, so
 * one call never hands the model a whole page of code at once.
 */
export const figmaDesignLimit = 64_000;
/** Each part of an answer stays under the Gemini CLI's cap on one part of a tool's output (40,000 characters), which would cut it. */
export const figmaPartLimit = 38_000;
/** How long a frame's design is reused. */
const cacheMs = 10 * 60_000;

export interface FigmaStatus {
	readonly running: boolean;
	readonly problem?: string;
	readonly version?: string;
}

export interface FigmaReadOptions {
	readonly frameworks?: string;
	readonly languages?: string;
	/** Whether Figma looks up Code Connect mappings, which can make it ask questions instead of answering. */
	readonly codeConnect?: boolean;
	/** Stops the read, such as when the tool call is cancelled: what was read by then is answered. */
	readonly signal?: AbortSignal;
}

/** The file key and node id of a Figma link such as `https://www.figma.com/design/KEY/Name?node-id=12-34`. */
export function parseFigmaLink(link: string): { readonly fileKey: string; readonly nodeId?: string } | undefined {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return undefined;
	}
	if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
		return undefined;
	}
	const key = /^\/(?:design|file|proto|board)\/([\w-]+)/.exec(url.pathname)?.[1];
	if (!key) {
		return undefined;
	}
	const node = url.searchParams.get('node-id');
	return { fileKey: key, ...node ? { nodeId: node.replace(/-/g, ':') } : {} };
}

/** What the team tools ask of Figma: FigmaDesktop, loaded from dist/onDemand.js on first use. */
export interface FigmaClient {
	status(): Promise<FigmaStatus>;
	designContext(link: string, options?: FigmaReadOptions): Promise<FigmaContent[]>;
	screenshot(link: string): Promise<FigmaContent[]>;
}

export type FigmaContent = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** A request GeminiCode stopped waiting for: its own limit, not Figma's. */
export class FigmaTimeoutError extends Error {
	constructor(readonly method: string, readonly ms: number) {
		super(`GeminiCode stopped waiting for Figma's ${method} after ${Math.round(ms / 1000)} s.`);
	}
}

/** A read stopped by its caller, such as a cancelled tool call. */
export class FigmaCancelledError extends Error {
	constructor() {
		super('The Figma read was cancelled.');
	}
}

/** An answer Figma gave as an error: its own words. */
export class FigmaError extends Error {
	constructor(readonly figmaMessage: string, readonly status?: number) {
		super(`Figma reported: ${figmaMessage}`);
	}
}

/** One element of a frame's outline (`get_metadata`): a part that can be read on its own. */
export interface FigmaPart {
	readonly id: string;
	readonly name: string;
	readonly type: string;
}

/** The outline's direct children of its top element, in order. */
export function topLevelParts(outline: string): FigmaPart[] {
	const parts: FigmaPart[] = [];
	for (const match of outline.matchAll(/^ {2}<(?<type>[\w-]+) id="(?<id>[^"]+)" name="(?<name>[^"]*)"/gm)) {
		parts.push({ id: match.groups!.id, name: match.groups!.name, type: match.groups!.type });
	}
	return parts;
}

/** Whether Figma answered with its Code Connect question instead of the design. */
export function isCodeConnectPrompt(content: readonly FigmaContent[]): boolean {
	return content.some(c => c.type === 'text' && /missing code connect mappings|get_code_connect_suggestions/i.test(c.text));
}

/** Whether Figma can't see the node: its file isn't the active tab, or its page hasn't been opened yet. */
export function isNodeNotFound(message: string): boolean {
	return /No node could be found/i.test(message);
}

export class FigmaDesktop implements FigmaClient {

	private session: string | undefined;
	private initialized: Promise<{ tools: readonly string[]; version?: string }> | undefined;
	private nextId = 1;
	/** Requests go one at a time: Figma reads a frame on the app's own thread, and overlapping reads slow each other. */
	private queue: Promise<unknown> = Promise.resolve();
	private readonly cache = new Map<string, { readonly at: number; readonly content: readonly FigmaContent[] }>();

	constructor(
		private readonly url = figmaDesktopUrl,
		private readonly fetcher: Fetch = fetch,
		/** Writes a line about each read to the Gemini log. */
		private readonly log?: (line: string) => void,
		private readonly now: () => number = Date.now,
	) { }

	/** Whether Figma answers now, on a connection of its own, so the check never disturbs one a read is using. */
	async status(): Promise<FigmaStatus> {
		try {
			const opened = await this.open(2500);
			void this.close(opened.session);
			return { running: true, ...opened.version ? { version: opened.version } : {} };
		} catch {
			return { running: false, problem: 'Figma isn\'t open, or its Dev Mode MCP server is off. Open the Figma desktop app and turn it on in Preferences.' };
		}
	}

	/**
	 * The frame at `link` for building it: code hints, layout, text and design
	 * variables, without a screenshot. A frame too large for one answer comes
	 * in whole sections; one Figma can't read comes as its outline and
	 * variables, with the parts to read next. Never rejects for a read Figma
	 * stopped; rejects only when Figma can't be reached or can't find the node.
	 */
	async designContext(link: string, options: FigmaReadOptions = {}): Promise<FigmaContent[]> {
		const parsed = parseFigmaLink(link);
		const nodeId = parsed?.nodeId;
		const args = { ...nodeId ? { nodeId } : {}, clientFrameworks: options.frameworks ?? 'React', clientLanguages: options.languages ?? 'TypeScript,CSS' };
		// A link with no node reads whatever is selected in Figma now, which is never kept.
		const key = nodeId && `${parsed.fileKey}|${nodeId}|${args.clientFrameworks}|${args.clientLanguages}|${options.codeConnect ? 'cc' : ''}`;
		const cached = key ? this.cache.get(key) : undefined;
		if (cached && this.now() - cached.at < cacheMs) {
			return [...cached.content];
		}
		const started = this.now();
		const { content, complete } = await this.readDesign(args, options, started + figmaDesignDeadlineMs);
		this.log?.(`Figma: read ${nodeId ?? 'the selection'} in ${((this.now() - started) / 1000).toFixed(1)} s, ${content.reduce((sum, c) => sum + (c.type === 'text' ? c.text.length : 0), 0)} characters${complete ? '' : ', not all of it'}.`);
		// Only a complete read is kept: one Figma stopped, or that ran out of time, is asked again next time.
		if (key && complete) {
			this.cache.set(key, { at: this.now(), content });
		}
		return content;
	}

	/** Ends the connection and forgets the kept designs, when Figma is turned off. */
	dispose(): void {
		const session = this.session;
		this.reset();
		this.cache.clear();
		void this.close(session);
	}

	async screenshot(link: string): Promise<FigmaContent[]> {
		const nodeId = parseFigmaLink(link)?.nodeId;
		return this.call('get_screenshot', { ...nodeId ? { nodeId } : {} });
	}

	/** The design, as `designContext` describes it, read by `deadline`; `complete` when nothing Figma was asked for failed or ran out of time. */
	private async readDesign(args: Record<string, string>, options: FigmaReadOptions, deadline: number): Promise<{ content: FigmaContent[]; complete: boolean }> {
		const { tools } = await this.init();
		const name = tools.includes('get_design_context') ? 'get_design_context' : 'get_code';
		const lean = name === 'get_design_context' ? { excludeScreenshot: true, ...options.codeConnect ? {} : { disableCodeConnect: true } } : {};
		const read = (tool: string, toolArgs: Record<string, unknown>, timeoutMs: number) => this.call(tool, toolArgs, timeoutMs, deadline, options.signal);
		let complete = true;
		const failed = () => {
			complete = false;
			return undefined;
		};
		let design: FigmaContent[] | undefined;
		let failure: Error | undefined;
		try {
			design = await read(name, { ...args, ...lean }, figmaReadTimeoutMs);
			// Figma may ask about Code Connect instead of answering; asked again without it, it answers.
			if (isCodeConnectPrompt(design)) {
				design = await read(name, { ...args, ...lean, disableCodeConnect: true }, figmaReadTimeoutMs);
				// Asked again all the same: answered, but not kept.
				complete &&= !isCodeConnectPrompt(design);
			}
		} catch (err) {
			if (err instanceof FigmaError && isNodeNotFound(err.figmaMessage)) {
				throw err;
			}
			complete = false;
			failure = err instanceof Error ? err : new Error(String(err));
			this.log?.(`Figma: the design read of ${args.nodeId ?? 'the selection'} failed: ${failure.message}`);
		}
		const variables = withoutAdvice(tools.includes('get_variable_defs') ? await read('get_variable_defs', args, 20_000).catch(failed) ?? [] : []);
		const code = withoutAdvice(design ?? []);
		const size = code.reduce((sum, c) => sum + (c.type === 'text' ? c.text.length : 0), 0);
		if (design && size <= figmaDesignLimit) {
			return { content: [...code.flatMap(splitText), ...variables], complete };
		}
		// Too large for one answer, or Figma stopped: the outline says which parts to read on their own.
		const outline = tools.includes('get_metadata') && args.nodeId ? await read('get_metadata', { nodeId: args.nodeId }, 20_000).catch(failed) : undefined;
		const outlineText = outline?.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').find(text => text.includes('<')) ?? '';
		const parts = topLevelParts(outlineText);
		if (design && !parts.length) {
			// Nothing smaller to read: the code as it is, cut where it must be, saying so.
			return { content: [...code.flatMap(c => splitText(c.type === 'text' && c.text.length > figmaDesignLimit ? { type: 'text', text: `${c.text.slice(0, figmaDesignLimit)}\n… (${c.text.length - figmaDesignLimit} more characters cut: this frame has no smaller parts to read on their own)` } : c)), ...variables], complete };
		}
		const sections: FigmaContent[] = [];
		const left: FigmaPart[] = [];
		let used = 0;
		let stopped: Error | undefined;
		for (const part of parts) {
			if (used >= figmaDesignLimit || stopped) {
				left.push(part);
				continue;
			}
			const answer = await read(name, { ...args, ...lean, nodeId: part.id, disableCodeConnect: true }, figmaReadTimeoutMs).catch((err: unknown) => {
				complete = false;
				// Figma that ran out of time on one section is no faster on the next: the rest are left for later calls.
				if (err instanceof FigmaTimeoutError || err instanceof FigmaCancelledError) {
					stopped = err;
				}
				return undefined;
			});
			const text = withoutAdvice(answer ?? []).map(c => c.type === 'text' ? c.text : '').join('\n');
			if (!text || used + text.length > figmaDesignLimit) {
				left.push(part);
				continue;
			}
			sections.push(...splitText({ type: 'text', text: `Section "${part.name}" (${part.id}):\n${text}` }));
			used += text.length;
		}
		const why = failure instanceof FigmaTimeoutError ? failure.message : failure ? `Figma didn't finish reading this frame (${failure.message}).` : 'This frame\'s design is larger than one answer.';
		const intro = `${why} ${sections.length ? 'It was read one section at a time instead.' : 'Here are its outline and design variables instead.'}${stopped ? ` ${stopped.message} The other sections weren't read.` : ''}`;
		const next = left.length ? `Not read yet: ${left.map(part => `${part.id} "${part.name}"`).join(', ')}. Call figma_design with a link to one of these node ids (node-id=${left[0].id.replace(':', '-')}) to read it.` : '';
		return {
			content: [
				{ type: 'text', text: [intro, next].filter(Boolean).join(' ') },
				...sections,
				...!sections.length && outlineText ? splitText({ type: 'text', text: `Outline:\n${outlineText}` }) : [],
				...variables,
			],
			complete,
		};
	}

	private reset(): void {
		this.session = undefined;
		this.initialized = undefined;
	}

	private init(timeoutMs = 10_000): Promise<{ tools: readonly string[]; version?: string }> {
		this.initialized ??= (async () => {
			const opened = await this.open(timeoutMs);
			this.session = opened.session;
			return { tools: opened.tools, ...opened.version ? { version: opened.version } : {} };
		})().catch(err => {
			this.reset();
			throw err;
		});
		return this.initialized;
	}

	/** Opens a connection: initialize, initialized, tools/list. */
	private async open(timeoutMs: number): Promise<{ session?: string; tools: readonly string[]; version?: string }> {
		const first = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'GeminiCode', version: '1' } }, timeoutMs, undefined);
		const session = first.session;
		await this.request('notifications/initialized', undefined, timeoutMs, session, true);
		const list = (await this.request('tools/list', {}, timeoutMs, session)).result as { tools?: { name: string }[] } | undefined;
		return { ...session ? { session } : {}, tools: (list?.tools ?? []).map(t => t.name), version: (first.result as { serverInfo?: { version?: string } } | undefined)?.serverInfo?.version };
	}

	/** Ends a connection Figma no longer needs to keep; errors are of no interest. */
	private async close(session: string | undefined): Promise<void> {
		if (session) {
			await this.fetcher(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } }).catch(() => undefined);
		}
	}

	/**
	 * Calls a tool, one request at a time; a connection Figma forgot is opened
	 * again and the call made once more. Its request waits `timeoutMs` at most,
	 * and the call never past `deadline`, its time in the queue behind other
	 * calls included (by default `figmaQueueWaitMs` more than `timeoutMs`), or past `signal`.
	 */
	private call(name: string, args: Record<string, unknown>, timeoutMs = 60_000, deadline = this.now() + timeoutMs + figmaQueueWaitMs, signal?: AbortSignal): Promise<FigmaContent[]> {
		const queued = this.now();
		let started = false;
		const run = async (): Promise<FigmaContent[]> => {
			started = true;
			for (let attempt = 0; ; attempt++) {
				const ms = Math.min(timeoutMs, deadline - this.now());
				if (signal?.aborted) {
					throw new FigmaCancelledError();
				}
				if (ms <= 0) {
					throw new FigmaTimeoutError(name, figmaDesignDeadlineMs);
				}
				await this.init();
				try {
					const result = (await this.request('tools/call', { name, arguments: args }, ms, this.session, false, signal)).result as { content?: FigmaContent[]; isError?: boolean } | undefined;
					const content = (result?.content ?? []).filter(c => c.type === 'text' || c.type === 'image');
					if (result?.isError) {
						throw new FigmaError(content.map(c => c.type === 'text' ? c.text : '').join(' ').trim() || `${name} failed.`);
					}
					return content;
				} catch (err) {
					// Figma restarted, or dropped the connection: it answers 400 or 404 to the old one.
					const stale = err instanceof FigmaError && (err.status === 400 || err.status === 404 || /session/i.test(err.figmaMessage));
					if (stale) {
						this.reset();
					}
					if (!stale || attempt > 0) {
						throw err;
					}
				}
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		// While it waits its turn, the deadline and `signal` end the wait; once it runs, its request's own limits do.
		return new Promise<FigmaContent[]>((resolve, reject) => {
			const stop = (err: Error) => !started && reject(err);
			const timer = setTimeout(() => stop(new FigmaTimeoutError(`${name} behind another Figma read`, this.now() - queued)), Math.max(0, deadline - this.now()));
			const cancel = () => stop(new FigmaCancelledError());
			signal?.addEventListener('abort', cancel, { once: true });
			void next.then(resolve, reject).finally(() => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', cancel);
			});
		});
	}

	private async request(method: string, params: unknown, timeoutMs: number, session: string | undefined, notification = false, signal?: AbortSignal): Promise<{ result?: unknown; session?: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const cancel = () => controller.abort();
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			const response = await this.fetcher(this.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...session ? { 'Mcp-Session-Id': session } : {} },
				body: JSON.stringify({ jsonrpc: '2.0', method, ...notification ? {} : { id: this.nextId++ }, ...params === undefined ? {} : { params } }),
				signal: controller.signal,
			});
			const opened = response.headers.get('mcp-session-id') ?? session;
			if (!response.ok) {
				throw new FigmaError(`answered ${response.status} to ${method}`, response.status);
			}
			if (notification) {
				return { ...opened ? { session: opened } : {} };
			}
			const text = await response.text();
			const message = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? lastEvent(text) : JSON.parse(text);
			if (message?.error) {
				throw new FigmaError(String(message.error.message ?? 'it refused the request'));
			}
			return { result: message?.result, ...opened ? { session: opened } : {} };
		} catch (err) {
			if (signal?.aborted) {
				throw new FigmaCancelledError();
			}
			if (controller.signal.aborted) {
				throw new FigmaTimeoutError(method, timeoutMs);
			}
			throw err;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', cancel);
		}
	}
}

/** Figma's own answers without its advice to use its remote server, which is of no use to the agent. */
function withoutAdvice(content: readonly FigmaContent[]): FigmaContent[] {
	return content.filter(c => !(c.type === 'text' && /^Figma recommends using the remote MCP server/.test(c.text)));
}

/** A text part split at line ends into parts under `figmaPartLimit`, so none is cut on its way to the model. */
export function splitText(content: FigmaContent): FigmaContent[] {
	if (content.type !== 'text' || content.text.length <= figmaPartLimit) {
		return [content];
	}
	const parts: FigmaContent[] = [];
	let rest = content.text;
	while (rest.length > figmaPartLimit) {
		const end = rest.lastIndexOf('\n', figmaPartLimit);
		const at = end > figmaPartLimit / 2 ? end + 1 : figmaPartLimit;
		parts.push({ type: 'text', text: rest.slice(0, at) });
		rest = rest.slice(at);
	}
	if (rest) {
		parts.push({ type: 'text', text: rest });
	}
	return parts;
}

/** The last JSON-RPC message in an event stream's text. */
export function lastEvent(text: string): { result?: unknown; error?: { message?: string } } | undefined {
	let last: { result?: unknown; error?: { message?: string } } | undefined;
	for (const block of text.split(/\r?\n\r?\n/)) {
		const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
		if (data) {
			try {
				const parsed = JSON.parse(data);
				if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
					last = parsed;
				}
			} catch {
				// Not JSON: a keep-alive.
			}
		}
	}
	return last;
}
