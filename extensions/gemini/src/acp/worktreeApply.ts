/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Moves an agent's work between its worktree and the user's checkout without
// commits, merges or the index: Try in Workspace, its updates after each turn,
// Take Back, and Send My Edits. Each step takes a snapshot of a folder as a
// tree (through a temporary index, so the folder's own index is untouched)
// and applies the difference between two trees file by file, merged three
// ways with whatever the target folder holds, so the user's own edits stay.
// A file both sides changed in the same lines gets conflict markers; a file
// that can't be merged (binary, a symbolic link, or changed on one side and
// deleted on the other) is left as it is and reported apart.
//
// Files are compared and written as git would check them out (its filters:
// line endings, LFS), symbolic links as links, and nothing is written through
// a link that leads out of the target folder.

import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError } from './worktrees';

/** Git's empty tree, the base when nothing was applied yet. */
export const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const linkMode = '120000';

/** What applying a difference did. */
export interface ApplyResult {
	/** Files written or deleted. */
	readonly changed: readonly string[];
	/** Files merged with conflict markers. */
	readonly conflicts: readonly string[];
	/** Files left as they were because they can't be merged: binary, a symbolic link, deleted on one side, or reached through a link out of the folder. */
	readonly unmerged: readonly string[];
	/** Files `skip` held back, left as they were. */
	readonly skipped: readonly string[];
}

export interface ApplyOptions {
	/** The sides' names in conflict markers. */
	readonly labels: { readonly ours: string; readonly theirs: string };
	/** Only these files, when given. */
	readonly paths?: readonly string[];
	/** Files to leave alone, such as ones with unsaved edits in an editor. */
	readonly skip?: (file: string) => boolean;
}

interface RunOptions {
	readonly env?: Record<string, string>;
	/** Exit codes that are answers rather than failures, such as `git merge-file`'s conflict count. */
	readonly okCodes?: (code: number) => boolean;
	/** Written to the command's standard input. */
	readonly input?: string | Buffer;
}

function run(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<{ stdout: Buffer; code: number }> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env } }, (err, stdout, stderr) => {
			const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
			if (err && !(options.okCodes?.(code))) {
				const raw = stderr.toString();
				reject(new GitError(raw.trim() || err.message, raw));
				return;
			}
			resolve({ stdout, code });
		});
		// A command that stops reading early closes the pipe; its exit code says what happened.
		child.stdin?.on('error', () => undefined);
		child.stdin?.end(options.input);
	});
}

async function text(cwd: string, args: readonly string[], options?: RunOptions): Promise<string> {
	return (await run(cwd, args, options)).stdout.toString();
}

