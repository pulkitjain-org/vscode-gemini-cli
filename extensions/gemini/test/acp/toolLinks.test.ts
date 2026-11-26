/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { findToolRefs, parseTeamToolCall, parseToolLink, soleToolRef, teamToolTitle, toolRefId, toolRefLabel, toolRefUrl } from '../../src/acp/toolLinks';

const all = { connected: ['jira', 'gitlab', 'figma'] };

describe('tool refs', () => {
	it('reads Jira, GitLab and Figma links', () => {
		expect(parseToolLink('https://acme.atlassian.net/browse/ACME-412')).toEqual({ tool: 'jira', key: 'ACME-412' });
		expect(parseToolLink('https://acme.atlassian.net/jira/software/projects/ACME/boards/1?selectedIssue=ACME-9')).toEqual({ tool: 'jira', key: 'ACME-9' });
		expect(parseToolLink('https://gitlab.acme.internal/shop/acme-checkout/-/merge_requests/301/diffs.')).toEqual({
			tool: 'gitlab', kind: 'mr', project: 'shop/acme-checkout', iid: 301, url: 'https://gitlab.acme.internal/shop/acme-checkout/-/merge_requests/301',
		});
		expect(parseToolLink('https://gitlab.acme.internal/shop/a/-/issues/45')).toMatchObject({ kind: 'issue', iid: 45 });
		expect(parseToolLink('https://www.figma.com/design/AbC/Checkout?node-id=12-34')).toMatchObject({ tool: 'figma', fileKey: 'AbC', nodeId: '12:34' });
		expect(parseToolLink('https://example.com/x')).toBeUndefined();
	});

	it('finds keys and links in text, once each, for connected tools only', () => {
		const text = 'Build ACME-412 from https://www.figma.com/design/K/x?node-id=1-2 and see ACME-412 again; also UTF-8';
		expect(findToolRefs(text, { ...all, jiraProjects: ['ACME'] }).map(toolRefId)).toEqual(['figma:K:1:2', 'jira:ACME-412']);
		expect(findToolRefs(text, { connected: ['gitlab'] })).toEqual([]);
	});

	it('takes lower-case keys only for the team\'s projects', () => {
		expect(findToolRefs('on acme-412 now', { connected: ['jira'], jiraProjects: ['ACME'] }).map(toolRefId)).toEqual(['jira:ACME-412']);
		expect(findToolRefs('on acme-412 now', { connected: ['jira'] })).toEqual([]);
		expect(findToolRefs('release-2026 and ISO-8601', { connected: ['jira'], jiraProjects: ['ACME'] })).toEqual([]);
	});

	it('knows a paste that is only one ref', () => {
		expect(soleToolRef(' https://gitlab.acme.internal/shop/a/-/merge_requests/7 ', all)).toMatchObject({ tool: 'gitlab', iid: 7 });
		expect(soleToolRef('see ACME-1', all)).toBeUndefined();
	});

	it('labels refs briefly', () => {
		expect(toolRefLabel({ tool: 'jira', key: 'ACME-1' })).toBe('ACME-1');
		expect(toolRefLabel({ tool: 'gitlab', kind: 'mr', project: 'a/b', iid: 3, url: '' })).toBe('!3');
		expect(toolRefLabel({ tool: 'gitlab', kind: 'issue', project: 'a/b', iid: 3, url: '' })).toBe('#3');
	});

	it('finds a chip\'s page from its id again, and nothing for a tool whose site it doesn\'t know', () => {
		const sites = { jira: 'https://acme.atlassian.net/', gitlab: 'https://gitlab.acme.internal' };
		const links = [
			'https://acme.atlassian.net/browse/ACME-412',
			'https://gitlab.acme.internal/shop/web/-/merge_requests/318',
			'https://gitlab.acme.internal/shop/web/-/issues/45',
			'https://www.figma.com/design/AbC123/Checkout?node-id=12-34',
		];
		expect(links.map(link => toolRefUrl(toolRefId(parseToolLink(link)!), sites))).toEqual([
			'https://acme.atlassian.net/browse/ACME-412',
			'https://gitlab.acme.internal/shop/web/-/merge_requests/318',
			'https://gitlab.acme.internal/shop/web/-/issues/45',
			'https://www.figma.com/design/AbC123?node-id=12-34',
		]);
		expect([toolRefUrl('jira:ACME-1', {}), toolRefUrl('gitlab:mr:a/b:3', { jira: sites.jira }), toolRefUrl('jira:not a key', sites), toolRefUrl('other:x', sites)]).toEqual([undefined, undefined, undefined, undefined]);
	});
});

