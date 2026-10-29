/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { teamStatusSummary } from '../../src/acp/teamStatus';

describe('teamStatusSummary', () => {
	it('says nothing when no tool is connected', () => {
		expect(teamStatusSummary([{ tool: 'jira', kind: 'off' }]).word).toBe('none');
	});

	it('says Connected when every tool answers, and a closed Figma is fine', () => {
		expect(teamStatusSummary([{ tool: 'jira', kind: 'connected' }, { tool: 'figma', kind: 'unreachable' }, { tool: 'sonar', kind: 'off' }]))
			.toEqual({ word: 'connected', connected: ['jira', 'figma'], affected: [] });
	});

	it('says VPN off when a VPN-only tool does not answer, but not for Jira', () => {
		expect(teamStatusSummary([{ tool: 'jira', kind: 'connected' }, { tool: 'gitlab', kind: 'unreachable' }, { tool: 'snyk', kind: 'unreachable' }]))
			.toMatchObject({ word: 'vpnOff', affected: ['gitlab', 'snyk'] });
		expect(teamStatusSummary([{ tool: 'jira', kind: 'unreachable' }]).word).toBe('connected');
	});

	it('puts a refused token before the VPN', () => {
		expect(teamStatusSummary([{ tool: 'jira', kind: 'auth' }, { tool: 'gitlab', kind: 'unreachable' }]))
			.toMatchObject({ word: 'attention', affected: ['jira'] });
	});
});
