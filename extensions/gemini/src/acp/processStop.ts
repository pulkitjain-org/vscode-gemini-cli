/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Ending a child process the same way everywhere (the agent's sidecar, a stdio
// MCP server): kept apart from sidecar.ts, whose module state (the processes
// still running, killed on exit) must not be copied into a bundle loaded on
// first use (test/perf/chunks.test.ts).
/** How long a stopped CLI gets to exit on SIGTERM before it is killed. */
const killAfterMs = 3_000;

/**
 * Ends a child process: the CLI, or an MCP server of GeminiCode's own
 * (mcpStdio.ts). On Windows a `.cmd` shim runs it under cmd.exe, which `kill`
 * alone would end without the CLI, so the whole tree goes. Elsewhere a process
 * that ignores SIGTERM, for example a CLI while a shell tool runs, is killed
 * after `killAfterMs`.
 */
export function stopProcess(child: ChildProcessWithoutNullStreams): void {
	if (process.platform === 'win32' && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
			return;
		} catch {
			// Fall through to kill.
		}
	}
	child.kill();
	if (child.exitCode === null && child.signalCode === null) {
		const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
		timer.unref?.();
		child.once('exit', () => clearTimeout(timer));
	}
}