function tempIndex(): string {
	return path.join(os.tmpdir(), `geminicode-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/**
 * A tree of everything in `folder`'s repository as it is on disk: tracked and
 * new files, not ignored ones. Built in a copy of the folder's index (which
 * keeps git's file stats, so unchanged files aren't read again), never in the
 * index itself.
 */
export async function snapshotTree(folder: string): Promise<string> {
	const top = (await text(folder, ['rev-parse', '--show-toplevel'])).trim();
	const indexFile = path.resolve(top, (await text(top, ['rev-parse', '--git-path', 'index'])).trim());
	const temp = tempIndex();
	try {
		// The copy keeps the index's time: git trusts a file's stats only when it is older than its index.
		await fs.copyFile(indexFile, temp).then(async () => {
			const stat = await fs.stat(indexFile);
			await fs.utimes(temp, stat.atime, stat.mtime);
		}, () => undefined);
		const env = { GIT_INDEX_FILE: temp };
		await run(top, ['add', '-A', '--', '.'], { env });
		return (await text(top, ['write-tree'], { env })).trim();
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** The tree of `commit`. */
export async function treeOf(folder: string, commit: string): Promise<string> {
	return (await text(folder, ['rev-parse', `${commit}^{tree}`])).trim();
}

/** Where `branch` and what `repository` has checked out last met, or undefined when they never did. */
export async function forkPoint(repository: string, branch: string): Promise<string | undefined> {
	return mergeBase(repository, 'HEAD', branch);
}

async function mergeBase(repository: string, a: string, b: string): Promise<string | undefined> {
	try {
		return (await text(repository, ['merge-base', a, b])).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The commit `branch` was made from: where its reflog starts, when that is
 * its creation; else where it and `from` (the branch it was made from) last
 * met; else where it and the checkout's HEAD did. Not the user's HEAD first,
 * which may be an older branch than the agent started from.
 */
export async function startOf(repository: string, branch: string, from?: string): Promise<string | undefined> {
	const log = await text(repository, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--']).catch(() => '');
	const first = log.trim().split('\n').pop() ?? '';
	const created = /^([0-9a-f]+) branch: Created from /.exec(first)?.[1];
	if (created && await contains(repository, created, branch)) {
		return created;
	}
	return (from ? await mergeBase(repository, from, branch) : undefined) ?? mergeBase(repository, 'HEAD', branch);
}

/** Whether `head` (the checkout's HEAD by default) has `commit` in its history. */
export async function contains(repository: string, commit: string, head = 'HEAD'): Promise<boolean> {
	const { code } = await run(repository, ['merge-base', '--is-ancestor', commit, head], { okCodes: c => c === 1 }).catch(() => ({ code: 1 }));
	return code === 0;
}

/** The files that differ between two trees, renames as a delete and an add. */
export async function changedFiles(repository: string, from: string, to: string): Promise<string[]> {
	if (from === to) {
		return [];
	}
	return (await text(repository, ['diff', '--name-only', '--no-renames', '-z', from, to])).split('\0').filter(Boolean);
}

interface Entry {
	readonly oid: string;
	readonly mode: string;
}

/** Each path's blob and mode in `tree`; paths it doesn't have are left out. */
async function entries(repository: string, tree: string, paths: readonly string[]): Promise<Map<string, Entry>> {
	const found = new Map<string, Entry>();
	for (const chunk of chunks(paths, 200)) {
		const out = await text(repository, ['ls-tree', '-z', '--full-tree', tree, '--', ...chunk]);
		for (const line of out.split('\0').filter(Boolean)) {
			const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
			if (match && match[2] === 'blob') {
				found.set(match[4], { oid: match[3], mode: match[1] });
			}
		}
	}
	return found;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
	return a?.oid === b?.oid && a?.mode === b?.mode;
}

/** Blobs as stored, in one `git cat-file --batch`. */
async function rawBlobs(repository: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	const unique = [...new Set(oids)];
	if (!unique.length) {
		return found;
	}
	const out = (await run(repository, ['cat-file', '--batch'], { input: unique.map(oid => `${oid}\n`).join('') })).stdout;
	let at = 0;
	for (const oid of unique) {
		const end = out.indexOf(10, at);
		const header = /^([0-9a-f]+) blob (\d+)$/.exec(out.subarray(at, end).toString());
		if (!header) {
			throw new GitError(`Couldn't read ${oid}: ${out.subarray(at, end).toString()}`, '');
		}
		const size = Number(header[2]);
		found.set(oid, out.subarray(end + 1, end + 1 + size));
		at = end + 1 + size + 1;
	}
	return found;
}

/** Whether `core.autocrlf` converts line endings on checkout: true, yes, on or 1, not input or false. */
async function autocrlf(folder: string): Promise<boolean> {
	const value = (await text(folder, ['config', '--get', 'core.autocrlf']).catch(() => '')).trim().toLowerCase();
	if (!value || value === 'input') {
		return false;
	}
	return (await text(folder, ['config', '--type=bool', '--get', 'core.autocrlf']).catch(() => '')).trim() === 'true';
}

/**
 * The paths among `paths` whose checkout git changes on the way (line
 * endings, a filter such as LFS, an encoding), by their attributes and
 * `core.autocrlf`; the rest check out byte for byte as stored.
 */
async function filtered(folder: string, paths: readonly string[]): Promise<Set<string>> {
	if (!paths.length) {
		return new Set();
	}
	if (await autocrlf(folder)) {
		return new Set(paths);
	}
	const out = await text(folder, ['check-attr', '-z', '--stdin', 'text', 'eol', 'filter', 'ident', 'working-tree-encoding'], { input: paths.map(file => `${file}\0`).join('') });
	const found = new Set<string>();
	const fields = out.split('\0');
	for (let i = 0; i + 2 < fields.length; i += 3) {
		if (fields[i + 2] !== 'unspecified' && fields[i + 2] !== 'unset') {
			found.add(fields[i]);
		}
	}
	return found;
}

