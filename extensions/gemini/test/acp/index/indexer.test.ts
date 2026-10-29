/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { changedSince, porcelainPaths } from '../../../src/acp/index/gitChanges';
import { importNames, Indexer, workspaceId } from '../../../src/acp/index/indexer';
import type { IndexStatus } from '../../../src/acp/index/indexerProtocol';
import { IndexLock } from '../../../src/acp/index/indexLock';
import { IndexStore, schemaVersion } from '../../../src/acp/index/indexStore';

const settings = { exclude: ['fixtures/'], maxFileBytes: 64 * 1024 };

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, stdio: 'ignore' });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await check()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('The condition never held.');
}

function write(root: string, relative: string, text: string): void {
	mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
	writeFileSync(path.join(root, relative), text);
}

describe('Indexer', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'indexer-')));
	const repo = path.join(base, 'repo');
	const indexes = path.join(base, 'indexes');
	mkdirSync(repo);
	git(repo, 'init', '-q');
	write(repo, '.gitignore', 'build/\n');
	write(repo, 'src/cart/discount.ts', [
		'import { Cart } from \'./cart\';',
		'',
		'/** Applies a discount code to the cart. */',
		'export function applyDiscount(cart: Cart, code: string): Cart {',
		'\tif (!DISCOUNT_RULES[code]) {',
		'\t\tthrow new InvalidCodeError(code);',
		'\t}',
		'\treturn cart;',
		'}',
		'',
		'export const DISCOUNT_RULES: Record<string, number> = { SAVE10: 10 };',
	].join('\n'));
	write(repo, 'src/cart/cart.ts', 'export interface Cart { total: number }\nexport class CartService {\n\tcheckout(cart: Cart) {\n\t\treturn applyDiscount(cart, \'x\');\n\t}\n}\n');
	write(repo, 'src/cart/discount.test.ts', 'import { applyDiscount } from \'./discount\';\ntest(\'applies\', () => applyDiscount({ total: 1 }, \'SAVE10\'));\n');
	write(repo, 'build/out.js', 'function applyDiscount() {}\n');
	write(repo, 'fixtures/big.ts', 'export function fixture() {}\n');
	write(repo, '.env', 'TOKEN=secret\n');
	write(repo, 'logo.png', 'not really a png');
	write(repo, 'README.md', '# Acme Checkout\n\nThe checkout service for the Acme shop.\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-qm', 'one');
	write(repo, 'src/cart/discount.ts', `${require('node:fs').readFileSync(path.join(repo, 'src/cart/discount.ts'), 'utf8')}\n`);
	write(repo, 'src/cart/cart.ts', `${require('node:fs').readFileSync(path.join(repo, 'src/cart/cart.ts'), 'utf8')}\n`);
	git(repo, 'commit', '-qam', 'two');

	const statuses: IndexStatus[] = [];
	let waiters: (() => void)[] = [];
	const indexer = new Indexer({
		baseDir: indexes,
		onStatus: status => {
			statuses.push(status);
			const current = waiters;
			waiters = [];
			current.forEach(w => w());
		},
	});
	const ready = async (root: string) => {
		for (let i = 0; i < 200; i++) {
			const status = (await indexer.status({ roots: [root] }))[0];
			if (status.state.kind === 'ready') {
				return status;
			}
			await new Promise<void>(resolve => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
		throw new Error(`${root} never got ready`);
	};

	afterAll(async () => {
		await indexer.dispose();
		rmSync(base, { recursive: true, force: true });
	});

	it('builds an index of the files git lists, leaving out secrets, binaries and excludes', async () => {
		expect((await indexer.ensure({ root: repo, settings, build: true })).state.kind).toBe('building');
		const status = await ready(repo);
		expect(status.state).toMatchObject({ kind: 'ready', files: 5, skipped: 0 });
		const skipped = (await indexer.skipped({ root: repo })).map(s => `${s.path}: ${s.reason}`);
		expect(skipped).toEqual(expect.arrayContaining([
			'.env: .env may contain secrets',
			'fixtures/big.ts: excluded by .geminiignore or gemini.index.exclude',
			'logo.png: a binary file type',
		]));
		expect(await indexer.files({ root: repo })).toEqual(['.gitignore', 'README.md', 'src/cart/cart.ts', 'src/cart/discount.test.ts', 'src/cart/discount.ts']);
		expect(existsSync(path.join(indexes, 'code', await workspaceId(repo), 'index.db'))).toBe(true);
	});

	it('ranks the defining chunk first for words, camelCase names and snake_case names', async () => {
		for (const query of ['discount code', 'applyDiscount', 'apply discount', 'DISCOUNT_RULES']) {
			const { result, fallback } = await indexer.search({ root: repo, query: { query } });
			expect(fallback).toBeUndefined();
			expect(result.hits[0]?.path, query).toBe('src/cart/discount.ts');
		}
		// Tests rank below the code they test, unless the query asks for tests.
		expect((await indexer.search({ root: repo, query: { query: 'applies discount' } })).result.hits[0]?.path).toBe('src/cart/discount.ts');
		expect((await indexer.search({ root: repo, query: { query: 'test that applies discount' } })).result.hits[0]?.path).toBe('src/cart/discount.test.ts');
		const filtered = await indexer.search({ root: repo, query: { query: 'applyDiscount', path: '*.test.ts' } });
		expect(filtered.result.hits.map(h => h.path)).toEqual(['src/cart/discount.test.ts']);
	});

	it('finds a symbol\'s definition with its signature, and its references', async () => {
		const { result } = await indexer.findSymbol({ root: repo, name: 'applyDiscount', references: true });
		expect(result.definitions.map(d => [d.path, d.line, d.kind, d.signature])).toEqual([['src/cart/discount.ts', 4, 'function', 'export function applyDiscount(cart: Cart, code: string): Cart {']]);
		expect(result.references.map(r => `${r.path}:${r.line}`)).toEqual(['src/cart/cart.ts:4', 'src/cart/discount.test.ts:1', 'src/cart/discount.test.ts:2']);
		const method = await indexer.findSymbol({ root: repo, name: 'CartService.checkout' });
		expect(method.result.definitions.map(d => `${d.container}.${d.name} ${d.kind}`)).toEqual(['CartService.checkout method']);
		const similar = await indexer.findSymbol({ root: repo, name: 'Discount' });
		expect(similar.result.definitions).toEqual([]);
		expect(similar.result.similar.map(s => s.name)).toEqual(['applyDiscount', 'DISCOUNT_RULES']);
	});

	it('relates a file to its imports, importers, tests and the files it changes with', async () => {
		const { result } = await indexer.related({ root: repo, path: 'src/cart/discount.ts' });
		expect(result).toEqual({
			imports: ['src/cart/cart.ts'],
			importedBy: ['src/cart/discount.test.ts'],
			tests: ['src/cart/discount.test.ts'],
			changedWith: [{ path: 'src/cart/cart.ts', count: 2 }],
			known: true,
			suggestions: [],
		});
		const wrong = await indexer.related({ root: repo, path: 'discount.ts' });
		expect(wrong.result).toMatchObject({ known: false, suggestions: ['src/cart/discount.ts'] });
	});

	it('outlines the folder from its manifest, README, folders and public definitions', async () => {
		const { result } = await indexer.repoMap({ root: repo });
		expect(result).toBe([
			'README: Acme Checkout: The checkout service for the Acme shop.',
			'',
			'5 files · typescript 3, text 1, markdown 1',
			'',
			'./: .gitignore, README.md',
			'src/ (3 files)',
			'  src/cart/ (3 files): Cart, CartService, applyDiscount, DISCOUNT_RULES',
		].join('\n'));
	});

	it('applies changed, new and deleted files without a rebuild', async () => {
		write(repo, 'src/cart/coupon.ts', 'export function redeemCoupon() {}\n');
		rmSync(path.join(repo, 'src/cart/discount.test.ts'));
		write(repo, 'build/new.js', 'export function redeemCoupon() {}\n');
		await indexer.update({ root: repo, paths: ['src/cart/coupon.ts', path.join(repo, 'src/cart/discount.test.ts'), 'build/new.js', '../outside.ts'] });
		await eventually(async () => (await indexer.findSymbol({ root: repo, name: 'redeemCoupon' })).result.definitions.length > 0);
		const { result } = await indexer.findSymbol({ root: repo, name: 'redeemCoupon' });
		expect(result.definitions.map(d => d.path)).toEqual(['src/cart/coupon.ts']);
		expect(await indexer.files({ root: repo })).not.toContain('src/cart/discount.test.ts');
	});

	it('indexes a left-out file once it is included, without a rebuild', async () => {
		const before = await indexer.skipped({ root: repo });
		expect(before.find(s => s.path === 'fixtures/big.ts')).toEqual({ path: 'fixtures/big.ts', reason: 'excluded by .geminiignore or gemini.index.exclude', includable: true });
		expect(before.find(s => s.path === '.env')?.includable).toBe(false);
		await indexer.ensure({ root: repo, settings: { ...settings, include: ['/fixtures/big.ts'] }, build: false });
		await eventually(async () => (await indexer.findSymbol({ root: repo, name: 'fixture' })).result.definitions.length === 1);
		expect((await indexer.skipped({ root: repo })).some(s => s.path === 'fixtures/big.ts')).toBe(false);
		await indexer.ensure({ root: repo, settings, build: false });
	});

	it('answers from live search while a folder has no index yet', async () => {
		const plain = path.join(base, 'plain');
		write(plain, 'a.py', 'def apply_discount():\n    pass\n');
		const answer = await indexer.search({ root: plain, query: { query: 'apply_discount' } });
		expect(answer.fallback).toEqual({ done: 0, total: 0 });
		expect((await indexer.status({ roots: [plain] }))[0].state.kind).toBe('none');
	});

	it('seeds a worktree\'s index from its repository\'s, then reconciles it', async () => {
		const worktree = path.join(base, 'wt');
		git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
		write(worktree, 'src/cart/extra.ts', 'export function onlyInWorktree() {}\n');
		await indexer.seed({ from: repo, to: worktree, settings });
		await ready(worktree);
		await eventually(async () => (await indexer.findSymbol({ root: worktree, name: 'onlyInWorktree' })).result.definitions.length === 1);
		expect((await indexer.findSymbol({ root: repo, name: 'onlyInWorktree' })).result.definitions).toHaveLength(0);
		expect((await indexer.findSymbol({ root: worktree, name: 'redeemCoupon' })).result.definitions).toHaveLength(0);
		expect(await workspaceId(worktree)).not.toBe(await workspaceId(repo));
	});

	it('shares one index between two spellings of a folder', async () => {
		const link = path.join(base, 'link');
		symlinkSync(repo, link);
		expect(await workspaceId(link)).toBe(await workspaceId(repo));
	});

	it('starts again from a damaged index file', async () => {
		const damaged = path.join(base, 'damaged');
		write(damaged, 'x.ts', 'export function fromDamaged() {}\n');
		const file = path.join(indexes, 'code', await workspaceId(damaged), 'index.db');
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, 'this is not a database');
		await indexer.ensure({ root: damaged, settings, build: true });
		await ready(damaged);
		expect((await indexer.findSymbol({ root: damaged, name: 'fromDamaged' })).result.definitions).toHaveLength(1);
		expect(existsSync(`${file}.broken`)).toBe(true);
	});

	it('leaves out links that lead out of the folder or to secret files, and keeps links inside it', async () => {
		const linked = path.join(base, 'linked');
		const outside = path.join(base, 'outside-secrets');
		write(outside, 'id_rsa', 'PRIVATE KEY outsideKeyMaterial\n');
		write(linked, 'src/real.ts', 'export function realThing() {}\n');
		write(linked, '.ssh/config', 'Host x\n');
		symlinkSync(path.join(outside, 'id_rsa'), path.join(linked, 'notes.md'));
		symlinkSync(path.join(linked, 'src/real.ts'), path.join(linked, 'alias.ts'));
		symlinkSync(path.join(linked, '.ssh/config'), path.join(linked, 'config.txt'));
		git(linked, 'init', '-q');
		git(linked, 'add', '-A');
		git(linked, 'commit', '-qm', 'links');
		await indexer.ensure({ root: linked, settings, build: true });
		await ready(linked);
		const skipped = (await indexer.skipped({ root: linked })).filter(s => !s.path.startsWith('.ssh/'));
		expect(skipped).toEqual([
			{ path: 'config.txt', reason: 'a link to a file that may contain secrets', includable: false },
			{ path: 'notes.md', reason: 'a link to a file outside the folder', includable: false },
		]);
		expect(await indexer.files({ root: linked })).toEqual(['alias.ts', 'src/real.ts']);
		expect((await indexer.search({ root: linked, query: { query: 'outsideKeyMaterial' } })).result.hits).toEqual([]);
		// A file event for a link (or a path through a linked folder) is checked the same way.
		symlinkSync(outside, path.join(linked, 'vendor'));
		symlinkSync(path.join(outside, 'id_rsa'), path.join(linked, 'later.md'));
		await indexer.update({ root: linked, paths: ['vendor/id_rsa', 'later.md', 'src/real.ts'] });
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(await indexer.files({ root: linked })).toEqual(['alias.ts', 'src/real.ts']);
	});

	it('keeps secret files and .geminiignore out of live search before the first build', async () => {
		const fresh = path.join(base, 'fresh');
		write(fresh, '.geminiignore', 'private/\n');
		const rg = path.join(base, 'fake-rg.sh');
		// Stands in for ripgrep: the lines it would print for "private key".
		writeFileSync(rg, '#!/bin/sh\nprintf \'service-account.json:3:  "private_key": "-----BEGIN"\\nprivate/notes.md:1:private key here\\nsrc/keys.ts:7:export function rotatePrivateKey() {}\\n\'\n');
		chmodSync(rg, 0o755);
		const live = new Indexer({ baseDir: path.join(base, 'live-indexes'), ripgrep: rg });
		try {
			const answer = await live.search({ root: fresh, query: { query: 'private key' } });
			expect(answer.fallback).toBeDefined();
			expect(answer.result.hits.map(h => h.path)).toEqual(['src/keys.ts']);
			const symbol = await live.findSymbol({ root: fresh, name: 'rotatePrivateKey' });
			expect(symbol.result.definitions.map(d => d.path)).toEqual(['src/keys.ts']);
		} finally {
			await live.dispose();
		}
	});

	it('drops a deleted folder\'s files when only the folder is reported', async () => {
		write(repo, 'src/legacy/a.ts', 'export function legacyA() {}\n');
		write(repo, 'src/legacy/deep/b.ts', 'export function legacyB() {}\n');
		write(repo, 'src/legacyKeep.ts', 'export function legacyKeep() {}\n');
		await indexer.update({ root: repo, paths: ['src/legacy/a.ts', 'src/legacy/deep/b.ts', 'src/legacyKeep.ts'] });
		await eventually(async () => (await indexer.findSymbol({ root: repo, name: 'legacyB' })).result.definitions.length === 1);
		rmSync(path.join(repo, 'src/legacy'), { recursive: true });
		await indexer.update({ root: repo, paths: ['src/legacy'] });
		await eventually(async () => (await indexer.findSymbol({ root: repo, name: 'legacyB' })).result.definitions.length === 0);
		const files = await indexer.files({ root: repo });
		expect(files?.filter(f => f.includes('legacy'))).toEqual(['src/legacyKeep.ts']);
		// The counts kept by each write match a fresh count.
		const status = (await indexer.status({ roots: [repo] }))[0];
		const store = await IndexStore.open(path.join(indexes, 'code', await workspaceId(repo), 'index.db'), { readOnly: true });
		try {
			expect(status.state).toMatchObject(store.counts());
		} finally {
			store.close();
		}
	});

	it('points an import at a file added after it, without re-resolving on saves', async () => {
		write(repo, 'src/cart/checkout.ts', 'import { tax } from \'./taxes\';\nexport function checkoutTotal() { return tax(); }\n');
		await indexer.update({ root: repo, paths: ['src/cart/checkout.ts'] });
		await eventually(async () => (await indexer.related({ root: repo, path: 'src/cart/checkout.ts' })).result.known);
		expect((await indexer.related({ root: repo, path: 'src/cart/checkout.ts' })).result.imports).toEqual([]);
		write(repo, 'src/cart/taxes.ts', 'export function tax() { return 1; }\n');
		await indexer.update({ root: repo, paths: ['src/cart/taxes.ts'] });
		await eventually(async () => (await indexer.related({ root: repo, path: 'src/cart/checkout.ts' })).result.imports.length === 1);
		expect((await indexer.related({ root: repo, path: 'src/cart/taxes.ts' })).result.importedBy).toEqual(['src/cart/checkout.ts']);
		expect([...importNames(['src/a/cart.service.ts', 'pkg/mod/__init__.py', 'Foo.java'])]).toEqual(['cart', '__init__', 'mod', 'Foo']);
	});

	it('applies what git says changed when an agent\'s turn ends', async () => {
		const worktree = path.join(base, 'wt');
		write(worktree, 'src/cart/turn.ts', 'export function fromTheTurn() {}\n');
		write(worktree, 'src/cart/committed.ts', 'export function committedInTurn() {}\n');
		git(worktree, 'add', 'src/cart/committed.ts');
		git(worktree, 'commit', '-qm', 'in the turn');
		await indexer.turnEnded({ root: worktree });
		await eventually(async () => (await indexer.findSymbol({ root: worktree, name: 'fromTheTurn' })).result.definitions.length === 1);
		await eventually(async () => (await indexer.findSymbol({ root: worktree, name: 'committedInTurn' })).result.definitions.length === 1);
		expect(porcelainPaths(' M a.ts\0R  new.ts\0old.ts\0?? dir/x.ts\0')).toEqual(['a.ts', 'new.ts', 'old.ts', 'dir/x.ts']);
		expect(await changedSince(path.join(base, 'plain'), undefined)).toBeUndefined();
	});

	it('closes an idle index and opens it again for the next change', async () => {
		let now = Date.now();
		const idleBase = path.join(base, 'idle-indexes');
		const idle = new Indexer({ baseDir: idleBase, now: () => now });
		const folder = path.join(base, 'idle');
		write(folder, 'a.ts', 'export function beforeIdle() {}\n');
		try {
			await idle.ensure({ root: folder, settings, build: true });
			await eventually(async () => (await idle.findSymbol({ root: folder, name: 'beforeIdle' })).result.definitions.length === 1);
			now += 11 * 60 * 1000;
			await idle.closeIdle();
			expect(existsSync(path.join(idleBase, 'code', await workspaceId(folder), 'index.lock'))).toBe(false);
			write(folder, 'b.ts', 'export function afterIdle() {}\n');
			await idle.update({ root: folder, paths: ['b.ts'] });
			await eventually(async () => (await idle.findSymbol({ root: folder, name: 'afterIdle' })).result.definitions.length === 1);
		} finally {
			await idle.dispose();
		}
	});

	it('removes an index', async () => {
		await indexer.remove({ root: path.join(base, 'damaged') });
		expect(existsSync(path.join(indexes, 'code', await workspaceId(path.join(base, 'damaged'))))).toBe(false);
	});
});

