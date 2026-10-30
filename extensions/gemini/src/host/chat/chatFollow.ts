/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Follow the agent: opens each file the agent reads or edits, leaving focus
// in the chat, and names the file in the composer while its tab is open.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { followablePath, FollowTarget, FollowTracker } from '../../acp/follow';
import type { ToolCallModel } from '../../acp/sessionUpdates';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { followAgentOn, rememberFollowAgent } from '../modelPreference';
import type { ChatControllerOptions } from './chatOptions';
import { isFile } from './chatFiles';

/** At most one file is shown this often while following the agent, so a burst of reads does not flicker the editor. */
const followIntervalMs = 250;

export type FollowMessage = Extract<FromWebview, { readonly type: 'setFollow' | 'showFollowed' | 'closeFollowed' }>;

export class ChatFollow implements vscode.Disposable {

	/** Starts as the last chat left it. */
	private following = followAgentOn();
	private readonly follow = new FollowTracker();
	/** The file to show next; files are shown at most every {@link followIntervalMs}, the latest winning. */
	private target: FollowTarget | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The file Follow the agent opened last, until its tab closes. */
	private followed: vscode.Uri | undefined;
	private readonly tabsListener: vscode.Disposable;

	constructor(
		/** The agent's folder: files outside it are not shown. */
		private readonly cwd: string,
		private readonly options: Pick<ChatControllerOptions, 'editorColumn'>,
		private readonly post: (message: ToWebview) => void,
	) {
		this.tabsListener = vscode.window.tabGroups.onDidChangeTabs(() => {
			if (this.followed && !followedTabs(this.followed).length) {
				this.followed = undefined;
				this.postFollowed();
			}
		});
	}

	/** Tells a view that loaded whether the chat follows the agent. */
	postFollowing(): void {
		this.post({ type: 'follow', on: this.following });
	}

	/** The chat names the followed file, with a close button, while its tab is open. */
	postFollowed(): void {
		const uri = this.followed;
		this.post({ type: 'followed', file: uri && { name: path.basename(uri.fsPath), path: vscode.workspace.asRelativePath(uri) } });
	}

	/** Turns Follow the agent on or off in this chat; new chats start the same way. */
	toggle(): void {
		this.set(!this.following);
	}

	/** A turn's tool call started or changed: shows the file it is on, when the chat follows the agent. */
	onToolCall(call: ToolCallModel): void {
		if (this.following) {
			this.schedule(this.follow.next(call));
		}
	}

	onMessage(message: FollowMessage): void {
		switch (message.type) {
			case 'setFollow':
				this.set(message.on);
				break;
			case 'showFollowed':
				if (this.followed) {
					const followed = this.followed;
					void Promise.resolve(this.options.editorColumn?.()).then(viewColumn => vscode.window.showTextDocument(followed, { preview: true, viewColumn })).then(undefined, () => undefined);
				}
				break;
			case 'closeFollowed':
				void this.closeFollowed();
				break;
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.tabsListener.dispose();
	}

	private set(on: boolean): void {
		this.following = on;
		if (!on) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.target = undefined;
		}
		this.post({ type: 'follow', on });
		rememberFollowAgent(on);
	}

	private schedule(target: FollowTarget | undefined): void {
		if (!target) {
			return;
		}
		this.target = target;
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			const next = this.target;
			this.target = undefined;
			if (next && this.following) {
				void this.show(next);
			}
		}, followIntervalMs);
	}

	/**
	 * Shows a file the agent is on, leaving focus in the chat. Folders, missing
	 * files, files outside the agent's folder and files that may hold secrets
	 * are skipped.
	 */
	private async show(target: FollowTarget): Promise<void> {
		const file = followablePath(this.cwd, target);
		if (!file || !await isFile(file)) {
			return;
		}
		const position = new vscode.Position(Math.max((target.line ?? 1) - 1, 0), 0);
		const uri = vscode.Uri.file(file);
		try {
			await vscode.window.showTextDocument(uri, {
				selection: new vscode.Range(position, position), preview: true, preserveFocus: true, viewColumn: await this.options.editorColumn?.(),
			});
		} catch {
			// A file that cannot be shown, such as a binary one, is skipped.
			return;
		}
		this.followed = uri;
		this.postFollowed();
	}

	private async closeFollowed(): Promise<void> {
		const uri = this.followed;
		if (uri) {
			await vscode.window.tabGroups.close(followedTabs(uri));
		}
	}
}

/** The editor tabs showing `uri`. */
function followedTabs(uri: vscode.Uri): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
}
