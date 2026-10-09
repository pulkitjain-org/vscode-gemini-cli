/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The showcase: a clip of the app for each tab. While the showcase is on screen
// the clips play one after another; hovering pauses them, and the first click
// stops the tour so the reader picks what to watch. With Reduce Motion on, each
// tab shows its clip's last frame instead. Served as plain JavaScript (build.mts
// strips the types).

const showcase = document.querySelector<HTMLElement>('.showcase');
if (showcase) {
	const root = document.documentElement;
	const stage = showcase.querySelector<HTMLElement>('.sc-stage')!;
	const tabs = [...showcase.querySelectorAll<HTMLButtonElement>('.sc-tabs [role="tab"]')];
	const themeButtons = [...showcase.querySelectorAll<HTMLButtonElement>('.sc-theme button')];
	const caption = showcase.querySelector<HTMLElement>('.sc-text')!;
	const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
	const prefersDark = matchMedia('(prefers-color-scheme: dark)');

	// The still under the clip: the frame the reader saw last, so a new clip never starts from black.
	const still = document.createElement('img');
	still.alt = '';
	still.decoding = 'async';
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'none';
	video.setAttribute('aria-hidden', 'true');
	stage.replaceChildren(still, video);

	let current = 0;
	let touring = true; // until the first click
	let visible = false;
	let hovering = false;
	let chosenTheme: 'dark' | 'light' | undefined;

	const pageTheme = (): 'dark' | 'light' => root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : prefersDark.matches ? 'dark' : 'light';
	const theme = () => chosenTheme ?? pageTheme();
	const file = (index: number, extension: 'mp4' | 'webp') => `media/showcase-${tabs[index].dataset.view}-${theme()}.${extension}`;

	/** Plays the clip when the reader can see it, motion is allowed and the pointer is elsewhere. */
	const update = () => {
		if (visible && !hovering && !reduceMotion.matches && !video.ended) {
			void video.play().catch(() => { /* autoplay refused: the still stays */ });
		} else {
			video.pause();
		}
	};

	/** Shows tab `index`: from its first frame, or its last frame when motion is off. */
	const show = (index: number, focus = false) => {
		tabs[current].style.removeProperty('--p');
		current = index;
		tabs.forEach((tab, i) => {
			const selected = i === index;
			tab.setAttribute('aria-selected', String(selected));
			tab.tabIndex = selected ? 0 : -1;
		});
		if (focus) {
			tabs[index].focus();
		}
		tabs[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
		stage.setAttribute('aria-labelledby', tabs[index].id);
		stage.setAttribute('aria-label', tabs[index].dataset.alt ?? '');
		caption.textContent = tabs[index].dataset.caption ?? '';
		if (reduceMotion.matches) {
			video.removeAttribute('src');
			video.classList.remove('ready');
			still.src = file(index, 'webp');
			return;
		}
		video.classList.remove('ready');
		video.preload = 'auto';
		video.src = file(index, 'mp4');
		update();
	};

	video.addEventListener('loadeddata', () => video.classList.add('ready'));
	video.addEventListener('timeupdate', () => {
		if (video.duration) {
			tabs[current].style.setProperty('--p', String(video.currentTime / video.duration));
		}
	});
	video.addEventListener('ended', () => {
		tabs[current].style.setProperty('--p', '1');
		// The tour moves on; a clip the reader picked stays on its last frame.
		if (touring) {
			still.src = file(current, 'webp');
			show((current + 1) % tabs.length);
		}
	});

	const stopTour = () => { touring = false; };
	showcase.addEventListener('pointerdown', stopTour, { capture: true });
	showcase.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
			stopTour();
		}
	}, { capture: true });

	tabs.forEach((tab, i) => tab.addEventListener('click', () => show(i)));
	showcase.querySelector('.sc-tabs')!.addEventListener('keydown', event => {
		const key = (event as KeyboardEvent).key;
		const next = key === 'ArrowRight' ? (current + 1) % tabs.length
			: key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
				: key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : -1;
		if (next >= 0) {
			event.preventDefault();
			show(next, true);
		}
	});

	// Clicking the clip replays it from the start, or pauses and resumes it.
	stage.addEventListener('click', () => {
		if (reduceMotion.matches) {
			return;
		}
		if (video.ended) {
			video.currentTime = 0;
		}
		if (video.paused) {
			hovering = false;
			void video.play().catch(() => undefined);
		} else {
			video.pause();
		}
	});
	stage.addEventListener('pointerenter', event => {
		if (event.pointerType === 'mouse') {
			hovering = true;
			update();
		}
	});
	stage.addEventListener('pointerleave', () => {
		hovering = false;
		update();
	});

	const syncThemeButtons = () => themeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === theme())));
	themeButtons.forEach(button => button.addEventListener('click', () => {
		chosenTheme = button.dataset.theme === 'light' ? 'light' : 'dark';
		syncThemeButtons();
		show(current);
	}));
	// Until the reader picks the app's theme, it follows the page's.
	root.addEventListener('themechange', () => {
		if (!chosenTheme) {
			syncThemeButtons();
			show(current);
		}
	});
	reduceMotion.addEventListener('change', () => show(current));

	new IntersectionObserver(entries => {
		visible = entries.some(entry => entry.isIntersecting);
		update();
	}, { threshold: 0.35 }).observe(stage);
	document.addEventListener('visibilitychange', () => {
		visible = visible && !document.hidden;
		update();
	});

	stage.tabIndex = 0;
	still.src = file(0, 'webp');
	syncThemeButtons();
	show(0);
}
