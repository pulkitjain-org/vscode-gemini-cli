/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Home's menus: the composer's "+", folder, mode, project and From Your Tools
// menus, and a dashboard row's "..." menu. A chunk of its own, with the menu class,
// which Home loads once it has settled or on the first click on one of their
// buttons, so Home's startup script stays small. Show All and Customize
// (homePopups.ts) get the same menu class from here, so opening one menu
// closes the others.

import type { HomeAction, HomeButton, HomeCard, HomeRow, HomeView } from '../src/host/panelProtocol';
import type { HomeStrings } from '../src/host/panelStrings';
import { Menu, type MenuRow, type MenuSection } from './menu';
import { modeIcon } from './modeIcon';
import { format } from './panelDom';

export { Menu };

/** What the menus need from Home. */
export interface HomeMenusHost {
	readonly strings: HomeStrings;
	/** The view Home shows now. */
	view(): HomeView | undefined;
	/** The folder and the approval mode the next agent starts in, and picking them. */
	folder(): string;
	pickFolder(folder: string): void;
	mode(): string;
	pickMode(mode: string): void;
	pickFiles(): void;
	addFolder(): void;
	/** Trust...: the folder's trust question, asked again. */
	trust(folder: string): void;
	/** The project the next task goes to, when it goes to one: a coordinator's id, or 'new'; picking one, or a plain branch instead. */
	project(): string;
	toProject(): boolean;
	pickProject(id: string): void;
	pickBranch(): void;
	run(action: HomeAction): void;
	logo(tool: 'jira' | 'gitlab', size: number): Element;
	/** Home's themed tooltip, for the rows. */
	tip(node: HTMLElement, tip: string): void;
	/** Where focus goes when a row's menu closes and its button is gone. */
	fallbackFocus(): HTMLElement;
}

export interface HomeMenus {
	readonly Menu: typeof Menu;
	/** Opens the menu of the composer's button `anchor`, as its first click would have. */
	open(anchor: HTMLElement): void;
	/** Opens, or closes when open from it, the "..." menu of a row with `items`. */
	openRow(anchor: HTMLElement, items: readonly HomeButton[]): void;
	/** Draws the open menu again, as when the view changed. */
	render(): void;
}

