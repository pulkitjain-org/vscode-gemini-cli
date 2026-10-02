/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface AgentCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	/** Windows `.cmd` shims can only be started through a shell. */
	readonly shell: boolean;
}

export interface ResolveAgentCommandOptions {
	/** The `gemini.cliPath` setting; empty means look up `gemini` on `PATH`. */
	readonly cliPath: string | undefined;
	/** The Node binary to run a JavaScript entry point with (Electron's, in the app). */
	readonly execPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	/** Run the interactive CLI (for terminal setup) instead of `--acp`. */
	readonly interactive?: boolean;
}

const scriptExtension = /\.(c|m)?js$/i;
const windowsShim = /\.(cmd|bat)$/i;

/**
 * Works out how to start `gemini --acp` (or the interactive `gemini`).
 *
 * A JavaScript entry point runs under `execPath` with `ELECTRON_RUN_AS_NODE=1`,
 * so the app needs no Node installed on the host. Anything else is executed as is.
 */
export function resolveAgentCommand(options: ResolveAgentCommandOptions): AgentCommand {
	const cliPath = options.cliPath?.trim();
	const modeArgs = options.interactive ? [] : ['--acp'];
	if (cliPath && scriptExtension.test(cliPath)) {
		return {
			command: options.execPath,
			args: [cliPath, ...modeArgs],
			env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
			shell: false,
		};
	}
	const command = cliPath || (options.platform === 'win32' ? 'gemini.cmd' : 'gemini');
	return {
		command,
		args: modeArgs,
		env: { ...options.env },
		shell: options.platform === 'win32' && windowsShim.test(command),
	};
}

export function spawnAgent(command: AgentCommand, cwd: string | undefined): ChildProcessWithoutNullStreams {
	return spawn(command.command, [...command.args], {
		cwd,
		env: command.env,
		shell: command.shell,
		stdio: 'pipe',
		windowsHide: true,
	});
}
