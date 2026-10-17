/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { forwardPairs } from '../acp/dashboard';
import type { GitLabMr, GitLabMrSummary } from '../acp/gitlab';
import type { JiraMySprint } from '../acp/jira';
import type { SnykFinding } from '../acp/snyk';
import { sonarProjectKeyIn, type SonarGate } from '../acp/sonar';
import { isReleaseBranch, sortReleaseBranches } from '../acp/teamDefaults';
import { TeamToolError, type TeamErrorKind, type TeamToolId } from '../acp/teamHttp';
import { gitlabProjectOf } from '../acp/teamTools';
import type { TeamConnections } from './teamConnections';

/** One source's last answer: its data and when it came, or why the latest try failed (the data stays). */
export interface Fetched<T> {
	readonly data?: T;
	readonly at?: number;
	readonly error?: { readonly kind: TeamErrorKind; readonly message: string };
	readonly loading?: boolean;
}

export interface QualityData {
	readonly branch: string;
	readonly gate?: SonarGate;
	readonly newIssues?: number;
	readonly major?: number;
	readonly url?: string;
}

export interface SnykData {
	readonly high: number;
	readonly critical: number;
	/** The packages with high or critical issues, a few. */
	readonly packages: readonly string[];
	readonly problem?: string;
	readonly findings: readonly SnykFinding[];
}

export interface ReleaseRow {
	readonly from: string;
	readonly to: string;
	readonly ahead: number;
}

export interface ReleasesData {
	readonly project: string;
	/** Release branches, oldest first. */
	readonly branches: readonly string[];
	readonly forward: readonly ReleaseRow[];
}

export interface TeamSnapshot {
	readonly sprint?: Fetched<JiraMySprint>;
	readonly reviews?: Fetched<readonly GitLabMrSummary[]>;
	readonly mine?: Fetched<readonly GitLabMr[]>;
	readonly releases?: Fetched<ReleasesData>;
	readonly quality?: Fetched<QualityData>;
	readonly snyk?: Fetched<SnykData>;
}

type Source = keyof TeamSnapshot;

const sourceTool: Record<Source, TeamToolId> = { sprint: 'jira', reviews: 'gitlab', mine: 'gitlab', releases: 'gitlab', quality: 'sonar', snyk: 'snyk' };
const storageKey = 'gemini.home.teamData';
/** Snyk runs a full test, so it is refreshed at most this often. */
const snykMaxAgeMs = 6 * 60 * 60_000;
/** One source may take this long before the page stops waiting on it. */
const sourceTimeoutMs = 15_000;

/**
 * The team tools' data Home's dashboard shows: the user's sprint, merge
 * requests, release branches and quality. Each source is fetched in
 * parallel with a timeout of its own, so a tool behind a VPN that is off
 * never holds the others; the last answers are kept in global state, so Home
 * shows them at once in a new window and keeps them (dimmed) while a tool
 * can't be reached. Fetches only when asked; never starts the Gemini CLI.
 */
