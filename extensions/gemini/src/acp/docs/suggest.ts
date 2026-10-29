/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Documentation worth attaching to a folder, from the libraries its
// manifests name (package.json, requirements.txt, pyproject.toml, go.mod,
// Cargo.toml, pom.xml, build.gradle): a short list of well-known docs sites
// that ships with GeminiCode, so nothing is looked up anywhere. Where a site
// keeps docs per version, the suggestion points at the folder's version.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface Dependency {
	readonly name: string;
	readonly version?: string;
	/** The manifest that names it. */
	readonly manifest: string;
}

export interface DocsSuggestion {
	readonly library: string;
	readonly version?: string;
	readonly title: string;
	readonly url: string;
	readonly manifest: string;
}

interface KnownDocs {
	readonly title: string;
	readonly url: string | ((version: Version) => string | undefined);
}

interface Version {
	readonly major: number;
	readonly minor: number;
}

const known: Readonly<Record<string, KnownDocs>> = {
	// npm
	'react': { title: 'React', url: 'https://react.dev/reference' },
	'next': { title: 'Next.js', url: 'https://nextjs.org/docs' },
	'vue': { title: 'Vue', url: 'https://vuejs.org/guide/' },
	'svelte': { title: 'Svelte', url: 'https://svelte.dev/docs' },
	'@angular/core': { title: 'Angular', url: 'https://angular.dev/overview' },
	'express': { title: 'Express', url: v => `https://expressjs.com/en/${v.major >= 5 ? 5 : 4}x/api.html` },
	'fastify': { title: 'Fastify', url: 'https://fastify.dev/docs/latest/' },
	'@nestjs/core': { title: 'NestJS', url: 'https://docs.nestjs.com/' },
	'zod': { title: 'Zod', url: 'https://zod.dev/' },
	'typescript': { title: 'TypeScript', url: 'https://www.typescriptlang.org/docs/handbook/' },
	'vitest': { title: 'Vitest', url: 'https://vitest.dev/api/' },
	'jest': { title: 'Jest', url: 'https://jestjs.io/docs/api' },
	'@playwright/test': { title: 'Playwright', url: 'https://playwright.dev/docs/api/class-playwright' },
	'tailwindcss': { title: 'Tailwind CSS', url: 'https://tailwindcss.com/docs' },
	'@prisma/client': { title: 'Prisma', url: 'https://www.prisma.io/docs' },
	'drizzle-orm': { title: 'Drizzle ORM', url: 'https://orm.drizzle.team/docs/overview' },
	'mongoose': { title: 'Mongoose', url: 'https://mongoosejs.com/docs/' },
	'axios': { title: 'Axios', url: 'https://axios-http.com/docs/intro' },
	'rxjs': { title: 'RxJS', url: 'https://rxjs.dev/api' },
	'vite': { title: 'Vite', url: 'https://vite.dev/guide/' },
	'@tanstack/react-query': { title: 'TanStack Query', url: 'https://tanstack.com/query/latest/docs/framework/react/overview' },
	'@reduxjs/toolkit': { title: 'Redux Toolkit', url: 'https://redux-toolkit.js.org/introduction/getting-started' },
	'graphql': { title: 'GraphQL', url: 'https://graphql.org/learn/' },
	// Python
	'django': { title: 'Django', url: v => `https://docs.djangoproject.com/en/${v.major}.${v.minor}/` },
	'flask': { title: 'Flask', url: 'https://flask.palletsprojects.com/en/stable/' },
	'fastapi': { title: 'FastAPI', url: 'https://fastapi.tiangolo.com/' },
	'pydantic': { title: 'Pydantic', url: 'https://docs.pydantic.dev/latest/' },
	'sqlalchemy': { title: 'SQLAlchemy', url: v => `https://docs.sqlalchemy.org/en/${v.major}${v.minor}/` },
	'pandas': { title: 'pandas', url: 'https://pandas.pydata.org/docs/reference/' },
	'numpy': { title: 'NumPy', url: 'https://numpy.org/doc/stable/reference/' },
	'pytest': { title: 'pytest', url: 'https://docs.pytest.org/en/stable/' },
	'requests': { title: 'Requests', url: 'https://requests.readthedocs.io/en/latest/' },
	// Go
	'github.com/gin-gonic/gin': { title: 'Gin', url: 'https://gin-gonic.com/en/docs/' },
	'gorm.io/gorm': { title: 'GORM', url: 'https://gorm.io/docs/' },
	'github.com/labstack/echo/v4': { title: 'Echo', url: 'https://echo.labstack.com/docs' },
	// JVM
	'spring-boot': { title: 'Spring Boot', url: 'https://docs.spring.io/spring-boot/' },
	'junit-jupiter': { title: 'JUnit 5', url: 'https://junit.org/junit5/docs/current/user-guide/' },
	// Rust
	'tokio': { title: 'Tokio', url: 'https://tokio.rs/tokio/tutorial' },
	'serde': { title: 'Serde', url: 'https://serde.rs/' },
	'axum': { title: 'axum', url: 'https://docs.rs/axum/latest/axum/' },
};

