/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project's chat: its side panel, the New thread dialog
// and Project settings, and a thread chat's way back to its project. The
// thread cards and the coordinator's posts are transcript items.

import * as vscode from 'vscode';
import type { FromWebview, ProjectPanel, ProjectRepoView, ProjectSettingsView, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

export type ProjectMessage = Extract<FromWebview, { readonly type: 'threadAction' | 'prepareThread' | 'openProjectSettings' | 'saveProjectSettings' | 'projectSettingsAction' | 'startThread' | 'openParentProject' }>;

export class ChatProjectView {

	/** The side panel, as last shown; kept to show again when the view reloads. */
	private panel: ProjectPanel | undefined;
	/** Project settings to open once the view has loaded. */
	private settingsPending: ProjectSettingsView | undefined;
	/** New Thread was asked for before the view was ready. */
	private newThreadPending = false;

	constructor(
		private readonly options: Pick<ChatControllerOptions, 'project' | 'parentProject'>,
		/** Whether the view's script has said it is ready. */
		private readonly isViewReady: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) { }

	/** The project chat's side panel; kept to show again when the view reloads. */
	showPanel(panel: ProjectPanel): void {
		this.panel = panel;
		this.post({ type: 'projectPanel', panel });
	}

	/** Opens Project settings with `settings`, or refreshes it if it is open; `open` false only refreshes. */
	showSettings(settings: ProjectSettingsView, open: boolean): void {
		if (this.isViewReady() || !open) {
			this.post({ type: 'projectSettings', settings, open });
		} else {
			this.settingsPending = settings;
		}
	}

	/** The folder Project settings' Add repository picked. */
	pickedRepository(repo: ProjectRepoView): void {
		this.post({ type: 'pickedRepository', repo });
	}

	/** Opens the New thread dialog in a project chat, once its view has loaded if it is still loading. */
	openNewThread(): void {
		if (this.isViewReady()) {
			this.post({ type: 'openNewThread' });
		} else {
			this.newThreadPending = true;
		}
	}

	/** The view was reset: shows the panel again, opens what was asked for while it loaded, and offers the way back to the project. */
	postReset(): void {
		if (this.panel) {
			this.post({ type: 'projectPanel', panel: this.panel });
		}
		if (this.newThreadPending) {
			this.newThreadPending = false;
			this.post({ type: 'openNewThread' });
		}
		if (this.settingsPending) {
			this.post({ type: 'projectSettings', settings: this.settingsPending, open: true });
			this.settingsPending = undefined;
		}
		if (this.options.parentProject) {
			this.post({ type: 'parentProject', parent: { label: vscode.l10n.t("Thread in {0}", this.options.parentProject.name()), action: vscode.l10n.t("Open Project Chat") } });
		}
	}

	onMessage(message: ProjectMessage): void {
		const project = this.options.project;
		switch (message.type) {
			case 'threadAction':
				project?.threadAction(message.thread, message.action, message.repo);
				break;
			case 'prepareThread':
				project?.prepareThread(message.thread);
				break;
			case 'openProjectSettings':
				project?.openSettings();
				break;
			case 'saveProjectSettings':
				project?.saveSettings(message.settings);
				break;
			case 'projectSettingsAction':
				project?.settingsAction(message.action, message.name);
				break;
			case 'startThread':
				project?.startThread(message.thread);
				break;
			case 'openParentProject':
				this.options.parentProject?.open();
				break;
		}
	}
}
