/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent worktrees: an agent can work on its own branch in its own folder
// (`git worktree`), so agents running side by side never edit the same files.
// The folders live under ~/.geminicode/worktrees rather than inside the
// repository, so the open workspace's search, file watchers and language
// servers don't see every file twice.

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** An agent's own branch and folder. Plain data, kept with the agent. */
export interface AgentWorktree {
	/** The worktree's top folder. */
	readonly folder: string;
	/** Where the agent runs: the workspace's place inside the worktree. */
	readonly cwd: string;
	readonly branch: string;
	/** The branch (or short commit) it was made from, which Merge Back merges into by default. */
	readonly base: string;
}

/** What went wrong with a git command that talks to a server, in terms the user can act on. */
export type GitNetworkProblem = 'vpn' | 'signIn' | 'timeout';

export class GitError extends Error {
	constructor(message: string, readonly stderr: string, readonly problem?: GitNetworkProblem) {
		super(message);
	}
}

/** The git commands that talk to a server, which get a time limit and an ssh that never prompts. */
const networkCommands = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);
/** How long a git command that talks to a server may take. */
export const networkGitTimeoutMs = 60_000;
/** The ssh git uses for those, unless the user set their own: no prompt to hang on, and a quick give-up on a host that doesn't answer. */
export const batchSsh = 'ssh -o BatchMode=yes -o ConnectTimeout=10';

