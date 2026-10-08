/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the two window modes. Agents mode is the agent list on the
// left, the agent's chat in the middle and its Changes on the right, with no
// activity bar; Editor mode is the classic layout. Each mode remembers which
// parts were open, and switching only shows and hides parts, so it is instant.
// Agents mode always shows the Gemini view, and Changes on the right unless the
// user put another view there; opening any other view
// in the side bar switches to Editor mode with that view open.
// The title bar carries the switch right after the window controls. In Agents
// mode the editor tabs move into the title bar as one capsule (geminiTitleTabs.ts)
// and show each agent's state; in Editor mode the editors keep their own tab row
// and the title bar shows a pill for each agent that is working or waiting.
// Agent states come from the Gemini extension through `_gemini.setAgentStatus`.

import './geminiModes.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { GeminiTitleTabs } from './geminiTitleTabs.js';

type Mode = 'agents' | 'editor';

/** Which parts a mode shows. */
interface ModeLayout {
	readonly sideBar: boolean;
	readonly sideBarContainer?: string;
	readonly auxiliaryBar: boolean;
	readonly auxiliaryBarContainer?: string;
	readonly panel: boolean;
}

export interface AgentStatus {
	readonly id: string;
	readonly title: string;
	readonly state: 'working' | 'waiting' | 'done' | 'error';
	/** What it does or wants, such as "Wants to run npm test". */
	readonly detail?: string;
}

const geminiContainer = 'workbench.view.extension.gemini';
/** The Changes panel on the right, contributed by the Gemini extension. */
const changesContainer = 'workbench.view.extension.geminiChanges';
const explorerContainer = 'workbench.view.explorer';
const activityBarLocation = 'workbench.activityBar.location';
/** Agents mode draws the editor tabs in the title bar; see {@link GeminiModes.setMode}. */
const editorShowTabs = 'workbench.editor.showTabs';
/** On the workbench's windows while in Agents mode, for geminiModes.css and geminiGlass.css. */
const agentsModeClass = 'gemini-agents-mode';

const modeKey = 'gemini.mode';
const changesPendingKey = 'gemini.mode.changesPending';
/** Set once the "Switched to Editor mode" hint has been shown. */
const switchHintKey = 'gemini.mode.switchHintShown';
const layoutKey = (mode: Mode) => `gemini.mode.layout.${mode}`;
const defaults: Record<Mode, ModeLayout> = {
	agents: { sideBar: true, sideBarContainer: geminiContainer, auxiliaryBar: true, auxiliaryBarContainer: changesContainer, panel: false },
	editor: { sideBar: true, sideBarContainer: explorerContainer, auxiliaryBar: false, panel: false },
};

export const GeminiModeContext = new RawContextKey<Mode>('gemini.mode', 'editor', localize('geminiMode', "Whether GeminiCode is in Agents or Editor mode"));

/** Shared between the contribution and the title bar widgets it renders. */
class ModeState {
	mode: Mode = 'editor';
	agents: readonly AgentStatus[] = [];
	readonly onDidChange = new Emitter<void>();
	/** The selected agent's branch, shown at the foot of Agents mode's side bar; empty for none. */
	footer = '';
	readonly onDidChangeFooter = new Emitter<void>();
}

const state = new ModeState();
let modes: GeminiModes | undefined;

