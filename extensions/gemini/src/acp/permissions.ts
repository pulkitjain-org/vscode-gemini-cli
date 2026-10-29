/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
import { SessionApprovals } from './sessionApprovals';

export interface PendingPermission {
	readonly id: string;
	readonly request: acp.RequestPermissionRequest;
	/** Confirm class: the card offers Allow once and Reject only, every time. */
	readonly confirm?: boolean;
	/** For a shell command, the prefixes "Allow for this session" would record (`npx vitest`), for the card's label. */
	readonly prefixes?: readonly string[];
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

/**
 * Permission ids, unique across sessions and window reloads: a chat keeps its
 * transcript when its agent restarts, and a new card that took an earlier
 * card's id would show in that card's place and be answered there.
 */
const permissionIdPrefix = `permission-${Date.now().toString(36)}-`;
let nextPermissionId = 0;

function newPermissionId(): string {
	return `${permissionIdPrefix}${nextPermissionId++}`;
}

export class PermissionBroker {

	private readonly onDidChangeEmitter = new Emitter<PermissionEvent>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly pending = new Map<string, { permission: PendingPermission; resolve: (response: acp.RequestPermissionResponse) => void }>();
	/** The agent's folders, for telling redirects inside them from ones outside, which always ask. */
	roots: (() => readonly string[]) | undefined;
	/** The shell command prefixes allowed for this session. */
	readonly approvals = new SessionApprovals(() => ({ roots: this.roots?.() ?? [] }));
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
				this.onDidChangeEmitter.fire({ kind: 'allowed', permission: { id: newPermissionId(), request }, outcome, label: instant.label });
			}
			return Promise.resolve({ outcome });
		}
		const command = shellCommand(request);
		const once = request.options.find(option => option.kind === 'allow_once');
		if (command !== undefined && once && this.approvals.covers(command).kind === 'covered') {
			const outcome: acp.RequestPermissionOutcome = { outcome: 'selected', optionId: once.optionId };
			this.onDidChangeEmitter.fire({ kind: 'allowed', permission: { id: newPermissionId(), request }, outcome });
			return Promise.resolve({ outcome });
		}
		const prefixes = command === undefined ? undefined : this.approvals.prefixesOf(command);
		return this.ask(withPermanentScope(withApprovalLabels(request, prefixes)), false, prefixes);
	}

	/** Shows the card and waits. */
	private ask(request: acp.RequestPermissionRequest, confirm = false, prefixes?: readonly string[]): Promise<acp.RequestPermissionResponse> {
		const permission: PendingPermission = { id: newPermissionId(), request, ...confirm ? { confirm: true } : {}, ...prefixes?.length ? { prefixes } : {} };
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
		const recorded = command !== undefined && option.kind === 'allow_always' ? this.approvals.approve(command) : undefined;
		const chosen: acp.RequestPermissionOutcome = { outcome: 'selected', optionId };
		// GeminiCode answers the session's repeats of the prefixes it recorded. The CLI is told
		// "once": its own session rule would cover the whole program (`npx`), not the prefix (`npx vitest`).
		const once = recorded && isSessionOption(option) ? entry.permission.request.options.find(o => o.kind === 'allow_once') : undefined;
		this.resolve(id, once ? { outcome: 'selected', optionId: once.optionId } : chosen, chosen);
		return true;
	}

	/**
	 * Allows every open request but the confirm class, with each one's Allow
	 * once: the user switched to YOLO while they waited. Requests that come
	 * later are allowed by the client (see agentClient.ts).
	 */
	allowPending(): void {
		for (const { permission } of [...this.pending.values()]) {
			const allow = permission.request.options.find(option => option.kind === 'allow_once') ?? permission.request.options.find(option => option.kind === 'allow_always');
			if (!permission.confirm && allow) {
				this.resolve(permission.id, { outcome: 'selected', optionId: allow.optionId });
			}
		}
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

	/** Answers the agent with `outcome`; the card shows `shown`, the user's own choice, when the agent is told otherwise. */
	private resolve(id: string, outcome: acp.RequestPermissionOutcome, shown = outcome): void {
		const entry = this.pending.get(id);
		if (!entry) {
			return;
		}
		this.pending.delete(id);
		entry.resolve({ outcome });
		this.onDidChangeEmitter.fire({ kind: 'resolved', id, outcome: shown });
	}
}

/**
 * The command of a shell tool's request; undefined for other tools. The tool's
 * own input wins when the agent sends it, since a title is display text;
 * gemini-cli 0.63 sends none and titles the request with the whole command.
 */
export function shellCommand(request: acp.RequestPermissionRequest): string | undefined {
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

/** Whether `option` is a request's "Allow for this session" (gemini-cli's `proceed_always`), not "for all future sessions". */
export function isSessionOption(option: acp.PermissionOption): boolean {
	return option.kind === 'allow_always' && (option.optionId === 'proceed_always' || /for this session/i.test(option.name));
}

/** Whether `option` is the CLI's "Allow for all future sessions" (`proceed_always_and_save`), which writes a policy rule. */
export function isPermanentOption(option: acp.PermissionOption): boolean {
	return option.kind === 'allow_always' && (option.optionId === 'proceed_always_and_save' || /all future sessions/i.test(option.name));
}

/**
 * The CLI's permanent allow with its scope spelt out: the rule it writes
 * (`~/.gemini/policies/auto-saved.toml`) applies in the mode the session is in
 * and the ones that approve more, never in a stricter one.
 */
export function withPermanentScope(request: acp.RequestPermissionRequest): acp.RequestPermissionRequest {
	if (!request.options.some(isPermanentOption)) {
		return request;
	}
	return { ...request, options: request.options.map(option => isPermanentOption(option) ? { ...option, name: `${option.name} (in this mode and the ones that approve more)` } : option) };
}

/** Says what "Allow for this session" covers for a shell command: "Allow git status, grep, head for this session". */
function withApprovalLabels(request: acp.RequestPermissionRequest, prefixes: readonly string[] | undefined): acp.RequestPermissionRequest {
	if (!prefixes?.length) {
		return request;
	}
	const programs = prefixes.join(', ');
	return {
		...request,
		options: request.options.map(option => isSessionOption(option)
			? { ...option, name: `Allow ${programs} for this session` }
			: option),
	};
}

let nextProtectedWrite = 0;

/**
 * The card for an agent's edit to a setting that decides what runs next, asked by GeminiCode
 * before the write in Auto Edit: the edit as a diff, with Allow and Reject only.
 */
export function protectedWriteRequest(sessionId: string, filePath: string, oldText: string | null, newText: string): acp.RequestPermissionRequest {
	return {
		sessionId,
		toolCall: {
			toolCallId: `geminicode-protected-write-${nextProtectedWrite++}`,
			status: 'pending',
			title: `Edit ${filePath}, which decides what runs next`,
			kind: 'edit',
			content: [{ type: 'diff', path: filePath, oldText, newText }],
			locations: [{ path: filePath }],
		},
		options: [
			{ optionId: 'allow', name: 'Allow', kind: 'allow_once' },
			{ optionId: 'reject', name: 'Reject', kind: 'reject_once' },
		],
	};
}

/** Whether `response` picked one of `request`'s allow options. */
export function isAllowed(request: acp.RequestPermissionRequest, response: acp.RequestPermissionResponse): boolean {
	const outcome = response.outcome;
	return outcome.outcome === 'selected' && request.options.some(option => option.optionId === outcome.optionId && option.kind.startsWith('allow'));
}
