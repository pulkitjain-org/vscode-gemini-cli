/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The model menu beside Send and the branch, folder and commit menus under
// the composer, as pop-ups in the chat rather than system menus or quick
// picks, and the commit message box Commit to {0} opens.

import { isValidBranchName } from '../src/acp/branchNames';
import type { ViewBranch, ViewGit, ViewRepo, ViewWorkspace } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { el, icon, setLabel } from './dom';
import { Menu, type MenuRow, type MenuSection } from './menu';
import { toneOf } from './repoTones';
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
	}, ...cliDefaultSection(() => modelMenu.close())],
	empty: () => strings.loading,
});

/** The row that makes the session's model the CLI's default, as the terminal's /model dialog offers; none without a model. */
export function cliDefaultSection(close: () => void): MenuSection[] {
	const current = state.settings.model?.currentId;
	if (!current) {
		return [];
	}
	return [{
		rows: [{
			icon: 'pin', name: strings.modelDefaultCli, detail: strings.modelDefaultCliDetail,
			run: () => {
				vscode.postMessage({ type: 'setCliDefaultModel', id: current });
				close();
			},
		}],
	}];
}

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

// ---- A project's repositories ----

// A project with several repositories shows one pill per repository, with
// its branch, where one folder and branch would go; each opens the folder
// menu's actions for that repository.

let repos: readonly ViewRepo[] = [];
let menuRepo: ViewRepo | undefined;

const reposMenu = new Menu({
	element: ui.reposMenu,
	anchor: ui.repos,
	label: strings.repositories,
	title: () => menuRepo && { name: menuRepo.branch ? `${menuRepo.name} \u00b7 ${menuRepo.branch}` : menuRepo.name, detail: menuRepo.path },
	sections: () => menuRepo ? [{
		rows: ([['copy', strings.copyPath, 'copyPath'], ['folder-opened', strings.revealFolder, 'reveal']] as const).map(([iconName, name, action]): MenuRow => ({
			icon: iconName,
			name,
			run: () => {
				vscode.postMessage({ type: 'workspaceAction', action, repo: menuRepo!.name });
				reposMenu.close();
			},
		})),
	}] : [],
	empty: () => '',
	// Back to the pill that opened it.
	returnFocus: () => [...ui.repos.children].find(node => (node as HTMLElement).dataset.repo === menuRepo?.name) as HTMLElement ?? ui.repos,
});

/** Shows a project's repositories, or hides them with none. */
export function setRepos(list: readonly ViewRepo[]): void {
	repos = list;
	ui.repos.hidden = !list.length;
	ui.repos.replaceChildren(...list.map(repo => {
		const pill = toneOf(el('button', 'foot-button repo'), repo.name);
		pill.type = 'button';
		pill.dataset.repo = repo.name;
		pill.append(icon('repo'), el('span', 'repo-name', repo.name));
		if (repo.branch) {
			pill.append(icon('git-branch'), el('span', 'repo-branch', repo.branch));
		}
		setLabel(pill, format(strings.repoTooltip, repo.name, repo.branch ?? '?', repo.path));
		// The pills share one menu: a click on another pill while it is open moves it there.
		pill.addEventListener('click', () => {
			const moving = reposMenu.isOpen && menuRepo?.name !== repo.name;
			menuRepo = repo;
			if (moving) {
				queueMicrotask(() => reposMenu.open());
			}
		});
		return pill;
	}));
	if (menuRepo) {
		menuRepo = repos.find(repo => repo.name === menuRepo!.name);
		if (!menuRepo) {
			reposMenu.close(false);
		}
	}
	reposMenu.render();
}

/** The folder the folder menu is about. */
export function setWorkspace(value: ViewWorkspace | undefined): void {
	workspace = value;
	folderMenu.render();
}

// ---- Commit ----

// On a branch other than the repository's default, Commit commits there, with
// a message the extension writes from the changes, edited in a box over the
// footer; its chevron offers Create Branch and Commit. On the default branch
// Commit is Create Branch & Commit, as it always was.

