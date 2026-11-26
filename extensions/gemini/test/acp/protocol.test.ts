/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AGENT_SETUP_ERROR_CODE } from '../../src/acp/errors';
import { FileAccessDeniedError } from '../../src/acp/fileAccess';
import { SUPPORTED_PROTOCOL_VERSION } from '../../src/acp/protocol';

// protocol.ts and fileAccess.ts import the SDK for types only, so that it loads when an agent
// starts rather than when the extension activates. These keep their copies equal to the SDK's.

describe('protocol constants', () => {
	it('supports the protocol version the SDK speaks', () => {
		expect(SUPPORTED_PROTOCOL_VERSION).toBe(acp.PROTOCOL_VERSION);
	});

	it('denies a file with the setup error code', () => {
		const err = new FileAccessDeniedError('/work/.env', 'it matches a denied pattern');
		expect({ code: err.code, name: err.name, isError: err instanceof Error }).toEqual({ code: AGENT_SETUP_ERROR_CODE, name: 'FileAccessDeniedError', isError: true });
	});
});
