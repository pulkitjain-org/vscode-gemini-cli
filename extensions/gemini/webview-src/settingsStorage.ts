/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Setup's Storage section (src/host/storageSection.ts), on its Storage &
// Audit tab: a row per place GeminiCode keeps data, with its size. The sizes
// are asked for the first time the section scrolls into view, never as the
// page opens.

import type { StorageMessage, StorageStrings, StorageView } from '../src/host/panelProtocol';
import { button, el, icon } from './panelDom';
import { selectMenu, type SelectMenu } from './selectMenu';

/** The logs row's menu, drawn again with the page. */
let keepLogsMenu: SelectMenu | undefined;
let watching: IntersectionObserver | undefined;

/** The section; `post` asks the extension, which measures once the section is in view while `view` is still waiting. */
export function storageSection(view: StorageView, strings: StorageStrings, post: (message: StorageMessage) => void): HTMLElement {
	const node = el('section', 'settings-section storage');
	const header = el('div', 'section-header');
	const text = el('div');
	text.append(el('h2', undefined, strings.storage), el('p', 'hint', strings.storageHint));
	header.append(text);
	if (view.cleanup) {
		header.append(button('secondary', view.cleanup, () => post({ type: 'cleanUp' }), 'trash'));
	}
	node.append(header);
	const list = el('div', 'rows');
	for (const row of view.rows) {
		const line = el('div', `row storage-${row.id}`);
		const main = el('div', 'row-main');
		const title = el('div', 'row-title');
		title.append(el('span', 'name', row.label));
		main.append(title, el('div', 'row-detail', row.detail || (view.state === 'ready' ? '' : strings.storageMeasuring)));
		line.append(main);
		if (row.id === 'logs') {
			const select = el('select', 'select');
			for (const choice of view.keepLogs.choices) {
				const option = el('option', undefined, choice.label);
				option.value = choice.value;
				option.selected = choice.value === view.keepLogs.value;
				select.append(option);
			}
			select.addEventListener('change', () => post({ type: 'setKeepLogs', days: select.value }));
			keepLogsMenu?.dispose();
			keepLogsMenu = selectMenu(select, strings.keepLogs);
			line.append(keepLogsMenu.element);
		}
		line.append(el('span', 'mono storage-size', row.size));
		const action = row.action;
		if (action) {
			line.append(button('secondary', action.label, () => post({ type: 'storageAction', action: action.kind })));
		}
		list.append(line);
	}
	if (view.error) {
		const problem = el('p', 'empty row-problem');
		problem.append(icon('warning'), el('span', undefined, ` ${view.error}`));
		list.append(problem);
	}
	node.append(list);
	watching?.disconnect();
	watching = undefined;
	if (view.state === 'waiting') {
		if (typeof IntersectionObserver === 'undefined') {
			post({ type: 'measureStorage' });
		} else {
			const observer = new IntersectionObserver(entries => {
				if (entries.some(entry => entry.isIntersecting)) {
					observer.disconnect();
					post({ type: 'measureStorage' });
				}
			});
			observer.observe(node);
			watching = observer;
		}
	}
	return node;
}
