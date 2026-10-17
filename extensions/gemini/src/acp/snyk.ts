/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Snyk through the user's own Snyk CLI, which is signed in (`snyk auth`) and
// pointed at the team's Snyk (`snyk config set endpoint=...`) on their Mac.
// GeminiCode never sees a Snyk token. `snyk test` checks dependencies,
// `snyk code test` the source; both give JSON (SARIF for code).

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SnykFinding {
	readonly id: string;
	readonly severity: 'critical' | 'high' | 'medium' | 'low';
	readonly title: string;
	/** For a dependency: the package and version; for code: the file and line. */
	readonly where: string;
	readonly file?: string;
	readonly line?: number;
	/** How to fix it, when Snyk says: "upgrade axios to 1.7.4". */
	readonly fix?: string;
}

export interface SnykResult {
	readonly kind: 'dependencies' | 'code';
	readonly findings: readonly SnykFinding[];
	/** Set when Snyk couldn't test (no supported project, not signed in, can't reach). */
	readonly problem?: string;
}

export interface SnykStatus {
	readonly installed: boolean;
	readonly version?: string;
	readonly endpoint?: string;
	readonly user?: string;
	readonly problem?: string;
}

export type Run = (file: string, args: readonly string[], cwd: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Folders a GUI app's PATH lacks on macOS, where Homebrew and npm put the CLI. */
function searchPath(): string {
	const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.volta', 'bin'), path.join(os.homedir(), '.asdf', 'shims')];
	return [process.env.PATH ?? '', ...extra].filter(Boolean).join(path.delimiter);
}

export const runProcess: Run = (file, args, cwd, timeoutMs) => new Promise(resolve => {
	execFile(file, [...args], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: searchPath(), FORCE_COLOR: '0' }, windowsHide: true }, (err, stdout, stderr) => {
		const code = err ? typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1 : 0;
		resolve({ code, stdout: String(stdout), stderr: String(stderr) || (code === -1 && err ? err.message : '') });
	});
});

export class SnykCli {

	/** The CLI's path once found; `snyk` on the search path until then. */
	private resolved: Promise<string> | undefined;

	constructor(private readonly command = 'snyk', private readonly run: Run = runProcess, private readonly locate: (command: string) => Promise<string | undefined> = locateInLoginShell) { }

	async status(): Promise<SnykStatus> {
		const command = await this.cli();
		const version = await this.run(command, ['--version'], undefined, 10_000);
		if (version.code !== 0) {
			this.resolved = undefined;
			return { installed: false, problem: 'GeminiCode can\'t find the Snyk CLI. Install it with `brew install snyk-cli` or `npm install -g snyk`, then try again.' };
		}
		const [endpoint, whoami] = await Promise.all([
			this.run(command, ['config', 'get', 'endpoint'], undefined, 10_000),
			this.run(command, ['whoami', '--experimental'], undefined, 15_000),
		]);
		const host = endpoint.stdout.trim();
		const result: SnykStatus = { installed: true, version: version.stdout.trim().split(/\s/)[0], ...host ? { endpoint: hostOnly(host) } : {} };
		if (whoami.code === 0) {
			return { ...result, user: whoami.stdout.trim() };
		}
		const text = `${whoami.stdout}\n${whoami.stderr}`;
		if (/auth|token|401|unauthori[sz]ed|not logged/i.test(text)) {
			return { ...result, problem: 'The Snyk CLI isn\'t signed in. Run `snyk auth` in a terminal.' };
		}
		if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|network|timed? ?out|unable to connect/i.test(text)) {
			return { ...result, problem: `Can't reach Snyk${host ? ` at ${hostOnly(host)}` : ''}. Check that your VPN is on.` };
		}
		// A CLI without `whoami`: installed, and tests will say if it can't sign in.
		return result;
	}

	/** The CLI to run: `snyk` when the search path has it, else where the user's login shell finds it (nvm, Volta, asdf). */
	private cli(): Promise<string> {
		this.resolved ??= this.run(this.command, ['--version'], undefined, 10_000).then(async found => found.code === 0 ? this.command : await this.locate(this.command) ?? this.command);
		return this.resolved;
	}

	async testDependencies(folder: string): Promise<SnykResult> {
		const run = await this.run(await this.cli(), ['test', '--json', '--all-projects'], folder, 5 * 60_000);
		return parseSnykTest(run.stdout, run.code, run.stderr);
	}

	async testCode(folder: string): Promise<SnykResult> {
		const run = await this.run(await this.cli(), ['code', 'test', '--json'], folder, 10 * 60_000);
		return parseSnykCode(run.stdout, run.code, run.stderr, folder);
	}
}

/**
 * Where the user's login shell finds `command`: a GUI app's PATH lacks what
 * .zshrc adds (nvm, Volta, asdf), so ask the shell once.
 */
export async function locateInLoginShell(command: string, run: Run = runProcess): Promise<string | undefined> {
	if (process.platform === 'win32' || !/^[\w.-]+$/.test(command)) {
		return undefined;
	}
	const shell = process.env.SHELL || '/bin/zsh';
	const found = await run(shell, ['-ilc', `command -v ${command}`], undefined, 8_000);
	return found.stdout.split('\n').map(line => line.trim()).reverse().find(line => path.isAbsolute(line));
}

