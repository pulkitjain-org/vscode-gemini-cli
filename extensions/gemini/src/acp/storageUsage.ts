/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where GeminiCode keeps its data, how much each area holds, and what Clean
// Up would remove: the data behind Settings' Storage section. Nothing here
// removes anything until `runCleanup` is handed a plan the user agreed to;
// a worktree is offered only when its work is all committed and merged.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isQuarantined, oldDayFiles, removeOldDayFiles } from './fsUtil';
import { debugLogPid, isRunning } from './mcpDiagnostics';
import { folderSize, type AgentWorktree, type WorktreeStatus } from './worktrees';

export type StorageAreaId = 'chats' | 'checkpoints' | 'agentList' | 'reviews' | 'flows' | 'auditLog' | 'pilotLog' | 'traces' | 'cliLogs' | 'managedCli' | 'index' | 'worktrees' | 'reviewCheckouts' | 'threads' | 'projects';

export interface StorageArea {
	readonly id: StorageAreaId;
	readonly folder: string;
}

export interface StorageAreaSize extends StorageArea {
	readonly bytes: number;
}

/** Every place GeminiCode keeps data: under the extension's global storage, and under ~/.geminicode. */
export function storageAreas(globalStorage: string, home: string = os.homedir()): StorageArea[] {
	const own = (id: StorageAreaId, name: string): StorageArea => ({ id, folder: path.join(globalStorage, name) });
	const geminicode = (id: StorageAreaId, name: string): StorageArea => ({ id, folder: path.join(home, '.geminicode', name) });
	return [
		own('chats', 'agents'),
		own('checkpoints', 'checkpoints'),
		own('agentList', 'records'),
		own('reviews', 'reviews'),
		own('flows', 'flows'),
		own('auditLog', 'audit'),
		own('pilotLog', 'pilot'),
		own('traces', 'traces'),
		own('cliLogs', 'cli-logs'),
		own('managedCli', 'gemini-cli'),
		geminicode('index', 'index'),
		geminicode('worktrees', 'worktrees'),
		geminicode('reviewCheckouts', 'reviews'),
		geminicode('threads', 'threads'),
		geminicode('projects', 'projects'),
	];
}

/** How much each area holds, in bytes; a missing folder holds nothing. */
export async function measureStorage(areas: readonly StorageArea[]): Promise<StorageAreaSize[]> {
	return Promise.all(areas.map(async area => ({ ...area, bytes: await folderSize(area.folder) })));
}

/** Why Clean Up would remove something. */
export type CleanupReason =
	/** A saved chat or checkpoints of an agent no longer in the list. */
	| 'orphaned'
	/** Checkpoints of a thread merged back. */
	| 'merged'
	/** An audit or pilot log day older than `gemini.storage.keepLogsDays`. */
	| 'oldLog'
	/** A performance trace and its summary. */
	| 'trace'
	/** A file that couldn't be read and was moved aside. */
	| 'broken'
	/** The debug log of a window that has closed, or the one all windows shared before. */
	| 'oldDebugLog'
	/** A merged thread's worktree, all of its work committed and merged. */
	| 'mergedWorktree'
	/** The checkout of a reviewer whose review is over, with nothing uncommitted. */
	| 'reviewWorktree'
	/** A worktree in ~/.geminicode/worktrees no agent has any more, all of its work committed and on another branch. */
	| 'removedWorktree';

/** Whose worktree Clean Up offers: a merged thread's, an ended review's, or one no agent has any more. */
export type WorktreeKind = 'merged' | 'review' | 'removed';

const worktreeReasons: Readonly<Record<WorktreeKind, CleanupReason>> = { merged: 'mergedWorktree', review: 'reviewWorktree', removed: 'removedWorktree' };

export interface CleanupItem {
	readonly area: StorageAreaId;
	readonly path: string;
	readonly bytes: number;
	readonly reason: CleanupReason;
	/** The agent it belongs to, for a chat, checkpoints or worktree. */
	readonly agent?: string;
	/** For a worktree: the repository it is a worktree of and the worktree, which `runCleanup` hands to `removeWorktree`. */
	readonly worktree?: { readonly repository: string; readonly worktree: AgentWorktree };
}

