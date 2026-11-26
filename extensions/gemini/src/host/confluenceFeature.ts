/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Confluence for agents and the Review Page, in a bundle of its own loaded the
// first time Confluence is used (src/confluence.ts). Agents search and read
// pages, and draft pages: a draft is kept on disk and opens in the Review
// Page, and nothing reaches Confluence until the user publishes it there.
// Publishing goes through the team tools' audited write (`confluence_publish`),
// which calls back into `publish` here.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfluenceClient, ConfluenceConflictError, ConfluencePage, confluencePageId, describePage } from '../acp/confluence';
import { blockChanges } from '../acp/blockMerge';
import { ConfluenceDraft, DraftStore, DraftTarget } from '../acp/confluenceDrafts';
import { confluenceSafe, publishBlocks } from '../acp/draftReview';
import { external } from '../acp/externalText';
import { clip, hostOf, type TeamRequest } from '../acp/teamHttp';
import type { ConfluenceAccount, ConfluenceTools, TeamToolResult, TeamWriteResult } from '../acp/teamTools';
import { agentColumn } from './editorPlacement';
import { ConfluenceReviewPage, confluenceErrorText } from './confluenceReviewPage';

export interface ConfluenceDeps {
	readonly extensionUri: vscode.Uri;
	/** Where drafts are kept. */
	readonly storageDir: string;
	/** The Confluence sites turned on now. */
	accounts(): readonly ConfluenceAccount[];
	/** The extension's own `teamRequest` for Confluence, so reachability is one state for every page. */
	request<T>(url: string, request?: TeamRequest): Promise<T>;
	/** Publishes through the team tools' audited write, which comes back to `publish`. */
	write(name: string, args: Record<string, unknown>): Promise<TeamWriteResult>;
	/** Opens a link as Home opens team links (the extension's `openTeamLink`). */
	openLink(url: string): Promise<void>;
	/** The agent whose tab is in front, if any: only then does a draft open in that agent's side group. */
	agentInFront?(): string | undefined;
	readonly log: vscode.LogOutputChannel;
}

export class ConfluenceFeature implements ConfluenceTools, vscode.Disposable {

