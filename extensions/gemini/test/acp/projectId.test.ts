/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/acp/env';
import { resolveProjectId, validateProjectId } from '../../src/acp/projectId';

describe('resolveProjectId', () => {
	it('prefers workspace, then user, then org default, then the environment', () => {
		const env = { GOOGLE_CLOUD_PROJECT: 'env-project' };
		expect(resolveProjectId({ workspace: 'ws-project', user: 'user-project', orgDefault: 'org-project', env })).toEqual({ projectId: 'ws-project', source: 'workspace' });
		expect(resolveProjectId({ workspace: ' ', user: 'user-project', orgDefault: 'org-project', env })).toEqual({ projectId: 'user-project', source: 'user' });
		expect(resolveProjectId({ orgDefault: 'org-project', env })).toEqual({ projectId: 'org-project', source: 'org' });
		expect(resolveProjectId({ env })).toEqual({ projectId: 'env-project', source: 'env' });
	});

	it('reads the environment variables in order', () => {
		expect(resolveProjectId({ env: { GOOGLE_CLOUD_PROJECT_ID: 'c', GOOGLE_CLOUD_PROJECT: 'b', GOOGLE_CLOUD_QUOTA_PROJECT: 'a' } })?.projectId).toBe('a');
		expect(resolveProjectId({ env: { GOOGLE_CLOUD_PROJECT_ID: 'c' } })?.projectId).toBe('c');
		expect(resolveProjectId({ env: {} })).toBeUndefined();
	});
});

describe('validateProjectId', () => {
	it('accepts project IDs', () => {
		for (const id of ['my-project-123', 'ric-prd-gemini-ca-apr', 'example.com:my-project']) {
			expect(validateProjectId(id), id).toBeUndefined();
		}
	});

	it('rejects project numbers and malformed IDs', () => {
		expect(validateProjectId('123456789012')).toBe('numeric');
		for (const id of ['My-Project', 'short', 'ends-with-hyphen-', '1starts-with-digit', 'has space']) {
			expect(validateProjectId(id), id).toBe('malformed');
		}
	});
});

describe('buildAgentEnv', () => {
	it('injects the project and keeps proxy settings', () => {
		const env = buildAgentEnv({ HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/ca.pem', GOOGLE_CLOUD_PROJECT_ID: 'stale' }, 'my-project');
		expect(env).toEqual({ HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/ca.pem', GOOGLE_CLOUD_PROJECT: 'my-project' });
	});
});
