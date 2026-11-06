/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
// The page in front of a side group can be expanded into upstream's modal
// editor overlay, almost the whole window, from the group's title bar; closing
// the overlay (Escape, its buttons, a click outside) puts the page back in its
// agent's side group rather than closing it.

import { isHTMLElement } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorsOrder, GroupIdentifier, GroupModelChangeKind } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IReadonlyEditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { refreshGeminiTabRows } from '../../../browser/parts/editor/geminiTabRows.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart, IModalEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';

/** The workbench's names for the Gemini extension's webview tabs: agents, Agent Home and its pages. */
const geminiViewTypePrefix = 'mainThreadWebview-gemini.';
const agentViewType = 'mainThreadWebview-gemini.agent';
/**
 * The extension's pages that open beside their agent, in its side group, and
 * so hide and come back with it like its files: a team flow's (Review !706,
 * Log Time), Plan Review, Confluence's Review Page and Debug mode's Evidence.
 */
const sidePageViewTypes: ReadonlySet<string> = new Set(['teamFlow', 'planReview', 'confluenceReview', 'agentFiles', 'debugEvidence'].map(name => `${geminiViewTypePrefix}${name}`));
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

/** True in the scoped context of an agent's side group, whose title bar then offers Expand. */
const sideGroupContext = new RawContextKey<boolean>('geminiAgentSideGroup', false);
/** True while the modal overlay holds a page expanded from an agent's side group. */
const pageExpandedContext = new RawContextKey<boolean>('geminiAgentPageExpanded', false);

