/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Confluence Cloud over its REST API (v2 for pages, v1 for CQL search), with
// the same email and API token as the Jira site it shares. Pages come and go
// as Atlassian Document Format, the editor's format, so nothing is lost
// between reading a page and publishing it again; the model reads them as
// plain text.

import { adfToText } from './jira';
import type { TeamRequest } from './teamHttp';

/** How a call reaches the site: the extension's `teamRequest` for Confluence, so its reachability is shared. */
export type ConfluenceRequest = <T>(url: string, request?: TeamRequest) => Promise<T>;

export interface ConfluenceAuth {
	readonly site: string;
	readonly email: string;
	readonly token: string;
}

export interface ConfluenceSpace {
	readonly id: string;
	readonly key: string;
	readonly name: string;
}

export interface ConfluencePageSummary {
	readonly id: string;
	readonly title: string;
	readonly space?: string;
	readonly url: string;
	readonly excerpt?: string;
	readonly updated?: string;
}

export interface ConfluencePage {
	readonly id: string;
	readonly title: string;
	readonly spaceId: string;
	readonly parentId?: string;
	readonly version: number;
	readonly updated?: string;
	/** Who saved the version, by account id. */
	readonly authorId?: string;
	/** The page in Atlassian Document Format. */
	readonly body: AdfDocument;
	readonly url: string;
}

export interface AdfDocument {
	readonly type: 'doc';
	readonly version: 1;
	readonly content: readonly AdfNode[];
}

export interface AdfNode {
	readonly type: string;
	readonly attrs?: Readonly<Record<string, unknown>>;
	readonly content?: readonly AdfNode[];
	readonly text?: string;
	readonly marks?: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[];
}

/** Publishing would overwrite a newer version: someone saved the page since the draft was made. */
export class ConfluenceConflictError extends Error {
	constructor(readonly current: ConfluencePage) {
		super(`The page changed since the draft was made: version ${current.version} is the latest.`);
		this.name = 'ConfluenceConflictError';
	}
}

