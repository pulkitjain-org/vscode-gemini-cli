/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Keeps the last lines written to the Gemini log, for Report a Problem
// (reportProblem.ts): the channel's file is VS Code's to place, and the
// lines are wanted as the user saw them, levels included.

import * as vscode from 'vscode';

/** Lines kept. */
export const recentLogLines = 300;

const levels = ['trace', 'debug', 'info', 'warn', 'error'] as const;

/**
 * `channel`, with every line it is given also kept in a ring of
 * `recentLogLines`; `recent()` is the ring, oldest first.
 */
export function withRecentLog(channel: vscode.LogOutputChannel): { readonly channel: vscode.LogOutputChannel; recent(): string[] } {
	const ring: string[] = [];
	const keep = (level: string, message: string) => {
		ring.push(`[${level}] ${message}`);
		if (ring.length > recentLogLines) {
			ring.splice(0, ring.length - recentLogLines);
		}
	};
	const proxied = new Proxy(channel, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof property === 'string' && (levels as readonly string[]).includes(property)) {
				return (message: string, ...args: unknown[]) => {
					keep(property, message);
					return (value as (message: string, ...args: unknown[]) => void).call(target, message, ...args);
				};
			}
			if (property === 'appendLine') {
				return (line: string) => {
					keep('info', line);
					return target.appendLine(line);
				};
			}
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { channel: proxied, recent: () => [...ring] };
}
