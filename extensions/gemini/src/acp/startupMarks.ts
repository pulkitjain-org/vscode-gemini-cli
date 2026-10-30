/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The marks of one launch, in ms since the extension's activation began:
// what the window waited on before Home showed, and what the first chat
// waited on before its first reply. The extension logs them as one line,
// "Startup: ...", which scripts/startup-log.mts reads back across launches
// (FINDINGS.md, startup on real machines). Each mark is set once: a later
// call for the same name is ignored, so a restart never moves it.

export const startupMarkNames = [
	'product loaded', 'records loaded', 'services up', 'home shown',
	'agent spawned', 'agent ready', 'first session', 'first prompt sent', 'first text',
] as const;
export type StartupMarkName = typeof startupMarkNames[number];

export type StartupTimes = Partial<Record<StartupMarkName, number>>;

export class StartupMarks {

	private readonly marks = new Map<StartupMarkName, number>();

	/** `origin` is when activation began, in ms since the epoch. */
	constructor(private readonly origin: number, private readonly now: () => number = Date.now) { }

	/** Records `name` at `at` (ms since the epoch; now by default), unless it was recorded before; true when it was recorded now. */
	mark(name: StartupMarkName, at = this.now()): boolean {
		if (this.marks.has(name)) {
			return false;
		}
		this.marks.set(name, Math.max(0, Math.round(at - this.origin)));
		return true;
	}

	has(name: StartupMarkName): boolean {
		return this.marks.has(name);
	}

	/** Ms after activation, or undefined while the mark isn't set. */
	at(name: StartupMarkName): number | undefined {
		return this.marks.get(name);
	}

	times(): StartupTimes {
		return Object.fromEntries(startupMarkNames.filter(name => this.marks.has(name)).map(name => [name, this.marks.get(name)]));
	}

	/** The log line: the marks recorded so far, in launch order. */
	line(): string {
		return formatStartupLine(this.times());
	}
}

export function formatStartupLine(times: StartupTimes): string {
	const parts = startupMarkNames.filter(name => times[name] !== undefined).map(name => `${name} ${times[name]} ms`);
	return `Startup: ${parts.join(', ')} after activation`;
}

const oldLine = /^Startup: services up (\d+) ms after activation; agent spawned (\d+) ms after activation, process ready (\d+) ms after spawn, first session ready (\d+) ms after spawn/;

/**
 * Reads a launch's marks back from its log line, with or without the log's
 * date and level in front. Lines of releases before 1.8 (services up and
 * agent spawned after activation, process ready and first session after
 * spawn) are read too, as the marks they amount to.
 */
export function parseStartupLine(line: string): StartupTimes | undefined {
	const start = line.indexOf('Startup: ');
	if (start < 0) {
		return undefined;
	}
	const text = line.slice(start).trim();
	const old = oldLine.exec(text);
	if (old) {
		const [, up, spawned, ready, session] = old.map(Number);
		return { 'services up': up, 'agent spawned': spawned, 'agent ready': spawned + ready, 'first session': spawned + session };
	}
	const body = text.slice('Startup: '.length).replace(/ after activation$/, '');
	const times: StartupTimes = {};
	for (const part of body.split(', ')) {
		const match = /^(.+) (\d+) ms$/.exec(part);
		const name = match?.[1] as StartupMarkName | undefined;
		if (match && name && startupMarkNames.includes(name)) {
			times[name] = Number(match[2]);
		}
	}
	return Object.keys(times).length ? times : undefined;
}

export interface StartupSummary {
	readonly name: StartupMarkName;
	/** How many launches recorded the mark. */
	readonly count: number;
	readonly median: number;
	readonly min: number;
	readonly max: number;
}

/** Each mark across launches: the median, the range and how many launches reached it. Marks no launch reached are left out. */
export function summarizeStartupTimes(launches: readonly StartupTimes[]): StartupSummary[] {
	const summaries: StartupSummary[] = [];
	for (const name of startupMarkNames) {
		const values = launches.map(times => times[name]).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
		if (values.length) {
			summaries.push({ name, count: values.length, median: values[Math.floor(values.length / 2)], min: values[0], max: values[values.length - 1] });
		}
	}
	return summaries;
}
