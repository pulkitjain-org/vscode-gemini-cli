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
// While a file is open from an agent's Files page, the page sits in a narrow
// group of its own right of the side group, its tree beside the file
// (`_gemini.agentFilesBeside`); it hides and comes back with the side group,
// and takes its place, at its width, when the side group's last file closes.

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
/**
 * The extension's pages that open beside their agent, in its side group, and
 * so hide and come back with it like its files: a team flow's (Review !706,
 * Log Time), Plan Review, and Confluence's Review Page.
 */
const sidePageViewTypes: ReadonlySet<string> = new Set(['teamFlow', 'planReview', 'confluenceReview', 'agentFiles'].map(name => `${geminiViewTypePrefix}${name}`));
/** An agent's Files page (the extension's agentFilesPage.ts). */
const filesViewType = `${geminiViewTypePrefix}agentFiles`;
/** The Files page's width beside an open file: its tree alone. */
const treeWidth = 280;
/** Agent tab icons end in #gemini-agent=<id> (the extension's agentsView.ts). */
const agentFragment = 'gemini-agent=';
const groupsKey = 'gemini.agentGroups';
const treesKey = 'gemini.agentTreeGroups';

/** The agent an editor is the tab of, if it is one. */
export function agentIdOf(editor: EditorInput | null | undefined): string | undefined {
	if (!(editor instanceof WebviewInput) || editor.viewType !== agentViewType) {
		return undefined;
	}
	const icon = editor.iconPath;
	const fragment = icon && !ThemeIcon.isThemeIcon(icon) ? icon.light.fragment : '';
	return fragment.startsWith(agentFragment) ? fragment.slice(agentFragment.length) : undefined;
}

function isFilesPage(editor: EditorInput): boolean {
	return editor instanceof WebviewInput && editor.viewType === filesViewType;
}

function isGeminiTab(editor: EditorInput): boolean {
	return editor instanceof WebviewInput && editor.viewType.startsWith(geminiViewTypePrefix);
}

/**
 * A tab that makes its group the agents' group: an agent, Agent Home or one of
 * its pages, but not a page that sits in an agent's side group. Counting one
 * of those would take the side group from its agent and keep it in view.
 */
function isAgentsTab(editor: EditorInput): boolean {
	return editor instanceof WebviewInput && editor.viewType.startsWith(geminiViewTypePrefix) && !sidePageViewTypes.has(editor.viewType);
}