	readonly drafts: DraftStore;
	private readonly pages = new Map<string, ConfluenceReviewPage>();
	/** Each draft's saves and publish, one after another: a publish never reads a draft a save is still writing. */
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly deps: ConfluenceDeps) {
		this.drafts = new DraftStore(path.join(deps.storageDir, 'confluence-drafts'));
	}

	openDraft(id?: string): Promise<void> {
		return id ? this.open(id) : this.pickDraft();
	}

	dispose(): void {
		for (const page of this.pages.values()) {
			page.dispose();
		}
	}

	async call(name: string, args: Record<string, unknown>, agent?: string): Promise<TeamToolResult> {
		switch (name) {
			case 'confluence_search': return this.search(str(args.query) ?? '', str(args.space));
			case 'confluence_get_page': return this.getPage(str(args.link) ?? '');
			case 'confluence_draft_page': return this.draft(args, agent);
			case 'confluence_publish': return this.publish(str(args.draft) ?? '', str(args.title) ?? '');
		}
		return fail(`No tool named ${name}.`);
	}

	/**
	 * Opens a draft's Review Page: in `agent`'s side group when the agent
	 * drafting it is open, else (and from the Confluence Drafts command) in the
	 * active group, as everything Home opens.
	 */
	async open(id: string, agent?: string): Promise<void> {
		const existing = this.pages.get(id);
		if (existing) {
			existing.reveal();
			return;
		}
		const draft = await this.drafts.get(id);
		if (!draft) {
			void vscode.window.showWarningMessage(vscode.l10n.t("That draft was published or discarded."));
			return;
		}
		// Beside the agent only when its tab is in front: else its side group is hidden, and the column beside the active one would split Home.
		const besideAgent = agent && this.deps.agentInFront?.() === agent ? await agentColumn(agent, undefined) : vscode.ViewColumn.Active;
		const column = besideAgent === vscode.ViewColumn.Beside ? vscode.ViewColumn.Active : besideAgent;
		const page = new ConfluenceReviewPage(this.deps.extensionUri, draft, column, {
			load: () => this.drafts.get(id),
			save: (title, document, review) => this.serial(id, async () => void await this.drafts.save({ ...await this.current(id), title, saved: document, review })),
			publish: (title, document, review) => this.serial(id, async () => {
				await this.drafts.save({ ...await this.current(id), title, saved: document, review });
				return this.deps.write('confluence_publish', { draft: id, title, site: hostOf(draft.site), ...draft.target.kind === 'edit' ? { page: draft.target.pageId } : {} });
			}),
			rebase: (title, document, review, version, base) => this.serial(id, async () => {
				const current = await this.current(id);
				if (current.target.kind === 'edit') {
					await this.drafts.save({ ...current, title, saved: document, review, target: { ...current.target, baseVersion: version, base } });
				}
			}),
			discard: () => this.serial(id, () => this.drafts.remove(id)),
			open: url => this.deps.openLink(url),
		});
		this.pages.set(id, page);
		page.onDidDispose(() => this.pages.delete(id));
	}

	/** Runs `work` on draft `id` after the draft's earlier work, whether that went through or not. */
	private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
		const run = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
		const done = run.catch(() => undefined);
		this.queues.set(id, done);
		void done.then(() => {
			if (this.queues.get(id) === done) {
				this.queues.delete(id);
			}
		});
		return run;
	}

	private async current(id: string): Promise<ConfluenceDraft> {
		const draft = await this.drafts.get(id);
		if (!draft) {
			throw new Error(vscode.l10n.t("That draft was published or discarded."));
		}
		return draft;
	}

	private async pickDraft(): Promise<void> {
		const drafts = await this.drafts.list();
		if (!drafts.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("No Confluence drafts are waiting for review."));
			return;
		}
		const picked = await vscode.window.showQuickPick(drafts.map(draft => ({ label: draft.title, description: hostOf(draft.site), detail: draft.target.kind === 'edit' ? vscode.l10n.t("New version of a page") : vscode.l10n.t("New page in {0}", draft.target.spaceKey), id: draft.id })), { title: vscode.l10n.t("Confluence Drafts") });
		if (picked) {
			await this.open(picked.id);
		}
	}

	private client(account: ConfluenceAccount): ConfluenceClient {
		return new ConfluenceClient(account, (url, request) => this.deps.request(url, request));
	}

	/**
	 * The site a page link points at, by host; for a bare page id, the only
	 * site. A link to a site that isn't connected is never taken for a page of
	 * another site, which would have an unrelated page of the same id.
	 */
	private accountFor(link: string): ConfluenceAccount | string {
		const accounts = this.deps.accounts();
		if (/^https?:\/\//i.test(link.trim())) {
			const host = hostOf(link.trim());
			return accounts.find(account => hostOf(account.site) === host)
				?? `${host} isn't a connected Confluence site (connected: ${accounts.map(a => hostOf(a.site)).join(', ') || 'none'}). Ask the user to connect it in GeminiCode's Connections page, or use a page on a connected site.`;
		}
		return accounts.length === 1 ? accounts[0] : 'Give the page\'s full link: more than one Confluence site is connected.';
	}

	private async search(query: string, space?: string): Promise<TeamToolResult> {
		if (!query.trim()) {
			return fail('Give words to find, or a CQL query.');
		}
		const accounts = this.deps.accounts();
		const results = await Promise.allSettled(accounts.map(async account => ({ account, pages: await this.client(account).search(query, space) })));
		const found = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
		if (!found.length) {
			const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
			return fail(failed ? errorText(failed.reason) : 'No Confluence site answered.');
		}
		const lines = found.flatMap(({ account, pages }) => pages.map(page => `- ${page.title}${page.space ? ` (${page.space}${accounts.length > 1 ? `, ${account.name}` : ''})` : ''} ${page.url}${page.excerpt ? `\n  ${clip(page.excerpt.replace(/\s+/g, ' '), 300)}` : ''}`));
		return ok(lines.length ? external('confluence', 'search', lines.join('\n')) : 'No pages match.');
	}

	private async getPage(link: string): Promise<TeamToolResult> {
		const id = confluencePageId(link);
		if (!id) {
			return fail('That isn\'t a Confluence page link. Copy it from the page\'s address bar or Share menu.');
		}
		const account = this.accountFor(link);
		if (typeof account === 'string') {
			return fail(account);
		}
		const page = await this.client(account).page(id);
		return ok(external('confluence', page.url, clip(describePage(page), 40_000)));
	}

	private async draft(args: Record<string, unknown>, agent: string | undefined): Promise<TeamToolResult> {
		const title = str(args.title)?.trim();
		const markdown = str(args.markdown) ?? '';
		const pageLink = str(args.page);
		if (!title || !markdown.trim()) {
			return fail('Give the page a title and its Markdown.');
		}
		let account: ConfluenceAccount | undefined;
		let target: DraftTarget;
		if (pageLink) {
			const id = confluencePageId(pageLink);
			if (!id) {
				return fail('`page` isn\'t a Confluence page link.');
			}
			const found = this.accountFor(pageLink);
			if (typeof found === 'string') {
				return fail(found);
			}
			account = found;
			const page = await this.client(account).page(id);
			target = { kind: 'edit', pageId: page.id, url: page.url, baseVersion: page.version, baseTitle: page.title, base: page.body };
		} else {
			const spaceKey = str(args.space)?.trim().toUpperCase();
			if (!spaceKey) {
				return fail('Give the space key for a new page (`space`), or the link of the page this is a new version of (`page`).');
			}
			const parentLink = str(args.parent);
			const parentSite = parentLink ? this.accountFor(parentLink) : undefined;
			if (typeof parentSite === 'string' && /^https?:\/\//i.test(parentLink!.trim())) {
				return fail(parentSite);
			}
			const found = await this.findSpace(spaceKey, typeof parentSite === 'string' ? undefined : parentSite);
			if (!found) {
				return fail(`No Confluence site you can write to has the space ${spaceKey}.`);
			}
			account = found.account;
			let parent: ConfluencePage | undefined;
			const parentId = parentLink ? confluencePageId(parentLink) : undefined;
			if (parentId) {
				parent = await this.client(account).page(parentId);
			}
			target = { kind: 'new', spaceId: found.space.id, spaceKey: found.space.key, spaceName: found.space.name, ...parent ? { parentId: parent.id, parentTitle: parent.title } : {} };
		}
		const now = new Date().toISOString();
		const draft = await this.drafts.save({ id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, site: account.site, target, title, markdown, ...agent ? { agent } : {}, createdAt: now });
		this.deps.log.info(`Drafted a Confluence page for review: ${title}`);
		void this.open(draft.id, agent).catch(err => this.deps.log.warn(`The Review Page didn't open: ${errorText(err)}`));
		return ok(`Drafted "${title}" for the user's review. It opened in GeminiCode's Review Page and isn't on Confluence: the user edits it there and publishes it, or discards it. Don't draft it again unless they ask.`);
	}

	/** The space `key` on `site`, the parent page's site, else on the first connected site that has it. */
	private async findSpace(key: string, site: ConfluenceAccount | undefined): Promise<{ account: ConfluenceAccount; space: { id: string; key: string; name: string } } | undefined> {
		for (const account of site ? [site] : this.deps.accounts()) {
			const spaces = await this.client(account).spaces([key]).catch(() => []);
			if (spaces[0]) {
				return { account, space: spaces[0] };
			}
		}
		return undefined;
	}

	/**
	 * Publishes draft `id` (as the user last saved it) as `title`: a new page,
	 * or a new version of its page with only the changes the user kept, when
	 * nobody saved the page since. Called by the team tools' audited write. A
	 * conflict fails without writing and gives the latest version, for the
	 * Review Page to merge. What fails is said in the user's words: only the
	 * Review Page calls this.
	 */
	private async publish(id: string, title: string): Promise<TeamToolResult> {
		const draft = await this.drafts.get(id);
		if (!draft?.saved) {
			return fail(vscode.l10n.t("That draft was published or discarded."));
		}
		const account = this.deps.accounts().find(a => hostOf(a.site) === hostOf(draft.site));
		if (!account) {
			return fail(vscode.l10n.t("Confluence on {0} isn't connected. Turn it on in Connections.", hostOf(draft.site)));
		}
		if (draft.review?.conflicts?.length) {
			return fail(vscode.l10n.t("Pick a version for each part you both changed, then publish."));
		}
		const client = this.client(account);
		const target = draft.target;
		try {
			const page = target.kind === 'new'
				? await client.createPage({ spaceId: target.spaceId, ...target.parentId ? { parentId: target.parentId } : {}, title: title || draft.title, body: { type: 'doc', version: 1, content: confluenceSafe(draft.saved.content) } })
				: await client.updatePage(target.pageId, {
					title: title || draft.title,
					body: { type: 'doc', version: 1, content: confluenceSafe(publishBlocks(blockChanges(target.base.content, draft.saved.content), new Set(draft.review?.kept))) },
					baseVersion: target.baseVersion,
				});
			await this.drafts.remove(id);
			return ok(vscode.l10n.t("Published \"{0}\" to Confluence.", page.title), `page ${page.id} version ${page.version}`, { url: page.url, version: page.version });
		} catch (err) {
			if (err instanceof ConfluenceConflictError) {
				this.pages.get(id)?.conflict(err.current.body, err.current.version);
				return { ...fail(confluenceErrorText(err)), data: { conflict: 'true', version: err.current.version } };
			}
			// A write that got no answer may have gone through: the audit record stays open (`TeamToolError`'s detail, read by shape as it comes from the extension's bundle).
			return { ...fail(confluenceErrorText(err)), ...(err as { detail?: { unsure?: boolean } } | undefined)?.detail?.unsure ? { unsure: true } : {} };
		}
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function ok(text: string, remote?: string, data?: Readonly<Record<string, string | number>>): TeamToolResult {
	return { content: [{ type: 'text', text }], ...remote ? { remote } : {}, ...data ? { data } : {} };
}

function fail(text: string): TeamToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

