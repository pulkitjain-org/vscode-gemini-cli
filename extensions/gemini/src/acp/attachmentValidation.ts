/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { Attachment, inlineType, maxDocumentTextBytes, maxImageBase64Length, supportedImageTypes } from './attachments';

/**
 * Whether an attachment sent by the chat view is well formed. The view is
 * untrusted input, so this runs before anything is sent to the agent.
 */
export function isValidAttachment(attachment: Attachment): boolean {
	switch (attachment?.kind) {
		case 'file': return typeof attachment.path === 'string' && path.isAbsolute(attachment.path);
		case 'selection': return typeof attachment.path === 'string' && path.isAbsolute(attachment.path) && typeof attachment.text === 'string';
		case 'image': return supportedImageTypes.has(attachment.mimeType) && typeof attachment.data === 'string' && attachment.data.length <= maxImageBase64Length;
		case 'document':
			return typeof attachment.name === 'string' && typeof attachment.mimeType === 'string'
				&& (attachment.path === undefined || (typeof attachment.path === 'string' && path.isAbsolute(attachment.path)))
				&& (typeof attachment.text === 'string'
					? attachment.text.length <= maxDocumentTextBytes
					: typeof attachment.data === 'string' && attachment.data.length <= maxImageBase64Length && inlineType(attachment.name, attachment.mimeType) === attachment.mimeType);
		default: return false;
	}
}