export function createHomeMenus(host: HomeMenusHost): HomeMenus {
	const { strings } = host;
	const byId = (id: string) => document.getElementById(id)!;
	const menu = (anchor: string, label: string, sections: () => readonly MenuSection[], empty = () => '') => new Menu({
		element: byId(`${anchor}-menu`),
		anchor: byId(anchor),
		label,
		sections,
		empty,
		tip: host.tip,
	});

	/** A row per mode the next agent can start in; picking one closes `open`. Auto Edit in a folder the CLI doesn't trust offers Trust... instead. */
	const modeRows = (open: () => Menu): MenuRow[] => {
		const untrusted = host.view()?.workspaces.find(w => w.folder === host.folder())?.trust === 'untrusted';
		return (host.view()?.modes ?? []).map(choice => untrusted && choice.id === 'autoEdit' ? {
			icon: modeIcon(choice.id),
			name: choice.name,
			detail: strings.needsTrustedFolder,
			end: strings.trustButton,
			run: () => {
				open().close();
				host.trust(host.folder());
			},
		} : {
			icon: modeIcon(choice.id),
			name: choice.name,
			detail: choice.description,
			checked: choice.id === host.mode(),
			run: () => {
				host.pickMode(choice.id);
				open().close();
			},
		});
	};

	const plusMenu: Menu = menu('plus', strings.plusMenu, () => [
		{ heading: strings.mode, rows: modeRows(() => plusMenu) },
		{ rows: [{ icon: 'files', name: strings.files, detail: strings.filesDetail, run: () => { plusMenu.close(); host.pickFiles(); } }] },
	]);

	/** "From Your Tools...": the tickets and merge requests on the cards, each starting an agent or a review on it. */
	const fromToolsMenu: Menu = menu('from-tools', strings.fromTools, () => {
		const cards = host.view()?.dashboard.cards ?? [];
		const rowsOf = (id: HomeCard['id'], tool: 'jira' | 'gitlab', actionOf: (row: HomeRow) => HomeAction | undefined): MenuRow[] =>
			(cards.find(card => card.id === id)?.rows ?? []).flatMap(row => {
				const action = actionOf(row);
				return row.key && action ? [{
					iconElement: () => host.logo(tool, 14),
					name: `${row.key} ${row.title}`,
					detail: [row.detail, row.pill?.text].filter(Boolean).join(' · '),
					run: () => {
						fromToolsMenu.close();
						host.run(action);
					},
				}] : [];
			});
		const tickets = rowsOf('tickets', 'jira', row => row.menu?.[0]?.action);
		const mergeRequests = rowsOf('mergeRequests', 'gitlab', row => row.button?.action);
		return [
			...tickets.length ? [{ heading: strings.tickets, rows: tickets }] : [],
			...mergeRequests.length ? [{ heading: strings.mergeRequests, rows: mergeRequests }] : [],
		];
	}, () => strings.fromToolsEmpty);

	const modeMenu: Menu = menu('mode', strings.mode, () => [{ rows: modeRows(() => modeMenu) }]);

	const trustEnd = { trusted: [strings.trusted, 'ok', 'workspace-trusted'], parent: [strings.trustedByParent, undefined, undefined], untrusted: [strings.needsTrust, 'warn', 'workspace-untrusted'] } as const;
	const folderMenu: Menu = menu('workspace', strings.workspace, () => [
		{
			rows: (host.view()?.workspaces ?? []).map(w => ({
				icon: 'folder',
				name: w.name,
				detail: w.description,
				...w.trust ? { end: trustEnd[w.trust][0], endTone: trustEnd[w.trust][1], endIcon: trustEnd[w.trust][2] } : {},
				checked: w.folder === host.folder(),
				run: () => {
					host.pickFolder(w.folder);
					folderMenu.close();
				},
			})),
		},
		{ rows: [{ icon: 'add', name: strings.addFolder, run: () => { folderMenu.close(); host.addFolder(); } }] },
	], () => strings.noWorkspace);

	/** On a Branch's chevron: a branch of its own, or a project (the folder's repository's first, then the others', then a new one there). */
	const projectMenu: Menu = menu('project', strings.branchMenu, () => {
		const view = host.view();
		const current = view?.workspaces.find(w => w.folder === host.folder());
		const all = view?.projects ?? [];
		const row = (p: NonNullable<HomeView['projects']>[number], other: boolean): MenuRow => ({
			name: p.title,
			detail: [...other ? [p.workspace] : [], p.threads, p.updated].join(' \u00b7 '),
			checked: host.toProject() && p.id === host.project(),
			run: () => {
				projectMenu.close();
				if (other) {
					host.pickFolder(p.folder);
				}
				host.pickProject(p.id);
			},
		});
		const here = all.filter(p => p.folder === current?.folder);
		const others = all.filter(p => p.folder !== current?.folder);
		return [
			{ rows: [{ icon: 'git-branch', name: strings.branchAlone, detail: strings.startOwnBranchHint, checked: !host.toProject(), run: () => { projectMenu.close(); host.pickBranch(); } }] },
			...here.length ? [{ heading: format(strings.projectsIn, current?.name ?? ''), rows: here.map(p => row(p, false)) }] : [],
			...others.length ? [{ heading: strings.otherProjects, rows: others.map(p => row(p, true)) }] : [],
			{ heading: here.length || others.length ? undefined : strings.startProject, rows: [{ icon: 'add', name: format(strings.newProjectIn, current?.name ?? ''), detail: strings.startProjectHint, checked: host.toProject() && host.project() === 'new', run: () => { projectMenu.close(); host.pickProject('new'); } }] },
		];
	});

	/** The "..." menu of a row; moved into the row it opens for. */
	let rowItems: readonly HomeButton[] = [];
	let rowAnchor: HTMLElement | undefined;
	const rowMenuElement = byId('row-menu');
	const rowMenu: Menu = new Menu({
		element: rowMenuElement,
		anchor: document.createElement('button'),
		label: strings.moreActions,
		sections: () => [{ rows: rowItems.map(item => ({ name: item.label, run: () => { rowMenu.close(); host.run(item.action); } })) }],
		empty: () => '',
		returnFocus: () => rowAnchor?.isConnected ? rowAnchor : host.fallbackFocus(),
		tip: host.tip,
	});

	const composerMenus = [plusMenu, fromToolsMenu, modeMenu, folderMenu, projectMenu];
	const anchors = ['plus', 'from-tools', 'mode', 'workspace', 'project'].map(byId);
	return {
		Menu,
		open(anchor) {
			composerMenus[anchors.indexOf(anchor)]?.open();
		},
		openRow(anchor, items) {
			if (rowMenu.isOpen && rowAnchor === anchor) {
				rowMenu.close();
				return;
			}
			rowItems = items;
			rowAnchor = anchor;
			anchor.parentElement!.append(rowMenuElement);
			rowMenu.open();
		},
		render() {
			for (const each of composerMenus) {
				each.render();
			}
		},
	};
}
