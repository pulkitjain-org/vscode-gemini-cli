/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The points of a debug session (DEBUG_MODE.md): one place to observe, owned
// by one agent's Debug mode and tied to one hypothesis. Their ids and limits,
// which lines are taken across agents, the message a logpoint prints so its
// output can be routed back, and the matching of an output line to its point.

export type PointKind = 'logpoint' | 'breakpoint' | 'marked';
export type Channel = 'console' | 'http';

export interface PointInput {
	readonly kind: PointKind;
	readonly file: string;
	/** One-based, as the editor shows it. */
	readonly line: number;
	readonly hypothesis: string;
	/** Logpoints and marked lines: what to print. */
	readonly expressions?: readonly string[];
	/** Breakpoints. */
	readonly condition?: string;
	readonly hitCount?: number;
	readonly hold?: boolean;
	/** Marked lines. */
	readonly channel?: Channel;
}

export type PointStatus = 'active' | 'removed' | 'user';

export interface Point extends PointInput {
	/** `p1`, `p2`, ... */
	readonly id: string;
	readonly agent: string;
	/** Active; removed (by the agent, the user or Clean up); or the user's since they edited it. */
	readonly status: PointStatus;
	/** Whether the adapter reported it bound; undefined until known or for marked lines. */
	readonly bound?: boolean;
}

/** Limits per debug session. */
export const pointLimits = { debuggerPoints: 20, markedLines: 12, files: 8, expressions: 8 } as const;

/** The prefix of every line a point prints; the tracker and the terminal scan look for it. */
export const markerPrefix = '@@gc:';

const pointIdPattern = /^p\d+$/;
const noncePattern = /^[A-Za-z0-9]{4,32}$/;

export function isPointId(id: string): boolean {
	return pointIdPattern.test(id);
}

/** The marker in front of a point's output: `@@gc:<nonce>:<point>@@`. */
export function marker(nonce: string, point: string): string {
	return `${markerPrefix}${nonce}:${point}@@`;
}

/**
 * The message a logpoint prints, in the adapter's `{expression}` syntax:
 * `@@gc:<nonce>:<point>@@ {"cart.total":{cart.total},"n":{n}}`. The adapter
 * fills each `{...}` in; the output is matched by `matchOutputLine`.
 */
export function logpointMessage(nonce: string, point: string, expressions: readonly string[]): string {
	const fields = expressions.map(e => `${JSON.stringify(e)}:{${e}}`);
	return `${marker(nonce, point)} {${fields.join(',')}}`;
}

export interface MatchedLine {
	readonly nonce: string;
	readonly point: string;
	/** What follows the marker, trimmed. */
	readonly payload: string;
}

const outputLine = /@@gc:([A-Za-z0-9]{4,32}):(p\d+)@@[ \t]?(.*)$/;

/** The point an output line belongs to, or undefined for a line without a marker. Ownership (the nonce) is the caller's to check. */
export function matchOutputLine(line: string): MatchedLine | undefined {
	if (!line.includes(markerPrefix)) {
		return undefined;
	}
	const match = outputLine.exec(line);
	return match ? { nonce: match[1], point: match[2], payload: match[3].trim() } : undefined;
}

/** Which lines across the window's agents hold a point, so two agents never share one. */
export class LineOwnership {

	private readonly owners = new Map<string, string>();

	owner(file: string, line: number): string | undefined {
		return this.owners.get(`${file}:${line}`);
	}

	claim(file: string, line: number, agent: string): boolean {
		const key = `${file}:${line}`;
		const owner = this.owners.get(key);
		if (owner !== undefined && owner !== agent) {
			return false;
		}
		this.owners.set(key, agent);
		return true;
	}

	release(file: string, line: number, agent: string): void {
		const key = `${file}:${line}`;
		if (this.owners.get(key) === agent) {
			this.owners.delete(key);
		}
	}

	/** Forgets every line `agent` holds, at Clean up. */
	releaseAll(agent: string): void {
		for (const [key, owner] of this.owners) {
			if (owner === agent) {
				this.owners.delete(key);
			}
		}
	}
}

export type AddResult = { readonly ok: true; readonly point: Point } | { readonly ok: false; readonly error: string };

/** One agent's points, with ids that are never reused within the debug session. */
export class PointSet {

	private readonly points: Point[] = [];
	private next = 1;

	constructor(readonly agent: string, readonly nonce: string, private readonly lines: LineOwnership = new LineOwnership()) {
		if (!noncePattern.test(nonce)) {
			throw new Error('A nonce is 4 to 32 letters and digits.');
		}
	}

	get all(): readonly Point[] {
		return this.points;
	}

	/** The points still in place. */
	get active(): readonly Point[] {
		return this.points.filter(p => p.status === 'active');
	}

	get(id: string): Point | undefined {
		return this.points.find(p => p.id === id);
	}

	/** The active point on a line, if any. */
	at(file: string, line: number): Point | undefined {
		return this.points.find(p => p.status === 'active' && p.file === file && p.line === line);
	}

