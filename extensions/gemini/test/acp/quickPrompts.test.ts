/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cleanCommitMessage, cleanEdit, cleanEnhancedPrompt, commitMessagePrompt, enhancePromptPrompt, inlineEditPrompt, knownFlash, quickEditModels } from '../../src/acp/quickPrompts';

describe('inlineEditPrompt', () => {
	it('marks the selection inside its surrounding lines', () => {
		const lines = ['a', 'b', 'c', 'd'];
		const { system, prompt } = inlineEditPrompt({ path: 'src/x.ts', languageId: 'typescript', lines, start: 1, end: 3, instruction: 'rename' });
		expect(system).toContain('<selection>');
		expect(prompt).toBe('File: src/x.ts (typescript)\n\na\n<selection>\nb\nc\n</selection>\nd\n\nRequest: rename');
	});

	it('shows at most 80 lines on each side', () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
		const { prompt } = inlineEditPrompt({ path: 'x', languageId: 'plaintext', lines, start: 150, end: 151, instruction: 'x' });
		expect(prompt).toContain('line 70\n');
		expect(prompt).not.toContain('line 69\n');
		expect(prompt).toContain('line 230\n');
		expect(prompt).not.toContain('line 231\n');
	});
});

describe('cleanEdit', () => {
	it('strips a code fence and keeps the original ending', () => {
		expect(cleanEdit('```ts\nconst a = 1;\n```', 'const a = 0;\n')).toBe('const a = 1;\n');
		expect(cleanEdit('const a = 1;\n\n', 'const a = 0;')).toBe('const a = 1;');
	});

	it('strips selection tags', () => {
		expect(cleanEdit('<selection>\n  x();\n</selection>', '  y();\n')).toBe('  x();\n');
	});

	it('keeps leading indentation', () => {
		expect(cleanEdit('    return 1;', '    return 0;\n')).toBe('    return 1;\n');
	});
});

describe('commitMessagePrompt', () => {
	it('includes recent subjects and the diff', () => {
		const { system, prompt } = commitMessagePrompt('diff --git a/a.ts b/a.ts\n+x', ['Fix y', 'Add z']);
		expect(system).toContain('recent subjects');
		expect(prompt).toContain('- Fix y\n- Add z');
		expect(prompt).toContain('+x');
	});

	it('cuts a long diff and lists its files', () => {
		const diff = 'diff --git a/a.ts b/a.ts\n' + '+x\n'.repeat(30_000) + 'diff --git a/b.ts b/b.ts\n+y';
		const { prompt } = commitMessagePrompt(diff, []);
		expect(prompt.length).toBeLessThan(41_000);
		expect(prompt).toContain('files changed: a.ts, b.ts');
	});
});

describe('cleanCommitMessage', () => {
	it('removes fences and quotes', () => {
		expect(cleanCommitMessage('```\nFix the total\n\nBody.\n```')).toBe('Fix the total\n\nBody.');
		expect(cleanCommitMessage('"Fix the total"\n')).toBe('Fix the total');
	});
});

describe('quickEditModels', () => {
	const cliFlash = { latest: 'gemini-9-flash', base: 'gemini-8-flash', codeAssist: 'gemini-7-flash' };
	const choose = (setting: string, chatModel?: string, latestRefused = false, codeAssist = false) => quickEditModels({ setting, chatModel, cliFlash, codeAssist, latestRefused });

	it('tries the latest Flash model, then the one every account has', () => {
		expect(choose('latestFlash')).toEqual(['gemini-9-flash', 'gemini-8-flash']);
		expect(choose('')).toEqual(['gemini-9-flash', 'gemini-8-flash']);
		expect(choose('latestFlash', undefined, true)).toEqual(['gemini-8-flash']);
		expect(quickEditModels({ setting: 'latestFlash', chatModel: undefined, cliFlash: {}, codeAssist: false, latestRefused: false })).toEqual([knownFlash.latest, knownFlash.base]);
	});

	it('falls back to the name Code Assist serves the base Flash model under', () => {
		expect(choose('latestFlash', undefined, false, true)).toEqual(['gemini-9-flash', 'gemini-7-flash']);
		expect(choose('latestFlash', undefined, true, true)).toEqual(['gemini-7-flash']);
		expect(choose('sameAsChat', 'gemini-8-flash', false, true)).toEqual(['gemini-7-flash']);
		expect(quickEditModels({ setting: 'latestFlash', chatModel: undefined, cliFlash: {}, codeAssist: true, latestRefused: false })).toEqual([knownFlash.latest, knownFlash.codeAssist]);
	});

	it('follows the chat unless it is on Auto', () => {
		expect(choose('sameAsChat', 'gemini-2.5-pro')).toEqual(['gemini-2.5-pro']);
		expect(choose('sameAsChat', 'auto')).toEqual(['gemini-9-flash', 'gemini-8-flash']);
		expect(choose('sameAsChat', 'auto-gemini-3')).toEqual(['gemini-9-flash', 'gemini-8-flash']);
		expect(choose('sameAsChat', undefined)).toEqual(['gemini-9-flash', 'gemini-8-flash']);
	});

	it('uses a model named in the setting', () => {
		expect(choose(' gemini-2.5-pro ', 'auto')).toEqual(['gemini-2.5-pro']);
	});
});

