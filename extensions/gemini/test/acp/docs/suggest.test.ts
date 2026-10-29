/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { suggestDocs } from '../../../src/acp/docs/suggest';

describe('suggestDocs', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'suggest-')));
	afterAll(() => rmSync(base, { recursive: true, force: true }));
	const project = (name: string, files: Record<string, string>) => {
		const dir = path.join(base, name);
		mkdirSync(dir, { recursive: true });
		for (const [file, text] of Object.entries(files)) {
			writeFileSync(path.join(dir, file), text);
		}
		return dir;
	};

	it('suggests docs for the libraries a package.json names, at their version, once per site', async () => {
		const dir = project('web', { 'package.json': JSON.stringify({ dependencies: { 'react': '^18.3.1', 'react-dom': '^18.3.1', 'express': '~4.21.0', 'left-pad': '1.0.0' }, devDependencies: { vitest: '^2.1.0' } }) });
		expect((await suggestDocs(dir, new Set())).map(s => `${s.title} ${s.url}`)).toEqual([
			'React https://react.dev/reference',
			'Express https://expressjs.com/en/4x/api.html',
			'Vitest https://vitest.dev/api/',
		]);
		expect((await suggestDocs(dir, new Set(['https://react.dev/reference']))).map(s => s.title)).toEqual(['Express', 'Vitest']);
	});

	it('reads Python, Go, Rust and Gradle manifests', async () => {
		const dir = project('mixed', {
			'requirements.txt': 'Django==4.2.7\nrequests>=2.31  # http\n',
			'go.mod': 'module example.com/x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n',
			'Cargo.toml': '[dependencies]\ntokio = { version = "1.35", features = ["full"] }\nserde = "1.0"\n',
			'build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.2.0" }\n',
		});
		expect((await suggestDocs(dir, new Set())).map(s => `${s.title} ${s.url} (${s.manifest})`)).toEqual([
			'Django https://docs.djangoproject.com/en/4.2/ (requirements.txt)',
			'Requests https://requests.readthedocs.io/en/latest/ (requirements.txt)',
			'Gin https://gin-gonic.com/en/docs/ (go.mod)',
			'Tokio https://tokio.rs/tokio/tutorial (Cargo.toml)',
			'Serde https://serde.rs/ (Cargo.toml)',
			'Spring Boot https://docs.spring.io/spring-boot/ (build.gradle.kts)',
		]);
	});
});
