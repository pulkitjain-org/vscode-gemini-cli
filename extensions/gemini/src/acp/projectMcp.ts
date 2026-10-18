/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The `geminicode-project` MCP server: the tools a project's coordinator uses
// to start and steer threads, and the one a thread uses to report back. The
// same shape as the browser's server (browserMcp.ts): Streamable HTTP with
// plain JSON replies on 127.0.0.1, one URL and HMAC token per caller, so a
// thread's token can't act as the coordinator. Nothing runs until a project
// opens, and every call is answered from memory.

import type { McpTool, McpToolResult } from './browserMcp';
import { LocalMcpServer, type McpHttpConfig } from './localMcpServer';

/** Who is calling: a project's coordinator, or one of its threads. */
export type ProjectCaller = { readonly role: 'coordinator'; readonly project: string } | { readonly role: 'thread'; readonly project: string; readonly thread: string };

export interface ProjectToolHost {
	call(caller: ProjectCaller, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	/** Whether a thread works in several repositories, which gives it add_repo. */
	multiRepo?(caller: ProjectCaller): boolean;
}

/** The server's name in a session's MCP servers. */
export const projectServerName = 'geminicode-project';

const text = { type: 'string' } as const;

export const coordinatorTools: readonly McpTool[] = [
	{
		name: 'start_thread',
		description: 'Starts a thread: a new agent on its own branch and worktree that does one piece of work. Returns at once with the thread id, and the thread starts work right away. Write the brief as the whole task: what to do, the files involved, and how to check it.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { ...text, description: 'A few words naming the work, as the user would.' },
				brief: { ...text, description: 'Everything the thread needs, in plain language.' },
				planFirst: { type: 'boolean', description: 'Write a plan and wait for the user\'s OK before changing anything. Only when the user asked for it.' },
				track: { ...text, description: 'A Conductor track id to take the brief from (its spec.md and plan.md).' },
				repos: { type: 'array', items: text, description: 'In a project with several repositories: the ones the thread works in, by name, as <repositories> lists them. Ignored in a project with one.' },
			},
			required: ['title', 'brief'],
		},
	},
	{
		name: 'message_thread',
		description: 'Sends a note to a thread: an idle or done thread starts a turn on it at once, on its own branch, and a working one gets it after its current turn. Use it for anything that extends that thread\'s work, such as something the user added in the project chat.',
		inputSchema: { type: 'object', properties: { thread: { ...text, description: 'The thread id.' }, text, reopen: { type: 'boolean', description: 'Reopen a resolved (merged) thread. Only when the user asked to reopen it.' } }, required: ['thread', 'text'] },
	},
	{
		name: 'list_threads',
		description: 'The project\'s threads with their state and last line. The same list is already in each wake; call this only for a fresh look, or with all: true for the older merged threads the wake leaves out.',
		inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Also list every older merged thread.' } } },
	},
	{
		name: 'read_thread',
		description: 'The latest messages of one thread, as text.',
		inputSchema: { type: 'object', properties: { thread: text, last: { type: 'number', description: 'How many messages, newest last (default 10).' } }, required: ['thread'] },
	},
	{
		name: 'post',
		description: 'Posts a message in the project chat, where the user reads it. Keep it to a line or two.',
		inputSchema: { type: 'object', properties: { text }, required: ['text'] },
	},
];

export const threadTools: readonly McpTool[] = [
	{
		name: 'add_repo',
		description: 'Adds another of the project\'s repositories to this thread: a worktree of it on this thread\'s branch, as a new folder beside the others in your folder. Use it when the work turns out to need that repository. Returns once the folder is ready.',
		inputSchema: {
			type: 'object',
			properties: { repo: { ...text, description: 'The repository\'s name, as its folder in your folder would be named.' }, reason: { ...text, description: 'Why the work needs it, in a few words; the user sees this.' } },
			required: ['repo', 'reason'],
		},
	},
	{
		name: 'report',
		description: 'Tells the project\'s coordinator about a result, a blocker, or a question only the user can answer. Call it once when your work is done.',
		inputSchema: {
			type: 'object',
			properties: { kind: { type: 'string', enum: ['result', 'blocker', 'question'] }, text: { ...text, description: 'One or two sentences.' } },
			required: ['kind', 'text'],
		},
	},
];

/**
 * Whether a permission request is for one of `tools` from this server. The
 * CLI titles an MCP call by its tool and arguments, without the server's
 * name; only MCP calls offer "Allow all server tools", which together with the
 * tool's name tells the project's tools apart from the user's own servers.
 */
