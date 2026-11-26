/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { diagnosticFiles, errorsNotice, resolveTarget } from '../../src/acp/editorTools';

describe('editor tools', () => {
	it('lists a few errors after a turn, never warnings, and nothing without errors', () => {
		const errors = Array.from({ length: 7 }, (_, i) => ({ file: `/repo/src/f${i}.ts`, line: i + 1, severity: 'error' as const, message: `Bad   thing ${i}.` }));
		expect({
			one: errorsNotice('/repo', [errors[0], { file: '/repo/src/w.ts', line: 3, severity: 'warning', message: 'Unused.' }]),
			many: errorsNotice('/repo', errors)?.split('\n').slice(0, 2),
			none: errorsNotice('/repo', [{ file: '/repo/src/w.ts', line: 3, severity: 'warning', message: 'Unused.' }]),
		}).toEqual({
			one: 'The language server reports 1 error in the changed files:\n- src/f0.ts:1  Bad thing 0.',
			many: ['The language servers report 7 errors in the changed files, the first 5 here:', '- src/f0.ts:1  Bad thing 0.'],
			none: undefined,
		});
	});

	it('picks a symbol\'s place from one definition, lists several, and keeps paths inside the folder', () => {
		const def = (container: string) => ({ name: 'checkout', kind: 'method', container, path: `src/${container}.ts`, line: 4, endLine: 9, exported: true, signature: '' });
		expect({
			one: resolveTarget('/repo', 'Cart.checkout', [def('Cart'), def('Order')]),
			several: resolveTarget('/repo', 'checkout', [def('Cart'), def('Order')]),
			files: diagnosticFiles('/repo', ['src/a.ts', '../b.ts', 7, '']),
		}).toEqual({
			one: { folder: '/repo', file: '/repo/src/Cart.ts', line: 4, name: 'checkout' },
			several: 'checkout has 2 definitions; call again with path and line:\n  method Cart.checkout · src/Cart.ts:4\n  method Order.checkout · src/Order.ts:4',
			files: ['/repo/src/a.ts'],
		});
	});
});
