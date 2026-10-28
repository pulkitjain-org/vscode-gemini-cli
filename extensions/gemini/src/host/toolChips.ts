/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Attachment } from '../acp/attachments';
import { ticketGroups } from '../acp/dashboard';
import { describeMr } from '../acp/gitlab';
import type { JiraMyTicket, JiraMyTickets } from '../acp/jira';
import { AmbiguousTicketError } from '../acp/jiraSites';
import { defaultDesignSizes } from '../acp/figmaDesign';
import type { TeamDefaults } from '../acp/teamDefaults';
import { hostOf, TeamToolError } from '../acp/teamHttp';
import { parseToolLink, ToolRef, ToolRefContext, toolRefId, toolRefLabel, toolRefUrl } from '../acp/toolLinks';
import type { TeamConnections } from './teamConnections';
import { openTeamLink } from './teamLinks';

/** A ticket in a quick pick, with its key to start on or attach, and its link, which says its Jira site. */
export type TicketPickItem = vscode.QuickPickItem & { readonly key?: string; readonly url?: string };

/**
 * The user's tickets for a quick pick: the running sprint's under its name,
 * then the rest under "Not in this sprint"; with more than one Jira site, each says its site.
 */
export function ticketPickItems(mine: JiraMyTickets): TicketPickItem[] {
	const { sprint, other } = ticketGroups(mine.issues);
	const sites = (mine.sites?.length ?? 0) > 1;
	const item = (issue: JiraMyTicket): TicketPickItem => ({ label: issue.key, description: issue.summary, detail: sites ? `${issue.status} · ${hostOf(issue.url)}` : issue.status, key: issue.key, url: issue.url });
	return [
		...sprint.length ? [{ label: mine.sprint?.name ?? vscode.l10n.t("This sprint"), kind: vscode.QuickPickItemKind.Separator }, ...sprint.map(item)] : [],
		...sprint.length && other.length ? [{ label: vscode.l10n.t("Not in this sprint"), kind: vscode.QuickPickItemKind.Separator }] : [],
		...other.map(item),
	];
}

/** A chip's attachment: a document the prompt carries, with the tool's logo and the item's id. */
export type ToolAttachment = Extract<Attachment, { kind: 'document' }> & { readonly tool: ToolRef['tool']; readonly ref: string };

/**
 * Turns Jira tickets, GitLab merge requests and issues, and Figma frames
 * named in the composer into chips that carry the item's trimmed content.
 * Each item is fetched once and kept for a few minutes. Nothing here waits
 * for the user: the view shows a chip at once and swaps in the title and
 * content when they arrive, and a prompt sent first carries a note telling
 * the agent which tool reads the item.
 */
export class ToolChips {

	private readonly cache = new Map<string, { readonly at: number; readonly value: Promise<ToolAttachment> }>();

	constructor(private readonly connections: TeamConnections) { }

	get onDidChange(): vscode.Event<void> {
		return this.connections.onDidChange;
	}

	/** What the view needs to find refs: the connected tools and the team's Jira projects. */
	async context(folder?: string): Promise<ToolRefContext> {
		const connected = [...this.connections.connected].filter(tool => tool === 'jira' || tool === 'gitlab' || tool === 'figma' || tool === 'confluence');
		const defaults: TeamDefaults = await (folder ? this.connections.defaults(folder) : this.connections.workspaceDefaults()).catch(() => ({}));
		return { connected, jiraProjects: defaults.jira?.projects ?? [], figmaSizes: defaults.figma?.viewports ?? userDesignSizes() ?? defaultDesignSizes, designSystem: !!defaults.figma?.designSystem };
	}

	/** The item's attachment; never throws (a failure gives a chip with a note instead). */
	resolve(ref: ToolRef): Promise<ToolAttachment> {
		const id = toolRefId(ref);
		const cached = this.cache.get(id);
		if (cached && Date.now() - cached.at < 5 * 60_000) {
			return cached.value;
		}
		const value = this.fetch(ref).catch(err => {
			this.cache.delete(id);
			return placeholderAttachment(ref, err instanceof TeamToolError || err instanceof Error ? err.message : String(err));
		});
		this.cache.set(id, { at: Date.now(), value });
		return value;
	}

