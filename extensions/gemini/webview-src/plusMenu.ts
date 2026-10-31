/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's "+" menu: the approval mode, attaching files and context,
// following the agent, the model, usage and the slash commands, in one
// searchable list, so the composer itself holds only the input, the Write
// and Preview tabs, the model and Send.

import { format } from './chatLogic';
import { setLabel } from './dom';
import { Menu, type MenuRow, type MenuSection } from './menu';
import { modeIcon } from './modeIcon';
import { openFigmaDesign } from './figmaDesignLoader';
import { closePicker, startCommand, startMention } from './picker';
import { cliDefaultSection } from './pickers';
import { openNewThread, planFirst, setPlanFirst } from './project';
import { hasTerminal } from './runButtons';
import { toolRefContext } from './toolChips';
import { toolLogo } from './toolLogos';
import { setTip } from './tooltip';
import { contextPercent, toggleUsage } from './usage';
import { state, strings, ui, vscode } from './view';

const { plusButton: button, input } = ui;

let page: 'main' | 'model' = 'main';

setLabel(button, strings.plusMenu);

const menu = new Menu({
	element: ui.plusMenu,
	anchor: button,
	label: strings.plusMenu,
	search: () => strings.menuSearch,
	sections,
	empty: () => strings.noCommands,
	inside: [ui.modeChip],
	returnFocus: () => input,
	tip: setTip,
	onOpen: () => {
		closePicker();
		page = 'main';
	},
	onKey: event => {
		if (page === 'main' || ((event.key === 'ArrowLeft' || event.key === 'Backspace') && menu.text)) {
			return false;
		}
		if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Backspace') {
			show('main');
			return true;
		}
		return false;
	},
});

export function openPlusMenu(): void {
	menu.open();
}

export function closePlusMenu(focusInput = true): void {
	menu.close(focusInput);
}

/** The mode, model or follow state changed: an open menu shows it. */
export function updatePlusMenu(): void {
	menu.render();
}

