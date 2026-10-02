/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { checkAgent } from './host/checkAgent';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Gemini', { log: true });
	context.subscriptions.push(
		log,
		vscode.commands.registerCommand('gemini.showLog', () => log.show()),
		vscode.commands.registerCommand('gemini.checkAgent', () => checkAgent(log)),
	);
}

export function deactivate(): void { }
