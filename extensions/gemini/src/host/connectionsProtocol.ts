/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the Connections page (connectionsPage.ts) and its webview (webview-src/connections.ts).

import type { TeamToolId } from '../acp/teamHttp';
import type { TeamToolStateKind } from '../acp/teamStatus';

export interface ConnectionRowView {
	readonly tool: TeamToolId;
	readonly name: string;
	readonly kind: TeamToolStateKind;
	/** The state in a word or two: Connected, Can't reach, Token refused… */
	readonly label: string;
	/** The line under the name: who is signed in, or what's wrong and what to do. */
	readonly detail: string;
	/** Beside the name: the server and its version, and how GeminiCode reaches the tool. */
	readonly pills: readonly string[];
	/** Under the detail: where the token lives and when it expires, when a token is saved. */
	readonly token?: string;
	/** Whether a token or account is saved (or Snyk or Figma turned on). */
	readonly saved: boolean;
	/** Whether connecting takes a server and token (Jira, GitLab, SonarQube). */
	readonly needsToken: boolean;
	/** The server address saved, else the team default. */
	readonly url?: string;
	/** Whether `url` came from the team's defaults file. */
	readonly urlFromDefaults: boolean;
	readonly email?: string;
	/** Whether a "Create Token" link can open. */
	readonly canCreateToken: boolean;
}

export interface ConnectionsView {
	readonly rows: readonly ConnectionRowView[];
	/** The team's defaults file, as the page names it (with its folder), when one was found. */
	readonly defaultsFile?: string;
	/** A settings file that excludes geminicode-tools or turns MCP off, as the page names it. */
	readonly allowlist?: { readonly file: string; readonly kind: 'excluded' | 'adminOff' };
	/** Jira and GitLab run as MCP servers of the CLI from the repository's own settings: what the file says about each. */
	readonly teamServers?: { readonly file: string; readonly servers: readonly TeamServerView[] };
}

export interface TeamServerView {
	readonly name: string;
	/** The container image or package the file runs, when one can be told. */
	readonly image?: string;
	/** Environment variables the file passes that look like tokens. */
	readonly tokenEnv: readonly string[];
	readonly included?: number;
	readonly excluded?: number;
}

export interface ConnectionsStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly tools: string;
	readonly toolsHint: string;
	readonly checkAll: string;
	/** `{0}` is the settings file, `{1}` the server names. */
	readonly teamServersTitle: string;
	readonly teamServersText: string;
	/** `{0}` the image, `{1}` the token variables. */
	readonly teamServerLine: string;
	/** `{0}` how many tools the file keeps, or leaves out. */
	readonly teamServerIncluded: string;
	readonly teamServerExcluded: string;
	readonly openSettings: string;
	readonly takeOverServers: string;
	readonly defaultsHint: string;
	readonly connect: string;
	readonly replaceToken: string;
	readonly disconnect: string;
	readonly tryAgain: string;
	readonly openFigma: string;
	readonly cancel: string;
	readonly connectTitle: string;
	readonly server: string;
	readonly serverHint: string;
	readonly serverHintDefaults: string;
	readonly serverHintVpn: string;
	readonly email: string;
	readonly emailHint: string;
	readonly token: string;
	readonly tokenHintJira: string;
	readonly tokenHintGitlab: string;
	readonly tokenHintSonar: string;
	readonly createToken: string;
	readonly keychainNote: string;
	readonly checking: string;
	readonly connected: string;
	readonly snykConnectHint: string;
	readonly figmaConnectHint: string;
	readonly permissions: string;
	readonly permissionsHint: string;
	readonly writes: string;
	readonly writesDetail: string;
	readonly confirmWrites: string;
	readonly confirmWritesDetail: string;
	readonly reads: string;
	readonly readsDetail: string;
	readonly askEachTime: string;
	readonly askOnceOnly: string;
	readonly alwaysAllowed: string;
	readonly allowlistExcluded: string;
	readonly allowlistAdminOff: string;
	readonly removeExclusion: string;
	readonly openFile: string;
	readonly close: string;
}

export type ToConnections =
	| { readonly type: 'view'; readonly view: ConnectionsView }
	/** The answer to a `connect`: on success the dialog closes; on failure `message` says why. */
	| { readonly type: 'connectResult'; readonly tool: TeamToolId; readonly ok: boolean; readonly message?: string };

export type FromConnections =
	| { readonly type: 'ready' }
	| { readonly type: 'connect'; readonly tool: TeamToolId; readonly url?: string; readonly email?: string; readonly token?: string }
	| { readonly type: 'disconnect' | 'refresh'; readonly tool: TeamToolId }
	| { readonly type: 'createToken'; readonly tool: TeamToolId; readonly url?: string }
	| { readonly type: 'openFigma' | 'allowlist' | 'openAllowlistFile' | 'openDefaults' | 'checkAll' | 'openTeamServers' | 'takeOverTeamServers' };
