/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashSource } from '../../src/acp/sourceHash';
import { chatProtocolHash, chatProtocolVersion } from '../../src/host/chatProtocol';

const protocolFile = path.join(__dirname, '..', '..', 'src', 'host', 'chatProtocol.ts');

describe('chat protocol version', () => {
	it('is bumped whenever the messages change', () => {
		const hash = hashSource(readFileSync(protocolFile, 'utf8'), 'export type FromWebview');
		expect(hash, `The messages in chatProtocol.ts changed: bump chatProtocolVersion (now ${chatProtocolVersion}) and set chatProtocolHash to '${hash}'`).toBe(chatProtocolHash);
	});

	it('hashes the declarations, not their comments or spacing', () => {
		const a = hashSource('const x = 1;\nexport type FromWebview = { a: 1 } // note\n', 'export type FromWebview');
		const b = hashSource('export type FromWebview   =\n\t{ a: 1 }\n/** said otherwise */', 'export type FromWebview');
		const c = hashSource('export type FromWebview = { a: 2 }', 'export type FromWebview');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
