/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reads the "Startup: ..." lines GeminiCode logs, one per launch, and shows
// each mark's median across launches: what the window waited on before Home
// showed, and what the first chat waited on before its first reply text
// (FINDINGS.md, startup on real machines). Lines of releases before 1.8 are
// read as the marks they amount to.
//
//   node --experimental-transform-types --no-warnings extensions/gemini/scripts/startup-log.mts [--last 20] [log files or folders...]
//
// Without files it reads the installed app's logs. Launches whose first chat
// never sent a prompt have no "first prompt sent" or "first text".

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { parseStartupLine, summarizeStartupTimes, type StartupTimes } from '../src/acp/startupMarks.ts';

const { values: args, positionals } = parseArgs({ options: { last: { type: 'string', default: '20' } }, allowPositionals: true });
const roots = positionals.length ? positionals : [path.join(homedir(), 'Library', 'Application Support', 'GeminiCode', 'logs')];

function logFiles(root: string): string[] {
	if (!statSync(root).isDirectory()) {
		return [root];
	}
	return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(root, entry.name);
		return entry.isDirectory() ? logFiles(file) : /Gemini\.log$/.test(entry.name) ? [file] : [];
	});
}

const launches: { readonly at: string; readonly times: StartupTimes }[] = [];
for (const root of roots) {
	for (const file of logFiles(root)) {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			const times = parseStartupLine(line);
			if (times) {
				launches.push({ at: line.slice(0, 19), times });
			}
		}
	}
}
// A launch logs once when the first session opens and again after the first reply: the later line has every mark.
const byLaunch = new Map<string, StartupTimes>();
for (const launch of launches.sort((a, b) => a.at.localeCompare(b.at))) {
	const key = launch.at.slice(0, 16);
	byLaunch.set(key, { ...byLaunch.get(key), ...launch.times });
}
const recent = [...byLaunch.values()].slice(-Number(args.last));
if (!recent.length) {
	console.log('No Startup lines found.');
	process.exit(1);
}
console.log(`${recent.length} launches, ms after activation (median, range, launches that reached the mark):`);
for (const { name, median, min, max, count } of summarizeStartupTimes(recent)) {
	console.log(`${name.padEnd(20)} ${String(median).padStart(8)}   ${String(min).padStart(7)} to ${String(max).padEnd(7)}  ${count}`);
}
