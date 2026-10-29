/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A composer's Write and Preview tabs, shared by the agent chat and Agent
// Home. Preview shows the draft as it will look once sent, in the input's
// place and at its height, so nothing below jumps; typing goes back to Write.
// The draft is rendered only while Preview is shown.

export interface PreviewParts {
	readonly input: HTMLTextAreaElement;
	/** What Preview hides: the input, or the box around it. */
	readonly inputWrap: HTMLElement;
	readonly preview: HTMLElement;
	readonly writeTab: HTMLButtonElement;
	readonly previewTab: HTMLButtonElement;
	/** Gets the `previewing` class while Preview shows. */
	readonly form: HTMLElement;
	readonly strings: { readonly writeLabel: string; readonly previewLabel: string; readonly previewMarkdown: string; readonly previewEmpty: string };
	/** The draft as nodes; may be loading, in which case Preview fills in once it has. */
	render(text: string): Node[] | Promise<Node[]>;
}

export interface PreviewTabs {
	toggle(): void;
	/** Back to Write, as after sending. */
	close(): void;
	/** Shows the draft as it will look; call after changing the input's text. */
	update(): void;
	readonly open: boolean;
}

const mac = /Mac/.test(navigator.platform);

/** ⇧⌘V (Ctrl+Shift+V on Windows and Linux) switches between Write and Preview, as for Markdown files in the editor. */
export function isPreviewShortcut(event: KeyboardEvent): boolean {
	return event.code === 'KeyV' && event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export function createPreviewTabs(parts: PreviewParts): PreviewTabs {
	const { input, inputWrap, preview, writeTab, previewTab, form, strings } = parts;
	let open = false;
	let renders = 0;

	writeTab.textContent = strings.writeLabel;
	previewTab.textContent = strings.previewLabel;
	previewTab.title = strings.previewMarkdown.replace('{0}', mac ? '⇧⌘V' : 'Ctrl+Shift+V');
	writeTab.addEventListener('click', () => show(false));
	previewTab.addEventListener('click', () => show(true));
	// Arrow keys move between the tabs, as in any tab list.
	for (const tab of [writeTab, previewTab]) {
		tab.addEventListener('keydown', event => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault();
				show(tab === writeTab);
				(tab === writeTab ? previewTab : writeTab).focus();
			}
		});
	}
	for (const target of [preview, writeTab, previewTab]) {
		target.addEventListener('keydown', event => {
			if (isPreviewShortcut(event)) {
				event.preventDefault();
				show(!open);
			} else if (target === preview && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
				// Typing in Preview goes back to the draft, keeping the key.
				show(false);
			}
		});
	}

	function show(value: boolean): void {
		if (value) {
			// The preview takes the input's place at the input's height, so nothing below it jumps.
			preview.style.minHeight = `${input.offsetHeight}px`;
		}
		open = value;
		form.classList.toggle('previewing', open);
		writeTab.setAttribute('aria-selected', String(!open));
		previewTab.setAttribute('aria-selected', String(open));
		writeTab.tabIndex = open ? -1 : 0;
		previewTab.tabIndex = open ? 0 : -1;
		inputWrap.hidden = open;
		preview.hidden = !open;
		if (open) {
			update();
		} else {
			input.focus();
		}
	}

	function update(): void {
		if (!open) {
			return;
		}
		const text = input.value;
		if (!text.trim()) {
			const empty = document.createElement('p');
			empty.className = 'preview-empty';
			empty.textContent = strings.previewEmpty;
			preview.replaceChildren(empty);
			return;
		}
		const nodes = parts.render(text);
		if (Array.isArray(nodes)) {
			preview.replaceChildren(...nodes);
			return;
		}
		const render = ++renders;
		void nodes.then(loaded => {
			// Only the latest draft, and only while Preview still shows.
			if (render === renders && open) {
				preview.replaceChildren(...loaded);
			}
		}, () => undefined);
	}

	return {
		toggle: () => show(!open),
		close: () => {
			if (open) {
				show(false);
			}
		},
		update,
		get open() {
			return open;
		},
	};
}
