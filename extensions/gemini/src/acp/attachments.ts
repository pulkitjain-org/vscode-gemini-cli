/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Context the user attaches to a prompt. Shared with the webview, so this
// module must not import Node or VS Code.

export type Attachment =
	| { readonly kind: 'file'; readonly path: string }
	| {
		readonly kind: 'selection'; readonly path: string; readonly text: string;
		/** 1-based and inclusive. */
		readonly startLine: number; readonly endLine: number;
		readonly languageId?: string;
	}
	| { readonly kind: 'image'; readonly name: string; readonly mimeType: string; /** Base64, no data: prefix. */ readonly data: string }
	/**
	 * A file sent with its contents, for files the agent cannot read itself:
	 * ones from outside the workspace, or dropped from Finder (which have no
	 * path). Text files carry `text`; PDFs carry base64 `data`.
	 */
	| {
		readonly kind: 'document'; readonly name: string; readonly mimeType: string;
		readonly path?: string; readonly text?: string; readonly data?: string;
	};

/** Image types Gemini accepts inline. */
export const supportedImageTypes: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** Largest image sent inline, in base64 characters (about 7.5 MB of image). */
export const maxImageBase64Length = 10 * 1024 * 1024;

/** Largest text file sent with its contents, in bytes. */
export const maxDocumentTextBytes = 1024 * 1024;

/** How a file can be sent with its contents. */
export type FileContent =
	/** As text. */
	| { readonly kind: 'text'; readonly text: string }
	/** As is, base64 encoded: an image or PDF, which Gemini reads itself. */
	| { readonly kind: 'inline'; readonly mimeType: string }
	| { readonly kind: 'tooLarge' }
	/** Not text, and not a type Gemini reads inline. */
	| { readonly kind: 'unsupported' };

const inlineTypesByExtension: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	heic: 'image/heic',
	heif: 'image/heif',
};

/** The type of an image or PDF, from its reported type or else its name. */
export function inlineType(name: string, reportedType: string): string | undefined {
	const type = reportedType || inlineTypesByExtension[name.split('.').pop()?.toLowerCase() ?? ''] || '';
	return supportedImageTypes.has(type) || type === 'application/pdf' ? type : undefined;
}

/** Decides how to send a file with its contents. Works in the webview and the extension host. */
export function classifyFile(name: string, reportedType: string, bytes: Uint8Array): FileContent {
	const type = inlineType(name, reportedType);
	if (type) {
		return Math.ceil(bytes.length / 3) * 4 > maxImageBase64Length ? { kind: 'tooLarge' } : { kind: 'inline', mimeType: type };
	}
	// Text has no NUL bytes; nearly every binary format has some early on.
	if (bytes.subarray(0, 8192).includes(0)) {
		return { kind: 'unsupported' };
	}
	if (bytes.length > maxDocumentTextBytes) {
		return { kind: 'tooLarge' };
	}
	return { kind: 'text', text: new TextDecoder().decode(bytes) };
}

export function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() || filePath;
}

/** Short label for chips and the transcript, such as `app.ts` or `app.ts:10-20`. */
export function attachmentLabel(attachment: Attachment): string {
	switch (attachment.kind) {
		case 'file': return basename(attachment.path);
		case 'selection': return attachment.startLine === attachment.endLine
			? `${basename(attachment.path)}:${attachment.startLine}`
			: `${basename(attachment.path)}:${attachment.startLine}-${attachment.endLine}`;
		case 'image':
		case 'document': return attachment.name;
	}
}