	/** Adds a point if the limits and the line allow; says why when not. */
	add(input: PointInput): AddResult {
		if (!Number.isInteger(input.line) || input.line < 1) {
			return { ok: false, error: 'A point needs a line number, counted from 1.' };
		}
		if (!input.file) {
			return { ok: false, error: 'A point needs a file.' };
		}
		if (!input.hypothesis) {
			return { ok: false, error: 'A point belongs to a hypothesis: give its id (h1, h2, ...).' };
		}
		const expressions = input.expressions ?? [];
		if (input.kind !== 'breakpoint' && !expressions.length) {
			return { ok: false, error: 'Give at least one expression to print.' };
		}
		if (expressions.length > pointLimits.expressions) {
			return { ok: false, error: `At most ${pointLimits.expressions} expressions per point.` };
		}
		if (input.hitCount !== undefined && (!Number.isInteger(input.hitCount) || input.hitCount < 1)) {
			return { ok: false, error: 'A hit count is a whole number of 1 or more.' };
		}
		const active = this.active;
		if (input.kind === 'marked') {
			if (active.filter(p => p.kind === 'marked').length >= pointLimits.markedLines) {
				return { ok: false, error: `This debug session already has ${pointLimits.markedLines} marked lines, the most it can hold: remove one (debug_remove) first.` };
			}
		} else if (active.filter(p => p.kind !== 'marked').length >= pointLimits.debuggerPoints) {
			return { ok: false, error: `This debug session already has ${pointLimits.debuggerPoints} debugger points, the most it can hold: remove one (debug_remove) first.` };
		}
		const files = new Set(active.map(p => p.file));
		if (!files.has(input.file) && files.size >= pointLimits.files) {
			return { ok: false, error: `Points are already in ${pointLimits.files} files, the most a debug session observes at once: remove some first.` };
		}
		const taken = this.at(input.file, input.line);
		if (taken) {
			return { ok: false, error: `This session already has a point at ${input.file}:${input.line} (${taken.id}).` };
		}
		if (!this.lines.claim(input.file, input.line, this.agent)) {
			return { ok: false, error: `Another agent's point is on ${input.file}:${input.line}: choose another line.` };
		}
		const point: Point = { ...input, expressions, id: `p${this.next++}`, agent: this.agent, status: 'active' };
		this.points.push(point);
		return { ok: true, point };
	}

	/** Marks the point removed and frees its line; false for an id it does not have, or one already gone. */
	remove(id: string): boolean {
		const index = this.points.findIndex(p => p.id === id && p.status === 'active');
		if (index < 0) {
			return false;
		}
		this.set(index, { status: 'removed' });
		return true;
	}

	/** Every active point removed, at Clean up or `debug_remove all`; the ids that went. */
	removeAll(): string[] {
		return this.active.map(p => p.id).filter(id => this.remove(id));
	}

	/** The user edited the point's breakpoint: it is theirs now, and Clean up leaves it. */
	disown(id: string): boolean {
		const index = this.points.findIndex(p => p.id === id && p.status === 'active');
		if (index < 0) {
			return false;
		}
		this.set(index, { status: 'user' });
		return true;
	}

	/** Records whether the adapter bound the point. */
	setBound(id: string, bound: boolean): void {
		const index = this.points.findIndex(p => p.id === id);
		if (index >= 0) {
			this.points[index] = { ...this.points[index], bound };
		}
	}

	/** The point an output line with this session's nonce belongs to. */
	match(line: string): { readonly point: Point; readonly payload: string } | undefined {
		const matched = matchOutputLine(line);
		if (!matched || matched.nonce !== this.nonce) {
			return undefined;
		}
		const point = this.get(matched.point);
		return point ? { point, payload: matched.payload } : undefined;
	}

	/** The counts the bar and the prompt show. */
	counts(): { readonly logpoints: number; readonly breakpoints: number; readonly marked: number; readonly files: number } {
		const active = this.active;
		return {
			logpoints: active.filter(p => p.kind === 'logpoint').length,
			breakpoints: active.filter(p => p.kind === 'breakpoint').length,
			marked: active.filter(p => p.kind === 'marked').length,
			files: new Set(active.map(p => p.file)).size,
		};
	}

	private set(index: number, change: Partial<Point>): void {
		const point = this.points[index];
		this.points[index] = { ...point, ...change };
		this.lines.release(point.file, point.line, this.agent);
	}
}

/** One line per point, as the model and the bar read it. */
export function describePoint(point: Point, hits?: number): string {
	const what = point.kind === 'marked' ? `marked line (${point.channel ?? 'console'})` : point.kind;
	const detail = point.kind === 'breakpoint'
		? [point.condition ? `if ${point.condition}` : '', point.hitCount ? `hit count ${point.hitCount}` : '', point.hold ? 'hold' : ''].filter(Boolean).join(', ')
		: (point.expressions ?? []).join(', ');
	const state = point.status === 'removed' ? ' (removed)' : point.status === 'user' ? ' (edited by the user)' : point.bound === false ? ' (not bound)' : '';
	return `${point.id} ${point.file}:${point.line} ${point.hypothesis} ${what}${detail ? ` ${detail}` : ''}${hits === undefined ? '' : ` - ${hits} hit${hits === 1 ? '' : 's'}`}${state}`;
}
