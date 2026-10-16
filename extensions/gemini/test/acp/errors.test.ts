/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAgentError, isModelTurnRefusal } from '../../src/acp/errors';

interface Fixture { kind: string; code?: number; message: string; details?: string }
const fixtures: Record<string, Fixture[] | string> = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'agentErrors.json'), 'utf8'));

describe('classifyAgentError', () => {
	for (const [version, cases] of Object.entries(fixtures)) {
		if (typeof cases === 'string') {
			continue;
		}
		for (const fixture of cases) {
			it(`classifies ${fixture.kind} from CLI ${version}`, () => {
				expect(classifyAgentError({ code: fixture.code, message: fixture.message, data: fixture.details ? { details: fixture.details } : undefined }))
					.toEqual({ kind: fixture.kind, code: fixture.code, message: fixture.details ?? fixture.message });
			});
		}
	}

	it('falls back to the raw message', () => {
		expect(classifyAgentError(new Error('  Quota exceeded for project x  '))).toEqual({ kind: 'unknown', message: 'Quota exceeded for project x', code: undefined });
	});
});

describe('isModelTurnRefusal', () => {
	it('knows the refusal, in plain text and in the API JSON', () => {
		expect(isModelTurnRefusal('Requests ending with a model turn are not supported.')).toBe(true);
		expect(isModelTurnRefusal('{"error":{"code":400,"message":"Please ensure that single turn requests end with a user role or the role field is empty."}}')).toBe(true);
		expect(isModelTurnRefusal('Rate limit exceeded. Try again later.')).toBe(false);
	});
});
