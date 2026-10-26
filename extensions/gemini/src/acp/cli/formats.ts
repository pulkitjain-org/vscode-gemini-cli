/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What GeminiCode reads from the Gemini CLI outside the Agent Client
// Protocol: names in its bundle, the files it saves, its debug log and its
// telemetry file. None of it is a public interface, so it is all here, and
// `checkCliContract` (contract.ts) checks a CLI's bundle still has each of
// them. `npm run bundle-cli` refuses a CLI that fails the check, and
// test/acp/realCliContract.test.ts runs it against the real CLI.
// Read from gemini-cli 0.64.0.

import * as os from 'node:os';
import * as path from 'node:path';

// --- Constants in the CLI's bundle (directRequest.ts, readCliBundle) ---

/** The CLI's OAuth client, which refreshing a saved Google sign-in needs. A desktop app's "secret" is public. */
export const oauthClientIdPattern = /OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+\.apps\.googleusercontent\.com)["']/;
export const oauthClientSecretPattern = /OAUTH_CLIENT_SECRET\s*=\s*["']([\w-]+)["']/;

/** The newest Flash model, which not every account can use yet. */
export const latestFlashPattern = /\bLATEST_GEMINI_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/;
/** The Flash model every account can use. */
export const baseFlashPattern = /\bBASE_GEMINI_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/;
/** The name Code Assist serves the base Flash model under. */
export const codeAssistFlashPattern = /\bLEGACY_CCPA_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/;

// --- The CLI's own folder and saved sessions (cliSessions.ts) ---
//
//   <home>/.gemini/projects.json             { "projects": { "<folder>": "<project id>" } }
//   <home>/.gemini/tmp/<project id>/chats/   session-<time>-<id>.jsonl (or .json, older)

/** The CLI's own folder: ~/.gemini, or under GEMINI_CLI_HOME when that is set. */
export function cliHome(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/** The CLI's registry of folders and their project ids, in `cliHome`. */
export const projectsFileName = 'projects.json';
/** The folder in `cliHome` with one folder per project id. */
export const projectTempDirName = 'tmp';
/** The folder in a project's folder that holds its saved sessions. */
export const chatsDirName = 'chats';
/** How a saved session's file name starts. */
export const sessionFilePrefix = 'session-';

// --- The debug log (mcpDiagnostics.ts) ---

/** The variable that points the CLI's debug log at a file. */
export const debugLogFileVariable = 'GEMINI_DEBUG_LOG_FILE';
/** An entry's first line: "[2026-10-04T10:36:52.038Z] [LOG] ...". Lines after it, such as a stack trace, belong to it. */
export const debugLogEntryStart = /^\[\d{4}-\d\d-\d\dT[^\]]*\] \[[A-Z]+\] /;
/** An MCP problem, after the entry's start: "[MCP error] Error during discovery for MCP server 'x': ...". */
export const debugLogMcpEntry = /^\[MCP (error|warning)\] (.*)$/;

// --- The telemetry file (traceRecording.ts) ---

/** The environment that writes the CLI's OpenTelemetry export to `file` for one agent process. */
export function telemetryEnv(file: string): NodeJS.ProcessEnv {
	return {
		GEMINI_TELEMETRY_ENABLED: 'true',
		GEMINI_TELEMETRY_TARGET: 'local',
		GEMINI_TELEMETRY_OUTFILE: file,
		GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
		GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
		GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
	};
}

/** The log records a performance trace reads, by their `event.name`. */
export const traceEvents = {
	startupStats: 'gemini_cli.startup_stats',
	modelRouting: 'gemini_cli.model_routing',
	apiResponse: 'gemini_cli.api_response',
	toolCall: 'gemini_cli.tool_call',
} as const;
