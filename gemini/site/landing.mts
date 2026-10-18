/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The landing page's moving parts: the hero clip, and the "Watch it work" rail
// with its player. With Reduce Motion on, clips show their last frame. Old
// links to the feature index go to the docs. Served as plain JavaScript
// (build.mts strips the types).

const doc = document.documentElement;
const noMotion = matchMedia('(prefers-reduced-motion: reduce)');
const systemDark = matchMedia('(prefers-color-scheme: dark)');

type Theme = 'dark' | 'light';

/** The page's theme, from the switch or else the system. */
function pageTheme(): Theme {
	return doc.dataset.theme === 'light' || doc.dataset.theme === 'dark' ? doc.dataset.theme : systemDark.matches ? 'dark' : 'light';
}

function clipFile(id: string, theme: Theme, extension: 'mp4' | 'webp'): string {
	return `media/showcase-${id}-${theme}.${extension}`;
}

/** Points `video` at `src` unless it already plays it. */
function setSource(video: HTMLVideoElement, src: string): void {
	if (video.getAttribute('src') !== src) {
		video.classList.remove('ready');
		video.src = src;
	}
}

// ---- Hero clip: plays while on screen ----

const heroVideo = document.querySelector<HTMLVideoElement>('.hero-shot video');
if (heroVideo) {
	let visible = false;
	const update = () => {
		if (noMotion.matches) {
			heroVideo.pause();
			heroVideo.classList.remove('ready');
			return;
		}
		if (visible && !document.hidden) {
			setSource(heroVideo, clipFile(heroVideo.dataset.clip ?? '', pageTheme(), 'mp4'));
			void heroVideo.play().catch(() => { /* autoplay refused: the still stays */ });
		} else {
			heroVideo.pause();
		}
	};
	heroVideo.addEventListener('playing', () => heroVideo.classList.add('ready'));
	new IntersectionObserver(entries => {
		visible = entries.some(entry => entry.isIntersecting);
		update();
	}, { threshold: 0.3 }).observe(heroVideo);
	doc.addEventListener('themechange', update);
	noMotion.addEventListener('change', update);
	document.addEventListener('visibilitychange', update);
}

// ---- Watch it work: hover previews, categories, the arrows and the player ----

const rail = document.querySelector<HTMLElement>('.rail');
if (rail) {
	const cards = [...rail.querySelectorAll<HTMLButtonElement>('.clip')];
	const section = rail.closest('section')!;

	for (const card of cards) {
		const video = card.querySelector('video')!;
		card.addEventListener('pointerenter', event => {
			if (event.pointerType !== 'mouse' || noMotion.matches) {
				return;
			}
			setSource(video, clipFile(card.dataset.clip ?? '', pageTheme(), 'mp4'));
			video.currentTime = 0;
			void video.play().then(() => card.classList.add('playing')).catch(() => undefined);
		});
		card.addEventListener('pointerleave', () => {
			video.pause();
			card.classList.remove('playing');
		});
	}

	const arrows = [...section.querySelectorAll<HTMLButtonElement>('[data-scroll]')];
	const syncArrows = () => {
		arrows[0].disabled = rail.scrollLeft <= 4;
		arrows[1].disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
	};
	arrows.forEach(arrow => arrow.addEventListener('click', () => {
		rail.scrollBy({ left: Number(arrow.dataset.scroll) * rail.clientWidth * 0.9, behavior: noMotion.matches ? 'auto' : 'smooth' });
	}));
	rail.addEventListener('scroll', syncArrows, { passive: true });
	addEventListener('resize', syncArrows);

	syncArrows();

	// The player: one clip at a time, in the theme the reader picks.
	const player = section.querySelector<HTMLDialogElement>('.player')!;
	const stage = player.querySelector<HTMLElement>('.player-stage')!;
	const title = player.querySelector<HTMLElement>('#player-title')!;
	const caption = player.querySelector<HTMLElement>('.player-cap')!;
	const themeButtons = [...player.querySelectorAll<HTMLButtonElement>('.seg button')];
	let open: HTMLButtonElement = cards[0];
	let theme: Theme = 'dark';

	const render = () => {
		const id = open.dataset.clip ?? '';
		title.textContent = open.dataset.title ?? '';
		caption.textContent = open.dataset.caption ?? '';
		themeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === theme)));
		const still = document.createElement('img');
		still.src = clipFile(id, theme, 'webp');
		still.alt = open.dataset.alt ?? '';
		if (noMotion.matches) {
			stage.replaceChildren(still);
			return;
		}
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.controls = true;
		video.poster = still.src;
		video.src = clipFile(id, theme, 'mp4');
		video.setAttribute('aria-label', still.alt);
		stage.replaceChildren(video);
		void video.play().catch(() => undefined);
	};
	const show = (card: HTMLButtonElement) => {
		open = card;
		theme = pageTheme();
		render();
		if (!player.open) {
			player.showModal();
		}
	};
	cards.forEach(card => card.addEventListener('click', () => show(card)));
	document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => {
		const card = cards.find(c => c.dataset.clip === button.dataset.open);
		if (card) {
			show(card);
		}
	}));
	player.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => button.addEventListener('click', () => {
		const index = cards.indexOf(open);
		open = cards[(index + Number(button.dataset.step) + cards.length) % cards.length] ?? open;
		render();
	}));
	themeButtons.forEach(button => button.addEventListener('click', () => {
		theme = button.dataset.theme === 'light' ? 'light' : 'dark';
		render();
	}));
	player.querySelector('[data-close]')!.addEventListener('click', () => player.close());
	// A click on the dimmed page around the player closes it.
	player.addEventListener('click', event => {
		if (event.target === player) {
			player.close();
		}
	});
	player.addEventListener('close', () => stage.replaceChildren());
}

// ---- Links to sections that moved to the docs ----

// The feature index is now the docs home's "All features".
if (location.hash === '#features') {
	location.replace('docs/#all-features');
}
