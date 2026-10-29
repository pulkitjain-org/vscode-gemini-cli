/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { sectionsOf } from '../../../src/acp/docs/docsLibrary';
import { htmlToMarkdown } from '../../../src/acp/docs/htmlToMarkdown';

describe('htmlToMarkdown', () => {
	it('keeps the main content as Markdown, without the site\'s chrome or scripts', () => {
		const html = `<!doctype html><html><head><title>useEffect &ndash; React</title><script>alert(1)</script><style>p{}</style></head>
			<body><header><a href="/">React</a></header><nav class="sidebar"><a href="/learn">Learn</a></nav>
			<main><h1>useEffect</h1><p>Lets you <strong>synchronize</strong> a component with an <a href="/learn/external">external system</a>.</p>
			<pre><code class="language-js">useEffect(() =&gt; {
\u0020\u0020connect();
}, []);</code></pre>
			<ul><li>Call it at the top level<ul><li>Not in loops</li></ul></li><li>Return a <code>cleanup</code></li></ul>
			<table><tr><th>Param</th><th>Type</th></tr><tr><td>setup</td><td>function</td></tr></table>
			<div class="feedback">Was this helpful?</div><footer>© Meta</footer></main></body></html>`;
		const page = htmlToMarkdown(html, 'https://react.dev/reference/react/useEffect');
		expect(page.title).toBe('useEffect – React');
		expect(page.markdown).toBe([
			'# useEffect',
			'',
			'Lets you **synchronize** a component with an [external system](https://react.dev/learn/external).',
			'',
			'```js',
			'useEffect(() => {',
			'  connect();',
			'}, []);',
			'```',
			'',
			'- Call it at the top level',
			'  - Not in loops',
			'- Return a `cleanup`',
			'',
			'| Param | Type |',
			'| --- | --- |',
			'| setup | function |',
		].join('\n'));
		expect(page.links).toEqual(['https://react.dev/', 'https://react.dev/learn', 'https://react.dev/learn/external']);
	});

	it('closes paragraphs and list items left open, as browsers do', () => {
		const page = htmlToMarkdown('<body><p>One<p>Two<ul><li>a<li>b</ul></body>', 'https://x.test/');
		expect(page.markdown).toBe('One\n\nTwo\n\n- a\n- b');
	});
});

describe('htmlToMarkdown on hostile pages', () => {
	it('survives tags nested far deeper than any page needs, and many scripts', () => {
		const deep = `<main>${'<div>'.repeat(100_000)}<p>Deep text.</p>${'</div>'.repeat(100_000)}</main>`;
		expect(htmlToMarkdown(deep, 'https://x.dev/').markdown).toBe('Deep text.');
		const scripts = `<main>${'<SCRIPT>var a = 1;</SCRIPT><p>Kept.</p>'.repeat(5_000)}</main>`;
		const started = performance.now();
		const page = htmlToMarkdown(scripts, 'https://x.dev/');
		expect([page.markdown.split('\n\n').length, page.markdown.includes('var a')]).toEqual([5_000, false]);
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe('sectionsOf', () => {
	it('cuts at headings, keeping the headings above each section', () => {
		const markdown = '# Payments\n\nIntro.\n\n## Retries\n\nBackoff.\n\n```sh\n# not a heading\n```\n\n### Limits\n\nFive.\n\n## Refunds\n\nWithin 30 days.';
		expect(sectionsOf(markdown)).toEqual([
			{ heading: 'Payments', text: 'Intro.' },
			{ heading: 'Payments › Retries', text: 'Backoff.\n\n```sh\n# not a heading\n```' },
			{ heading: 'Payments › Retries › Limits', text: 'Five.' },
			{ heading: 'Payments › Refunds', text: 'Within 30 days.' },
		]);
	});
});