/** What a network git command's stderr means, when it is a usual failure: no route (the VPN), or no sign-in. */
export function gitNetworkProblem(stderr: string): GitNetworkProblem | undefined {
	if (/Permission denied \(|Authentication failed|terminal prompts disabled|could not read (Username|Password)|Host key verification failed|HTTP Basic: Access denied|returned error: 40[13]/i.test(stderr)) {
		return 'signIn';
	}
	if (/Could not resolve host|Operation timed out|Connection timed out|Connection refused|Network is unreachable|No route to host|ssh: connect to host|unable to access .*: (Failed to connect|Couldn't connect)/i.test(stderr)) {
		return 'vpn';
	}
	return undefined;
}

/** The plain words for a network problem. */
export function gitNetworkMessage(problem: GitNetworkProblem): string {
	switch (problem) {
		case 'vpn': return 'Git couldn\'t reach the server. Check your VPN.';
		case 'signIn': return 'Git couldn\'t sign in to the server. Sign in with git once in a terminal (run git fetch there), then try again.';
		case 'timeout': return `Git got no answer from the server within ${networkGitTimeoutMs / 1000} s. Check your VPN.`;
	}
}

/** Whether the user set an ssh for git themselves (in the environment, or core.sshCommand), which is then left alone. */
async function ownSsh(cwd: string): Promise<boolean> {
	if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) {
		return true;
	}
	return new Promise(resolve => execFile('git', ['config', '--get', 'core.sshCommand'], { cwd, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => resolve(!err && !!String(stdout).trim())));
}

/**
 * Runs git in `cwd`; rejects with its stderr. A command that talks to a
 * server (fetch, push...) is given up after `networkGitTimeoutMs`, runs ssh
 * in batch mode unless the user set their own, and fails in plain words for
 * the usual problems (no VPN, no sign-in); the raw stderr stays on the error.
 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
	const network = networkCommands.has(args[0]);
	const ssh = network && !await ownSsh(cwd) ? { GIT_SSH_COMMAND: batchSsh } : {};
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...ssh }, ...network ? { timeout: networkGitTimeoutMs } : {} }, (err, stdout, stderr) => {
			if (err) {
				const raw = String(stderr);
				const detail = (raw.trim() || err.message).split('\n').filter(line => !/^hint:/.test(line)).join('\n');
				const problem = network ? (err.killed ? 'timeout' : gitNetworkProblem(raw)) : undefined;
				reject(new GitError(problem ? gitNetworkMessage(problem) : detail, raw || detail, problem));
			} else {
				resolve(String(stdout));
			}
		});
	});
}

/** The top folder of the repository `folder` is in, or undefined outside one. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
	try {
		return (await git(folder, ['rev-parse', '--show-toplevel'])).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * `folder`'s path inside its repository ('' at the top). Asked of Git rather
 * than worked out from `repositoryRoot`, which is the real path: through a
 * symlink (such as /tmp on macOS) the two would not line up.
 */
export async function folderInRepository(folder: string): Promise<string> {
	return (await git(folder, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');
}

/** Where agent worktrees for `repository` go: ~/.geminicode/worktrees/<repository name>. */
export function worktreesHome(repository: string, home: string = os.homedir()): string {
	return path.join(home, '.geminicode', 'worktrees', path.basename(repository) || 'repository');
}

/**
 * Where a project's coordinator runs: an empty folder of its own, so it has
 * no code to read and hands the work to threads, which run in worktrees.
 */
export function coordinatorHome(project: string, home: string = os.homedir()): string {
	return path.join(projectsHome(home), project.replace(/[^\w.-]+/g, '-'));
}

/** The folder that holds every coordinator's own folder. */
export function projectsHome(home: string = os.homedir()): string {
	return path.join(home, '.geminicode', 'projects');
}

/** A free folder name in `parent` for `branch`: its last part, with -2, -3... if taken. */
export async function freeFolder(parent: string, branch: string): Promise<string> {
	const name = branch.split('/').pop()?.replace(/[^\w.-]+/g, '-') || 'agent';
	for (let n = 1; ; n++) {
		const candidate = path.join(parent, n === 1 ? name : `${name}-${n}`);
		try {
			await fs.access(candidate);
		} catch {
			return candidate;
		}
	}
}

/** The folder where `branch` is checked out, if the repository or one of its worktrees has it. */
export async function checkoutOf(repository: string, branch: string): Promise<string | undefined> {
	const text = await git(repository, ['worktree', 'list', '--porcelain']);
	let folder: string | undefined;
	for (const line of text.split('\n')) {
		if (line.startsWith('worktree ')) {
			folder = line.slice('worktree '.length).trim();
		} else if (line.trim() === `branch refs/heads/${branch}` && folder) {
			return folder;
		}
	}
	return undefined;
}

/** Whether `branch` already exists in `repository`. */
export async function branchExists(repository: string, branch: string): Promise<boolean> {
	try {
		await git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Makes a new branch from what `repository` has checked out, in a new folder.
 * `subfolder` is the workspace's path inside the repository, for the agent's `cwd`.
 */
export async function createWorktree(repository: string, branch: string, subfolder = '', home?: string): Promise<AgentWorktree> {
	const base = await currentBranch(repository);
	const parent = worktreesHome(repository, home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, branch);
	await git(repository, ['worktree', 'add', '--quiet', '-b', branch, folder, 'HEAD']);
	return { folder, cwd: path.join(folder, subfolder), branch, base };
}

/** The main checkout of the repository `folder` is in, when `folder` is in a worktree of it; `folder`'s own top otherwise. */
export async function mainRepository(folder: string): Promise<string> {
	const common = (await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
	return path.basename(common) === '.git' ? path.dirname(common) : (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
}

/** What `folder`'s repository is in the middle of, which a fork can't carry: a merge, rebase, cherry-pick or revert. */
export async function unfinishedOperation(folder: string): Promise<'merge' | 'rebase' | 'cherry-pick' | 'revert' | undefined> {
	const marks = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const;
	for (const [mark, operation] of marks) {
		const file = (await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', mark])).trim();
		if (await pathExists(file)) {
			return operation;
		}
	}
	return undefined;
}

/**
 * Makes a new branch from what `parent` (a workspace folder or another
 * agent's worktree) has checked out, in a folder of its own, with `parent`'s
 * uncommitted changes and untracked files copied in; `parent` itself is left
 * as it is. `subfolder` is the agent's place inside the repository, for its
 * `cwd`. Rejects, leaving nothing behind, when `parent` is in the middle of a
 * merge or rebase, or when its changes can't be copied.
 */
export async function createWorktreeFrom(parent: string, branch: string, subfolder = '', home?: string): Promise<AgentWorktree> {
	const top = (await git(parent, ['rev-parse', '--show-toplevel'])).trim();
	const operation = await unfinishedOperation(top);
	if (operation) {
		throw new Error(`${path.basename(top)} is in the middle of a ${operation}; finish or abort it first.`);
	}
	const base = await currentBranch(top);
	// A commit of the uncommitted changes, made without touching the folder or the stash list; empty when there are none.
	const changes = (await git(top, ['stash', 'create'])).trim();
	const untracked = (await git(top, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
	const repository = await mainRepository(top);
	const folders = worktreesHome(repository, home);
	await fs.mkdir(folders, { recursive: true });
	const folder = await freeFolder(folders, branch);
	await git(top, ['worktree', 'add', '--quiet', '-b', branch, folder, 'HEAD']);
	const worktree: AgentWorktree = { folder, cwd: path.join(folder, subfolder), branch, base };
	try {
		if (changes) {
			await git(folder, ['stash', 'apply', '--quiet', changes]);
		}
		for (const file of untracked) {
			await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
			await fs.cp(path.join(top, file), path.join(folder, file), { recursive: true, verbatimSymlinks: true });
		}
	} catch (err) {
		await removeWorktree(top, worktree, true).catch(() => undefined);
		throw err;
	}
	return worktree;
}

/** One repository's worktree in a thread that works in several, side by side in the thread's own folder. */
export interface RepoWorktree extends AgentWorktree {
	/** The repository's key in its project, which is also its folder's name in the thread's folder. */
	readonly key: string;
	/** The repository it was made from. */
	readonly repository: string;
}

/** Where a project's multi-repository threads keep their folders: ~/.geminicode/threads/<project>. */
export function threadsHome(project: string, home: string = os.homedir()): string {
	return path.join(allThreadsHome(home), project.replace(/[^\w.-]+/g, '-'));
}

/** The folder that holds every project's multi-repository thread folders. */
export function allThreadsHome(home: string = os.homedir()): string {
	return path.join(home, '.geminicode', 'threads');
}

/** Makes a new branch from what `repository` has checked out, at `folder` exactly, which must not exist yet. */
export async function createWorktreeAt(repository: string, branch: string, folder: string): Promise<AgentWorktree> {
	const base = await currentBranch(repository);
	await fs.mkdir(path.dirname(folder), { recursive: true });
	await git(repository, ['worktree', 'add', '--quiet', '-b', branch, folder, 'HEAD']);
	return { folder, cwd: folder, branch, base };
}

/** Folders a thread's agent never needs to search, whatever each repository's own ignore files say. */
const threadIgnores = ['node_modules/', 'dist/', 'build/', 'out/', 'target/', '.next/', '.nuxt/', '.output/', 'coverage/', '.turbo/', '.cache/', '.gradle/', '__pycache__/', '.venv/', 'vendor/'];

/**
 * The rules file a multi-repository thread's folder gets: which folder is
 * which repository, that they share one branch, and the project's memory.
 * The folder itself is not a repository, so this is GeminiCode's to write.
 */
export function threadGuide(repos: readonly { readonly key: string; readonly about?: string }[], branch: string, memory?: string): string {
	const lines = [
		'# This thread\'s repositories',
		'',
		`This folder holds one Git worktree for each repository this thread works in, all on the branch \`${branch}\`:`,
		'',
		...repos.map(repo => `- \`${repo.key}/\`${repo.about ? `: ${repo.about}` : ''}`),
		'',
		'This folder is not a repository itself. Run git, builds and tests inside a repository\'s folder (for example `cd ' + (repos[0]?.key ?? 'repo') + '` or `git -C ' + (repos[0]?.key ?? 'repo') + ' status`), and say which repository each change is in.',
		'If the work needs another of the project\'s repositories, call the add_repo tool rather than looking for it elsewhere on disk.',
	];
	if (memory?.trim()) {
		lines.push('', '# Project memory', '', 'From the project\'s settings, written or approved by the user:', '', memory.trim());
	}
	return `${lines.join('\n')}\n`;
}

/** Writes a multi-repository thread's GEMINI.md and .geminiignore into its folder. */
export async function writeThreadGuide(folder: string, guide: string): Promise<void> {
	await fs.mkdir(folder, { recursive: true });
	await fs.writeFile(path.join(folder, 'GEMINI.md'), guide);
	await fs.writeFile(path.join(folder, '.geminiignore'), `${threadIgnores.join('\n')}\n`);
}

export interface WorktreeStatus {
	/** Files changed in the worktree and not committed. */
	readonly uncommitted: number;
	/** Commits on the agent's branch that `into` does not have. */
	readonly commits: number;
}

export async function worktreeStatus(worktree: AgentWorktree, into: string): Promise<WorktreeStatus> {
	const [status, count] = await Promise.all([
		git(worktree.folder, ['status', '--porcelain']),
		git(worktree.folder, ['rev-list', '--count', `${into}..${worktree.branch}`]).catch(() => '0'),
	]);
	return { uncommitted: status.split('\n').filter(Boolean).length, commits: Number(count.trim()) || 0 };
}

/** Commits everything in the worktree. */
export async function commitAll(folder: string, message: string): Promise<void> {
	await git(folder, ['add', '-A']);
	await git(folder, ['commit', '--quiet', '-m', message]);
}

export type MergeResult =
	| { readonly kind: 'merged' }
	| { readonly kind: 'conflicts'; readonly files: readonly string[] };

/**
 * Merges the agent's branch into what `repository` has checked out. On
 * conflicts the merge is left in progress for the user to finish in Source
 * Control; any other failure (such as local changes in the way) rejects.
 */
export async function mergeBranch(repository: string, branch: string): Promise<MergeResult> {
	try {
		await git(repository, ['merge', '--no-ff', '--no-edit', branch]);
		return { kind: 'merged' };
	} catch (err) {
		const files = (await git(repository, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
		if (files.length) {
			return { kind: 'conflicts', files };
		}
		throw err;
	}
}

/** The branch `repository` has checked out, or a short commit when detached. */
export async function currentBranch(repository: string): Promise<string> {
	const head = (await git(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	return head === 'HEAD' ? (await git(repository, ['rev-parse', '--short', 'HEAD'])).trim() : head;
}

/** Deletes the worktree's folder and, with `deleteBranch`, its branch, even with unmerged work. */
export async function removeWorktree(repository: string, worktree: AgentWorktree, deleteBranch: boolean): Promise<void> {
	try {
		await git(repository, ['worktree', 'remove', '--force', worktree.folder]);
	} catch (err) {
		// Already gone from disk: forget it.
		await fs.access(worktree.folder).then(() => { throw err; }, () => git(repository, ['worktree', 'prune']));
	}
	if (deleteBranch && await branchExists(repository, worktree.branch)) {
		await git(repository, ['branch', '-D', worktree.branch]);
	}
}

/**
 * Puts back a worktree whose folder was removed (Clean Up Merged Folders),
 * at the same place and on its branch as the branch now stands. Resolves
 * false when the branch is gone too; does nothing when the folder is there.
 */
export async function restoreWorktree(repository: string, worktree: AgentWorktree): Promise<boolean> {
	if (await fs.access(worktree.folder).then(() => true, () => false)) {
		return true;
	}
	if (!await branchExists(repository, worktree.branch)) {
		return false;
	}
	// Git still lists the removed folder until it is pruned, and refuses to add it again meanwhile.
	await git(repository, ['worktree', 'prune']);
	await fs.mkdir(path.dirname(worktree.folder), { recursive: true });
	await git(repository, ['worktree', 'add', '--quiet', worktree.folder, worktree.branch]);
	return true;
}

/** The bytes the files under `folder` take, symbolic links not followed; 0 when it is gone. */
export async function folderSize(folder: string): Promise<number> {
	let total = 0;
	const folders = [folder];
	// A few folders at a time: a worktree's node_modules can hold a hundred thousand files.
	while (folders.length) {
		const batch = folders.splice(0, 16);
		await Promise.all(batch.map(async each => {
			const entries = await fs.readdir(each, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const full = path.join(each, entry.name);
				if (entry.isDirectory()) {
					folders.push(full);
				} else if (entry.isFile()) {
					total += await fs.lstat(full).then(stat => stat.size, () => 0);
				}
			}
		}));
	}
	return total;
}

/** The script a repository keeps for setting up a new agent worktree, relative to its top folder. */
export const setupScriptFile = path.join('.gemini', 'worktree-setup.sh');

/** The setup a new worktree gets, and, when it is the repository's own script, that script. */
export interface WorktreeSetup {
	readonly command: string;
	/** The repository's `.gemini/worktree-setup.sh`, which runs only once the user allowed its content (setupConsent.ts). */
	readonly script?: { readonly file: string; readonly content: string };
}

/**
 * The setup to run in a new worktree: the `gemini.agents.worktreeSetup` command when set, else
 * the repository's own `.gemini/worktree-setup.sh` when it has one, with its content. Undefined when neither.
 */
export async function worktreeSetup(repository: string, configured: string | undefined): Promise<WorktreeSetup | undefined> {
	if (configured?.trim()) {
		return { command: configured.trim() };
	}
	const file = path.join(repository, setupScriptFile);
	const content = await fs.readFile(file, 'utf8').catch(() => undefined);
	// From the repository, so a script not yet committed (and so not in the worktree) still runs.
	return content === undefined ? undefined : { command: `sh ${shellQuote(file)}`, script: { file, content } };
}

/** The command of `worktreeSetup`, for a caller that runs it as it is. */
export async function worktreeSetupCommand(repository: string, configured: string | undefined): Promise<string | undefined> {
	return (await worktreeSetup(repository, configured))?.command;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `command` through the shell in the new worktree's top folder, with
 * GEMINI_SOURCE_REPOSITORY naming the repository it came from (to copy files
 * such as .env that Git does not carry). Resolves with the exit code; the
 * output goes to `onOutput` as it comes. `signal` stops it.
 */
export function runWorktreeSetup(command: string, worktree: AgentWorktree, repository: string, onOutput: (text: string) => void, signal?: AbortSignal): Promise<number> {
	return new Promise(resolve => {
		const child = spawn(command, {
			cwd: worktree.folder,
			shell: process.env.SHELL || true,
			env: { ...process.env, GEMINI_SOURCE_REPOSITORY: repository, GEMINI_WORKTREE: worktree.folder, GEMINI_BRANCH: worktree.branch },
			signal,
		});
		child.stdout.on('data', data => onOutput(String(data)));
		child.stderr.on('data', data => onOutput(String(data)));
		child.on('error', err => {
			onOutput(`${err.message}\n`);
			resolve(-1);
		});
		child.on('close', code => resolve(code ?? -1));
	});
}

/** `branch`, or `branch-2`, `branch-3`... when taken in any of `repositories`. */
export async function freeBranchName(repositories: readonly string[], branch: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? branch : `${branch}-${n}`;
		if (!(await Promise.all(repositories.map(repository => branchExists(repository, candidate)))).some(Boolean)) {
			return candidate;
		}
	}
}

/** Removes a multi-repository thread's worktrees, then its folder, which GeminiCode made and holds nothing else of the user's. */
export async function removeThreadFolder(repos: readonly RepoWorktree[], folder: string, deleteBranch: boolean, home: string = os.homedir()): Promise<void> {
	const results = await Promise.allSettled(repos.map(repo => removeWorktree(repo.repository, repo, deleteBranch)));
	if (path.dirname(path.dirname(folder)) === allThreadsHome(home)) {
		await fs.rm(folder, { recursive: true, force: true });
	}
	const failed = results.find(result => result.status === 'rejected');
	if (failed) {
		throw failed.reason;
	}
}

/**
 * The folders a project needs trusted: the coordinators' own, which hold
 * nothing; the repository's threads' worktrees; and with several
 * repositories, the folders that hold a worktree of each.
 */
export function projectFolders(repository: string, threads: boolean, home: string = os.homedir()): string[] {
	return [projectsHome(home), worktreesHome(repository, home), ...threads ? [allThreadsHome(home)] : []];
}

/** Whether `folder` exists. */
export async function pathExists(folder: string): Promise<boolean> {
	try {
		await fs.stat(folder);
		return true;
	} catch {
		return false;
	}
}

/** Runs tasks one at a time per key, each once the last one queued under its key has ended, however it ended. */
export class TurnQueue {

	/** The last task queued under each key, while it runs. */
	private readonly tails = new Map<string, Promise<void>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		const tail = next.then(() => undefined, () => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return next;
	}
}

/**
 * The key a repository's git writes queue under: its main checkout's real
 * path, so a worktree of it, a symlink to it and the folder itself share one.
 */
export async function repositoryKey(folder: string): Promise<string> {
	const main = await mainRepository(folder).catch(() => folder);
	return fs.realpath(main).catch(() => main);
}

const repositoryQueue = new TurnQueue();

/**
 * Runs `task` once every git write queued for the repository `folder` is in
 * has ended: adding a worktree, merging, committing and pushing take turns
 * per repository, whichever part of GeminiCode asks (Projects, the team
 * flows, Merge Back). `folder` may name several repositories, locked in a
 * fixed order so two callers can't wait on each other. Never nest a call for a repository the
 * task already holds.
 */
export async function inRepository<T>(folder: string | readonly string[], task: () => Promise<T>): Promise<T> {
	const keys = [...new Set(await Promise.all((typeof folder === 'string' ? [folder] : folder).map(repositoryKey)))].sort();
	const run = (index: number): Promise<T> => index < keys.length ? repositoryQueue.run(keys[index], () => run(index + 1)) : task();
	return run(0);
}
