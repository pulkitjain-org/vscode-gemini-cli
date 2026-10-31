/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { Attachment } from '../acp/attachments';
import { BrowserAction, BrowserBackend, BrowserGate, BrowserMcpServer, BrowserToolHost, NetworkRequest, PageState, sharedPageText } from '../acp/browserMcp';
import { describeDevServer, findDevServers } from '../acp/devServers';
import { FileAccessPolicyOptions } from '../acp/fileAccess';
import { PageContext, pageContextAttachments } from '../acp/pageContext';
import { configSection } from './configuration';
import { agentFileAccessPolicy, getFileAccessPolicy } from './workspaceFileSystem';
import { showError } from './errorNotice';

/**
 * The GeminiCode browser for agents: the MCP server each agent session gets
 * (when `gemini.browser.enabled`), driving the Integrated Browser through the
 * workbench's `_gemini.browser.*` commands (contrib/gemini/electron-browser/
 * geminiBrowser.ts). Sites other than local ones ask once per agent and
 * site, unless `gemini.browser.allowOtherSites` is off; files
 * follow the agent's file access policy. Turning `gemini.browser.enabled`
 * off stops the server, so running agents lose the tools too.
 *
 * "Let Gemini Use This Page" (a workbench action on pages the user opened)
 * calls `_gemini.browser.handOver` here: the user picks one of the agents
 * open in this window, the page is checked as the agent's own pages are, and
 * the workbench makes it that agent's page. The page stays shared until the
 * user stops sharing it (the chip's × in the agent's composer, or Stop
 * Sharing on the page) or closes it: the composer shows it, and every prompt
 * tells the agent about it. Only that user action hands a page over.
 */
export class BrowserTools implements vscode.Disposable {

