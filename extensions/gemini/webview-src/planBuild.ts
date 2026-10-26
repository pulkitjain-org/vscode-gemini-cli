/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Build This Plan under a plan's reply: it builds in the mode the chat was in
// before Plan, and its chevron offers the other choice (Default, or Auto Edit
// when that mode was Default). A line under it names both models when the
// build's model differs from the plan's.

import { format, type ItemOf } from './chatLogic';
import { button, el, setLabel, setTip } from './dom';
import { Menu, type MenuRow } from './menu';
import { modeIcon } from './modeIcon';
import { state, strings, vscode } from './view';

/** The chevrons' menu, made on the first click, and the turn it is open for. */
let menu: Menu | undefined;
let menuTurn: { readonly id: string; readonly build: NonNullable<ItemOf<'turnEnd'>['build']>; readonly anchor: HTMLElement } | undefined;

/** Build This Plan for `item`, with its chevron when there is another way to build, and the models' line. */
export function planBuildButtons(item: ItemOf<'turnEnd'>): HTMLElement[] {
	const build = button('turn-action', strings.buildPlan, () => vscode.postMessage({ type: 'buildPlan', itemId: item.id }), 'play');
	const choice = item.build;
	setLabel(build, choice ? `${strings.buildPlanTooltip}: ${buildName(choice.mode)}` : strings.buildPlanTooltip);
	const nodes: HTMLElement[] = [build];
	if (choice?.other) {
		const more = button('turn-action plan-build-more', '', () => toggleMenu(item.id, choice, more), 'chevron-down');
		setLabel(more, strings.planBuild.more);
		more.setAttribute('aria-haspopup', 'menu');
		more.setAttribute('aria-expanded', 'false');
		nodes.push(more);
	}
	// The plan file this turn wrote: Review Plan edits it and gathers comments for Gemini.
	if (item.planFile) {
		const review = button('turn-action', strings.reviewPlan, () => vscode.postMessage({ type: 'reviewPlan', itemId: item.id }), 'comment-discussion');
		setLabel(review, strings.reviewPlanTooltip);
		nodes.push(review);
	}
	if (choice?.models) {
		nodes.push(el('span', 'plan-build-models', format(strings.planBuild.models, choice.models.build, choice.models.plan)));
	}
	return nodes;
}

/** "Build in Auto Edit", or "Build, Asking for Each Edit" for Default. */
function buildName(mode: string): string {
	return mode === 'default' ? strings.planBuild.asking : format(strings.planBuild.buildIn, state.settings.mode?.available.find(choice => choice.id === mode)?.name ?? mode);
}

function toggleMenu(id: string, build: NonNullable<ItemOf<'turnEnd'>['build']>, anchor: HTMLElement): void {
	menu ??= createMenu();
	if (menu.isOpenFrom(anchor)) {
		menu.close();
		return;
	}
	menu.setAnchor(anchor);
	menuTurn = { id, build, anchor };
	menu.open();
}

function createMenu(): Menu {
	const element = el('div', 'run-menu plan-build-menu');
	element.hidden = true;
	document.body.append(element);
	const created: Menu = new Menu({
		element,
		// Each chevron is made its anchor in turn (toggleMenu); this one is never shown.
		anchor: el('button'),
		label: strings.planBuild.more,
		tip: setTip,
		onOpen: () => {
			const box = menuTurn!.anchor.getBoundingClientRect();
			// Above the chevron when the turn's end is near the bottom, as the latest one is.
			const up = innerHeight - box.bottom < 140;
			element.style.top = up ? '' : `${box.bottom + 4}px`;
			element.style.bottom = up ? `${innerHeight - box.top + 4}px` : '';
			element.style.left = `${Math.max(8, box.left)}px`;
		},
		sections: () => {
			const turn = menuTurn!;
			const row = (mode: string): MenuRow => ({
				icon: modeIcon(mode), name: buildName(mode), checked: mode === turn.build.mode,
				detail: mode === 'default' ? strings.planBuild.defaultMode : mode === turn.build.mode ? strings.planBuild.beforePlan : undefined,
				run: () => {
					created.close();
					vscode.postMessage({ type: 'buildPlan', itemId: turn.id, mode });
				},
			});
			return [{ rows: [row(turn.build.mode), row(turn.build.other!)] }];
		},
		empty: () => '',
	});
	return created;
}
