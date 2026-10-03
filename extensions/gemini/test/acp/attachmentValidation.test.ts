/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Attachment, maxDocumentTextBytes, maxImageBase64Length } from '../../src/acp/attachments';
import { isValidAttachment } from '../../src/acp/attachmentValidation';

const valid = (attachment: unknown) => isValidAttachment(attachment as Attachment);

describe('isValidAttachment', () => {
	it('accepts files and selections with absolute paths only', () => {
		expect(valid({ kind: 'file', path: '/repo/a.ts' })).toBe(true);
		expect(valid({ kind: 'file', path: 'a.ts' })).toBe(false);
		expect(valid({ kind: 'selection', path: '/repo/a.ts', text: 'x', range: { start: 1, end: 1 } })).toBe(true);
		expect(valid({ kind: 'selection', path: '/repo/a.ts' })).toBe(false);
	});

	it('accepts supported images within the size limit', () => {
		expect(valid({ kind: 'image', mimeType: 'image/png', data: 'AAAA' })).toBe(true);
		expect(valid({ kind: 'image', mimeType: 'image/gif', data: 'AAAA' })).toBe(false);
		expect(valid({ kind: 'image', mimeType: 'image/png', data: 'A'.repeat(maxImageBase64Length + 1) })).toBe(false);
	});

	it('accepts text documents within the limit and only images and PDFs inline', () => {
		expect(valid({ kind: 'document', name: 'notes.md', mimeType: 'text/markdown', text: '# hi' })).toBe(true);
		expect(valid({ kind: 'document', name: 'notes.md', mimeType: 'text/markdown', text: 'x'.repeat(maxDocumentTextBytes + 1) })).toBe(false);
		expect(valid({ kind: 'document', name: 'spec.pdf', mimeType: 'application/pdf', data: 'AAAA' })).toBe(true);
		expect(valid({ kind: 'document', name: 'archive.zip', mimeType: 'application/zip', data: 'AAAA' })).toBe(false);
		expect(valid({ kind: 'document', name: 'a.md', mimeType: 'text/markdown', path: 'relative.md', text: '' })).toBe(false);
	});

	it('rejects unknown kinds and missing values', () => {
		expect(valid({ kind: 'script' })).toBe(false);
		expect(valid(undefined)).toBe(false);
	});
});