export function isProjectToolCall(request: { readonly toolCall: { readonly title?: string | null }; readonly options: readonly { readonly optionId: string }[] }, tools: readonly McpTool[]): boolean {
	const title = request.toolCall.title ?? '';
	return request.options.some(option => /server/i.test(option.optionId))
		&& tools.some(tool => title === tool.name || title.startsWith(`${tool.name}(`));
}

/** Whether a tool call's title is a call of one of `tools`, as the CLI titles MCP calls. */
export function isProjectToolTitle(title: string, tools: readonly McpTool[]): boolean {
	return tools.some(tool => title === tool.name || title.startsWith(`${tool.name}(`));
}

const idPattern = /^[\w-]{1,80}$/;

/** The MCP endpoint: POST `/mcp/<project>/coordinator` or `/mcp/<project>/thread/<id>` with `Authorization: Bearer <token>`. */
export class ProjectMcpServer {

	private readonly server: LocalMcpServer<ProjectCaller>;
	/** The routes whose tools the CLI has listed since the server started, and who waits on one. */
	private readonly listed = new Set<string>();
	private readonly listeners = new Map<string, Set<() => void>>();
	/** The routes the CLI has sent anything to, for telling a session that never connected from one that connected and stopped. */
	private readonly contacted = new Set<string>();

	constructor(private readonly host: ProjectToolHost, version: string) {
		this.server = new LocalMcpServer<ProjectCaller>({
			name: projectServerName,
			version,
			callerOf,
			instructions: caller => caller.role === 'coordinator'
				? 'Tools to start and steer the threads of a GeminiCode project.'
				: 'Tools to report back to the coordinator of your GeminiCode project.',
			tools: caller => this.toolsFor(caller),
			call: async (caller, name, args) => this.toolsFor(caller).some(tool => tool.name === name)
				? this.host.call(caller, name, args)
				: { content: [{ type: 'text', text: `No tool named ${name}.` }], isError: true },
			onMessages: (route, messages) => {
				this.contacted.add(route);
				if (messages.some(m => m?.method === 'tools/list')) {
					this.listed.add(route);
					this.listeners.get(route)?.forEach(listener => listener());
				}
			},
		});
	}

	start(): Promise<number> {
		return this.server.start();
	}

	get listening(): boolean {
		return this.server.listening;
	}

	/** The ACP `mcpServers` entry for `caller`; undefined until started. */
	configFor(caller: ProjectCaller): McpHttpConfig | undefined {
		const route = routeOf(caller);
		return route ? this.server.configFor(route) : undefined;
	}

	/**
	 * Whether `caller`'s session loaded the tools: the CLI lists them when a
	 * session opens with the server, and never in a folder it doesn't trust.
	 * Waits up to `ms` for that; at once when it happened already.
	 */
	whenListed(caller: ProjectCaller, ms: number): Promise<boolean> {
		const route = routeOf(caller);
		if (!route || this.listed.has(route)) {
			return Promise.resolve(!!route);
		}
		return new Promise(resolve => {
			const waiting = this.listeners.get(route) ?? new Set();
			this.listeners.set(route, waiting);
			const done = (listed: boolean) => {
				clearTimeout(timer);
				waiting.delete(onListed);
				resolve(listed);
			};
			const onListed = () => done(true);
			const timer = setTimeout(() => done(false), ms);
			waiting.add(onListed);
		});
	}

	/** Whether the CLI has sent `caller`'s route anything since the server started. */
	wasContacted(caller: ProjectCaller): boolean {
		const route = routeOf(caller);
		return !!route && this.contacted.has(route);
	}

	/** Forgets that `caller`'s tools were listed, as before its session opens again in a new agent process. */
	forgetListed(caller: ProjectCaller): void {
		const route = routeOf(caller);
		if (route) {
			this.listed.delete(route);
		}
	}

	dispose(): void {
		this.server.dispose();
	}

	private toolsFor(caller: ProjectCaller): readonly McpTool[] {
		return caller.role === 'coordinator' ? coordinatorTools
			: this.host.multiRepo?.(caller) ? threadTools : threadTools.filter(tool => tool.name !== 'add_repo');
	}
}

function routeOf(caller: ProjectCaller): string | undefined {
	if (!idPattern.test(caller.project) || (caller.role === 'thread' && !idPattern.test(caller.thread))) {
		return undefined;
	}
	return caller.role === 'coordinator' ? `${caller.project}/coordinator` : `${caller.project}/thread/${caller.thread}`;
}

function callerOf(route: string): ProjectCaller | undefined {
	const coordinator = /^([\w-]{1,80})\/coordinator$/.exec(route);
	if (coordinator) {
		return { role: 'coordinator', project: coordinator[1] };
	}
	const thread = /^([\w-]{1,80})\/thread\/([\w-]{1,80})$/.exec(route);
	return thread ? { role: 'thread', project: thread[1], thread: thread[2] } : undefined;
}