class GeminiModes extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.geminiModes';

	private readonly context: IContextKey<Mode>;
	/** True while this class opens views itself, so those opens are not taken as the user's. */
	private applying = false;
	/**
	 * A layout wanted Changes on the right before the extension had registered it, as on a first
	 * open in Restricted Mode, where the extension does not run. Kept until Changes shows.
	 */
	private get changesPending(): boolean {
		return this.storageService.getBoolean(changesPendingKey, StorageScope.WORKSPACE, false);
	}

	private set changesPending(pending: boolean) {
		if (pending) {
			this.storageService.store(changesPendingKey, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(changesPendingKey, StorageScope.WORKSPACE);
		}
	}

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@INotificationService private readonly notificationService: INotificationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		modes = this;
		this.context = GeminiModeContext.bindTo(contextKeyService);
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, ModeSwitcherAction.ID, (action, options) =>
			instantiationService.createInstance(ModeSwitcher, action, options)));
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, TitleTabsAction.ID, (action, options) =>
			instantiationService.createInstance(GeminiTitleTabs, action, options)));
		this._register(layoutService.onDidAddContainer(({ container }) => container.classList.toggle(agentsModeClass, state.mode === 'agents')));
		this._register(state.onDidChangeFooter.event(() => this.renderFooter()));
		this._register(toDisposable(() => this.footer?.element.remove()));
		const saved = this.storageService.get(modeKey, StorageScope.WORKSPACE);
		const mode: Mode = saved === 'editor' ? 'editor' : 'agents';
		// The workbench restores the parts as they were left, so only the activity bar needs setting,
		// except the first time, when the parts are still upstream's.
		this.setMode(mode, false);
		if (!saved) {
			this.storageService.store(modeKey, mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			lifecycleService.when(LifecyclePhase.Restored).then(() => this.applyLayout(defaults[mode]));
		}
		lifecycleService.when(LifecyclePhase.Restored).then(() => {
			// A window left with another view in the side bar comes back showing Gemini.
			if (state.mode === 'agents' && this.layoutService.isVisible(Parts.SIDEBAR_PART) && this.sideBarContainer() !== geminiContainer) {
				void this.openFixed(geminiContainer, ViewContainerLocation.Sidebar);
			}
			this.showChanges();
			// The Changes panel comes from the extension, which can register it after the layout is applied.
			this._register(this.viewDescriptorService.onDidChangeViewContainers(({ added }) => {
				if (added.some(({ container }) => container.id === changesContainer)) {
					this.showChanges();
				}
			}));
			this._register(this.paneCompositeService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
				if (state.mode === 'agents' && !this.applying && viewContainerLocation === ViewContainerLocation.Sidebar && composite.getId() !== geminiContainer) {
					void this.showInEditorMode(composite.getId());
				}
			}));
		});
	}

	get mode(): Mode {
		return state.mode;
	}

	/** The side bar's footer, made the first time the extension sends a branch. */
	private footer: { readonly element: HTMLElement; readonly label: HTMLElement } | undefined;

	/**
	 * Agents mode's side bar ends with the selected agent's branch, as a tree view cannot. It sits in
	 * the room the hidden side bar title leaves at the bottom (geminiModes.css), so it needs no layout.
	 */
	private renderFooter(): void {
		if (!this.footer && state.footer) {
			const sideBar = this.layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART);
			if (sideBar) {
				const element = append(sideBar, $('.gemini-agents-footer'));
				append(element, $(ThemeIcon.asCSSSelector(Codicon.gitBranch)));
				this.footer = { element, label: append(element, $('span.gemini-agents-footer-label')) };
			}
		}
		if (this.footer) {
			this.footer.element.classList.toggle('empty', !state.footer);
			this.footer.label.textContent = state.footer;
			this.footer.element.setAttribute('aria-label', localize('gemini.mode.footer', "Branch {0}", state.footer));
		}
	}

	async switchTo(mode: Mode): Promise<void> {
		if (mode === state.mode) {
			return;
		}
		this.storageService.store(layoutKey(state.mode), JSON.stringify(this.currentLayout()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.setMode(mode, true);
		this.storageService.store(modeKey, mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const layout = this.savedLayout(mode);
		// Agents mode remembers only which parts were open; its views are always Gemini and Changes.
		await this.applyLayout(mode === 'agents'
			? { ...layout, sideBar: true, sideBarContainer: geminiContainer, auxiliaryBarContainer: changesContainer }
			: layout);
	}

	/** The user opened another view in Agents mode: carry on in Editor mode with it open. */
	private async showInEditorMode(container: string): Promise<void> {
		// Agents mode is saved as Gemini and Changes, not as the view that pushed Gemini aside.
		this.storageService.store(layoutKey('agents'), JSON.stringify({ ...this.currentLayout(), sideBar: true, sideBarContainer: geminiContainer }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.setMode('editor', true);
		this.storageService.store(modeKey, 'editor', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const layout = this.savedLayout('editor');
		await this.applyLayout({ ...layout, sideBar: true, sideBarContainer: container });
		this.showSwitchHint(container);
	}

	private showSwitchHint(container: string): void {
		if (this.storageService.getBoolean(switchHintKey, StorageScope.APPLICATION, false)) {
			return;
		}
		this.storageService.store(switchHintKey, true, StorageScope.APPLICATION, StorageTarget.USER);
		const name = this.viewDescriptorService.getViewContainerById(container)?.title.value ?? container;
		const keys = this.keybindingService.lookupKeybinding('gemini.mode.toggle')?.getLabel();
		this.notificationService.prompt(Severity.Info,
			keys
				? localize('gemini.mode.switchedKeys', "Switched to Editor mode to show {0}. Agents mode always shows Gemini; press {1} to go back.", name, keys)
				: localize('gemini.mode.switched', "Switched to Editor mode to show {0}. Agents mode always shows Gemini.", name),
			[{ label: localize('gemini.mode.backToAgents', "Back to Agents"), run: () => this.switchTo('agents') }]);
	}

	private sideBarContainer(): string | undefined {
		return this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
	}

	/**
	 * In Agents mode the right side shows Changes when a layout asked for it
	 * before the extension had registered it, or when the side is open with no
	 * view in it. A view the user put there is left alone.
	 */
	private showChanges(): void {
		if (state.mode !== 'agents' || !this.viewDescriptorService.getViewContainerById(changesContainer)) {
			return;
		}
		const empty = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) && !this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		if (this.changesPending || empty) {
			this.changesPending = false;
			this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			void this.openFixed(changesContainer, ViewContainerLocation.AuxiliaryBar);
		}
	}

	private async openFixed(container: string, location: ViewContainerLocation): Promise<void> {
		this.applying = true;
		try {
			await this.paneCompositeService.openPaneComposite(container, location);
		} finally {
			this.applying = false;
		}
	}

	private setMode(mode: Mode, changed: boolean): void {
		state.mode = mode;
		this.context.set(mode);
		// In memory only, so the user's own settings are untouched and come back in Editor mode.
		// Agents mode has no activity bar and draws the editor tabs in the title bar. Its Command Center is
		// hidden by geminiModes.css rather than by `window.commandCenter`, which the title bar cannot change
		// this early in startup; a search button on the right of the title bar opens the same Quick Open.
		const agents = mode === 'agents';
		void this.configurationService.updateValue(activityBarLocation, agents ? 'hidden' : undefined, ConfigurationTarget.MEMORY);
		void this.configurationService.updateValue(editorShowTabs, agents ? 'none' : undefined, ConfigurationTarget.MEMORY);
		for (const container of this.layoutService.containers) {
			container.classList.toggle(agentsModeClass, agents);
		}
		if (changed) {
			state.onDidChange.fire();
			// Agent Home opens when Agents mode starts with no editors; the extension may not have started yet.
			this.commandService.executeCommand('_gemini.modeChanged', mode).catch(() => undefined);
		}
	}

	private currentLayout(): ModeLayout {
		return {
			sideBar: this.layoutService.isVisible(Parts.SIDEBAR_PART),
			sideBarContainer: this.sideBarContainer(),
			auxiliaryBar: this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			auxiliaryBarContainer: this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId(),
			panel: this.layoutService.isVisible(Parts.PANEL_PART),
		};
	}

	private savedLayout(mode: Mode): ModeLayout {
		try {
			const saved = JSON.parse(this.storageService.get(layoutKey(mode), StorageScope.WORKSPACE) ?? 'null');
			if (saved && typeof saved.sideBar === 'boolean' && typeof saved.auxiliaryBar === 'boolean' && typeof saved.panel === 'boolean') {
				return saved;
			}
		} catch {
			// Fall back to the defaults.
		}
		return defaults[mode];
	}

	private async applyLayout(layout: ModeLayout): Promise<void> {
		this.applying = true;
		if (layout.auxiliaryBar && layout.auxiliaryBarContainer === changesContainer && !this.viewDescriptorService.getViewContainerById(changesContainer)) {
			this.changesPending = true;
		}
		try {
			this.layoutService.setPartHidden(!layout.panel, Parts.PANEL_PART);
			this.layoutService.setPartHidden(!layout.auxiliaryBar, Parts.AUXILIARYBAR_PART);
			this.layoutService.setPartHidden(!layout.sideBar, Parts.SIDEBAR_PART);
			await Promise.all([
				layout.sideBar && layout.sideBarContainer ? this.paneCompositeService.openPaneComposite(layout.sideBarContainer, ViewContainerLocation.Sidebar) : undefined,
				layout.auxiliaryBar && layout.auxiliaryBarContainer ? this.paneCompositeService.openPaneComposite(layout.auxiliaryBarContainer, ViewContainerLocation.AuxiliaryBar) : undefined,
			]);
		} finally {
			this.applying = false;
		}
	}
}

registerWorkbenchContribution2(GeminiModes.ID, GeminiModes, WorkbenchPhase.BlockRestore);

/** The mode now, for the extension as it starts. */
CommandsRegistry.registerCommand('_gemini.getMode', () => state.mode);

/** The extension reports the selected agent's branch for the foot of Agents mode's side bar; empty for none. */
CommandsRegistry.registerCommand('_gemini.setAgentFooter', (_accessor, branch: string) => {
	state.footer = typeof branch === 'string' ? branch : '';
	state.onDidChangeFooter.fire();
});

/** The extension reports the agents worth a pill: working, waiting on the user, or done and unread. */
CommandsRegistry.registerCommand('_gemini.setAgentStatus', (_accessor, agents: readonly AgentStatus[]) => {
	state.agents = Array.isArray(agents) ? agents.filter(a => typeof a?.id === 'string' && typeof a.title === 'string') : [];
	state.onDidChange.fire();
});

class SwitchToAgentsMode extends Action2 {
	constructor() {
		super({
			id: 'gemini.mode.agents',
			title: localize2('gemini.mode.agents', "Switch to Agents Mode"),
			category: localize2('gemini', "Gemini"),
			f1: true,
			precondition: GeminiModeContext.notEqualsTo('agents'),
		});
	}
	run(): Promise<void> | undefined {
		return modes?.switchTo('agents');
	}
}

class SwitchToEditorMode extends Action2 {
	constructor() {
		super({
			id: 'gemini.mode.editor',
			title: localize2('gemini.mode.editor', "Switch to Editor Mode"),
			category: localize2('gemini', "Gemini"),
			f1: true,
			precondition: GeminiModeContext.notEqualsTo('editor'),
		});
	}
	run(): Promise<void> | undefined {
		return modes?.switchTo('editor');
	}
}

class ToggleMode extends Action2 {
	constructor() {
		super({
			id: 'gemini.mode.toggle',
			title: localize2('gemini.mode.toggle', "Switch Between Agents and Editor Mode"),
			category: localize2('gemini', "Gemini"),
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyM },
		});
	}
	run(): Promise<void> | undefined {
		return modes?.switchTo(state.mode === 'agents' ? 'editor' : 'agents');
	}
}

/** The title bar entry; {@link ModeSwitcher} draws it. */
class ModeSwitcherAction extends Action2 {
	static readonly ID = 'gemini.mode.switcher';
	constructor() {
		super({
			id: ModeSwitcherAction.ID,
			title: localize2('gemini.mode.switcher', "Agents and Editor Modes"),
			f1: false,
			menu: { id: MenuId.TitleBarAdjacentCenter, order: -2000, when: ContextKeyExpr.true() },
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('gemini.mode.toggle');
	}
}

/** The title bar entry for Agents mode's editor tabs; {@link GeminiTitleTabs} draws it. */
class TitleTabsAction extends Action2 {
	static readonly ID = 'gemini.mode.titleTabs';
	constructor() {
		super({
			id: TitleTabsAction.ID,
			title: localize2('gemini.mode.titleTabs', "Open Editors"),
			f1: false,
			menu: { id: MenuId.TitleBarAdjacentCenter, order: -1999, when: GeminiModeContext.isEqualTo('agents') },
		});
	}
	run(): void { }
}

// Agents mode has no Command Center; this button on the right of the title bar opens the same Quick Open.
// It runs Quick Open's own command, so its tooltip shows Quick Open's shortcut.
MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: { id: 'workbench.action.quickOpen', title: localize2('gemini.mode.search', "Search Files and Commands"), icon: Codicon.search },
	group: TitleBarLeadingActionsGroup,
	order: 1,
	when: GeminiModeContext.isEqualTo('agents'),
});

registerAction2(TitleTabsAction);
registerAction2(SwitchToAgentsMode);
registerAction2(SwitchToEditorMode);
registerAction2(ToggleMode);
registerAction2(ModeSwitcherAction);

/** How many agent pills fit before the rest fold into "+N". */
const maxPills = 3;

/** The title bar's agent pills and the Agents | Editor switch. */
class ModeSwitcher extends BaseActionViewItem {

	private readonly renderStore = this._register(new DisposableStore());
	private pills: HTMLElement | undefined;
	private agentsButton: HTMLElement | undefined;
	private editorButton: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
		this._register(state.onDidChange.event(() => this.update()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('gemini-mode-switcher');
		const toggle = append(container, $('.gemini-mode-toggle'));
		toggle.setAttribute('role', 'radiogroup');
		toggle.setAttribute('aria-label', localize('gemini.mode.label', "Window mode"));
		this.agentsButton = this.modeButton(toggle, 'agents', localize('gemini.mode.agentsLabel', "Agents"));
		this.editorButton = this.modeButton(toggle, 'editor', localize('gemini.mode.editorLabel', "Editor"));
		this.pills = append(container, $('.gemini-agent-pills'));
		this.update();
	}

	// The buttons handle their own clicks.
	override onClick(): void { }

	private modeButton(parent: HTMLElement, mode: Mode, label: string): HTMLElement {
		const button = append(parent, $('button.gemini-mode-button', { type: 'button', role: 'radio' }, label));
		this._register(addDisposableListener(button, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(mode === 'agents' ? 'gemini.mode.agents' : 'gemini.mode.editor');
		}));
		const hover = mode === 'agents' ? localize('gemini.mode.agentsHover', "Agents mode: your agents, their chats and their changes") : localize('gemini.mode.editorHover', "Editor mode: the classic editor layout");
		// Read the shortcut on each hover, so a rebinding shows at once.
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, () => {
			const keys = this.keybindingService.lookupKeybinding('gemini.mode.toggle')?.getLabel();
			return keys ? localize('gemini.mode.hoverKeys', "{0} ({1} switches modes)", hover, keys) : hover;
		}));
		return button;
	}

	private update(): void {
		for (const [button, mode] of [[this.agentsButton, 'agents'], [this.editorButton, 'editor']] as const) {
			button?.classList.toggle('checked', state.mode === mode);
			button?.setAttribute('aria-checked', String(state.mode === mode));
		}
		const pills = this.pills;
		if (!pills) {
			return;
		}
		this.renderStore.clear();
		clearNode(pills);
		// In Agents mode the title bar tabs and the agent list show each agent's state.
		const agents = state.mode === 'agents' ? [] : state.agents;
		const shown = agents.slice(0, maxPills);
		for (const agent of shown) {
			const pill = append(pills, $(`button.gemini-agent-pill.${agent.state}`, { type: 'button' }));
			append(pill, $('span.dot'));
			append(pill, $('span.title', undefined, agent.title));
			const hover = [agent.title, agent.detail ?? stateLabel(agent.state), localize('gemini.mode.openAgent', "Click to open its chat")].join('\n');
			pill.setAttribute('aria-label', hover);
			this.renderStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), pill, hover));
			this.renderStore.add(addDisposableListener(pill, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('gemini.agents.open', agent.id);
			}));
		}
		const rest = agents.length - shown.length;
		if (rest > 0) {
			const more = append(pills, $('button.gemini-agent-pill.more', { type: 'button' }, `+${rest}`));
			const label = localize('gemini.mode.more', "{0} more agents: click to show them all", rest);
			more.setAttribute('aria-label', label);
			this.renderStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), more, label));
			this.renderStore.add(addDisposableListener(more, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('workbench.view.extension.gemini');
			}));
		}
	}
}

function stateLabel(agentState: AgentStatus['state']): string {
	switch (agentState) {
		case 'working': return localize('gemini.agent.working', "Working");
		case 'waiting': return localize('gemini.agent.waiting', "Waiting for you");
		case 'done': return localize('gemini.agent.done', "Done");
		case 'error': return localize('gemini.agent.error', "Needs attention");
	}
}
