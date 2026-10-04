/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the extension API has no OS notifications or Dock badge, so the
// Gemini extension reaches them through these two internal commands.

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { IHostService } from '../../../services/host/browser/host.js';

interface GeminiToast {
	readonly title: string;
	readonly body?: string;
	readonly actions?: readonly string[];
	/** A newer toast with the same key replaces the older one. */
	readonly key?: string;
}

const liveToasts = new Map<string, CancellationTokenSource>();

/**
 * Shows an OS notification and bounces the Dock icon. Resolves when the user
 * clicks it (the window comes to the front) or it goes away, with what they
 * clicked: `{ clicked, actionIndex }`, or `{ supported: false }`.
 */
CommandsRegistry.registerCommand('_gemini.showToast', async (accessor, toast: GeminiToast) => {
	const hostService = accessor.get(IHostService);
	if (typeof toast?.title !== 'string') {
		return { supported: false, clicked: false };
	}
	const key = toast.key ?? toast.title;
	liveToasts.get(key)?.dispose(true);
	const cts = new CancellationTokenSource();
	liveToasts.set(key, cts);
	try {
		await hostService.focus(mainWindow, { mode: FocusMode.Notify });
		const result = await hostService.showToast({ title: toast.title, body: toast.body, actions: toast.actions, dedupeKey: `gemini:${key}` }, cts.token);
		if (result.clicked || typeof result.actionIndex === 'number') {
			await hostService.focus(mainWindow, { mode: FocusMode.Force });
		}
		return { supported: result.supported, clicked: result.clicked, actionIndex: result.actionIndex };
	} finally {
		if (liveToasts.get(key) === cts) {
			liveToasts.delete(key);
		}
		cts.dispose();
	}
});

/** Withdraws the toast with `key`, such as once the agent no longer waits. */
CommandsRegistry.registerCommand('_gemini.hideToast', (_accessor, key: string) => {
	liveToasts.get(key)?.dispose(true);
	liveToasts.delete(key);
});

/** Shows `count` on the Dock icon; 0 clears it. The badge goes with the window. */
CommandsRegistry.registerCommand('_gemini.setApplicationBadge', (accessor, count: number, description: string) => {
	const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	return accessor.get(INativeHostService).setApplicationBadge(n ? { count: n, description: String(description ?? '') } : undefined);
});
