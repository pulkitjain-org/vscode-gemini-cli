/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Get Started walkthrough. It opens once, on the first start, and its steps
// tick themselves off from the agent's status through the `gemini.setup.*`
// context keys.

import * as vscode from 'vscode';
import { advanceSetupProgress, noSetupProgress, SetupProgress } from '../acp/setupProgress';
import { AgentService } from './agentService';

export const walkthroughId = 'gemini-fork.gemini#gemini.getStarted';
const progressKey = 'gemini.setup.progress';
const shownKey = 'gemini.setup.walkthroughShown';

export class SetupWalkthrough extends vscode.Disposable {
	private readonly listener: vscode.Disposable;
	private progress: SetupProgress;

	constructor(private readonly service: AgentService, private readonly globalState: vscode.Memento) {
		super(() => this.listener.dispose());
		this.progress = globalState.get<SetupProgress>(progressKey) ?? noSetupProgress;
		this.publish();
		this.listener = service.onDidChangeStatus(status => this.update(advanceSetupProgress(this.progress, status)));
		this.update(advanceSetupProgress(this.progress, service.status));
		if (!globalState.get<boolean>(shownKey)) {
			void globalState.update(shownKey, true);
			void vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthroughId, false);
		}
	}

	/** Starts the agent, which signs in with Google when the CLI asks for it. */
	async signIn(): Promise<void> {
		const status = this.service.status;
		if (status.phase === 'ready') {
			void vscode.window.showInformationMessage(vscode.l10n.t("You are signed in, and the Gemini agent is ready."));
			return;
		}
		if (status.phase === 'stopped' || status.phase === 'error') {
			this.service.restart();
		}
		try {
			await this.service.ensureReady();
		} catch {
			// The service already shows why, with a way to fix it.
		}
	}

	private update(next: SetupProgress): void {
		if (next.cliReady === this.progress.cliReady && next.signedIn === this.progress.signedIn && next.projectReady === this.progress.projectReady) {
			return;
		}
		this.progress = next;
		void this.globalState.update(progressKey, next);
		this.publish();
	}

	private publish(): void {
		void vscode.commands.executeCommand('setContext', 'gemini.setup.cliReady', this.progress.cliReady);
		void vscode.commands.executeCommand('setContext', 'gemini.setup.signedIn', this.progress.signedIn);
		void vscode.commands.executeCommand('setContext', 'gemini.setup.projectReady', this.progress.projectReady);
	}
}