/** A worktree Clean Up may offer, with what git says about it; undefined when git couldn't say. */
export interface WorktreeCandidate {
	/** The agent it belongs to; for a removed agent's, the folder. */
	readonly agent: string;
	/** Unset: a merged thread's. */
	readonly kind?: WorktreeKind;
	readonly repository: string;
	readonly worktree: AgentWorktree;
	readonly status: WorktreeStatus | undefined;
}

export interface CleanupInput {
	readonly globalStorage: string;
	/** Every agent in the list, by id. */
	readonly agents: ReadonlySet<string>;
	/** The threads merged back (`mergedThreads`). */
	readonly merged: ReadonlySet<string>;
	/** `gemini.storage.keepLogsDays`; 0 keeps every day. */
	readonly keepLogsDays: number;
	readonly now: Date;
	/** Merged threads' worktrees; only those whose work is all committed and merged are offered. */
	readonly worktrees?: readonly WorktreeCandidate[];
	/** Whether a process is still running, for the debug logs. */
	readonly running?: (pid: number) => boolean;
}

/** What Clean Up would remove, to list for the user before asking. */
export async function cleanupPlan(input: CleanupInput): Promise<CleanupItem[]> {
	const items: CleanupItem[] = [];
	// Files are named after agents' ids, with anything but word characters and dashes made `_`.
	const agents = new Set([...input.agents].map(fileStem));
	const merged = new Set([...input.merged].map(fileStem));
	const own = (name: string) => path.join(input.globalStorage, name);
	const filesIn = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).map(name => ({ name, file: path.join(dir, name) }));
	const add = async (item: Omit<CleanupItem, 'bytes'>) => {
		const bytes = await fs.stat(item.path).then(stat => stat.isDirectory() ? folderSize(item.path) : stat.size, () => undefined);
		if (bytes !== undefined) {
			items.push({ ...item, bytes });
		}
	};
	const perAgent = async (area: StorageAreaId, dir: string, dropMerged: boolean) => {
		for (const { name, file } of await filesIn(dir)) {
			if (isQuarantined(name)) {
				await add({ area, path: file, reason: 'broken' });
				continue;
			}
			if (!name.endsWith('.json')) {
				continue;
			}
			const id = name.slice(0, -'.json'.length);
			if (!agents.has(id)) {
				await add({ area, path: file, reason: 'orphaned', agent: id });
			} else if (dropMerged && merged.has(id)) {
				await add({ area, path: file, reason: 'merged', agent: id });
			}
		}
	};
	await perAgent('chats', own('agents'), false);
	await perAgent('checkpoints', own('checkpoints'), true);
	for (const [area, name] of [['agentList', 'records/agents'], ['agentList', 'records/workspaces'], ['reviews', 'reviews']] as const) {
		for (const { name: file, file: full } of await filesIn(own(name))) {
			if (isQuarantined(file)) {
				await add({ area, path: full, reason: 'broken' });
			}
		}
	}
	for (const [area, name] of [['auditLog', 'audit'], ['pilotLog', 'pilot']] as const) {
		for (const file of await oldDayFiles(own(name), input.keepLogsDays, input.now)) {
			await add({ area, path: file, reason: 'oldLog' });
		}
	}
	for (const { file } of await filesIn(own('traces'))) {
		await add({ area: 'traces', path: file, reason: 'trace' });
	}
	const running = input.running ?? isRunning;
	for (const { name, file } of await filesIn(own('cli-logs'))) {
		const pid = debugLogPid(name);
		if (pid !== undefined && pid !== process.pid && !running(pid)) {
			await add({ area: 'cliLogs', path: file, reason: 'oldDebugLog' });
		}
	}
	await add({ area: 'cliLogs', path: own('cli-debug.log'), reason: 'oldDebugLog' });
	for (const candidate of input.worktrees ?? []) {
		// Never a worktree with uncommitted changes, or work its repository doesn't have.
		if (candidate.status && !candidate.status.uncommitted && !candidate.status.commits) {
			await add({ area: 'worktrees', path: candidate.worktree.folder, reason: worktreeReasons[candidate.kind ?? 'merged'], agent: candidate.agent, worktree: { repository: candidate.repository, worktree: candidate.worktree } });
		}
	}
	return items;
}