export class TeamData implements vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private snapshotValue: { [K in Source]?: Fetched<unknown> };
	private running: Promise<void> | undefined;
	private lastRefresh = 0;

	constructor(private readonly state: vscode.Memento, private readonly connections: TeamConnections) {
		this.snapshotValue = { ...state.get<TeamSnapshot>(storageKey) };
		// A fetch that was running when the window closed isn't any more.
		for (const key of Object.keys(this.snapshotValue) as Source[]) {
			const value = this.snapshotValue[key];
			if (value?.loading) {
				this.snapshotValue[key] = { ...value, loading: false };
			}
		}
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	get snapshot(): TeamSnapshot {
		return this.snapshotValue as TeamSnapshot;
	}

	/** When the last refresh started, in ms since the epoch; 0 before the first. */
	get refreshedAt(): number {
		return this.lastRefresh;
	}

	/**
	 * Refetches every connected tool's data for the repository at `folder`;
	 * `qualityBranch` overrides the newest release branch. Concurrent calls
	 * share one refresh.
	 */
	refresh(folder: string | undefined, qualityBranch?: string): Promise<void> {
		this.running ??= this.run(folder, qualityBranch).finally(() => this.running = undefined);
		return this.running;
	}

	/** Refreshes unless one ran in the last `ms`. */
	refreshIfOlder(ms: number, folder: string | undefined, qualityBranch?: string): Promise<void> {
		return Date.now() - this.lastRefresh > ms ? this.refresh(folder, qualityBranch) : this.running ?? Promise.resolve();
	}

	private async run(folder: string | undefined, qualityBranch?: string): Promise<void> {
		this.lastRefresh = Date.now();
		const connected = this.connections.connected;
		const { jira, gitlab, sonar, snyk } = this.connections.connectors;
		const defaults = folder ? await this.connections.defaults(folder).catch(() => ({})) : {};
		const local = folder && gitlab ? await gitlabProjectOf(folder, gitlab.url, defaults).catch(() => ({ project: undefined, branch: undefined })) : {};
		// Releases first, as Quality looks at the newest release branch.
		const releases = gitlab && local.project ? this.fetch('releases', async () => {
			const pattern = (defaults as { gitlab?: { releaseBranches?: string } }).gitlab?.releaseBranches ?? 'release/*';
			const prefix = pattern.split('*')[0];
			const branches = sortReleaseBranches((await gitlab.branches(local.project!, prefix)).map(b => b.name).filter(name => isReleaseBranch(name, pattern)));
			const forward = await Promise.all(forwardPairs(branches).map(async pair => ({ ...pair, ahead: await gitlab.commitsAhead(local.project!, pair.from, pair.to).catch(() => 0) })));
			return { project: local.project!, branches, forward };
		}) : this.clear('releases', !connected.has('gitlab'));
		const tasks: Promise<unknown>[] = [
			jira ? this.fetch('sprint', () => jira.mySprint()) : this.clear('sprint', true),
			gitlab ? this.fetch('reviews', () => gitlab.reviewRequests()) : this.clear('reviews', true),
			gitlab ? this.fetch('mine', async () => {
				const list = await gitlab.myMergeRequests();
				return Promise.all(list.slice(0, 6).map(mr => gitlab.mr(mr.projectId, mr.iid)));
			}) : this.clear('mine', true),
			releases,
		];
		if (sonar && folder) {
			tasks.push(releases.then(async () => {
				const project = (defaults as { sonar?: { projectKey?: string } }).sonar?.projectKey ?? await sonarProjectKeyIn(folder);
				if (!project) {
					return this.clear('quality', true);
				}
				const branches = this.snapshot.releases?.data?.branches ?? [];
				const branch = qualityBranch && branches.includes(qualityBranch) ? qualityBranch : branches[branches.length - 1] ?? (defaults as { gitlab?: { defaultTarget?: string } }).gitlab?.defaultTarget ?? local.branch ?? 'main';
				return this.fetch('quality', async () => {
					const [gate, issues] = await Promise.all([sonar.gate({ project, branch }), sonar.issues({ project, branch }, 100)]);
					return { branch, gate, newIssues: issues.length, major: issues.filter(i => /BLOCKER|CRITICAL|MAJOR|HIGH/i.test(i.severity)).length, url: `${sonar.url}/dashboard?id=${encodeURIComponent(project)}&branch=${encodeURIComponent(branch)}` };
				});
			}));
		} else {
			tasks.push(this.clear('quality', !connected.has('sonar')));
		}
		const snykAge = Date.now() - (this.snapshotValue.snyk?.at ?? 0);
		if (snyk && folder && (snykAge > snykMaxAgeMs || this.snapshotValue.snyk?.error)) {
			// A full test takes a while; it runs on its own and lands when it lands.
			void this.fetch('snyk', async () => {
				const result = await snyk.testDependencies(folder);
				const bad = result.findings.filter(f => f.severity === 'high' || f.severity === 'critical');
				return {
					high: bad.filter(f => f.severity === 'high').length,
					critical: bad.filter(f => f.severity === 'critical').length,
					packages: [...new Set(bad.map(f => f.where.split('@')[0]))].slice(0, 3),
					...result.problem ? { problem: result.problem } : {},
					findings: result.findings.slice(0, 50),
				};
			}, 10 * 60_000);
		} else if (!snyk) {
			void this.clear('snyk', true);
		}
		await Promise.all(tasks);
	}

	private async clear(source: Source, drop: boolean): Promise<void> {
		if (drop && this.snapshotValue[source]) {
			delete this.snapshotValue[source];
			this.save();
		}
	}

	private async fetch<K extends Source>(source: K, get: () => Promise<NonNullable<TeamSnapshot[K]>['data']>, timeoutMs = sourceTimeoutMs): Promise<void> {
		const previous = this.snapshotValue[source];
		this.snapshotValue[source] = { ...previous, loading: true };
		this.onDidChangeEmitter.fire();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const data = await Promise.race([
				get(),
				new Promise<never>((_, reject) => timer = setTimeout(() => reject(new TeamToolError('unreachable', vscode.l10n.t("{0} didn't answer in time.", sourceTool[source]))), timeoutMs)),
			]);
			this.snapshotValue[source] = { data, at: Date.now() };
		} catch (err) {
			const kind: TeamErrorKind = err instanceof TeamToolError ? err.kind : 'failed';
			this.snapshotValue[source] = { ...previous, loading: false, error: { kind, message: err instanceof Error ? err.message : String(err) } };
		} finally {
			clearTimeout(timer);
		}
		this.save();
	}

	private save(): void {
		void this.state.update(storageKey, this.snapshotValue);
		this.onDidChangeEmitter.fire();
	}
}
