/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { advanceSetupProgress, noSetupProgress } from '../../src/acp/setupProgress';
import { AgentErrorKind } from '../../src/acp/errors';

const error = (kind: AgentErrorKind) => ({ phase: 'error' as const, error: { kind, message: kind } });

describe('advanceSetupProgress', () => {
	it('marks nothing while the CLI is missing or starting', () => {
		expect(advanceSetupProgress(noSetupProgress, error('agent-not-found'))).toEqual(noSetupProgress);
		expect(advanceSetupProgress(noSetupProgress, { phase: 'starting' })).toEqual(noSetupProgress);
	});

	it('marks the CLI ready when it asks for sign-in', () => {
		expect(advanceSetupProgress(noSetupProgress, error('auth-required'))).toEqual({ cliReady: true, signedIn: false, projectReady: false });
	});

	it('marks sign-in done when only the project is missing', () => {
		expect(advanceSetupProgress(noSetupProgress, error('project-id-required'))).toEqual({ cliReady: true, signedIn: true, projectReady: false });
	});

	it('marks everything done once a session is ready, and keeps it through a restart', () => {
		const done = advanceSetupProgress(noSetupProgress, { phase: 'ready' });
		expect(done).toEqual({ cliReady: true, signedIn: true, projectReady: true });
		expect(advanceSetupProgress(done, { phase: 'restarting' })).toEqual(done);
	});
});
