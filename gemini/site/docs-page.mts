/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The docs pages' own behaviour: the search dialog on ⌘K, the page list on phones, the copy
// button on code blocks, "On this page" following the scroll with a sliding rule, the reading
// progress bar, and images that fade in once loaded. Copy as Markdown is in page.mts, shared
// with the release notes. Served as plain JavaScript (build.mts strips the types).

import './page.mts';

// ---- Search: page titles and headings from search.json, in a dialog ----

interface Entry { readonly page: string; readonly heading: string; readonly text: string; readonly url: string }

const dialog = document.querySelector<HTMLDialogElement>('dialog.search');
const searchBase = dialog?.dataset.docsRoot ?? '';
let entries: Promise<Entry[]> | undefined;
const loadEntries = () => entries ??= fetch(`${searchBase}search.json`).then(response => response.json() as Promise<Entry[]>).catch(() => []);

if (dialog) {
	const input = dialog.querySelector('input')!;
	const list = dialog.querySelector<HTMLElement>('.results')!;
	let active = -1;
	const links = () => [...list.querySelectorAll<HTMLAnchorElement>('a')];
	const highlight = (index: number) => {
		const all = links();
		active = all.length ? (index + all.length) % all.length : -1;
		all.forEach((link, i) => link.setAttribute('aria-selected', String(i === active)));
		all[active]?.scrollIntoView({ block: 'nearest' });
	};
	const update = async () => {
		const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) {
			list.replaceChildren();
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
		highlight(0);
	};
	const open = () => {
		if (!dialog.open) {
			void loadEntries();
			dialog.showModal();
			input.select();
		}
	};
	document.querySelectorAll<HTMLButtonElement>('.search-btn').forEach(button => button.addEventListener('click', open));
	input.addEventListener('input', () => void update());
	dialog.querySelector('form')!.addEventListener('submit', event => {
		event.preventDefault();
		links()[active]?.click();
	});
	input.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
		}
	});
	// A click on the dimmed page around the dialog closes it.
	dialog.addEventListener('click', event => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	document.addEventListener('keydown', event => {
		const target = event.target as HTMLElement;
		const typing = /^(INPUT|TEXTAREA)$/.test(target.tagName);
		if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey)) {
			event.preventDefault();
			open();
		}
	});
}

// ---- The page list on phones: one button opens it ----

const picker = document.querySelector<HTMLButtonElement>('.picker');
picker?.addEventListener('click', () => {
	const side = picker.closest<HTMLElement>('.side')!;
	const open = !side.hasAttribute('data-open');
	side.toggleAttribute('data-open', open);
	picker.setAttribute('aria-expanded', String(open));
});

// ---- Code blocks: a Copy button that fades in on hover ----

for (const pre of document.querySelectorAll<HTMLElement>('.doc pre')) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'copy-code';
	button.textContent = 'Copy';
	let reset = 0;
	button.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '');
			button.textContent = 'Copied';
		} catch {
			button.textContent = 'Couldn\'t copy';
		}
		clearTimeout(reset);
		reset = setTimeout(() => (button.textContent = 'Copy'), 1500);
	});
	pre.append(button);
}

// ---- On this page: the rule slides to the section being read; a bar shows reading progress ----

const toc = document.querySelector<HTMLElement>('.toc nav');
const tocLinks = toc ? [...toc.querySelectorAll<HTMLAnchorElement>('a')] : [];
const rule = toc?.querySelector<HTMLElement>('.rule');
const progress = document.querySelector<HTMLElement>('.progress');
if (tocLinks.length || progress) {
	const sections = tocLinks.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1)))).filter(section => section !== null);
	let queued = false;
	const mark = () => {
		queued = false;
		if (progress) {
			const total = document.documentElement.scrollHeight - innerHeight;
			progress.style.transform = `scaleX(${total > 0 ? Math.min(1, scrollY / total) : 0})`;
		}
		if (!tocLinks.length) {
			return;
		}
		let current = 0;
		sections.forEach((section, i) => {
			if (section.getBoundingClientRect().top <= 120) {
				current = i;
			}
		});
		tocLinks.forEach((link, i) => link.classList.toggle('on', i === current));
		const link = tocLinks[current];
		if (rule && link && toc) {
			toc.classList.add('spy');
			rule.style.setProperty('--y', `${link.offsetTop}px`);
			rule.style.height = `${link.offsetHeight}px`;
		}
	};
	addEventListener('scroll', () => {
		if (!queued) {
			queued = true;
			requestAnimationFrame(mark);
		}
	}, { passive: true });
	addEventListener('resize', mark);
	mark();
}

// ---- Images fade in from a surface-coloured frame of the same aspect ratio ----

for (const image of document.querySelectorAll<HTMLImageElement>('.doc figure img')) {
	if (image.complete && image.naturalWidth) {
		image.classList.add('loaded');
	} else {
		image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
		image.addEventListener('error', () => image.classList.add('loaded'), { once: true });
	}
}

