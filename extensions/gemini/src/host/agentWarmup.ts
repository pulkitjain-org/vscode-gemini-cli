/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Starts the agent process before the first chat needs it. A cold start takes
// about 3 s to `initialize` (FINDINGS.md), which the first prompt after
// launch would otherwise wait for. Only an agent that can start without
// asking anything is started early: one set up before and still signed in,
// since a CLI with no saved sign-in opens the sign-in flow as it starts.

import { access } from 'node:fs/promises';
import * as vscode from 'vscode';
import { detectAuth, DirectAuth } from '../acp/directRequest';
import { aliasedSetting } from '../acp/settingAlias';
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
	private disposed = false;

	/** `isSetUp` says whether a session has opened before (`SetupState`). */
	constructor(private readonly service: AgentService, private readonly isSetUp: () => boolean, private readonly log: vscode.LogOutputChannel) {
		this.timer = setTimeout(() => this.startSoon(), startDelayMs);
	}

	/** Starts the agent now if it can start quietly, such as when the user starts typing a task. */
	startSoon(): void {
		if (this.service.isStarted || !startEarly() || !this.isSetUp()) {
			return;
		}
		// A project number stops the start with an error, which belongs to a chat the user opened.
		if (getProjectSettings().problem === 'numeric') {
			return;
		}
		const checked = this.checked ??= detectAuth().then(auth => startsQuietly(auth), () => false);
		void checked.then(quiet => {
			if (!quiet && this.checked === checked) {
				// Not signed in yet: ask again next time, since the user may sign in meanwhile.
				this.checked = undefined;
			}
			if (quiet && !this.disposed && !this.service.isStarted) {
				this.log.info('Starting the agent ahead of the first chat');
				this.service.restart();
			}
		});
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
	}
}

/** `gemini.agents.startEarly`, or the setting's old name, `gemini.agent.startEarly`, which still counts until it is removed. */
function startEarly(): boolean {
	const config = vscode.workspace.getConfiguration(configSection);
	return aliasedSetting(config.inspect<boolean>('agents.startEarly'), config.inspect<boolean>('agent.startEarly'), true);
}
