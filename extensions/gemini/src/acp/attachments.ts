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
	| { readonly kind: 'image'; readonly name: string; readonly mimeType: string; /** Base64, no data: prefix. */ readonly data: string };

/** Image types Gemini accepts inline. */
export const supportedImageTypes: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** Largest image sent inline, in base64 characters (about 7.5 MB of image). */
export const maxImageBase64Length = 10 * 1024 * 1024;

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
		case 'image': return attachment.name;
	}
}

