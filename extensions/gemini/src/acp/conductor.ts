/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Conductor's files, read for a project's coordinator. Conductor
// (gemini-cli-extensions/conductor) keeps a repo's context in `conductor/`:
// product.md, tech-stack.md, workflow.md, and tracks.md listing each track
// ("feature or bug") with a checkbox, whose spec.md and plan.md live in
// `conductor/tracks/<id>/`. The coordinator gets the context and open tracks
// in its wake prompt, and a thread started for a track gets that track's spec
// and plan as its brief. Nothing is written to the repo. Files are cached
// until they change on disk, so a wake costs one stat per file.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ConductorTrack {
	readonly id: string;
	readonly title: string;
	readonly state: 'open' | 'in-progress' | 'done';
}

export interface ConductorContext {
	readonly product?: string;
	readonly techStack?: string;
	readonly tracks: readonly ConductorTrack[];
}

/** The longest any one file is quoted; a wake prompt stays small. */
const maxChars = 6000;

/**
 * Tracks in tracks.md. Conductor writes each as a checkbox line under a
 * heading, with a link to its folder: `- [ ] **Track: Dark mode** ([link](./tracks/dark-mode/))`.
 * `[~]` marks one in progress and `[x]` a finished one.
 */
export function parseTracks(markdown: string): ConductorTrack[] {
	const tracks: ConductorTrack[] = [];
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^\s*(?:[-*]|#+)\s*\[([ xX~])\]\s*(.+)$/.exec(line);
		if (!match) {
			continue;
		}
		const rest = match[2];
		const link = /\]\((?:\.\/)?(?:conductor\/)?tracks\/([^/)]+)\/?[^)]*\)/.exec(rest);
		const title = rest.replace(/\(\[[^\]]*\]\([^)]*\)\)|\[[^\]]*\]\([^)]*\)/g, '').replace(/\*\*/g, '').replace(/^Track:\s*/i, '').trim();
		const id = link?.[1] ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		if (!id || !title) {
			continue;
		}
		const mark = match[1].toLowerCase();
		tracks.push({ id, title, state: mark === 'x' ? 'done' : mark === '~' ? 'in-progress' : 'open' });
	}
	return tracks;
}

/** Reads a repo's Conductor files, cached by modification time. */
export class ConductorReader {

	private readonly cache = new Map<string, { readonly mtimeMs: number; readonly text: string }>();

	constructor(private readonly root: string) { }

	private get folder(): string {
		return path.join(this.root, 'conductor');
	}

	/** The context and tracks, or undefined when the repo has no `conductor/` folder. */
	async read(): Promise<ConductorContext | undefined> {
		const [product, techStack, tracks] = await Promise.all([
			this.file('product.md'),
			this.file('tech-stack.md'),
			this.file('tracks.md'),
		]);
		if (product === undefined && techStack === undefined && tracks === undefined) {
			return undefined;
		}
		return { product, techStack, tracks: tracks ? parseTracks(tracks) : [] };
	}

	/** A track's spec and plan, as a thread's brief. */
	async trackBrief(id: string): Promise<string | undefined> {
		if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) {
			return undefined;
		}
		const [spec, plan] = await Promise.all([this.file(path.join('tracks', id, 'spec.md')), this.file(path.join('tracks', id, 'plan.md'))]);
		if (spec === undefined && plan === undefined) {
			return undefined;
		}
		return [
			`This thread works on the Conductor track "${id}" (conductor/tracks/${id}/).`,
			spec ? `Spec:\n${spec}` : undefined,
			plan ? `Plan (tick each task in conductor/tracks/${id}/plan.md as you finish it):\n${plan}` : undefined,
		].filter(Boolean).join('\n\n');
	}

	private async file(name: string): Promise<string | undefined> {
		const file = path.join(this.folder, name);
		try {
			const stat = await fs.stat(file);
			const cached = this.cache.get(file);
			if (cached?.mtimeMs === stat.mtimeMs) {
				return cached.text;
			}
			const raw = await fs.readFile(file, 'utf8');
			const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[cut at ${maxChars} characters]` : raw;
			this.cache.set(file, { mtimeMs: stat.mtimeMs, text });
			return text;
		} catch {
			this.cache.delete(file);
			return undefined;
		}
	}
}

/** The open tracks and context as a block of the coordinator's wake prompt. */
export function conductorSummary(context: ConductorContext): string {
	const open = context.tracks.filter(track => track.state !== 'done');
	return [
		context.product ? `Product (conductor/product.md):\n${context.product.trim()}` : undefined,
		context.techStack ? `Tech stack (conductor/tech-stack.md):\n${context.techStack.trim()}` : undefined,
		open.length ? `Open tracks (start a thread for one with start_thread and its track id):\n${open.map(track => `- ${track.id}: ${track.title}${track.state === 'in-progress' ? ' (in progress)' : ''}`).join('\n')}` : 'No open tracks.',
	].filter(Boolean).join('\n\n');
}