/** Whether a group holds agents (or Agent Home), so its tabs are the title bar's in Agents mode. */
export function holdsAgents(model: IReadonlyEditorGroupModel): boolean {
	return model.getEditors(EditorsOrder.SEQUENTIAL).some(isAgentsTab);
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
	return active.editors.some(isAgentsTab) ? active : part.getGroups(GroupsOrder.GRID_APPEARANCE).find(group => group.editors.some(isAgentsTab));
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
	/** The group holding an agent's Files page beside its side group while a file is open, and the width both had together. */
	private readonly trees = new Map<string, { readonly group: GroupIdentifier; readonly span: number }>();
	/**
	 * The widths of the agents' group and of a hidden agent's Files page, put
	 * back when the agent comes to the front (its side group takes the rest):
	 * the grid hands a hidden group's space to its neighbour, another agent's
	 * side group or the agents' group, which keeps it.
	 */
	private readonly hiddenWidths = new Map<string, { readonly agents: number; readonly tree?: number }>();
	/** The agent whose group is in view: the one last in front in the agents' group. */
	private current: string | undefined;
	private restored = false;
	/** Each group's model listener, until the group goes. */
	private readonly groupListeners = this._register(new DisposableMap<GroupIdentifier>());
	private reportedMissingVisibility = false;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
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
			const trees: unknown = JSON.parse(storageService.get(treesKey, StorageScope.WORKSPACE) ?? '{}');
			for (const [id, tree] of Object.entries(trees ?? {})) {
				const { group, span } = (tree ?? {}) as { group?: unknown; span?: unknown };
				if (typeof group === 'number' && typeof span === 'number') {
					this.trees.set(id, { group, span });
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
			for (const [id, tree] of [...this.trees]) {
				const group = part.getGroup(tree.group);
				if (!group?.editors.some(isFilesPage)) {
					// The Files page is not restored with the window: its group goes, the side group takes the space back.
					this.trees.delete(id);
					if (group?.isEmpty) {
						part.removeGroup(group);
					}
				}
			}
			this.save();
			this._register(part.onDidRemoveGroup(group => {
				this.groupListeners.deleteAndDispose(group.id);
				this.forgetGroup(group.id);
			}));
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
		this.groupListeners.set(group.id, group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_ACTIVE) {
				if (agentIdOf(group.activeEditor) !== undefined || group.activeEditor && isGeminiTab(group.activeEditor)) {
					this.apply();
				}
			} else if (e.kind === GroupModelChangeKind.EDITOR_LABEL && e.editor && e.editor === group.activeEditor) {
				// An agent's tab is known by its icon, which the extension sets just after the tab opens in front.
				const agent = agentIdOf(e.editor);
				if (agent !== undefined && agent !== this.current) {
					this.apply();
				}
			} else if ((e.kind === GroupModelChangeKind.EDITOR_OPEN || e.kind === GroupModelChangeKind.EDITOR_CLOSE) && e.editor && isGeminiTab(e.editor)) {
				refreshGeminiTabRows();
			}
		}));
	}

	/**
	 * The group visibility calls the fork adds to EditorPart, or undefined, logged once, when
	 * they are missing (renamed or lost in an upstream merge): side groups then all stay in view.
	 */
	private get visibility(): GroupVisibility | undefined {
		const part = this.part as unknown as Partial<GroupVisibility>;
		if (typeof part.geminiSetGroupVisible === 'function' && typeof part.geminiIsGroupVisible === 'function') {
			return part as GroupVisibility;
		}
		if (!this.reportedMissingVisibility) {
			this.reportedMissingVisibility = true;
			this.logService.error('[GeminiAgentGroups] EditorPart has no geminiSetGroupVisible or geminiIsGroupVisible (editorPart.ts, GEMINI-FORK): every agent\'s side group stays in view.');
		}
		return undefined;
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
		const visibility = this.visibility;
		const inView = (group: GroupIdentifier | undefined): group is GroupIdentifier => group !== undefined && !!this.part.getGroup(group) && visibility?.geminiIsGroupVisible(group) === true;
		for (const [id, group] of this.groups) {
			if (id !== this.current && agentsGroup && inView(group)) {
				const tree = this.trees.get(id)?.group;
				this.hiddenWidths.set(id, { agents: this.part.getSize(agentsGroup).width, ...inView(tree) ? { tree: this.part.getSize(tree).width } : {} });
			}
		}
		for (const [id, tree] of [...this.trees]) {
			if (this.part.getGroup(tree.group)?.editors.some(isAgentsTab)) {
				this.trees.delete(id);
				this.save();
				visibility?.geminiSetGroupVisible(tree.group, true);
				continue;
			}
			visibility?.geminiSetGroupVisible(tree.group, id === this.current);
		}
		for (const [id, group] of [...this.groups]) {
			if (this.part.getGroup(group)?.editors.some(isAgentsTab)) {
				// An agent or Agent Home opened in this group (it was the active
				// one), so it holds agents now, not one agent's files: hiding it
				// would leave the editor area blank with a stale webview over it.
				this.groups.delete(id);
				this.save();
				visibility?.geminiSetGroupVisible(group, true);
				continue;
			}
			visibility?.geminiSetGroupVisible(group, id === this.current);
		}
		const shown = this.current;
		const widths = shown === undefined ? undefined : this.hiddenWidths.get(shown);
		if (shown !== undefined && widths && agentsGroup && inView(this.groups.get(shown))) {
			this.hiddenWidths.delete(shown);
			this.part.setSize(agentsGroup, { width: widths.agents, height: this.part.getSize(agentsGroup).height });
			const tree = this.trees.get(shown)?.group;
			if (widths.tree !== undefined && inView(tree)) {
				this.part.setSize(tree, { width: widths.tree, height: this.part.getSize(tree).height });
			}
		}
	}

	/** A hidden agent's group became active (Open Editors, a keyboard shortcut): bring its agent to the front. */
	private onDidActivateGroup(group: IEditorGroup): void {
		const agent = [...this.groups].find(([, id]) => id === group.id)?.[0] ?? [...this.trees].find(([, tree]) => tree.group === group.id)?.[0];
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
		for (const [id, tree] of this.trees) {
			if (tree.group === group) {
				// The Files page was closed: the side group takes the space back.
				this.trees.delete(id);
				this.save();
			}
		}
		for (const [id, g] of this.groups) {
			if (g === group) {
				this.groups.delete(id);
				const tree = this.trees.get(id);
				const files = tree && this.part.getGroup(tree.group);
				if (tree && files) {
					// The side group's last file closed: the Files page takes its place, at the width they had together.
					this.trees.delete(id);
					this.groups.set(id, files.id);
					this.part.setSize(files, { width: tree.span, height: this.part.getSize(files).height });
				}
				this.save();
			}
		}
	}

	private save(): void {
		this.storageService.store(groupsKey, JSON.stringify(Object.fromEntries(this.groups)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.storageService.store(treesKey, JSON.stringify(Object.fromEntries(this.trees)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * Moves `agent`'s Files page out of its side group into a narrow group on
	 * the right, so its tree shows beside the file just opened there. True
	 * when the page is beside the side group now; false when the agent has no
	 * Files page in its side group, or nothing else there.
	 */
	filesBeside(agent: string): boolean {
		const part = this.part;
		if (this.trees.has(agent) && part.getGroup(this.trees.get(agent)!.group)) {
			return true;
		}
		const id = this.groups.get(agent);
		const side = id === undefined ? undefined : part.getGroup(id);
		const page = side?.editors.find(isFilesPage);
		if (!side || !page || side.count < 2) {
			return false;
		}
		const span = part.getSize(side).width;
		// The tree comes out of the side group's width: the agent's chat keeps its own.
		const agentsGroup = agentsGroupOf(part);
		const agentsWidth = agentsGroup && part.getSize(agentsGroup).width;
		const tree = part.addGroup(side, GroupDirection.RIGHT);
		side.moveEditor(page, tree, { preserveFocus: true, activation: EditorActivation.PRESERVE });
		if (agentsGroup && agentsWidth) {
			part.setSize(agentsGroup, { width: agentsWidth, height: part.getSize(agentsGroup).height });
		}
		part.setSize(tree, { width: Math.min(treeWidth, Math.floor(span / 2)), height: part.getSize(tree).height });
		this.trees.set(agent, { group: tree.id, span });
		this.save();
		this.apply();
		return true;
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
		const tree = this.trees.get(agent);
		const files = tree && this.part.getGroup(tree.group);
		this.trees.delete(agent);
		if (files) {
			await files.closeAllEditors();
			if (this.part.getGroup(files.id)) {
				this.part.removeGroup(files);
			}
		}
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
			this.visibility?.geminiSetGroupVisible(group.id, true);
		}
	}
}

registerWorkbenchContribution2(GeminiAgentGroups.ID, GeminiAgentGroups, WorkbenchPhase.BlockRestore);

/** The 1-based column for the files `agent` opens: its own side group. */
CommandsRegistry.registerCommand('_gemini.agentGroupColumn', (_accessor, agent: unknown, activate: unknown) =>
	typeof agent === 'string' ? agentGroups?.columnFor(agent, activate === true) : undefined);

CommandsRegistry.registerCommand('_gemini.closeAgentGroup', (_accessor, agent: unknown) =>
	typeof agent === 'string' ? agentGroups?.close(agent) : undefined);

CommandsRegistry.registerCommand('_gemini.agentFilesBeside', (_accessor, agent: unknown) =>
	typeof agent === 'string' ? agentGroups?.filesBeside(agent) ?? false : false);

/** The 1-based column of the group holding the agents, where a new agent or Agent Home opens; undefined when there is none. */
CommandsRegistry.registerCommand('_gemini.agentsColumn', accessor => {
	const part = accessor.get(IEditorGroupsService).mainPart;
	const group = agentsGroupOf(part);
	return group ? part.getGroups(GroupsOrder.GRID_APPEARANCE).indexOf(group) + 1 : undefined;
});
