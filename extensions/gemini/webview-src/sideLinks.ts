/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The side column of an agent's or thread's chat, in the margin right of the
// centred transcript: where the agent works, and links to its Changes (with
// the lines added and removed), Browser, Terminal and Files. It never moves
// the chat; a narrow view shows the links as icons, and one too narrow for
// those hides them (chat.css).

import type { SideLink, ViewSideLinks } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { button, el, setTip } from './dom';
import { strings, ui, vscode } from './view';

const column = ui.sideLinks;
const heading = el('p', 'side-on');
const added = el('span', 'side-added');
const removed = el('span', 'side-removed');

function link(name: SideLink, iconName: string, label: string, tip: string): HTMLButtonElement {
	const node = button(`side-link side-${name}`, label, () => vscode.postMessage({ type: 'openSideLink', link: name }), iconName);
	node.setAttribute('aria-label', label);
	setTip(node, tip);
	return node;
}

const changes = link('changes', 'diff-multiple', strings.sideChanges, strings.sideChanges);
const counts = el('span', 'side-counts');
counts.append(added, removed);
changes.append(counts);
column.setAttribute('aria-label', strings.sideLinks);
column.append(
	heading,
	changes,
	link('browser', 'globe', strings.sideBrowser, strings.sideBrowserTip),
	link('terminal', 'terminal', strings.sideTerminal, strings.sideTerminalTip),
	link('files', 'files', strings.sideFiles, strings.sideFilesTip),
);

/** Shows the column for `links`, or hides it (a project's chat has none). */
export function setSideLinks(links: ViewSideLinks | undefined): void {
	column.hidden = !links;
	document.body.classList.toggle('has-side-links', !!links);
	if (!links) {
		return;
	}
	heading.textContent = format(strings.sideOn, links.place);
	setTip(heading, heading.textContent);
	added.textContent = `+${links.added}`;
	removed.textContent = `\u2212${links.removed}`;
	counts.hidden = !links.added && !links.removed;
	setTip(changes, format(strings.sideChangesTip, String(links.added), String(links.removed)));
}
