/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { isSafeLink } from '../../webview-src/linkPolicy';

describe('Markdown links', () => {
	it('allows only web and mail links, and shows others as text', () => {
		const markdown = new MarkdownIt({ html: false, linkify: true });
		markdown.validateLink = isSafeLink;
		expect(markdown.render('[docs](https://example.com) [mail](mailto:a@b.c) [x](geminicode://gemini-fork.gemini/open?a=1) [y](vscode://file/etc/passwd) [z](file:///etc/passwd) www.example.com').trim()).toBe(
			'<p><a href="https://example.com">docs</a> <a href="mailto:a@b.c">mail</a> [x](geminicode://gemini-fork.gemini/open?a=1) [y](vscode://file/etc/passwd) [z](file:///etc/passwd) <a href="http://www.example.com">www.example.com</a></p>');
	});
});
