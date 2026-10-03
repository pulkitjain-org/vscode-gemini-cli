/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { classifyFile, inlineType, maxDocumentTextBytes } from '../../src/acp/attachments';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('classifyFile', () => {
	it('sends text files as text', () => {
		expect(classifyFile('notes.md', '', utf8('# Héllo\n'))).toEqual({ kind: 'text', text: '# Héllo\n' });
		expect(classifyFile('Makefile', 'application/octet-stream', utf8('all:\n'))).toEqual({ kind: 'text', text: 'all:\n' });
	});

	it('sends PDFs and images as they are, by type or by name', () => {
		expect(classifyFile('spec.pdf', '', utf8('%PDF-1.7\0'))).toEqual({ kind: 'inline', mimeType: 'application/pdf' });
		expect(classifyFile('shot', 'image/png', new Uint8Array([137, 80, 0]))).toEqual({ kind: 'inline', mimeType: 'image/png' });
		expect(classifyFile('PHOTO.JPG', '', new Uint8Array([255, 216, 0]))).toEqual({ kind: 'inline', mimeType: 'image/jpeg' });
	});

	it('turns down other binary files and text over the limit', () => {
		expect(classifyFile('app.zip', 'application/zip', new Uint8Array([80, 75, 3, 4, 0, 0]))).toEqual({ kind: 'unsupported' });
		expect(classifyFile('big.log', '', new Uint8Array(maxDocumentTextBytes + 1).fill(97))).toEqual({ kind: 'tooLarge' });
	});

	it('knows only the types Gemini reads inline', () => {
		expect(inlineType('a.gif', '')).toBeUndefined();
		expect(inlineType('a.heic', '')).toBe('image/heic');
	});
});