/** A CQL field, then an operator: what tells a CQL query from words to find, which may hold `=` or `~` of their own. */
const cqlField = /\b(?:text|title|space|type|label|creator|contributor|mention|ancestor|parent|id|content|created|lastmodified|space\.key|space\.title)\s*(?:!?[=~]|[<>]=?|(?:NOT\s+)?IN\s*\()/i;

/**
 * The CQL search for `text` within `space`: `text` itself when it reads as
 * CQL (a field and an operator, such as `label = runbook`), else a search
 * for its words; newest first unless the query orders itself.
 */
export function cqlQuery(text: string, space?: string): string {
	const inSpace = space ? ` AND space = "${space.replace(/["\\]/g, '')}"` : '';
	if (!cqlField.test(text)) {
		return `type = page AND text ~ "${text.replace(/["\\]/g, ' ')}"${inSpace} ORDER BY lastmodified DESC`;
	}
	const order = /\s+ORDER\s+BY\s+[\s\S]*$/i.exec(text)?.[0] ?? '';
	const where = text.slice(0, text.length - order.length).trim();
	return inSpace ? `(${where})${inSpace}${order}` : text;
}

/** The page id in a Confluence link: /wiki/spaces/KEY/pages/123/Title, ?pageId=123, or /wiki/x/… is not read. */
export function confluencePageId(link: string): string | undefined {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return /^\d+$/.test(link.trim()) ? link.trim() : undefined;
	}
	return /\/pages\/(?:edit-v2\/)?(\d+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('pageId') ?? undefined;
}

export class ConfluenceClient {

	readonly site: string;

	constructor(private readonly auth: ConfluenceAuth, private readonly send: ConfluenceRequest) {
		this.site = auth.site.replace(/\/+$/, '');
	}

	private request<T>(path: string, init: TeamRequest = {}): Promise<T> {
		const basic = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
		return this.send<T>(`${this.site}/wiki${path}`, { ...init, headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', ...init.headers } });
	}

	/** The spaces the user can see, by key. */
	async spaces(keys: readonly string[] = []): Promise<ConfluenceSpace[]> {
		const query = keys.length ? `keys=${keys.map(encodeURIComponent).join(',')}&limit=${keys.length}` : 'limit=100&sort=name';
		const result = await this.request<{ results?: { id: string | number; key: string; name: string }[] }>(`/api/v2/spaces?${query}`);
		return (result?.results ?? []).map(space => ({ id: String(space.id), key: space.key, name: space.name }));
	}

	/** Pages matching `text` (or a CQL query, `cqlQuery`), newest first; within `space` when given. */
	async search(text: string, space?: string, limit = 10): Promise<ConfluencePageSummary[]> {
		const cql = cqlQuery(text, space);
		const result = await this.request<{ results?: { content?: { id?: string; title?: string }; title?: string; url?: string; excerpt?: string; lastModified?: string; resultGlobalContainer?: { title?: string } }[] }>(
			`/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(Math.max(limit, 1), 50)}`);
		return (result?.results ?? []).flatMap(item => item.content?.id ? [{
			id: item.content.id,
			title: item.content.title ?? item.title ?? '',
			...item.resultGlobalContainer?.title ? { space: item.resultGlobalContainer.title } : {},
			url: item.url ? `${this.site}/wiki${item.url}` : this.pageUrl(item.content.id),
			...item.excerpt ? { excerpt: item.excerpt.replace(/@@@(end)?hl@@@/g, '').trim() } : {},
			...item.lastModified ? { updated: item.lastModified } : {},
		}] : []);
	}

	async page(id: string): Promise<ConfluencePage> {
		const raw = await this.request<RawPage>(`/api/v2/pages/${encodeURIComponent(id)}?body-format=atlas_doc_format`);
		return this.pageOf(raw);
	}

	/** Makes a page; `parentId` puts it under another page, else at the space's top. */
	async createPage(page: { readonly spaceId: string; readonly parentId?: string; readonly title: string; readonly body: AdfDocument }): Promise<ConfluencePage> {
		const raw = await this.request<RawPage>('/api/v2/pages', {
			method: 'POST',
			body: { spaceId: page.spaceId, status: 'current', title: page.title, ...page.parentId ? { parentId: page.parentId } : {}, body: { representation: 'atlas_doc_format', value: JSON.stringify(page.body) } },
		});
		return this.pageOf(raw);
	}

	/**
	 * Saves a new version of page `id` made from version `baseVersion`. When
	 * someone saved since, nothing is written and a `ConfluenceConflictError`
	 * carries the latest version, so the user sees it before anything is lost.
	 */
	async updatePage(id: string, page: { readonly title: string; readonly body: AdfDocument; readonly baseVersion: number; readonly message?: string }): Promise<ConfluencePage> {
		const current = await this.page(id);
		if (current.version !== page.baseVersion) {
			throw new ConfluenceConflictError(current);
		}
		try {
			const raw = await this.request<RawPage>(`/api/v2/pages/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body: {
					id, status: 'current', title: page.title,
					body: { representation: 'atlas_doc_format', value: JSON.stringify(page.body) },
					version: { number: page.baseVersion + 1, ...page.message ? { message: page.message } : {} },
				},
			});
			return this.pageOf(raw);
		} catch (err) {
			// Saved between the check and the write: Confluence refuses the version number.
			if ((err as { status?: number }).status === 409) {
				throw new ConfluenceConflictError(await this.page(id));
			}
			throw err;
		}
	}

	pageUrl(id: string): string {
		return `${this.site}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
	}

	private pageOf(raw: RawPage): ConfluencePage {
		let body: AdfDocument = { type: 'doc', version: 1, content: [] };
		try {
			const parsed = JSON.parse(raw.body?.atlas_doc_format?.value ?? '') as AdfDocument;
			if (parsed?.type === 'doc' && Array.isArray(parsed.content)) {
				body = parsed;
			}
		} catch {
			// No body asked for, or an empty page.
		}
		const id = String(raw.id);
		return {
			id,
			title: raw.title ?? '',
			spaceId: String(raw.spaceId ?? ''),
			...raw.parentId ? { parentId: String(raw.parentId) } : {},
			version: raw.version?.number ?? 1,
			...raw.version?.createdAt ? { updated: raw.version.createdAt } : {},
			...raw.version?.authorId ? { authorId: raw.version.authorId } : {},
			body,
			url: raw._links?.webui ? `${this.site}/wiki${raw._links.webui}` : this.pageUrl(id),
		};
	}
}

interface RawPage {
	readonly id: string | number;
	readonly title?: string;
	readonly spaceId?: string | number;
	readonly parentId?: string | number;
	readonly version?: { readonly number?: number; readonly createdAt?: string; readonly authorId?: string };
	readonly body?: { readonly atlas_doc_format?: { readonly value?: string } };
	readonly _links?: { readonly webui?: string };
}

/** A page as the model reads it: its title, where it is, its version, then its text. */
export function describePage(page: ConfluencePage, space?: string): string {
	return [
		`${page.title} (${page.url})`,
		[space ? `Space ${space}` : '', `version ${page.version}`, page.updated ? `updated ${page.updated.slice(0, 10)}` : ''].filter(Boolean).join(' · '),
		'',
		adfToText(page.body).trim() || '(empty page)',
	].join('\n');
}
