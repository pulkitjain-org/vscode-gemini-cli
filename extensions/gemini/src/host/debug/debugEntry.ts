/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's part of the startup bundle, kept to its entry points: the
// `geminicode-debug` route every session lists while the setting is on (with
// no tools until Debug mode starts for its agent, when tools/list_changed
// brings them), the turn note, and the check for a Debug mode that did not
// end. Everything else is dist/debug.js (src/debug.ts), loaded behind the
// commands' stand-ins.

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { McpTool, McpToolResult } from '../../acp/browserMcp';
import { AgentMcpServer } from '../../acp/localMcpServer';
import type { LazyFeature } from '../lazyFeature';

/** What the debug bundle's feature answers for the entry. */
export interface DebugFeatureApi extends vscode.Disposable {
	tools(agent: string): readonly McpTool[];
	call(agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	turnNote(agent: string): string | undefined;
	recover(): Promise<void>;
}

const on = () => vscode.workspace.getConfiguration('gemini').get('debugMode.enabled') === true;

export class DebugEntry implements vscode.Disposable {

	readonly feature: LazyFeature<DebugFeatureApi>;
	/** The route; `notifyToolsChanged` tells an agent's sessions its debug tools changed. */
	readonly server: AgentMcpServer;
	private readonly disposables: vscode.Disposable[];

	constructor(version: string, storage: vscode.Uri, feature: (entry: DebugEntry) => LazyFeature<DebugFeatureApi>) {
		this.server = new AgentMcpServer({
			name: 'geminicode-debug',
			version,
			instructions: '',
			tools: agent => agent && this.loaded?.tools(agent) || [],
			call: (agent, name, args) => this.feature.get().call(agent, name, args),
			notReady: '',
		});
		this.feature = feature(this);
		const start = () => on() && void this.server.start();
		start();
		// A Debug mode that did not end leaves its record: the next start removes its breakpoints and offers its marked lines.
		const timer = setTimeout(() => void vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(storage, 'debug')).then(names => names.length ? this.feature.get().recover() : undefined, () => undefined), 5000);
		this.disposables = [vscode.workspace.onDidChangeConfiguration(start), { dispose: () => clearTimeout(timer) }, this.feature, this.server];
	}

	private get loaded(): DebugFeatureApi | undefined {
		return this.feature.created ? this.feature.get() : undefined;
	}

	/** The route for `agent`'s sessions, or for a spare session no agent has taken yet. */
	servers(agent?: string): acp.McpServer[] {
		const config = on() ? agent ? this.server.configFor(agent) : this.server.configForSlot() : undefined;
		return config ? [config] : [];
	}

	/** Gives `agent` the route of a spare session it took. */
	bindSession(agent: string, servers: readonly acp.McpServer[]): void {
		// Any other server's url is not a slot of this one, and `bind` leaves it.
		servers.forEach(server => this.server.bind(String((server as { readonly url?: unknown }).url), agent));
	}

	turnNote(agent: string): string | undefined {
		return this.loaded?.turnNote(agent);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
