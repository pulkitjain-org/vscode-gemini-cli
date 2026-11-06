/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A stand-in for the `vscode` module, for the host modules that import it:
// `vi.mock('vscode', () => import('./vscodeStub'))` at the top of a test. The
// parts are plain objects, so a test replaces what it drives (`window.createWebviewPanel`)
// and fires the events it needs (`terminalEvents`). The host modules' types of
// `vscode` come from the app's declarations, as in the host's own tsconfig.

/// <reference path="../../../../src/vscode-dts/vscode.d.ts" />
/// <reference path="../../../../src/vscode-dts/vscode.proposed.terminalSelection.d.ts" />
/// <reference path="../../../../src/vscode-dts/vscode.proposed.terminalQuickFixProvider.d.ts" />

import { Emitter } from '../../src/acp/events';

export class EventEmitter<T> {
	private readonly emitter = new Emitter<T>();
	readonly event = this.emitter.event;
	fire(value: T): void {
		this.emitter.fire(value);
	}
	dispose(): void {
		this.emitter.dispose();
	}
}

export class Disposable {
	constructor(private readonly callOnDispose: () => void) { }
	static from(...disposables: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => disposables.forEach(d => d.dispose()));
	}
	dispose(): void {
		this.callOnDispose();
	}
}

export class Uri {
	private constructor(readonly scheme: string, readonly fsPath: string) { }
	static file(path: string): Uri {
		return new Uri('file', path);
	}
	static parse(value: string): Uri {
		const at = value.indexOf('://');
		return at >= 0 ? new Uri(value.slice(0, at), value.slice(at + 3)) : new Uri('file', value);
	}
	static joinPath(base: Uri, ...parts: string[]): Uri {
		return new Uri(base.scheme, [base.fsPath, ...parts].join('/'));
	}
	get path(): string {
		return this.fsPath;
	}
	toString(): string {
		return `${this.scheme}://${this.fsPath}`;
	}
	with(): Uri {
		return this;
	}
}

export class ThemeIcon {
	constructor(readonly id: string) { }
}

export class ThemeColor {
	constructor(readonly id: string) { }
}

export class MarkdownString {
	value = '';
	constructor(value = '') {
		this.value = value;
	}
	appendMarkdown(text: string): this {
		this.value += text;
		return this;
	}
	appendText(text: string): this {
		this.value += text;
		return this;
	}
	appendCodeblock(text: string): this {
		this.value += text;
		return this;
	}
}

export class CancellationTokenSource {
	readonly token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
	cancel(): void {
		this.token.isCancellationRequested = true;
	}
	dispose(): void { }
}

export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export enum TerminalShellExecutionCommandLineConfidence { Low = 0, Medium = 1, High = 2 }

export class TreeItem {
	constructor(readonly label: string, readonly collapsibleState?: TreeItemCollapsibleState) { }
}

export class Position {
	constructor(readonly line: number, readonly character: number) { }
}

export class Range {
	constructor(readonly start: Position, readonly end: Position) { }
}

export class Selection extends Range { }

export class RelativePattern {
	constructor(readonly base: unknown, readonly pattern: string) { }
}

/** `{0}` placeholders filled in, as `vscode.l10n.t` does. */
export const l10n = {
	t: (message: string, ...args: unknown[]): string => message.replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)])),
};

/** The terminal events, fired by tests of the terminals. */
export const terminalEvents = {
	start: new EventEmitter<{ terminal: unknown; execution: unknown; shellIntegration?: unknown }>(),
	end: new EventEmitter<{ terminal: unknown; execution: unknown; exitCode: number | undefined; shellIntegration?: unknown }>(),
	close: new EventEmitter<unknown>(),
	integration: new EventEmitter<{ terminal: unknown; shellIntegration: unknown }>(),
};

const noEvent = () => ({ dispose: () => undefined });

