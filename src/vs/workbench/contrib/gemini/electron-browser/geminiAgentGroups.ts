/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: each agent keeps its own side group. The files, diffs and
// changes an agent opens go in a group of its own beside the agents' group,
// created the first time it opens something. Only the agent in front has its
// group in view; the others stay open but hidden, so coming back to an agent
// shows its files exactly as left (same tabs, scroll, cursor and diff) with
// nothing reloaded: a switch is one grid visibility change. A group goes when
// the user closes its last file, or when its agent is closed (files with
// unsaved changes stay open). Groups the user made are never touched.
// The Gemini extension asks for an agent's column with `_gemini.agentGroupColumn`
// before it opens something, and closes the group with `_gemini.closeAgentGroup`.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorsOrder, GroupIdentifier, GroupModelChangeKind } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IReadonlyEditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { refreshGeminiTabRows } from '../../../browser/parts/editor/geminiTabRows.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';

/** The workbench's names for the Gemini extension's webview tabs: agents, Agent Home and its pages. */
const geminiViewTypePrefix = 'mainThreadWebview-gemini.';
const agentViewType = 'mainThreadWebview-gemini.agent';
/** Agent tab icons end in #gemini-agent=<id> (the extension's agentsView.ts). */
const agentFragment = 'gemini-agent=';
const groupsKey = 'gemini.agentGroups';

/** The agent an editor is the tab of, if it is one. */
export function agentIdOf(editor: EditorInput | null | undefined): string | undefined {
	if (!(editor instanceof WebviewInput) || editor.viewType !== agentViewType) {
		return undefined;
	}
	const icon = editor.iconPath;
	const fragment = icon && !ThemeIcon.isThemeIcon(icon) ? icon.light.fragment : '';
	return fragment.startsWith(agentFragment) ? fragment.slice(agentFragment.length) : undefined;
}

function isGeminiTab(editor: EditorInput): boolean {
	return editor instanceof WebviewInput && editor.viewType.startsWith(geminiViewTypePrefix);
}

/** Whether a group holds agents (or Agent Home), so its tabs are the title bar's in Agents mode. */
export function holdsAgents(model: IReadonlyEditorGroupModel): boolean {
	return model.getEditors(EditorsOrder.SEQUENTIAL).some(isGeminiTab);
}

/**
 * The group holding the agents in `part`, if any. The title bar is built
 * before the editor part has groups, so `part` may have no active group yet.
 */
export function agentsGroupOf(part: IEditorPart): IEditorGroup | undefined {
	const active: IEditorGroup | undefined = part.activeGroup;
	if (!active) {
		return undefined;
	}
	return active.editors.some(isGeminiTab) ? active : part.getGroups(GroupsOrder.GRID_APPEARANCE).find(group => group.editors.some(isGeminiTab));
}

/** The group visibility calls the fork adds to EditorPart (editorPart.ts). */
interface GroupVisibility {
	geminiSetGroupVisible(group: GroupIdentifier, visible: boolean): void;
	geminiIsGroupVisible(group: GroupIdentifier): boolean;
}

let agentGroups: GeminiAgentGroups | undefined;

