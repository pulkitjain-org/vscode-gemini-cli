/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The environment for the agent process. Proxy and CA settings
 * (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, ...) pass through from the
 * app's own environment; the resolved project is injected as GOOGLE_CLOUD_PROJECT.
 */
export function buildAgentEnv(base: NodeJS.ProcessEnv, projectId: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	// The CLI prefers GOOGLE_CLOUD_PROJECT but also reads GOOGLE_CLOUD_PROJECT_ID;
	// set one, clear the other so they cannot disagree.
	delete env.GOOGLE_CLOUD_PROJECT_ID;
	if (projectId) {
		env.GOOGLE_CLOUD_PROJECT = projectId;
	}
	return env;
}
