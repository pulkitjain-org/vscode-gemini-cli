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
	/** V8 heap size for the agent, from {@link cliHeapSizeMb}; unset leaves Node's default. */
	readonly heapSizeMb?: number;
}

/**
 * The heap the CLI would give itself: half the machine's memory, unless its
 * `advanced.autoConfigureMemory` setting is false. Mirrors the CLI's entry
 * point (bundle/gemini.js), which reads the same file the same way.
 */
export function cliHeapSizeMb(settingsJson: string | undefined, totalMemoryBytes: number): number | undefined {
	try {
		if (settingsJson && JSON.parse(settingsJson)?.advanced?.autoConfigureMemory === false) {
			return undefined;
		}
	} catch {
		// The CLI ignores an unreadable settings file too.
	}
	return Math.floor(totalMemoryBytes / (1024 * 1024) * 0.5);
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
	const env: NodeJS.ProcessEnv = { ...options.env };
	// By default the CLI starts a second Node process just to raise its heap
	// limit, which costs about 0.6 s of the agent's startup (FINDINGS.md). For
	// the agent, set the heap ourselves and tell the CLI not to relaunch.
	// The interactive terminal keeps the CLI's own behaviour.
	const heapArg = !options.interactive && options.heapSizeMb ? `--max-old-space-size=${options.heapSizeMb}` : undefined;
	if (!options.interactive) {
		env.GEMINI_CLI_NO_RELAUNCH = 'true';
	}
	if (cliPath && scriptExtension.test(cliPath)) {
		return {
			command: options.execPath,
			args: [...(heapArg ? [heapArg] : []), cliPath, ...modeArgs],
			env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
			shell: false,
		};
	}
	if (heapArg) {
		// An executable starts its own Node, so the flag can only go through
		// NODE_OPTIONS, as the CLI itself does for its single-file binary.
		env.NODE_OPTIONS = [env.NODE_OPTIONS, heapArg].filter(Boolean).join(' ');
	}
	const command = cliPath || (options.platform === 'win32' ? 'gemini.cmd' : 'gemini');
	return {
		command,
		args: modeArgs,
		env,
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