class GeminiAgentGroups extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.geminiAgentGroups';

	/** Each agent's side group. Group ids survive a reload with the layout. */
	private readonly groups = new Map<string, GroupIdentifier>();
	/** The agent whose group is in view: the one last in front in the agents' group. */
	private current: string | undefined;
	private restored = false;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		agentGroups = this;
		try {
			const saved: unknown = JSON.parse(storageService.get(groupsKey, StorageScope.WORKSPACE) ?? '{}');
			for (const [id, group] of Object.entries(saved ?? {})) {
				if (typeof group === 'number') {
					this.groups.set(id, group);
				}
			}
		} catch {
			// Start with no groups.
		}
		lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this.restored = true;
			const part = this.part;
			for (const [id, group] of [...this.groups]) {
				if (!part.getGroup(group)) {
					this.groups.delete(id);
				}
			}
			this._register(part.onDidRemoveGroup(group => this.forgetGroup(group.id)));
			this._register(part.onDidChangeActiveGroup(group => this.onDidActivateGroup(group)));
			this._register(part.onDidAddGroup(group => this.watch(group)));
			// Visibility waits while a group is maximized (editorPart.ts); the agent in front may have changed meanwhile.
			this._register(part.onDidChangeGroupMaximized(maximized => !maximized && this.apply()));
			part.groups.forEach(group => this.watch(group));
			this.apply();
			refreshGeminiTabRows();
		});
	}

	private get part(): IEditorPart {
		return this.editorGroupsService.mainPart;
	}

	private watch(group: IEditorGroup): void {
		const listener = group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_ACTIVE) {
				if (agentIdOf(group.activeEditor) !== undefined || group.activeEditor && isGeminiTab(group.activeEditor)) {
					this.apply();
				}
			} else if ((e.kind === GroupModelChangeKind.EDITOR_OPEN || e.kind === GroupModelChangeKind.EDITOR_CLOSE) && e.editor && isGeminiTab(e.editor)) {
				refreshGeminiTabRows();
			}
		});
		const removed = this.part.onDidRemoveGroup(g => {
			if (g === group) {
				listener.dispose();
				removed.dispose();
			}
		});
		this._register(listener);
		this._register(removed);
	}

	/** Shows the group of the agent in front and hides the other agents'. */
	private apply(): void {
		if (!this.restored) {
			return;
		}
		const agentsGroup = agentsGroupOf(this.part);
		const front = agentsGroup?.activeEditor;
		if (front && isGeminiTab(front)) {
			// Agent Home and the extension's pages show no agent's files.
			this.current = agentIdOf(front);
		}
		const part = this.part as unknown as Partial<GroupVisibility>;
		for (const [id, group] of [...this.groups]) {
			if (this.part.getGroup(group)?.editors.some(isGeminiTab)) {
				// An agent or Agent Home opened in this group (it was the active
				// one), so it holds agents now, not one agent's files: hiding it
				// would leave the editor area blank with a stale webview over it.
				this.groups.delete(id);
				this.save();
				part.geminiSetGroupVisible?.(group, true);
				continue;
			}
			part.geminiSetGroupVisible?.(group, id === this.current);
		}
	}

	/** A hidden agent's group became active (Open Editors, a keyboard shortcut): bring its agent to the front. */
	private onDidActivateGroup(group: IEditorGroup): void {
		const agent = [...this.groups].find(([, id]) => id === group.id)?.[0];
		if (agent === undefined || agent === this.current) {
			return;
		}
		const agentsGroup = agentsGroupOf(this.part);
		const tab = agentsGroup?.editors.find(editor => agentIdOf(editor) === agent);
		if (agentsGroup && tab) {
			void agentsGroup.openEditor(tab, { preserveFocus: true, activation: EditorActivation.PRESERVE });
		} else {
			this.current = agent;
			this.apply();
		}
	}

	private forgetGroup(group: GroupIdentifier): void {
		for (const [id, g] of this.groups) {
			if (g === group) {
				this.groups.delete(id);
				this.save();
			}
		}
	}

	private save(): void {
		this.storageService.store(groupsKey, JSON.stringify(Object.fromEntries(this.groups)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** The column of `agent`'s side group, made the first time and made active on `activate`; undefined when the agent has no tab. */
	columnFor(agent: string, activate: boolean): number | undefined {
		if (!this.restored) {
			return undefined;
		}
		const part = this.part;
		let group = this.groups.has(agent) ? part.getGroup(this.groups.get(agent)!) : undefined;
		if (!group) {
			const agentsGroup = part.groups.find(g => g.editors.some(editor => agentIdOf(editor) === agent));
			if (!agentsGroup) {
				return undefined;
			}
			group = part.addGroup(agentsGroup, GroupDirection.RIGHT);
			this.groups.set(agent, group.id);
			this.save();
		}
		if (this.current !== agent) {
			const front = agentsGroupOf(part)?.activeEditor;
			this.current = agentIdOf(front) ?? agent;
		}
		this.apply();
		if (activate) {
			part.activateGroup(group);
		}
		return part.getGroups(GroupsOrder.GRID_APPEARANCE).indexOf(group) + 1;
	}

	/** Closes `agent`'s side group and its files, leaving any with unsaved changes open. */
	async close(agent: string): Promise<void> {
		const id = this.groups.get(agent);
		const group = id === undefined ? undefined : this.part.getGroup(id);
		this.groups.delete(agent);
		this.save();
		if (!group) {
			return;
		}
		await group.closeEditors(group.editors.filter(editor => !editor.isDirty()));
		if (group.isEmpty) {
			if (this.part.getGroup(group.id)) {
				this.part.removeGroup(group);
			}
		} else {
			// Unsaved files stay in view until the user saves or closes them.
			(this.part as unknown as Partial<GroupVisibility>).geminiSetGroupVisible?.(group.id, true);
		}
	}
}

registerWorkbenchContribution2(GeminiAgentGroups.ID, GeminiAgentGroups, WorkbenchPhase.BlockRestore);

/** The 1-based column for the files `agent` opens: its own side group. */
CommandsRegistry.registerCommand('_gemini.agentGroupColumn', (_accessor, agent: unknown, activate: unknown) =>
	typeof agent === 'string' ? agentGroups?.columnFor(agent, activate === true) : undefined);

CommandsRegistry.registerCommand('_gemini.closeAgentGroup', (_accessor, agent: unknown) =>
	typeof agent === 'string' ? agentGroups?.close(agent) : undefined);

/** The 1-based column of the group holding the agents, where a new agent or Agent Home opens; undefined when there is none. */
CommandsRegistry.registerCommand('_gemini.agentsColumn', accessor => {
	const part = accessor.get(IEditorGroupsService).mainPart;
	const group = agentsGroupOf(part);
	return group ? part.getGroups(GroupsOrder.GRID_APPEARANCE).indexOf(group) + 1 : undefined;
});
