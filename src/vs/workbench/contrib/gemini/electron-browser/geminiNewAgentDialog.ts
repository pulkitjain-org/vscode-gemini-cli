/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the New agent popup the Gemini extension opens from the browser's
// "Let Gemini Use This Page" (`_gemini.newAgentDialog`, src/host/agentsView.ts).
// The extension API has no popup with fields, and a webview can't float over the
// browser's page, so the form is drawn here. It only collects the choices: the
// extension passes what to offer and starts the agent with what comes back.
// The block carries `monaco-dialog-modal-block`, so the browser's overlay
// manager hides the page under it as it does for other dialogs.

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import './geminiNewAgentDialog.css';

/** What the extension offers. */
export interface NewAgentDialogInput {
	/** The page the agent gets, named under the title. */
	readonly page?: string;
	readonly folders: readonly { readonly folder: string; readonly label: string; readonly description: string; readonly git: boolean }[];
	/** The models the agent offers; empty when not known yet, which leaves the model to the usual default. */
	readonly models: readonly { readonly id: string; readonly name: string }[];
	readonly defaultModel?: string;
	readonly modes: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
	/** The branch name an own branch gets unless the user names one. */
	readonly branchPlaceholder: string;
}

/** What the user chose. */
export interface NewAgentDialogResult {
	readonly folder: string;
	readonly ownBranch: boolean;
	readonly branch?: string;
	readonly model?: string;
	readonly mode: string;
	/** What it should do; sent with the page when given, else the page waits in its message box. */
	readonly task?: string;
}

CommandsRegistry.registerCommand('_gemini.newAgentDialog', (accessor, input: NewAgentDialogInput) => {
	const layoutService = accessor.get(ILayoutService);
	const fileDialogService = accessor.get(IFileDialogService);
	return showNewAgentDialog(layoutService.activeContainer, input, () => fileDialogService.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		title: localize('gemini.newAgent.chooseFolderTitle', "Where the Agent Works"),
		openLabel: localize('gemini.newAgent.chooseFolderOpen', "Choose"),
	}).then(uris => uris?.[0]?.fsPath));
});

let open: Promise<NewAgentDialogResult | undefined> | undefined;

