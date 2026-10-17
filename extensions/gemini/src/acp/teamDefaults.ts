/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team's defaults for its tools, checked in at .gemini/geminicode-tools.json
// so each person only pastes a token: server addresses, the Jira projects,
// the SonarQube project key and how release branches are named. Never tokens.
//
//   {
//     "jira": { "site": "https://acme.atlassian.net", "projects": ["ACME"] },
//     "gitlab": { "url": "https://gitlab.acme.internal", "releaseBranches": "release/*", "defaultTarget": "develop" },
//     "sonar": { "url": "https://sonar.acme.internal", "projectKey": "acme-checkout" }
//   }

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const teamDefaultsFile = path.join('.gemini', 'geminicode-tools.json');

export interface TeamDefaults {
	readonly jira?: { readonly site?: string; readonly projects?: readonly string[]; readonly commentVisibility?: string };
	readonly gitlab?: { readonly url?: string; readonly releaseBranches?: string; readonly defaultTarget?: string; readonly project?: string };
	readonly sonar?: { readonly url?: string; readonly projectKey?: string };
	readonly snyk?: { readonly endpoint?: string };
	/** The file it came from, for the Connections page. */
	readonly file?: string;
}

/** The defaults in `folder` (a repository root), or {} when it has none or they don't parse. */
export async function readTeamDefaults(folder: string): Promise<TeamDefaults> {
	const file = path.join(folder, teamDefaultsFile);
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		return {};
	}
	try {
		return { ...sanitize(JSON.parse(text)), file };
	} catch {
		return {};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitize(raw: unknown): TeamDefaults {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
	const jira = o.jira ?? {};
	const gitlab = o.gitlab ?? {};
	const sonar = o.sonar ?? {};
	const snyk = o.snyk ?? {};
	return {
		jira: { site: str(jira.site), projects: Array.isArray(jira.projects) ? jira.projects.flatMap(p => str(p) ? [String(p).trim().toUpperCase()] : []) : undefined, commentVisibility: str(jira.commentVisibility) },
		gitlab: { url: str(gitlab.url), releaseBranches: str(gitlab.releaseBranches), defaultTarget: str(gitlab.defaultTarget), project: str(gitlab.project) },
		sonar: { url: str(sonar.url), projectKey: str(sonar.projectKey) },
		snyk: { endpoint: str(snyk.endpoint) },
	};
}

/** Whether `branch` is a release branch by the team's pattern (default `release/*`); `*` matches anything. */
export function isReleaseBranch(branch: string, pattern = 'release/*'): boolean {
	const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${source}$`).test(branch);
}

/**
 * Release branches ordered oldest first by the version in their name
 * (release/2026.10 before release/2026.11, release/1.9 before release/1.10).
 */
export function sortReleaseBranches(branches: readonly string[]): string[] {
	const parts = (branch: string) => (branch.match(/\d+/g) ?? []).map(Number);
	return [...branches].sort((a, b) => {
		const x = parts(a);
		const y = parts(b);
		for (let i = 0; i < Math.max(x.length, y.length); i++) {
			const d = (x[i] ?? -1) - (y[i] ?? -1);
			if (d) {
				return d;
			}
		}
		return a.localeCompare(b);
	});
}

/** The release branch a Jira fix version names, such as fix version "2026.11" for release/2026.11. */
export function releaseBranchForVersion(version: string, branches: readonly string[]): string | undefined {
	const v = version.trim().replace(/^v/i, '').toLowerCase();
	return branches.find(b => b.toLowerCase().endsWith(`/${v}`) || b.toLowerCase().endsWith(`-${v}`) || b.toLowerCase() === v)
		?? branches.find(b => b.toLowerCase().includes(v));
}
