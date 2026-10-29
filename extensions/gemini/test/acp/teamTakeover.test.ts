/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { readTeamServers, removeTeamServers } from '../../src/acp/teamTakeover';

/** The shape of a team's settings file that runs its own Jira and GitLab servers, trimmed. */
function teamSettings(): Record<string, unknown> {
	return {
		mcpServers: {
			jira: {
				command: 'docker',
				args: ['run', '-i', '--rm', '-e', 'JIRA_URL', '-e', 'JIRA_USERNAME', '-e', 'JIRA_API_TOKEN', 'ghcr.io/sooperset/mcp-atlassian:latest'],
				env: { JIRA_URL: 'https://acme.atlassian.net', JIRA_USERNAME: 'me@acme.com', JIRA_API_TOKEN: '$JIRA_API_TOKEN' },
				trust: false,
				excludeTools: ['jira_delete_issue'],
			},
			gitlab: {
				command: 'docker',
				args: ['run', '-i', '--rm', '-e', 'GITLAB_PERSONAL_ACCESS_TOKEN', '-e', 'GITLAB_API_URL=https://gitlab.acme.internal/api/v4', 'zereight050/gitlab-mcp:latest'],
				trust: false,
			},
			figma: { httpUrl: 'http://127.0.0.1:3845/mcp' },
		},
		mcp: { allowed: ['jira', 'gitlab', 'geminicode-tools', 'geminicode-browser'] },
		security: { environmentVariableRedaction: { allowed: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'JIRA_API_TOKEN', 'NODE_ENV'] } },
	};
}

describe('taking over the team\'s servers', () => {
	it('reads each server\'s address, account and token from the file and the environment', () => {
		expect(readTeamServers(teamSettings(), { JIRA_API_TOKEN: 'jira-secret' })).toEqual({
			jira: { name: 'jira', url: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'jira-secret', tokenEnv: 'JIRA_API_TOKEN', secretEnv: ['JIRA_API_TOKEN'] },
			// The token's variable isn't set where GeminiCode started, so the take-over asks for it by name.
			gitlab: { name: 'gitlab', url: 'https://gitlab.acme.internal', tokenEnv: 'GITLAB_PERSONAL_ACCESS_TOKEN', secretEnv: ['GITLAB_PERSONAL_ACCESS_TOKEN'] },
		});
	});

	it('leaves the file without the two servers, their allowance and their tokens\' redaction exception', () => {
		const settings = teamSettings();
		const removed = removeTeamServers(settings, readTeamServers(settings, {}));
		expect({ removed, settings }).toEqual({
			removed: ['mcpServers.jira', 'mcpServers.gitlab', 'mcp.allowed', 'security.environmentVariableRedaction.allowed'],
			settings: {
				mcpServers: { figma: { httpUrl: 'http://127.0.0.1:3845/mcp' } },
				mcp: { allowed: ['geminicode-tools', 'geminicode-browser'] },
				security: { environmentVariableRedaction: { allowed: ['NODE_ENV'] } },
			},
		});
	});

	it('finds nothing to take over in a file without them', () => {
		expect(readTeamServers({ mcpServers: { figma: {} } }, {})).toEqual({});
	});
});
