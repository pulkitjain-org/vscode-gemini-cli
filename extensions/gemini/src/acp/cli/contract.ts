/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a Gemini CLI still has what GeminiCode reads from it outside
// ACP (formats.ts). Each check looks for the code in the CLI's bundle that
// writes or names the format, so a release that renames a constant, moves a
// file or changes a log line shows up here, by the feature it affects, and
// not as a feature that quietly stops working. Run by `npm run bundle-cli`,
// test/acp/realCliContract.test.ts and Check Agent Connection.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { baseFlashPattern, codeAssistFlashPattern, debugLogFileVariable, latestFlashPattern, oauthClientIdPattern, oauthClientSecretPattern, telemetryEnv, traceEvents } from './formats';

/** The GeminiCode feature that depends on a check. */
export type CliContractArea =
	/** Inline edit, commit messages and Enhance prompt, which fall back on a slower agent turn. */
	| 'directRequests'
	/** The MCP servers that fail to start, read from the debug log. */
	| 'mcpDiagnostics'
	/** Record Performance Trace. */
	| 'performanceTrace'
	/** The CLI's saved sessions: Pick Up a Gemini CLI Session, Rewind and session snapshots. */
	| 'savedSessions';

export type CliContractCheck = 'bundle' | 'oauthClient' | 'flashModels' | 'debugLog' | 'mcpLogLines' | 'telemetryEnv' | 'traceEvents' | 'sessionFiles';

/** Something GeminiCode reads that the CLI no longer has. */
export interface CliContractMismatch {
	readonly check: CliContractCheck;
	readonly area: CliContractArea;
	/** What was looked for, for the log; the user-facing line comes from `check` and `area`. */
	readonly detail: string;
}

interface Probe {
	readonly check: Exclude<CliContractCheck, 'bundle'>;
	readonly area: CliContractArea;
	readonly detail: string;
	/** Each must match somewhere in the bundle. */
	readonly patterns: readonly RegExp[];
}

const literal = (text: string) => new RegExp(`["'\`]${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`);

const probes: readonly Probe[] = [
	{ check: 'oauthClient', area: 'directRequests', detail: 'OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET', patterns: [oauthClientIdPattern, oauthClientSecretPattern] },
	{ check: 'flashModels', area: 'directRequests', detail: 'LATEST_GEMINI_FLASH_MODEL, BASE_GEMINI_FLASH_MODEL and LEGACY_CCPA_FLASH_MODEL', patterns: [latestFlashPattern, baseFlashPattern, codeAssistFlashPattern] },
	{
		check: 'debugLog', area: 'mcpDiagnostics', detail: `${debugLogFileVariable} and its "[<time>] [<level>] <message>" lines`,
		// `[${timestamp}] [${level}] ${message}`, as the CLI's DebugLogger writes each entry.
		patterns: [literal(debugLogFileVariable), /`\[\$\{[\w$]+\}\] \[\$\{[\w$]+\}\] \$\{[\w$]+\}/],
	},
	{ check: 'mcpLogLines', area: 'mcpDiagnostics', detail: '"[MCP <severity>] <message>" in the debug log', patterns: [/`\[MCP \$\{[\w$]+\}\] \$\{[\w$]+\}`/] },
	{ check: 'telemetryEnv', area: 'performanceTrace', detail: Object.keys(telemetryEnv('')).join(', '), patterns: Object.keys(telemetryEnv('')).map(literal) },
	{ check: 'traceEvents', area: 'performanceTrace', detail: Object.values(traceEvents).join(', '), patterns: [literal('event.name'), ...Object.values(traceEvents).map(literal)] },
	{
		check: 'sessionFiles', area: 'savedSessions', detail: '~/.gemini (GEMINI_CLI_HOME), projects.json, tmp/<project>/chats/session-*',
		patterns: [/\bGEMINI_DIR\s*=\s*["']\.gemini["']/, literal('GEMINI_CLI_HOME'), literal('projects.json'), /\bTMP_DIR_NAME\s*=\s*["']tmp["']/, /\bCHATS_DIR\s*=\s*["']chats["']/, /\bSESSION_FILE_PREFIX\s*=\s*["']session-["']/],
	},
];

/**
 * What GeminiCode reads from the CLI whose entry point is `entry` (its
 * `gemini.js`, or a link to it) that its bundle no longer has; empty when
 * everything is there. A CLI that is not a JavaScript bundle beside its
 * entry point gives one `bundle` mismatch per area.
 */
export async function checkCliContract(entry: string): Promise<CliContractMismatch[]> {
	let dir: string;
	let files: string[];
	try {
		dir = path.dirname(await fs.realpath(entry));
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.js'));
	} catch {
		files = [];
		dir = '';
	}
	if (!files.length) {
		const areas = [...new Set(probes.map(p => p.area))];
		return areas.map(area => ({ check: 'bundle', area, detail: `no JavaScript bundle beside ${entry}` }));
	}
	// The constants live in shared chunks the entry imports; read those first and stop once everything is found.
	const base = path.basename(await fs.realpath(entry));
	const ordered = [base, ...files.filter(f => f.startsWith('chunk-')), ...files.filter(f => !f.startsWith('chunk-') && f !== base)];
	const missing = new Map(probes.map(probe => [probe, new Set(probe.patterns)]));
	for (const file of ordered) {
		let text: string;
		try {
			text = await fs.readFile(path.join(dir, file), 'utf8');
		} catch {
			continue;
		}
		for (const [probe, patterns] of missing) {
			for (const pattern of patterns) {
				if (pattern.test(text)) {
					patterns.delete(pattern);
				}
			}
			if (!patterns.size) {
				missing.delete(probe);
			}
		}
		if (!missing.size) {
			break;
		}
	}
	return [...missing.keys()].map(({ check, area, detail }) => ({ check, area, detail }));
}
