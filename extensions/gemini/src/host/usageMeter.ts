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

/** How fresh a quota read on request must be; older ones are read again. */
const onRequestMaxAgeMs = 60_000;

/** The quota as last read: `none` when the sign-in has no quota to read (an API key). */
export type QuotaReading =
	| { readonly kind: 'ok'; readonly quota: readonly ModelQuota[]; /** When it was read, in ms since the epoch. */ readonly at: number }
	| { readonly kind: 'none' }
	| { readonly kind: 'failed' }
	| { readonly kind: 'off' };

/**
 * Today's Gemini quota use, for the status bar and the chat's usage popover:
 * one small `retrieveUserQuota` request with the CLI's sign-in, at most every
 * 10 minutes and only while the window is in front, or when the popover asks.
 * API key sign-ins have no quota to read.
 */
export class UsageMeter implements vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<readonly ModelQuota[] | undefined>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private lastRead = 0;
	/** The last value sent, so listeners hear only changes. */
	private last: string | undefined = '';
	private pending: Promise<QuotaReading> | undefined;
	private _reading: QuotaReading | undefined;
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

	/** The last read, if there was one. */
	get reading(): QuotaReading | undefined {
		return this.enabled() ? this._reading : { kind: 'off' };
	}

	/** The quota, read again unless the last read is under a minute old. */
	refresh(): Promise<QuotaReading> {
		if (!this.enabled()) {
			return Promise.resolve({ kind: 'off' });
		}
		if (this._reading && Date.now() - this.lastRead < onRequestMaxAgeMs) {
			return this.pending ?? Promise.resolve(this._reading);
		}
		return this.pending ?? this.readNow();
	}

	private enabled(): boolean {
		return vscode.workspace.getConfiguration(configSection).get<boolean>(enabledSetting, true);
	}

	private async read(): Promise<void> {
		if (!this.enabled()) {
			this._reading = undefined;
			this.update(undefined);
			return;
		}
		if (this.pending || !vscode.window.state.focused || Date.now() - this.lastRead < refreshMs - toleranceMs) {
			return;
		}
		await this.readNow();
	}

	private readNow(): Promise<QuotaReading> {
		this.lastRead = Date.now();
		const pending = this.client.quota(AbortSignal.timeout(15_000)).then(
			(quota): QuotaReading => quota?.length ? { kind: 'ok', quota, at: Date.now() } : { kind: 'none' },
			(err): QuotaReading => {
				// The meter is a nicety; a failure only leaves it out.
				this.log.debug(`Could not read the Gemini quota: ${errorMessage(err)}`);
				return { kind: 'failed' };
			},
		).then(reading => {
			this.pending = undefined;
			this._reading = reading;
			this.update(reading.kind === 'ok' ? reading.quota : undefined);
			return reading;
		});
		this.pending = pending;
		return pending;
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