	/** Opens the item a chip names (its `toolRefId`) in its tool, as Home opens team links; says so when that tool isn't connected. */
	async open(id: string): Promise<void> {
		const { jira, gitlab } = this.connections.connectors;
		// A ticket opens on the Jira site that has it.
		const key = id.startsWith('jira:') ? id.slice('jira:'.length) : undefined;
		const url = key && jira ? await jira.clientFor(key).then(client => client.issueUrl(key), (err: unknown) => {
			// A key on more than one site: the user says which, rather than the first site's ticket opening.
			if (err instanceof AmbiguousTicketError) {
				return vscode.window.showQuickPick(err.sites.map(site => ({ label: site.name, description: hostOf(site.client.site), url: site.client.issueUrl(key) })), { title: vscode.l10n.t("{0} is on more than one Jira site. Open it on which?", key) }).then(site => site?.url);
			}
			return jira.primary.issueUrl(key);
		}) : toolRefUrl(id, { jira: jira?.site, gitlab: gitlab?.url });
		if (key && jira && !url) {
			return;
		}
		if (url) {
			await openTeamLink(url);
			return;
		}
		const tool = id.startsWith('jira:') ? 'Jira' : id.startsWith('gitlab:') ? 'GitLab' : id.startsWith('confluence:') ? 'Confluence' : undefined;
		if (tool) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Connect {0} in Connections to open this item.", tool));
		}
	}

	/** Asks the user for a ticket, merge request or frame for the + menu, in a quick pick. */
	async pick(tool: ToolRef['tool']): Promise<ToolRef | undefined> {
		switch (tool) {
			case 'jira': return this.pickTicket();
			case 'gitlab': return this.pickMergeRequest();
			case 'figma': {
				const link = await vscode.window.showInputBox({
					title: vscode.l10n.t("Figma frame"),
					prompt: vscode.l10n.t("Paste the frame's link. In Figma, select the frame and choose Copy link to selection."),
					placeHolder: 'https://www.figma.com/design/…?node-id=…',
					ignoreFocusOut: true,
					validateInput: value => !value.trim() || parseToolLink(value.trim())?.tool === 'figma' ? undefined : vscode.l10n.t("That isn't a Figma link."),
				});
				const ref = link ? parseToolLink(link.trim()) : undefined;
				return ref?.tool === 'figma' ? ref : undefined;
			}
			case 'confluence': {
				const link = await vscode.window.showInputBox({
					title: vscode.l10n.t("Confluence page"),
					prompt: vscode.l10n.t("Paste the page's link, from its address bar or Share menu."),
					placeHolder: 'https://…/wiki/spaces/…/pages/…',
					ignoreFocusOut: true,
					validateInput: value => !value.trim() || parseToolLink(value.trim())?.tool === 'confluence' ? undefined : vscode.l10n.t("That isn't a Confluence page link."),
				});
				const ref = link ? parseToolLink(link.trim()) : undefined;
				return ref?.tool === 'confluence' ? ref : undefined;
			}
		}
	}

	private async pickTicket(): Promise<ToolRef | undefined> {
		const jira = this.connections.connectors.jira;
		if (!jira) {
			return undefined;
		}
		const pick = vscode.window.createQuickPick<TicketPickItem>();
		pick.title = vscode.l10n.t("Jira ticket");
		pick.placeholder = vscode.l10n.t("Search your open tickets, or type a key such as ACME-412");
		pick.matchOnDescription = true;
		pick.busy = true;
		let listed: TicketPickItem[] = [];
		const typed = () => {
			const key = /^[A-Za-z][A-Za-z0-9_]{1,15}-\d+$/.test(pick.value.trim()) ? pick.value.trim().toUpperCase() : undefined;
			pick.items = [...key && !listed.some(item => item.key === key) ? [{ label: key, description: vscode.l10n.t("Use this ticket"), key }] : [], ...listed];
		};
		pick.onDidChangeValue(typed);
		pick.show();
		void jira.myTickets().then(result => {
			listed = ticketPickItems(result);
			typed();
		}, (err: unknown) => {
			pick.placeholder = err instanceof Error ? err.message : String(err);
		}).finally(() => pick.busy = false);
		const chosen = await new Promise<TicketPickItem | undefined>(resolve => {
			pick.onDidAccept(() => resolve(pick.selectedItems[0]));
			pick.onDidHide(() => resolve(undefined));
		});
		pick.dispose();
		return chosen?.key ? { tool: 'jira', key: chosen.key } : undefined;
	}

	private async pickMergeRequest(): Promise<ToolRef | undefined> {
		const gitlab = this.connections.connectors.gitlab;
		if (!gitlab) {
			return undefined;
		}
		type Item = vscode.QuickPickItem & { ref?: ToolRef };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t("GitLab merge request or issue");
		pick.placeholder = vscode.l10n.t("Search your merge requests, or paste a link");
		pick.matchOnDescription = true;
		pick.matchOnDetail = true;
		pick.busy = true;
		let listed: Item[] = [];
		const typed = () => {
			const ref = parseToolLink(pick.value.trim());
			pick.items = [...ref?.tool === 'gitlab' ? [{ label: toolRefLabel(ref), description: vscode.l10n.t("Use this link"), ref }] : [], ...listed];
		};
		pick.onDidChangeValue(typed);
		pick.show();
		void Promise.all([gitlab.reviewRequests().catch(() => []), gitlab.myMergeRequests().catch(() => [])]).then(([review, mine]) => {
			const item = (mr: typeof mine[number]): Item => ({
				label: `!${mr.iid}`, description: mr.title, detail: `${mr.project} · ${mr.sourceBranch} → ${mr.targetBranch} · ${mr.author}`,
				ref: { tool: 'gitlab', kind: 'mr', project: mr.project, iid: mr.iid, url: mr.url },
			});
			listed = [
				...review.length ? [{ label: vscode.l10n.t("Waiting for my review"), kind: vscode.QuickPickItemKind.Separator }, ...review.map(item)] : [],
				...mine.length ? [{ label: vscode.l10n.t("Mine"), kind: vscode.QuickPickItemKind.Separator }, ...mine.map(item)] : [],
			];
			typed();
		}).finally(() => pick.busy = false);
		const chosen = await new Promise<Item | undefined>(resolve => {
			pick.onDidAccept(() => resolve(pick.selectedItems[0]));
			pick.onDidHide(() => resolve(undefined));
		});
		pick.dispose();
		return chosen?.ref;
	}

	private async fetch(ref: ToolRef): Promise<ToolAttachment> {
		const { jira, gitlab } = this.connections.connectors;
		switch (ref.tool) {
			case 'jira': {
				if (!jira) {
					return placeholderAttachment(ref);
				}
				const issue = await jira.issue(ref.key);
				const text = [
					`Jira ticket ${issue.key}: ${issue.summary} (${issue.url})`,
					`${issue.type ?? 'Ticket'} · ${issue.status}${issue.priority ? ` · ${issue.priority}` : ''}${issue.fixVersions.length ? ` · fix version ${issue.fixVersions.join(', ')}` : ''}`,
					'',
					cut(issue.description.trim() || '(no description)', 12_000),
					...issue.comments.length ? ['', 'Latest comments:', ...issue.comments.map(c => `- ${c.author}: ${cut(c.body.trim(), 1000)}`)] : [],
					...issue.links.length ? ['', 'Links:', ...issue.links.map(l => `- ${l}`)] : [],
				].join('\n');
				return toolAttachment(ref, `${issue.key} ${issue.summary}`, text);
			}
			case 'gitlab': {
				if (!gitlab) {
					return placeholderAttachment(ref);
				}
				if (ref.kind === 'issue') {
					const issue = await gitlab.issue(ref.project, ref.iid);
					return toolAttachment(ref, `#${ref.iid} ${issue.title}`, `GitLab issue #${ref.iid}: ${issue.title} (${issue.url}) · ${issue.state}\n\n${cut(issue.description, 12_000)}`);
				}
				const [mr, discussions] = await Promise.all([gitlab.mr(ref.project, ref.iid), gitlab.discussions(ref.project, ref.iid).catch(() => [])]);
				return toolAttachment(ref, `!${mr.iid} ${mr.title}`, `${describeMr(mr, discussions, [])}\n\nFor the diff, call gitlab_get_mr with ${ref.url}.`);
			}
			case 'figma':
				return placeholderAttachment(ref);
			case 'confluence': {
				// Read as an agent reads it (confluence_get_page), from Confluence's own bundle, loaded now if it wasn't.
				const confluence = this.connections.confluence();
				if (!confluence) {
					return placeholderAttachment(ref);
				}
				const result = await confluence.call('confluence_get_page', { link: ref.url });
				const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n');
				if (result.isError) {
					throw new Error(text || vscode.l10n.t("Confluence didn't return the page."));
				}
				// The page's first line is "Title (link)", inside the frame that marks it as someone else's text.
				const title = /^(?:<external[^>]*>\n)?(.+?) \(https?:\/\//.exec(text)?.[1];
				return toolAttachment(ref, title ?? toolRefLabel(ref), text);
			}
		}
	}
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function toolAttachment(ref: ToolRef, name: string, text: string): ToolAttachment {
	return { kind: 'document', name, mimeType: 'text/plain', text, tool: ref.tool, ref: toolRefId(ref) };
}

/** A chip whose item wasn't (or isn't yet) read: its note tells the agent which tool reads it. */
export function placeholderAttachment(ref: ToolRef, problem?: string): ToolAttachment {
	const why = problem ? ` GeminiCode couldn't read it: ${problem}` : '';
	switch (ref.tool) {
		case 'jira':
			return toolAttachment(ref, ref.key, `Jira ticket ${ref.key}.${why} Read it with jira_get_issue.`);
		case 'gitlab':
			return toolAttachment(ref, toolRefLabel(ref), `GitLab ${ref.kind === 'mr' ? 'merge request' : 'issue'} ${ref.url}.${why} Read it with ${ref.kind === 'mr' ? 'gitlab_get_mr' : 'gitlab_get_issue'}.`);
		case 'figma':
			return toolAttachment(ref, vscode.l10n.t("Figma frame {0}", ref.nodeId ?? ''), `Figma frame: ${ref.url}\nCall figma_design with this link for its code hints and design variables. Call figma_screenshot only when you need to see it, such as to compare what you built.${why}`);
		case 'confluence':
			return toolAttachment(ref, vscode.l10n.t("Confluence page {0}", ref.pageId), `Confluence page ${ref.url}.${why} Read it with confluence_get_page.`);
	}
}

/** The sizes `gemini.figma.viewports` names, when it names any: the team's defaults outrank it. */
function userDesignSizes(): readonly string[] | undefined {
	const sizes = vscode.workspace.getConfiguration('gemini').get<unknown>('figma.viewports');
	const names = Array.isArray(sizes) ? sizes.filter((size): size is string => typeof size === 'string' && !!size.trim()).map(size => size.trim()) : [];
	return names.length ? names : undefined;
}

const instances = new WeakMap<TeamConnections, ToolChips>();

/** The one ToolChips for `connections`, so every chat shares its cache. */
export function toolChipsFor(connections: TeamConnections): ToolChips {
	let chips = instances.get(connections);
	if (!chips) {
		chips = new ToolChips(connections);
		instances.set(connections, chips);
	}
	return chips;
}
