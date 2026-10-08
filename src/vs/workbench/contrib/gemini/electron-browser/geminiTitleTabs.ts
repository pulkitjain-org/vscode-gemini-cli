/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the editor tabs of Agents mode, drawn in the title bar as one
// capsule, as in the Liquid Glass design. They mirror the active editor group
// of the window they are in (the group's own tab row is hidden in Agents mode,
// see geminiModes.ts) and redraw only when that group changes: an editor opens,
// closes, moves, becomes active, is renamed or becomes dirty. An agent's tab
// shows its state through the icon the Gemini extension gives it. Nothing is
// animated, and layout is read only to reveal the active tab when they overflow.

import { $, addDisposableListener, append, clearNode, EventHelper, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../browser/labels.js';
import { EditorResourceAccessor, SideBySideEditor, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** The title bar tab strip: one capsule with a tab per editor of the window's active group. */
export class GeminiTitleTabs extends BaseActionViewItem {

	private readonly groupListener = this._register(new MutableDisposable<DisposableStore>());
	private readonly renderStore = this._register(new DisposableStore());
	private labels: ResourceLabels | undefined;
	private strip: HTMLElement | undefined;
	private part: IEditorPart | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('gemini-title-tabs');
		this.labels = this._register(this.instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		this.strip = append(container, $('.gemini-title-tabs-strip.show-file-icons', { role: 'tablist' }));
		this.strip.setAttribute('aria-label', localize('gemini.titleTabs', "Open Editors"));
		// A mouse wheel scrolls the strip sideways when its tabs do not fit.
		this._register(addDisposableListener(this.strip, EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (this.strip && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
				this.strip.scrollLeft += e.deltaY;
				EventHelper.stop(e);
			}
		}, { passive: false }));
		this.part = this.editorGroupsService.getPart(container);
		this._register(this.part.onDidChangeActiveGroup(() => this.watchGroup()));
		this.watchGroup();
	}

	// The tabs handle their own clicks.
	override onClick(): void { }

	override focus(): void {
		// eslint-disable-next-line no-restricted-syntax
		(this.strip?.querySelector('.gemini-title-tab.active') as HTMLElement | null)?.focus();
	}

	private watchGroup(): void {
		const group = this.part?.activeGroup;
		const store = new DisposableStore();
		if (group) {
			store.add(group.onDidModelChange(() => this.update()));
		}
		this.groupListener.value = store;
		this.update();
	}

	private update(): void {
		const strip = this.strip;
		const labels = this.labels;
		const group = this.part?.activeGroup;
		if (!strip || !group || !labels) {
			return;
		}
		this.renderStore.clear();
		labels.clear();
		clearNode(strip);
		let active: HTMLElement | undefined;
		for (const editor of group.editors) {
			const tab = this.renderTab(strip, labels, group, editor);
			if (group.isActive(editor)) {
				active = tab;
			}
		}
		// Only when the strip overflows does this read layout, and only after an editor change.
		if (active && strip.scrollWidth > strip.clientWidth) {
			active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	private renderTab(strip: HTMLElement, labels: ResourceLabels, group: IEditorGroup, editor: EditorInput): HTMLElement {
		const isActive = group.isActive(editor);
		const isDirty = editor.isDirty() && !editor.isSaving();
		const tab = append(strip, $('.gemini-title-tab', { role: 'tab', tabIndex: isActive ? 0 : -1 }));
		tab.classList.toggle('active', isActive);
		tab.classList.toggle('dirty', isDirty);
		tab.classList.toggle('preview', !group.isPinned(editor));
		tab.setAttribute('aria-selected', String(isActive));

		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.BOTH });
		const description = editor.getDescription();
		// A file's hover is its path; an agent's is its title and line counts.
		const scheme = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY })?.scheme;
		const title = scheme === Schemas.file || scheme === Schemas.vscodeRemote ? editor.getTitle(Verbosity.LONG) : editor.getName();
		const hover = description ? `${title}\n${description}` : title;
		tab.setAttribute('aria-label', description ? `${title}, ${description}` : title);
		const label = labels.create(append(tab, $('.gemini-title-tab-label')), { supportIcons: true, hoverDelegate: getDefaultHoverDelegate('mouse') });
		label.setResource(
			{ name: editor.getName(), resource },
			{ title: hover, extraClasses: editor.getLabelExtraClasses(), italic: !group.isPinned(editor), icon: editor.getIcon() }
		);

		const close = append(tab, $('span.gemini-title-tab-close', { role: 'button' }));
		close.classList.add(...ThemeIcon.asClassNameArray(isDirty ? Codicon.circleFilled : Codicon.close));
		close.setAttribute('aria-label', localize('gemini.titleTabs.close', "Close {0}", editor.getName()));

		this.renderStore.add(addDisposableListener(tab, EventType.MOUSE_DOWN, e => {
			if (e.button === 1) {
				EventHelper.stop(e, true); // no autoscroll on middle-click
			}
		}));
		this.renderStore.add(addDisposableListener(tab, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			if (isHTMLElement(e.target) && close.contains(e.target)) {
				void group.closeEditor(editor);
			} else {
				void this.editorService.openEditor(editor, undefined, group);
			}
		}));
		this.renderStore.add(addDisposableListener(tab, EventType.AUXCLICK, e => {
			if (e.button === 1) {
				EventHelper.stop(e, true);
				void group.closeEditor(editor);
			}
		}));
		this.renderStore.add(addDisposableListener(tab, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				EventHelper.stop(e, true);
				void this.editorService.openEditor(editor, undefined, group);
			}
		}));
		this.renderStore.add(addDisposableListener(tab, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e, true);
			this.contextMenuService.showContextMenu({
				getAnchor: () => tab,
				menuId: MenuId.EditorTitleContext,
				menuActionOptions: { shouldForwardArgs: true, arg: EditorResourceAccessor.getOriginalUri(editor) },
				getActionsContext: () => ({ groupId: group.id, editorIndex: group.getIndexOfEditor(editor) }),
			});
		}));
		return tab;
	}
}