describe('IndexStore', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'store-')));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('keeps an index it can\'t open for a passing reason, and moves aside one from another schema', async () => {
		const busy = path.join(dir, 'busy.db');
		// Not a file SQLite can open (as with a full disk or too many open files), but nothing says it is damaged.
		mkdirSync(busy);
		await expect(IndexStore.open(busy)).rejects.toThrow();
		expect([existsSync(busy), existsSync(`${busy}.broken`)]).toEqual([true, false]);

		const old = path.join(dir, 'old.db');
		const store = await IndexStore.open(old);
		store.setMeta('schema_version', String(schemaVersion + 1));
		store.close();
		(await IndexStore.open(old)).close();
		expect(existsSync(`${old}.broken`)).toBe(true);
	});
});

describe('IndexLock', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lock-')));
	afterEach(() => rmSync(path.join(dir, 'index.lock'), { force: true }));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('lets one live process write, and takes over a dead one\'s lock', async () => {
		const first = await IndexLock.acquire(dir, process.ppid);
		expect(first).toBeDefined();
		expect(await IndexLock.acquire(dir)).toBeUndefined();
		writeFileSync(path.join(dir, 'index.lock'), JSON.stringify({ pid: 999_999_999, at: 0 }));
		const second = await IndexLock.acquire(dir);
		expect(second).toBeDefined();
		await second!.release();
		expect(existsSync(path.join(dir, 'index.lock'))).toBe(false);
	});
});
