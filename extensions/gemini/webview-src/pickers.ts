/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The model menu beside Send and the branch and folder menus under the
// composer, as pop-ups in the chat rather than system menus or quick picks.

import { isValidBranchName } from '../src/acp/branchNames';
import type { ViewBranch, ViewWorkspace } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { setLabel } from './dom';
import { Menu, type MenuRow } from './menu';
import { state, strings, ui, vscode } from './view';

// ---- Model ----

const modelMenu = new Menu({
	element: ui.modelMenu,
	anchor: ui.modelButton,
	label: strings.model,
	sections: () => [{
		rows: (state.settings.model?.available ?? []).map(choice => ({
			name: choice.name,
			detail: choice.description,
			checked: choice.id === state.settings.model?.currentId,
			run: () => {
				vscode.postMessage({ type: 'setModel', id: choice.id });
				modelMenu.close();
			},
		})),
	}],
	empty: () => strings.loading,
});

/** Shows the session's model on its button, and in the menu if open. */
export function updateModel(): void {
	const model = state.settings.model;
	ui.modelButton.hidden = !model;
	const current = model?.available.find(choice => choice.id === model.currentId);
	ui.modelLabel.textContent = current?.name ?? '';
	setLabel(ui.modelButton, current?.description ? `${strings.model}: ${current.name}, ${current.description}` : `${strings.model}: ${current?.name ?? ''}`);
	modelMenu.render();
}

// ---- Branch ----

/** The folder's branches, once the extension sent them for this opening of the menu. */
let branches: readonly ViewBranch[] | undefined;
let branchNotice: string | undefined;
/** Whether the field names a new branch rather than filtering the list. */
let creating = false;
/** When the list was last asked for; a pointer on the button asks ahead, so the menu opens with it. */
let branchesAskedAt = 0;
/** A list asked for this recently is shown at once when the menu opens, while a fresh one comes. */
const branchesFreshMs = 10_000;
/** Rows the menu draws at most; typing narrows the rest. */
const maxBranchRows = 50;

function askForBranches(): void {
	branchesAskedAt = Date.now();
	vscode.postMessage({ type: 'listBranches' });
}

const branchMenu: Menu = new Menu({
	element: ui.branchMenu,
	anchor: ui.branchButton,
	label: strings.branchSearch,
	search: () => creating ? strings.newBranchName : strings.branchSearch,
	filters: true,
	sections: query => {
		const q = query.trim();
		if (branchNotice) {
			return [];
		}
		if (creating) {
			return isValidBranchName(q) ? [{ rows: [{ icon: 'add', name: format(strings.createBranchNamed, q), run: () => pickBranch(q, true) }] }] : [];
		}
		const shown = (branches ?? []).filter(branch => branch.name.toLowerCase().includes(q.toLowerCase())).slice(0, maxBranchRows);
		return [
			{ rows: [{ icon: 'add', name: strings.createBranch, run: startCreating }] },
			{
				rows: shown.map((branch): MenuRow => ({
					icon: 'git-branch',
					name: branch.name,
					end: branch.current ? (branch.age ? `${strings.currentBranch} · ${branch.age}` : strings.currentBranch) : branch.age,
					checked: branch.current,
					run: () => pickBranch(branch.name, false),
				})),
			},
		];
	},
	empty: (): string => branchNotice ?? (creating ? (branchMenu.text.trim() ? strings.invalidBranchName : strings.newBranchName) : branches ? strings.noBranches : strings.loading),
	onOpen: () => {
		if (Date.now() - branchesAskedAt > branchesFreshMs) {
			branches = undefined;
			branchNotice = undefined;
		}
		creating = false;
		askForBranches();
	},
	onKey: event => {
		if (event.key === 'Escape' && creating) {
			creating = false;
			branchMenu.clearQuery();
			branchMenu.render();
			return true;
		}
		return false;
	},
});

ui.branchButton.addEventListener('pointerenter', () => {
	if (Date.now() - branchesAskedAt > branchesFreshMs) {
		askForBranches();
	}
});

function startCreating(): void {
	creating = true;
	branchMenu.clearQuery();
	branchMenu.render();
}

function pickBranch(name: string, create: boolean): void {
	vscode.postMessage({ type: 'switchBranch', name, create });
	branchMenu.close();
}

/** The extension's answer to `listBranches`. */
export function setBranches(list: readonly ViewBranch[], notice: string | undefined): void {
	branches = list;
	branchNotice = notice;
	branchMenu.render();
}

// ---- Folder ----

let workspace: ViewWorkspace | undefined;

const folderMenu = new Menu({
	element: ui.workspaceMenu,
	anchor: ui.workspaceButton,
	label: strings.workspaceTooltip.replace('{0}', '').trim(),
	title: () => workspace && { name: workspace.name, detail: workspace.path },
	sections: () => [
		{ rows: folderRows([['copy', strings.copyPath, 'copyPath'], ['folder-opened', strings.revealFolder, 'reveal'], ['list-tree', strings.showAgents, 'showAgents']]) },
		{ rows: folderRows([['new-folder', strings.addFolder, 'addFolder']]) },
	],
	empty: () => '',
});

function folderRows(rows: readonly (readonly [string, string, 'copyPath' | 'reveal' | 'showAgents' | 'addFolder'])[]): MenuRow[] {
	return rows.map(([iconName, name, action]) => ({
		icon: iconName,
		name,
		run: () => {
			vscode.postMessage({ type: 'workspaceAction', action });
			folderMenu.close();
		},
	}));
}

/** The folder the folder menu is about. */
export function setWorkspace(value: ViewWorkspace | undefined): void {
	workspace = value;
	folderMenu.render();
}
