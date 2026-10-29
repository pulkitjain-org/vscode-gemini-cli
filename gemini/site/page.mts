/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What every page shares: the Dark · Light · System switch, the screenshot swap that goes with
// it, the nav's scrolled state and phone menu, the reveals that IntersectionObserver triggers
// once, and the viewer that shows a screenshot at full size. Served as plain JavaScript (build.mts strips the types).

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

// ---- Web fonts: on a session's first page, just after the first paint ----

// The page paints at once in the local fallback faces, which site.css sizes to match the web
// fonts, and the fonts swap in a moment later. Once they are cached, the page's first script
// loads them before the first paint instead (layout() in build.mts).
if (!document.getElementById('fonts')) {
	let loaded = false;
	const loadFonts = () => {
		if (loaded) {
			return;
		}
		loaded = true;
		const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', id: 'fonts', href: new URL('fonts.css', import.meta.url).href });
		link.addEventListener('load', () => void document.fonts.ready.then(() => {
			try {
				sessionStorage.setItem('fonts', '1');
			} catch {
				// Without storage, each page loads the fonts after its first paint.
			}
		}), { once: true });
		document.head.append(link);
	};
	// The browser says when the first text or image painted; without paint timing, two frames on.
	if (PerformanceObserver.supportedEntryTypes?.includes('paint')) {
		const observer = new PerformanceObserver(list => {
			if (list.getEntries().some(entry => entry.name === 'first-contentful-paint')) {
				observer.disconnect();
				loadFonts();
			}
		});
		observer.observe({ type: 'paint', buffered: true });
	} else {
		requestAnimationFrame(() => requestAnimationFrame(loadFonts));
	}
	// A page opened in a background tab gets no first-contentful-paint entry at all.
	const late = () => setTimeout(loadFonts, 1000);
	if (document.readyState === 'complete') {
		late();
	} else {
		addEventListener('load', late, { once: true });
	}
}

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

// ---- Screenshots at full size: a button on each product shot opens it in a dialog ----

/** The image a shot shows now: its light or dark copy, whichever the page's theme leaves visible. */
function shownImage(holder: HTMLElement): HTMLImageElement | undefined {
	return [...holder.querySelectorAll<HTMLImageElement>('img')].find(image => getComputedStyle(image).display !== 'none');
}

function svgIcon(name: string): string {
	return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

let viewer: HTMLDialogElement | undefined;

/** The dialog, made the first time a shot is opened: the caption, Full screen and Close above the image. */
function viewerDialog(): HTMLDialogElement {
	if (viewer) {
		return viewer;
	}
	const dialog = document.createElement('dialog');
	dialog.className = 'viewer';
	dialog.setAttribute('aria-labelledby', 'viewer-cap');
	dialog.innerHTML = `<div class="viewer-bar"><p id="viewer-cap"></p>${document.fullscreenEnabled ? `<button type="button" class="viewer-btn" data-full>${svgIcon('fullscreen')}<span>Full screen</span></button>` : ''}<button type="button" class="viewer-btn" data-close aria-label="Close">${svgIcon('x')}</button></div><img alt="" decoding="async">`;
	const image = dialog.querySelector('img')!;
	const full = dialog.querySelector<HTMLButtonElement>('[data-full]');
	full?.addEventListener('click', () => {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void image.requestFullscreen().catch(() => undefined);
		}
	});
	document.addEventListener('fullscreenchange', () => {
		const label = full?.querySelector('span');
		if (label) {
			label.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
		}
	});
	dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
	// A click beside the image, on the dark ground, closes the viewer.
	dialog.addEventListener('click', event => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	document.body.append(dialog);
	viewer = dialog;
	return dialog;
}

/** Opens `holder`'s shown image in the viewer; focus goes back to `opener` when it closes. */
function openShot(holder: HTMLElement, opener: HTMLElement): void {
	const shown = shownImage(holder);
	if (!shown) {
		return;
	}
	const dialog = viewerDialog();
	const image = dialog.querySelector('img')!;
	// The full file, never the phone-sized copy a srcset may have picked for the page.
	image.src = shown.getAttribute('src') ?? shown.currentSrc;
	image.alt = shown.alt;
	dialog.querySelector('#viewer-cap')!.textContent = shown.alt || holder.closest('figure')?.querySelector('figcaption')?.textContent || 'Screenshot';
	dialog.addEventListener('close', () => opener.focus(), { once: true });
	dialog.showModal();
}

/** Gives `holder` a full-size button, and makes its images open the viewer when clicked. */
function makeZoomable(holder: HTMLElement): void {
	const label = shownImage(holder)?.alt || 'this screenshot';
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'zoom';
	button.setAttribute('aria-label', `View full size: ${label}`);
	button.innerHTML = svgIcon('maximize');
	button.addEventListener('click', () => openShot(holder, button));
	holder.append(button);
	for (const image of holder.querySelectorAll('img')) {
		image.addEventListener('click', () => openShot(holder, button));
	}
	holder.classList.add('can-zoom');
}

// Product shots, but not the orbit's thumbnails or a clip's still, which a play button turns into the clip.
for (const holder of document.querySelectorAll<HTMLElement>('.shot')) {
	if (holder.querySelector('img') && !holder.querySelector('video') && !holder.closest('.thumb, .float') && !holder.querySelector('.clip-play') && !holder.parentElement?.querySelector('.play')) {
		makeZoomable(holder);
	}
}
// Images pasted into the release notes, each wrapped so its button has a corner to sit in.
for (const image of document.querySelectorAll<HTMLImageElement>('.notes img')) {
	const holder = document.createElement('span');
	holder.className = 'zoomable';
	image.replaceWith(holder);
	holder.append(image);
	makeZoomable(holder);
}

// ---- Clips: a still with Play, which loads the clip in the theme the still shows ----

for (const button of document.querySelectorAll<HTMLButtonElement>('.clip-play')) {
	button.addEventListener('click', () => {
		const holder = button.closest<HTMLElement>('.shot');
		const shown = holder && shownImage(holder);
		if (!holder || !shown) {
			return;
		}
		const theme = shown.classList.contains('on-dark') ? 'dark' : 'light';
		const video = document.createElement('video');
		video.controls = true;
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;
		video.poster = shown.getAttribute('src') ?? '';
		video.src = button.dataset[theme] ?? '';
		video.setAttribute('aria-label', shown.alt);
		// The clips have no speech; the empty captions track says so to assistive technology.
		const track = Object.assign(document.createElement('track'), { kind: 'captions', srclang: 'en', label: 'No speech', src: new URL('media/silent.vtt', import.meta.url).href });
		video.append(track);
		holder.style.aspectRatio = '2000 / 1250';
		holder.replaceChildren(video);
		video.focus();
		void video.play().catch(() => undefined);
	});
}

export { pageTheme };
