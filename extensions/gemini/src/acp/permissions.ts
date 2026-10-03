/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Holds the agent's `session/request_permission` requests until the user
// answers one in the UI. Options come from the request, never from a hardcoded
// list, and every request is answered: `cancelled` when the turn is stopped or
// the agent goes away.

import type * as acp from '@agentclientprotocol/sdk';
import { Emitter } from './events';

export interface PendingPermission {
	readonly id: string;
	readonly request: acp.RequestPermissionRequest;
}

export type PermissionEvent =
	| { readonly kind: 'requested'; readonly permission: PendingPermission }
	| { readonly kind: 'resolved'; readonly id: string; readonly outcome: acp.RequestPermissionOutcome };

export class PermissionBroker {

	private readonly onDidChangeEmitter = new Emitter<PermissionEvent>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly pending = new Map<string, { permission: PendingPermission; resolve: (response: acp.RequestPermissionResponse) => void }>();
	private nextId = 0;

	get pendingPermissions(): readonly PendingPermission[] {
		return [...this.pending.values()].map(entry => entry.permission);
	}

	/** Waits for the user's answer. Never rejects. */
	request(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const permission: PendingPermission = { id: `permission-${this.nextId++}`, request };
		return new Promise(resolve => {
			this.pending.set(permission.id, { permission, resolve });
			this.onDidChangeEmitter.fire({ kind: 'requested', permission });
		});
	}

	/** Answers with one of the request's own options; returns false if the request or option is unknown. */
	select(id: string, optionId: string): boolean {
		const entry = this.pending.get(id);
		if (!entry || !entry.permission.request.options.some(option => option.optionId === optionId)) {
			return false;
		}
		this.resolve(id, { outcome: 'selected', optionId });
		return true;
	}

	cancel(id: string): void {
		this.resolve(id, { outcome: 'cancelled' });
	}

	/** Answers every open request with `cancelled`, as ACP requires after `session/cancel`. */
	cancelAll(): void {
		for (const id of [...this.pending.keys()]) {
			this.cancel(id);
		}
	}

	dispose(): void {
		this.cancelAll();
		this.onDidChangeEmitter.dispose();
	}

	private resolve(id: string, outcome: acp.RequestPermissionOutcome): void {
		const entry = this.pending.get(id);
		if (!entry) {
			return;
		}
		this.pending.delete(id);
		entry.resolve({ outcome });
		this.onDidChangeEmitter.fire({ kind: 'resolved', id, outcome });
	}
}