/** The hook the fork adds to the modal editor part (modalEditorPart.ts). */
interface GeminiModal {
	geminiOnClose: (() => boolean) | undefined;
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
	/** Each group's `geminiAgentSideGroup` key, bound in its own scoped context. */
	private readonly sideGroupKeys = new Map<GroupIdentifier, IContextKey<boolean>>();
	/** The page in the modal overlay and the agent it goes back to. */
	private expanded: { readonly agent: string; readonly modal: IModalEditorPart } | undefined;
	private readonly pageExpanded: IContextKey<boolean>;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		agentGroups = this;
		this.pageExpanded = pageExpandedContext.bindTo(contextKeyService);
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
				const restored = part.getGroup(group);
				if (!restored) {
					this.groups.delete(id);
				} else if (restored.isEmpty && part.count > 1) {
					// Its pages (Files, Plan Review, ...) are not restored with the window, nor is its
					// agent's tab: kept, the empty group would take Home, which opens in the active
					// group, and leave the agents' group empty beside it. The agent's next file makes
					// a side group again.
					this.groups.delete(id);
					part.removeGroup(restored);
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
				this.sideGroupKeys.delete(group.id);
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
		this.sideGroupKeys.set(group.id, sideGroupContext.bindTo(group.scopedContextKeyService));
		this.updateSideGroupKeys();
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
		if (visibility) {
			this.showStrayGroups(visibility);
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

	/**
	 * Shows any hidden group that no agent claims, such as one whose agent's
	 * record was lost or a layout that came back hidden from a reload: nothing
	 * else would show it, and an editor opened in it would not draw. And when
	 * every group is hidden, which leaves the editor area blank, it shows the
	 * active one.
	 */
	private showStrayGroups(visibility: GroupVisibility): void {
		const claimed = new Set<GroupIdentifier>([...this.groups.values(), ...[...this.trees.values()].map(tree => tree.group)]);
		const all = this.part.getGroups(GroupsOrder.GRID_APPEARANCE);
		for (const group of all) {
			if (!claimed.has(group.id) && !visibility.geminiIsGroupVisible(group.id)) {
				this.logService.warn(`[GeminiAgentGroups] Showing hidden group ${group.id}, which no agent claims.`);
				visibility.geminiSetGroupVisible(group.id, true);
			}
		}
		if (all.length && !all.some(group => visibility.geminiIsGroupVisible(group.id))) {
			this.logService.warn('[GeminiAgentGroups] Every editor group was hidden: showing the active one.');
			visibility.geminiSetGroupVisible(this.part.activeGroup.id, true);
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

	/** Marks the agents' side groups, whose title bars offer Expand. */
	private updateSideGroupKeys(): void {
		const sides = new Set(this.groups.values());
		for (const [group, key] of this.sideGroupKeys) {
			key.set(sides.has(group));
		}
	}

	private save(): void {
		this.updateSideGroupKeys();
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

	/** Whether `group` is an agent's side group or the group of its Files page. */
	claims(group: GroupIdentifier): boolean {
		return [...this.groups.values()].includes(group) || [...this.trees.values()].some(tree => tree.group === group);
	}

	/** Moves the page in front of side group `groupId` into the modal overlay, almost the whole window. */
	async expand(groupId: GroupIdentifier): Promise<void> {
		const agent = [...this.groups].find(([, id]) => id === groupId)?.[0];
		const group = this.part.getGroup(groupId);
		const editor = group?.activeEditor;
		if (agent === undefined || !group || !editor || this.expanded) {
			return;
		}
		const modal = await this.editorGroupsService.createModalEditorPart({ maximized: true });
		// A webview is mounted once, at the end of the window, and drawn over its editor with
		// CSS anchors, which only resolve to an anchor earlier in the document. A page that
		// already exists comes before the overlay, so it would draw as a small box in the
		// corner: the overlay moves ahead of the webviews instead, which cannot move without
		// reloading. Its stacking comes from its z-index, not its place in the document.
		const element = modal.modalElement;
		if (isHTMLElement(element) && element.parentElement && element.parentElement.firstElementChild !== element) {
			element.parentElement.insertBefore(element, element.parentElement.firstElementChild);
		}
		this.expanded = { agent, modal };
		this.pageExpanded.set(true);
		(modal as unknown as GeminiModal).geminiOnClose = () => this.collapse();
		Event.once(modal.onWillClose)(() => {
			(modal as unknown as GeminiModal).geminiOnClose = undefined;
			this.expanded = undefined;
			this.pageExpanded.set(false);
		});
		// A webview moves rather than reloads, so the page keeps what was typed in it.
		group.moveEditor(editor, modal.activeGroup, { activation: EditorActivation.ACTIVATE });
	}

	/**
	 * Puts the expanded page back in its agent's side group, made again if the
	 * page was its last tab, or in the active group when the agent's tab has
	 * closed meanwhile. True when there was a page to put back.
	 */
	collapse(): boolean {
		const page = this.expanded;
		if (!page) {
			return false;
		}
		const { agent, modal } = page;
		(modal as unknown as GeminiModal).geminiOnClose = undefined;
		this.expanded = undefined;
		this.pageExpanded.set(false);
		const column = this.columnFor(agent, false);
		const target = column === undefined ? this.part.activeGroup : this.part.getGroups(GroupsOrder.GRID_APPEARANCE)[column - 1] ?? this.part.activeGroup;
		for (const group of modal.groups) {
			for (const editor of group.editors) {
				group.moveEditor(editor, target, { activation: EditorActivation.ACTIVATE });
			}
		}
		// The modal closes itself once its last tab leaves; this covers it staying open, and closes nothing.
		if (this.editorGroupsService.activeModalEditorPart === modal) {
			void modal.close();
		}
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

registerAction2(class ExpandAgentPageAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gemini.expandAgentPage',
			title: localize2('gemini.expandAgentPage', "Expand"),
			icon: Codicon.screenFull,
			precondition: pageExpandedContext.negate(),
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: -10, when: sideGroupContext },
		});
	}
	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = resolveCommandsContext(args, accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IListService));
		const group = context.groupedEditors[0]?.group ?? accessor.get(IEditorGroupsService).activeGroup;
		await agentGroups?.expand(group.id);
	}
});

registerAction2(class CollapseAgentPageAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gemini.collapseAgentPage',
			title: localize2('gemini.collapseAgentPage', "Back Beside the Chat"),
			icon: Codicon.screenNormal,
			precondition: pageExpandedContext,
			menu: { id: MenuId.ModalEditorTitle, group: 'navigation', order: -10, when: pageExpandedContext },
		});
	}
	run(): void {
		agentGroups?.collapse();
	}
});

/**
 * The 1-based column where a new agent or Agent Home opens: the group holding
 * the agents or, with none, an empty group no agent claims, such as the agents'
 * group after a reload, whose tabs are not restored. Undefined when there is
 * neither, and the extension uses the active group.
 */
CommandsRegistry.registerCommand('_gemini.agentsColumn', accessor => {
	const part = accessor.get(IEditorGroupsService).mainPart;
	const groups = part.getGroups(GroupsOrder.GRID_APPEARANCE);
	const group = agentsGroupOf(part) ?? groups.find(g => g.isEmpty && !agentGroups?.claims(g.id));
	return group ? groups.indexOf(group) + 1 : undefined;
});
