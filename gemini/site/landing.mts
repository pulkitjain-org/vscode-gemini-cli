/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The landing page's moving parts, as the motion spec has them: the headline that types itself,
// the dot field behind it, the eight capability cards' parallax and drift, the showcase card's
// Dark · Light pill and Play button, the command strip's speed, and the download button's
// press. CSS transitions and IntersectionObserver do the rest. Everything stops, or falls back
// to a fade, under Reduce Motion. Served as plain JavaScript (build.mts strips the types).

import { pageTheme } from './page.mts';

const html = document.documentElement;
const noMotion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const hero = document.querySelector<HTMLElement>('.hero');

// ---- The headline types itself at about 28 characters per second, the italic line last ----

const typed = [...document.querySelectorAll<HTMLElement>('.h1 .tw [data-t]')];
const caret = document.querySelector<HTMLElement>('.h1 .caret');
// The page's first script sets html.typing when the headline is to type: motion allowed and
// not seen this session. Until then the headline is hidden, so nothing flashes.
const willType = html.classList.contains('typing');
const floats = [...document.querySelectorAll<HTMLElement>('.float')];
// Outside in: the corners first, then the middle pair, then the two near the headline.
const order = ['pos-tl', 'pos-tr', 'pos-bl', 'pos-br', 'pos-ml', 'pos-mr', 'pos-bil', 'pos-bir'];
floats.forEach(card => {
	const index = order.findIndex(name => card.classList.contains(name));
	card.style.setProperty('--d', `${400 + Math.max(index, 0) * 60}ms`);
});

function finishHeadline(): void {
	html.classList.remove('typing');
	if (caret) {
		caret.classList.add('blink');
		caret.addEventListener('animationend', () => caret.classList.add('done'), { once: true });
	}
	try {
		sessionStorage.setItem('typed', '1');
	} catch {
		// Fine without.
	}
}

if (hero && typed.length && willType) {
	const parts = typed.map(el => ({ el, text: el.dataset.t ?? '' }));
	parts.forEach(part => (part.el.textContent = ''));
	html.classList.add('type-run');
	let part = 0;
	let at = 0;
	const step = () => {
		const current = parts[part];
		if (!current) {
			finishHeadline();
			return;
		}
		at++;
		current.el.textContent = current.text.slice(0, at);
		if (at >= current.text.length) {
			part++;
			at = 0;
		}
		setTimeout(step, 36);
	};
	setTimeout(step, 150);
} else {
	html.classList.remove('typing');
	caret?.classList.add('done');
}

// ---- The dot field: one canvas, dots that brighten and drift away from the pointer ----

