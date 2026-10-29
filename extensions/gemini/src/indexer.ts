/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The indexer process's entry point (dist/indexer.js, out/indexer.js),
// forked by IndexClient with the app's own Node. It answers the extension
// host's requests over the IPC channel and exits when the host goes away.

import * as os from 'node:os';
import { DocsLibrary } from './acp/docs/docsLibrary';
import { Indexer } from './acp/index/indexer';
import type { HostMessage, IndexerMessage, IndexerMethods } from './acp/index/indexerProtocol';

function send(message: IndexerMessage): void {
	process.send?.(message);
}

try {
	// Below everything the user is doing; the editor and the agent come first.
	os.setPriority(os.constants.priority.PRIORITY_LOW);
} catch {
	// Not allowed here; the work is cut into short slices anyway.
}

const baseDir = process.env.GEMINICODE_INDEX_DIR || `${os.homedir()}/.geminicode/index`;
const indexer = new Indexer({
	baseDir,
	ripgrep: process.env.GEMINICODE_RIPGREP || undefined,
	onStatus: status => send({ kind: 'event', event: 'status', status }),
	onIdle: idle => send({ kind: 'event', event: 'idle', idle }),
	log: message => send({ kind: 'event', event: 'log', message }),
});
const docs = new DocsLibrary(baseDir);

const handlers: { [M in keyof IndexerMethods]: (params: Parameters<IndexerMethods[M]>[0]) => unknown } = {
	ensure: params => indexer.ensure(params),
	update: params => indexer.update(params),
	reconcile: params => indexer.reconcile(params),
	turnEnded: params => indexer.turnEnded(params),
	rebuild: params => indexer.rebuild(params),
	pause: params => indexer.pause(params),
	resume: params => indexer.resume(params),
	remove: params => indexer.remove(params),
	seed: params => indexer.seed(params),
	status: params => indexer.status(params),
	skipped: params => indexer.skipped(params),
	files: params => indexer.files(params),
	search: params => indexer.search(params),
	findSymbol: params => indexer.findSymbol(params),
	related: params => indexer.related(params),
	repoMap: params => indexer.repoMap(params),
	docsIngest: params => docs.ingest(params),
	docsStatus: params => docs.status(params),
	docsRemove: params => docs.remove(params),
	docsSearch: params => docs.search(params),
	docsValidators: params => docs.validators(params),
};

process.on('message', (raw: unknown) => {
	const message = raw as HostMessage;
	void (async () => {
		try {
			const handler = handlers[message.method] as (params: unknown) => unknown;
			send({ kind: 'answer', id: message.id, result: await handler(message.params) });
		} catch (err) {
			send({ kind: 'answer', id: message.id, error: err instanceof Error ? err.message : String(err) });
		}
	})();
});

process.on('disconnect', () => {
	docs.dispose();
	void indexer.dispose().finally(() => process.exit(0));
});

setTimeout(() => void indexer.collectUnused(), 60_000).unref();
