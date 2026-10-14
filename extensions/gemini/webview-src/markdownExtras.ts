/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat adds to rendered Markdown: GitHub-style callouts
// (> [!NOTE]), tables that scroll on their own, and file names in `code` that
// open the file.

import { fileReference } from './chatLogic';
import { addCallouts, wrapTables } from './draftMarkdown';
import { strings, vscode } from './view';

const calloutLabels: Record<string, () => string> = {
	note: () => strings.calloutNote,
	tip: () => strings.calloutTip,
	important: () => strings.calloutImportant,
	warning: () => strings.calloutWarning,
	caution: () => strings.calloutCaution,
};

/** Adds callouts, table wrappers and file links to rendered Markdown in `root`. */
export function enhanceMarkdown(root: HTMLElement): void {
	addCallouts(root, kind => calloutLabels[kind]());
	wrapTables(root);
	for (const code of root.querySelectorAll('code')) {
		if (!code.closest('pre')) {
			toFileLink(code);
		}
	}
}

function toFileLink(code: HTMLElement): void {
	const reference = fileReference(code.textContent ?? '');
	if (!reference) {
		return;
	}
	code.classList.add('file-link');
	code.tabIndex = 0;
	code.setAttribute('role', 'link');
	code.title = strings.openFile;
	const open = () => vscode.postMessage({ type: 'openPath', path: reference.path, ...(reference.line ? { line: reference.line } : {}) });
	code.addEventListener('click', open);
	code.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			open();
		}
	});
}
