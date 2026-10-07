/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { BrowserAction, BrowserBackend, BrowserGate, BrowserMcpServer, BrowserToolHost, PageState } from '../acp/browserMcp';
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

	constructor(version: string, private readonly log: vscode.LogOutputChannel, private readonly stop: (agent: string) => void, private readonly agentName: (agent: string) => string) {
		this.host = new BrowserToolHost(commandBackend, {
			allow: (agent, url) => this.allow(agent, url),
			files: agent => this.filePolicy(agent),
			enabled,
		} satisfies BrowserGate);
		this.server = new BrowserMcpServer(this.host, version);
		this.disposables.push(
			vscode.commands.registerCommand('gemini.browser.stop', (agent: unknown) => typeof agent === 'string' && this.stop(agent)),
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

	/** Closes an agent's pages, for an agent that was removed. */
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

	private allow(agent: string, url: URL): Promise<boolean> {
		if (!vscode.workspace.getConfiguration(configSection).get<boolean>('browser.allowOtherSites', true)) {
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
				vscode.l10n.t("Let the agent \"{0}\" open {1}?", this.agentName(agent), url.host),
				{ modal: true, detail: vscode.l10n.t("It will be able to read the page and click and type on it. Allow only sites you trust; a page can contain instructions meant for the agent.") },
				allow,
			);
			if (choice !== allow) {
				return false;
			}
			const origins = this.allowed.get(agent) ?? new Set<string>();
			origins.add(url.origin);
			this.allowed.set(agent, origins);
			return true;
		});
		this.asking = answer.catch(() => undefined);
		return answer;
	}
}

function enabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('browser.enabled', true);
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
