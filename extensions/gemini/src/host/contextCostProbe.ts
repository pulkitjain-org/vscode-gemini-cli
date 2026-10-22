/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { promises as fs } from 'node:fs';
import { AgentConnection } from '../acp/agentConnection';
import { spawnAgent } from '../acp/agentProcess';
import { allowedServersFor, ContextCost, measureContextCost, ProbeVariant } from '../acp/contextCost';
import { readTurnUsage } from '../acp/turnUsage';
import { getAgentCommand, ownServers } from './configuration';

/** A probe that never answers is given up after this long. */
const probeTimeoutMs = 120_000;
const probePrompt = 'Reply with the single word OK and nothing else. Do not call any tools.';

export interface ContextCostOptions {
	/** The folder agents work in. */
	readonly folder: string;
	/** The MCP servers its settings files add, by name. */
	readonly servers: readonly string[];
	/** GeminiCode's own servers, as a new session would get them. */
	readonly geminicodeServers: () => readonly acp.McpServer[];
	/** An empty folder the CLI doesn't trust, so it loads nothing there: the CLI's own prompt alone. */
	readonly emptyFolder: string;
	readonly log: (message: string) => void;
}

/**
 * Measures what every model call carries in `folder` (contextCost.ts): one
 * short prompt per part, on the lightest model the CLI offers, each in a CLI
 * started as GeminiCode starts agents but with only the servers that part needs.
 */
export async function measureFolderContextCost(options: ContextCostOptions): Promise<ContextCost> {
	await fs.mkdir(options.emptyFolder, { recursive: true });
	let model: string | undefined;
	const cost = await measureContextCost(options.servers, async variant => {
		const result = await probeOnce(options, variant);
		model ??= result.model;
		return result.input;
	});
	return { ...cost, ...model ? { model } : {} };
}

async function probeOnce(options: ContextCostOptions, variant: ProbeVariant): Promise<{ input: number; model?: string }> {
	const own = variant.kind === 'all' || variant.kind === 'geminicode';
	const cwd = variant.kind === 'empty' ? options.emptyFolder : options.folder;
	const command = await getAgentCommand({ ownFolderOnly: true, allowedMcpServers: [...allowedServersFor(variant), ...own ? ownServers : []] });
	const child = spawnAgent(command, cwd);
	child.stderr.resume();
	const connection = new AgentConnection(child.stdin, child.stdout, {
		sessionUpdate: () => undefined,
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
	});
	const timer = setTimeout(() => child.kill(), probeTimeoutMs);
	try {
		await connection.initialize();
		const session = await connection.newSession(cwd, own ? options.geminicodeServers() : []);
		const model = lightestModel(session);
		if (model) {
			await connection.setModel(session.sessionId, model).catch(() => undefined);
		}
		const response = await connection.prompt(session.sessionId, [{ type: 'text', text: probePrompt }]);
		const input = (readTurnUsage((response as { _meta?: unknown })._meta) ?? []).reduce((sum, usage) => sum + usage.input, 0);
		if (!input) {
			throw new Error('The Gemini CLI reported no token counts.');
		}
		return { input, model };
	} catch (err) {
		options.log(`Measuring context cost (${variant.kind}${variant.kind === 'server' ? ` ${variant.server}` : ''}) failed: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	} finally {
		clearTimeout(timer);
		connection.dispose();
		child.kill();
	}
}

/** The first Flash-Lite model the CLI offers, else the first Flash: the cheapest call that counts the same context. */
function lightestModel(session: acp.NewSessionResponse): string | undefined {
	const models = (session as { models?: { availableModels?: { modelId: string }[] } }).models?.availableModels ?? [];
	const pick = (pattern: RegExp) => models.find(m => pattern.test(m.modelId))?.modelId;
	return pick(/flash-lite/i) ?? pick(/flash/i);
}
