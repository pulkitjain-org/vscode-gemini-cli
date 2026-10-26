/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the next prompt sends along, shown as chips above the input, and the
// files pasted or dropped into the view.

import type { SharedPageView } from '../src/host/chatProtocol';
import { type Attachment, attachmentLabel, classifyFile, maxImageBase64Length, supportedImageTypes } from '../src/acp/attachments';
import { attachmentIcon, carriesFiles, fileUris, format, imageName, sameAttachment, toolChipParts } from './chatLogic';
import { readFileBase64 } from './panelDom';
import { openFigmaDesign } from './figmaDesignLoader';
import { toolLogo } from './toolLogos';
import { button, el, icon, setLabel, setTip } from './dom';
import { updateSendState } from './inputBox';
import { setTransientNotice } from './transcript';
import { state, strings, ui, vscode } from './view';

const { attachmentList, form, input } = ui;

export function addAttachments(added: readonly Attachment[]): void {
	for (const attachment of added) {
		if (!state.attachments.some(existing => sameAttachment(existing, attachment))) {
			state.attachments.push(attachment);
		}
	}
	renderAttachments();
	input.focus();
}

/** Pins the shared page's chip to the composer, or takes it away. */
export function setSharedPage(page: SharedPageView | undefined): void {
	state.sharedPage = page;
	renderAttachments();
}

function sharedPageChip(page: SharedPageView): HTMLElement {
	const chip = el('span', 'chip attachment shared-page');
	const open = button('shared-page-open', format(strings.sharedPage, page.title), () => vscode.postMessage({ type: 'openSharedPage' }), 'globe');
	setTip(open, format(strings.showSharedPage, page.url));
	chip.append(open);
	const stop = button('chip-remove', '', () => vscode.postMessage({ type: 'stopSharing' }), 'close');
	setLabel(stop, strings.stopSharing);
	chip.append(stop);
	return chip;
}

export function renderAttachments(): void {
	attachmentList.replaceChildren(...state.sharedPage ? [sharedPageChip(state.sharedPage)] : [], ...state.attachments.map(attachment => {
		const chip = el('span', 'chip attachment');
		if (attachment.kind === 'image') {
			const thumbnail = el('img', 'thumbnail');
			thumbnail.src = `data:${attachment.mimeType};base64,${attachment.data}`;
			thumbnail.alt = '';
			chip.append(thumbnail);
		} else if (attachment.kind === 'document' && attachment.design) {
			// A Figma design with a frame for each size: its sizes, and a click to change them.
			const design = attachment.design;
			chip.classList.add('tool-chip');
			const open = button('tool-chip-open', '', () => openFigmaDesign(design));
			open.append(toolLogo('figma', 14), el('span', 'tool-chip-key', strings.figmaDesignChip), el('span', 'tool-chip-title', design.map(frame => frame.size).join(' · ')));
			setTip(open, strings.figmaEditDesign);
			chip.append(open);
		} else if (attachment.kind === 'document' && attachment.tool) {
			// A Jira ticket, GitLab item or Figma frame: the tool's logo, its key in bold, then its title; a click opens it in its tool.
			const [key, title] = toolChipParts(attachment);
			const ref = attachment.ref;
			chip.classList.add('tool-chip');
			const open = button('tool-chip-open', '', () => ref && vscode.postMessage({ type: 'openToolRef', ref }));
			open.append(toolLogo(attachment.tool, 14), el('span', 'tool-chip-key', key), ...title ? [el('span', 'tool-chip-title', title)] : []);
			open.setAttribute('aria-label', format(strings.openToolItem, title ? attachment.name : key));
			setTip(open, title ? format(strings.openToolItem, attachment.name) : strings.toolChipLoading);
			chip.append(open);
		} else {
			chip.append(icon(attachmentIcon(attachment.kind, attachmentLabel(attachment))));
			setTip(chip, attachment.path ?? attachmentLabel(attachment));
		}
		if (!chip.classList.contains('tool-chip')) {
			chip.append(el('span', undefined, attachmentLabel(attachment)));
		}
		const remove = button('chip-remove', '', () => {
			// The rewrite running may name it; it can go once the rewrite is back.
			if (state.enhancing) {
				return;
			}
			state.attachments = state.attachments.filter(a => a !== attachment);
			if (attachment.kind === 'document' && attachment.ref) {
				state.dismissedToolRefs.add(attachment.ref);
			}
			renderAttachments();
			input.focus();
		}, 'close');
		setTip(remove, strings.remove);
		remove.setAttribute('aria-label', `${strings.remove} ${attachmentLabel(attachment)}`);
		chip.append(remove);
		return chip;
	}));
	attachmentList.hidden = !state.attachments.length && !state.sharedPage;
	updateSendState();
}


async function readImage(file: File): Promise<Attachment | undefined> {
	const data = await readFileBase64(file);
	if (data.length > maxImageBase64Length) {
		setTransientNotice(format(strings.fileTooLarge, file.name || 'file'));
		return undefined;
	}
	return { kind: 'image', name: imageName(file.name, file.type), mimeType: file.type, data };
}

/** A file without a path (dropped from Finder or pasted) sent with its contents, if it can be. */
async function readDroppedFile(file: File): Promise<Attachment | undefined> {
	const name = file.name || 'file';
	if (state.imageInput && supportedImageTypes.has(file.type)) {
		return readImage(file);
	}
	const content = classifyFile(name, file.type, new Uint8Array(await file.arrayBuffer()));
	switch (content.kind) {
		case 'text':
			return { kind: 'document', name, mimeType: 'text/plain', text: content.text };
		case 'inline':
			return { kind: 'document', name, mimeType: content.mimeType, data: await readFileBase64(file) };
		case 'tooLarge':
			setTransientNotice(format(strings.fileTooLarge, name));
			return undefined;
		case 'unsupported':
			setTransientNotice(format(strings.cannotAttach, name));
			return undefined;
	}
}

/** File URIs in a drop, such as from the Explorer (which needs Shift held to drop into a view). */
function droppedUris(data: DataTransfer): string[] {
	return fileUris(data.getData('application/vnd.code.uri-list') || data.getData('text/uri-list'));
}

/**
 * Takes the files from a paste or drop. Ones with paths go to the extension,
 * which links workspace files and reads others; ones without are read here.
 */
function takeFiles(data: DataTransfer | null): boolean {
	if (!data) {
		return false;
	}
	const uris = droppedUris(data);
	if (uris.length) {
		vscode.postMessage({ type: 'attachUris', uris });
		return true;
	}
	const files = [...data.files];
	if (!files.length) {
		return false;
	}
	void Promise.all(files.map(file => readDroppedFile(file).catch(() => undefined)))
		.then(added => addAttachments(added.filter((a): a is Attachment => !!a)));
	return true;
}

input.addEventListener('paste', event => {
	// Pasted files only; pasted text (and a link list copied as text) stays text.
	if (event.clipboardData?.files.length && takeFiles(event.clipboardData)) {
		event.preventDefault();
	}
});
// Files can be dropped anywhere in the view; the composer shows where they go.
document.addEventListener('dragover', event => {
	const data = event.dataTransfer;
	if (data && carriesFiles(data.types)) {
		event.preventDefault();
		data.dropEffect = 'copy';
		form.classList.add('dragging');
	}
});
document.addEventListener('dragleave', event => {
	// Leaving the view, not just moving between its elements.
	if (!event.relatedTarget) {
		form.classList.remove('dragging');
	}
});
document.addEventListener('drop', event => {
	form.classList.remove('dragging');
	if (takeFiles(event.dataTransfer)) {
		event.preventDefault();
	}
});
