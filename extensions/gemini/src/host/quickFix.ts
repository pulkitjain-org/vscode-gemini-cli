/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Fix with Gemini", a quick fix on every problem in a file: it attaches the
// problem and the code around it to the agent in front (else the running agent
// used last, else a new one), ready for the user to send. Nothing is sent by
// itself. The provider only builds an action per diagnostic it is given, so it
// costs nothing as the light bulb asks.

import * as vscode from 'vscode';
import type { Attachment } from '../acp/attachments';
import { codeAround, problemLine } from '../acp/mentions';
import { problemOf } from './chat/chatAttachments';
import type { ChatController } from './chatController';

const fixCommand = 'gemini.fixWithGemini';

export class FixWithGemini implements vscode.CodeActionProvider, vscode.Disposable {

	static readonly kinds = [vscode.CodeActionKind.QuickFix];
	private readonly disposables: vscode.Disposable[];

	/** `chatFor` finds the chat to attach to, starting an agent when none is open. */
	constructor(private readonly chatFor: () => Promise<ChatController | undefined>) {
		this.disposables = [
			vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, { providedCodeActionKinds: FixWithGemini.kinds }),
			vscode.commands.registerCommand(fixCommand, (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => this.fix(uri, diagnostic)),
		];
	}

	provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		return context.diagnostics.map(diagnostic => {
			const action = new vscode.CodeAction(vscode.l10n.t("Fix with Gemini"), vscode.CodeActionKind.QuickFix);
			action.diagnostics = [diagnostic];
			action.command = { command: fixCommand, title: action.title, arguments: [document.uri, diagnostic] };
			return action;
		});
	}

	private async fix(uri: vscode.Uri, diagnostic: vscode.Diagnostic): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const chat = await this.chatFor();
		if (!chat) {
			return;
		}
		const problem = problemOf(uri.fsPath, diagnostic);
		const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? '';
		const attachments: Attachment[] = [
			{ kind: 'document', name: vscode.l10n.t("Problem: {0}", diagnostic.message.split('\n')[0].slice(0, 60)), mimeType: 'text/plain', text: problemLine(problem, folder) },
			codeAround(uri.fsPath, document.getText(), diagnostic.range.start.line + 1, diagnostic.range.end.line + 1, 10, document.languageId),
		];
		await chat.addAttachments(attachments);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