	private readonly host: BrowserToolHost;
	private readonly server: BrowserMcpServer;
	/** Origins each agent may open, as the user allowed them. */
	private readonly allowed = new Map<string, Set<string>>();
	/** Each agent's folder, when it was given; its `file:` pages must be inside. */
	private readonly folders = new Map<string, string>();
	/** The page the user handed each agent, while it has it. */
	private readonly shared = new Map<string, { readonly pageId: string; readonly url: string; readonly title: string }>();
	/** Agents whose hand-over this window asked the workbench about, after a reload. */
	private readonly lookedUp = new Set<string>();
	/** One question at a time, so a burst of tool calls does not stack dialogs. */
	private asking: Promise<unknown> = Promise.resolve();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(version: string, private readonly log: vscode.LogOutputChannel, private readonly agents: BrowserAgents) {
		this.host = new BrowserToolHost(commandBackend, {
			allow: (agent, url) => this.allow(agent, url),
			files: agent => this.filePolicy(agent),
			enabled,
			otherSites,
			grant: (agent, url) => this.grant(agent, url),
			knows: (agent, url) => this.allowed.get(agent)?.has(url.origin) ?? false,
			model: agent => this.agents.model?.(agent),
			allowedOrigins,
			devServers: async () => (await findDevServers()).map(describeDevServer),
		} satisfies BrowserGate);
		this.server = new BrowserMcpServer(this.host, version);
		this.disposables.push(
			vscode.commands.registerCommand('gemini.browser.stop', (agent: unknown) => typeof agent === 'string' && this.agents.stop(agent)),
			vscode.commands.registerCommand('_gemini.browser.handOver', (pageId: unknown, url: unknown, title: unknown) =>
				typeof pageId === 'string' && typeof url === 'string' ? this.handOver(pageId, url, typeof title === 'string' ? title : '') : undefined),
			vscode.commands.registerCommand('_gemini.browser.released', (agent: unknown, pageId: unknown) => {
				if (typeof agent === 'string' && this.shared.get(agent)?.pageId === pageId) {
					this.shared.delete(agent);
					this.agents.sharedPageChanged?.(agent);
				}
			}),
			vscode.commands.registerCommand('_gemini.browser.addToPrompt', (context: unknown, agent: unknown) =>
				this.addToPrompt(context as PageContext, typeof agent === 'string' ? agent : undefined)),
			// The workbench asks before an agent's page loads a file, or a local page of the agent's reaches another site (geminiAgentFiles.ts in the browser view's main process code).
			vscode.commands.registerCommand('_gemini.browser.loadAllowed', (agent: unknown, url: unknown) =>
				typeof agent === 'string' && typeof url === 'string' && this.host.loadAllowed(agent, url)),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.browser.enabled`) && this.applyEnabled()),
		);
		this.applyEnabled();
	}

	/**
	 * The `mcpServers` for an agent's session: the browser, when it is on and
	 * listening. `folder` is the agent's working folder; without it, files
	 * follow the workspace's policy.
	 */
	mcpServersFor(agent: string, folder?: string): acp.McpServer[] {
		if (folder) {
			this.folders.set(agent, folder);
		}
		if (!enabled()) {
			return [];
		}
		const config = this.server.configFor(agent);
		return config ? [config] : [];
	}

	/** Whether a session opened now gets the browser. */
	get serving(): boolean {
		return enabled() && this.server.listening;
	}

	/** The `mcpServers` for a spare session, which no agent has yet: the browser on a slot of its own. */
	spareServers(): acp.McpServer[] {
		const config = enabled() ? this.server.configForSlot() : undefined;
		return config ? [config] : [];
	}

	/** Gives `agent` the browser slot of a session it took (see `spareServers`); `folder` is its working folder. */
	bindSession(agent: string, folder: string, servers: readonly acp.McpServer[]): void {
		this.folders.set(agent, folder);
		for (const server of servers) {
			const url = (server as { readonly url?: unknown }).url;
			if (typeof url === 'string') {
				this.server.bind(url, agent);
			}
		}
	}

	/**
	 * Hands the user's page `pageId` (at `url`, titled `title`) to an agent
	 * the user picks, for "Let Gemini Use This Page". Tells the user when it
	 * can't; resolves with the agent's id when the agent has the page.
	 */
	async handOver(pageId: string, url: string, title: string): Promise<string | undefined> {
		if (!enabled()) {
			return undefined;
		}
		const agent = await this.pickAgent(title || url);
		if (!agent) {
			return undefined;
		}
		const refused = await this.host.handOverRefusal(agent.id, url);
		if (refused) {
			void showError(vscode.l10n.t("Gemini can't use this page: {0}.", refused));
			return undefined;
		}
		let shared: { url: string; title: string };
		try {
			shared = await run<{ url: string; title: string }>('_gemini.browser.share', agent.id, pageId);
		} catch (err) {
			void showError(vscode.l10n.t("Gemini can't use this page: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
		// The page may have moved on while the agent was picked.
		const moved = await this.host.handOverRefusal(agent.id, shared.url);
		if (moved) {
			await run('_gemini.browser.release', agent.id, pageId).catch(() => undefined);
			void showError(vscode.l10n.t("Gemini can't use this page: {0}.", moved));
			return undefined;
		}
		this.host.adopt(agent.id, pageId, shared.url);
		this.shared.set(agent.id, { pageId, url: shared.url, title: shared.title });
		this.log.info(`Handed a page to agent ${agent.id}`);
		// Every prompt from now on tells the agent about the page (see sharedPage), so a task goes as it is.
		if (agent.task && this.agents.send) {
			this.agents.send(agent.id, agent.task, []);
		} else {
			await this.agents.showSharedPage(agent.id);
		}
		return agent.id;
	}

	/**
	 * The page shared with `agent`, while it still is, with the note each
	 * prompt carries about it. After a window reload the workbench still knows
	 * the page, so it is picked up again rather than lost.
	 */
	async sharedPage(agent: string): Promise<{ readonly title: string; readonly url: string; readonly note: string } | undefined> {
		if (!enabled()) {
			return undefined;
		}
		let page = this.shared.get(agent);
		if (page && !(await commandBackend.pages(agent).catch((): readonly string[] => [])).includes(page.pageId)) {
			// Closed, or given back from the page.
			this.shared.delete(agent);
			page = undefined;
		}
		if (!page && !this.lookedUp.has(agent)) {
			// Once per agent: only a window reload makes this window forget a hand-over.
			this.lookedUp.add(agent);
			const found = await run<{ pageId: string; url: string; title: string } | undefined>('_gemini.browser.sharedPage', agent).catch(() => undefined);
			if (!found || typeof found.pageId !== 'string' || await this.host.handOverRefusal(agent, found.url)) {
				return undefined;
			}
			this.host.adopt(agent, found.pageId, found.url);
			this.shared.set(agent, found);
			page = found;
		}
		if (!page) {
			return undefined;
		}
		const text = sharedPageText(page.title, page.url);
		return { title: text.title, url: page.url, note: text.text };
	}

	/** Brings the tab of the page shared with `agent` to the front: a click on its chip. False when none is shared. */
	async revealSharedPage(agent: string): Promise<boolean> {
		await this.sharedPage(agent);
		const page = this.shared.get(agent);
		return !!page && await run<boolean>('_gemini.browser.reveal', agent, page.pageId).catch(() => false) === true;
	}

	/**
	 * Brings `agent`'s page to the front, for its chat's Browser link: the
	 * page shared with it, else the newest it opened. False when it has none.
	 */
	async revealAgentPage(agent: string): Promise<boolean> {
		if (await this.revealSharedPage(agent)) {
			return true;
		}
		const pages = await run<string[]>('_gemini.browser.pages', agent).catch(() => []);
		const newest = pages.at(-1);
		return !!newest && await run<boolean>('_gemini.browser.reveal', agent, newest).catch(() => false) === true;
	}

	/** Gives the page shared with `agent` back to the user, still open: the × on its chip. */
	async stopSharing(agent: string): Promise<void> {
		const page = this.shared.get(agent);
		this.shared.delete(agent);
		if (page) {
			await run('_gemini.browser.release', agent, page.pageId).catch(err => this.log.warn(`Could not stop sharing a page: ${err}`));
		}
	}

	/**
	 * Adds what the user took from a page ("Add to Gemini": an element, notes,
	 * a screenshot or the console) to a Gemini composer: the agent's whose
	 * page it is, else the chat in front. Resolves with whether it was added.
	 */
	async addToPrompt(context: PageContext, agent: string | undefined): Promise<boolean> {
		const attachments = pageContextAttachments(context);
		if (!attachments?.length) {
			return false;
		}
		if (agent && this.agents.open().some(open => open.id === agent)) {
			await this.agents.attach(agent, attachments);
		} else {
			await this.agents.attachToFront(attachments);
		}
		return true;
	}

	/** Closes an agent's pages, for an agent that was removed; pages the user handed it go back to the user, open. */
	closeAgent(agent: string): void {
		this.host.forget(agent);
		this.shared.delete(agent);
		this.server.unbind(agent);
		this.allowed.delete(agent);
		this.folders.delete(agent);
		void vscode.commands.executeCommand('_gemini.browser.close', agent).then(undefined, () => undefined);
	}

	dispose(): void {
		this.server.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private applyEnabled(): void {
		if (enabled()) {
			this.server.start().then(port => this.log.info(`Browser tools for agents listen on 127.0.0.1:${port}`), err => this.log.error(`Browser tools could not start: ${err}`));
		} else {
			this.server.dispose();
		}
	}

	/** As for the agent's file reads: its own folder, and the window's others only when the setting shares them; the whole window for an agent whose folder is not known. */
	private filePolicy(agent: string): FileAccessPolicyOptions {
		const folder = this.folders.get(agent);
		return folder ? agentFileAccessPolicy(folder) : getFileAccessPolicy();
	}

	/** The agent to hand a page to: one the user picks from the open agents, most recent first, or a new one. */
	private async pickAgent(page: string): Promise<{ readonly id: string; readonly title: string; readonly task?: string } | undefined> {
		const open = this.agents.open();
		const newAgent = this.agents.newAgent;
		if (newAgent) {
			// Always the list first: the running agents, the ones used lately, and New Agent... for the popup.
			const recent = this.agents.recent?.().filter(agent => !open.some(each => each.id === agent.id)) ?? [];
			type Item = vscode.QuickPickItem & { readonly agent?: { readonly id: string; readonly title: string }; readonly asleep?: boolean };
			const fresh: Item = { label: `$(add) ${vscode.l10n.t("New Agent...")}`, description: vscode.l10n.t("Pick its folder, branch, model and mode") };
			const items: Item[] = [fresh];
			if (open.length) {
				items.push({ label: vscode.l10n.t("Running"), kind: vscode.QuickPickItemKind.Separator }, ...open.map(agent => ({ label: agent.title, agent })));
			}
			if (recent.length) {
				items.push({ label: vscode.l10n.t("Recent"), kind: vscode.QuickPickItemKind.Separator }, ...recent.map(agent => ({ label: agent.title, description: agent.detail, agent, asleep: true })));
			}
			const picked = await vscode.window.showQuickPick(items, {
				title: vscode.l10n.t("Let Gemini Use {0}", truncate(page, 60)),
				placeHolder: vscode.l10n.t("Choose the agent, or start a new one. It can read the page and click and type on it, as you."),
			});
			if (picked === fresh) {
				return newAgent(page);
			}
			if (picked?.agent && picked.asleep) {
				// It starts before it gets the page, as when opened from the agent list.
				await this.agents.wake?.(picked.agent.id);
			}
			return picked?.agent;
		}
		if (!open.length) {
			const show = vscode.l10n.t("Show Agents");
			const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first, then let it use this page."), show);
			if (choice === show) {
				void vscode.commands.executeCommand('gemini.agents.focus');
			}
			return undefined;
		}
		if (open.length === 1) {
			return open[0];
		}
		const picked = await vscode.window.showQuickPick(open.map(agent => ({ label: agent.title, agent })), {
			title: vscode.l10n.t("Let Gemini Use {0}", truncate(page, 60)),
			placeHolder: vscode.l10n.t("Choose the agent. It can read the page and click and type on it, as you."),
		});
		return picked?.agent;
	}

	private grant(agent: string, url: URL): void {
		const origins = this.allowed.get(agent) ?? new Set<string>();
		origins.add(url.origin);
		this.allowed.set(agent, origins);
	}

	private allow(agent: string, url: URL): Promise<boolean> {
		if (!otherSites()) {
			return Promise.resolve(false);
		}
		if (this.allowed.get(agent)?.has(url.origin)) {
			return Promise.resolve(true);
		}
		const answer = this.asking.then(async () => {
			if (this.allowed.get(agent)?.has(url.origin)) {
				return true;
			}
			const allow = vscode.l10n.t("Allow");
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t("Let the agent \"{0}\" open {1}?", this.agents.title(agent), url.host),
				{ modal: true, detail: vscode.l10n.t("It will be able to read the page and click and type on it. Allow only sites you trust; a page can contain instructions meant for the agent.") },
				allow,
			);
			if (choice !== allow) {
				return false;
			}
			this.grant(agent, url);
			return true;
		});
		this.asking = answer.catch(() => undefined);
		return answer;
	}
}

/** What the browser needs from the agents in this window. */
export interface BrowserAgents {
	/** Stops the agent's turn (the page bar's Stop). */
	stop(agent: string): void;
	/** The agent's name, for questions about it. */
	title(agent: string): string;
	/** The agents running in this window, most recent first. */
	open(): readonly { readonly id: string; readonly title: string }[];
	/** Shows the agent's chat and adds `attachments` to its composer. */
	attach(agent: string, attachments: readonly Attachment[]): Promise<void>;
	/** Shows the agent's chat, whose composer then shows the page it was handed (see `sharedPage`). */
	showSharedPage(agent: string): Promise<void>;
	/** The page shared with the agent changed outside its chat, such as Stop Sharing on the page. */
	sharedPageChanged?(agent: string): void;
	/** Adds `attachments` to the composer of the chat in front: the agent shown, else the Gemini chat. */
	attachToFront(attachments: readonly Attachment[]): Promise<void>;
	/** The model the agent's session is on, when known. */
	model?(agent: string): string | undefined;
	/** Asks in one popup where, on which model and in which mode, then starts a new agent with its tab open; undefined when cancelled. `task` is what the user asked it to do, if anything. */
	newAgent?(page: string): Promise<{ readonly id: string; readonly title: string; readonly task?: string } | undefined>;
	/** Agents used lately that aren't running in this window, most recent first, with where each works. */
	recent?(): readonly { readonly id: string; readonly title: string; readonly detail?: string }[];
	/** Starts an agent from `recent`, with its tab open. */
	wake?(agent: string): Promise<void>;
	/** Sends the agent a prompt with `attachments`, as if typed in its chat. */
	send?(agent: string, text: string, attachments: readonly Attachment[]): void;
}

function enabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('browser.enabled', true);
}

function otherSites(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('browser.allowOtherSites', true);
}

function allowedOrigins(): readonly string[] {
	const origins = vscode.workspace.getConfiguration(configSection).get<unknown>('browser.allowedOrigins', []);
	return Array.isArray(origins) ? origins.filter((o): o is string => typeof o === 'string' && !!o.trim()) : [];
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** The workbench's browser commands, as a backend. */
const commandBackend: BrowserBackend = {
	open: (agent, url) => run<{ pageId: string; summary: string; url: string }>('_gemini.browser.open', agent, url),
	pages: agent => run<string[]>('_gemini.browser.pages', agent),
	snapshot: (agent, pageId) => run<{ summary: string; url: string }>('_gemini.browser.snapshot', agent, pageId),
	act: (agent, pageId, action: BrowserAction, args) => run<PageState>('_gemini.browser.act', agent, pageId, action, args),
	screenshot: (agent, pageId) => run<{ data: string; url: string }>('_gemini.browser.screenshot', agent, pageId),
	console: (agent, pageId) => run<{ text: string; url: string }>('_gemini.browser.console', agent, pageId),
	network: (agent, pageId) => run<{ requests: NetworkRequest[]; url: string }>('_gemini.browser.network', agent, pageId),
	dialog: (agent, pageId, accept, text) => run<PageState>('_gemini.browser.dialog', agent, pageId, accept, text),
	reveal: (agent, pageId) => run<boolean>('_gemini.browser.reveal', agent, pageId, true),
};

async function run<T>(command: string, ...args: unknown[]): Promise<T> {
	try {
		return await vscode.commands.executeCommand<T>(command, ...args);
	} catch (err) {
		if (err instanceof Error && /command .* not found/i.test(err.message)) {
			throw new Error('The GeminiCode browser is not available in this build.');
		}
		throw err;
	}
}