const canvas = document.querySelector<HTMLCanvasElement>('.hero .dots');
const context = canvas?.getContext('2d');
if (hero && canvas && context) {
	interface Dot { x: number; y: number; ox: number; oy: number; glow: number }
	const gap = 26;
	const reach = 140;
	let dots: Dot[] = [];
	let width = 0;
	let height = 0;
	let pointerX = -9999;
	let pointerY = -9999;
	let color = '';
	let running = false;
	let visible = true;
	let ripple = 0;
	const readColor = () => {
		color = getComputedStyle(html).getPropertyValue('--dot').trim();
	};
	const layout = () => {
		const dpr = Math.min(devicePixelRatio || 1, 2);
		width = hero.clientWidth;
		height = hero.clientHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		dots = [];
		for (let y = gap / 2; y < height; y += gap) {
			for (let x = gap / 2; x < width; x += gap) {
				dots.push({ x, y, ox: 0, oy: 0, glow: 0 });
			}
		}
	};
	const draw = (): boolean => {
		context.clearRect(0, 0, width, height);
		let moving = false;
		const still = noMotion.matches;
		for (const dot of dots) {
			let targetX = 0;
			let targetY = 0;
			let targetGlow = 0;
			if (!still) {
				const dx = dot.x - pointerX;
				const dy = dot.y - pointerY;
				const distance = Math.hypot(dx, dy);
				if (distance < reach && distance > 0) {
					const force = 1 - distance / reach;
					targetX = dx / distance * 6 * force;
					targetY = dy / distance * 6 * force;
					targetGlow = force;
				} else if (ripple) {
					// Touch screens get a slow ripple from the centre instead of a pointer.
					const fromCentre = Math.hypot(dot.x - width / 2, dot.y - height * 0.4);
					const band = Math.abs(fromCentre - ripple);
					targetGlow = band < 60 ? (1 - band / 60) * 0.6 : 0;
				}
				// Ease toward the target, which settles in about 600ms.
				dot.ox += (targetX - dot.ox) * 0.12;
				dot.oy += (targetY - dot.oy) * 0.12;
				dot.glow += (targetGlow - dot.glow) * 0.12;
				if (Math.abs(dot.ox - targetX) > 0.05 || Math.abs(dot.oy - targetY) > 0.05 || Math.abs(dot.glow - targetGlow) > 0.01) {
					moving = true;
				}
			}
			context.globalAlpha = 1 + dot.glow * 1.6;
			context.fillStyle = color;
			context.beginPath();
			context.arc(dot.x + dot.ox, dot.y + dot.oy, 1 + dot.glow * 0.6, 0, Math.PI * 2);
			context.fill();
		}
		context.globalAlpha = 1;
		return moving;
	};
	let last = 0;
	const loop = (now: number) => {
		if (!running) {
			return;
		}
		// Rippling needs no more than 20 frames a second.
		if (ripple && now - last < 50) {
			requestAnimationFrame(loop);
			return;
		}
		last = now;
		if (ripple) {
			ripple = (ripple + 3) % (Math.max(width, height) * 0.7);
		}
		const moving = draw();
		if (moving || ripple) {
			requestAnimationFrame(loop);
		} else {
			running = false;
		}
	};
	const start = () => {
		if (!running && visible && !document.hidden && !noMotion.matches) {
			running = true;
			requestAnimationFrame(loop);
		}
	};
	readColor();
	layout();
	draw();
	if (!finePointer.matches) {
		ripple = 1;
		start();
	}
	hero.addEventListener('pointermove', event => {
		if (event.pointerType !== 'mouse') {
			return;
		}
		const box = hero.getBoundingClientRect();
		pointerX = event.clientX - box.left;
		pointerY = event.clientY - box.top;
		start();
	}, { passive: true });
	hero.addEventListener('pointerleave', () => {
		pointerX = pointerY = -9999;
		start();
	});
	addEventListener('resize', () => { layout(); draw(); });
	html.addEventListener('themechange', () => { readColor(); draw(); });
	noMotion.addEventListener('change', () => { draw(); start(); });
	document.addEventListener('visibilitychange', () => { if (!document.hidden) { start(); } });
	new IntersectionObserver(entries => {
		visible = entries.some(entry => entry.isIntersecting);
		if (visible) {
			start();
		} else {
			running = false;
		}
	}).observe(hero);
}

// ---- Capability cards: parallax with the pointer, and they drift away as the hero scrolls ----

if (hero && floats.length) {
	let queued = false;
	let nx = 0;
	let ny = 0;
	const place = () => {
		queued = false;
		for (const card of floats) {
			const depth = Number(card.dataset.depth ?? 8);
			card.style.setProperty('--px', `${(-nx * depth).toFixed(1)}px`);
			card.style.setProperty('--py', `${(-ny * depth).toFixed(1)}px`);
		}
	};
	hero.addEventListener('pointermove', event => {
		if (event.pointerType !== 'mouse' || noMotion.matches) {
			return;
		}
		const box = hero.getBoundingClientRect();
		nx = (event.clientX - box.left) / box.width * 2 - 1;
		ny = (event.clientY - box.top) / box.height * 2 - 1;
		if (!queued) {
			queued = true;
			requestAnimationFrame(place);
		}
	}, { passive: true });
	let scrollQueued = false;
	const away = () => {
		scrollQueued = false;
		const amount = Math.min(1, Math.max(0, scrollY / (hero.offsetHeight * 0.6)));
		for (const card of floats) {
			card.style.setProperty('--away', amount.toFixed(3));
		}
		if (canvas) {
			canvas.style.opacity = String(1 - amount);
		}
	};
	addEventListener('scroll', () => {
		if (!scrollQueued) {
			scrollQueued = true;
			requestAnimationFrame(away);
		}
	}, { passive: true });
	away();
}

