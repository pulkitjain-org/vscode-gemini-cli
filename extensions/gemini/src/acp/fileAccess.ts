/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Serves the agent's `fs/read_text_file` and `fs/write_text_file` requests. The
// host supplies the file system (open editors, WorkspaceEdit and save); this
// module applies the access policy and the protocol details. Any error fails
// the tool call with a message the model can read.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AGENT_SETUP_ERROR_CODE } from './errors';

/** The host's view of the workspace files. */
export interface ClientFileSystem {
	/** The file's current text, including unsaved editor changes; `undefined` if it does not exist. */
	readTextFile(filePath: string): Promise<string | undefined>;
	/** Replaces the file's text through the editor and saves it, creating the file if needed. */
	writeTextFile(filePath: string, content: string): Promise<void>;
}

export interface FileAccessPolicyOptions {
	/** Workspace folders; the agent may only touch files inside them. */
	readonly roots: readonly string[];
	/** Whether a path is ignored by git. Ignored files are not readable. */
	readonly isIgnored?: (filePath: string) => Promise<boolean>;
}

export type FileAccessMode = 'read' | 'write';

/** File names that hold secrets. Matched case-insensitively against the base name. */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
	/^\.env$/,
	/^\.env\.(?!example$|sample$|template$|defaults$).+$/,
	/\.(pem|key|p12|pfx|jks|keystore)$/,
	/^id_(rsa|dsa|ecdsa|ed25519)$/,
	/^\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/,
	/^credentials(\.json)?$/,
	// Google Cloud keys and sign-ins, which a Gemini project's repository is likely to hold by mistake.
	/^application_default_credentials\.json$/,
	/service[-_]?account.*\.json$/,
	/^(kubeconfig|\.dockercfg|\.vault-token)$/,
];

/** Directories whose contents are secret or not the agent's to touch. */
const SECRET_DIRECTORIES: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.git', '.kube', '.docker', 'gcloud']);

/** Why a (workspace-relative) path is treated as a secret, or `undefined` if it is not. */
export function secretPathReason(filePath: string): string | undefined {
	const segments = filePath.split(/[\\/]/).filter(Boolean);
	const directory = segments.slice(0, -1).find(segment => SECRET_DIRECTORIES.has(segment.toLowerCase()));
	if (directory) {
		return `files under ${directory} are not shared with the agent`;
	}
	const base = (segments.at(-1) ?? '').toLowerCase();
	return SECRET_FILE_PATTERNS.some(pattern => pattern.test(base)) ? `${segments.at(-1)} may contain secrets` : undefined;
}

/** Whether `filePath` is `root` or inside it. */
export function isInside(root: string, filePath: string): boolean {
	const relative = path.relative(root, filePath);
	// A child named `..foo` is inside; only `..` itself climbs out.
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The reason the agent may not access `filePath`, or `undefined` if it may. */
export async function checkFileAccess(filePath: string, mode: FileAccessMode, options: FileAccessPolicyOptions): Promise<string | undefined> {
	if (!path.isAbsolute(filePath)) {
		return 'the path must be absolute';
	}
	const resolved = path.resolve(filePath);
	const root = options.roots.map(r => path.resolve(r)).find(r => isInside(r, resolved));
	if (!root) {
		return 'the file is outside the workspace';
	}
	// Only the part inside the workspace counts: a workspace may itself live inside a folder such as ~/.aws.
	const secret = secretPathReason(path.relative(root, resolved));
	if (secret) {
		return secret;
	}
	// A symlink in the workspace can point anywhere, such as at ~/.aws/credentials:
	// the file it reaches has to pass the same checks.
	const real = await realPath(resolved);
	const linked = real !== resolved;
	if (linked) {
		const realRoots = await Promise.all(options.roots.map(r => realPath(path.resolve(r))));
		const realRoot = realRoots.find(r => isInside(r, real));
		if (!realRoot) {
			return 'the file is a link to a file outside the workspace';
		}
		const realSecret = secretPathReason(path.relative(realRoot, real));
		if (realSecret) {
			return realSecret;
		}
	}
	// A tracked link to an ignored file reads that file, so the target is checked too.
	if (mode === 'read' && (await options.isIgnored?.(resolved) || (linked && await options.isIgnored?.(real)))) {
		return 'the file is ignored by git';
	}
	return undefined;
}

/**
 * `filePath` with every symlink resolved. For a file that does not exist yet,
 * the nearest folder that does is resolved and the rest appended, so a write
 * through a linked folder is caught too.
 */
async function realPath(filePath: string): Promise<string> {
	let rest = '';
	let current = filePath;
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return rest ? path.join(real, rest) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) {
				return filePath;
			}
			rest = rest ? path.join(path.basename(current), rest) : path.basename(current);
			current = parent;
		}
	}
}

/** Lines `line` (1-based) to `line + limit - 1`, as `fs/read_text_file` defines them. */
export function sliceLines(text: string, line?: number | null, limit?: number | null): string {
	if (!line && !limit) {
		return text;
	}
	const lines = text.split('\n');
	const start = Math.max((line ?? 1) - 1, 0);
	const end = limit ? start + Math.max(limit, 0) : lines.length;
	return lines.slice(start, end).join('\n');
}

/**
 * A refused `fs/*` request. AgentConnection answers the agent with it as a
 * JSON-RPC error of this code; it is not the SDK's own error class, so that
 * this module, which much of the extension imports, does not load the SDK.
 */
export class FileAccessDeniedError extends Error {
	readonly code = AGENT_SETUP_ERROR_CODE;
	constructor(filePath: string, reason: string) {
		super(`Access to ${filePath} was denied: ${reason}.`);
		this.name = 'FileAccessDeniedError';
	}
}

/** The `fs/*` handlers for AgentConnection, with the policy applied. */
export function createFileHandlers(fileSystem: ClientFileSystem, policy: () => FileAccessPolicyOptions) {
	return {
		async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
			const denied = await checkFileAccess(params.path, 'read', policy());
			if (denied) {
				throw new FileAccessDeniedError(params.path, denied);
			}
			const text = await fileSystem.readTextFile(params.path);
			// A missing file reads as empty. ACP says to answer "Resource not
			// found", but gemini-cli (0.62 to 0.64 nightly) rejects with the raw
			// JSON-RPC error object, so its ENOENT check sees "[object Object]"
			// and write_file fails to create any new file. Its read_file tool
			// checks the disk for existence first, so only edit and write_file
			// see the empty text, and both treat it as a new file.
			return { content: sliceLines(text ?? '', params.line, params.limit) };
		},
		async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
			const denied = await checkFileAccess(params.path, 'write', policy());
			if (denied) {
				throw new FileAccessDeniedError(params.path, denied);
			}
			await fileSystem.writeTextFile(params.path, params.content);
			return {};
		},
	};
}
