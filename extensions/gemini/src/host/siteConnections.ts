/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Connections' actions on Jira sites and Confluence: adding a Jira site after
// the first, removing one, disconnecting the first while others remain, and
// turning Confluence on or off for a site. Only the Connections page runs
// them, so they live in its bundle (dist/pages.js) and work on what
// TeamConnections keeps through its small storage API.

import * as vscode from 'vscode';
import { hostOf, normalizeBaseUrl, TeamToolError, teamToolNames } from '../acp/teamHttp';
import { accountKey, confluenceSitesKey, ConnectionState, defaultSiteName, jiraSitesKey, secretKey, siteSecretKey, StoredAccount, StoredJiraSite, TeamConnections } from './teamConnections';

/**
 * Adds a Jira site after the first, or replaces one's details or token
 * (`id`), after checking it. Throws a `TeamToolError` and saves nothing when
 * Jira refuses, except when it can't be reached.
 */
export async function connectJiraSite(connections: TeamConnections, details: { id?: string; name?: string; url?: string; email?: string; token?: string }, log: vscode.LogOutputChannel): Promise<ConnectionState> {
	const url = details.url ? normalizeBaseUrl(details.url) : '';
	const email = details.email?.trim() ?? '';
	const token = details.token?.trim() ?? '';
	if (!connections.connected.has('jira')) {
		throw new TeamToolError('failed', vscode.l10n.t("Connect your first Jira site before adding another."));
	}
	if (!url || !email || !token) {
		throw new TeamToolError('failed', vscode.l10n.t("Enter the Jira site, your email and an API token."));
	}
	const sites = connections.jiraSiteList();
	const taken = [connections.accountOf('jira')?.url, ...sites.filter(site => site.id !== details.id).map(site => site.url)];
	if (taken.some(other => other && hostOf(other) === hostOf(url))) {
		throw new TeamToolError('failed', vscode.l10n.t("{0} is already connected.", hostOf(url)));
	}
	const site: StoredJiraSite = { id: details.id ?? `site-${Date.now().toString(36)}`, name: details.name?.trim() || defaultSiteName(url), url, email };
	log.info(`Connecting Jira at ${url}`);
	const state = await connections.checkJiraSite(url, email, token);
	log.info(`Jira at ${url}: ${state.kind}${state.detail ? ` (${state.detail})` : ''}`);
	if (state.kind === 'auth' || state.kind === 'failed') {
		throw new TeamToolError(state.kind === 'auth' ? 'auth' : 'failed', state.detail ?? vscode.l10n.t("{0} refused the token.", teamToolNames.jira));
	}
	const { secrets, globalState } = connections.storage;
	await secrets.store(siteSecretKey(site.id), token);
	const index = sites.findIndex(s => s.id === site.id);
	await globalState.update(jiraSitesKey, index >= 0 ? sites.map((s, i) => i === index ? site : s) : [...sites, site]);
	await connections.reload();
	connections.setSiteState(site.id, state);
	return state;
}

/** Removes a Jira site added after the first, and Confluence on it. */
export async function removeJiraSite(connections: TeamConnections, id: string, log: vscode.LogOutputChannel): Promise<void> {
	const { secrets, globalState } = connections.storage;
	await secrets.delete(siteSecretKey(id));
	await globalState.update(jiraSitesKey, connections.jiraSiteList().filter(site => site.id !== id));
	if (connections.confluenceSiteIds().includes(id)) {
		await disconnectConfluence(connections, id);
	}
	connections.setSiteState(id, undefined);
	await connections.reload();
	log.info('Removed a Jira site');
}

/**
 * Disconnects the first Jira site. While others remain, the next one with a
 * token becomes the first, in the single-site settings, so Jira stays
 * connected; a site whose token is gone is removed. With none left, Jira and
 * Confluence are disconnected, and no site is left behind in the settings.
 */
export async function disconnectJira(connections: TeamConnections, log: vscode.LogOutputChannel): Promise<void> {
	const { secrets, globalState } = connections.storage;
	const sites = connections.jiraSiteList();
	let next: StoredJiraSite | undefined;
	let token: string | undefined;
	for (const site of sites) {
		token = await secrets.get(siteSecretKey(site.id));
		if (token) {
			next = site;
			break;
		}
	}
	// The sites before the new first had no token: they go too.
	const gone = next ? sites.slice(0, sites.indexOf(next) + 1) : sites;
	const rest = sites.filter(site => !gone.includes(site));
	const state = next && connections.siteState(next.id);
	// The list changes before any token does: each keychain write reloads the connections, which must never see a site twice.
	await globalState.update(jiraSitesKey, rest.length ? rest : undefined);
	for (const site of gone) {
		connections.setSiteState(site.id, undefined);
	}
	if (!next || !token || !state) {
		for (const site of gone) {
			await secrets.delete(siteSecretKey(site.id));
		}
		await globalState.update(confluenceSitesKey, undefined);
		if (connections.connected.has('confluence')) {
			await connections.disconnect('confluence');
		}
		await connections.disconnect('jira');
		return;
	}
	await globalState.update(accountKey('jira'), { url: next.url, email: next.email, name: next.name } satisfies StoredAccount);
	await secrets.store(secretKey('jira'), token);
	for (const site of gone) {
		await secrets.delete(siteSecretKey(site.id));
	}
	// Confluence on the old first site and on removed sites goes; on the new first site it keeps its place.
	const confluence = connections.confluenceSiteIds().filter(id => id !== 'default' && (id === next.id || !gone.some(site => site.id === id))).map(id => id === next.id ? 'default' : id);
	await globalState.update(confluenceSitesKey, confluence.length ? confluence : undefined);
	await connections.reload();
	connections.setToolState('jira', state, true);
	log.info(`Disconnected a Jira site; ${next.url} is now the first`);
}

/**
 * Turns Confluence on for Jira site `id` with that site's account, after
 * checking Confluence answers. Throws a `TeamToolError` and saves nothing
 * when it refuses, except when it can't be reached.
 */
export async function connectConfluence(connections: TeamConnections, id: string, log: vscode.LogOutputChannel): Promise<ConnectionState> {
	const account = connections.jiraAccounts().find(a => a.id === id);
	if (!account) {
		throw new TeamToolError('failed', vscode.l10n.t("Connect that Jira site first."));
	}
	connections.setConnecting('confluence', true);
	let state: ConnectionState;
	try {
		state = await connections.checkConfluence(account);
	} finally {
		connections.setConnecting('confluence', false);
	}
	if (state.kind === 'auth' || state.kind === 'failed') {
		throw new TeamToolError(state.kind === 'auth' ? 'auth' : 'failed', state.detail ?? vscode.l10n.t("{0} refused the token.", teamToolNames.confluence));
	}
	await connections.storage.globalState.update(confluenceSitesKey, [...new Set([...connections.confluenceSiteIds(), id])]);
	await connections.reload();
	connections.setConfluenceState(id, state);
	connections.startServer();
	log.info(`Connected Confluence at ${account.site}`);
	return state;
}

/** Turns Confluence off for Jira site `id`. */
export async function disconnectConfluence(connections: TeamConnections, id: string): Promise<void> {
	const rest = connections.confluenceSiteIds().filter(other => other !== id);
	if (!rest.length) {
		await connections.disconnect('confluence');
		return;
	}
	await connections.storage.globalState.update(confluenceSitesKey, rest);
	await connections.reload();
	connections.setConfluenceState(id, undefined);
}
