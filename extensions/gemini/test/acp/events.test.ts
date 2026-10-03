/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/acp/events';

describe('Emitter', () => {
	it('keeps calling listeners after one throws', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => { });
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		emitter.event(() => { throw new Error('boom'); });
		emitter.event(n => seen.push(n));
		emitter.fire(1);
		expect(seen).toEqual([1]);
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});

	it('stops calling a disposed listener', () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		emitter.event(n => seen.push(n)).dispose();
		emitter.fire(1);
		expect(seen).toEqual([]);
	});
});
