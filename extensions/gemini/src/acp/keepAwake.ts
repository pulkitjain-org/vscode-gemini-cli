/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface KeepAwakeOptions {
	readonly platform: NodeJS.Platform;
	/** The process `caffeinate` watches: it exits on its own when that process does, so it cannot outlive GeminiCode. */
	readonly pid: number;
	readonly spawn?: (command: string, args: readonly string[]) => ChildProcess;
	readonly log?: (message: string) => void;
}

/**
 * Keeps a Mac from idle sleep while an agent works, with `caffeinate -i`.
 * The display may still sleep. Does nothing on other platforms.
 */
export class KeepAwake {

	private child: ChildProcess | undefined;
	private enabled = true;
	private busy = false;
	/** Set when `caffeinate` cannot run, so it is not tried on every turn. */
	private broken = false;

	constructor(private readonly options: KeepAwakeOptions) { }

	/** Whether `caffeinate` is running. */
	get active(): boolean {
		return this.child !== undefined;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.update();
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		this.update();
	}

	dispose(): void {
		this.enabled = false;
		this.update();
	}

	private update(): void {
		const want = this.enabled && this.busy && !this.broken && this.options.platform === 'darwin';
		if (want && !this.child) {
			this.start();
		} else if (!want && this.child) {
			const child = this.child;
			this.child = undefined;
			child.kill();
			this.options.log?.('An agent stopped working; the Mac may sleep again');
		}
	}

	private start(): void {
		const spawn = this.options.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: 'ignore' }));
		const child = spawn('caffeinate', ['-i', '-w', String(this.options.pid)]);
		this.child = child;
		this.options.log?.('An agent is working; keeping the Mac awake');
		child.on('error', err => {
			this.broken = true;
			this.options.log?.(`Could not keep the Mac awake: ${err.message}`);
		});
		child.on('exit', () => {
			if (this.child === child) {
				this.child = undefined;
			}
		});
	}
}
