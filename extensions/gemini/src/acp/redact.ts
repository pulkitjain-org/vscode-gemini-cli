/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Takes what identifies the user, or lets someone in, out of text that leaves
// the machine: a problem report's log lines, and Debug mode's evidence. Email
// addresses, the account and project the user named, the home folder, and
// anything that looks like a key, token or password. What is left still reads
// as the same log, with each removed thing named by its kind.

export interface RedactOptions {
	/** The user's account name, project id and other words to take out whole. */
	readonly names?: readonly string[];
	/** The home folder, written as `~`. */
	readonly home?: string;
}

const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A header, query or assignment that hands over a credential: `Authorization: Bearer x`, `api_key=x`, `"token": "x"`. */
const credentialPair = /\b(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|cookie|set-cookie)\b(["']?\s*[:=]\s*(?:bearer\s+)?)(["']?)([^\s"',;&]+)\3/gi;
/** A bare key or token: Google API keys, GitLab and GitHub tokens, JWTs, long base64 or hex runs. */
const bareSecret = /\b(?:AIza[0-9A-Za-z_-]{30,}|glpat-[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{30,}|ya29\.[0-9A-Za-z_-]{20,}|eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|[0-9a-f]{40,}|[0-9A-Za-z+/]{48,}={0,2})\b/g;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` with the user's identity and any credential-looking value taken out. */
export function redact(text: string, options: RedactOptions = {}): string {
	let out = text;
	if (options.home) {
		const home = options.home.replace(/[\\/]+$/, '');
		out = out.split(home).join('~');
		// The same folder written with the other separator, as Windows paths come either way.
		const other = home.includes('\\') ? home.replace(/\\/g, '/') : home.replace(/\//g, '\\');
		if (other !== home) {
			out = out.split(other).join('~');
		}
	}
	out = out.replace(credentialPair, (_, key: string, between: string, quote: string) => `${key}${between}${quote}[redacted]${quote}`);
	out = out.replace(email, '[email]');
	out = out.replace(bareSecret, '[redacted]');
	for (const name of (options.names ?? []).filter(name => name.trim().length >= 3)) {
		out = out.replace(new RegExp(escapeRegExp(name), 'gi'), '[name]');
	}
	return out;
}