const commitBox = ui.commitBox;
const commitMessage = commitBox.querySelector<HTMLTextAreaElement>('.commit-message')!;
const commitNote = commitBox.querySelector<HTMLElement>('.commit-note')!;
const commitConfirm = commitBox.querySelector<HTMLButtonElement>('.commit-confirm')!;
const commitCancel = commitBox.querySelector<HTMLButtonElement>('.commit-cancel')!;
commitBox.querySelector('label')!.textContent = strings.commitTo.message;
commitConfirm.textContent = strings.commitTo.commit;
commitCancel.textContent = strings.commitTo.cancel;
commitBox.setAttribute('aria-label', strings.commitTo.message);
commitBox.tabIndex = -1;
setLabel(ui.commitMore, strings.commitTo.more);

/** The branch Commit commits to; unset on the default branch. */
let commitTo: string | undefined;
/** Waiting for the written message, or for the commit to finish. */
let commitState: 'writing' | 'ready' | 'committing' = 'ready';

const commitMenu = new Menu({
	element: ui.commitMenu,
	anchor: ui.commitMore,
	label: strings.commitTo.more,
	sections: () => [{
		rows: [{
			icon: 'git-branch', name: strings.commitTo.newBranch, run: () => {
				commitMenu.close();
				closeCommitBox(false);
				vscode.postMessage({ type: 'createBranchAndCommit' });
			},
		}],
	}],
	empty: () => '',
});

/** The commit button and its chevron, as the folder's branch has them. */
export function setCommit(git: ViewGit): void {
	commitTo = git.canCommit ? git.commitTo : undefined;
	ui.commitButton.hidden = !git.canCommit || !git.branch;
	ui.commitMore.hidden = ui.commitButton.hidden || !commitTo;
	ui.commitLabel.textContent = commitTo ? format(strings.commitTo.button, commitTo) : strings.commit;
	setLabel(ui.commitButton, commitTo ? format(strings.commitTo.tip, commitTo) : strings.createBranchAndCommit);
	if (ui.commitMore.hidden) {
		commitMenu.close(false);
	}
	if (!commitTo && commitState !== 'committing') {
		closeCommitBox(false);
	}
}

function showCommitState(): void {
	commitNote.textContent = commitState === 'writing' ? strings.commitTo.writing : strings.commitTo.generated;
	commitMessage.disabled = commitState !== 'ready';
	commitConfirm.disabled = commitState !== 'ready' || !commitMessage.value.trim();
}

function openCommitBox(): void {
	commitMenu.close(false);
	commitBox.hidden = false;
	ui.commitButton.setAttribute('aria-expanded', 'true');
	commitState = 'writing';
	commitMessage.value = '';
	showCommitState();
	vscode.postMessage({ type: 'writeCommitMessage' });
	commitBox.focus();
}

function closeCommitBox(focus = true): void {
	if (commitBox.hidden) {
		return;
	}
	commitBox.hidden = true;
	commitState = 'ready';
	ui.commitButton.setAttribute('aria-expanded', 'false');
	if (focus) {
		ui.commitButton.focus();
	}
}

/** The message the extension wrote for the box. */
export function setCommitMessage(message: string | undefined): void {
	if (commitBox.hidden || commitState !== 'writing') {
		return;
	}
	commitState = 'ready';
	commitMessage.value = message ?? '';
	showCommitState();
	commitMessage.focus();
	commitMessage.setSelectionRange(0, 0);
}

/** The box's commit finished: it closes once committed, and stays for another try when not. */
export function commitDone(ok: boolean): void {
	if (ok) {
		closeCommitBox(false);
	} else if (!commitBox.hidden) {
		commitState = 'ready';
		showCommitState();
	}
}

function confirmCommit(): void {
	const message = commitMessage.value.trim();
	if (commitState !== 'ready' || !message) {
		return;
	}
	commitState = 'committing';
	showCommitState();
	vscode.postMessage({ type: 'commitToBranch', message });
}

ui.commitButton.setAttribute('aria-haspopup', 'dialog');
ui.commitButton.addEventListener('click', () => {
	if (!commitTo) {
		vscode.postMessage({ type: 'createBranchAndCommit' });
	} else if (commitBox.hidden) {
		openCommitBox();
	} else {
		closeCommitBox();
	}
});
commitMessage.addEventListener('input', showCommitState);
commitConfirm.addEventListener('click', confirmCommit);
commitCancel.addEventListener('click', () => closeCommitBox());
commitBox.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		closeCommitBox();
	} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		// ⌘Return commits, as in Source Control's message box.
		event.preventDefault();
		confirmCommit();
	}
});
