/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes the licence notices for what the Gemini extension ships besides its
// own code: the bundled Gemini CLI, the packages bundled into dist/ and media/,
// the emoji data and the ripgrep GeminiCode adds to the CLI. The app's own
// ThirdPartyNotices.txt is upstream's and covers the workbench. The release
// build runs this after `npm run bundle-cli`, so the CLI's licence is there:
//
//   node gemini/scripts/third-party-notices.mts [output]
//
// The output defaults to extensions/gemini/ThirdPartyNotices.txt, which ships
// in the app beside the extension. A licence file that is missing stops it.

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const extensionDir = path.join(root, 'extensions', 'gemini');
const output = path.resolve(process.argv[2] ?? path.join(extensionDir, 'ThirdPartyNotices.txt'));

interface Component {
	readonly name: string;
	readonly version: string;
	readonly url: string;
	/** Licence and notice texts, in order. */
	readonly texts: readonly string[];
}

const mitText = (copyright: string) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function read(file: string): string {
	if (!fs.existsSync(file)) {
		throw new Error(`${path.relative(root, file)} is missing: install the dependencies (and run npm run bundle-cli in extensions/gemini) first.`);
	}
	return fs.readFileSync(file, 'utf8').trim();
}

/** A package from node_modules, with every licence and notice file it ships. */
function npmPackage(name: string, modules = path.join(extensionDir, 'node_modules')): Component {
	const dir = path.join(modules, ...name.split('/'));
	const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { version: string; homepage?: string; repository?: string | { url?: string } };
	const files = fs.readdirSync(dir).filter(file => /^(licen[cs]e|notice)/i.test(file)).sort();
	if (!files.length) {
		throw new Error(`${name} has no licence file in ${path.relative(root, dir)}.`);
	}
	const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
	const url = (pkg.homepage ?? repository ?? `https://www.npmjs.com/package/${name}`).replace(/^git\+/, '').replace(/\.git$/, '');
	return { name, version: pkg.version, url, texts: files.map(file => read(path.join(dir, file))) };
}

function geminiCli(): Component {
	const { version } = JSON.parse(read(path.join(extensionDir, 'package.json'))).bundledCli as { version: string };
	const dir = path.join(extensionDir, 'cli', version);
	const texts = [read(path.join(dir, 'LICENSE'))];
	// Apache-2.0 asks for the work's NOTICE file to travel with it; the npm package has had none so far.
	if (fs.existsSync(path.join(dir, 'NOTICE'))) {
		texts.push(read(path.join(dir, 'NOTICE')));
	}
	texts.push('The notices for the code the Gemini CLI bundles ship inside it, in bundle/bundled/third_party/THIRD_PARTY_NOTICES.');
	return { name: '@google/gemini-cli', version, url: 'https://github.com/google-gemini/gemini-cli', texts };
}

function emojibase(): Component {
	const { source } = JSON.parse(read(path.join(extensionDir, 'webview-src', 'emojiData.json'))) as { source: string };
	const version = /emojibase-data (\S+)/.exec(source)?.[1] ?? 'unknown';
	return { name: 'emojibase-data', version, url: 'https://github.com/milesj/emojibase', texts: [mitText('Copyright (c) 2017-2019 Miles Johnson')] };
}

function ripgrep(): Component[] {
	const wrapper = npmPackage('@vscode/ripgrep-universal', path.join(root, 'node_modules'));
	return [
		{ name: 'ripgrep', version: `as packaged by ${wrapper.name} ${wrapper.version}`, url: 'https://github.com/BurntSushi/ripgrep', texts: [mitText('Copyright (c) 2015 Andrew Gallant')] },
		wrapper,
	];
}

const components: Component[] = [
	geminiCli(),
	...['@agentclientprotocol/sdk', 'zod', 'highlight.js', 'katex', 'markdown-it', 'entities', 'linkify-it', 'mdurl', 'uc.micro', 'punycode.js', '@vscode/codicons'].map(name => npmPackage(name)),
	emojibase(),
	...ripgrep(),
];

const rule = '---------------------------------------------------------';
const text = [
	'NOTICES FOR THE GEMINI EXTENSION',
	'',
	'The Gemini extension is part of GeminiCode, licensed under the MIT License (LICENSE.txt in the app).',
	'It incorporates the material listed below.',
	...components.flatMap(component => ['', rule, '', `${component.name} ${component.version}`, component.url, '', component.texts.join('\n\n')]),
	'',
].join('\n');
fs.writeFileSync(output, text);
console.log(`Wrote the notices for ${components.length} components to ${path.relative(process.cwd(), output) || output}.`);
