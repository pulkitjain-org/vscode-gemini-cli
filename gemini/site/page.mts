/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The page's own behaviour: the light/dark switch, the particles that drift
// away from the pointer and the pointer's soft light. Served as plain
// JavaScript (build.mts strips the types).

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const prefersDark = matchMedia('(prefers-color-scheme: dark)');

/** Whether the page is dark now, from the switch or else the system. */
function isDark(): boolean {
	return root.dataset.theme ? root.dataset.theme === 'dark' : prefersDark.matches;
}

document.querySelector('.theme')?.addEventListener('click', () => {
	root.dataset.theme = isDark() ? 'light' : 'dark';
	try {
		localStorage.setItem('theme', root.dataset.theme);
	} catch {
		// Private windows can refuse storage; the switch still works for this visit.
	}
	root.dispatchEvent(new CustomEvent('themechange'));
});
prefersDark.addEventListener('change', () => root.dispatchEvent(new CustomEvent('themechange')));

// ---- Particles and the pointer's light (mouse only) ----

interface Particle { x: number; y: number; vx: number; vy: number; r: number }

const canvas = document.querySelector<HTMLCanvasElement>('.particles');
const ctx = canvas?.getContext('2d');
if (canvas && ctx) {
	let width = 0;
	let height = 0;
	let mouseX = -999;
	let mouseY = -999;
	let colors = ['', ''];
	let running = false;
	const readColors = () => {
		const style = getComputedStyle(root);
		colors = [style.getPropertyValue('--dot').trim(), style.getPropertyValue('--web').trim()];
	};
	const resize = () => {
		const dpr = Math.min(devicePixelRatio, 2);
		width = innerWidth;
		height = innerHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	resize();
	readColors();
	const particles: Particle[] = Array.from({ length: innerWidth < 640 ? 22 : 44 }, () => ({
		x: Math.random() * width, y: Math.random() * height,
		vx: (Math.random() - 0.5) * 0.45, vy: (Math.random() - 0.5) * 0.45,
		r: Math.random() * 1.4 + 0.9,
	}));
	const draw = () => {
		ctx.clearRect(0, 0, width, height);
		const still = reduceMotion.matches;
		for (const p of particles) {
			if (!still) {
				p.x += p.vx;
				p.y += p.vy;
				if (p.x < 0 || p.x > width) { p.vx *= -1; }
				if (p.y < 0 || p.y > height) { p.vy *= -1; }
				const dx = mouseX - p.x;
				const dy = mouseY - p.y;
				const distance = Math.hypot(dx, dy);
				if (distance < 120 && distance > 0) {
					p.x -= dx / distance * 0.8;
					p.y -= dy / distance * 0.8;
				}
			}
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fillStyle = colors[0];
			ctx.fill();
		}
		ctx.lineWidth = 0.8;
		ctx.strokeStyle = colors[1];
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const distance = Math.hypot(particles[i].x - particles[j].x, particles[i].y - particles[j].y);
				if (distance < 100) {
					ctx.globalAlpha = 1 - distance / 100;
					ctx.beginPath();
					ctx.moveTo(particles[i].x, particles[i].y);
					ctx.lineTo(particles[j].x, particles[j].y);
					ctx.stroke();
				}
			}
		}
		ctx.globalAlpha = 1;
	};
	const loop = () => {
		if (!running) { return; }
		draw();
		requestAnimationFrame(loop);
	};
	// Animate only while the tab is visible and motion is allowed; otherwise draw once.
	const update = () => {
		const shouldRun = !reduceMotion.matches && !document.hidden;
		if (shouldRun && !running) {
			running = true;
			requestAnimationFrame(loop);
		} else if (!shouldRun) {
			running = false;
			draw();
		}
	};
	addEventListener('resize', () => { resize(); draw(); });
	root.addEventListener('themechange', () => { readColors(); draw(); });
	reduceMotion.addEventListener('change', update);
	document.addEventListener('visibilitychange', update);
	addEventListener('pointermove', event => {
		if (event.pointerType !== 'mouse') { return; }
		mouseX = event.clientX;
		mouseY = event.clientY;
		root.style.setProperty('--mx', `${mouseX}px`);
		root.style.setProperty('--my', `${mouseY}px`);
		root.classList.add('pointer');
	}, { passive: true });
	document.addEventListener('pointerleave', () => {
		mouseX = mouseY = -999;
		root.classList.remove('pointer');
	});
	update();
}

