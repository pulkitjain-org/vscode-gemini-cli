/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../../src/acp/errors';

interface Fixture { kind: string; code?: number; message: string }
const fixtures: Record<string, Fixture[] | string> = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'agentErrors.json'), 'utf8'));

describe('classifyAgentError', () => {
	for (const [version, cases] of Object.entries(fixtures)) {
		if (typeof cases === 'string') {
			continue;
		}
		for (const fixture of cases) {
			it(`classifies ${fixture.kind} from CLI ${version}`, () => {
				expect(classifyAgentError({ code: fixture.code, message: fixture.message })).toEqual({ kind: fixture.kind, code: fixture.code, message: fixture.message });
			});
		}
	}

	it('falls back to the raw message', () => {
		expect(classifyAgentError(new Error('  Quota exceeded for project x  '))).toEqual({ kind: 'unknown', message: 'Quota exceeded for project x', code: undefined });
	});
});
