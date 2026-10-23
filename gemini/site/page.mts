/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What every page shares: the Dark · Light · System switch, the screenshot swap that goes with
// it, the nav's scrolled state and phone menu, and the reveals that IntersectionObserver
// triggers once. Served as plain JavaScript (build.mts strips the types).

type Mode = 'dark' | 'light' | 'system';

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const systemDark = matchMedia('(prefers-color-scheme: dark)');

/** The switch's position: the stored choice, else System. */
function currentMode(): Mode {
	return root.dataset.theme === 'dark' || root.dataset.theme === 'light' ? root.dataset.theme : 'system';
}

/** The theme the page shows now, after System is resolved. */
function pageTheme(): 'dark' | 'light' {
	const mode = currentMode();
	return mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : mode;
}

const switches = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-set]')];

function markSwitches(): void {
	const mode = currentMode();
	for (const button of switches) {
		button.setAttribute('aria-pressed', String(button.dataset.themeSet === mode));
	}
}

function announceTheme(): void {
	root.dispatchEvent(new CustomEvent('themechange', { detail: pageTheme() }));
}

/** Applies a choice: page colours crossfade, every product shot swaps to its dark or light file. */
function setMode(mode: Mode): void {
	if (mode === currentMode()) {
		return;
	}
	const apply = () => {
		if (mode === 'system') {
			delete root.dataset.theme;
		} else {
			root.dataset.theme = mode;
		}
		markSwitches();
		announceTheme();
	};
	try {
		localStorage.setItem('theme', mode);
	} catch {
		// Private windows can refuse storage; the switch still works for this visit.
	}
	if (reduceMotion.matches) {
		apply();
		return;
	}
	// Shots fade out, the colours and files change, then the shots fade back in.
	root.classList.add('theming');
	setTimeout(() => {
		apply();
		setTimeout(() => root.classList.remove('theming'), 60);
	}, 200);
}

for (const button of switches) {
	button.addEventListener('click', () => setMode(button.dataset.themeSet as Mode));
}
markSwitches();
systemDark.addEventListener('change', () => {
	if (currentMode() === 'system') {
		announceTheme();
	}
});

// ---- Nav: scrolled state and the phone menu ----

const top = document.querySelector<HTMLElement>('.top');
if (top) {
	let queued = false;
	const update = () => {
		queued = false;
		top.classList.toggle('scrolled', scrollY > 40);
	};
	addEventListener('scroll', () => {
		if (!queued) {
			queued = true;
			requestAnimationFrame(update);
		}
	}, { passive: true });
	update();
}

const menuButton = document.querySelector<HTMLButtonElement>('.menu-btn');
const menu = document.querySelector<HTMLElement>('.menu');
if (menuButton && menu) {
	menu.querySelectorAll<HTMLElement>('a').forEach((link, i) => link.style.setProperty('--i', String(i)));
	menuButton.addEventListener('click', () => {
		const open = !menu.hasAttribute('data-open');
		menu.toggleAttribute('data-open', open);
		menuButton.setAttribute('aria-expanded', String(open));
	});
	menu.addEventListener('click', event => {
		if ((event.target as HTMLElement).closest('a')) {
			menu.removeAttribute('data-open');
			menuButton.setAttribute('aria-expanded', 'false');
		}
	});
}

// ---- The Features menu: opens on click, closes on Escape, a click outside or leaving it ----

const featureButton = document.querySelector<HTMLButtonElement>('.fm-btn');
const featurePanel = document.querySelector<HTMLElement>('.fm-panel');
if (featureButton && featurePanel) {
	const items = () => [...featurePanel.querySelectorAll<HTMLAnchorElement>('a')];
	const show = (open: boolean, focus = false) => {
		featurePanel.hidden = !open;
		featureButton.setAttribute('aria-expanded', String(open));
		if (open && focus) {
			items()[0]?.focus();
		}
	};
	featureButton.addEventListener('click', () => show(featurePanel.hidden));
	featureButton.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			show(true, true);
		}
	});
	featurePanel.addEventListener('keydown', event => {
		const list = items();
		const at = list.indexOf(document.activeElement as HTMLAnchorElement);
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
		}
	});
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape' && !featurePanel.hidden) {
			show(false);
			featureButton.focus();
		}
	});
	document.addEventListener('click', event => {
		if (!featurePanel.hidden && !(event.target as HTMLElement).closest('.fmenu')) {
			show(false);
		}
	});
	featurePanel.addEventListener('focusout', event => {
		if (!(event.relatedTarget as HTMLElement | null)?.closest('.fmenu')) {
			show(false);
		}
	});
}

// ---- Reveals: each element enters once, siblings 60ms apart, capped at six ----

const revealed = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
for (const group of document.querySelectorAll<HTMLElement>('[data-stagger]')) {
	[...group.children].forEach((child, i) => (child as HTMLElement).style.setProperty('--d', `${Math.min(i, 5) * 60}ms`));
}
if ('IntersectionObserver' in window && revealed.length) {
	const observer = new IntersectionObserver(entries => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				entry.target.classList.add('in');
				observer.unobserve(entry.target);
			}
		}
	}, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
	revealed.forEach(element => observer.observe(element));
} else {
	revealed.forEach(element => element.classList.add('in'));
}

// ---- Copy buttons: the icon becomes a tick and the label reads Copied for 1.5 seconds ----

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-md]')) {
	const label = button.querySelector<HTMLElement>('.copy-label');
	const original = label?.textContent ?? '';
	let reset = 0;
	const say = (words: string, copied: boolean) => {
		if (label) {
			label.textContent = words;
		}
		button.classList.toggle('copied', copied);
		clearTimeout(reset);
		reset = setTimeout(() => {
			if (label) {
				label.textContent = original;
			}
			button.classList.remove('copied');
		}, 1500);
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
			say('Copied', true);
		} catch {
			say('Couldn\'t copy', false);
		}
	});
}

export { pageTheme };
