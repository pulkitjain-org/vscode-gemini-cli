/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Features the extension does not construct, or even load, when it activates,
// because nobody waits on them at startup: pages opened on request (Project
// Helpers, Connections) and tools used rarely (Run Benchmark, the pilot's
// export, the trace recorder, the audit log). Only their commands are
// registered, and the first run of one loads the feature's bundle and
// constructs it. Their code is in bundles of their own beside extension.js
// (`src/pages.ts` and `src/onDemand.ts`, built to dist/pages.js and
// dist/onDemand.js), so the extension's own bundle never carries it.

import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Loads bundle `name` from `dir`, the folder extension.js runs from (dist/,
 * or out/ in a development build), the first time the returned function is
 * called; later calls return the same module.
 */
export function chunkLoader<T>(dir: string, name: string): () => T {
	let loaded: T | undefined;
	// A path the bundler cannot follow: the chunk stays a file of its own, so tree-shaking does not apply.
	// eslint-disable-next-line no-restricted-syntax
	return () => loaded ??= require(path.join(dir, `${name}.js`)) as T;
}

/**
 * A feature constructed the first time one of `commands` runs. Until then
 * only stand-ins for its commands are registered; the first run removes them,
 * constructs the feature, which registers its own, and runs the command
 * again with the same arguments.
 */
export class LazyFeature<T extends vscode.Disposable> implements vscode.Disposable {

	private feature: T | undefined;
	private standIns: vscode.Disposable[] = [];
	private disposed = false;

	constructor(private readonly commands: readonly string[], private readonly create: () => T) {
		this.registerStandIns();
	}

	/** Whether the feature has been constructed. */
	get created(): boolean {
		return !!this.feature;
	}

	/** The feature, constructed now if it was not yet. */
	get(): T {
		if (this.disposed) {
			throw new Error('The feature was disposed.');
		}
		if (!this.feature) {
			this.disposeStandIns();
			try {
				this.feature = this.create();
			} catch (err) {
				// Its bundle could not load: the commands stay, and say so when run.
				this.registerStandIns();
				throw err;
			}
		}
		return this.feature;
	}

	dispose(): void {
		this.disposed = true;
		this.disposeStandIns();
		this.feature?.dispose();
		this.feature = undefined;
	}

	private registerStandIns(): void {
		this.standIns = this.commands.map(command => vscode.commands.registerCommand(command, (...args: unknown[]) => {
			this.get();
			return vscode.commands.executeCommand(command, ...args);
		}));
	}

	private disposeStandIns(): void {
		vscode.Disposable.from(...this.standIns).dispose();
		this.standIns = [];
	}
}
