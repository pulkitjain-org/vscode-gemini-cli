/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildAgentEnv, editorProxyEnv, isSecretVariable, withoutSecrets } from '../../src/acp/env';

describe('withoutSecrets', () => {
	it('leaves out every variable whose name looks like a credential, and keeps the rest', () => {
		const secrets = [
			'GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'PGPASSWORD', 'SSH_PASSWD', 'OPENAI_API_KEY', 'SIGNING_KEY_ID', 'AZURE_CREDENTIALS',
			'NPM_CONFIG__AUTH', 'AUTH_HEADER', 'GITHUB_PAT', 'DB_PASS', 'PASS_DB', 'MYSQL_PWD', 'SSH_PRIVATE_KEY', 'PRIVATE_KEY_PEM',
		];
		const plain = ['PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'NODE_OPTIONS', 'HTTPS_PROXY', 'NO_PROXY', 'MONKEY', 'KEYBOARD_LAYOUT', 'PASSTHROUGH', 'COMPASS_HOME', 'AUTHOR', 'PATTERN', 'PATH_INFO'];
		const base = Object.fromEntries([...secrets, ...plain].map(name => [name, 'x']));
		expect(Object.keys(withoutSecrets(base))).toEqual(plain);
	});

	it('leaves out a URL with a password in it, whatever the variable is called', () => {
		const base = { DATABASE_URL: 'postgres://app:s3cret@db.internal:5432/app', REDIS: 'redis://:pw@cache/0', SITE: 'https://docs.example.com/a:b', REGISTRY: 'https://user@registry.example.com', PROXY: 'http://proxy:3128' };
		expect(Object.keys(withoutSecrets(base))).toEqual(['SITE', 'REGISTRY', 'PROXY']);
	});

	it('keeps the CLI\'s own variables however they look', () => {
		const base = { GEMINI_API_KEY: 'k', GOOGLE_APPLICATION_CREDENTIALS: '/c.json', GOOGLE_CLOUD_PROJECT: 'p', GEMINI_SANDBOX_PROXY_URL: 'http://u:p@proxy' };
		expect(withoutSecrets(base)).toEqual(base);
		expect([isSecretVariable('GEMINI_API_KEY', 'k'), isSecretVariable('MY_API_KEY', 'k'), isSecretVariable('DSN', 'mysql://a:b@h')]).toEqual([false, true, true]);
	});
});

describe('buildAgentEnv', () => {
	it('sets the project, clears the other spelling, trusts the system certificates, and fills in the editor\'s proxy', () => {
		const env = buildAgentEnv({ PATH: '/usr/bin', GOOGLE_CLOUD_PROJECT_ID: 'old', NPM_TOKEN: 't' }, 'proj', { proxy: 'http://proxy:3128', noProxy: ['*.internal'] });
		expect(env).toEqual({
			PATH: '/usr/bin', GOOGLE_CLOUD_PROJECT: 'proj', NODE_USE_SYSTEM_CA: '1',
			HTTPS_PROXY: 'http://proxy:3128', https_proxy: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', http_proxy: 'http://proxy:3128',
			NO_PROXY: '*.internal,localhost,127.0.0.1', no_proxy: '*.internal,localhost,127.0.0.1',
		});
	});

	it('lets the environment\'s own proxy and certificate settings win', () => {
		expect(buildAgentEnv({ HTTPS_PROXY: 'http://mine:1', NODE_USE_SYSTEM_CA: '0' }, undefined, { proxy: 'http://proxy:3128' })).toEqual({ HTTPS_PROXY: 'http://mine:1', NODE_USE_SYSTEM_CA: '0' });
		expect(editorProxyEnv({}, { proxy: 'socks5://proxy:1080' })).toEqual({});
	});
});
