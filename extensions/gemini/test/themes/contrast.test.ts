/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

type Colors = Record<string, string>;

function load(name: string): Colors {
	const file = path.join(import.meta.dirname, '..', '..', 'themes', name);
	return (JSON.parse(fs.readFileSync(file, 'utf8')) as { colors: Colors }).colors;
}

/** A colour over `under`, with its alpha applied. */
function rgb(color: string, under = [255, 255, 255]): number[] {
	const hex = color.replace('#', '');
	const channels = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
	const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
	return channels.map((c, i) => c * alpha + under[i] * (1 - alpha));
}

function luminance([r, g, b]: number[]): number {
	const [lr, lg, lb] = [r, g, b].map(c => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(text: string, background: string): number {
	const back = rgb(background);
	const [a, b] = [luminance(rgb(text, back)), luminance(back)].sort((x, y) => y - x);
	return (a + 0.05) / (b + 0.05);
}

// Text and the surfaces it sits on, from the approved mockups' roles.
const pairs: readonly [text: string, background: string][] = [
	['foreground', 'editor.background'],
	['foreground', 'sideBar.background'],
	['descriptionForeground', 'editor.background'],
	['descriptionForeground', 'sideBar.background'],
	['descriptionForeground', 'input.background'],
	['button.foreground', 'button.background'],
	['badge.foreground', 'badge.background'],
	['list.activeSelectionForeground', 'list.activeSelectionBackground'],
	['textLink.foreground', 'editor.background'],
	['errorForeground', 'editor.background'],
	['editorWarning.foreground', 'editor.background'],
	['statusBar.foreground', 'statusBar.background'],
	['tab.activeForeground', 'tab.activeBackground'],
	['input.foreground', 'input.background'],
];

describe.each(['geminicode-dark.json', 'geminicode-light.json'])('%s', name => {
	const colors = load(name);
	it.each(pairs)('%s on %s reads at 4.5:1 or more', (text, background) => {
		expect(colors[text], text).toBeDefined();
		expect(colors[background], background).toBeDefined();
		expect(contrast(colors[text], colors[background])).toBeGreaterThanOrEqual(4.5);
	});
});

// Glass (media/glass.css, geminiSoft.css): text on the strongest glass fill, the lens and the chosen row,
// laid over each surface it sits on. The fill is white 7% on GeminiCode Dark and black 7% on Light; at 10% on Dark, secondary text on a pop-up fell to 4.1:1.
const glassFill: Record<string, string> = { 'geminicode-dark.json': '#FFFFFF12', 'geminicode-light.json': '#00000012' };
const glassPairs: readonly [text: string, under: string][] = [
	['foreground', 'editor.background'],
	['foreground', 'sideBar.background'],
	['foreground', 'quickInput.background'],
	['descriptionForeground', 'editor.background'],
	['descriptionForeground', 'sideBar.background'],
	['descriptionForeground', 'quickInput.background'],
];

/** `color` with alpha laid over the opaque `under`, as a hex colour. */
function over(color: string, under: string): string {
	return `#${rgb(color, rgb(under)).map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

describe.each(Object.keys(glassFill))('%s glass', name => {
	const colors = load(name);
	it.each(glassPairs)('%s on the glass fill over %s reads at 4.5:1 or more', (text, under) => {
		expect(contrast(colors[text], over(glassFill[name], colors[under]))).toBeGreaterThanOrEqual(4.5);
	});
});
