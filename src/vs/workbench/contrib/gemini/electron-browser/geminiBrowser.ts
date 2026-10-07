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

import { $, append } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { getAgentBrowserViewCreationDefaults } from '../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../browserView/electron-browser/browserEditor.js';
import './geminiBrowser.css';

/** Agent sessions are `gemini-agent:<key>`; the key is the extension's id for the agent. */
const sessionPrefix = 'gemini-agent:';
const pageReadyTimeoutMs = 8000;
const actionTimeoutMs = 30000;

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

/** Opens `url` in a new page the agent owns, beside the editor in front without taking focus. */
CommandsRegistry.registerCommand('_gemini.browser.open', async (accessor, key: string, url: string) => {
	const session = sessionOf(key);
	const parsed = typeof url === 'string' ? URL.parse(url) : null;
	if (!parsed || !/^(https?|file):$/.test(parsed.protocol)) {
		throw new Error('Only http, https and file URLs can be opened.');
	}
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const playwright = accessor.get(IPlaywrightService);
	const input = await browserViews.createBrowserView({ ...getAgentBrowserViewCreationDefaults(session), initialUrl: parsed.href, openSource: 'cdpCreated' }, { preserveFocus: true });
	const summary = await playwright.waitForPageAndGetSummary(session, input.id, parsed.href, pageReadyTimeoutMs);
	return { pageId: input.id, summary };
});

/** The agent's open pages. */
CommandsRegistry.registerCommand('_gemini.browser.pages', (accessor, key: string) => pagesOf(accessor.get(IBrowserViewWorkbenchService), sessionOf(key)));

/** The page's accessibility snapshot, with the element refs actions take. */
CommandsRegistry.registerCommand('_gemini.browser.snapshot', (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	return accessor.get(IPlaywrightService).getSummary(session, pageId);
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
	const url = await playwright.invokeFunctionRaw<string>(session, pageId, 'async (page) => page.url()').catch(() => undefined);
	return { summary: result.summary, error: result.error, url, pending: !!result.deferredResultId };
});

/** Where the agent's page is now, without reading it. */
CommandsRegistry.registerCommand('_gemini.browser.url', (accessor, key: string, pageId: string) =>
	accessor.get(IPlaywrightService).invokeFunctionRaw<string>(sessionOf(key), pageId, 'async (page) => page.url()'));

/** A JPEG of the visible part of the agent's page, base64-encoded. */
CommandsRegistry.registerCommand('_gemini.browser.screenshot', async (accessor, key: string, pageId: string) => {
	const session = sessionOf(key);
	if (!pagesOf(accessor.get(IBrowserViewWorkbenchService), session).includes(pageId)) {
		throw new Error('The page was closed.');
	}
	return accessor.get(IPlaywrightService).invokeFunctionRaw<string>(session, pageId, 'async (page) => (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64")');
});

/** Closes the agent's pages and ends its Playwright session, for an agent that was removed. */
CommandsRegistry.registerCommand('_gemini.browser.close', async (accessor, key: string) => {
	const session = sessionOf(key);
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const pages = new Set(pagesOf(browserViews, session));
	const editors = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor instanceof BrowserEditorInput && pages.has(editor.id));
	await editorService.closeEditors(editors);
	await accessor.get(IPlaywrightService).disposeSession(session);
});

/** "Gemini is using this page", with Stop, on pages an agent owns. */
class GeminiAgentPageBar extends BrowserEditorContribution {

	private readonly bar = $('.gemini-browser-bar');
	private key: string | undefined;

	constructor(editor: BrowserEditor, @ICommandService private readonly commandService: ICommandService) {
		super(editor);
		append(this.bar, $(`span${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
		append(this.bar, $('span.label', undefined, localize('gemini.browser.using', "Gemini is using this page")));
		const stop = append(this.bar, $('button.stop', { type: 'button' }, localize('gemini.browser.stop', "Stop")));
		stop.addEventListener('click', () => this.key && this.commandService.executeCommand('gemini.browser.stop', this.key));
		this.bar.style.display = 'none';
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.bar, order: -10 }];
	}

	protected override onModelAttached(model: IBrowserViewModel, _store: DisposableStore): void {
		this.key = keyOf(model);
		this.bar.style.display = this.key ? '' : 'none';
	}

	override onModelDetached(): void {
		this.key = undefined;
		this.bar.style.display = 'none';
	}
}

BrowserEditor.registerContribution(GeminiAgentPageBar);
