/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { followablePath, FollowTracker } from '../../src/acp/follow';
import type { ToolCallModel } from '../../src/acp/sessionUpdates';

function call(id: string, kind: ToolCallModel['kind'], status: ToolCallModel['status'], locations: ToolCallModel['locations'] = []): ToolCallModel {
	return { id, title: id, kind, status, locations, content: [] };
}

describe('FollowTracker', () => {
	it('shows a read file as soon as the call names it, once', () => {
		const follow = new FollowTracker();
		expect(follow.next(call('r', 'read', 'pending'))).toBeUndefined();
		expect(follow.next(call('r', 'read', 'in_progress', [{ path: '/w/cart.ts', line: 12 }]))).toEqual({ path: '/w/cart.ts', line: 12 });
		expect(follow.next(call('r', 'read', 'completed', [{ path: '/w/cart.ts', line: 12 }]))).toBeUndefined();
	});

	it('shows an edited file once the edit is written', () => {
		const follow = new FollowTracker();
		const at = [{ path: '/w/cart.ts' }];
		expect(follow.next(call('e', 'edit', 'pending', at))).toBeUndefined();
		expect(follow.next(call('e', 'edit', 'in_progress', at))).toBeUndefined();
		expect(follow.next(call('e', 'edit', 'completed', at))).toEqual({ path: '/w/cart.ts' });
		expect(follow.next(call('f', 'edit', 'failed', at))).toBeUndefined();
	});

	it('shows where a moved file went, and nothing for searches or commands', () => {
		const follow = new FollowTracker();
		expect(follow.next(call('m', 'move', 'completed', [{ path: '/w/a.ts' }, { path: '/w/b.ts' }]))).toEqual({ path: '/w/b.ts' });
		expect(follow.next(call('s', 'search', 'completed', [{ path: '/w/src' }]))).toBeUndefined();
		expect(follow.next(call('x', 'execute', 'completed', [{ path: '/w' }]))).toBeUndefined();
		expect(follow.next(call('u', undefined, 'completed', [{ path: '/w/a.ts' }]))).toBeUndefined();
	});
});

describe('followablePath', () => {
	it('resolves a file in the agent\'s folder, and skips files outside it or that may hold secrets', () => {
		const cwd = path.join(path.sep, 'w');
		expect([
			followablePath(cwd, { path: 'src/cart.ts' }),
			followablePath(cwd, { path: path.join(cwd, 'src', 'cart.ts'), line: 3 }),
			followablePath(cwd, { path: '../other/cart.ts' }),
			followablePath(cwd, { path: path.join(path.sep, 'etc', 'hosts') }),
			followablePath(cwd, { path: '.env' }),
		]).toEqual([path.join(cwd, 'src', 'cart.ts'), path.join(cwd, 'src', 'cart.ts'), undefined, undefined, undefined]);
	});
});