// ---- Showcase card: the Dark · Light pill swaps just that frame; Play runs the clip ----

for (const pill of document.querySelectorAll<HTMLElement>('.pill')) {
	const frame = pill.closest<HTMLElement>('[data-frame]')?.querySelector<HTMLElement>('.shot');
	const buttons = [...pill.querySelectorAll<HTMLButtonElement>('button[data-shot-theme]')];
	const mark = () => {
		const theme = frame?.dataset.shot ?? pageTheme();
		buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.shotTheme === theme)));
	};
	buttons.forEach(button => button.addEventListener('click', () => {
		if (!frame) {
			return;
		}
		const theme = button.dataset.shotTheme ?? 'dark';
		const swap = () => {
			frame.dataset.shot = theme;
			mark();
			frame.dispatchEvent(new CustomEvent('shotchange'));
		};
		if (noMotion.matches) {
			swap();
			return;
		}
		frame.style.opacity = '0';
		setTimeout(() => { swap(); frame.style.opacity = ''; }, 200);
	}));
	html.addEventListener('themechange', () => {
		// A frame the reader set by hand keeps its choice; the others follow the page.
		mark();
	});
	mark();
}

const play = document.querySelector<HTMLButtonElement>('.play');
if (play) {
	play.addEventListener('click', () => {
		const stage = play.closest<HTMLElement>('.stage');
		const frame = stage?.querySelector<HTMLElement>('.shot');
		const clip = play.dataset.clip;
		if (!stage || !frame || !clip) {
			return;
		}
		const theme = frame.dataset.shot ?? pageTheme();
		const video = document.createElement('video');
		video.controls = true;
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;
		video.poster = `media/showcase-${clip}-${theme}.webp`;
		video.src = `media/showcase-${clip}-${theme}.mp4`;
		video.setAttribute('aria-label', play.getAttribute('aria-label') ?? '');
		const track = document.createElement('track');
		track.kind = 'captions';
		track.srclang = 'en';
		track.label = 'No speech';
		track.src = 'media/silent.vtt';
		video.append(track);
		frame.replaceChildren(video);
		frame.style.aspectRatio = '';
		play.remove();
		void video.play().catch(() => undefined);
	});
}

// ---- Command strip: 40 pixels a second, whatever its width ----

const track = document.querySelector<HTMLElement>('.strip .track');
if (track) {
	const speed = () => track.style.setProperty('--marquee', `${Math.round(track.scrollWidth / 2 / 40)}s`);
	speed();
	addEventListener('resize', speed);
}

// ---- Download: the button says Starting… for a moment, and the SHA-256 link lights up ----

for (const button of document.querySelectorAll<HTMLAnchorElement>('a.dl')) {
	button.addEventListener('click', () => {
		const label = button.querySelector<HTMLElement>('.dl-label');
		if (!label || button.classList.contains('starting')) {
			return;
		}
		const original = label.textContent;
		label.textContent = 'Starting…';
		button.classList.add('starting');
		setTimeout(() => {
			label.textContent = original;
			button.classList.remove('starting');
		}, 600);
		const sha = document.querySelector<HTMLElement>('.sha-link');
		if (sha) {
			sha.classList.add('hi');
			setTimeout(() => sha.classList.remove('hi'), 2000);
		}
	});
}

// ---- Links to sections that moved to the docs ----

if (location.hash === '#features' || location.hash === '#tour') {
	location.replace('docs/#all-features');
} else if (location.hash === '#watch') {
	location.replace('#agents');
}
