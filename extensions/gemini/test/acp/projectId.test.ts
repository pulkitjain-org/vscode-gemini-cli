/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/acp/env';
import { resolveProjectId, validateProjectId, workspaceOverride } from '../../src/acp/projectId';

describe('resolveProjectId', () => {
	it('prefers workspace, then user, then org default, then the environment', () => {
		const env = { GOOGLE_CLOUD_PROJECT: 'env-project' };
		expect(resolveProjectId({ workspace: 'ws-project', user: 'user-project', orgDefault: 'org-project', env })).toEqual({ projectId: 'ws-project', source: 'workspace' });
		expect(resolveProjectId({ workspace: ' ', user: 'user-project', orgDefault: 'org-project', env })).toEqual({ projectId: 'user-project', source: 'user' });
		expect(resolveProjectId({ orgDefault: 'org-project', env })).toEqual({ projectId: 'org-project', source: 'org' });
		expect(resolveProjectId({ env })).toEqual({ projectId: 'env-project', source: 'env' });
	});

	it('puts an admin\'s policy first, and says what a workspace value replaces', () => {
		const env = {};
		expect(resolveProjectId({ policy: 'managed-project', workspace: 'ws-project', user: 'user-project', env })).toEqual({ projectId: 'managed-project', source: 'policy' });
		expect([
			workspaceOverride({ workspace: 'ws-project', user: 'user-project', env }),
			workspaceOverride({ workspace: 'ws-project', orgDefault: 'org-project', env }),
			workspaceOverride({ workspace: 'same-project', user: 'same-project', env }),
			workspaceOverride({ workspace: 'ws-project', env }),
			workspaceOverride({ policy: 'managed-project', workspace: 'ws-project', user: 'user-project', env }),
		]).toEqual(['user-project', 'org-project', undefined, undefined, undefined]);
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
		const env = buildAgentEnv({ HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/ca.pem', GOOGLE_CLOUD_PROJECT_ID: 'stale' }, 'my-project', { proxy: 'http://editor-proxy:8080', noProxy: ['corp.example'] });
		expect(env).toEqual({ HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/ca.pem', GOOGLE_CLOUD_PROJECT: 'my-project', NODE_USE_SYSTEM_CA: '1', NO_PROXY: 'corp.example', no_proxy: 'corp.example' });
	});

	it('takes the editor\'s proxy when the environment names none, never past GeminiCode\'s own servers', () => {
		expect(buildAgentEnv({ PATH: '/usr/bin' }, undefined, { proxy: ' http://proxy.corp:3128 ', noProxy: ['*.corp.example', 'localhost'] })).toEqual({
			PATH: '/usr/bin',
			NODE_USE_SYSTEM_CA: '1',
			HTTPS_PROXY: 'http://proxy.corp:3128',
			https_proxy: 'http://proxy.corp:3128',
			HTTP_PROXY: 'http://proxy.corp:3128',
			http_proxy: 'http://proxy.corp:3128',
			NO_PROXY: '*.corp.example,localhost,127.0.0.1',
			no_proxy: '*.corp.example,localhost,127.0.0.1',
		});
	});

	it('keeps what the environment sets, and skips a proxy the CLI cannot use', () => {
		expect([
			buildAgentEnv({ https_proxy: 'http://shell:1', no_proxy: 'shell.example', NODE_USE_SYSTEM_CA: '0' }, undefined, { proxy: 'http://editor:2', noProxy: ['editor.example'] }),
			buildAgentEnv({}, undefined, { proxy: 'socks5://proxy:1080' }),
			buildAgentEnv({}, undefined, { proxy: 'not a url' }),
		]).toEqual([
			{ https_proxy: 'http://shell:1', no_proxy: 'shell.example', NODE_USE_SYSTEM_CA: '0' },
			{ NODE_USE_SYSTEM_CA: '1' },
			{ NODE_USE_SYSTEM_CA: '1' },
		]);
	});
});
