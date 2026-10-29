/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The ripgrep that ships with the app, under `appRoot`, unpacked from its archive in a release build. */
export async function appRipgrep(appRoot: string, platform: string = process.platform, arch: string = process.arch): Promise<string | undefined> {
	const binary = platform === 'win32' ? 'rg.exe' : 'rg';
	for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
		const candidate = path.join(appRoot, modules, '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, binary);
		if (await fs.access(candidate).then(() => true, () => false)) {
			return candidate;
		}
	}
	return undefined;
}