/**
 * Reads blobs as git would check them out at their paths under `folder`:
 * one batch for all, and git's filters for the paths that have any.
 * (`cat-file --batch --filters` reports the stored size, not the filtered
 * one, so its output can't be split.) The filtered ones are checked out
 * from temporary indexes into a temporary folder, two git processes per
 * version of a path, however many files: an index holds each path once.
 */
async function checkoutBlobs(folder: string, wanted: readonly { readonly entry: Entry; readonly path: string }[]): Promise<(entry: Entry, file: string) => Buffer> {
	const raw = await rawBlobs(folder, wanted.map(item => item.entry.oid));
	const special = await filtered(folder, [...new Set(wanted.filter(item => item.entry.mode !== linkMode).map(item => item.path))]);
	const converted = new Map<string, Buffer>();
	// Each round takes one version of each path: base and theirs of a file are two rounds.
	const rounds: Map<string, string>[] = [];
	for (const { entry, path: file } of wanted) {
		if (entry.mode === linkMode || !special.has(file) || rounds.some(round => round.get(file) === entry.oid)) {
			continue;
		}
		let round = rounds.find(round => !round.has(file));
		if (!round) {
			round = new Map();
			rounds.push(round);
		}
		round.set(file, entry.oid);
	}
	if (rounds.length) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geminicode-checkout-'));
		try {
			for (const [i, round] of rounds.entries()) {
				const env = { GIT_INDEX_FILE: path.join(dir, `index-${i}`) };
				const into = path.join(dir, `files-${i}`);
				await run(folder, ['update-index', '-z', '--index-info'], { env, input: [...round].map(([file, oid]) => `100644 ${oid}\t${file}\0`).join('') });
				// The attributes come from the checkout's own files, as the temporary index has none.
				await run(folder, ['checkout-index', '-a', '-f', `--prefix=${into}${path.sep}`], { env });
				for (const [file, oid] of round) {
					converted.set(`${oid}\0${file}`, await fs.readFile(path.join(into, file)));
				}
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	return (entry, file) => converted.get(`${entry.oid}\0${file}`) ?? raw.get(entry.oid)!;
}

/** A file as one side has it: missing, a regular file (and whether it is executable), a symbolic link (its target), or something else, such as a folder. */
type Side =
	| { readonly kind: 'missing' }
	| { readonly kind: 'file'; readonly data: Buffer; readonly executable: boolean }
	| { readonly kind: 'link'; readonly data: Buffer }
	| { readonly kind: 'other' };

const missing: Side = { kind: 'missing' };

/** What is at `file` on disk, without following a link there. */
async function readDisk(file: string): Promise<Side> {
	let stat;
	try {
		stat = await fs.lstat(file);
	} catch {
		return missing;
	}
	if (stat.isSymbolicLink()) {
		return { kind: 'link', data: await fs.readlink(file, { encoding: 'buffer' }) };
	}
	if (!stat.isFile()) {
		return { kind: 'other' };
	}
	return { kind: 'file', data: await fs.readFile(file), executable: (stat.mode & 0o111) !== 0 };
}

function sideOf(entry: Entry | undefined, data: ((entry: Entry) => Buffer)): Side {
	if (!entry) {
		return missing;
	}
	return entry.mode === linkMode ? { kind: 'link', data: data(entry) } : { kind: 'file', data: data(entry), executable: entry.mode === '100755' };
}

function sameContent(a: Side, b: Side): boolean {
	if (a.kind === 'missing' || a.kind === 'other' || b.kind === 'missing' || b.kind === 'other') {
		return a.kind === b.kind && a.kind === 'missing';
	}
	return a.kind === b.kind && a.data.equals(b.data);
}

function isBinary(data: Buffer): boolean {
	return data.subarray(0, 8000).includes(0);
}

/** `dir` with links followed, as far as it exists. */
async function realFolder(dir: string): Promise<string> {
	try {
		return await fs.realpath(dir);
	} catch {
		const parent = path.dirname(dir);
		return parent === dir ? dir : path.join(await realFolder(parent), path.basename(dir));
	}
}

/** Whether `file`'s folder, links followed, is inside `realTop`: a link to a folder elsewhere must not let a write out. */
async function insideFolder(realTop: string, file: string, known: Map<string, boolean>): Promise<boolean> {
	const dir = path.dirname(file);
	let inside = known.get(dir);
	if (inside === undefined) {
		const real = await realFolder(dir);
		inside = real === realTop || real.startsWith(realTop + path.sep);
		known.set(dir, inside);
	}
	return inside;
}

/** Puts `side` at `file`: deleted, written (never through a link), or made a link. */
async function put(file: string, side: Side, top: string): Promise<void> {
	if (side.kind === 'missing' || side.kind === 'other') {
		await remove(file, top);
		return;
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	const now = await fs.lstat(file).catch(() => undefined);
	if (now && (side.kind === 'link' || !now.isFile())) {
		await fs.rm(file, { recursive: false, force: true });
	}
	if (side.kind === 'link') {
		await fs.symlink(side.data.toString(), file);
		return;
	}
	// No following a link put there since it was read.
	const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
	try {
		await handle.writeFile(side.data);
		await setExecutable(handle, side.executable);
	} finally {
		await handle.close();
	}
}

async function setExecutable(handle: fs.FileHandle, executable: boolean): Promise<void> {
	const mode = (await handle.stat()).mode & 0o777;
	const want = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
	if (want !== mode) {
		await handle.chmod(want);
	}
}

/** Deletes `file` and the folders it leaves empty, up to `top`. */
async function remove(file: string, top: string): Promise<void> {
	await fs.rm(file, { force: true });
	let dir = path.dirname(file);
	while (dir.startsWith(top + path.sep)) {
		try {
			await fs.rmdir(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

/**
 * Applies what changed from tree `from` to tree `to` (both in `repository`'s
 * objects) to the files under `target`, a checkout of the same repository,
 * merging each with what the file holds there.
 */
export async function applyTrees(repository: string, target: string, from: string, to: string, options: ApplyOptions): Promise<ApplyResult> {
	const files = options.paths ?? await changedFiles(repository, from, to);
	const [before, after] = await Promise.all([entries(repository, from, files), entries(repository, to, files)]);
	const changed: string[] = [];
	const conflicts: string[] = [];
	const unmerged: string[] = [];
	const skipped: string[] = [];
	const work: string[] = [];
	for (const file of files) {
		if (sameEntry(before.get(file), after.get(file))) {
			continue;
		}
		(options.skip?.(file) ? skipped : work).push(file);
	}
	const blob = await checkoutBlobs(target, work.flatMap(file => [before.get(file), after.get(file)].filter(entry => !!entry).map(entry => ({ entry, path: file }))));
	const realTop = await fs.realpath(target);
	const known = new Map<string, boolean>();
	for (const file of work) {
		const full = path.join(target, file);
		try {
			if (!await insideFolder(realTop, full, known)) {
				unmerged.push(file);
				continue;
			}
			const ours = await readDisk(full);
			const base = sideOf(before.get(file), entry => blob(entry, file));
			const theirs = sideOf(after.get(file), entry => blob(entry, file));
			if (sameContent(ours, theirs)) {
				// The same already; only the executable bit may differ.
				if (ours.kind === 'file' && theirs.kind === 'file' && ours.executable !== theirs.executable) {
					await put(full, theirs, target);
					changed.push(file);
				}
				continue;
			}
			if (sameContent(ours, base)) {
				// Untouched here: take the new version as it is.
				await put(full, theirs, target);
				changed.push(file);
				continue;
			}
			if (ours.kind !== 'file' || theirs.kind !== 'file' || base.kind === 'link' || base.kind === 'other' || isBinary(ours.data) || isBinary(theirs.data) || (base.kind === 'file' && isBinary(base.data))) {
				unmerged.push(file);
				continue;
			}
			const merged = await mergeText(repository, ours.data, base.kind === 'file' ? base.data : Buffer.alloc(0), theirs.data, options.labels);
			await put(full, { kind: 'file', data: merged.data, executable: theirs.executable }, target);
			changed.push(file);
			if (merged.conflicts) {
				conflicts.push(file);
			}
		} catch {
			// Couldn't be read or written (a folder in the way, no permission): left as it is, and said, while the files before it stay applied.
			unmerged.push(file);
		}
	}
	return { changed, conflicts, unmerged, skipped };
}

async function mergeText(repository: string, ours: Buffer, base: Buffer, theirs: Buffer, labels: { readonly ours: string; readonly theirs: string }): Promise<{ data: Buffer; conflicts: boolean }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geminicode-merge-'));
	try {
		const [a, o, b] = [path.join(dir, 'ours'), path.join(dir, 'base'), path.join(dir, 'theirs')];
		await Promise.all([fs.writeFile(a, ours), fs.writeFile(o, base), fs.writeFile(b, theirs)]);
		// Exit codes 1-127 count the conflicts; anything else is a failure.
		const result = await run(repository, ['merge-file', '-p', '-L', labels.ours, '-L', 'before', '-L', labels.theirs, a, o, b], { okCodes: code => code > 0 && code < 128 });
		return { data: result.stdout, conflicts: result.code > 0 };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * The blob each of `paths` under `folder` (the top of a checkout) would be
 * stored as: through git's filters, as `git add` would; a link as its
 * target. Null for a missing file, 'other' for a folder or the like. `write`
 * stores the blobs too.
 */
async function diskEntries(folder: string, paths: readonly string[], write: boolean): Promise<Map<string, Entry | null | 'other'>> {
	const found = new Map<string, Entry | null | 'other'>();
	const files: string[] = [];
	const modes = new Map<string, string>();
	for (const file of paths) {
		const full = path.join(folder, file);
		const stat = await fs.lstat(full).catch(() => undefined);
		if (!stat) {
			found.set(file, null);
		} else if (stat.isSymbolicLink()) {
			const target = await fs.readlink(full, { encoding: 'buffer' });
			const oid = (await text(folder, ['hash-object', ...write ? ['-w'] : [], '--no-filters', '--stdin'], { input: target })).trim();
			found.set(file, { oid, mode: linkMode });
		} else if (!stat.isFile()) {
			found.set(file, 'other');
		} else if (file.includes('\n')) {
			found.set(file, { oid: (await text(folder, ['hash-object', ...write ? ['-w'] : [], '--', file])).trim(), mode: stat.mode & 0o111 ? '100755' : '100644' });
		} else {
			files.push(file);
			modes.set(file, stat.mode & 0o111 ? '100755' : '100644');
		}
	}
	for (const chunk of chunks(files, 2000)) {
		const oids = (await text(folder, ['hash-object', ...write ? ['-w'] : [], '--stdin-paths'], { input: chunk.map(file => `${file}\n`).join('') })).trim().split('\n');
		chunk.forEach((file, i) => found.set(file, { oid: oids[i], mode: modes.get(file)! }));
	}
	return found;
}

/** The files among `paths` that differ under `folder` from their version in `tree`: edits made there since. */
export async function editedSince(repository: string, folder: string, tree: string, paths: readonly string[]): Promise<string[]> {
	if (!paths.length) {
		return [];
	}
	const [known, disk] = await Promise.all([entries(repository, tree, paths), diskEntries(folder, paths, false)]);
	return paths.filter(file => {
		const now = disk.get(file);
		const then = known.get(file);
		// An executable bit alone isn't an edit.
		return now === 'other' || (now ? now.oid !== then?.oid : then !== undefined);
	});
}

/** The files among `paths` under `folder` that still hold conflict markers. */
export async function filesWithMarkers(folder: string, paths: readonly string[]): Promise<string[]> {
	const marked: string[] = [];
	for (const file of paths) {
		const side = await readDisk(path.join(folder, file));
		if (side.kind === 'file' && /^<{7} .*$[\s\S]*?^={7}$[\s\S]*?^>{7} /m.test(side.data.toString('utf8'))) {
			marked.push(file);
		}
	}
	return marked;
}

/** `tree` with `set` added or replaced and `drop` removed: a tree made in a temporary index. */
async function buildTree(repository: string, tree: string, set: readonly { readonly path: string; readonly entry: Entry }[], drop: readonly string[]): Promise<string> {
	if (!set.length && !drop.length) {
		return tree;
	}
	const temp = tempIndex();
	const env = { GIT_INDEX_FILE: temp };
	try {
		await run(repository, ['read-tree', tree], { env });
		if (set.length) {
			await run(repository, ['update-index', '-z', '--index-info'], { env, input: set.map(item => `${item.entry.mode} ${item.entry.oid}\t${item.path}\0`).join('') });
		}
		if (drop.length) {
			await run(repository, ['update-index', '-z', '--force-remove', '--stdin'], { env, input: drop.map(file => `${file}\0`).join('') });
		}
		return (await text(repository, ['write-tree'], { env })).trim();
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/**
 * Copies `paths` as they are under `from` (the top of a checkout) into a
 * tree built on `tree`: what a folder would hold with those files as they
 * are now. Stored as `git add` would store them.
 */
export async function treeWithFiles(repository: string, tree: string, from: string, paths: readonly string[]): Promise<string> {
	const disk = await diskEntries(from, paths, true);
	const set: { path: string; entry: Entry }[] = [];
	const drop: string[] = [];
	for (const file of paths) {
		const entry = disk.get(file);
		if (entry === null) {
			drop.push(file);
		} else if (entry && entry !== 'other') {
			set.push({ path: file, entry });
		}
	}
	return buildTree(repository, tree, set, drop);
}

/** `tree` with `paths` as `source` has them: for files held back from an update, which the next one brings. */
export async function treeWithEntries(repository: string, tree: string, source: string, paths: readonly string[]): Promise<string> {
	const found = await entries(repository, source, paths);
	return buildTree(repository, tree, paths.flatMap(file => found.has(file) ? [{ path: file, entry: found.get(file)! }] : []), paths.filter(file => !found.has(file)));
}

/**
 * Merges, in trees, what changed from `base` to `theirs` into `ours`, for
 * `paths`. A file both changed is merged by its lines; when that clashes, or
 * it can't be merged, `onConflict` says what the result holds: the merge
 * with conflict markers (or ours, when it can't be merged), or theirs.
 */
export async function mergeTrees(repository: string, ours: string, base: string, theirs: string, paths: readonly string[], onConflict: 'markers' | 'theirs'): Promise<{ readonly tree: string; readonly conflicts: readonly string[] }> {
	const [o, b, t] = await Promise.all([entries(repository, ours, paths), entries(repository, base, paths), entries(repository, theirs, paths)]);
	const set: { path: string; entry: Entry }[] = [];
	const drop: string[] = [];
	const conflicts: string[] = [];
	const take = (file: string, entry: Entry | undefined) => entry ? set.push({ path: file, entry }) : drop.push(file);
	const both = paths.filter(file => !sameEntry(b.get(file), t.get(file)) && !sameEntry(o.get(file), b.get(file)) && !sameEntry(o.get(file), t.get(file)));
	const textual = both.filter(file => [o, b, t].every(side => side.get(file)?.mode !== linkMode) && o.has(file) && t.has(file));
	const data = await rawBlobs(repository, textual.flatMap(file => [o, b, t].flatMap(side => side.get(file)?.oid ?? [])));
	for (const file of paths) {
		const [mine, start, other] = [o.get(file), b.get(file), t.get(file)];
		if (sameEntry(start, other) || sameEntry(mine, other)) {
			continue;
		}
		if (sameEntry(mine, start)) {
			take(file, other);
			continue;
		}
		const blobs = textual.includes(file) ? [mine!, start, other!].map(entry => entry ? data.get(entry.oid)! : Buffer.alloc(0)) : undefined;
		if (!blobs || blobs.some(isBinary)) {
			conflicts.push(file);
			if (onConflict === 'theirs') {
				take(file, other);
			}
			continue;
		}
		const merged = await mergeText(repository, blobs[0], blobs[1], blobs[2], { ours: 'ours', theirs: 'theirs' });
		if (merged.conflicts) {
			conflicts.push(file);
			if (onConflict === 'theirs') {
				take(file, other);
				continue;
			}
		}
		const oid = (await text(repository, ['hash-object', '-w', '--no-filters', '--stdin'], { input: merged.data })).trim();
		take(file, { oid, mode: other!.mode });
	}
	return { tree: await buildTree(repository, ours, set, drop), conflicts };
}

/**
 * The tried files as Try wrote them into `checkout`, read back after an
 * apply of `tree`: the user's edits are measured from it. A file left with
 * conflict markers counts as the thread's version, so the user's resolution
 * is their edit, not a clash with the markers.
 */
export async function appliedAfterTry(repository: string, tree: string, checkout: string, files: readonly string[], conflicts: readonly string[]): Promise<string> {
	return treeWithFiles(repository, tree, checkout, files.filter(file => !conflicts.includes(file)));
}

/**
 * What Try has written once an update from `from` to `to` was applied over
 * `applied`: the thread's changes on top of what it wrote before, without
 * the user's edits since. Files left with conflict markers count as the
 * thread's version, as in `appliedAfterTry`.
 */
export async function appliedAfterUpdate(repository: string, applied: string, from: string, to: string, conflicts: readonly string[]): Promise<string> {
	const merged = (await mergeTrees(repository, applied, from, to, await changedFiles(repository, from, to), 'theirs')).tree;
	return conflicts.length ? treeWithEntries(repository, merged, to, conflicts) : merged;
}

/** What Send My Edits did, in trees. */
export interface SentEdits {
	/** Applying the edits to the agent's folder. */
	readonly result: ApplyResult;
	/** The thread's tree with the edits, which updates start from. */
	readonly tree: string;
	/** What Take Back returns to, with the edits. */
	readonly back: string;
	/** The files as the user has them, which their next edits are measured from. */
	readonly applied: string;
	/** Files whose edits clashed with the thread's lines in `back`: Take Back leaves them as the user has them, the thread's change included. */
	readonly mixed: readonly string[];
}

/**
 * Send My Edits: the user's edits to `files` in the checkout `repository`,
 * since Try wrote them (`trees.applied`), merged into the agent's folder,
 * the thread's tree and what Take Back returns to.
 */
export async function sendEdits(repository: string, worktree: string, trees: { readonly tree: string; readonly applied: string; readonly back: string }, files: readonly string[], labels: { readonly ours: string; readonly theirs: string }): Promise<SentEdits> {
	const mine = await treeWithFiles(repository, trees.applied, repository, files);
	const result = await applyTrees(repository, worktree, trees.applied, mine, { labels, paths: files });
	const [tree, back] = await Promise.all([mergeTrees(repository, trees.tree, trees.applied, mine, files, 'theirs'), mergeTrees(repository, trees.back, trees.applied, mine, files, 'theirs')]);
	return { result, tree: tree.tree, back: back.tree, applied: mine, mixed: back.conflicts };
}

/** Points `ref` at `commit` in `folder`'s repository. */
export async function setRef(folder: string, ref: string, commit: string): Promise<void> {
	await run(folder, ['update-ref', ref, commit]);
}

/**
 * Saves `folder` as it is on disk as a commit on top of its HEAD, under
 * `ref`, without touching the folder or its branch: what Discard Changes
 * keeps so that Restore can bring it back.
 */
export async function saveSnapshot(folder: string, ref: string, message: string): Promise<{ readonly commit: string; readonly head: string }> {
	const tree = await snapshotTree(folder);
	const head = (await text(folder, ['rev-parse', 'HEAD'])).trim();
	const args = ['commit-tree', tree, '-p', head, '-m', message];
	// The user's own name and email, as for any commit; GeminiCode's only when git has none, since the ref is never pushed.
	const commit = (await text(folder, args).catch(err => /Please tell me who you are|Author identity unknown|empty ident/i.test(String(err?.stderr ?? err)) ? text(folder, args, { env: fallbackIdentity }) : Promise.reject(err))).trim();
	await run(folder, ['update-ref', ref, commit]);
	return { commit, head };
}

/** Puts `folder` back to `commit`'s files on its branch at `head`, as saved by `saveSnapshot`: the files changed, the index left at `head`. */
export async function restoreSnapshot(folder: string, commit: string, head: string): Promise<void> {
	await run(folder, ['reset', '--hard', '--quiet', head]);
	await run(folder, ['read-tree', '-u', '--reset', commit]);
	await run(folder, ['reset', '--quiet', head]);
}

/** Resets `folder` to `commit`, files and branch, and deletes new files that aren't ignored. */
export async function resetFolder(folder: string, commit: string): Promise<void> {
	await run(folder, ['reset', '--hard', '--quiet', commit]);
	await run(folder, ['clean', '-fd', '--quiet']);
}

/** Deletes `ref` in `folder`'s repository, if it is there. */
export async function deleteRef(folder: string, ref: string): Promise<void> {
	await run(folder, ['update-ref', '-d', ref]);
}

/** Deletes the refs whose names start with `prefix` (such as a thread's saved snapshots) in `folder`'s repository. */
export async function deleteRefs(folder: string, prefix: string): Promise<void> {
	const refs = (await text(folder, ['for-each-ref', '--format=%(refname)', prefix, `${prefix}*`])).split('\n').filter(ref => ref.startsWith(prefix));
	if (refs.length) {
		await run(folder, ['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}\n`).join('') });
	}
}

/** The name on a saved snapshot when git has no user configured. */
const fallbackIdentity: Record<string, string> = {
	GIT_AUTHOR_NAME: 'GeminiCode',
	GIT_AUTHOR_EMAIL: 'geminicode@localhost',
	GIT_COMMITTER_NAME: 'GeminiCode',
	GIT_COMMITTER_EMAIL: 'geminicode@localhost',
};
