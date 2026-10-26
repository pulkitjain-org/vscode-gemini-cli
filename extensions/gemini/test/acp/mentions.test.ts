/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFileCount, codeAround, countProblems, foldersOf, type Problem, problemsReport, symbolLines } from '../../src/acp/mentions';

const root = path.join(path.sep, 'w');
const file = (relative: string) => ({ path: path.join(root, ...relative.split('/')), relative });

describe('foldersOf', () => {
	it('offers the folders the files are in, and the folders above them, best match first', () => {
		const files = [file('src/auth/login.ts'), file('src/auth/session.ts'), file('src/app.ts'), file('README.md')];
		expect({
			auth: foldersOf(files, 'auth', 5),
			all: foldersOf(files, '', 5).map(folder => folder.relative),
		}).toEqual({
			auth: [{ path: path.join(root, 'src', 'auth'), relative: 'src/auth' }],
			all: ['src', 'src/auth'],
		});
	});
});

describe('the Problems row', () => {
	const problems: Problem[] = [
		{ file: path.join(root, 'src', 'b.ts'), severity: 'warning', line: 3, column: 1, message: 'Unused import.', source: 'eslint' },
		{ file: path.join(root, 'src', 'a.ts'), severity: 'error', line: 42, column: 33, message: 'Cannot find name `Requst`.\nDid you mean `Request`?', source: 'ts', code: '2552' },
		{ file: path.join(root, 'src', 'a.ts'), severity: 'info', line: 1, column: 1, message: 'Note.' },
	];

	it('counts errors and warnings, and lists errors first relative to the folder, one line each', () => {
		expect({
			counts: countProblems(problems),
			report: problemsReport(problems, root).split('\n'),
			capped: problemsReport(problems, root, 1).split('\n'),
		}).toEqual({
			counts: { errors: 1, warnings: 1 },
			report: [
				'src/a.ts:42:33 error: Cannot find name `Requst`. Did you mean `Request`? (ts 2552)',
				'src/b.ts:3:1 warning: Unused import. (eslint)',
				'src/a.ts:1:1 info: Note.',
			],
			capped: ['src/a.ts:42:33 error: Cannot find name `Requst`. Did you mean `Request`? (ts 2552)', '# 2 more problems left out'],
		});
	});
});

describe('code attached with a problem or a symbol', () => {
	const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

	it('takes the lines around a problem, and a definition\'s own lines, within the file', () => {
		const around = codeAround('/w/a.ts', text, 3, 3, 2, 'typescript');
		const symbol = symbolLines('/w/a.ts', text, 28, 40);
		const long = symbolLines('/w/a.ts', text, 5, 30, 3);
		expect({
			around: { ...around, text: around.text.split('\n') },
			symbol: [symbol.startLine, symbol.endLine],
			long: [long.startLine, long.endLine, long.text],
			changes: changedFileCount(' M a.ts\n?? b.ts\n\n'),
		}).toEqual({
			around: { kind: 'selection', path: '/w/a.ts', text: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'], startLine: 1, endLine: 5, languageId: 'typescript' },
			symbol: [28, 30],
			long: [5, 7, 'line 5\nline 6\nline 7'],
			changes: 2,
		});
	});
});
