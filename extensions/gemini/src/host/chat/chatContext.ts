/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The usage popover's context breakdown (`/context`): what every model call
// in a folder carries, from the context-cost measure (contextCost.ts), and the
// rule files the CLI loaded there, as its `/memory list` names them. The
// measure makes a model call per part, so it runs in the background at most
// once a day per folder, or when the user asks again; every chat in the folder
// and Agent Setup share the result.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { contextBreakdown, type ContextCost, type RuleFile } from '../../acp/contextCost';
import { geminiDir } from '../../acp/directRequest';
import { errorMessage } from '../../acp/errors';
import { disabledServers, isServerEnabled, mcpServersIn, readSettingsFile } from '../../acp/projectSettings';
import type { ViewContextBreakdown } from '../chatProtocol';
import type { ChatContextCost } from './chatOptions';

/** A measure younger than this is shown as it is; an older one is measured again when the popover opens. */
const measureEveryMs = 24 * 60 * 60 * 1000;

export interface ContextMeasureHost {
	/** Measures what every model call carries in `folder` with `servers` (contextCostProbe.ts). */
	measure(folder: string, servers: readonly string[]): Promise<ContextCost>;
	/** The context files the CLI loads in `folder` (its `/memory list`); undefined when it can't say. */
	ruleFiles(folder: string): Promise<readonly string[] | undefined>;
	readonly log: (message: string) => void;
}

export class ContextMeasures implements ChatContextCost, vscode.Disposable {

	private readonly running = new Map<string, Promise<void>>();
	private readonly failures = new Map<string, string>();
	/** Folders whose rule files were listed for a measure made before they were kept. */
	private readonly listed = new Set<string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
	/** Fires with the folder whose breakdown changed. */
	readonly onDidChange = this.onDidChangeEmitter.event;

	/** `state` keeps each folder's last measure. */
	constructor(private readonly state: vscode.Memento, private readonly host: ContextMeasureHost, private readonly now: () => number = Date.now) { }

	view(folder: string): ViewContextBreakdown {
		const cost = this.cached(folder);
		return contextBreakdown(cost, this.running.has(folder), this.failures.get(folder));
	}

	/** The folder's last measure, with each server's part, for Agent Setup. */
	cost(folder: string): ContextCost | undefined {
		return this.cached(folder);
	}

	/** The MCP servers a measure of `folder` covers. */
	servers(folder: string): Promise<string[]> {
		return folderServers(folder);
	}

	measure(folder: string, force: boolean): Promise<void> {
		const cost = this.cached(folder);
		const running = this.running.get(folder);
		if (running) {
			return running;
		}
		if (!force && (this.failures.has(folder) || !vscode.workspace.isTrusted)) {
			// Failed in this window already, or a window in Restricted Mode: measured only on Measure Again.
			return Promise.resolve();
		}
		const fresh = !force && cost && this.now() - cost.measuredAt < measureEveryMs;
		if (fresh && (cost.rules || this.listed.has(folder))) {
			return Promise.resolve();
		}
		// A measure from before rule files were kept: only the rule files, which cost no model call.
		const work = (fresh ? this.listRules(folder, cost) : this.measureNow(folder)).finally(() => {
			this.running.delete(folder);
			this.onDidChangeEmitter.fire(folder);
		});
		this.running.set(folder, work);
		this.failures.delete(folder);
		this.onDidChangeEmitter.fire(folder);
		return work;
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	private cached(folder: string): ContextCost | undefined {
		const cost = this.state.get<ContextCost>(`gemini.contextCost:${folder}`);
		// A measure kept before the readings were (it held parts worked out by subtraction) is measured again.
		return cost?.readings ? cost : undefined;
	}

	private async listRules(folder: string, cost: ContextCost): Promise<void> {
		this.listed.add(folder);
		const files = await this.host.ruleFiles(folder).catch(() => undefined);
		if (files) {
			await this.state.update(`gemini.contextCost:${folder}`, { ...cost, rules: await ruleSizes(files) } satisfies ContextCost);
		}
	}

	private async measureNow(folder: string): Promise<void> {
		try {
			// The rule files are listed by the CLI without a model call; the parts take one each.
			const [cost, rules] = await Promise.all([
				folderServers(folder).then(servers => this.host.measure(folder, servers)),
				this.host.ruleFiles(folder).then(files => files && ruleSizes(files)).catch(() => undefined),
			]);
			await this.state.update(`gemini.contextCost:${folder}`, { ...cost, ...rules ? { rules } : {} } satisfies ContextCost);
		} catch (err) {
			this.failures.set(folder, errorMessage(err));
			this.host.log(`Measuring the context of ${folder} failed: ${errorMessage(err)}`);
		}
	}
}

/** The MCP servers new agents in `folder` get from the CLI's settings: the folder's, then personal ones it doesn't replace, less those switched off. */
async function folderServers(folder: string): Promise<string[]> {
	const dir = geminiDir();
	const [project, personal, disabled] = await Promise.all([
		readSettingsFile(path.join(folder, '.gemini', 'settings.json')),
		readSettingsFile(path.join(dir, 'settings.json')),
		disabledServers(path.join(dir, 'mcp-server-enablement.json')),
	]);
	const names = new Set([...mcpServersIn(project, ''), ...mcpServersIn(personal, '')].map(server => server.name));
	return [...names].filter(name => isServerEnabled(disabled, name));
}

/** Each rule file's size; one that can't be read is left out. */
async function ruleSizes(files: readonly string[]): Promise<RuleFile[]> {
	const sized = await Promise.all(files.map(async file => {
		const stat = await fs.stat(file).catch(() => undefined);
		return stat?.isFile() ? [{ path: file, bytes: stat.size }] : [];
	}));
	return sized.flat();
}
