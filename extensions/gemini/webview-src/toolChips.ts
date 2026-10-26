/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Chips for the team's tools in the composer: a Jira key typed or pasted, or
// a Jira, GitLab or Figma link pasted, becomes a chip with the tool's logo.
// The chip shows at once with the key; the extension reads the item in the
// background and swaps in its title and content (toolRefResolved). A pasted
// link alone is replaced by its chip; a key stays in the text, since it reads
// naturally there. A chip the user removed doesn't come back for that item.

import type { Attachment } from '../src/acp/attachments';
import { findToolRefs, soleToolRef, ToolRef, ToolRefContext, toolRefId, toolRefLabel } from '../src/acp/toolLinks';
import { addAttachments, renderAttachments } from './attachmentChips';
import { state, vscode } from './view';

let context: ToolRefContext = { connected: [] };
const dismissed = state.dismissedToolRefs;

export function setToolRefContext(next: ToolRefContext): void {
	context = next;
}

export function toolRefContext(): ToolRefContext {
	return context;
}

/** A chip for `ref`, at once with its key, then with its title once the extension has read it. */
export function attachToolRef(ref: ToolRef): void {
	const id = toolRefId(ref);
	if (state.attachments.some(a => a.kind === 'document' && a.ref === id)) {
		return;
	}
	dismissed.delete(id);
	addAttachments([{ kind: 'document', name: toolRefLabel(ref), mimeType: 'text/plain', text: placeholderText(ref), tool: ref.tool, ref: id }]);
	vscode.postMessage({ type: 'resolveToolRef', ref });
}

/** Swaps a chip for its read item; a chip removed meanwhile stays removed. */
export function toolRefResolved(attachment: Attachment): void {
	if (attachment.kind !== 'document' || !attachment.ref) {
		return;
	}
	const index = state.attachments.findIndex(a => a.kind === 'document' && a.ref === attachment.ref);
	if (index !== -1) {
		state.attachments[index] = attachment;
		renderAttachments();
	}
}

function placeholderText(ref: ToolRef): string {
	switch (ref.tool) {
		case 'jira': return `Jira ticket ${ref.key}. Read it with jira_get_issue.`;
		case 'gitlab': return `GitLab ${ref.kind === 'mr' ? 'merge request' : 'issue'} ${ref.url}. Read it with ${ref.kind === 'mr' ? 'gitlab_get_mr' : 'gitlab_get_issue'}.`;
		case 'figma': return `Figma frame: ${ref.url}\nCall figma_design with this link for its code hints and design variables. Call figma_screenshot only when you need to see it, such as to compare what you built.`;
	}
}

function attachAll(refs: readonly ToolRef[]): void {
	for (const ref of refs) {
		if (!dismissed.has(toolRefId(ref))) {
			attachToolRef(ref);
		}
	}
}

/** Watches `input` for pasted links and typed keys. */
export function watchToolRefs(input: HTMLTextAreaElement): void {
	input.addEventListener('paste', event => {
		if (!context.connected.length || event.clipboardData?.files.length) {
			return;
		}
		const text = event.clipboardData?.getData('text/plain') ?? '';
		const sole = soleToolRef(text, context);
		if (sole && sole.tool !== 'jira') {
			// A link on its own: the chip says it better than the URL.
			event.preventDefault();
			attachAll([sole]);
			return;
		}
		attachAll(findToolRefs(text, context));
	});
	input.addEventListener('input', event => {
		if (!context.connected.includes('jira') || (event as InputEvent).inputType === 'insertFromPaste') {
			return;
		}
		// A key just finished: the word before the caret, ended by a space or punctuation.
		const before = input.value.slice(0, input.selectionStart);
		const word = /([A-Za-z][A-Za-z0-9_]{1,15}-\d{1,7})[\s.,;:!?)]$/.exec(before)?.[1];
		if (word) {
			attachAll(findToolRefs(word, context));
		}
	});
}
