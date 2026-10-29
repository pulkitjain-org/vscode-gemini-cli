/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import type { AgentCommand } from '../src/acp/agentProcess';
import type { FakeAgentScript } from './fake-agent/fakeAgent';

const fakeAgent = path.join(import.meta.dirname, 'fake-agent', 'fakeAgent.ts');
const scriptDir = mkdtempSync(path.join(tmpdir(), 'fake-agent-'));
let scriptCount = 0;

/** The command that runs the fake agent with the given script. */
export function fakeAgentCommand(script: FakeAgentScript = {}): AgentCommand {
	const scriptPath = path.join(scriptDir, `script-${++scriptCount}.json`);
	writeFileSync(scriptPath, JSON.stringify(script));
	return { command: process.execPath, args: [fakeAgent, scriptPath], env: process.env, shell: false };
}

/** Resolves with the first value `predicate` accepts from an event. */
export function waitFor<T>(event: (listener: (e: T) => void) => { dispose(): void }, predicate: (e: T) => boolean = () => true): Promise<T> {
	return new Promise(resolve => {
		const listener = event(e => {
			if (predicate(e)) {
				listener.dispose();
				resolve(e);
			}
		});
	});
}

const tempDirs: string[] = [];
let cleanupRegistered = false;

/**
 * A fresh temporary folder (its real path, since macOS links /var to
 * /private/var and git reports real paths), removed after the test. Call it
 * inside a test or a `beforeEach`.
 */
export function tempDir(prefix = 'geminicode-'): string {
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		afterEach(() => {
			for (const dir of tempDirs.splice(0)) {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

/** Runs git in `cwd` with a test identity and no signing or hooks, so a commit never waits on an agent or runs the user's own. */
export function gitIn(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' });
}

/**
 * A temporary git repository on `main` with one commit of `files` (paths
 * relative to it, with their text), removed after the test. `run` runs git in it.
 */
export function tempRepo(files: Readonly<Record<string, string>> = { 'README.md': 'hello\n' }, prefix = 'repo-'): { readonly root: string; run(...args: string[]): string } {
	const root = tempDir(prefix);
	gitIn(root, 'init', '-q', '-b', 'main');
	for (const [file, text] of Object.entries(files)) {
		const at = path.join(root, file);
		execFileSync('mkdir', ['-p', path.dirname(at)]);
		writeFileSync(at, text);
	}
	gitIn(root, 'add', '-A');
	gitIn(root, 'commit', '-q', '-m', 'Initial');
	return { root, run: (...args) => gitIn(root, ...args) };
}
