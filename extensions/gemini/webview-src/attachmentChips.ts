/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the next prompt sends along, shown as chips above the input, and the
// files pasted or dropped into the view.

import { type Attachment, attachmentLabel, classifyFile, maxImageBase64Length, supportedImageTypes } from '../src/acp/attachments';
import { attachmentIcon, carriesFiles, fileUris, format, imageName, sameAttachment } from './chatLogic';
import { button, el, icon } from './dom';
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

export function renderAttachments(): void {
	attachmentList.replaceChildren(...state.attachments.map(attachment => {
		const chip = el('span', 'chip attachment');
		if (attachment.kind === 'image') {
			const thumbnail = el('img', 'thumbnail');
			thumbnail.src = `data:${attachment.mimeType};base64,${attachment.data}`;
			thumbnail.alt = '';
			chip.append(thumbnail);
		} else {
			chip.append(icon(attachmentIcon(attachment.kind, attachmentLabel(attachment))));
			chip.title = attachment.path ?? attachmentLabel(attachment);
		}
		chip.append(el('span', undefined, attachmentLabel(attachment)));
		const remove = button('chip-remove', '', () => {
			// The rewrite running may name it; it can go once the rewrite is back.
			if (state.enhancing) {
				return;
			}
			state.attachments = state.attachments.filter(a => a !== attachment);
			renderAttachments();
			input.focus();
		}, 'close');
		remove.title = strings.remove;
		remove.setAttribute('aria-label', `${strings.remove} ${attachmentLabel(attachment)}`);
		chip.append(remove);
		return chip;
	}));
	attachmentList.hidden = !state.attachments.length;
	updateSendState();
}

function readBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

async function readImage(file: File): Promise<Attachment | undefined> {
	const data = await readBase64(file);
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
			return { kind: 'document', name, mimeType: content.mimeType, data: await readBase64(file) };
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
