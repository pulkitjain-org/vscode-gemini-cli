/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: lets Gemini agents use the Integrated Browser. Upstream's browser
// tools reach only Copilot's chat, so the Gemini extension gets a small set of
// internal commands instead, which its MCP server (extensions/gemini,
// src/host/browserTools.ts) offers to the Gemini CLI. Each agent has its own
// Playwright session and pages it owns; the commands take only fixed actions,
// never code. A bar on an agent's page says Gemini is using it, with Stop.
// "Let Gemini Use This Page" hands a page the user opened to one agent the
// user picks (in the extension): the page joins the agent's Playwright
// session and becomes the agent's, until Stop Sharing or the agent's removal
// gives it back to the user, still open.

import { $, append } from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewStorageScope, getAgentBrowserViewCreationDefaults, IBrowserViewService, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory, BrowserActionGroup, BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, CONTEXT_BROWSER_HAS_URL, IBrowserEditorWidget } from '../../browserView/electron-browser/browserEditor.js';
import './geminiBrowser.css';

/** Agent sessions are `gemini-agent:<key>`; the key is the extension's id for the agent. */
const sessionPrefix = 'gemini-agent:';
const pageReadyTimeoutMs = 8000;
const navigationTimeoutMs = 30000;
const actionTimeoutMs = 30000;
const currentUrl = 'async (page) => page.url()';

function sessionOf(key: unknown): string {
	if (typeof key !== 'string' || !/^[\w-]{1,80}$/.test(key)) {
		throw new Error('Invalid agent key');
	}
	return sessionPrefix + key;
}

function keyOf(model: IBrowserViewModel): string | undefined {
	return model.owner.type === 'agent' && model.owner.sessionId.startsWith(sessionPrefix) ? model.owner.sessionId.slice(sessionPrefix.length) : undefined;
}

/** The pages an agent owns, by id. */
function pagesOf(service: IBrowserViewWorkbenchService, session: string): string[] {
	return [...service.getKnownBrowserViews().values()]
		.filter(input => input.model?.owner.type === 'agent' && input.model.owner.sessionId === session)
		.map(input => input.id);
}

/**
 * Opens `url` in a new page the agent owns, in a tab beside the editor in
 * front (the agent's chat) without taking focus, so the user sees it load.
 * Upstream opens agents' pages in the background unless their chat widget is
 * visible, which a Gemini agent's never is, so the page is opened here. Resolves
 * with where the page ended up, after any redirect. When it throws, the page
 * may still be open, and is the agent's newest.
 */
CommandsRegistry.registerCommand('_gemini.browser.open', async (accessor, key: string, url: string) => {
	const session = sessionOf(key);
	const parsed = typeof url === 'string' ? URL.parse(url) : null;
	if (!parsed || !/^(https?|file):$/.test(parsed.protocol)) {
		throw new Error('Only http, https and file URLs can be opened.');
	}
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const playwright = accessor.get(IPlaywrightService);
	const editorService = accessor.get(IEditorService);
	const input = await browserViews.createBrowserView({ ...getAgentBrowserViewCreationDefaults(session), openSource: 'cdpCreated' });
	await editorService.openEditor(input, { preserveFocus: true, pinned: true }, SIDE_GROUP);
	const model = await input.resolve();
	await raceTimeout(model.loadURL(parsed.href), navigationTimeoutMs);
	const summary = await playwright.waitForPageAndGetSummary(session, input.id, parsed.href, pageReadyTimeoutMs);
	return { pageId: input.id, summary, url: await playwright.invokeFunctionRaw<string>(session, input.id, currentUrl) };
});

/**
 * Pages the user handed to an agent, by id, with the agent's session. A page
 * is in here from the moment it is being handed over, so a second hand-over
 * of the same page fails: one agent per page.
 */
const handedOver = new Map<string, string>();

/**
 * Whether `model`, an agent's page, is one the user handed over. Pages agents
 * open themselves always live in agent storage, so a page in the user's own
 * storage was handed over even when `handedOver` forgot it (a window reload).
 */
function isHandedOver(model: IBrowserViewModel): boolean {
	return handedOver.has(model.id) || model.storageScope !== BrowserViewStorageScope.Agent;
}

function browserViewServiceOf(accessor: ServicesAccessor): IBrowserViewService {
	return ProxyChannel.toService<IBrowserViewService>(accessor.get(IMainProcessService).getChannel(ipcBrowserViewChannelName));
}

/** Gives a handed-over page back to the user: no longer the agent's, and out of its Playwright session. */
async function release(views: IBrowserViewService, model: IBrowserViewModel, session: string): Promise<void> {
	handedOver.delete(model.id);
	await model.setOwner({ type: 'user' });
	await views.setAudience(model.id, { type: 'agent', sessionId: session }, false);
}

/**
 * Hands the user's page `pageId` to the agent, for "Let Gemini Use This
 * Page" once the user picked the agent. The page joins the agent's Playwright
 * session (the main process refuses that for a page outside the network
 * policy) and becomes the agent's, so the other commands act on it and its
 * bar shows. Resolves with where the page is and its title.
 */