function hostOnly(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

const severities = ['critical', 'high', 'medium', 'low'] as const;

function severityOf(value: unknown): SnykFinding['severity'] {
	return severities.find(s => s === value) ?? (value === 'error' ? 'high' : value === 'warning' ? 'medium' : 'low');
}

function problemFrom(code: number, stdout: string, stderr: string): string | undefined {
	// 0: nothing found; 1: findings; 2: failure; 3: no supported project.
	if (code === 0 || code === 1) {
		return undefined;
	}
	let message = '';
	try {
		message = String((JSON.parse(stdout) as { error?: string; message?: string }).error ?? (JSON.parse(stdout) as { message?: string }).message ?? '');
	} catch {
		message = (stderr || stdout).trim().split('\n').slice(-3).join(' ');
	}
	if (code === 3) {
		return 'Snyk found no project it can test here (no package manifest).';
	}
	if (/auth|401|token/i.test(message)) {
		return 'The Snyk CLI isn\'t signed in. Run `snyk auth` in a terminal.';
	}
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|connect/i.test(message)) {
		return 'Can\'t reach Snyk. Check that your VPN is on.';
	}
	return message ? `Snyk couldn't test: ${message.slice(0, 300)}` : 'Snyk couldn\'t test this folder.';
}

/** Findings from `snyk test --json`, one per issue and package, worst first. */
export function parseSnykTest(stdout: string, code: number, stderr = ''): SnykResult {
	const problem = problemFrom(code, stdout, stderr);
	if (problem) {
		return { kind: 'dependencies', findings: [], problem };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { kind: 'dependencies', findings: [], ...code ? { problem: 'Snyk answered with something other than JSON.' } : {} };
	}
	const projects = (Array.isArray(parsed) ? parsed : [parsed]) as { vulnerabilities?: RawVuln[]; displayTargetFile?: string }[];
	const seen = new Set<string>();
	const findings: SnykFinding[] = [];
	for (const project of projects) {
		for (const v of project.vulnerabilities ?? []) {
			const key = `${v.id}@${v.packageName}@${v.version}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const upgrade = v.upgradePath?.find((step, i) => i > 0 && typeof step === 'string');
			findings.push({
				id: v.id,
				severity: severityOf(v.severity),
				title: v.title,
				where: `${v.packageName}@${v.version}${project.displayTargetFile ? ` (${project.displayTargetFile})` : ''}`,
				...v.isUpgradable && upgrade ? { fix: `upgrade to ${upgrade}` } : v.fixedIn?.length ? { fix: `fixed in ${v.packageName} ${v.fixedIn.join(', ')}` } : {},
			});
		}
	}
	return { kind: 'dependencies', findings: sortFindings(findings) };
}

/** Findings from `snyk code test --json` (SARIF). */
export function parseSnykCode(stdout: string, code: number, stderr = '', folder = ''): SnykResult {
	const problem = problemFrom(code, stdout, stderr);
	if (problem) {
		return { kind: 'code', findings: [], problem };
	}
	let sarif: { runs?: { results?: RawSarif[]; tool?: { driver?: { rules?: { id: string; shortDescription?: { text?: string } }[] } } }[] };
	try {
		sarif = JSON.parse(stdout);
	} catch {
		return { kind: 'code', findings: [], ...code ? { problem: 'Snyk answered with something other than JSON.' } : {} };
	}
	const findings: SnykFinding[] = [];
	for (const run of sarif.runs ?? []) {
		const rules = new Map((run.tool?.driver?.rules ?? []).map(r => [r.id, r.shortDescription?.text ?? r.id]));
		for (const result of run.results ?? []) {
			const location = result.locations?.[0]?.physicalLocation;
			const file = location?.artifactLocation?.uri ? decodeURIComponent(location.artifactLocation.uri.replace(/^file:\/\//, '')).replace(folder ? `${folder}/` : '', '') : undefined;
			const line = location?.region?.startLine;
			findings.push({
				id: result.ruleId ?? '',
				severity: severityOf(result.level),
				title: rules.get(result.ruleId ?? '') ?? result.message?.text ?? result.ruleId ?? '',
				where: file ? `${file}${line ? `:${line}` : ''}` : '',
				...file ? { file } : {},
				...line ? { line } : {},
				...result.message?.text ? { fix: result.message.text } : {},
			});
		}
	}
	return { kind: 'code', findings: sortFindings(findings) };
}

function sortFindings(findings: SnykFinding[]): SnykFinding[] {
	return findings.sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity));
}

interface RawVuln {
	readonly id: string;
	readonly title: string;
	readonly severity?: string;
	readonly packageName: string;
	readonly version: string;
	readonly isUpgradable?: boolean;
	readonly upgradePath?: readonly (string | boolean)[];
	readonly fixedIn?: readonly string[];
}

interface RawSarif {
	readonly ruleId?: string;
	readonly level?: string;
	readonly message?: { readonly text?: string };
	readonly locations?: readonly { readonly physicalLocation?: { readonly artifactLocation?: { readonly uri?: string }; readonly region?: { readonly startLine?: number } } }[];
}

export function describeSnyk(result: SnykResult): string {
	const what = result.kind === 'code' ? 'Snyk Code (source)' : 'Snyk (dependencies)';
	if (result.problem) {
		return `${what}: ${result.problem}`;
	}
	if (!result.findings.length) {
		return `${what}: no issues found.`;
	}
	const counts = severities.map(s => [s, result.findings.filter(f => f.severity === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ');
	return [`${what}: ${result.findings.length} issue${result.findings.length === 1 ? '' : 's'} (${counts})`, ...result.findings.slice(0, 60).map(f => `- [${f.severity}] ${f.title} · ${f.where}${f.fix ? ` · ${f.fix}` : ''} (${f.id})`)].join('\n');
}
