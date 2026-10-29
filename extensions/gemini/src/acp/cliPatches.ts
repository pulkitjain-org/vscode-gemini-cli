/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The one change GeminiCode makes to the Gemini CLI copies it runs. In ACP
// mode, which every GeminiCode agent uses, the CLI runs a tool and hands its
// whole output to the model: the cap its scheduler applies everywhere else
// (`tools.truncateToolOutputThreshold`, 40,000 characters) is skipped. One
// `git diff` of a few megabytes then takes an agent past the model's
// 1,048,576-token limit, and every later turn fails on the same history.
// Checked up to 0.65.0-preview.0.
//
// The patch puts that cap on the ACP path: past the threshold, the output is
// saved where the CLI saves it (`<project temp>/tool-outputs/`) and the model
// gets the CLI's own head-and-tail excerpt with the file's path. It is applied
// to the copy bundled with the app (scripts/bundle-cli.mts), to each copy
// GeminiCode installs (cliInstall.ts) and, at launch, to copies installed
// before it existed. A CLI the user chose (`gemini.cliPath`, PATH) is left as
// it is. A release whose code no longer matches is left unpatched.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Marks a patched file, so a patch is applied once. */
export const cliPatchMarker = '/* GeminiCode patch: acp-output-cap v1 */';

/** The files that hold the ACP agent, beside the CLI's entry point: `gemini-<hash>.js`. */
const patchedFile = /^gemini-[A-Za-z0-9]+\.js$/;

/** Where the ACP session runs a tool the model called (`runTool`), as esbuild writes it. */
const toolCall = [
	'      const toolResult = await invocation.execute({',
	'        abortSignal',
	'      });',
	'      const content = toToolCallContent(toolResult);',
].join('\n');

const cappedToolCall = [
	'      const toolResult = __geminiCodeCapOutput(await invocation.execute({',
	'        abortSignal',
	'      }), this.context.config, fc.name, callId, this.id);',
	'      const content = toToolCallContent(toolResult);',
].join('\n');

/**
 * The cap, as the CLI's own `truncateOutputIfNeeded` and
 * `formatTruncatedToolOutput` do it: the first fifth and the rest from the
 * end, within the threshold the CLI works out from its settings and the
 * context left. Synchronous, since the call site is; any failure returns the
 * output as it was.
 */
const capFunction = `
${cliPatchMarker}
function __geminiCodeCapOutput(result, config, toolName, callId, sessionId) {
	try {
		const limit = typeof config?.getTruncateToolOutputThreshold === "function" ? config.getTruncateToolOutputThreshold() : 4e4;
		if (!result || !(limit > 0)) {
			return result;
		}
		const safe = (value) => String(value).replace(/[^a-zA-Z0-9_.-]/g, "_").toLowerCase();
		const cap = (text, index) => {
			if (typeof text !== "string" || text.length <= limit) {
				return text;
			}
			let saved;
			try {
				const fs = require("node:fs");
				const path = require("node:path");
				let dir = path.join(config.storage.getProjectTempDir(), "tool-outputs");
				if (sessionId) {
					dir = path.join(dir, "session-" + safe(sessionId));
				}
				fs.mkdirSync(dir, { recursive: true });
				saved = path.join(dir, safe(toolName) + "_" + safe(callId) + (index ? "_" + index : "") + ".txt");
				fs.writeFileSync(saved, text);
			} catch {
				saved = undefined;
			}
			const headChars = Math.floor(limit * 0.2);
			const tailChars = limit - headChars;
			const omitted = text.length - headChars - tailChars;
			return "Output too large. Showing first " + headChars.toLocaleString() + " and last " + tailChars.toLocaleString() + " characters. " + (saved ? "For full output see: " + saved : "The full output could not be saved.") + "\\n" + text.slice(0, headChars) + "\\n\\n... [" + omitted.toLocaleString() + " characters omitted] ...\\n\\n" + text.slice(-tailChars);
		};
		const content = result.llmContent;
		if (typeof content === "string") {
			const capped = cap(content, 0);
			return capped === content ? result : { ...result, llmContent: capped };
		}
		if (Array.isArray(content)) {
			let changed = false;
			const parts = content.map((part, index) => {
				if (typeof part === "string") {
					const capped = cap(part, index);
					changed ||= capped !== part;
					return capped;
				}
				if (part && typeof part.text === "string") {
					const capped = cap(part.text, index);
					if (capped !== part.text) {
						changed = true;
						return { ...part, text: capped };
					}
				}
				return part;
			});
			return changed ? { ...result, llmContent: parts } : result;
		}
		if (content && typeof content.text === "string") {
			const capped = cap(content.text, 0);
			return capped === content.text ? result : { ...result, llmContent: { ...content, text: capped } };
		}
		return result;
	} catch {
		return result;
	}
}
`;

/** `source` with tool output capped on the ACP path; undefined when it is patched already or isn't the code this patch knows. */
export function patchAcpToolOutput(source: string): string | undefined {
	if (source.includes(cliPatchMarker)) {
		return undefined;
	}
	const at = source.indexOf(toolCall);
	// Exactly one call site, or the code has changed under the patch.
	if (at < 0 || source.indexOf(toolCall, at + 1) >= 0) {
		return undefined;
	}
	return source.slice(0, at) + cappedToolCall + source.slice(at + toolCall.length) + capFunction;
}

/** Whether `file`, a path inside a CLI package such as `bundle/gemini-Q2GRYIAK.js`, is one the patch may change. */
export function isPatchedCliFile(file: string): boolean {
	return path.basename(path.dirname(file)) === 'bundle' && patchedFile.test(path.basename(file));
}

/** `data`, the content of CLI file `file`, with the patch applied when it holds the ACP agent. */
export function patchCliFile(file: string, data: Buffer): Buffer {
	if (!isPatchedCliFile(file)) {
		return data;
	}
	const patched = patchAcpToolOutput(data.toString('utf8'));
	return patched === undefined ? data : Buffer.from(patched, 'utf8');
}

export type CliPatchResult = 'patched' | 'unchanged' | 'unrecognized';

/**
 * Patches the CLI copy whose `bundle` folder is `bundleDir`, in place. Each
 * file is replaced whole (written beside it, then renamed), so a CLI starting
 * meanwhile reads the old file or the new one. `unchanged` when it is patched
 * already; `unrecognized` when no file holds the code the patch knows.
 */
export async function patchCliBundle(bundleDir: string): Promise<CliPatchResult> {
	const names = (await fs.readdir(bundleDir)).filter(name => patchedFile.test(name));
	let patched = 0;
	let already = 0;
	for (const name of names) {
		const file = path.join(bundleDir, name);
		const source = await fs.readFile(file, 'utf8');
		if (source.includes(cliPatchMarker)) {
			already++;
			continue;
		}
		const next = patchAcpToolOutput(source);
		if (next === undefined) {
			continue;
		}
		const staging = `${file}.${process.pid}.tmp`;
		try {
			await fs.writeFile(staging, next);
			await fs.rename(staging, file);
		} catch (err) {
			await fs.rm(staging, { force: true });
			throw err;
		}
		patched++;
	}
	return patched ? 'patched' : already ? 'unchanged' : 'unrecognized';
}
