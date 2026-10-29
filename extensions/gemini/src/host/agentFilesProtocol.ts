/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The messages between an agent's Files page (agentFilesPage.ts) and its
// webview (webview-src/agentFiles.ts).

import type { TreeEntry } from '../acp/agentFiles';

export type { TreeEntry };

/** A file in Recents or the search results. */
export interface FileRow {
	/** Absolute. */
	readonly path: string;
	readonly name: string;
	/** Its folder, relative to the agent's; '' at the top. */
	readonly folder: string;
	readonly icon: string;
}

export interface FilesView {
	/** The agent's folder, the tree's root. */
	readonly root: { readonly name: string; readonly path: string };
	readonly recents: readonly FileRow[];
}

export interface FilesStrings {
	readonly search: string;
	readonly newFile: string;
	readonly recents: string;
	readonly noRecents: string;
	readonly noMatches: string;
	readonly hideTree: string;
	readonly showTree: string;
	readonly closeTree: string;
	readonly tree: string;
	readonly emptyFolder: string;
}

export type FromFiles =
	| { readonly type: 'ready' }
	/** A folder of the tree was opened: list its entries. */
	| { readonly type: 'list'; readonly folder: string; /** It is in an ignored folder, so all of it is ignored. */ readonly ignored?: boolean }
	| { readonly type: 'open'; readonly path: string }
	| { readonly type: 'search'; readonly requestId: number; readonly query: string }
	| { readonly type: 'newFile' }
	/** The tree's close button beside an open file: the page goes, the file takes the space. */
	| { readonly type: 'close' };

export type ToFiles =
	| { readonly type: 'view'; readonly view: FilesView }
	| { readonly type: 'entries'; readonly folder: string; readonly entries: readonly TreeEntry[] }
	| { readonly type: 'found'; readonly requestId: number; readonly files: readonly FileRow[] }
	/** Files were created or deleted in these folders: list them again if open. */
	| { readonly type: 'changed'; readonly folders: readonly string[] };
