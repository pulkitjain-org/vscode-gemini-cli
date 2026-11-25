/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TeamToolId } from '../../src/acp/teamHttp';
import { teamToolsFor } from '../../src/acp/teamTools';

// The tools a session is offered are sent to the model before the chat, with
// every request. Gemini reuses what it has already read of a request's start
// (its implicit cache), so a tool list that came in another order, or with
// other words, would be read and paid for again from that point on.
describe('the team tools a session is offered', () => {
	it('come in one order and with the same words whichever tool was connected first', () => {
		const orders: TeamToolId[][] = [['jira', 'gitlab', 'sonar', 'snyk', 'figma', 'confluence'], ['confluence', 'figma', 'snyk', 'sonar', 'gitlab', 'jira'], ['gitlab', 'confluence', 'jira', 'figma', 'sonar', 'snyk']];
		const lists = orders.map(order => JSON.stringify(teamToolsFor(new Set(order))));
		expect([lists[1] === lists[0], lists[2] === lists[0], JSON.parse(lists[0]).length > 10]).toEqual([true, true, true]);
	});

	it('are the same list, less the tools that write, for an agent that only reads', () => {
		const all = teamToolsFor(new Set<TeamToolId>(['jira', 'gitlab'])).map(tool => tool.name);
		const reading = teamToolsFor(new Set<TeamToolId>(['gitlab', 'jira']), true).map(tool => tool.name);
		expect([reading.length < all.length, all.filter(name => reading.includes(name))]).toEqual([true, reading]);
	});
});