function showNewAgentDialog(container: HTMLElement, input: NewAgentDialogInput, chooseFolder: () => Promise<string | undefined>): Promise<NewAgentDialogResult | undefined> {
	// One at a time: a second request waits on the open one.
	if (open) {
		return open;
	}
	const disposables = new DisposableStore();
	const previousFocus = container.ownerDocument.activeElement as HTMLElement | null;
	open = new Promise<NewAgentDialogResult | undefined>(resolve => {
		const block = append(container, $('.monaco-dialog-modal-block.dimmed.gemini-new-agent-block'));
		const dialog = append(block, $('.gemini-new-agent', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gemini-new-agent-title' }));

		const header = append(dialog, $('.header'));
		append(header, $('h2#gemini-new-agent-title', undefined, localize('gemini.newAgent.title', "New agent")));
		const close = append(header, $('button.close.codicon.codicon-close', { type: 'button', 'aria-label': localize('gemini.newAgent.close', "Close") }));
		if (input.page) {
			append(dialog, $('p.subtitle', undefined, localize('gemini.newAgent.page', "It gets the page \"{0}\" to read and use.", input.page)));
		}

		const field = (label: string, control: HTMLElement, id: string) => {
			const wrap = append(dialog, $('.field'));
			const labelElement = append(wrap, $('label', undefined, label)) as HTMLLabelElement;
			labelElement.htmlFor = id;
			control.id = id;
			wrap.append(control);
			return wrap;
		};

		// Where: the workspaces, then any folder.
		const folder = $('select') as HTMLSelectElement;
		const git = new Map<string, boolean>();
		for (const each of input.folders) {
			folder.append(new Option(`${each.label}  —  ${each.description}`, each.folder));
			git.set(each.folder, each.git);
		}
		const chooseValue = '\u0000choose';
		folder.append(new Option(localize('gemini.newAgent.chooseFolder', "Choose folder..."), chooseValue));
		field(localize('gemini.newAgent.folder', "Folder"), folder, 'gemini-new-agent-folder');

		const task = $('textarea', { rows: '4', placeholder: localize('gemini.newAgent.taskPlaceholder', "Optional. What to do with the page; leave it empty to write it in the agent's chat.") }) as HTMLTextAreaElement;
		field(localize('gemini.newAgent.task', "What should it do?"), task, 'gemini-new-agent-task');

		// Branch and model side by side, as in New thread.
		const row = append(dialog, $('.row'));
		const branchField = append(row, $('.field.branch'));
		const ownBranchLabel = append(branchField, $('label.check'));
		const ownBranch = append(ownBranchLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(ownBranchLabel, $('span', undefined, localize('gemini.newAgent.ownBranch', "On its own branch")));
		const branch = append(branchField, $('input', { type: 'text', placeholder: input.branchPlaceholder, spellcheck: 'false', 'aria-label': localize('gemini.newAgent.branch', "Branch") })) as HTMLInputElement;
		const modelField = append(row, $('.field'));
		const modelLabel = append(modelField, $('label', undefined, localize('gemini.newAgent.model', "Model"))) as HTMLLabelElement;
		const model = append(modelField, $('select#gemini-new-agent-model')) as HTMLSelectElement;
		modelLabel.htmlFor = model.id;
		model.append(new Option(localize('gemini.newAgent.defaultModel', "Default"), ''));
		for (const each of input.models) {
			if (each.id !== input.defaultModel) {
				model.append(new Option(each.name, each.id));
			}
		}
		model.disabled = !input.models.length;

		const mode = $('select') as HTMLSelectElement;
		for (const each of input.modes) {
			const option = new Option(each.description ? `${each.name}  —  ${each.description}` : each.name, each.id);
			mode.append(option);
		}
		field(localize('gemini.newAgent.mode', "Mode"), mode, 'gemini-new-agent-mode');

		const hint = append(dialog, $('p.hint'));
		const footer = append(dialog, $('.footer'));
		append(footer, $('span.note', undefined, localize('gemini.newAgent.note', "It can read the page and click and type on it, as you.")));
		const cancel = append(footer, $('button.secondary', { type: 'button' }, localize('gemini.newAgent.cancel', "Cancel")));
		const start = append(footer, $('button.primary', { type: 'button' }, localize('gemini.newAgent.start', "Start agent")));

		const update = () => {
			const inGit = git.get(folder.value) ?? true;
			ownBranchLabel.classList.toggle('disabled', !inGit);
			ownBranch.disabled = !inGit;
			if (!inGit) {
				ownBranch.checked = false;
			}
			branch.disabled = !ownBranch.checked;
			hint.textContent = ownBranch.checked
				? localize('gemini.newAgent.ownBranchHint', "It works on a new branch in a folder of its own. Merge Back brings its work into yours.")
				: inGit ? localize('gemini.newAgent.sameBranchHint', "It edits the folder's files on the branch checked out now.")
					: localize('gemini.newAgent.noGitHint', "The folder isn't in a Git repository, so the agent edits its files directly.");
			start.toggleAttribute('disabled', folder.value === chooseValue);
		};

		let lastFolder = folder.value;
		const finish = (result: NewAgentDialogResult | undefined) => {
			disposables.dispose();
			block.remove();
			open = undefined;
			previousFocus?.focus();
			resolve(result);
		};
		const submit = () => {
			if (folder.value === chooseValue) {
				return;
			}
			finish({
				folder: folder.value,
				ownBranch: ownBranch.checked,
				...(ownBranch.checked && branch.value.trim() ? { branch: branch.value.trim() } : {}),
				...(model.value ? { model: model.value } : {}),
				mode: mode.value || 'default',
				...(task.value.trim() ? { task: task.value.trim() } : {}),
			});
		};

		disposables.add(addDisposableListener(folder, EventType.CHANGE, async () => {
			if (folder.value !== chooseValue) {
				lastFolder = folder.value;
				update();
				return;
			}
			const picked = await chooseFolder();
			if (picked) {
				if (![...folder.options].some(option => option.value === picked)) {
					folder.insertBefore(new Option(picked, picked), folder.options[folder.options.length - 1]);
				}
				folder.value = picked;
				lastFolder = picked;
			} else {
				folder.value = lastFolder;
			}
			update();
		}));
		disposables.add(addDisposableListener(ownBranch, EventType.CHANGE, () => {
			update();
			if (ownBranch.checked) {
				branch.focus();
			}
		}));
		disposables.add(addDisposableListener(close, EventType.CLICK, () => finish(undefined)));
		disposables.add(addDisposableListener(cancel, EventType.CLICK, () => finish(undefined)));
		disposables.add(addDisposableListener(start, EventType.CLICK, submit));
		disposables.add(addDisposableListener(block, EventType.MOUSE_DOWN, e => {
			if (e.target === block) {
				finish(undefined);
			}
		}));
		disposables.add(addDisposableListener(dialog, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				e.preventDefault();
				e.stopPropagation();
				finish(undefined);
			} else if (event.equals(KeyMod.CtrlCmd | KeyCode.Enter) || (event.equals(KeyCode.Enter) && (e.target === branch || e.target === ownBranch))) {
				e.preventDefault();
				submit();
			} else if (event.equals(KeyCode.Tab) || event.equals(KeyMod.Shift | KeyCode.Tab)) {
				// Keep the focus inside the popup.
				const focusable = [close, folder, task, ownBranch, branch, model, mode, cancel, start].filter(each => !(each as HTMLInputElement).disabled);
				const index = focusable.indexOf(container.ownerDocument.activeElement as HTMLElement);
				const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
				e.preventDefault();
				focusable[next]?.focus();
			}
		}));
		update();
		task.focus();
	});
	return open;
}
