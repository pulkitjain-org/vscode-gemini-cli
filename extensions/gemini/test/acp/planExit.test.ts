/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { planApprovalAnswer, planApprovalFile, planApprovalStep } from '../../src/acp/planExit';
import { PermissionBroker } from '../../src/acp/permissions';
import { SessionUpdateAdapter } from '../../src/acp/sessionUpdates';

const planTitle = 'Requesting plan approval for: /Users/sam/.gemini/tmp/acme-checkout-1/2becb28c/plans/freeship.md';

function request(title: string): acp.RequestPermissionRequest {
	return {
		sessionId: 's1',
		toolCall: { toolCallId: 'call-1', title, kind: 'other', status: 'pending' },
		options: [
			{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
			{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
		],
	};
}

describe('planExit', () => {
	it('recognises the CLI\'s plan approval by its title only', () => {
		expect([planApprovalFile(planTitle), planApprovalFile('npm test'), planApprovalFile(undefined), planApprovalFile('Requesting plan approval for:')]).toEqual([
			'/Users/sam/.gemini/tmp/acme-checkout-1/2becb28c/plans/freeship.md', undefined, undefined, undefined,
		]);
	});

	it('declines the plan approval quietly, and leaves other requests alone', () => {
		expect([planApprovalAnswer(request(planTitle)), planApprovalAnswer(request('npm test'))]).toEqual([{ optionId: 'cancel', quiet: true }, undefined]);
	});

	it('shows the step as the plan being ready, by file name, never as failed', () => {
		expect([
			planApprovalStep(planTitle, 'pending'),
			planApprovalStep(planTitle, 'failed'),
			planApprovalStep('Plan ready for review: freeship.md', 'failed'),
			planApprovalStep('npm test', 'failed'),
		]).toEqual([
			{ title: 'Plan ready for review: freeship.md', status: 'pending' },
			{ title: 'Plan ready for review: freeship.md', status: 'completed' },
			{ title: 'Plan ready for review: freeship.md', status: 'completed' },
			undefined,
		]);
	});

	it('rewrites the step as it arrives and as it finishes, with no path and no content', () => {
		const adapter = new SessionUpdateAdapter();
		const created = adapter.adapt({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: planTitle, kind: 'other', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: planTitle } }] });
		const finished = adapter.adapt({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' });
		const shown = [created, finished].map(event => event.kind === 'toolCall' ? { title: event.call.title, status: event.call.status, content: event.call.content.length } : event.kind);
		expect(shown).toEqual([
			{ title: 'Plan ready for review: freeship.md', status: 'pending', content: 0 },
			{ title: 'Plan ready for review: freeship.md', status: 'completed', content: 0 },
		]);
	});

	it('answers through the permission broker with no card', async () => {
		const broker = new PermissionBroker();
		broker.answerAtOnce = planApprovalAnswer;
		const events: string[] = [];
		broker.onDidChange(event => events.push(event.kind));
		const response = await broker.request(request(planTitle));
		expect({ response, events, pending: broker.pendingPermissions.length }).toEqual({ response: { outcome: { outcome: 'selected', optionId: 'cancel' } }, events: [], pending: 0 });
	});
});
