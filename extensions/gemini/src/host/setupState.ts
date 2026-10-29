/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How far setup has come (CLI ready, signed in, project in order), kept from
// the agent's status across launches. Home's Get started card is the setup
// flow; this decides whether the agent may start early.

import * as vscode from 'vscode';
import { advanceSetupProgress, noSetupProgress, SetupProgress } from '../acp/setupProgress';
import { AgentService } from './agentService';

const progressKey = 'gemini.setup.progress';

export class SetupState extends vscode.Disposable {
	private readonly listener: vscode.Disposable;
	private progress: SetupProgress;

	constructor(private readonly service: AgentService, private readonly globalState: vscode.Memento) {
		super(() => this.listener.dispose());
		this.progress = globalState.get<SetupProgress>(progressKey) ?? noSetupProgress;
		this.listener = service.onDidChangeStatus(status => this.update(advanceSetupProgress(this.progress, status)));
		this.update(advanceSetupProgress(this.progress, service.status));
	}

	/** Whether a session has opened before, so sign-in and the project were in order. */
	get isSetUp(): boolean {
		return this.progress.projectReady;
	}

	/** Starts the agent, which signs in with Google when the CLI asks for it. */
	async signIn(): Promise<void> {
		const status = this.service.status;
		// A ready process proves the sign-in only once a session opened on it.
		if (status.phase === 'ready' && status.sessionOpened !== false) {
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
	}
}
