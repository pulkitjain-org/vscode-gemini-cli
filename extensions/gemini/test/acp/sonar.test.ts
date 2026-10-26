/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSonar, sonarProjectKeyIn } from '../../src/acp/sonar';

describe('sonarProjectKeyIn', () => {
	it('reads sonar.projectKey from sonar-project.properties, if there is one', async () => {
		const withKey = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-'));
		await fs.writeFile(path.join(withKey, 'sonar-project.properties'), '# Shop\nsonar.projectName=Shop\n  sonar.projectKey : shop-web  \nsonar.sources=src\n');
		const withoutKey = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-'));
		await fs.writeFile(path.join(withoutKey, 'sonar-project.properties'), 'sonar.projectName=Shop\n#sonar.projectKey=old\n');
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-'));
		expect([await sonarProjectKeyIn(withKey), await sonarProjectKeyIn(withoutKey), await sonarProjectKeyIn(empty)]).toEqual(['shop-web', undefined, undefined]);
	});
});

describe('describeSonar', () => {
	it('describes a failed gate and its issues on a merge request', () => {
		const text = describeSonar({ project: 'shop', mergeRequest: '42' }, {
			status: 'ERROR',
			coverage: '71.5',
			failed: [{ metric: 'new_coverage', actual: '71.5', threshold: '80' }, { metric: 'new_bugs' }],
		}, [
			{ key: 'a', rule: 'ts:S1481', severity: 'MINOR', type: 'CODE_SMELL', message: 'Remove the unused "x".', file: 'src/cart.ts', line: 12, url: 'https://sonar/a' },
			{ key: 'b', rule: 'ts:S2259', severity: 'MAJOR', message: 'Possible null.', url: 'https://sonar/b' },
		]);
		expect(text).toBe([
			'SonarQube shop, merge request 42:',
			'Quality gate: failed · coverage 71.5%',
			'- new_coverage: 71.5 (threshold 80)',
			'- new_bugs: ? (threshold ?)',
			'2 open issues on new code:',
			'- [MINOR CODE_SMELL] src/cart.ts:12 Remove the unused "x". (ts:S1481)',
			'- [MAJOR]  Possible null. (ts:S2259)',
		].join('\n'));
	});

	it('names the branch or the main branch, and says when there is nothing open', () => {
		expect([
			describeSonar({ project: 'shop', branch: 'feature/cart' }, { status: 'OK', failed: [] }, []),
			describeSonar({ project: 'shop' }, undefined, [{ key: 'c', rule: 'r', severity: 'INFO', message: 'm', url: 'u' }]),
			describeSonar({ project: 'shop' }, { status: 'NONE', failed: [] }, []),
		]).toEqual([
			'SonarQube shop, branch feature/cart:\nQuality gate: passed\nNo open issues on new code.',
			'SonarQube shop, the main branch:\n1 open issue on new code:\n- [INFO]  m (r)',
			'SonarQube shop, the main branch:\nQuality gate: not computed\nNo open issues on new code.',
		]);
	});
});
