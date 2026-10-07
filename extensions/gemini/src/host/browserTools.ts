/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { BrowserAction, BrowserBackend, BrowserGate, BrowserMcpServer, BrowserToolHost, PageState } from '../acp/browserMcp';
import { configSection } from './configuration';

/**
 * The GeminiCode browser for agents: the MCP server each agent session gets
 * (when `gemini.browser.enabled`), driving the Integrated Browser through the
 * workbench's `_gemini.browser.*` commands (contrib/gemini/electron-browser/
 * geminiBrowser.ts). Sites other than local ones ask once per agent and
 * site, unless `gemini.browser.allowOtherSites` (a policy) is off.
 */
export class BrowserTools implements vscode.Disposable {

	private readonly host: BrowserToolHost;
	private readonly server: BrowserMcpServer;
	/** Origins each agent may open, as the user allowed them. */
	private readonly allowed = new Map<string, Set<string>>();
	/** One question at a time, so a burst of tool calls does not stack dialogs. */
	private asking: Promise<unknown> = Promise.resolve();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(version: string, private readonly log: vscode.LogOutputChannel, private readonly stop: (agent: string) => void, private readonly agentName: (agent: string) => string) {
		this.host = new BrowserToolHost(commandBackend, { allow: (agent, url) => this.allow(agent, url) } satisfies BrowserGate);
		this.server = new BrowserMcpServer(this.host, version);
		this.disposables.push(
			vscode.commands.registerCommand('gemini.browser.stop', (agent: unknown) => typeof agent === 'string' && this.stop(agent)),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.browser.enabled`) && this.startIfEnabled()),
		);
		this.startIfEnabled();
	}

	/** The `mcpServers` for an agent's session: the browser, when it is on and listening. */
	mcpServersFor(agent: string): acp.McpServer[] {
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
		void vscode.commands.executeCommand('_gemini.browser.close', agent).then(undefined, () => undefined);
	}

	dispose(): void {
		this.server.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private startIfEnabled(): void {
		if (enabled()) {
			this.server.start().then(port => this.log.info(`Browser tools for agents listen on 127.0.0.1:${port}`), err => this.log.error(`Browser tools could not start: ${err}`));
		}
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
	open: (agent, url) => run<{ pageId: string; summary: string }>('_gemini.browser.open', agent, url),
	pages: agent => run<string[]>('_gemini.browser.pages', agent),
	snapshot: (agent, pageId) => run<string>('_gemini.browser.snapshot', agent, pageId),
	act: (agent, pageId, action: BrowserAction, args) => run<PageState>('_gemini.browser.act', agent, pageId, action, args),
	screenshot: (agent, pageId) => run<string>('_gemini.browser.screenshot', agent, pageId),
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
