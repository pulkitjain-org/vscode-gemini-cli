/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { process } from '../../../base/parts/sandbox/electron-browser/globals.js';

export function createNativeAboutDialogDetails(productService: IProductService, osProps: IOSProperties, runningGeminiCliVersion?: string): { title: string; details: string; detailsToCopy: string } {
	let version = productService.version;
	if (productService.target) {
		version = `${version} (${productService.target} setup)`;
	} else if (productService.darwinUniversalAssetId) {
		version = `${version} (Universal)`;
	}
	// GEMINI-FORK: a release build stamps GeminiCode's own version into product.json; show it first.
	const geminiCodeVersion = (productService as { readonly geminiCodeVersion?: string }).geminiCodeVersion;
	if (geminiCodeVersion) {
		version = `${geminiCodeVersion} (Code - OSS ${version})`;
	}

	// GEMINI-FORK: no ElectronBuildId (only Microsoft's Electron sets it) and no Copilot runtime lines; the Gemini CLI instead:
	// the copy in use when the Gemini extension reports one, else the one bundled at build time.
	const geminiCliVersion = runningGeminiCliVersion || (productService as { readonly geminiCliVersion?: string }).geminiCliVersion || 'Unknown';

	const getDetails = (useAgo: boolean): string => {
		return localize({ key: 'geminiAboutDetail', comment: ['Electron, Chromium, Node.js, V8 and Gemini CLI are product names that need no translation'] },
			"Version: {0}\nCommit: {1}\nDate: {2}\nGemini CLI: {3}\nElectron: {4}\nChromium: {5}\nNode.js: {6}\nV8: {7}\nOS: {8}",
			version,
			productService.commit || 'Unknown',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown',
			geminiCliVersion,
			process.versions['electron'],
			process.versions['chrome'],
			process.versions['node'],
			process.versions['v8'],
			`${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`
		);
	};

	const details = getDetails(true);
	const detailsToCopy = getDetails(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
