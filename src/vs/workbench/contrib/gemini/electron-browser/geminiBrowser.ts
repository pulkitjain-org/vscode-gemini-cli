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
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserElementSelectionMode, BrowserViewStorageScope, getAgentBrowserViewCreationDefaults, IBrowserViewRect, IBrowserViewService, IElementData, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IAgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory, BrowserActionGroup, BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, CONTEXT_BROWSER_HAS_URL, IBrowserEditorWidget } from '../../browserView/electron-browser/browserEditor.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
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
	const storageService = accessor.get(IStorageService);
	const input = await browserViews.createBrowserView({ ...getAgentBrowserViewCreationDefaults(session), ...agentPageStorage(accessor), openSource: 'cdpCreated' });
	rememberAgentPage(storageService, input.id);
	await editorService.openEditor(input, { preserveFocus: true, pinned: true }, SIDE_GROUP);
	const model = await input.resolve();
	await raceTimeout(model.loadURL(parsed.href), navigationTimeoutMs);
	const summary = await playwright.waitForPageAndGetSummary(session, input.id, parsed.href, pageReadyTimeoutMs);
	await playwright.invokeFunctionRaw(session, input.id, recordNetwork).catch(() => undefined);
	return { pageId: input.id, summary, url: await playwright.invokeFunctionRaw<string>(session, input.id, currentUrl) };
});

/**
 * Where an agent's new page keeps its cookies and storage. In memory (lost
 * when the agent closes) unless `gemini.browser.keepSignIns` is on; then in
 * the workspace's own browser storage, so the agent stays signed in to, say,
 * a QA site. Only where that storage is the agents' alone: not when the
 * user's own pages keep theirs per workspace too (remote windows, or
 * `workbench.browser.dataStorage` set so), not in an untrusted or empty
 * window, and not under a network policy, which lets agents use only agent
 * storage.
 */
function agentPageStorage(accessor: ServicesAccessor): { session: { scope: BrowserViewStorageScope.Workspace } } | {} {
	const configurationService = accessor.get(IConfigurationService);
	if (configurationService.getValue<boolean>('gemini.browser.keepSignIns') !== true
		|| accessor.get(IWorkspaceContextService).getWorkbenchState() === WorkbenchState.EMPTY
		|| !accessor.get(IWorkspaceTrustManagementService).isWorkspaceTrusted()
		|| accessor.get(IAgentNetworkFilterService).isEnabled()) {
		return {};
	}
	const userStorage = configurationService.getValue<string>('workbench.browser.dataStorage') ?? 'default';
	const userPagesPerWorkspace = userStorage === BrowserViewStorageScope.Workspace || (userStorage === 'default' && !!accessor.get(IWorkbenchEnvironmentService).remoteAuthority);
	return userPagesPerWorkspace ? {} : { session: { scope: BrowserViewStorageScope.Workspace } };
}

/**
 * The pages agents opened themselves, by id, kept for the window's life
 * across reloads: with `keepSignIns` their storage alone no longer tells them
 * from pages the user handed over (see `isHandedOver`).
 */
const agentPagesKey = 'gemini.browser.agentPages';
const maxRememberedPages = 200;