/**
 * Removes what a plan lists; a worktree goes through `removeWorktree`
 * (`git worktree remove`, keeping its branch; for an ended review, its
 * reviewer agent too). Returns what could not be removed, with why.
 */
export async function runCleanup(items: readonly CleanupItem[], removeWorktree: (repository: string, worktree: AgentWorktree, item: CleanupItem) => Promise<void>): Promise<{ readonly item: CleanupItem; readonly error: string }[]> {
	const failed: { item: CleanupItem; error: string }[] = [];
	for (const item of items) {
		try {
			if (item.worktree) {
				await removeWorktree(item.worktree.repository, item.worktree.worktree, item);
			} else {
				await fs.rm(item.path, { recursive: true, force: true });
			}
		} catch (err) {
			failed.push({ item, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return failed;
}

/** The rows of Settings' Storage section, each the areas it adds up. */
export type StorageGroup = 'worktrees' | 'index' | 'cli' | 'checkpoints' | 'chats' | 'logs';

const groupOf: Readonly<Record<StorageAreaId, StorageGroup>> = {
	worktrees: 'worktrees', reviewCheckouts: 'worktrees', threads: 'worktrees', projects: 'worktrees',
	index: 'index',
	managedCli: 'cli',
	checkpoints: 'checkpoints',
	chats: 'chats', agentList: 'chats', reviews: 'chats', flows: 'chats',
	auditLog: 'logs', pilotLog: 'logs', traces: 'logs', cliLogs: 'logs',
};

/** The bytes each row of the Storage section holds, in the section's order. */
export function storageGroups(sizes: readonly StorageAreaSize[]): { readonly group: StorageGroup; readonly bytes: number }[] {
	const order: readonly StorageGroup[] = ['worktrees', 'index', 'cli', 'checkpoints', 'chats', 'logs'];
	return order.map(group => ({ group, bytes: sizes.filter(size => groupOf[size.id] === group).reduce((sum, size) => sum + size.bytes, 0) }));
}

/** How many folders `root` holds two levels down, such as worktrees under ~/.geminicode/worktrees/<repository>/. */
export async function foldersTwoDown(root: string): Promise<string[]> {
	const dirs = async (dir: string) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name));
	return (await Promise.all((await dirs(root)).map(dirs))).flat();
}

/** How many entries a folder of GeminiCode's own holds, such as one index or checkpoint file per folder or agent; 0 when it is gone. */
export async function entriesIn(folder: string, suffix = ''): Promise<number> {
	return (await fs.readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(suffix) && !isQuarantined(name)).length;
}

/** The days of the audit and pilot logs past `keepDays` go; run in the background after startup. Returns how many files went. */
export async function applyLogRetention(globalStorage: string, keepDays: number, now: Date = new Date()): Promise<number> {
	const counts = await Promise.all(['audit', 'pilot'].map(name => removeOldDayFiles(path.join(globalStorage, name), keepDays, now)));
	return counts.reduce((sum, count) => sum + count, 0);
}

/** `gemini.storage.keepLogsDays` as used: 0 keeps every day; otherwise at least 7, which Home's Unfinished list reads. */
export function keepLogsDays(setting: unknown): number {
	const days = typeof setting === 'number' && Number.isFinite(setting) ? Math.floor(setting) : 90;
	return days <= 0 ? 0 : Math.max(7, days);
}

function fileStem(id: string): string {
	return id.replace(/[^\w-]/g, '_');
}
