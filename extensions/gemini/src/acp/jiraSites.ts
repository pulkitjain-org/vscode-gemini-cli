/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The user's Jira sites, such as two client teams' Jira Cloud instances, as
// one client with JiraClient's methods: a call about a ticket goes to the
// site that has it, and the user's tickets and searches come from every site.
// A ticket's link goes to the site of its host. A project key is remembered
// with the site it was read from; one seen on two sites is ambiguous, and a
// key in it is looked for on every site, as is a key not seen before.

import type { JiraAttachment, JiraClient, JiraCommentVisibility, JiraIssue, JiraIssueSummary, JiraMyTickets, JiraSiteTickets, JiraTransition, JiraUser } from './jira';
import { hostOf } from './teamHttp';

export interface JiraSite {
	/** Stable across renames: `default` for the first site, which keeps the single-site storage. */
	readonly id: string;
	/** What the user calls it on Home and in Connections. */
	readonly name: string;
	readonly client: JiraClient;
}

/** The project part of a key: ACME for ACME-412. */
export function projectOf(key: string): string {
	return key.trim().toUpperCase().replace(/-\d+$/, '');
}

/** The key of a ticket's key or link: ACME-412 for `https://acme.atlassian.net/browse/ACME-412`. */
export function keyOf(keyOrUrl: string): string {
	return keyOrUrl.replace(/^.*\/browse\//, '').replace(/[?#].*$/, '').trim().toUpperCase();
}

/** A Jira search over every site: the matches, and what the model should know of the sites that didn't answer or have more. */
export interface JiraSitesSearch {
	readonly issues: JiraIssueSummary[];
	readonly notes: string[];
}

/** A ticket key more than one site has: which is meant can't be told. */
export class AmbiguousTicketError extends Error {
	constructor(readonly key: string, readonly sites: readonly JiraSite[]) {
		super(`${key} is on more than one Jira site (${sites.map(s => `${s.name}: ${s.client.issueUrl(key)}`).join(', ')}). Give the ticket's link instead of its key.`);
	}
}

export class JiraSites {

	/** Each project key's site, as found. */
	private readonly projects = new Map<string, JiraSite>();
	/** Project keys seen on more than one site. */
	private readonly ambiguous = new Set<string>();
	/** Each site's last answer for the user's tickets, shown while it can't be reached. */
	private readonly lastTickets = new Map<string, { readonly at: number; readonly tickets: JiraMyTickets }>();

	/** `sites` is never empty; the first is the one the single-site settings describe. */
	constructor(readonly sites: readonly JiraSite[]) { }

	get primary(): JiraClient {
		return this.sites[0].client;
	}

	/** The first site's address, for links that name no ticket. */
	get site(): string {
		return this.primary.site;
	}

	/** The site a ticket link points at, by its host. */
	siteOfUrl(url: string): JiraSite | undefined {
		const host = hostOf(url);
		return this.sites.find(site => hostOf(site.client.site) === host);
	}

	/**
	 * The client for ticket `key` (or a link to it): by the link's host, else,
	 * to read, by its project as found before, else by asking every site. A
	 * link to a site not connected is refused, with one site too. A write by
	 * key always asks every site, as a project found on one site may be on
	 * another too, and is refused when a site can't be asked. A key no site has
	 * goes to the first, whose own error then says so; one that more than one
	 * site has is refused, as it can't be told which is meant.
	 */
	async clientFor(keyOrUrl: string, write = false): Promise<JiraClient> {
		return (await this.route(keyOrUrl, write))[0];
	}

	/** The client for `keyOrUrl`, as `clientFor`, with the ticket's key. */
	private async route(keyOrUrl: string, write = false): Promise<[JiraClient, string]> {
		const key = keyOf(keyOrUrl);
		const url = keyOrUrl.trim();
		if (/^https?:\/\//i.test(url)) {
			const linked = this.siteOfUrl(url);
			if (!linked) {
				// Never another site's ticket with the same key.
				throw new Error(`${hostOf(url)} isn't a Jira site you've connected (${this.sites.map(site => hostOf(site.client.site)).join(', ')}). The user can connect it in GeminiCode's Connections page.`);
			}
			// A link says where its project is too: on a second site, it makes the project ambiguous.
			this.learn(linked, [{ key }]);
			return [linked.client, key];
		}
		if (this.sites.length === 1) {
			return [this.primary, key];
		}
		const known = write ? undefined : this.projects.get(projectOf(key));
		if (known) {
			return [known.client, key];
		}
		const answers = await Promise.all(this.sites.map(site => site.client.has(key).then(found => ({ site, found, error: undefined }), (error: unknown) => ({ site, found: false, error: error ?? new Error('failed') }))));
		const found = answers.flatMap(a => a.found ? [a.site] : []);
		if (found.length > 1) {
			throw new AmbiguousTicketError(key, found);
		}
		const failed = answers.filter(a => a.error !== undefined);
		if (found.length === 1 && write && failed.length) {
			// The site that didn't answer may have the same key: a write never guesses.
			throw new Error(`Couldn't check ${failed.map(a => `${a.site.name} (${hostOf(a.site.client.site)})`).join(', ')} for ${key}, which may have it too. Give the ticket's link instead of its key.`);
		}
		if (found.length === 1) {
			this.learn(found[0], [{ key }]);
			return [found[0].client, key];
		}
		if (failed.length) {
			throw failed[0].error;
		}
		return [this.primary, key];
	}

	/** Remembers the site of each ticket's project, as read from that site; a project read from two sites is ambiguous from then on. */
	private learn(site: JiraSite, issues: readonly { readonly key: string }[]): void {
		for (const issue of issues) {
			const project = projectOf(issue.key);
			const known = this.projects.get(project);
			if (this.ambiguous.has(project) || (known && known !== site)) {
				this.projects.delete(project);
				this.ambiguous.add(project);
			} else {
				this.projects.set(project, site);
			}
		}
	}

	/** The user on the site of `key`, or on the first site. */
	async myself(key?: string): Promise<JiraUser> {
		return (key ? await this.clientFor(key) : this.primary).myself();
	}

	async search(jql: string, max = 20): Promise<JiraIssueSummary[]> {
		return (await this.searchSites(jql, max)).issues;
	}

	/**
	 * Every site's matches, the first site's first, with `max` shared out
	 * evenly among the sites that have matches; `notes` names the sites that
	 * failed and those that have more than shown. Throws only when every site fails.
	 */
	async searchSites(jql: string, max = 20): Promise<JiraSitesSearch> {
		max = Math.max(1, max);
		if (this.sites.length === 1) {
			return { issues: await this.primary.search(jql, max), notes: [] };
		}
		const results = await Promise.allSettled(this.sites.map(async site => {
			const issues = await site.client.search(jql, max);
			this.learn(site, issues);
			return issues;
		}));
		if (results.every(r => r.status === 'rejected')) {
			throw (results[0] as PromiseRejectedResult).reason;
		}
		const lists = results.map(r => r.status === 'fulfilled' ? r.value : []);
		const taken = lists.map(() => 0);
		for (let left = max, more = true; left > 0 && more;) {
			more = false;
			lists.forEach((list, i) => {
				if (left > 0 && taken[i] < list.length) {
					taken[i]++;
					left--;
					more = true;
				}
			});
		}
		const notes = results.flatMap((r, i) => {
			const name = `${this.sites[i].name} (${hostOf(this.sites[i].client.site)})`;
			return r.status === 'rejected' ? [`Couldn't search ${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
				: taken[i] < r.value.length || r.value.length >= max ? [`${name}: has more matches than the ${taken[i]} shown.`] : [];
		});
		return { issues: lists.flatMap((list, i) => list.slice(0, taken[i])), notes };
	}

	/**
	 * The tickets assigned to the user on every site. With one site, as that
	 * site answers. With more, all of them (the first site's sprint as the
	 * sprint) and each site's own part in `sites`; a site that doesn't answer
	 * shows its last answer with the error, and only when none answers does it throw.
	 */
	async myTickets(now = Date.now()): Promise<JiraMyTickets> {
		if (this.sites.length === 1) {
			return this.primary.myTickets();
		}
		const results = await Promise.allSettled(this.sites.map(site => site.client.myTickets()));
		if (results.every(r => r.status === 'rejected')) {
			throw (results[0] as PromiseRejectedResult).reason;
		}
		const sites = this.sites.map((site, i): JiraSiteTickets => {
			const result = results[i];
			const base = { name: site.name, host: hostOf(site.client.site) };
			if (result.status === 'fulfilled') {
				this.lastTickets.set(site.id, { at: now, tickets: result.value });
				this.learn(site, result.value.issues);
				return { ...base, ...result.value.sprint ? { sprint: result.value.sprint } : {}, issues: result.value.issues };
			}
			const last = this.lastTickets.get(site.id);
			const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
			return { ...base, ...last?.tickets.sprint ? { sprint: last.tickets.sprint } : {}, issues: last?.tickets.issues ?? [], error, ...last ? { asOf: last.at } : {} };
		});
		return { ...sites[0].sprint ? { sprint: sites[0].sprint } : {}, issues: sites.flatMap(s => s.issues), sites };
	}

	/** Calls `call` with the client and key of `key` (a key or a link), as `clientFor` finds them. */
	private async on<T>(key: string, write: boolean, call: (client: JiraClient, key: string) => Promise<T>): Promise<T> {
		const [client, k] = await this.route(key, write);
		return call(client, k);
	}

	// Each call below takes a ticket's key or its link; the writes ask every site for a key.

	issue(key: string): Promise<JiraIssue> {
		return this.on(key, false, (client, k) => client.issue(k));
	}

	transitions(key: string): Promise<JiraTransition[]> {
		return this.on(key, false, (client, k) => client.transitions(k));
	}

	transition(key: string, transition: string, comment?: string, fields?: Record<string, string | readonly string[]>): Promise<JiraTransition> {
		return this.on(key, true, (client, k) => client.transition(k, transition, comment, fields));
	}

	comment(key: string, text: string, visibility?: string): Promise<{ readonly id?: string }> {
		return this.on(key, true, (client, k) => client.comment(k, text, visibility));
	}

	commentDocument(key: string, body: unknown, visibility?: JiraCommentVisibility): Promise<{ readonly id?: string }> {
		return this.on(key, true, (client, k) => client.commentDocument(k, body, visibility));
	}

	attach(key: string, files: Parameters<JiraClient['attach']>[1]): Promise<JiraAttachment[]> {
		return this.on(key, true, (client, k) => client.attach(k, files));
	}

	mentionableUsers(key: string, query: string): Promise<JiraUser[]> {
		return this.on(key, false, (client, k) => client.mentionableUsers(k, query));
	}

	commentVisibilities(key: string): Promise<{ readonly roles: string[]; readonly groups: string[] }> {
		return this.on(key, false, (client, k) => client.commentVisibilities(k));
	}

	logWork(key: string, spent: string, comment?: string, started?: Date): Promise<{ readonly id?: string }> {
		return this.on(key, true, (client, k) => client.logWork(k, spent, comment, started));
	}

	worklogTotals(key: string, accountId?: string): Promise<{ total: number; mine: number }> {
		return this.on(key, false, (client, k) => client.worklogTotals(k, accountId));
	}

	assignableUsers(key: string, query?: string): Promise<JiraUser[]> {
		return this.on(key, false, (client, k) => client.assignableUsers(k, query));
	}

	assign(key: string, accountId: string | null): Promise<void> {
		return this.on(key, true, (client, k) => client.assign(k, accountId));
	}
}

/** What a team tool's Jira call needs: one site's client, or all the sites for a search. */
export type JiraApi = Pick<JiraClient, 'issue' | 'search' | 'comment' | 'commentDocument' | 'attach' | 'logWork' | 'assign' | 'assignableUsers' | 'transitions' | 'transition'> & {
	myself(key?: string): Promise<JiraUser>;
	/** Every site's matches with notes on the sites, when there is more than one. */
	searchSites?(jql: string, max?: number): Promise<JiraSitesSearch>;
};
