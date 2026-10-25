/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { PermissionBroker, PermissionEvent } from '../../src/acp/permissions';

const request: acp.RequestPermissionRequest = {
	sessionId: 's1',
	toolCall: { toolCallId: 't1', title: 'Run npm test' },
	options: [
		{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
		{ optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
		{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
	],
};

const shell = (command: string): acp.RequestPermissionRequest => ({ ...request, toolCall: { toolCallId: command, title: command, kind: 'execute' } });

describe('PermissionBroker', () => {
	it('remembers shell programs allowed for the session and answers repeats with no card', async () => {
		const broker = new PermissionBroker();
		const events: PermissionEvent[] = [];
		broker.onDidChange(e => events.push(e));
		const first = broker.request(shell('grep -n x a.ts | head -n 10'));
		const [pending] = broker.pendingPermissions;
		expect(pending.request.options.map(o => o.name)).toEqual(['Allow', 'Allow grep, head for this session', 'Reject']);
		broker.select(pending.id, 'proceed_always');
		await first;
		// The CLI's taint check asks again; GeminiCode answers.
		expect(await broker.request(shell('grep -c y /tmp/out | head'))).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
		expect(events.map(e => e.kind)).toEqual(['requested', 'resolved', 'allowed']);
		// Not for a new program, the network, or a tool that is not the shell.
		void broker.request(shell('grep x a.ts | sort'));
		void broker.request(shell('grep x https://example.com'));
		void broker.request({ ...request, toolCall: { toolCallId: 'e', title: 'grep x a.ts', kind: 'edit' } });
		expect(broker.pendingPermissions).toHaveLength(3);
		broker.cancelAll();
	});

	it('reads the command from the tool input when the agent sends it, not from the title', async () => {
		const broker = new PermissionBroker();
		const titled = (title: string, command: string): acp.RequestPermissionRequest => ({ ...request, toolCall: { toolCallId: title, title, kind: 'execute', rawInput: { command } } });
		const first = broker.request(titled('List files', 'ls -la'));
		const [pending] = broker.pendingPermissions;
		expect(pending.request.options.map(o => o.name)).toContain('Allow ls for this session');
		broker.select(pending.id, 'proceed_always');
		await first;
		void broker.request(titled('ls -la', 'GIT_SSH_COMMAND=x git fetch'));
		expect(broker.pendingPermissions).toHaveLength(1);
		broker.cancelAll();
	});

	it('answers with the option the user picked', async () => {
		const broker = new PermissionBroker();
		const events: PermissionEvent[] = [];
		broker.onDidChange(e => events.push(e));
		const answer = broker.request(request);
		const [pending] = broker.pendingPermissions;
		expect(broker.select(pending.id, 'proceed_always')).toBe(true);
		expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_always' } });
		expect(events.map(e => e.kind)).toEqual(['requested', 'resolved']);
		expect(broker.pendingPermissions).toEqual([]);
	});

	it('only accepts options the request offered, and only once', async () => {
		const broker = new PermissionBroker();
		const answer = broker.request(request);
		const [pending] = broker.pendingPermissions;
		expect(broker.select(pending.id, 'proceed_always_and_save')).toBe(false);
		expect(broker.select(pending.id, 'cancel')).toBe(true);
		expect(broker.select(pending.id, 'proceed_once')).toBe(false);
		expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
	});

	it('never gives two requests the same id, across sessions', async () => {
		const first = new PermissionBroker();
		const second = new PermissionBroker();
		void first.request(request);
		void second.request(request);
		const ids = [...first.pendingPermissions, ...second.pendingPermissions].map(p => p.id);
		expect(new Set(ids).size).toBe(2);
		first.cancelAll();
		second.cancelAll();
	});

	it('allows the open requests, but not the confirm class, on a switch to YOLO', async () => {
		const broker = new PermissionBroker();
		broker.confirmOnly = r => r.toolCall.toolCallId === 'merge';
		const answers = Promise.all([broker.request(request), broker.request(shell('npm test'))]);
		void broker.request({ ...request, toolCall: { toolCallId: 'merge', title: 'gitlab_merge' } });
		broker.allowPending();
		expect({ answers: await answers, left: broker.pendingPermissions.map(p => p.request.toolCall.toolCallId) }).toEqual({
			answers: [{ outcome: { outcome: 'selected', optionId: 'proceed_once' } }, { outcome: { outcome: 'selected', optionId: 'proceed_once' } }],
			left: ['merge'],
		});
		broker.cancelAll();
	});

	it('answers every open request with cancelled when the turn stops', async () => {
		const broker = new PermissionBroker();
		const answers = Promise.all([broker.request(request), broker.request(request)]);
		broker.cancelAll();
		expect(await answers).toEqual([{ outcome: { outcome: 'cancelled' } }, { outcome: { outcome: 'cancelled' } }]);
	});
});

describe('the confirm class', () => {
	const transition: acp.RequestPermissionRequest = {
		...request,
		toolCall: { toolCallId: 'm1', title: 'jira_transition(key=ACME-412, to=In Review)', kind: 'other' },
		options: [
			{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
			{ optionId: 'proceed_always', name: 'Allow all server tools for this session', kind: 'allow_always' },
			{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
		],
	};

	it('shows a card with Allow once and Reject only, and never answers for the user', async () => {
		const broker = new PermissionBroker();
		broker.confirmOnly = r => r.toolCall.title?.startsWith('jira_transition') ?? false;
		// Even an instant answer and a session approval leave the confirm class alone.
		broker.answerAtOnce = () => ({ optionId: 'proceed_once', quiet: true });
		const answer = broker.request(transition);
		const [pending] = broker.pendingPermissions;
		expect(pending.request.options.map(o => o.kind)).toEqual(['allow_once', 'reject_once']);
		expect(broker.select(pending.id, 'proceed_always')).toBe(false);
		expect(broker.select(pending.id, 'proceed_once')).toBe(true);
		expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
		// A second request asks again.
		void broker.request(transition);
		expect(broker.pendingPermissions).toHaveLength(1);
		// Other tools still get their instant answer.
		expect(await broker.request({ ...transition, toolCall: { toolCallId: 'm2', title: 'jira_get_issue(key=ACME-412)', kind: 'other' } })).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
	});
});
