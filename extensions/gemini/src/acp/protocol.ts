/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Host-agnostic ACP client code. Nothing under `src/acp` may import `vscode`
// (enforced by ESLint), so it can move into the workbench later if needed.

import * as acp from '@agentclientprotocol/sdk';

/** The only ACP protocol version this client speaks. */
export const SUPPORTED_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;

/** Oldest Gemini CLI release this client is tested against. */
export const MIN_CLI_VERSION = '0.61.0';

export const CLIENT_INFO: acp.Implementation = {
	name: 'geminicode',
	title: 'GeminiCode',
	version: '0.1.0',
};

export class UnsupportedProtocolVersionError extends Error {
	constructor(public readonly agentVersion: number) {
		super(`The agent speaks ACP protocol version ${agentVersion}, but this client supports only version ${SUPPORTED_PROTOCOL_VERSION}.`);
		this.name = 'UnsupportedProtocolVersionError';
	}
}