describe('Confluence page links', () => {
	it('reads a page link as a Confluence ref, before a Jira link on the same site, and opens it on its own site', () => {
		const page = parseToolLink('https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Checkout+Design');
		const byId = parseToolLink('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=987');
		expect({
			page,
			byId: byId && toolRefId(byId),
			edit: parseToolLink('https://acme.atlassian.net/wiki/spaces/ENG/pages/edit-v2/555')?.tool,
			tiny: parseToolLink('https://acme.atlassian.net/wiki/x/AbCd'),
			label: page && toolRefLabel(page),
			url: page && toolRefUrl(toolRefId(page), {}),
			found: findToolRefs('See https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Checkout and ACME-1', { connected: ['confluence'] }).map(toolRefId),
		}).toEqual({
			page: { tool: 'confluence', url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Checkout+Design', host: 'acme.atlassian.net', pageId: '123456' },
			byId: 'confluence:acme.atlassian.net:987',
			edit: 'confluence',
			tiny: undefined,
			label: 'Page 123456',
			url: 'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123456',
			found: ['confluence:acme.atlassian.net:123456'],
		});
	});
});

describe('team tool titles', () => {
	it('reads the CLI\'s title for an MCP call', () => {
		expect(parseTeamToolCall('jira_comment({"key":"ACME-1","text":"Done"})')).toEqual({ tool: 'jira', name: 'jira_comment', args: { key: 'ACME-1', text: 'Done' } });
		expect(parseTeamToolCall('gitlab_list_mrs')).toEqual({ tool: 'gitlab', name: 'gitlab_list_mrs', args: {} });
		expect(parseTeamToolCall('run_shell_command(ls)')).toBeUndefined();
		expect(parseTeamToolCall('jira_search is not a call')).toBeUndefined();
	});

	it('gives friendly titles, with the text a change would post', () => {
		expect(teamToolTitle('jira_get_issue({"key":"ACME-412"})')).toEqual({ tool: 'jira', title: 'Read ACME-412' });
		expect(teamToolTitle('gitlab_get_mr({"mr":"318"})')?.title).toBe('Read !318');
		expect(teamToolTitle('gitlab_get_mr({})')?.title).toBe('Read this branch\'s merge request');
		expect(teamToolTitle('jira_comment({"key":"acme-412","text":"Ready for review"})')).toEqual({ tool: 'jira', title: 'Comment on ACME-412', text: 'Ready for review' });
		expect(teamToolTitle('jira_transition({"key":"ACME-1","to":"In Review"})')?.title).toBe('Move ACME-1 → In Review');
		expect(teamToolTitle('jira_log_time({"key":"ACME-412","spent":"1h 30m"})')).toEqual({ tool: 'jira', title: 'Log 1h 30m on ACME-412', effect: '1h 30m  ACME-412' });
		expect(teamToolTitle('gitlab_create_mr({"target":"develop","title":"Gift message"})')).toEqual({ tool: 'gitlab', title: 'Open merge request into develop', effect: '→ develop\nTitle: Gift message' });
		expect(teamToolTitle('snyk_test')).toEqual({ tool: 'snyk', title: 'Run Snyk on the dependencies' });
		expect(teamToolTitle('read_file(a.ts)')).toBeUndefined();
	});

	it('spells out a confirm-class action as the tool will record it', () => {
		expect(teamToolTitle('jira_transition({"key":"ACME-412","to":"In Review","comment":"Look at the cap.\\nAnd the test.","fields":{"Fix version":"2026.11"}})')).toEqual({
			tool: 'jira',
			title: 'Move ACME-412 → In Review',
			effect: 'ACME-412  → In Review\nFix version: 2026.11\nComment:\n  Look at the cap.\n  And the test.',
		});
		expect(teamToolTitle('gitlab_merge({"mr":"321","squash":true})')).toEqual({ tool: 'gitlab', title: 'Merge !321', effect: '!321\nSquash: true  Delete source branch: true' });
	});
});
