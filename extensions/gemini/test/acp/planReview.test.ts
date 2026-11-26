/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { changedSections, planSections, replaceSection, reviewMessage, type PlanComment, type ReviewWords } from '../../src/acp/planReview';

const plan = [
	'# MCP integration plan',
	'',
	'## Goal',
	'Let agents call the team\'s tools through **MCP**.',
	'',
	'## Approach',
	'Add an `McpServerStore` beside `projectMcp.ts`.',
	'',
	'```ts',
	'// ## not a heading',
	'```',
	'',
	'## Steps',
	'1. Read servers from both places.',
	'2. Store tokens with `context.secrets`.',
	'',
	'## Steps',
	'A second list with the same heading.',
	'',
].join('\n');

const words: ReviewWords = {
	intro: 'Revise the plan in {0} using my review. Change only what the comments ask for, and keep my edits.',
	edited: 'I edited {0} myself.',
	comments: 'Comments:',
	onSection: 'On "{0}" ("{1}")',
	onText: 'On "{0}"',
	build: 'Carry out the plan in {0}.',
};

describe('planReview', () => {
	it('splits a plan into its headings\' sections, code blocks and repeated headings included', () => {
		expect(planSections(plan).map(({ id, heading, opening, start, end }) => ({ id, heading, opening, start, end }))).toEqual([
			{ id: 'h:mcp integration plan', heading: 'MCP integration plan', opening: '', start: 0, end: 2 },
			{ id: 'h:goal', heading: 'Goal', opening: 'Let agents call the team\'s tools through MCP.', start: 2, end: 5 },
			{ id: 'h:approach', heading: 'Approach', opening: 'Add an McpServerStore beside projectMcp.ts.', start: 5, end: 12 },
			{ id: 'h:steps', heading: 'Steps', opening: 'Read servers from both places. Store tokens with…', start: 12, end: 16 },
			{ id: 'h:steps#2', heading: 'Steps', opening: 'A second list with the same heading.', start: 16, end: 19 },
		]);
	});

	it('splits a plan without headings into its blocks', () => {
		expect(planSections('First idea.\nStill first.\n\n- a list\n- of two\n\n```\ncode\n\nmore code\n```\n').map(each => each.id + ': ' + each.markdown)).toEqual([
			'b:1: First idea.\nStill first.',
			'b:2: - a list\n- of two',
			'b:3: ```\ncode\n\nmore code\n```',
		]);
	});

	it('replaces one section and keeps the blank lines around it, and tells which sections a revision changed', () => {
		const edited = replaceSection(plan, 'h:goal', '## Goal\nLet agents call the team\'s tools through MCP, per workspace.\n');
		expect(edited?.split('\n').slice(2, 6)).toEqual(['## Goal', 'Let agents call the team\'s tools through MCP, per workspace.', '', '## Approach']);
		expect(replaceSection(plan, 'h:gone', 'x')).toBeUndefined();
		expect(changedSections(plan, `${edited}\n## Testing\nUnit tests.`)).toEqual(['h:goal', 'h:testing']);
	});

	it('puts every unsent comment in one message, with where each applies and what the user edited', () => {
		const comments: PlanComment[] = [
			{ id: 'c1', section: 'h:approach', heading: 'Approach', quote: 'Add an McpServerStore beside…', text: 'Reuse teamToolsMcp\'s server. ', createdAt: 1 },
			{ id: 'c0', section: 'h:goal', heading: 'Goal', quote: 'Let agents', text: 'Already done.', createdAt: 0, sentAt: 5 },
			{ id: 'c2', section: 'b:1', quote: 'First idea.', text: 'Drop this.', createdAt: 2 },
		];
		expect(reviewMessage('plan.md', comments, ['Steps'], words)).toBe([
			'Revise the plan in plan.md using my review. Change only what the comments ask for, and keep my edits.',
			'',
			'I edited "Steps" myself.',
			'',
			'Comments:',
			'1. On "Approach" ("Add an McpServerStore beside…"): Reuse teamToolsMcp\'s server.',
			'2. On "First idea.": Drop this.',
		].join('\n'));
		expect(reviewMessage('plan.md', [comments[1]], [], words)).toBeUndefined();
	});
});
