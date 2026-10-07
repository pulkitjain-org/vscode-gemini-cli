/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { Attachment } from '../acp/attachments';
import { BrowserAction, BrowserBackend, BrowserGate, BrowserMcpServer, BrowserToolHost, PageState, sharedPageText } from '../acp/browserMcp';
import { FileAccessPolicyOptions, isInside } from '../acp/fileAccess';
import { configSection } from './configuration';
import { getFileAccessPolicy, isIgnoredByGitCached } from './workspaceFileSystem';

/**
 * The GeminiCode browser for agents: the MCP server each agent session gets
 * (when `gemini.browser.enabled`), driving the Integrated Browser through the
 * workbench's `_gemini.browser.*` commands (contrib/gemini/electron-browser/
 * geminiBrowser.ts). Sites other than local ones ask once per agent and
 * site, unless `gemini.browser.allowOtherSites` (a policy) is off; files
 * follow the agent's file access policy. Turning `gemini.browser.enabled`
 * off stops the server, so running agents lose the tools too.
 *
 * "Let Gemini Use This Page" (a workbench action on pages the user opened)
 * calls `_gemini.browser.handOver` here: the user picks one of the agents
 * open in this window, the page is checked as the agent's own pages are, and
 * the workbench makes it that agent's page; the agent's composer gets a note
 * naming it. Only that user action hands a page over.
 */
export class BrowserTools implements vscode.Disposable {

	private readonly host: BrowserToolHost;
	private readonly server: BrowserMcpServer;
	/** Origins each agent may open, as the user allowed them. */
	private readonly allowed = new Map<string, Set<string>>();
	/** Each agent's folder, when it was given; its `file:` pages must be inside. */
	private readonly folders = new Map<string, string>();
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
		} satisfies BrowserGate);
		this.server = new BrowserMcpServer(this.host, version);
		this.disposables.push(
			vscode.commands.registerCommand('gemini.browser.stop', (agent: unknown) => typeof agent === 'string' && this.agents.stop(agent)),
			vscode.commands.registerCommand('_gemini.browser.handOver', (pageId: unknown, url: unknown, title: unknown) =>
				typeof pageId === 'string' && typeof url === 'string' ? this.handOver(pageId, url, typeof title === 'string' ? title : '') : undefined),
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
			void vscode.window.showErrorMessage(vscode.l10n.t("Gemini can't use this page: {0}.", refused));
			return undefined;
		}
		let shared: { url: string; title: string };
		try {
			shared = await run<{ url: string; title: string }>('_gemini.browser.share', agent.id, pageId);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Gemini can't use this page: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
		// The page may have moved on while the agent was picked.
		const moved = await this.host.handOverRefusal(agent.id, shared.url);
		if (moved) {
			await run('_gemini.browser.release', agent.id, pageId).catch(() => undefined);
			void vscode.window.showErrorMessage(vscode.l10n.t("Gemini can't use this page: {0}.", moved));
			return undefined;
		}
		this.host.adopt(agent.id, pageId, shared.url);
		this.log.info(`Handed a page to agent ${agent.id}`);
		await this.agents.attach(agent.id, [sharedPageNote(shared.title, shared.url)]);
		return agent.id;
	}

	/** Closes an agent's pages, for an agent that was removed; pages the user handed it go back to the user, open. */
	closeAgent(agent: string): void {
		this.host.forget(agent);
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

	/** As for the agent's file reads: its own folder when that is outside the workspace, else the workspace's. */
	private filePolicy(agent: string): FileAccessPolicyOptions {
		const workspace = getFileAccessPolicy();
		const folder = this.folders.get(agent);
		return folder && !workspace.roots.some(root => isInside(root, folder)) ? { roots: [folder], isIgnored: isIgnoredByGitCached } : workspace;
	}

	/** The open agent to hand a page to: the only one, or the one the user picks, most recent first. */
	private async pickAgent(page: string): Promise<{ readonly id: string; readonly title: string } | undefined> {
		const open = this.agents.open();
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
}

function enabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('browser.enabled', true);
}

function otherSites(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('browser.allowOtherSites', true);
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** The note an agent's composer gets with a page the user handed it. */
function sharedPageNote(title: string, url: string): Attachment {
	const note = sharedPageText(title, url);
	return { kind: 'document', name: vscode.l10n.t("Shared page: {0}", note.title), mimeType: 'text/plain', text: note.text };
}

/** The workbench's browser commands, as a backend. */
const commandBackend: BrowserBackend = {
	open: (agent, url) => run<{ pageId: string; summary: string; url: string }>('_gemini.browser.open', agent, url),
	pages: agent => run<string[]>('_gemini.browser.pages', agent),
	snapshot: (agent, pageId) => run<{ summary: string; url: string }>('_gemini.browser.snapshot', agent, pageId),
	act: (agent, pageId, action: BrowserAction, args) => run<PageState>('_gemini.browser.act', agent, pageId, action, args),
	screenshot: (agent, pageId) => run<{ data: string; url: string }>('_gemini.browser.screenshot', agent, pageId),
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