function sections(): MenuSection[] {
	const model = state.settings.model;
	if (page === 'model') {
		return [{
			rows: [
				{ icon: 'arrow-left', name: strings.back, run: () => show('main') },
				...(model?.available ?? []).map(choice => ({
					icon: 'sparkle', name: choice.name, detail: choice.description, checked: choice.id === model?.currentId,
					run: () => {
						vscode.postMessage({ type: 'setModel', id: choice.id });
						closePlusMenu();
					},
				})),
			],
		}, ...cliDefaultSection(() => closePlusMenu())];
	}
	const mode = state.settings.mode;
	const result: MenuSection[] = [];
	const project = strings.project;
	if (project) {
		result.push({
			rows: [
				{ icon: 'git-branch', name: project.newThread, run: () => { closePlusMenu(); openNewThread(); } },
				{
					icon: modeIcon('plan'), name: project.planFirst, tooltip: project.planFirstTip, switchOn: planFirst(),
					run: () => {
						setPlanFirst(!planFirst());
						menu.render();
					},
				},
			],
		});
	}
	const fork = strings.fork;
	if (fork) {
		result.push({ rows: [{ icon: 'gemini-fork', name: fork.button, tooltip: fork.buttonTip, end: '/fork', run: () => { closePlusMenu(false); vscode.postMessage({ type: 'requestFork' }); } }] });
	}
	// Not in a project's coordinator chat: the coordinator never edits, and Plan mode would take away its project tools.
	if (mode && !project) {
		result.push({
			heading: strings.mode,
			// GeminiCode's words for the CLI's modes, and a tag on the one suggested for this folder; picking stays the user's.
			rows: mode.available.map(choice => ({
				icon: modeIcon(choice.id), name: choice.name, detail: strings.modeDetails[choice.id] ?? choice.description, checked: choice.id === mode.currentId,
				...choice.id === state.recommendMode ? { badge: strings.modeRecommended } : {},
				run: () => {
					vscode.postMessage({ type: 'setMode', id: choice.id });
					closePlusMenu();
				},
			})),
		});
	}
	result.push({
		rows: [
			{ icon: 'files', name: strings.menuFiles, detail: strings.menuFilesDetail, tooltip: strings.attachFiles, run: () => { closePlusMenu(); vscode.postMessage({ type: 'pickFiles' }); } },
			// Offered while a team tool is connected and this agent doesn't have them yet.
			...state.teamTools === 'available' ? [{ icon: 'plug', name: strings.menuTeamTools, detail: strings.menuTeamToolsDetail, run: () => { closePlusMenu(); vscode.postMessage({ type: 'useTeamTools' }); } }] : [],
			{ icon: 'mention', name: strings.menuContext, detail: strings.menuContextDetail, run: () => { closePlusMenu(false); startMention(); } },
			{
				icon: 'eye', name: strings.menuFollow, detail: strings.menuFollowDetail, switchOn: state.following,
				tooltip: state.following ? strings.followAgentOn : strings.followAgent,
				run: () => vscode.postMessage({ type: 'setFollow', on: !state.following }),
			},
			...hasTerminal() ? [{ icon: 'terminal', name: strings.run.openTerminal, detail: strings.run.openTerminalDetail, run: () => { closePlusMenu(false); vscode.postMessage({ type: 'command', command: 'gemini.agents.openTerminal' }); } }] : [],
			...strings.debugStart ? [{ icon: 'debug-alt', name: strings.debugStart[0], detail: strings.debugStart[1], run: () => { closePlusMenu(); vscode.postMessage({ type: 'debugAction', action: 'start' }); } }] : [],
		],
	});
	// Not in a project's coordinator chat, which runs in an empty folder with no branch.
	if (!project && toolRefContext().connected.includes('gitlab')) {
		result.push({
			rows: [{
				iconElement: () => toolLogo('gitlab', 14), name: strings.openMergeRequest, tooltip: strings.openMergeRequestTip,
				run: () => {
					closePlusMenu();
					vscode.postMessage({ type: 'openMergeRequest' });
				},
			}],
		});
	}
	const tools = fromYourTools();
	if (tools.length) {
		result.push({ heading: strings.fromYourTools, rows: tools });
	}
	const percent = contextPercent();
	result.push({
		rows: [
			...(model ? [{ icon: 'sparkle', name: strings.model, detail: model.available.find(choice => choice.id === model.currentId)?.name, submenu: true, run: () => show('model') }] : []),
			{ icon: 'gemini-usage', name: strings.usage, detail: percent === undefined ? undefined : format(strings.menuUsageDetail, percent), run: () => { closePlusMenu(false); toggleUsage(); } },
			{ icon: 'library', name: strings.menuCommands, detail: '/', run: () => { closePlusMenu(false); startCommand(); } },
		],
	});
	return result;
}

/** Jira tickets, GitLab items, Figma frames and Confluence pages, for the tools the user connected. */
function fromYourTools(): MenuRow[] {
	const connected = toolRefContext().connected;
	const pick = (tool: 'jira' | 'gitlab' | 'figma' | 'confluence') => () => {
		closePlusMenu();
		if (tool === 'figma') {
			// A frame for each screen size, in a dialog of its own.
			openFigmaDesign();
			return;
		}
		vscode.postMessage({ type: 'pickToolItem', tool });
	};
	const rows: { readonly tool: 'jira' | 'gitlab' | 'figma' | 'confluence'; readonly name: string; readonly end: string }[] = [
		{ tool: 'jira', name: strings.jiraTicket, end: '' },
		{ tool: 'gitlab', name: strings.gitlabItem, end: '!… #…' },
		{ tool: 'figma', name: strings.figmaDesign, end: strings.figmaDesignEnd },
		{ tool: 'confluence', name: strings.confluencePage, end: '' },
	];
	return rows.filter(row => connected.includes(row.tool)).map(row => ({
		iconElement: () => toolLogo(row.tool, 14), name: row.name, end: row.end || undefined, run: pick(row.tool),
	}));
}

function show(next: 'main' | 'model'): void {
	page = next;
	menu.clearQuery();
	menu.render();
}