/** Libraries that share another's docs: the first name in a family is enough. */
const aliases: Readonly<Record<string, string>> = { 'prisma': '@prisma/client', 'playwright': '@playwright/test', 'react-dom': 'react', 'flask-sqlalchemy': 'sqlalchemy' };

/** Docs to suggest for `folder`, leaving out addresses it has (`have`) or the user dismissed. */
export async function suggestDocs(folder: string, have: ReadonlySet<string>): Promise<DocsSuggestion[]> {
	const dependencies = await readDependencies(folder);
	const seen = new Set<string>();
	const suggestions: DocsSuggestion[] = [];
	for (const dependency of dependencies) {
		const name = aliases[dependency.name.toLowerCase()] ?? dependency.name.toLowerCase();
		const docs = known[name] ?? (/^spring-boot/.test(name) ? known['spring-boot'] : undefined);
		if (!docs || seen.has(docs.title)) {
			continue;
		}
		const version = parseVersion(dependency.version);
		const url = typeof docs.url === 'string' ? docs.url : version ? docs.url(version) : undefined;
		if (!url || have.has(url)) {
			continue;
		}
		seen.add(docs.title);
		suggestions.push({ library: dependency.name, ...dependency.version ? { version: dependency.version } : {}, title: docs.title, url, manifest: dependency.manifest });
	}
	return suggestions;
}

export async function readDependencies(folder: string): Promise<Dependency[]> {
	const read = (name: string) => fs.readFile(path.join(folder, name), 'utf8').catch(() => undefined);
	const out: Dependency[] = [];
	const pkg = await read('package.json');
	if (pkg) {
		try {
			const json = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			for (const [name, version] of [...Object.entries(json.dependencies ?? {}), ...Object.entries(json.devDependencies ?? {})]) {
				out.push({ name, version: typeof version === 'string' ? version : undefined, manifest: 'package.json' });
			}
		} catch {
			// Not JSON.
		}
	}
	const requirements = await read('requirements.txt');
	for (const line of requirements?.split(/\r?\n/) ?? []) {
		const match = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[=~<>!]=?\s*([\w.*]+))?/.exec(line.replace(/#.*/, ''));
		if (match?.[1]) {
			out.push({ name: match[1], version: match[2], manifest: 'requirements.txt' });
		}
	}
	const pyproject = await read('pyproject.toml');
	if (pyproject) {
		for (const match of pyproject.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[=~<>!]=?\s*([\w.*]+))?[^"']*["']/g)) {
			out.push({ name: match[1], version: match[2], manifest: 'pyproject.toml' });
		}
		const poetry = /\[tool\.poetry(?:\.group\.\w+)?\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1];
		for (const match of poetry?.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"[\^~>=<]*([\w.]+)"|\{[^}]*version\s*=\s*"[\^~>=<]*([\w.]+)")/gm) ?? []) {
			out.push({ name: match[1], version: match[2] ?? match[3], manifest: 'pyproject.toml' });
		}
	}
	const goMod = await read('go.mod');
	for (const match of goMod?.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v([\d.]+)/gm) ?? []) {
		out.push({ name: match[1], version: match[2], manifest: 'go.mod' });
	}
	const cargo = await read('Cargo.toml');
	const cargoDeps = cargo && /\[(?:dev-)?dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1];
	for (const match of (cargoDeps || '').matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([\w.^~]+)"|\{[^}]*version\s*=\s*"([\w.^~]+)")/gm)) {
		out.push({ name: match[1], version: match[2] ?? match[3], manifest: 'Cargo.toml' });
	}
	const pom = await read('pom.xml');
	for (const match of pom?.matchAll(/<artifactId>([^<]+)<\/artifactId>\s*(?:<version>([^<]+)<\/version>)?/g) ?? []) {
		out.push({ name: match[1], version: match[2], manifest: 'pom.xml' });
	}
	for (const gradle of ['build.gradle', 'build.gradle.kts']) {
		const text = await read(gradle);
		for (const match of text?.matchAll(/["'][\w.-]+:([\w.-]+):([\w.-]+)["']/g) ?? []) {
			out.push({ name: match[1], version: match[2], manifest: gradle });
		}
		for (const match of text?.matchAll(/id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*["']([\w.-]+)["']/g) ?? []) {
			out.push({ name: 'spring-boot', version: match[1], manifest: gradle });
		}
	}
	return out;
}

/** The major and minor of a version range such as `^4.18.2` or `>=3.2`. */
export function parseVersion(version: string | undefined): Version | undefined {
	const match = version && /(\d+)(?:\.(\d+))?/.exec(version);
	return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0) } : undefined;
}
