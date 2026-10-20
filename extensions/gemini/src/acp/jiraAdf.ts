/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Jira's rich text (Atlassian Document Format) for comments posted from
// Home: its shape, and what the extension adds to a comment the comment box
// wrote (webview-src/commentAdf.ts makes the document from Markdown).

/** A node of Atlassian Document Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ */
export interface AdfNode {
	readonly type: string;
	readonly attrs?: Readonly<Record<string, unknown>>;
	readonly content?: readonly AdfNode[];
	readonly text?: string;
	readonly marks?: readonly AdfMark[];
}

/** A whole ADF document, the `body` of a comment. */
export interface AdfDocument {
	readonly type: 'doc';
	readonly version: 1;
	readonly content: readonly AdfNode[];
}

export interface AdfMark {
	readonly type: 'strong' | 'em' | 'strike' | 'code' | 'link';
	readonly attrs?: Readonly<Record<string, unknown>>;
}

/** Someone picked with @ in the box: written as `@Display Name` in the text. */
export interface CommentMention {
	readonly accountId: string;
	readonly name: string;
}

/** A file uploaded to the ticket with the comment, listed under it. */
export interface CommentAttachment {
	readonly name: string;
	/** Where Jira serves it, such as https://acme.atlassian.net/rest/api/3/attachment/content/10001. */
	readonly url?: string;
}

/** Whether `value` is a comment document as the comment box sends it. */
export function isAdfDocument(value: unknown): value is AdfDocument {
	const doc = value as Partial<AdfDocument> | undefined;
	return !!doc && doc.type === 'doc' && doc.version === 1 && Array.isArray(doc.content);
}

/** `doc` with the files attached to the ticket listed at its end. */
export function appendAttachments(doc: AdfDocument, attachments: readonly CommentAttachment[]): AdfDocument {
	return attachments.length ? { ...doc, content: [...doc.content, attachmentsParagraph(attachments)] } : doc;
}

/** "Attached: a.png, b.log", each name linked to the file on the ticket. */
function attachmentsParagraph(attachments: readonly CommentAttachment[]): AdfNode {
	const content: AdfNode[] = [{ type: 'text', text: 'Attached: ' }];
	attachments.forEach((file, i) => {
		if (i) {
			content.push({ type: 'text', text: ', ' });
		}
		content.push({ type: 'text', text: file.name, ...file.url ? { marks: [{ type: 'link', attrs: { href: file.url } }] } : {} });
	});
	return { type: 'paragraph', content };
}
