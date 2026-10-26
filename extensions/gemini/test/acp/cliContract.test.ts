/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCliContract } from '../../src/acp/cli/contract';

/** The lines of a 0.64.0 bundle each check looks for, as esbuild writes them. */
const parts = {
	oauthClient: 'var OAUTH_CLIENT_ID = "123-abc.apps.googleusercontent.com";\nvar OAUTH_CLIENT_SECRET = "GOCSPX-secret";',
	flashModels: 'var LATEST_GEMINI_FLASH_MODEL = "gemini-3-flash";\nvar BASE_GEMINI_FLASH_MODEL = "gemini-2.5-flash";\nvar LEGACY_CCPA_FLASH_MODEL = "gemini-2.5-flash";',
	debugLog: 'this.logStream = process.env["GEMINI_DEBUG_LOG_FILE"] ? 1 : 0;\nconst logEntry = `[${timestamp2}] [${level}] ${message}\n`;',
	mcpLogLines: 'debugLogger.log(`[MCP ${severity}] ${message}`, error40);',
	telemetryEnv: ['ENABLED', 'TARGET', 'OUTFILE', 'LOG_PROMPTS', 'TRACES_ENABLED', 'USE_COLLECTOR'].map(name => `env2["GEMINI_TELEMETRY_${name}"];`).join('\n'),
	traceEvents: '"event.name";\nvar a = "gemini_cli.startup_stats", b = "gemini_cli.model_routing", c = "gemini_cli.api_response", d = "gemini_cli.tool_call";',
	sessionFiles: 'var GEMINI_DIR = ".gemini";\nprocess.env["GEMINI_CLI_HOME"];\npath4.join(dir, "projects.json");\nvar TMP_DIR_NAME = "tmp";\nvar CHATS_DIR = "chats";\nvar SESSION_FILE_PREFIX = "session-";',
};

/** A bundle with every part but `without`, the constants in a chunk as the CLI has them. */
function bundle(without: readonly (keyof typeof parts)[] = []): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'cli-contract-'));
	writeFileSync(path.join(dir, 'gemini.js'), 'import "./chunk-ABC.js";\n');
	const kept = Object.entries(parts).filter(([name]) => !without.includes(name as keyof typeof parts)).map(([, text]) => text);
	writeFileSync(path.join(dir, 'chunk-ABC.js'), kept.slice(0, 3).join('\n'));
	writeFileSync(path.join(dir, 'gemini-XYZ.js'), kept.slice(3).join('\n'));
	return path.join(dir, 'gemini.js');
}

describe('checkCliContract', () => {
	it('passes a bundle with everything GeminiCode reads', async () => {
		expect(await checkCliContract(bundle())).toEqual([]);
	});

	it('names each check that is missing, by the feature it affects', async () => {
		const mismatches = await checkCliContract(bundle(['oauthClient', 'mcpLogLines', 'sessionFiles']));
		expect(mismatches.map(m => [m.check, m.area])).toEqual([
			['oauthClient', 'directRequests'],
			['mcpLogLines', 'mcpDiagnostics'],
			['sessionFiles', 'savedSessions'],
		]);
	});

	it('notices a renamed constant or a changed log line', async () => {
		const entry = bundle(['flashModels', 'debugLog']);
		writeFileSync(path.join(path.dirname(entry), 'chunk-DEF.js'), [
			'var LATEST_FLASH = "gemini-3-flash"; var BASE_GEMINI_FLASH_MODEL = "gemini-2.5-flash"; var LEGACY_CCPA_FLASH_MODEL = "x";',
			'process.env["GEMINI_DEBUG_LOG_FILE"]; const logEntry = `${timestamp2} ${level}: ${message}`;',
		].join('\n'));
		expect((await checkCliContract(entry)).map(m => m.check)).toEqual(['flashModels', 'debugLog']);
	});

	it('reports every feature when there is no bundle to read', async () => {
		const mismatches = await checkCliContract(path.join(tmpdir(), 'no-such-cli', 'gemini.js'));
		expect(mismatches.map(m => [m.check, m.area])).toEqual([
			['bundle', 'directRequests'],
			['bundle', 'mcpDiagnostics'],
			['bundle', 'performanceTrace'],
			['bundle', 'savedSessions'],
		]);
	});
});
