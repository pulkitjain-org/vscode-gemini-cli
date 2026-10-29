/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { removeStaleTempFiles } from '../acp/fsUtil';
import { removeKeptSessionFolders } from '../acp/sessionFolder';
import { applyLogRetention } from '../acp/storageUsage';
import { keepDaysSetting } from './storageSection';

/** How long after startup the housekeeping runs, so it never competes with the first chat. */
const startDelayMs = 60_000;

/**
 * Housekeeping once the window has settled: the audit log's days past
 * `gemini.audit.keepDays` go, and so do the CLI debug log every window
 * shared before each got its own, the pilot's counters, which nothing records
 * or exports any more, copies of sessions' folders a load never put back
 * (sessionFolder.ts), and the temporary files of writes a crash interrupted.
 */
export function scheduleStorageMaintenance(globalStorage: string, log: vscode.LogOutputChannel): vscode.Disposable {
	const timer = setTimeout(async () => {
		try {
			const days = keepDaysSetting();
			const removed = await applyLogRetention(globalStorage, days);
			await fs.rm(path.join(globalStorage, 'cli-debug.log'), { force: true });
			await fs.rm(path.join(globalStorage, 'pilot'), { recursive: true, force: true });
			await removeKeptSessionFolders();
			// A store's write a crash interrupted leaves its temporary file beside the store (fsUtil.ts).
			const stale = await removeStaleTempFiles(globalStorage, 24 * 60 * 60 * 1000);
			if (removed || stale) {
				log.info(`Removed ${removed} log files older than ${days} days and ${stale} temporary files a crash left behind`);
			}
		} catch (err) {
			log.warn(`Storage housekeeping failed: ${errorMessage(err)}`);
		}
	}, startDelayMs);
	return { dispose: () => clearTimeout(timer) };
}