CommandsRegistry.registerCommand('_gemini.browser.share', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	const model = typeof pageId === 'string' ? accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(pageId)?.model : undefined;
	const playwright = accessor.get(IPlaywrightService);
	const views = browserViewServiceOf(accessor);
	if (!model) {
		throw new Error('The page was closed.');
	}
	if (model.owner.type !== 'user' || handedOver.has(model.id)) {
		throw new Error('An agent is using the page already.');
	}
	const parsed = URL.parse(model.url);
	if (!parsed || !/^(https?|file):$/.test(parsed.protocol)) {
		throw new Error('Only web pages and files can be shared.');
	}
	handedOver.set(model.id, session);
	try {
		await views.setAudience(model.id, { type: 'agent', sessionId: session }, true);
		await model.setOwner({ type: 'agent', sessionId: session });
		await playwright.waitForPageAndGetSummary(session, model.id, model.url, pageReadyTimeoutMs);
		return { url: await playwright.invokeFunctionRaw<string>(session, model.id, currentUrl), title: model.title };
	} catch (err) {
		await release(views, model, session).catch(() => undefined);
		throw err;
	}
});

/** Gives a page the user handed to the agent back to the user. */
CommandsRegistry.registerCommand('_gemini.browser.release', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	const model = typeof pageId === 'string' ? accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(pageId)?.model : undefined;
	const views = browserViewServiceOf(accessor);
	if (model && handedOver.get(model.id) === session) {
		await release(views, model, session);
	}
});

/** The agent's open pages. */
CommandsRegistry.registerCommand('_gemini.browser.pages', (accessor, key: string) => pagesOf(accessor.get(IBrowserViewWorkbenchService), sessionOf(key)));

/** The page's accessibility snapshot, with the element refs actions take, and where the page is. */
CommandsRegistry.registerCommand('_gemini.browser.snapshot', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	const playwright = accessor.get(IPlaywrightService);
	const summary = await playwright.getSummary(session, pageId);
	// Read after the content, so the extension checks where the content came from.
	return { summary, url: await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl) };
});

/** The fixed actions an agent can take on its page; `target` is an element ref from the snapshot (`aria-ref=e12`) or a CSS selector. */
const actions: Record<string, string> = {
	goto: 'async (page, url) => { await page.goto(url); }',
	back: 'async (page) => { await page.goBack(); }',
	reload: 'async (page) => { await page.reload(); }',
	click: 'async (page, target, double) => { const l = page.locator(target); if (double) { await l.dblclick(); } else { await l.click(); } }',
	hover: 'async (page, target) => { await page.locator(target).hover(); }',
	type: 'async (page, target, text, submit) => { const l = page.locator(target); await l.fill(text); if (submit) { await l.press("Enter"); } }',
	select: 'async (page, target, values) => { await page.locator(target).selectOption(values); }',
	press: 'async (page, key) => { await page.keyboard.press(key); }',
	scroll: 'async (page, dy) => { await page.mouse.wheel(0, dy); }',
	wait: 'async (page, ms) => { await page.waitForTimeout(Math.min(Math.max(ms, 0), 10000)); }',
};

/** Runs action `name` on the agent's page; resolves with the page's summary afterwards and where it now is. */
CommandsRegistry.registerCommand('_gemini.browser.act', async (accessor, key: string, pageId: string, name: string, args: unknown[]) => {
	const session = sessionOf(key);
	const fn = Object.hasOwn(actions, name) ? actions[name] : undefined;
	if (!fn) {
		throw new Error(`Unknown browser action: ${name}`);
	}
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	const playwright = accessor.get(IPlaywrightService);
	const result = await playwright.invokeFunction(session, pageId, fn, Array.isArray(args) ? args : [], actionTimeoutMs);
	const url = await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl).catch(() => undefined);
	return { summary: result.summary, error: result.error, url };
});

/** A JPEG of the visible part of the agent's page, base64-encoded, and where the page is. */
CommandsRegistry.registerCommand('_gemini.browser.screenshot', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	const playwright = accessor.get(IPlaywrightService);
	const data = await playwright.invokeFunctionRaw<string>(session, pageId, 'async (page) => (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64")');
	return { data, url: await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl) };
});

/**
 * Closes the agent's pages and ends its Playwright session, for an agent that
 * was removed. Pages the user handed it go back to the user, still open.
 */
CommandsRegistry.registerCommand('_gemini.browser.close', async (accessor, key: string) => {
	const session = sessionOf(key);
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const playwright = accessor.get(IPlaywrightService);
	const views = browserViewServiceOf(accessor);
	const pages = new Set<string>();
	const released: Promise<void>[] = [];
	for (const id of pagesOf(browserViews, session)) {
		const model = browserViews.getKnownBrowserViews().get(id)?.model;
		if (model && isHandedOver(model)) {
			released.push(release(views, model, session));
		} else {
			pages.add(id);
		}
	}
	const editors = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor instanceof BrowserEditorInput && pages.has(editor.id));
	await Promise.all([...released, editorService.closeEditors(editors)]);
	await playwright.disposeSession(session);
});

