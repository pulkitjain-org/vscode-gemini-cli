/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Taking over the Jira and GitLab servers a repository's .gemini/settings.json runs in the CLI
// (gemini/docs/AGENTIC-PLAN.md, section 3, "Migration"): what the file says about each server,
// and the file without them. The connections then hold the address, the account and the token (in
// the keychain), and the team tools run the same servers as their own children.

import { isRecord } from './projectSettings';

/** What the settings file says about one server, its references to the shell environment resolved. */
export interface TakeoverServer {
	/** The `mcpServers` key, as the file spells it. */
	readonly name: string;
	/** Jira's site, or GitLab's address without `/api/v4`. */
	readonly url?: string;
	/** Jira's account email. */
	readonly email?: string;
	/** The token, when the environment GeminiCode started in has it. */
	readonly token?: string;
	/** The variable the token comes from, to ask for by name when it isn't set here. */
	readonly tokenEnv?: string;
	/** Every environment variable the server reads that holds a secret. */
	readonly secretEnv: readonly string[];
}

export interface TakeoverPlan {
	readonly jira?: TakeoverServer;
	readonly gitlab?: TakeoverServer;
}

const secretName = /TOKEN|SECRET|PASSWORD/i;

/** The Jira and GitLab servers in `settings`, with what can be read of their address, account and token. */
export function readTeamServers(settings: Record<string, unknown>, env: NodeJS.ProcessEnv): TakeoverPlan {
	const servers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
	const plan: { jira?: TakeoverServer; gitlab?: TakeoverServer } = {};
	for (const [name, entry] of Object.entries(servers)) {
		const kind = name.toLowerCase();
		if ((kind !== 'jira' && kind !== 'gitlab') || !isRecord(entry)) {
			continue;
		}
		const vars = serverEnv(entry);
		const value = (key: string) => resolve(vars.get(key), env);
		const reference = (key: string) => referenceOf(vars.get(key));
		const secretEnv = [...vars.keys()].filter(key => secretName.test(key)).map(key => reference(key) ?? key);
		if (kind === 'jira') {
			const tokenKey = ['JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN'].find(key => vars.has(key));
			plan.jira = {
				name,
				...optional('url', value('JIRA_URL')),
				...optional('email', value('JIRA_USERNAME')),
				...optional('token', tokenKey && value(tokenKey)),
				...optional('tokenEnv', tokenKey && (reference(tokenKey) ?? tokenKey)),
				secretEnv,
			};
		} else {
			const tokenKey = vars.has('GITLAB_PERSONAL_ACCESS_TOKEN') ? 'GITLAB_PERSONAL_ACCESS_TOKEN' : undefined;
			plan.gitlab = {
				name,
				...optional('url', value('GITLAB_API_URL')?.replace(/\/api\/v4\/?$/, '').replace(/\/+$/, '')),
				...optional('token', tokenKey && value(tokenKey)),
				...optional('tokenEnv', tokenKey && (reference(tokenKey) ?? tokenKey)),
				secretEnv,
			};
		}
	}
	return plan;
}

/**
 * Removes the servers in `plan` from `settings`: their `mcpServers` entries, their names from
 * `mcp.allowed`, and their secrets' variables from `security.environmentVariableRedaction.allowed`,
 * so the CLI redacts the tokens again. Returns what it removed, for the message.
 */
export function removeTeamServers(settings: Record<string, unknown>, plan: TakeoverPlan): string[] {
	const servers = [plan.jira, plan.gitlab].filter((s): s is TakeoverServer => !!s);
	const removed: string[] = [];
	if (isRecord(settings.mcpServers)) {
		for (const server of servers) {
			if (Object.keys(settings.mcpServers).includes(server.name)) {
				delete settings.mcpServers[server.name];
				removed.push(`mcpServers.${server.name}`);
			}
		}
	}
	const names = new Set(servers.map(s => s.name));
	const mcp = settings.mcp;
	if (isRecord(mcp) && Array.isArray(mcp.allowed)) {
		const kept = mcp.allowed.filter(n => !(typeof n === 'string' && names.has(n)));
		if (kept.length !== mcp.allowed.length) {
			mcp.allowed = kept;
			removed.push('mcp.allowed');
		}
	}
	const secrets = new Set(servers.flatMap(s => s.secretEnv));
	const redaction = isRecord(settings.security) && isRecord(settings.security.environmentVariableRedaction) ? settings.security.environmentVariableRedaction : undefined;
	if (redaction && Array.isArray(redaction.allowed)) {
		const kept = redaction.allowed.filter(n => !(typeof n === 'string' && secrets.has(n)));
		if (kept.length !== redaction.allowed.length) {
			redaction.allowed = kept;
			removed.push('security.environmentVariableRedaction.allowed');
		}
	}
	return removed;
}

/** The server's environment: its `env` object, then `-e NAME=value` and `-e NAME` in its arguments (a bare name passes the shell's value, written as `$NAME`). */
function serverEnv(entry: Record<string, unknown>): Map<string, string | undefined> {
	const vars = new Map<string, string | undefined>();
	if (isRecord(entry.env)) {
		for (const [key, value] of Object.entries(entry.env)) {
			vars.set(key, typeof value === 'string' ? value : undefined);
		}
	}
	const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
	for (let i = 0; i < args.length; i++) {
		const flag = args[i] === '-e' || args[i] === '--env' ? args[++i] : /^--env=/.test(args[i]) ? args[i].slice(6) : undefined;
		if (!flag) {
			continue;
		}
		const eq = flag.indexOf('=');
		const key = eq < 0 ? flag : flag.slice(0, eq);
		// The `env` object sets what Docker passes on, so it wins; a bare name reads the shell's variable.
		if (vars.get(key) === undefined) {
			vars.set(key, eq < 0 ? `$${key}` : flag.slice(eq + 1));
		}
	}
	return vars;
}

/** `$NAME` or `${NAME}` names a variable of the shell the CLI starts in. */
function referenceOf(value: string | undefined): string | undefined {
	return value?.trim().match(/^\$\{?(?<name>[A-Za-z_][A-Za-z0-9_]*)\}?$/)?.groups?.name;
}

function resolve(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	const name = referenceOf(value);
	const resolved = name ? env[name] : value;
	return resolved?.trim() || undefined;
}

function optional<K extends string>(key: K, value: string | undefined | false | ''): { [P in K]?: string } {
	return (value ? { [key]: value } : {}) as { [P in K]?: string };
}
