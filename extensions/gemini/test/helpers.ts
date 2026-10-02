/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