/** Whether the page in the browser editor is an agent's (any agent's), so it can't be handed over. */
const pageIsAgents = new RawContextKey<boolean>('geminiBrowserPageIsAgents', false, localize('gemini.browser.pageIsAgents', "Whether an agent is using the page in the browser editor"));
/** Whether the page in the browser editor is one the user handed to a Gemini agent. */
const pageHandedOver = new RawContextKey<boolean>('geminiBrowserPageHandedOver', false, localize('gemini.browser.pageHandedOver', "Whether the page in the browser editor is shared with a Gemini agent"));
const browserEnabled = ContextKeyExpr.equals('config.gemini.browser.enabled', true);

/** The browser editor an action runs on: the one whose toolbar it is in, else the active one. */
function browserEditorOf(accessor: ServicesAccessor, editor: unknown): BrowserEditor | undefined {
	const target = editor ?? accessor.get(IEditorService).activeEditorPane;
	return target instanceof BrowserEditor ? target : undefined;
}

/** "Let Gemini Use This Page": the extension asks which agent, checks the page as the agent's own, and shares it. */
class LetGeminiUsePageAction extends Action2 {
	constructor() {
		super({
			id: 'gemini.browser.sharePage',
			title: localize2('gemini.browser.sharePage', "Let Gemini Use This Page"),
			category: BrowserActionCategory,
			icon: Codicon.sparkle,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, browserEnabled, pageIsAgents.negate()),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 0,
				when: ContextKeyExpr.and(browserEnabled, pageIsAgents.negate()),
			},
		});
	}

	async run(accessor: ServicesAccessor, editor?: unknown): Promise<void> {
		const model = browserEditorOf(accessor, editor)?.model;
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		if (!model || model.owner.type !== 'user' || handedOver.has(model.id)) {
			return;
		}
		try {
			await commandService.executeCommand('_gemini.browser.handOver', model.id, model.url, model.title);
		} catch {
			// The Gemini extension is not running (yet).
			notificationService.warn(localize('gemini.browser.notReady', "Gemini isn't ready to use pages yet. Try again in a moment."));
		}
	}
}

/** "Stop Sharing": gives a page the user handed to an agent back to the user. */
class StopSharingPageAction extends Action2 {
	static readonly ID = 'gemini.browser.stopSharingPage';

	constructor() {
		super({
			id: StopSharingPageAction.ID,
			title: localize2('gemini.browser.stopSharingPage', "Stop Sharing This Page with Gemini"),
			category: BrowserActionCategory,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, pageHandedOver),
		});
	}

	async run(accessor: ServicesAccessor, editor?: unknown): Promise<void> {
		const model = browserEditorOf(accessor, editor)?.model;
		const views = browserViewServiceOf(accessor);
		const key = model && keyOf(model);
		if (model && key && isHandedOver(model)) {
			await release(views, model, sessionOf(key));
		}
	}
}

registerAction2(LetGeminiUsePageAction);
registerAction2(StopSharingPageAction);

/**
 * "Gemini is using this page", with Stop, on pages a Gemini agent owns, and
 * Stop Sharing on those the user handed over. Also sets the editor's context
 * keys that show "Let Gemini Use This Page" only on the user's own pages.
 */
class GeminiAgentPageBar extends BrowserEditorContribution {

	private readonly bar = $('.gemini-browser-bar');
	private readonly releaseButton: HTMLButtonElement;
	private readonly isAgents: IContextKey<boolean>;
	private readonly isHandedOver: IContextKey<boolean>;
	private key: string | undefined;

	constructor(editor: BrowserEditor, @ICommandService private readonly commandService: ICommandService, @IContextKeyService contextKeyService: IContextKeyService) {
		super(editor);
		this.isAgents = pageIsAgents.bindTo(contextKeyService);
		this.isHandedOver = pageHandedOver.bindTo(contextKeyService);
		append(this.bar, $(`span${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
		append(this.bar, $('span.label', undefined, localize('gemini.browser.using', "Gemini is using this page")));
		const stop = append(this.bar, $('button.stop', { type: 'button' }, localize('gemini.browser.stop', "Stop")));
		stop.addEventListener('click', () => this.key && this.commandService.executeCommand('gemini.browser.stop', this.key));
		this.releaseButton = append(this.bar, $('button.stop', { type: 'button' }, localize('gemini.browser.stopSharing', "Stop Sharing")));
		this.releaseButton.addEventListener('click', () => this.commandService.executeCommand(StopSharingPageAction.ID, this.editor));
		this.bar.style.display = 'none';
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.bar, order: -10 }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this.update(model);
		store.add(model.onDidChangeOwner(() => this.update(model)));
	}

	override onModelDetached(): void {
		this.key = undefined;
		this.bar.style.display = 'none';
		this.isAgents.reset();
		this.isHandedOver.reset();
	}

	private update(model: IBrowserViewModel): void {
		this.key = keyOf(model);
		const handed = !!this.key && isHandedOver(model);
		this.bar.style.display = this.key ? '' : 'none';
		this.releaseButton.style.display = handed ? '' : 'none';
		this.isAgents.set(model.owner.type === 'agent');
		this.isHandedOver.set(handed);
	}
}

BrowserEditor.registerContribution(GeminiAgentPageBar);
