/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The docs pages' own behaviour: Copy as Markdown, the search box, the page
// list on phones, and "On this page" following the scroll. The release notes
// page uses Copy as Markdown too. Served as plain JavaScript (build.mts strips
// the types).

// ---- Copy as Markdown: copies the .md file named by the button ----

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-md]')) {
	const label = button.querySelector<HTMLElement>('.copy-label');
	const original = label?.textContent ?? '';
	let reset = 0;
	const say = (words: string) => {
		if (label) {
			label.textContent = words;
		}
		clearTimeout(reset);
		reset = setTimeout(() => label && (label.textContent = original), 2000);
	};
	const markdown = () => fetch(button.dataset.copyMd ?? '').then(response => {
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.text();
	});
	button.addEventListener('click', async () => {
		try {
			// Safari only copies within the click, so hand it the text as a promise.
			if (typeof ClipboardItem !== 'undefined' && ClipboardItem.supports?.('text/plain') !== false) {
				await navigator.clipboard.write([new ClipboardItem({ 'text/plain': markdown().then(md => new Blob([md], { type: 'text/plain' })) })]);
			} else {
				await navigator.clipboard.writeText(await markdown());
			}
			say('Copied');
		} catch {
			say('Couldn\'t copy');
		}
	});
}

// ---- Search: page titles and headings, from search.json ----

interface Entry { readonly page: string; readonly heading: string; readonly text: string; readonly url: string }

const searchBase = document.querySelector<HTMLElement>('[data-docs-root]')?.dataset.docsRoot ?? '';
let entries: Promise<Entry[]> | undefined;
const loadEntries = () => entries ??= fetch(`${searchBase}search.json`).then(response => response.json() as Promise<Entry[]>).catch(() => []);

for (const box of document.querySelectorAll<HTMLElement>('.search')) {
	const input = box.querySelector('input')!;
	const list = box.querySelector<HTMLElement>('.results')!;
	let active = -1;
	const links = () => [...list.querySelectorAll<HTMLAnchorElement>('a')];
	const highlight = (index: number) => {
		const all = links();
		active = all.length ? (index + all.length) % all.length : -1;
		all.forEach((link, i) => link.setAttribute('aria-selected', String(i === active)));
		all[active]?.scrollIntoView({ block: 'nearest' });
	};
	const close = () => {
		list.hidden = true;
		input.setAttribute('aria-expanded', 'false');
	};
	const update = async () => {
		const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) {
			close();
			return;
		}
		const found = (await loadEntries())
			.map(entry => {
				const haystack = `${entry.page} ${entry.heading} ${entry.text}`.toLowerCase();
				if (!words.every(word => haystack.includes(word))) {
					return undefined;
				}
				const title = `${entry.page} ${entry.heading}`.toLowerCase();
				return { entry, score: words.filter(word => title.includes(word)).length };
			})
			.filter(hit => hit !== undefined)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8);
		list.replaceChildren(...found.map(({ entry }) => {
			const link = document.createElement('a');
			link.href = searchBase + entry.url;
			link.setAttribute('role', 'option');
			const top = document.createElement('b');
			top.textContent = entry.heading ? `${entry.page} › ${entry.heading}` : entry.page;
			const words = document.createElement('span');
			words.textContent = entry.text;
			link.append(top, words);
			return link;
		}));
		if (!found.length) {
			const none = document.createElement('p');
			none.textContent = 'Nothing found. Try other words.';
			list.append(none);
		}
		list.hidden = false;
		input.setAttribute('aria-expanded', 'true');
		highlight(0);
	};
	input.addEventListener('focus', () => void loadEntries());
	input.addEventListener('input', () => void update());
	input.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
		} else if (event.key === 'Enter' && active >= 0) {
			event.preventDefault();
			links()[active]?.click();
		} else if (event.key === 'Escape') {
			input.value = '';
			close();
		}
	});
	document.addEventListener('click', event => {
		if (!box.contains(event.target as Node)) {
			close();
		}
	});
}

// "/" goes to the search box, as on GitHub.
document.addEventListener('keydown', event => {
	const target = event.target as HTMLElement;
	if (event.key === '/' && !event.metaKey && !event.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(target.tagName)) {
		const input = [...document.querySelectorAll<HTMLInputElement>('.search input')].find(box => box.offsetParent !== null);
		if (input) {
			event.preventDefault();
			input.focus();
		}
	}
});

// ---- The page list on phones: one button opens it ----

const picker = document.querySelector<HTMLButtonElement>('.picker');
picker?.addEventListener('click', () => {
	const side = picker.closest('.side')!;
	const open = side.classList.toggle('open');
	picker.setAttribute('aria-expanded', String(open));
});

// ---- On this page: mark the section being read ----

const onPage = [...document.querySelectorAll<HTMLAnchorElement>('.onpage nav a')];
if (onPage.length) {
	const sections = onPage.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1)))).filter(section => section !== null);
	const mark = () => {
		const line = 120;
		let current = 0;
		sections.forEach((section, i) => {
			if (section.getBoundingClientRect().top <= line) {
				current = i;
			}
		});
		onPage.forEach((link, i) => link.classList.toggle('on', i === current));
	};
	addEventListener('scroll', mark, { passive: true });
	mark();
}