describe('enhancePromptPrompt', () => {
	it('sends the draft with the context it has', () => {
		const { system, prompt } = enhancePromptPrompt({ draft: 'fix login', folder: 'app', branch: 'main', activeFile: 'src/auth.ts (typescript)', attachments: ['auth.ts'], mode: 'Plan' });
		expect(system).toContain('never answer it');
		expect(system).toContain('Plan mode');
		expect(prompt).toBe('Context:\nFolder: app\nBranch: main\nOpen file: src/auth.ts (typescript)\nAttached: auth.ts\n\nRequest to rewrite:\n<request>\nfix login\n</request>');
	});

	it('sends only the request when there is no context', () => {
		const { system, prompt } = enhancePromptPrompt({ draft: 'x' });
		expect(system).not.toContain('mode;');
		expect(prompt).toBe('Request to rewrite:\n<request>\nx\n</request>');
	});

	it('keeps the newest messages of the conversation that fit, oldest first', () => {
		const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'agent' as const : 'user' as const, text: `${i} ${'x'.repeat(1000)}` }));
		const { prompt } = enhancePromptPrompt({ draft: 'again', history });
		expect(prompt).toContain('Agent: 9 ');
		expect(prompt).toContain('User: 8 ');
		expect(prompt).not.toContain('User: 6 ');
		expect(prompt.indexOf('User: 8')).toBeLessThan(prompt.indexOf('Agent: 9'));
	});

	it('cuts a long message', () => {
		const { prompt } = enhancePromptPrompt({ draft: 'x', history: [{ role: 'agent', text: 'y'.repeat(3000) }] });
		expect(prompt).toContain(`Agent: ${'y'.repeat(1500)}…`);
	});
});

describe('cleanEnhancedPrompt', () => {
	it('removes a preamble, tags, quotes and a fence', () => {
		expect(cleanEnhancedPrompt('Here is the improved prompt:\nFix the bug.', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('[MODE_UPDATE] planFix the bug.', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('[MODE_UPDATE] plan\nHere is the improved prompt:\nFix the bug.', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('**Enhanced prompt:**\nFix the bug.', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('<request>\nFix the bug.\n</request>', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('```\nFix the bug.\n```', 'fix')).toBe('Fix the bug.');
		expect(cleanEnhancedPrompt('"Fix the bug."', 'fix')).toBe('Fix the bug.');
	});

	it('keeps a fence inside the prompt', () => {
		const reply = 'Make this pass:\n```ts\nexpect(a).toBe(1);\n```';
		expect(cleanEnhancedPrompt(reply, 'x')).toBe(reply);
	});

	it('returns the original for an empty answer', () => {
		expect(cleanEnhancedPrompt('  \n', 'fix it')).toBe('fix it');
	});

	it('puts a dropped leading command back first', () => {
		expect(cleanEnhancedPrompt('Review the auth changes.', '/review auth')).toBe('/review Review the auth changes.');
		expect(cleanEnhancedPrompt('Then /review the auth changes.', '/review auth')).toBe('/review Then the auth changes.');
		expect(cleanEnhancedPrompt('/review the auth changes.', '/review auth')).toBe('/review the auth changes.');
	});

	it('takes out a leading command the draft did not have', () => {
		expect(cleanEnhancedPrompt('/refactor @src/auth.ts to extract the refresh.', 'refactor @src/auth.ts')).toBe('Refactor @src/auth.ts to extract the refresh.');
		expect(cleanEnhancedPrompt('/task Implement validation.', 'now do the same for signup')).toBe('Implement validation.');
		expect(cleanEnhancedPrompt('/usr/local/bin/node crashes on start.', 'node crashes')).toBe('/usr/local/bin/node crashes on start.');
	});

	it('puts dropped mentions back at the end', () => {
		expect(cleanEnhancedPrompt('Fix the empty-email case in the login form.', 'fix @src/auth.ts and @src/form.ts.')).toBe('Fix the empty-email case in the login form.\n\n@src/auth.ts @src/form.ts');
		expect(cleanEnhancedPrompt('Fix @src/auth.ts.', 'fix @src/auth.ts')).toBe('Fix @src/auth.ts.');
	});

	it('does not treat an e-mail address as a mention', () => {
		expect(cleanEnhancedPrompt('Email the owner.', 'email me@example.com')).toBe('Email the owner.');
	});
});
