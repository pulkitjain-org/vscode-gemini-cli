/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: comments on a Markdown file an agent wrote, in upstream's rich
// Markdown editor, that go to the agent. The editor shows its comment box only
// for files a comments provider accepts, and upstream registers one only in its
// own agent sessions, so in GeminiCode it had none. This provider accepts the
// files the Gemini extension marks (`_gemini.markdownComments.allow`, when it
// opens one of an agent's Markdown files), keeps their comments in workspace
// storage, and Send Comments to Gemini, in the title bar of a file with
// comments, hands them to the extension (`_gemini.sendFileComments`), which
// sends them to the agent as one message. Comments leave the file as they go,
// and come back if the message never reaches the agent.

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentEditorComment, IAgentEditorCommentRevealEvent, IAgentEditorCommentsBridge, IAgentEditorCommentsProvider } from '../../../services/agentEditorComments/common/agentEditorComments.js';
import { GeminiMarkdownComment, GeminiMarkdownCommentStore } from '../common/geminiMarkdownCommentStore.js';

const storageKey = 'gemini.markdownComments';
/** The URIs of files with comments to send: the title bar's `resource` is matched against it. */
const commentedFiles = new RawContextKey<string[]>('geminiMarkdownCommentedFiles', []);

let instance: GeminiMarkdownComments | undefined;

class GeminiMarkdownComments extends Disposable implements IWorkbenchContribution, IAgentEditorCommentsProvider {

	static readonly ID = 'workbench.contrib.geminiMarkdownComments';

	private readonly store: GeminiMarkdownCommentStore;
	private readonly commented: IContextKey<string[]>;
	private readonly onDidChangeCommentsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeComments = this.onDidChangeCommentsEmitter.event;
	private readonly onDidRevealCommentEmitter = this._register(new Emitter<IAgentEditorCommentRevealEvent>());
	readonly onDidRevealComment = this.onDidRevealCommentEmitter.event;

	constructor(
		@IAgentEditorCommentsBridge bridge: IAgentEditorCommentsBridge,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		instance = this;
		this.store = new GeminiMarkdownCommentStore(storageService.get(storageKey, StorageScope.WORKSPACE));
		this.commented = commentedFiles.bindTo(contextKeyService);
		this.commented.set(this.store.commented());
		this._register(bridge.registerProvider(this));
	}

	acceptsComments(resource: URI): boolean {
		return this.store.accepts(resource.toString());
	}

	getComments(resource: URI): readonly IAgentEditorComment[] {
		return this.store.comments(resource.toString()).map(comment => ({ ...comment, resource }));
	}

	addComment(resource: URI, range: IRange, body: string): void {
		if (body.trim() && this.store.add(resource.toString(), { id: generateUuid(), range, body })) {
			this.changed();
		}
	}

	deleteComment(resource: URI, id: string): void {
		if (this.store.delete(resource.toString(), id)) {
			this.changed();
		}
	}

	/** Lets `resource`, written by agent `agent`, take comments. */
	allow(resource: URI, agent: string): void {
		const key = resource.toString();
		if (this.store.agentOf(key) !== agent || !this.store.accepts(key)) {
			this.store.allow(key, agent);
			this.changed();
		}
	}

	/** Sends `resource`'s comments to its agent; they come back if the message never reaches it. */
	async send(resource: URI): Promise<void> {
		const key = resource.toString();
		const taken = this.store.take(key);
		if (!taken) {
			return;
		}
		this.changed();
		let sent = false;
		try {
			sent = await this.commandService.executeCommand<boolean>('_gemini.sendFileComments', {
				agent: taken.agent,
				file: resource.fsPath,
				comments: taken.comments.map((comment: GeminiMarkdownComment) => ({ range: comment.range, body: comment.body })),
			}) === true;
		} catch (err) {
			// The extension says why when it can; without it there is no one to send to.
			this.logService.error('[GeminiMarkdownComments] Sending comments failed', err);
			this.notificationService.warn(localize('gemini.markdownComments.notSent', "Your comments didn't go to Gemini. They are back on the file: send them again when the agent is open."));
		}
		if (!sent) {
			this.store.restore(key, taken.comments);
			this.changed();
		}
	}

	private changed(): void {
		this.storageService.store(storageKey, this.store.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.commented.set(this.store.commented());
		this.onDidChangeCommentsEmitter.fire();
	}
}

registerWorkbenchContribution2(GeminiMarkdownComments.ID, GeminiMarkdownComments, WorkbenchPhase.AfterRestored);

/** From the Gemini extension: `uri` (a string) is a Markdown file agent `agent` wrote, which takes comments. */
CommandsRegistry.registerCommand('_gemini.markdownComments.allow', (_accessor, uri: unknown, agent: unknown) => {
	if (typeof uri !== 'string' || typeof agent !== 'string' || !agent) {
		return false;
	}
	const resource = URI.parse(uri);
	if (!/\.(md|markdown|mdx)$/i.test(resource.path)) {
		return false;
	}
	instance?.allow(resource, agent);
	return !!instance;
});

registerAction2(class SendMarkdownCommentsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gemini.sendMarkdownComments',
			title: localize2('gemini.sendMarkdownComments', "Send Comments to Gemini"),
			icon: Codicon.send,
			// Beside the chat, and in the overlay Expand opens it in.
			menu: [MenuId.EditorTitle, MenuId.ModalEditorEditorTitle].map(id => ({ id, group: 'navigation', order: -20, when: ContextKeyExpr.in('resource', commentedFiles.key) })),
		});
	}
	async run(_accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		if (URI.isUri(resource)) {
			await instance?.send(resource);
		}
	}
});
