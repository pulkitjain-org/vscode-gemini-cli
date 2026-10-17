/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// SonarQube (over the VPN) through its Web API with the user's token: the
// quality gate and new-code issues of a branch or merge request.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Fetch, normalizeBaseUrl, teamRequest, TeamToolError } from './teamHttp';

export interface SonarAuth {
	readonly url: string;
	readonly token: string;
}

/** Where to look: a branch, or a merge request (SonarQube calls it a pull request). */
export interface SonarTarget {
	readonly project: string;
	readonly branch?: string;
	readonly mergeRequest?: string;
}

export interface SonarGate {
	readonly status: 'OK' | 'WARN' | 'ERROR' | 'NONE';
	readonly failed: readonly { readonly metric: string; readonly actual?: string; readonly threshold?: string }[];
	readonly coverage?: string;
}

export interface SonarIssue {
	readonly key: string;
	readonly rule: string;
	readonly severity: string;
	readonly type?: string;
	readonly message: string;
	readonly file?: string;
	readonly line?: number;
	readonly url: string;
}

export class SonarClient {

	readonly url: string;

	constructor(private readonly auth: SonarAuth, private readonly fetcher: Fetch = fetch) {
		this.url = normalizeBaseUrl(auth.url);
	}

	private request<T>(pathAndQuery: string, init: Parameters<typeof teamRequest>[2] = {}): Promise<T> {
		return teamRequest<T>('sonar', `${this.url}${pathAndQuery}`, { ...init, headers: { Authorization: `Bearer ${this.auth.token}`, ...init.headers } }, this.fetcher);
	}

	/** The signed-in user; throws when the token is refused. */
	async user(): Promise<{ readonly login: string; readonly name: string }> {
		const valid = await this.request<{ valid?: boolean }>('/api/authentication/validate');
		const user = await this.request<{ login?: string; name?: string; isLoggedIn?: boolean }>('/api/users/current');
		if (!valid?.valid || user?.isLoggedIn === false) {
			throw new TeamToolError('auth', 'SonarQube refused the token. It may have expired or been revoked: replace it in Connections.');
		}
		return { login: user.login ?? '', name: user.name ?? user.login ?? '' };
	}

	async version(): Promise<string | undefined> {
		return (await this.request<string>('/api/server/version', { text: true }))?.trim();
	}

	async gate(target: SonarTarget): Promise<SonarGate> {
		const query = targetQuery(target, 'projectKey');
		const [gate, measures] = await Promise.all([
			this.request<{ projectStatus?: { status?: string; conditions?: { status: string; metricKey: string; actualValue?: string; errorThreshold?: string }[] } }>(`/api/qualitygates/project_status?${query}`),
			this.request<{ component?: { measures?: { metric: string; value?: string; period?: { value?: string }; periods?: { value?: string }[] }[] } }>(`/api/measures/component?${targetQuery(target, 'component')}&metricKeys=coverage,new_coverage`).catch(() => undefined),
		]);
		const status = gate.projectStatus?.status;
		const coverage = measures?.component?.measures?.find(m => m.metric === 'coverage')?.value;
		return {
			status: status === 'OK' || status === 'WARN' || status === 'ERROR' ? status : 'NONE',
			failed: (gate.projectStatus?.conditions ?? []).filter(c => c.status === 'ERROR' || c.status === 'WARN').map(c => ({ metric: c.metricKey, actual: c.actualValue, threshold: c.errorThreshold })),
			...coverage ? { coverage } : {},
		};
	}

	/** Open issues on new code, worst first. */
	async issues(target: SonarTarget, max = 50): Promise<SonarIssue[]> {
		const result = await this.request<{ issues?: { key: string; rule: string; severity?: string; type?: string; message: string; component?: string; line?: number; impacts?: { severity?: string }[] }[] }>(
			`/api/issues/search?${targetQuery(target, 'componentKeys')}&inNewCodePeriod=true&resolved=false&ps=${Math.min(max, 100)}&s=SEVERITY&asc=false`);
		return (result.issues ?? []).map(issue => ({
			key: issue.key,
			rule: issue.rule,
			severity: issue.severity ?? issue.impacts?.[0]?.severity ?? 'INFO',
			type: issue.type,
			message: issue.message,
			...issue.component ? { file: issue.component.replace(/^[^:]*:/, '') } : {},
			...issue.line ? { line: issue.line } : {},
			url: `${this.url}/project/issues?id=${encodeURIComponent(target.project)}&open=${encodeURIComponent(issue.key)}${target.branch ? `&branch=${encodeURIComponent(target.branch)}` : ''}${target.mergeRequest ? `&pullRequest=${encodeURIComponent(target.mergeRequest)}` : ''}`,
		}));
	}

	async hotspots(target: SonarTarget): Promise<SonarIssue[]> {
		const result = await this.request<{ hotspots?: { key: string; ruleKey?: string; vulnerabilityProbability?: string; message: string; component?: string; line?: number }[] }>(
			`/api/hotspots/search?${targetQuery(target, 'projectKey')}&inNewCodePeriod=true&status=TO_REVIEW&ps=50`);
		return (result.hotspots ?? []).map(h => ({
			key: h.key,
			rule: h.ruleKey ?? '',
			severity: h.vulnerabilityProbability ?? 'MEDIUM',
			type: 'SECURITY_HOTSPOT',
			message: h.message,
			...h.component ? { file: h.component.replace(/^[^:]*:/, '') } : {},
			...h.line ? { line: h.line } : {},
			url: `${this.url}/security_hotspots?id=${encodeURIComponent(target.project)}&hotspots=${encodeURIComponent(h.key)}`,
		}));
	}
}

function targetQuery(target: SonarTarget, projectParam: string): string {
	return [
		`${projectParam}=${encodeURIComponent(target.project)}`,
		...target.mergeRequest ? [`pullRequest=${encodeURIComponent(target.mergeRequest)}`] : target.branch ? [`branch=${encodeURIComponent(target.branch)}`] : [],
	].join('&');
}

/** `sonar.projectKey` from the repository's sonar-project.properties, when it has one. */
export async function sonarProjectKeyIn(folder: string): Promise<string | undefined> {
	try {
		const text = await fs.readFile(path.join(folder, 'sonar-project.properties'), 'utf8');
		return /^\s*sonar\.projectKey\s*[=:]\s*(\S+)\s*$/m.exec(text)?.[1];
	} catch {
		return undefined;
	}
}

export function describeSonar(target: SonarTarget, gate: SonarGate | undefined, issues: readonly SonarIssue[]): string {
	const where = target.mergeRequest ? `merge request ${target.mergeRequest}` : target.branch ? `branch ${target.branch}` : 'the main branch';
	const lines = [`SonarQube ${target.project}, ${where}:`];
	if (gate) {
		lines.push(`Quality gate: ${gate.status === 'OK' ? 'passed' : gate.status === 'ERROR' ? 'failed' : gate.status === 'WARN' ? 'warning' : 'not computed'}${gate.coverage ? ` · coverage ${gate.coverage}%` : ''}`);
		for (const c of gate.failed) {
			lines.push(`- ${c.metric}: ${c.actual ?? '?'} (threshold ${c.threshold ?? '?'})`);
		}
	}
	lines.push(issues.length ? `${issues.length} open issue${issues.length === 1 ? '' : 's'} on new code:` : 'No open issues on new code.');
	for (const issue of issues) {
		lines.push(`- [${issue.severity}${issue.type ? ` ${issue.type}` : ''}] ${issue.file ?? ''}${issue.line ? `:${issue.line}` : ''} ${issue.message} (${issue.rule})`);
	}
	return lines.join('\n');
}
