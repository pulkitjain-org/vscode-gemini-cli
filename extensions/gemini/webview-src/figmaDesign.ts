/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Add Figma Design (the + menu's From Your Tools): one frame link for each
// screen size, as designers lay a design's sizes out side by side. Pasting
// several links fills the rows in order; the sizes come from the team's
// defaults (`figma.viewports`), else Mobile, Tablet and Desktop. The design
// becomes one chip; clicking it opens the dialog again. It looks like the New
// thread dialog and shares its styles. A chunk of its own (media/figmaDesign.js),
// loaded the first time it opens (figmaDesignLoader.ts): what it needs of the
// chat comes in `FigmaDesignOptions`, never from the chat's own modules.

import type { Attachment } from '../src/acp/attachments';
import { designPrompt, designRefId, designWarnings, defaultDesignSizes, type DesignFrame, figmaLinksIn, nextSizes } from '../src/acp/figmaDesign';
import type { ChatStrings } from '../src/host/chatProtocol';
import { el, icon } from './panelDom';
import type { SelectMenu, selectMenu } from './selectMenu';

export type FigmaDesignStrings = Pick<ChatStrings, 'figmaDesignTitle' | 'figmaDesignHint' | 'figmaSize' | 'figmaLinkFor' | 'figmaAddSize' | 'figmaAddDesign' | 'figmaUpdateDesign' | 'figmaOtherFile' | 'figmaRepeated' | 'figmaNotLink' | 'figmaDesignChip' | 'cancel' | 'remove'>;

export interface FigmaDesignOptions {
	readonly strings: FigmaDesignStrings;
	/** The team's sizes, from its defaults; Mobile, Tablet and Desktop when empty. */
	readonly sizes: readonly string[];
	/** The design to change, from its chip. */
	readonly current?: readonly DesignFrame[];
	/** The chat's themed select menu and tooltips, so the dialog's are the chat's own. */
	readonly selectMenu: typeof selectMenu;
	setLabel(node: HTMLElement, label: string): void;
	/** The design's attachment, when the user adds it. */
	onDone(attachment: Attachment): void;
}

function format(template: string, ...values: string[]): string {
	return template.replace(/\{(\d+)\}/g, (match, i: string) => values[Number(i)] ?? match);
}

/** Opens the dialog, empty or with `current`'s frames to change. */
export function openFigmaDesign(options: FigmaDesignOptions): void {
	if (document.querySelector('.figma-design')) {
		return;
	}
	const { strings, current, setLabel } = options;
	const sizes = options.sizes.length ? options.sizes : defaultDesignSizes;
	const dialog = el('dialog', 'new-thread figma-design');
	dialog.setAttribute('aria-labelledby', 'figma-design-heading');
	const form = el('form');
	form.method = 'dialog';

	const head = el('div', 'new-thread-head');
	const heading = el('h2', undefined, strings.figmaDesignTitle);
	heading.id = 'figma-design-heading';
	const close = el('button', 'icon-button');
	close.type = 'button';
	close.append(icon('close'));
	setLabel(close, strings.cancel);
	close.addEventListener('click', () => dialog.close());
	head.append(heading, close);
	form.append(head, el('p', 'new-thread-hint', strings.figmaDesignHint));

	const rows = el('div', 'figma-design-rows');
	const warnings = el('div', 'figma-design-warnings');
	warnings.setAttribute('role', 'status');
	type Row = { readonly node: HTMLElement; readonly size: HTMLSelectElement; readonly menu: SelectMenu; readonly link: HTMLInputElement };
	let list: Row[] = [];

	const frames = (): DesignFrame[] => list.filter(row => row.link.value.trim()).map(row => ({ size: row.size.value, url: row.link.value.trim() }));
	const check = () => {
		const found = designWarnings(frames());
		const lines = [
			...found.otherFile.length ? [format(strings.figmaOtherFile, found.otherFile.join(', '))] : [],
			...found.repeated.map(size => format(strings.figmaRepeated, size)),
			...list.some(row => row.link.value.trim() && !figmaLinksIn(row.link.value).length) ? [strings.figmaNotLink] : [],
		];
		warnings.replaceChildren(...lines.map(line => {
			const item = el('div', 'figma-design-warning');
			item.append(icon('warning'), el('span', undefined, line));
			return item;
		}));
		submit.disabled = !frames().length || list.some(row => row.link.value.trim() && !figmaLinksIn(row.link.value).length);
	};
	const addRow = (size: string, url = '') => {
		const node = el('div', 'figma-design-row');
		const select = el('select', 'new-thread-input');
		for (const choice of [...new Set([...sizes, size])]) {
			select.append(new Option(choice, choice));
		}
		select.value = size;
		select.addEventListener('change', check);
		const menu = options.selectMenu(select, strings.figmaSize);
		const link = el('input', 'new-thread-input');
		link.type = 'url';
		link.placeholder = 'https://www.figma.com/design/…?node-id=…';
		link.spellcheck = false;
		link.value = url;
		link.setAttribute('aria-label', format(strings.figmaLinkFor, size));
		link.addEventListener('input', check);
		// Several links pasted at once fill this row and the next ones, in order.
		link.addEventListener('paste', event => {
			const pasted = figmaLinksIn(event.clipboardData?.getData('text/plain') ?? '');
			if (pasted.length < 2) {
				return;
			}
			event.preventDefault();
			link.value = pasted[0];
			const start = list.indexOf(row) + 1;
			const more = pasted.slice(1);
			more.forEach((value, i) => {
				const existing = list[start + i];
				if (existing && !existing.link.value.trim()) {
					existing.link.value = value;
				} else {
					addRow(nextSizes(1, sizes, list.map(r => r.size.value))[0], value);
				}
			});
			check();
		});
		const remove = el('button', 'icon-button');
		remove.type = 'button';
		remove.append(icon('close'));
		setLabel(remove, strings.remove);
		remove.addEventListener('click', () => {
			menu.dispose();
			node.remove();
			list = list.filter(r => r !== row);
			check();
		});
		node.append(menu.element, link, remove);
		const row: Row = { node, size: select, menu, link };
		list.push(row);
		rows.append(node);
		return row;
	};
	for (const frame of current ?? []) {
		addRow(frame.size, frame.url);
	}
	if (!current?.length) {
		// One row for each of the team's sizes, ready for their links.
		sizes.forEach(size => addRow(size));
	}
	const more = el('button', 'link-button figma-design-add');
	more.type = 'button';
	more.append(icon('add'), el('span', undefined, strings.figmaAddSize));
	more.addEventListener('click', () => {
		addRow(nextSizes(1, sizes, list.map(r => r.size.value))[0]).link.focus();
		check();
	});
	form.append(rows, more, warnings);

	const foot = el('div', 'permission-actions new-thread-foot');
	const cancel = el('button', 'secondary', strings.cancel);
	cancel.type = 'button';
	cancel.addEventListener('click', () => dialog.close());
	const submit = el('button', 'primary', current ? strings.figmaUpdateDesign : strings.figmaAddDesign);
	submit.type = 'submit';
	foot.append(cancel, submit);
	form.append(foot);

	form.addEventListener('submit', event => {
		event.preventDefault();
		const design = frames().map(frame => ({ ...frame, url: figmaLinksIn(frame.url)[0] ?? frame.url }));
		if (!design.length) {
			return;
		}
		options.onDone(designAttachment(design, strings));
		dialog.close();
	});
	dialog.addEventListener('close', () => {
		list.forEach(row => row.menu.dispose());
		dialog.remove();
	});
	dialog.append(form);
	document.body.append(dialog);
	check();
	dialog.showModal();
	(list.find(row => !row.link.value.trim()) ?? list[0])?.link.focus();
}

/** The design as one attachment: the chip names its sizes, and the agent reads each size's link. */
function designAttachment(design: readonly DesignFrame[], strings: FigmaDesignStrings): Attachment {
	return {
		kind: 'document' as const,
		name: strings.figmaDesignChip,
		mimeType: 'text/plain',
		text: designPrompt(design),
		tool: 'figma' as const,
		ref: designRefId(design),
		design,
	};
}