function agentPages(storageService: IStorageService): string[] {
	try {
		const ids = JSON.parse(storageService.get(agentPagesKey, StorageScope.WORKSPACE, '[]'));
		return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function rememberAgentPage(storageService: IStorageService, id: string): void {
	const ids = [...agentPages(storageService).filter(known => known !== id), id].slice(-maxRememberedPages);
	storageService.store(agentPagesKey, JSON.stringify(ids), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/**
 * Starts recording the page's requests for `browser_network`, once per page:
 * the newest 500, with method, URL, resource type, status or failure, and time.
 */
const recordNetwork = `async (page) => {
	if (page.__geminiNetwork) { return; }
	const log = page.__geminiNetwork = [];
	const push = entry => { log.push(entry); if (log.length > 500) { log.splice(0, log.length - 500); } };
	const ms = request => { const t = request.timing(); return t.responseEnd >= 0 ? t.responseEnd : undefined; };
	page.on('requestfinished', async request => {
		const response = await request.response().catch(() => null);
		push({ method: request.method(), url: request.url(), type: request.resourceType(), status: response ? response.status() : undefined, ms: ms(request) });
	});
	page.on('requestfailed', request => push({ method: request.method(), url: request.url(), type: request.resourceType(), failure: request.failure()?.errorText || 'failed', ms: ms(request) }));
}`;

/**
 * Pages the user handed to an agent, by id, with the agent's session. A page
 * is in here from the moment it is being handed over, so a second hand-over
 * of the same page fails: one agent per page.
 */
const handedOver = new Map<string, string>();

/**
 * Whether `model`, an agent's page, is one the user handed over. Pages agents
 * open themselves live in agent storage, or are remembered (`agentPages`) when
 * `keepSignIns` puts them in workspace storage, so a page in other storage
 * was handed over even when `handedOver` forgot it (a window reload).
 */
function isHandedOver(model: IBrowserViewModel, storageService: IStorageService): boolean {
	return handedOver.has(model.id) || (model.storageScope !== BrowserViewStorageScope.Agent && !agentPages(storageService).includes(model.id));
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
		await playwright.invokeFunctionRaw(session, model.id, recordNetwork).catch(() => undefined);
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

/**
 * The page the user handed to the agent, if it still has one: the extension
 * asks after a window reload, when it no longer remembers the hand-over.
 */
CommandsRegistry.registerCommand('_gemini.browser.sharedPage', (accessor, key: string) => {
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const storageService = accessor.get(IStorageService);
	for (const id of pagesOf(browserViews, sessionOf(key))) {
		const model = browserViews.getKnownBrowserViews().get(id)?.model;
		if (model && isHandedOver(model, storageService)) {
			return { pageId: model.id, url: model.url, title: model.title };
		}
	}
	return undefined;
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
	forward: 'async (page) => { await page.goForward(); }',
	reload: 'async (page) => { await page.reload(); }',
	click: 'async (page, target, double, button) => { const l = page.locator(target); const options = { button: button === "right" || button === "middle" ? button : "left" }; if (double) { await l.dblclick(options); } else { await l.click(options); } }',
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

/** The agent's page's console since it last loaded, one message per line, and where the page is. */
CommandsRegistry.registerCommand('_gemini.browser.console', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const model = pagesOf(browserViews, session).includes(pageId) ? browserViews.getKnownBrowserViews().get(pageId)?.model : undefined;
	if (!model) {
		throw new Error('The page was closed.');
	}
	const text = await model.getConsoleLogs();
	return { text, url: await accessor.get(IPlaywrightService).invokeFunctionRaw<string>(session, pageId, currentUrl) };
});

/** The requests the agent's page made since it opened (see `recordNetwork`), and where the page is. */
CommandsRegistry.registerCommand('_gemini.browser.network', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	const playwright = accessor.get(IPlaywrightService);
	// A page open since before this build recorded nothing yet: it starts now.
	await playwright.invokeFunctionRaw(session, pageId, recordNetwork);
	const requests = await playwright.invokeFunctionRaw<unknown[]>(session, pageId, 'async (page) => (page.__geminiNetwork || []).slice()');
	return { requests, url: await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl) };
});

/** Accepts or dismisses the dialog open on the agent's page; resolves with the page's summary afterwards and where it now is. */
CommandsRegistry.registerCommand('_gemini.browser.dialog', async (accessor, key: string, pageId: string, accept: boolean, text?: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	const playwright = accessor.get(IPlaywrightService);
	try {
		const { summary } = await playwright.replyToDialog(session, pageId, accept === true, typeof text === 'string' ? text : undefined);
		return { summary, url: await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl).catch(() => undefined) };
	} catch (err) {
		const summary = await playwright.getSummary(session, pageId).catch(() => '');
		return { summary, error: err instanceof Error ? err.message : String(err), url: await playwright.invokeFunctionRaw<string>(session, pageId, currentUrl).catch(() => undefined) };
	}
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
	const storageService = accessor.get(IStorageService);
	const pages = new Set<string>();
	const released: Promise<void>[] = [];
	for (const id of pagesOf(browserViews, session)) {
		const model = browserViews.getKnownBrowserViews().get(id)?.model;
		if (model && isHandedOver(model, storageService)) {
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
		const commandService = accessor.get(ICommandService);
		const key = model && keyOf(model);
		if (model && key && isHandedOver(model, accessor.get(IStorageService))) {
			await release(views, model, sessionOf(key));
			// The agent's composer drops its Shared page chip.
			commandService.executeCommand('_gemini.browser.released', key, model.id).catch(() => undefined);
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

	constructor(editor: BrowserEditor, @ICommandService private readonly commandService: ICommandService, @IContextKeyService contextKeyService: IContextKeyService, @IStorageService private readonly storageService: IStorageService) {
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
		const handed = !!this.key && isHandedOver(model, this.storageService);
		this.bar.style.display = this.key ? '' : 'none';
		this.releaseButton.style.display = handed ? '' : 'none';
		this.isAgents.set(model.owner.type === 'agent');
		this.isHandedOver.set(handed);
	}
}

BrowserEditor.registerContribution(GeminiAgentPageBar);

// -- Add to Gemini ------------------------------------------------------
//
// What upstream's "Add to Chat" menu does for Copilot's chat (pick an element,
// comment on elements, screenshots, console logs), for Gemini's composer.
// Upstream's actions need Copilot's chat, which GeminiCode turns off, so they
// stay hidden; these reuse the same page overlays (`toggleElementSelection`,
// `toggleAreaSelection`, `setElementComments`) and send what the user picked
// to the extension (`_gemini.browser.addToPrompt`, src/host/browserTools.ts),
// which adds it to the composer of the page's agent, else of the chat in
// front. The editor-scoped `geminiBrowserElementSelection` key tells
// upstream's chat integration a selection is Gemini's, so it leaves it alone.

/** Whether the element selection on the page is Gemini's (upstream's chat integration skips it). */
const geminiSelection = new RawContextKey<boolean>('geminiBrowserElementSelection', false, localize('gemini.browser.elementSelection', "Whether the element selection on the page is for Gemini"));
/** Whether the page has notes for Gemini not yet sent. */
const geminiHasNotes = new RawContextKey<boolean>('geminiBrowserHasNotes', false, localize('gemini.browser.hasNotes', "Whether the page has notes for Gemini not yet sent"));

/** Upstream's setting for a picture of an element sent to chat. */
const attachElementImagesSetting = 'workbench.browser.sendElementsToChat.attachImages';

interface PageNote {
	readonly comment: string;
	readonly element: ReturnType<typeof elementOf>;
}

/** An element as the extension takes it (`PageElement` in src/acp/pageContext.ts). */
function elementOf(data: IElementData) {
	return { outerHTML: data.outerHTML, computedStyle: data.computedStyle, ancestors: data.ancestors, dimensions: data.dimensions };
}

class GeminiPageContext extends BrowserEditorContribution {

	private readonly bar = $('.gemini-browser-bar.gemini-notes-bar');
	private readonly label: HTMLElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly selection: IContextKey<boolean>;
	private readonly hasNotes: IContextKey<boolean>;
	/** Notes left on the page, by the overlay's element id, in the order left. */
	private readonly notes = new Map<string, PageNote>();
	/** The mode a Gemini action is starting, until the page says selection is on. */
	private starting: BrowserElementSelectionMode | undefined;
	/** The mode of the page's current (or last) selection, when it is Gemini's. */
	private ownMode: BrowserElementSelectionMode | undefined;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(editor);
		this.selection = geminiSelection.bindTo(contextKeyService);
		this.hasNotes = geminiHasNotes.bindTo(contextKeyService);
		append(this.bar, $(`span${ThemeIcon.asCSSSelector(Codicon.comment)}`));
		this.label = append(this.bar, $('span.label'));
		this.sendButton = append(this.bar, $('button.stop', { type: 'button' }, localize('gemini.browser.sendNotes', "Send to Gemini")));
		this.sendButton.addEventListener('click', () => void this.sendNotes());
		const discard = append(this.bar, $('button.stop', { type: 'button' }, localize('gemini.browser.discardNotes', "Discard")));
		discard.addEventListener('click', () => this.discardNotes());
		this.render();
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.bar, order: -9 }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(model.onDidChangeElementSelectionState(state => {
			if (state.active) {
				this.ownMode = this.starting;
				this.starting = undefined;
				this.selection.set(this.ownMode !== undefined);
			}
			this.render();
		}));
		store.add(model.onDidSelectElement(data => {
			if (this.ownMode === undefined) {
				return;
			}
			if (data.comment !== undefined && data.elementId) {
				this.notes.set(data.elementId, { comment: data.comment, element: elementOf(data) });
				this.syncNotes(model);
			} else if (this.ownMode === BrowserElementSelectionMode.Select) {
				void this.sendElement(model, data);
			}
		}));
		store.add(model.onDidRemoveElementComment(elementId => {
			this.notes.delete(elementId);
			this.render();
		}));
		// The overlay's notes go with the page they were left on.
		store.add(model.onDidNavigate(() => {
			this.notes.clear();
			this.render();
		}));
	}

	override onModelDetached(): void {
		this.notes.clear();
		this.starting = undefined;
		this.ownMode = undefined;
		this.selection.reset();
		this.render();
	}

	/** Starts (or stops) picking one element for Gemini, or leaving notes on elements. */
	async toggle(mode: BrowserElementSelectionMode): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		this.editor.ensureBrowserFocus();
		const state = model.elementSelectionState;
		if (state.active && this.ownMode === mode) {
			await model.toggleElementSelection(false);
			return;
		}
		this.starting = mode;
		await model.toggleElementSelection(true, mode === BrowserElementSelectionMode.Comment
			? { mode, continuous: true, highlightFocusedElement: true }
			: { mode, continuous: false, highlightFocusedElement: true });
	}

	/** Sends the notes left on the page as one list of changes, then clears them. */
	async sendNotes(): Promise<void> {
		const model = this.editor.model;
		if (!model || !this.notes.size) {
			return;
		}
		const notes = [...this.notes.values()];
		if (await this.send(model, { kind: 'notes', url: model.url, title: model.title, notes })) {
			this.discardNotes();
		}
	}

	discardNotes(): void {
		const model = this.editor.model;
		this.notes.clear();
		if (model) {
			if (model.elementSelectionState.active && this.ownMode === BrowserElementSelectionMode.Comment) {
				void model.toggleElementSelection(false);
			}
			void model.setElementComments({ comments: [] });
		}
		this.render();
	}

	async addScreenshot(area: boolean): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		let rect: IBrowserViewRect | undefined;
		if (area) {
			if (model.isAreaSelectionActive) {
				void model.toggleAreaSelection(false);
				return;
			}
			this.editor.ensureBrowserFocus();
			const picked = Event.toPromise(Event.once(model.onDidPickArea));
			void model.toggleAreaSelection(true);
			rect = await picked;
			if (!rect) {
				return;
			}
		}
		// Taken before anything else changes the page, so it shows what the user saw.
		const shot = await model.captureScreenshot(rect ? { quality: 80, pageRect: rect, awaitNextPaint: true } : { quality: 80 });
		await this.send(model, { kind: 'screenshot', url: model.url, title: model.title, image: encodeBase64(shot), mimeType: 'image/jpeg', area });
	}

	async addConsoleLogs(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		const text = await model.getConsoleLogs();
		if (!text.trim()) {
			this.notificationService.info(localize('gemini.browser.consoleEmpty', "The page's console is empty."));
			return;
		}
		await this.send(model, { kind: 'console', url: model.url, title: model.title, text });
	}

	private async sendElement(model: IBrowserViewModel, data: IElementData): Promise<void> {
		const image = this.configurationService.getValue<boolean>(attachElementImagesSetting) !== false
			? await model.captureScreenshot({ quality: 80, pageRect: data.bounds, awaitNextPaint: true }).catch(() => undefined)
			: undefined;
		await this.send(model, { kind: 'element', url: data.url ?? model.url, title: model.title, element: elementOf(data), ...(image ? { image: encodeBase64(image) } : {}) });
	}

	/** Hands `context` to the extension, for the page's agent or the chat in front. */
	private async send(model: IBrowserViewModel, context: object): Promise<boolean> {
		try {
			return await this.commandService.executeCommand<boolean>('_gemini.browser.addToPrompt', context, keyOf(model)) === true;
		} catch {
			// The Gemini extension is not running (yet).
			this.notificationService.warn(localize('gemini.browser.addNotReady', "Gemini isn't ready yet. Try again in a moment."));
			return false;
		}
	}

	private syncNotes(model: IBrowserViewModel): void {
		void model.setElementComments({ comments: [...this.notes].map(([elementId, note]) => ({ elementId, body: note.comment })) });
		this.render();
	}

	private render(): void {
		const commenting = this.ownMode === BrowserElementSelectionMode.Comment && !!this.editor.model?.elementSelectionState.active;
		const count = this.notes.size;
		this.hasNotes.set(count > 0);
		this.bar.style.display = commenting || count ? '' : 'none';
		this.label.textContent = count === 0
			? localize('gemini.browser.notesHint', "Click an element to leave a note for Gemini")
			: count === 1
				? localize('gemini.browser.oneNote', "1 note for Gemini")
				: localize('gemini.browser.notes', "{0} notes for Gemini", count);
		this.sendButton.disabled = count === 0;
	}
}

BrowserEditor.registerContribution(GeminiPageContext);

/** The "Add to Gemini" menu in a page's toolbar. */
const addToGeminiMenu = new MenuId('GeminiBrowserAddToGemini');
const canAdd = ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL);

function pageContextOf(accessor: ServicesAccessor, editor: unknown): GeminiPageContext | undefined {
	return browserEditorOf(accessor, editor)?.getContribution(GeminiPageContext);
}

class AddElementToGeminiAction extends Action2 {
	static readonly ID = 'gemini.browser.addElement';
	constructor() {
		super({
			id: AddElementToGeminiAction.ID,
			title: localize2('gemini.browser.addElement', "Add Element to Gemini"),
			category: BrowserActionCategory,
			icon: Codicon.inspect,
			f1: true,
			precondition: canAdd,
			toggled: ContextKeyExpr.and(geminiSelection, ContextKeyExpr.equals('browserElementSelectionMode', BrowserElementSelectionMode.Select)),
			menu: { id: addToGeminiMenu, group: '1_element', order: 1 },
			// Upstream's Add Element to Chat keeps these keys while Copilot's chat is on.
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 50, primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC, when: ContextKeyExpr.and(canAdd, ChatContextKeys.enabled.negate()) },
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.toggle(BrowserElementSelectionMode.Select);
	}
}

class LeaveNotesForGeminiAction extends Action2 {
	static readonly ID = 'gemini.browser.leaveNotes';
	constructor() {
		super({
			id: LeaveNotesForGeminiAction.ID,
			title: localize2('gemini.browser.leaveNotes', "Leave Notes for Gemini"),
			category: BrowserActionCategory,
			icon: Codicon.comment,
			f1: true,
			precondition: canAdd,
			toggled: ContextKeyExpr.and(geminiSelection, ContextKeyExpr.equals('browserElementSelectionMode', BrowserElementSelectionMode.Comment)),
			menu: { id: addToGeminiMenu, group: '1_element', order: 2 },
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 50, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC, when: ContextKeyExpr.and(canAdd, ChatContextKeys.enabled.negate()) },
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.toggle(BrowserElementSelectionMode.Comment);
	}
}

class SendNotesToGeminiAction extends Action2 {
	constructor() {
		super({
			id: 'gemini.browser.sendNotes',
			title: localize2('gemini.browser.sendNotesAction', "Send Notes to Gemini"),
			category: BrowserActionCategory,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, geminiHasNotes),
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.sendNotes();
	}
}

class AddScreenshotToGeminiAction extends Action2 {
	constructor() {
		super({
			id: 'gemini.browser.addScreenshot',
			title: localize2('gemini.browser.addScreenshot', "Add Screenshot to Gemini"),
			category: BrowserActionCategory,
			f1: true,
			precondition: canAdd,
			menu: { id: addToGeminiMenu, group: '2_capture', order: 1 },
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.addScreenshot(false);
	}
}

class AddAreaScreenshotToGeminiAction extends Action2 {
	constructor() {
		super({
			id: 'gemini.browser.addAreaScreenshot',
			title: localize2('gemini.browser.addAreaScreenshot', "Add Area Screenshot to Gemini"),
			category: BrowserActionCategory,
			f1: true,
			precondition: canAdd,
			menu: { id: addToGeminiMenu, group: '2_capture', order: 2 },
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.addScreenshot(true);
	}
}

class AddConsoleLogsToGeminiAction extends Action2 {
	constructor() {
		super({
			id: 'gemini.browser.addConsoleLogs',
			title: localize2('gemini.browser.addConsoleLogs', "Add Console Logs to Gemini"),
			category: BrowserActionCategory,
			f1: true,
			precondition: canAdd,
			menu: { id: addToGeminiMenu, group: '3_logs', order: 1 },
		});
	}
	run(accessor: ServicesAccessor, editor?: unknown): Promise<void> | undefined {
		return pageContextOf(accessor, editor)?.addConsoleLogs();
	}
}

registerAction2(AddElementToGeminiAction);
registerAction2(LeaveNotesForGeminiAction);
registerAction2(SendNotesToGeminiAction);
registerAction2(AddScreenshotToGeminiAction);
registerAction2(AddAreaScreenshotToGeminiAction);
registerAction2(AddConsoleLogsToGeminiAction);

// A split button, as upstream's Add to Chat: the left side picks an element or leaves notes, the chevron opens the rest.
MenuRegistry.appendMenuItem(MenuId.BrowserActionsToolbar, {
	submenu: addToGeminiMenu,
	title: localize2('gemini.browser.addToGemini', "Add to Gemini"),
	icon: Codicon.inspect,
	group: BrowserActionGroup.Tools,
	order: 1,
	isSplitButton: {
		togglePrimaryAction: true,
		primaryActionIds: [AddElementToGeminiAction.ID, LeaveNotesForGeminiAction.ID],
	},
});
