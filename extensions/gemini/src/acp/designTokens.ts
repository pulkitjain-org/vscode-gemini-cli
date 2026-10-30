/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a Figma read needs of the repository's design system (designSystem.ts):
// whether Code Connect is on, and the tokens that name its colours. In
// dist/onDemand.js with Figma's client, so the extension bundle carries none of
// it; its cache is this bundle's own.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { designSystemConfig, type DesignSystemConfig, tokenIndex, type TokenIndex } from './designSystem';
import type { TeamDefaults } from './teamDefaults';

const tokenIndexes = new Map<string, { readonly mtimeMs: number; readonly index: TokenIndex }>();

/** The token index of the design system's skill in `folder`, read again only when its tokens.md changes; empty without one. */
export async function readTokenIndex(folder: string, config: DesignSystemConfig): Promise<TokenIndex> {
	const file = path.join(folder, config.skill, 'references', 'tokens.md');
	try {
		const { mtimeMs } = await fs.stat(file);
		const cached = tokenIndexes.get(file);
		if (cached?.mtimeMs === mtimeMs) {
			return cached.index;
		}
		const index = tokenIndex(await fs.readFile(file, 'utf8'));
		tokenIndexes.set(file, { mtimeMs, index });
		return index;
	} catch {
		return new Map();
	}
}

/** Code Connect and the tokens for a Figma read in the repository whose defaults are `defaults`; undefined without a design system. */
export async function figmaDesignSystem(defaults: TeamDefaults): Promise<{ readonly codeConnect?: boolean; readonly tokens: TokenIndex } | undefined> {
	const config = designSystemConfig(defaults);
	return config && { ...config.codeConnect === undefined ? {} : { codeConnect: config.codeConnect }, tokens: await readTokenIndex(config.root, config) };
}
