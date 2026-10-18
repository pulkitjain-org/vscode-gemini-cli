/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Holds the agent's `session/request_permission` requests until the user
// answers one in the UI. Options come from the request, never from a hardcoded
// list, and every request is answered: `cancelled` when the turn is stopped or
// the agent goes away. Shell commands the session's approvals cover are
// answered at once (see sessionApprovals.ts).
//
// Some tools change things that are hard to take back: a ticket's status, a
// time log, a merge request, a merge. Those are the confirm class (`confirmOnly`):
// their card never offers "Allow for this session", because the CLI would
// apply that to every tool of the same server, and nothing answers them for
// the user.

import type * as acp from '@agentclientprotocol/sdk';
import { Emitter } from './events';
import { parseCommand, SessionApprovals } from './sessionApprovals';

export interface PendingPermission {
	readonly id: string;
	readonly request: acp.RequestPermissionRequest;
	/** Confirm class: the card offers Allow once and Reject only, every time. */
	readonly confirm?: boolean;
}

export type PermissionEvent =
	| { readonly kind: 'requested'; readonly permission: PendingPermission }
	| { readonly kind: 'resolved'; readonly id: string; readonly outcome: acp.RequestPermissionOutcome }
	/** Answered at once, with no card: covered by the session's approvals, or by `answerAtOnce` with the `label` it gave. */
	| { readonly kind: 'allowed'; readonly permission: PendingPermission; readonly outcome: acp.RequestPermissionOutcome; readonly label?: string };

/**
 * A request answered without asking: the option to pick, and either `quiet`
 * (nothing shows, as for a project's own tools) or the label its row shows.
 */
export interface InstantAnswer {
	readonly optionId: string;
	readonly quiet?: boolean;
	readonly label?: string;
}

export class PermissionBroker {

	private readonly onDidChangeEmitter = new Emitter<PermissionEvent>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly pending = new Map<string, { permission: PendingPermission; resolve: (response: acp.RequestPermissionResponse) => void }>();
	private nextId = 0;
	/** The shell programs allowed for this session. */
	readonly approvals = new SessionApprovals();
	/** Answers some requests at once, such as a project coordinator's (see projectMcp.ts). */
	answerAtOnce: ((request: acp.RequestPermissionRequest) => InstantAnswer | undefined) | undefined;
	/** Says which requests are in the confirm class: always a card, with Allow once and Reject only. */
	confirmOnly: ((request: acp.RequestPermissionRequest) => boolean) | undefined;

	get pendingPermissions(): readonly PendingPermission[] {
		return [...this.pending.values()].map(entry => entry.permission);
	}

	/** Waits for the user's answer. Never rejects. */
	request(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		if (this.confirmOnly?.(request)) {
			return this.ask(confirmOptions(request), true);
		}
		const instant = this.answerAtOnce?.(request);
		if (instant && request.options.some(option => option.optionId === instant.optionId)) {
			const outcome: acp.RequestPermissionOutcome = { outcome: 'selected', optionId: instant.optionId };
			if (!instant.quiet) {
				this.onDidChangeEmitter.fire({ kind: 'allowed', permission: { id: `permission-${this.nextId++}`, request }, outcome, label: instant.label });
			}
			return Promise.resolve({ outcome });
		}
		const command = shellCommand(request);
		const once = request.options.find(option => option.kind === 'allow_once');
		if (command !== undefined && once && this.approvals.covers(command).kind === 'covered') {
			const outcome: acp.RequestPermissionOutcome = { outcome: 'selected', optionId: once.optionId };
			this.onDidChangeEmitter.fire({ kind: 'allowed', permission: { id: `permission-${this.nextId++}`, request }, outcome });
			return Promise.resolve({ outcome });
		}
		return this.ask(withApprovalLabels(request, command));
	}

	/** Shows the card and waits. */
	private ask(request: acp.RequestPermissionRequest, confirm = false): Promise<acp.RequestPermissionResponse> {
		const permission: PendingPermission = { id: `permission-${this.nextId++}`, request, ...confirm ? { confirm: true } : {} };
		return new Promise(resolve => {
			this.pending.set(permission.id, { permission, resolve });
			this.onDidChangeEmitter.fire({ kind: 'requested', permission });
		});
	}

	/** Answers with one of the request's own options; returns false if the request or option is unknown. */
	select(id: string, optionId: string): boolean {
		const entry = this.pending.get(id);
		const option = entry?.permission.request.options.find(o => o.optionId === optionId);
		if (!entry || !option) {
			return false;
		}
		const command = shellCommand(entry.permission.request);
		if (command !== undefined && option.kind === 'allow_always') {
			this.approvals.approve(command);
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

/**
 * The command of a shell tool's request; undefined for other tools. The tool's
 * own input wins when the agent sends it, since a title is display text;
 * gemini-cli 0.63 sends none and titles the request with the whole command.
 */
function shellCommand(request: acp.RequestPermissionRequest): string | undefined {
	if (request.toolCall.kind !== 'execute') {
		return undefined;
	}
	const input = request.toolCall.rawInput as { command?: unknown } | null | undefined;
	if (typeof input?.command === 'string') {
		return input.command;
	}
	return typeof request.toolCall.title === 'string' ? request.toolCall.title : undefined;
}

/** The request with only its allow-once and reject options, for the confirm class. */
function confirmOptions(request: acp.RequestPermissionRequest): acp.RequestPermissionRequest {
	const options = request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once' || option.kind === 'reject_always');
	return options.length ? { ...request, options } : request;
}

/** Says what "Allow for this session" covers for a shell command: "Allow grep, cut, head for this session". */
function withApprovalLabels(request: acp.RequestPermissionRequest, command: string | undefined): acp.RequestPermissionRequest {
	const parsed = command === undefined ? undefined : parseCommand(command);
	if (parsed?.kind !== 'ok') {
		return request;
	}
	const programs = [...new Set(parsed.programs.map(p => p.split('/').pop()!))].join(', ');
	return {
		...request,
		options: request.options.map(option => option.kind === 'allow_always' && /for this session/i.test(option.name)
			? { ...option, name: `Allow ${programs} for this session` }
			: option),
	};
}
