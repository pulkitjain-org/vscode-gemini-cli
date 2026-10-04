/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DirectClient, ModelQuota } from '../acp/directRequest';
import { errorMessage } from '../acp/errors';
import { configSection } from './configuration';

const enabledSetting = 'usageMeter.enabled';
/** The quota is read at most this often, like the CLI's own refresh. */
const refreshMs = 10 * 60_000;
/** The first read waits until startup has settled. */
const firstReadDelayMs = 15_000;
/** Slack for the timer: a tick a little under 10 minutes after the last read still reads. */
const toleranceMs = 60_000;

/**
 * Today's Gemini quota use, for the status bar: one small `retrieveUserQuota`
 * request with the CLI's sign-in, at most every 10 minutes and only while
 * the window is in front. API key sign-ins have no quota to read.
 */
export class UsageMeter implements vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<readonly ModelQuota[] | undefined>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private lastRead = 0;
	/** The last value sent, so listeners hear only changes. */
	private last: string | undefined = '';
	private reading = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly first: ReturnType<typeof setTimeout>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly client: DirectClient, private readonly log: vscode.LogOutputChannel) {
		this.first = setTimeout(() => void this.read(), firstReadDelayMs);
		this.timer = setInterval(() => void this.read(), refreshMs);
		this.disposables.push(
			this.onDidChangeEmitter,
			vscode.window.onDidChangeWindowState(state => state.focused && void this.read()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${configSection}.${enabledSetting}`)) {
					this.lastRead = 0;
					void this.read();
				}
			}),
		);
	}

	private enabled(): boolean {
		return vscode.workspace.getConfiguration(configSection).get<boolean>(enabledSetting, true);
	}

	private async read(): Promise<void> {
		if (!this.enabled()) {
			this.update(undefined);
			return;
		}
		if (this.reading || !vscode.window.state.focused || Date.now() - this.lastRead < refreshMs - toleranceMs) {
			return;
		}
		this.reading = true;
		this.lastRead = Date.now();
		try {
			const quota = await this.client.quota(AbortSignal.timeout(15_000));
			this.update(quota?.length ? quota : undefined);
		} catch (err) {
			// The meter is a nicety; a failure only leaves it out.
			this.log.debug(`Could not read the Gemini quota: ${errorMessage(err)}`);
			this.update(undefined);
		} finally {
			this.reading = false;
		}
	}

	private update(quota: readonly ModelQuota[] | undefined): void {
		const json = quota && JSON.stringify(quota);
		if (json !== this.last) {
			this.last = json;
			this.onDidChangeEmitter.fire(quota);
		}
	}

	dispose(): void {
		clearTimeout(this.first);
		clearInterval(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
