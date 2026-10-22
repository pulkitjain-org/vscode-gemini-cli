/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the Index page (webview-src/indexPage.ts) and its host (indexPage.ts).

import type { DocsRefresh, DocsScope } from '../acp/docs/docsProtocol';

export interface IndexPageStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly enable: string;
	readonly off: string;
	readonly workspaces: string;
	readonly workspacesHint: string;
	readonly noWorkspaces: string;
	readonly indexed: string;
	readonly indexing: string;
	readonly paused: string;
	readonly notIndexed: string;
	readonly failed: string;
	readonly untrusted: string;
	readonly readOnly: string;
	readonly rebuild: string;
	readonly indexNow: string;
	readonly pause: string;
	readonly resume: string;
	readonly removeIndex: string;
	readonly skippedFiles: string;
	readonly trust: string;
	readonly reveal: string;
	readonly more: string;
	readonly docs: string;
	/** `{0}` is the folder picker. */
	readonly docsHint: string;
	readonly docsOff: string;
	readonly addDocs: string;
	readonly noDocs: string;
	readonly attach: string;
	readonly refreshSource: string;
	readonly removeSource: string;
	readonly openPage: string;
	readonly fetching: string;
	readonly retry: string;
	readonly suggestions: string;
	/** `{0}` is the manifests, such as package.json. */
	readonly suggestionsHint: string;
	readonly add: string;
	readonly dismiss: string;
	// The Add Docs popup.
	readonly addTitle: string;
	readonly addSubtitle: string;
	readonly address: string;
	readonly addressPlaceholder: string;
	readonly what: string;
	readonly scopePage: string;
	readonly scopePrefix: string;
	readonly scopePrefixHint: string;
	readonly scopeSite: string;
	readonly upTo: string;
	readonly pagesUnit: string;
	readonly refresh: string;
	readonly refreshDefault: string;
	readonly refreshDaily: string;
	readonly refreshWeekly: string;
	readonly refreshManual: string;
	readonly attachTo: string;
	readonly fine: string;
	readonly cancel: string;
	readonly addAndFetch: string;
	readonly close: string;
	// The Files Left Out popup.
	/** `{0}` is the workspace. */
	readonly skippedTitle: string;
	/** `{0}` is how many files. */
	readonly skippedCount: string;
	readonly skippedHint: string;
	readonly skippedFilter: string;
	readonly skippedNone: string;
	readonly skippedLoading: string;
	/** `{0}` is how many files in the group. */
	readonly skippedGroup: string;
	readonly indexAnyway: string;
	readonly indexAllAnyway: string;
	readonly included: string;
	readonly neverIndexed: string;
	/** `{0}` is how many rows are not shown. */
	readonly skippedMore: string;
	readonly tooManyForAll: string;
	readonly openIgnoreFile: string;
	readonly editInclude: string;
}

export interface SkippedFileView {
	readonly path: string;
	readonly reason: string;
	readonly includable: boolean;
}

export type IndexState = 'none' | 'building' | 'paused' | 'ready' | 'failed';

export interface IndexWorkspaceView {
	readonly folder: string;
	readonly name: string;
	readonly state: IndexState;
	/** One line under the name: counts and age, how far a build is, or why it failed. */
	readonly detail: string;
	/** 0 to 1, while building or paused. */
	readonly progress?: number;
	/** The CLI won't load GeminiCode's tools in this folder until it is trusted. */
	readonly untrusted: boolean;
	readonly readOnly: boolean;
	readonly skipped: number;
}

export interface DocsSourceView {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly detail: string;
	readonly attached: boolean;
	readonly fetching: boolean;
	readonly error?: string;
	readonly refresh?: DocsRefresh;
}

export interface DocsSuggestionView {
	readonly title: string;
	readonly url: string;
	readonly library: string;
	readonly version?: string;
}

export interface IndexPageView {
	readonly enabled: boolean;
	readonly workspaces: readonly IndexWorkspaceView[];
	readonly docsEnabled: boolean;
	/** The folder the Docs section shows. */
	readonly docsFolder?: string;
	readonly folders: readonly { readonly folder: string; readonly name: string }[];
	readonly sources: readonly DocsSourceView[];
	readonly suggestions: readonly DocsSuggestionView[];
	readonly manifests: readonly string[];
}

export interface AddDocsRequest {
	readonly url: string;
	readonly scope: DocsScope;
	readonly maxPages: number;
	readonly refresh?: DocsRefresh;
	readonly folders: readonly string[];
}

export type FromIndexPage =
	| { readonly type: 'ready' }
	| { readonly type: 'setEnabled'; readonly enabled: boolean }
	| { readonly type: 'build' | 'rebuild' | 'pause' | 'resume' | 'remove' | 'skipped' | 'trust' | 'reveal'; readonly folder: string }
	| { readonly type: 'docsFolder'; readonly folder: string }
	| { readonly type: 'checkUrl'; readonly url: string }
	| { readonly type: 'addDocs'; readonly request: AddDocsRequest }
	| { readonly type: 'attach'; readonly id: string; readonly attached: boolean }
	| { readonly type: 'refreshSource' | 'removeSource'; readonly id: string }
	| { readonly type: 'setRefresh'; readonly id: string; readonly refresh?: DocsRefresh }
	| { readonly type: 'openUrl'; readonly url: string }
	| { readonly type: 'dismissSuggestion'; readonly url: string }
	| { readonly type: 'include'; readonly folder: string; readonly paths: readonly string[] }
	| { readonly type: 'openIgnoreFile'; readonly folder: string }
	| { readonly type: 'editInclude' };

export type ToIndexPage =
	| { readonly type: 'view'; readonly view: IndexPageView }
	| { readonly type: 'urlProblem'; readonly url: string; readonly problem?: string }
	| { readonly type: 'added' }
	| { readonly type: 'openAdd'; readonly url?: string }
	| { readonly type: 'skippedList'; readonly folder: string; readonly name: string; readonly files: readonly SkippedFileView[] };
