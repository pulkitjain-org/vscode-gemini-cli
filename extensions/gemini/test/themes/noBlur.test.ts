/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The glass look (gemini/docs/ARCHITECTURE.md, "Look") is static paint: no stylesheet of the fork may
// blur. A backdrop-filter or blur filter re-runs on every frame the content under it changes, such as
// a streaming chat or an agent's spinner. `backdrop-filter: none`, which turns upstream's off, is allowed.

const root = path.join(import.meta.dirname, '..', '..');
const workbench = path.join(root, '..', '..', 'src', 'vs', 'workbench', 'contrib', 'gemini');

function stylesheets(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? stylesheets(full) : entry.name.endsWith('.css') ? [full] : [];
	});
}

/** Declarations that blur, with their line numbers. */
function blurs(css: string): string[] {
	const found: string[] = [];
	const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
	text.split('\n').forEach((line, i) => {
		const backdrop = /(?:-webkit-)?backdrop-filter\s*:\s*([^;}]*)/.exec(line);
		if (backdrop && backdrop[1].trim() !== 'none') {
			found.push(`${i + 1}: ${line.trim()}`);
		}
		if (/(?:^|[^-])filter\s*:[^;}]*blur\(/.test(line)) {
			found.push(`${i + 1}: ${line.trim()}`);
		}
	});
	return found;
}

describe('no blur in the fork\'s stylesheets', () => {
	const files = [...stylesheets(path.join(root, 'media')), ...fs.existsSync(workbench) ? stylesheets(workbench) : []];

	it('finds the stylesheets', () => {
		expect(files.some(f => f.endsWith('glass.css'))).toBe(true);
	});

	it.each(files.map(f => [path.relative(path.join(root, '..', '..'), f), f]))('%s', (_, file) => {
		expect(blurs(fs.readFileSync(file, 'utf8'))).toEqual([]);
	});

	it('catches a blur', () => {
		expect(blurs('.a { backdrop-filter: blur(8px); }\n.b { filter: blur(2px); }\n.c { backdrop-filter: none; }')).toHaveLength(2);
	});
});
