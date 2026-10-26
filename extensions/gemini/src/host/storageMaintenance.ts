/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { applyLogRetention, keepLogsDays } from '../acp/storageUsage';
import { configSection } from './configuration';

/** How long after startup the housekeeping runs, so it never competes with the first chat. */
const startDelayMs = 60_000;

/**
 * Housekeeping once the window has settled: the audit and pilot logs' days
 * past `gemini.storage.keepLogsDays` go, and so does the CLI debug log every
 * window shared before each got its own.
 */
export function scheduleStorageMaintenance(globalStorage: string, log: vscode.LogOutputChannel): vscode.Disposable {
	const timer = setTimeout(async () => {
		try {
			const days = keepLogsDays(vscode.workspace.getConfiguration(configSection).get<number>('storage.keepLogsDays'));
			const removed = await applyLogRetention(globalStorage, days);
			await fs.rm(path.join(globalStorage, 'cli-debug.log'), { force: true });
			if (removed) {
				log.info(`Removed ${removed} log files older than ${days} days`);
			}
		} catch (err) {
			log.warn(`Storage housekeeping failed: ${errorMessage(err)}`);
		}
	}, startDelayMs);
	return { dispose: () => clearTimeout(timer) };
}