export const window = {
	createWebviewPanel: (..._args: unknown[]): unknown => {
		throw new Error('window.createWebviewPanel is not stubbed by this test');
	},
	createTerminal: (..._args: unknown[]): unknown => {
		throw new Error('window.createTerminal is not stubbed by this test');
	},
	createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, show: () => undefined, dispose: () => undefined }),
	createStatusBarItem: () => ({ show: () => undefined, hide: () => undefined, dispose: () => undefined }),
	createTextEditorDecorationType: () => ({ dispose: () => undefined }),
	createQuickPick: () => ({ show: () => undefined, dispose: () => undefined, onDidAccept: noEvent, onDidHide: noEvent, onDidTriggerItemButton: noEvent, items: [] }),
	showInformationMessage: async () => undefined,
	showWarningMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	showInputBox: async () => undefined,
	showQuickPick: async () => undefined,
	showOpenDialog: async () => undefined,
	showTextDocument: async () => undefined,
	withProgress: async <T>(_options: unknown, task: (progress: unknown, token: unknown) => Promise<T>): Promise<T> => task({ report: () => undefined }, { onCancellationRequested: noEvent }),
	activeTerminal: undefined as unknown,
	activeTextEditor: undefined as unknown,
	visibleTextEditors: [] as unknown[],
	terminals: [] as unknown[],
	tabGroups: { all: [], activeTabGroup: { tabs: [] }, onDidChangeTabs: noEvent, onDidChangeTabGroups: noEvent, close: async () => true },
	onDidChangeActiveTextEditor: noEvent,
	onDidChangeTextEditorSelection: noEvent,
	onDidChangeVisibleTextEditors: noEvent,
	onDidChangeWindowState: noEvent,
	onDidChangeActiveTerminal: noEvent,
	onDidOpenTerminal: noEvent,
	onDidStartTerminalShellExecution: terminalEvents.start.event,
	onDidEndTerminalShellExecution: terminalEvents.end.event,
	onDidCloseTerminal: terminalEvents.close.event,
	onDidChangeTerminalShellIntegration: terminalEvents.integration.event,
	registerWebviewViewProvider: noEvent,
	registerTreeDataProvider: noEvent,
	registerUriHandler: noEvent,
	createTreeView: () => ({ selection: [], reveal: async () => undefined, onDidChangeSelection: noEvent, onDidChangeVisibility: noEvent, dispose: () => undefined }),
};

export const commands = {
	/** Each command run, with its arguments, for the test to look at. */
	executed: [] as { command: string; args: unknown[] }[],
	executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
		commands.executed.push({ command, args });
		return undefined;
	},
	registerCommand: noEvent,
	getCommands: async () => [] as string[],
};

export const workspace = {
	workspaceFolders: undefined as unknown,
	getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, update: async () => undefined, inspect: () => undefined }),
	onDidChangeConfiguration: noEvent,
	onDidChangeWorkspaceFolders: noEvent,
	onDidSaveTextDocument: noEvent,
	onDidChangeTextDocument: noEvent,
	onDidOpenTextDocument: noEvent,
	onDidCloseTextDocument: noEvent,
	createFileSystemWatcher: () => ({ onDidChange: noEvent, onDidCreate: noEvent, onDidDelete: noEvent, dispose: () => undefined }),
	openTextDocument: async () => undefined,
	textDocuments: [] as unknown[],
	fs: { readFile: async () => new Uint8Array(), writeFile: async () => undefined, stat: async () => undefined, delete: async () => undefined },
	asRelativePath: (path: string) => path,
	isTrusted: true,
	onDidGrantWorkspaceTrust: noEvent,
};

export const env = {
	language: 'en',
	appName: 'GeminiCode',
	appRoot: '',
	machineId: 'test',
	sessionId: 'test',
	openExternal: async () => true,
	clipboard: { readText: async () => '', writeText: async () => undefined },
};

export const extensions = {
	all: [] as unknown[],
	getExtension: () => undefined,
	onDidChange: noEvent,
};

export const languages = {
	createDiagnosticCollection: () => ({ set: () => undefined, clear: () => undefined, dispose: () => undefined }),
	getDiagnostics: () => [],
	onDidChangeDiagnostics: noEvent,
};

export const authentication = {
	getSession: async () => undefined,
	onDidChangeSessions: noEvent,
};
