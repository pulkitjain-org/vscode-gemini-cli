/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the Audit log page (auditPage.ts) and its webview (webview-src/auditLog.ts).

/** One write: its intent and, when it came, its result, as one row. */
export interface AuditRowView {
	readonly id: string;
	/** "14:31:02" */
	readonly time: string;
	/** "agent · ACME-412 Gift message" or "UI · Open merge request" */
	readonly caller: string;
	/** The tool or flow: `jira_transition`, `openMergeRequest`. */
	readonly tool: string;
	readonly toolKind: 'jira' | 'gitlab' | 'other';
	readonly effect: string;
	/** Who answered, and how: "you · Allow once", "you · button". */
	readonly answered: string;
	/** The id the tool gave back, when the write went through. */
	readonly remote?: string;
	/** done: result recorded; failed: the call failed; open: an intent with no result, from a quit. */
	readonly state: 'done' | 'failed' | 'open';
	readonly error?: string;
}

import type { StorageMessage, StorageStrings, StorageView } from './panelProtocol';

export interface AuditPageView {
	/** The day shown, as YYYY-MM-DD. */
	readonly day: string;
	/** Days with records, newest first. */
	readonly days: readonly string[];
	/** The folder the log lives in, as the user names it. */
	readonly folder: string;
	/** The day's writes, newest first. */
	readonly rows: readonly AuditRowView[];
	/** Intents with no result over the last week. */
	readonly unfinished: number;	/** The Storage section above the log, when the page has the storage host. */
	readonly storage?: StorageView;
}

export interface AuditStrings extends StorageStrings {
	readonly title: string;
	/** The log's heading under the Storage section. */
	readonly auditTitle: string;
	/** `{0}` is the folder. */
	readonly subtitle: string;
	readonly day: string;
	readonly tool: string;
	readonly all: string;
	readonly onlyOpen: string;
	readonly exportDay: string;
	readonly openFolder: string;
	readonly columns: { readonly time: string; readonly caller: string; readonly action: string; readonly effect: string; readonly answered: string; readonly remote: string; readonly state: string };
	readonly done: string;
	readonly failed: string;
	readonly open: string;
	readonly noResult: string;
	readonly markChecked: string;
	readonly nothing: string;
	/** `{0}` is the count. */
	readonly unfinished: string;
}

export type ToAudit = { readonly type: 'view'; readonly view: AuditPageView };

export type FromAudit =
	| { readonly type: 'ready' }
	| { readonly type: 'day'; readonly day: string }
	| { readonly type: 'settle'; readonly id: string }
	| { readonly type: 'export'; readonly day: string }
	| { readonly type: 'openFolder' }
	| StorageMessage;
