/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { changesRegion, compareRegion, findRegion, findRegions, recordRegion, regionDiff, removeRegion, stillPresent } from '../../../src/acp/debug/regions';
import { markedRegion } from '../../../src/acp/debug/templates';

const lines = markedRegion({ language: 'javascript', channel: 'console', nonce: 'gc7f3a', point: 'p4', expressions: ['cart.total'], indent: '\t' });
const record = recordRegion('cart.js', 'gc7f3a', 'p4', lines, 3);
const original = ['function total(cart) {', '\tlet sum = 0;', ...lines, '\treturn sum;', '}', ''].join('\n');

describe('marked regions', () => {
	it('finds a region by its markers after lines were added above it, and removes it exactly', () => {
		const edited = `// a new comment\nimport x from "y";\n${original}`;
		const found = findRegion(edited, 'gc7f3a', 'p4');
		const removed = removeRegion(edited, record);
		expect({ start: found?.start, end: found?.end, state: removed.state, content: removed.content }).toEqual({
			start: 4,
			end: 6,
			state: 'same',
			content: '// a new comment\nimport x from "y";\nfunction total(cart) {\n\tlet sum = 0;\n\treturn sum;\n}\n',
		});
	});

	it('counts a region a formatter rewrapped as unchanged, and one the user edited as changed', () => {
		const rewrapped = original.replace(lines[1], lines[1].replace('try { console.log(', 'try {\n\t\tconsole.log(\n\t\t\t').replace('; } catch {}', ';\n\t} catch {}'));
		const userEdited = original.replace('cart.total', 'cart.sum');
		const kept = removeRegion(userEdited, record);
		const forced = removeRegion(userEdited, record, true);
		expect({
			rewrapped: compareRegion(rewrapped, record).state,
			rewrappedRemoved: removeRegion(rewrapped, record).content,
			edited: kept.state,
			keptContent: kept.content,
			forcedState: forced.state,
			forcedContent: forced.content,
			diff: regionDiff(record, kept.current ?? ''),
		}).toEqual({
			rewrapped: 'same',
			rewrappedRemoved: 'function total(cart) {\n\tlet sum = 0;\n\treturn sum;\n}\n',
			edited: 'changed',
			keptContent: undefined,
			forcedState: 'changed',
			forcedContent: 'function total(cart) {\n\tlet sum = 0;\n\treturn sum;\n}\n',
			diff: [
				`  ${lines[0]}`,
				`- ${lines[1]}`,
				`+ ${lines[1].replace('cart.total', 'cart.sum')}`,
				`  ${lines[2]}`,
			].join('\n'),
		});
	});

	it('reports a region whose markers are gone as missing, and lists the ones still present', () => {
		const markerGone = original.replace(lines[2], '');
		const other = recordRegion('cart.js', 'gc7f3a', 'p9', ['// GEMINI-DEBUG-START gc7f3a p9', 'x', '// GEMINI-DEBUG-END gc7f3a p9'], 1);
		expect({
			missing: removeRegion(markerGone, record),
			present: stillPresent(original, [record, other]).map(r => r.point),
			all: [...findRegions(original, 'gc7f3a').keys()],
			otherNonce: findRegion(original, 'zzzz9999', 'p4'),
		}).toEqual({ missing: { state: 'missing' }, present: ['p4'], all: ['p4'], otherNonce: undefined });
	});

	it('tells a write that touches a region from one outside it, in CRLF files too', () => {
		const crlf = original.replace(/\n/g, '\r\n');
		const outside = crlf.replace('let sum = 0;', 'let sum = 1;');
		const inside = crlf.replace('cart.total', 'cart.sum');
		const deleted = crlf.replace(`${lines.join('\r\n')}\r\n`, '');
		expect({
			outside: changesRegion(crlf, outside, [record]),
			inside: changesRegion(crlf, inside, [record])?.point,
			deleted: changesRegion(crlf, deleted, [record])?.point,
			crlfRemoved: removeRegion(crlf, record).content,
		}).toEqual({ outside: undefined, inside: 'p4', deleted: 'p4', crlfRemoved: 'function total(cart) {\r\n\tlet sum = 0;\r\n\treturn sum;\r\n}\r\n' });
	});
});
