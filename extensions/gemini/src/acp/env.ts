/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The editor's network settings the agent should follow, read by the host. */
export interface AgentNetwork {
	/** `http.proxy`: used when the environment names no proxy. */
	readonly proxy?: string;
	/** `http.noProxy`: hosts that skip the proxy, when the environment names none. */
	readonly noProxy?: readonly string[];
}

/** The proxy variables, in the spellings the Gemini CLI (gaxios, undici) and the tools its shell runs read. */
export const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;

/** GeminiCode's own MCP servers listen on this machine; a proxy GeminiCode sets never handles them. */
const loopback = ['localhost', '127.0.0.1'];

/** Names that look like a credential: a token, a secret, a password or a key. */
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|_KEY$|_KEY_|CREDENTIAL/i;

/** The CLI's own variables, which it needs however their names look (its API key, its Google settings). */
const cliOwn = /^(GEMINI|GOOGLE)_/;

/**
 * `base` without the variables whose names look like credentials, except the
 * Gemini CLI's own. The agent's shell inherits its process environment, and a
 * tool it runs could print it, so a token meant for another program never
 * reaches the agent. A program the agent needs a token for gets it from the
 * user, as the environment denial's message says (adminPolicy.ts).
 */
export function withoutSecrets(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(base)) {
		if (!secretName.test(name) || cliOwn.test(name)) {
			env[name] = value;
		}
	}
	return env;
}

/**
 * The environment for the agent process. Proxy and CA settings
 * (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, ...) pass through from the
 * app's own environment; the resolved project is injected as GOOGLE_CLOUD_PROJECT.
 *
 * An app opened from the Dock has no shell variables, so the editor's
 * `http.proxy` and `http.noProxy` (`network`) fill in a proxy the environment
 * does not name, and Node is told to trust the Mac's certificates as well as
 * its own (`NODE_USE_SYSTEM_CA`, which the Node in Electron 43 reads), for
 * networks that inspect TLS. Whatever the environment already sets wins.
 */
export function buildAgentEnv(base: NodeJS.ProcessEnv, projectId: string | undefined, network: AgentNetwork = {}): NodeJS.ProcessEnv {
	const env = withoutSecrets(base);
	// The CLI prefers GOOGLE_CLOUD_PROJECT but also reads GOOGLE_CLOUD_PROJECT_ID;
	// set one, clear the other so they cannot disagree.
	delete env.GOOGLE_CLOUD_PROJECT_ID;
	if (projectId) {
		env.GOOGLE_CLOUD_PROJECT = projectId;
	}
	if (env.NODE_USE_SYSTEM_CA === undefined) {
		env.NODE_USE_SYSTEM_CA = '1';
	}
	Object.assign(env, editorProxyEnv(base, network));
	return env;
}

/** The proxy variables `network` adds to `base`: none when `base` names its own. */
export function editorProxyEnv(base: NodeJS.ProcessEnv, network: AgentNetwork): Record<string, string> {
	const added: Record<string, string> = {};
	const proxy = network.proxy?.trim();
	const ownProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(name => base[name]);
	const setsProxy = !ownProxy && !!proxy && isHttpProxy(proxy);
	if (setsProxy) {
		for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
			added[name] = proxy;
		}
	}
	if (!base.NO_PROXY && !base.no_proxy) {
		const hosts = [...network.noProxy ?? [], ...setsProxy ? loopback : []].map(host => host.trim()).filter(Boolean);
		if (hosts.length) {
			added.NO_PROXY = added.no_proxy = [...new Set(hosts)].join(',');
		}
	}
	return added;
}

/** Only an http or https proxy: the CLI refuses any other kind (its telemetry throws "Unsupported proxy type"). */
function isHttpProxy(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
	} catch {
		return false;
	}
}
