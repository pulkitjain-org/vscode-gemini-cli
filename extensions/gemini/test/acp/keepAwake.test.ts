/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { KeepAwake } from '../../src/acp/keepAwake';

class FakeChild extends EventEmitter {
	killed = false;
	kill(): boolean {
		this.killed = true;
		this.emit('exit', null, 'SIGTERM');
		return true;
	}
}

function setup(platform: NodeJS.Platform = 'darwin') {
	const spawned: { command: string; args: readonly string[]; child: FakeChild }[] = [];
	const keepAwake = new KeepAwake({
		platform,
		pid: 4242,
		spawn: (command, args) => {
			const child = new FakeChild();
			spawned.push({ command, args, child });
			return child as unknown as ChildProcess;
		},
	});
	return { keepAwake, spawned };
}

describe('KeepAwake', () => {
	it('runs caffeinate tied to the host process while busy, and stops it when idle', () => {
		const { keepAwake, spawned } = setup();
		keepAwake.setBusy(true);
		keepAwake.setBusy(true);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]).toMatchObject({ command: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] });
		expect(keepAwake.active).toBe(true);
		keepAwake.setBusy(false);
		expect(spawned[0].child.killed).toBe(true);
		expect(keepAwake.active).toBe(false);
		keepAwake.setBusy(true);
		expect(spawned).toHaveLength(2);
	});

	it('does nothing when turned off or off a Mac', () => {
		const linux = setup('linux');
		linux.keepAwake.setBusy(true);
		expect(linux.spawned).toHaveLength(0);

		const { keepAwake, spawned } = setup();
		keepAwake.setBusy(true);
		keepAwake.setEnabled(false);
		expect(spawned[0].child.killed).toBe(true);
		keepAwake.setBusy(true);
		expect(spawned).toHaveLength(1);
		keepAwake.setEnabled(true);
		expect(spawned).toHaveLength(2);
		keepAwake.dispose();
		expect(spawned[1].child.killed).toBe(true);
	});

	it('stops trying once caffeinate cannot run', () => {
		const { keepAwake, spawned } = setup();
		keepAwake.setBusy(true);
		spawned[0].child.emit('error', new Error('spawn caffeinate ENOENT'));
		expect(keepAwake.active).toBe(false);
		spawned[0].child.emit('exit', -2, null);
		keepAwake.setBusy(false);
		keepAwake.setBusy(true);
		expect(spawned).toHaveLength(1);
	});

	it('starts caffeinate again when it exits early while an agent works, a few times at most', () => {
		const { keepAwake, spawned } = setup();
		keepAwake.setBusy(true);
		for (let i = 0; i < 5; i++) {
			spawned.at(-1)!.child.emit('exit', 0, null);
		}
		expect({ spawned: spawned.length, active: keepAwake.active }).toEqual({ spawned: 4, active: false });
		// A new busy spell tries again.
		keepAwake.setBusy(false);
		keepAwake.setBusy(true);
		expect({ spawned: spawned.length, active: keepAwake.active }).toEqual({ spawned: 5, active: true });
	});
});
