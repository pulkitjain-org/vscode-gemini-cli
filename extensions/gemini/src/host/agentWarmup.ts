/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Starts the agent process before the first chat needs it. A cold start takes
// about 1.2 s to `initialize` (FINDINGS.md), which the first prompt after
// launch would otherwise wait for. Only an agent that can start without
// asking anything is started early: one set up before and still signed in,
// since a CLI with no saved sign-in opens the sign-in flow as it starts.

import { access } from 'node:fs/promises';
import * as vscode from 'vscode';
import { detectAuth, DirectAuth } from '../acp/directRequest';
import { AgentService } from './agentService';
import { configSection, getProjectSettings } from './configuration';

/** How long after activation the agent starts, so the window's own startup goes first. */
const startDelayMs = 3_000;

/** Whether the CLI can start with `auth` without asking the user to sign in. */
export async function startsQuietly(auth: DirectAuth, exists: (file: string) => Promise<boolean> = fileExists): Promise<boolean> {
	switch (auth.kind) {
		case 'google':
			return exists(auth.credsFile);
		case 'apiKey':
			return true;
		case 'unsupported':
			// Vertex AI signs in from the environment, and the encrypted store is the system keychain.
			return auth.reason !== 'none';
	}
}

async function fileExists(file: string): Promise<boolean> {
	return access(file).then(() => true, () => false);
}

export class AgentWarmup implements vscode.Disposable {

	private readonly timer: ReturnType<typeof setTimeout>;
	private checked: Promise<boolean> | undefined;

	/** `isSetUp` says whether a session has opened before (the walkthrough's progress). */
	constructor(private readonly service: AgentService, private readonly isSetUp: () => boolean, private readonly log: vscode.LogOutputChannel) {
		this.timer = setTimeout(() => this.startSoon(), startDelayMs);
	}

	/** Starts the agent now if it can start quietly, such as when the user starts typing a task. */
	startSoon(): void {
		if (this.service.isStarted || !vscode.workspace.getConfiguration(configSection).get<boolean>('agent.startEarly', true) || !this.isSetUp()) {
			return;
		}
		// A project number stops the start with an error, which belongs to a chat the user opened.
		if (getProjectSettings().problem === 'numeric') {
			return;
		}
		this.checked ??= detectAuth().then(auth => startsQuietly(auth), () => false);
		void this.checked.then(quiet => {
			if (quiet && !this.service.isStarted) {
				this.log.info('Starting the agent ahead of the first chat');
				this.service.restart();
			}
		});
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
}
