/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team's design system, kept in the repository: the Figma file the team's
// `.gemini/geminicode-tools.json` names is read once (Sync Design System) into
// a skill, its references and an optional tokens file, so agents build every
// Figma design with the team's tokens and components without anyone sharing
// the design system again. Figma's Dev Mode server reads only the file open in
// the desktop app, and `get_variable_defs` returns only the variables a node
// uses, so the sync reads the pages the team names, one at a time. Pure, so
// the files it writes are tested without Figma.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TeamDefaults } from './teamDefaults';

/** `figma.designSystem` in the team's defaults, with the defaults filled in. */
export interface DesignSystemConfig {
	/** What the team calls it, such as "Acme DS"; Figma's file name when unset. */
	readonly name?: string;
	/** The design system's Figma file link. */
	readonly file?: string;
	/** The pages to read, by name, hidden ones too; every visible page when unset. */
	readonly pages?: readonly string[];
	/** The skill's folder, relative to the repository. */
	readonly skill: string;
	/** A CSS file to write the tokens to, relative to the repository; none when unset. */
	readonly tokens?: string;
	/** Whether Figma looks up Code Connect mappings for this repository's designs, over `gemini.figma.codeConnect`. */
	readonly codeConnect?: boolean;
}

export const defaultSkillFolder = path.join('.gemini', 'skills', 'design-system');

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A path inside the repository; undefined when it is absolute or climbs out of it. */
function repoPath(value: unknown): string | undefined {
	const text = str(value)?.replace(/\\/g, '/');
	return text && !path.isAbsolute(text) && !text.split('/').includes('..') ? path.normalize(text) : undefined;
}

/** The design system the team's defaults configure, with the repository its paths are in, or undefined when they name none. */
export function designSystemConfig(defaults: TeamDefaults): (DesignSystemConfig & { readonly root: string }) | undefined {
	const o = defaults.figma?.designSystem;
	if (!o || !defaults.file) {
		return undefined;
	}
	const pages = Array.isArray(o.pages) ? o.pages.flatMap(page => str(page) ? [str(page)!] : []) : [];
	return {
		...str(o.name) ? { name: str(o.name) } : {},
		...str(o.file) ? { file: str(o.file) } : {},
		...pages.length ? { pages } : {},
		skill: repoPath(o.skill) ?? defaultSkillFolder,
		...repoPath(o.tokens) ? { tokens: repoPath(o.tokens) } : {},
		...typeof o.codeConnect === 'boolean' ? { codeConnect: o.codeConnect } : {},
		// The defaults file is <root>/.gemini/geminicode-tools.json.
		root: path.dirname(path.dirname(defaults.file)),
	};
}

/** The note for a prompt with a Figma design in the repository whose defaults are `defaults`; undefined without a design-system skill. */
export async function designSystemNoteFor(defaults: TeamDefaults): Promise<string | undefined> {
	const config = designSystemConfig(defaults);
	const skill = config && await designSystemSkill(config.root, config);
	return skill ? designSystemNote(skill, config.name) : undefined;
}

/** The skill's name as its SKILL.md gives it, when the skill exists in `folder`. */
export async function designSystemSkill(folder: string, config: DesignSystemConfig): Promise<string | undefined> {
	try {
		const text = await fs.readFile(path.join(folder, config.skill, 'SKILL.md'), 'utf8');
		// Only the name is needed, so skills.ts, with the settings editor it carries, stays out of the extension bundle.
		return /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text)?.[1] ?? path.basename(config.skill);
	} catch {
		return undefined;
	}
}

/** The note a prompt with a Figma design carries, so the agent builds it with the team's tokens and components. */
export function designSystemNote(skill: string, name: string | undefined): string {
	return `This project has a design-system skill, "${skill}"${name ? ` (${name})` : ''}. Load it before building this design, and build with its tokens and components: never hard-code a colour, size or font the design system defines, and use the team's component before writing new markup.`;
}

/** One design variable as Figma's Dev Mode server gives it: a name and its value in the mode Figma shows. */
export interface DesignToken {
	readonly name: string;
	readonly value: string;
}

/** A component, or a component set with its variants' properties. */
export interface DesignComponent {
	readonly name: string;
	readonly page: string;
	/** Each variant property with the values its variants use, such as `Size: Small, Large`. */
	readonly properties: readonly { readonly name: string; readonly values: readonly string[] }[];
}

/** What a sync read: the tokens and the components, and the file's name. */
export interface DesignSystemRead {
	readonly fileName: string;
	readonly tokens: readonly DesignToken[];
	readonly components: readonly DesignComponent[];
}

/**
 * The variables in a `get_variable_defs` answer: a JSON object of name to
 * value, which Figma follows with advice for the agent. Undefined when the
 * answer holds no such object.
 */
export function parseVariableDefs(text: string): Record<string, string> | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') {
				i++;
			} else if (c === '"') {
				inString = false;
			}
		} else if (c === '"') {
			inString = true;
		} else if (c === '{') {
			depth++;
		} else if (c === '}' && --depth === 0) {
			try {
				const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return undefined;
				}
				return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => [key, String(value)]));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** A node in a `get_metadata` outline. */
export interface OutlineNode {
	readonly type: string;
	readonly id: string;
	readonly name: string;
	readonly hidden: boolean;
	readonly depth: number;
}

/** The nodes of a `get_metadata` outline, in order, each with its depth from its indentation. */
export function parseOutline(text: string): OutlineNode[] {
	const nodes: OutlineNode[] = [];
	for (const match of text.matchAll(/^(?<indent> *)<(?<type>[\w-]+) id="(?<id>[^"]+)" name="(?<name>[^"]*)"(?<rest>[^>]*)>/gm)) {
		const { indent, type, id, name, rest } = match.groups!;
		nodes.push({ type, id, name: unescapeXml(name), hidden: /\bhidden="true"/.test(rest), depth: indent.length / 2 });
	}
	return nodes;
}

function unescapeXml(text: string): string {
	return text.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The pages of a document outline (`get_metadata` on node 0:0), each saying whether it is hidden. */
export function documentPages(outline: string): { readonly fileName: string; readonly pages: readonly { readonly id: string; readonly name: string; readonly hidden: boolean }[] } {
	const nodes = parseOutline(outline);
	const document = nodes.find(node => node.type === 'document');
	return {
		fileName: document?.name ?? '',
		pages: nodes.filter(node => node.type === 'canvas').map(({ id, name, hidden }) => ({ id, name, hidden })),
	};
}

/** Whether Figma's outline gives `node` as a component; a component set is a frame of them. */
function isComponent(node: OutlineNode): boolean {
	return node.type === 'symbol' || node.type === 'component';
}

/** A variant's properties from its name, such as `Size=Small, State=Hover`; empty for a name that isn't one. */
function variantProperties(name: string): [string, string][] {
	return name.split(',').map(pair => pair.split('=').map(part => part.trim())).filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1]);
}

/**
 * The components on a page's outline. Figma's outline gives a component as a
 * `symbol`, and a component set as a node (a `frame`) whose children are its
 * variants, symbols named by their properties (`Size=Small, State=Hover`): a
 * set is one component with those properties; a component outside a set is
 * one with none.
 */
export function pageComponents(outline: string, page: string): DesignComponent[] {
	const nodes = parseOutline(outline);
	const components: DesignComponent[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const children: OutlineNode[] = [];
		for (let j = i + 1; j < nodes.length && nodes[j].depth > node.depth; j++) {
			if (nodes[j].depth === node.depth + 1) {
				children.push(nodes[j]);
			}
		}
		const variants = isComponent(node) ? [] : children.filter(child => isComponent(child) && variantProperties(child.name).length);
		if (variants.length) {
			const properties = new Map<string, string[]>();
			for (const [key, value] of variants.flatMap(variant => variantProperties(variant.name))) {
				const values = properties.get(key) ?? [];
				if (!values.includes(value)) {
					values.push(value);
				}
				properties.set(key, values);
			}
			components.push({ name: node.name, page, properties: [...properties].map(([name, values]) => ({ name, values })) });
		} else if (isComponent(node) && !variantProperties(node.name).length) {
			components.push({ name: node.name, page, properties: [] });
		}
		// A component's insides are not components of their own; a set's variants were read above.
		if (variants.length || isComponent(node)) {
			while (i + 1 < nodes.length && nodes[i + 1].depth > node.depth) {
				i++;
			}
		}
	}
	return components;
}

/** The files a sync writes, relative to the repository, with their text. */
export interface DesignSystemFiles {
	readonly [relative: string]: string;
}

/** What changed since the last sync, by token and component name. */
export interface DesignSystemChanges {
	readonly addedTokens: readonly string[];
	readonly changedTokens: readonly string[];
	readonly removedTokens: readonly string[];
	readonly addedComponents: readonly string[];
	readonly removedComponents: readonly string[];
}

/** The last sync's tokens and components, kept at the end of tokens.md so the next sync can say what changed. */
interface SyncRecord {
	readonly tokens: Record<string, string>;
	readonly components: readonly string[];
}

const recordStart = '<!-- design-system-sync ';
const recordEnd = ' -->';

/** The record a tokens.md written by a sync ends with, or undefined. */
export function readSyncRecord(tokensMd: string | undefined): SyncRecord | undefined {
	const start = tokensMd?.lastIndexOf(recordStart) ?? -1;
	if (!tokensMd || start < 0) {
		return undefined;
	}
	const end = tokensMd.indexOf(recordEnd, start + recordStart.length);
	try {
		const record = JSON.parse(tokensMd.slice(start + recordStart.length, end < 0 ? undefined : end)) as SyncRecord;
		return record && typeof record.tokens === 'object' && Array.isArray(record.components) ? record : undefined;
	} catch {
		return undefined;
	}
}

/** What changed between the last sync's record and this read. */
export function designSystemChanges(previous: SyncRecord | undefined, read: DesignSystemRead): DesignSystemChanges {
	const before = new Map(Object.entries(previous?.tokens ?? {}));
	const now = new Map(read.tokens.map(token => [token.name, token.value]));
	const components = new Set(read.components.map(component => component.name));
	const beforeComponents = new Set(previous?.components ?? []);
	return {
		addedTokens: [...now.keys()].filter(name => !before.has(name)),
		changedTokens: [...now].filter(([name, value]) => before.has(name) && before.get(name) !== value).map(([name]) => name),
		removedTokens: [...before.keys()].filter(name => !now.has(name)),
		addedComponents: [...components].filter(name => !beforeComponents.has(name)),
		removedComponents: [...beforeComponents].filter(name => !components.has(name)),
	};
}

/** Whether a sync would change nothing. */
export function isUnchanged(changes: DesignSystemChanges): boolean {
	return Object.values(changes).every(list => list.length === 0);
}

/** The tokens' group: the part of the name before its first slash, such as `color` in `color/brand/primary`. */
function groupOf(name: string): string {
	const slash = name.indexOf('/');
	return slash > 0 ? name.slice(0, slash) : 'other';
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A token's name as a CSS custom property: `color/brand/primary` is `--color-brand-primary`. */
export function cssVariableName(name: string): string {
	return `--${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Whether a token's value can be a CSS value as it is: a colour, a number or a length. */
function isCssValue(value: string): boolean {
	return /^#[0-9a-f]{3,8}$/i.test(value) || /^-?\d+(\.\d+)?(px|rem|em|%)?$/.test(value) || /^rgba?\([\d\s.,%]+\)$/i.test(value);
}

/** A token's value in CSS: Figma gives lengths as bare numbers, which a spacing, size or radius token means in pixels. */
function cssValue(name: string, value: string): string {
	return /^-?\d+(\.\d+)?$/.test(value) && /space|spacing|size|radius|gap|padding|margin|width|height|inset|offset|border/i.test(name) && !/weight|line|opacity|z-?index/i.test(name) ? `${value}px` : value;
}

/** The files a sync of `read` writes, for `config`, on `date` (YYYY-MM-DD). */
export function designSystemFiles(read: DesignSystemRead, config: DesignSystemConfig, date: string): DesignSystemFiles {
	const name = config.name || read.fileName || 'the design system';
	const skillName = path.basename(config.skill);
	const tokens = [...read.tokens].sort((a, b) => a.name.localeCompare(b.name));
	const components = [...read.components].sort((a, b) => a.name.localeCompare(b.name));
	const groups = [...new Set(tokens.map(token => groupOf(token.name)))];
	const record: SyncRecord = { tokens: Object.fromEntries(tokens.map(token => [token.name, token.value])), components: components.map(component => component.name) };
	const css = config.tokens ? tokens.filter(token => isCssValue(token.value)) : [];
	const skill = [
		'---',
		`name: ${skillName}`,
		`description: The ${name} design system: its tokens (colours, type, spacing, radii) and components. Use it for any UI work, and before building a Figma design.`,
		'---',
		'',
		`# ${name}`,
		'',
		`Synced from Figma on ${date}${config.file ? ` (${config.file})` : ''} by GeminiCode's Sync Design System. Sync again rather than editing the references by hand; edit this file's rules freely, a sync keeps them.`,
		'',
		'## Rules',
		'',
		'- Use a token for every colour, font, size, spacing and radius the design system defines. Never hard-code its value.',
		...config.tokens ? [`- The tokens are CSS custom properties in \`${config.tokens.split(path.sep).join('/')}\`: write \`var(--color-brand-primary)\`, not the colour.`] : [],
		'- Build with the components below before writing new markup. Match a Figma component to the code component of the same name.',
		'- When a design uses a value with no token, say so in your reply instead of inventing one.',
		'',
		'## References',
		'',
		`- [references/tokens.md](references/tokens.md): ${tokens.length} tokens${groups.length ? ` (${groups.join(', ')})` : ''}. Read it when you need a token's name or value.`,
		`- [references/components.md](references/components.md): ${components.length} components with their variants. Read it before building UI.`,
		'',
	].join('\n');
	const tokensMd = [
		`# ${name}: tokens`,
		'',
		`${tokens.length} tokens, synced from Figma on ${date}. Values are those of the mode Figma showed.`,
		'',
		...groups.flatMap(group => [
			`## ${group}`,
			'',
			config.tokens ? '| Token | Value | CSS |' : '| Token | Value |',
			config.tokens ? '| --- | --- | --- |' : '| --- | --- |',
			...tokens.filter(token => groupOf(token.name) === group).map(token => config.tokens
				? `| \`${cell(token.name)}\` | ${cell(token.value)} | ${isCssValue(token.value) ? `\`${cssVariableName(token.name)}\`` : ''} |`
				: `| \`${cell(token.name)}\` | ${cell(token.value)} |`),
			'',
		]),
		`${recordStart}${JSON.stringify(record)}${recordEnd}`,
		'',
	].join('\n');
	const componentsMd = [
		`# ${name}: components`,
		'',
		`${components.length} components, synced from Figma on ${date}.`,
		'',
		'| Component | Variants | Page |',
		'| --- | --- | --- |',
		...components.map(component => `| ${cell(component.name)} | ${cell(component.properties.map(p => `${p.name}: ${p.values.join(', ')}`).join('; ')) || '-'} | ${cell(component.page)} |`),
		'',
	].join('\n');
	const files: Record<string, string> = {
		[path.join(config.skill, 'SKILL.md')]: skill,
		[path.join(config.skill, 'references', 'tokens.md')]: tokensMd,
		[path.join(config.skill, 'references', 'components.md')]: componentsMd,
	};
	if (config.tokens) {
		files[config.tokens] = [
			`/* ${name} tokens, synced from Figma on ${date} by GeminiCode's Sync Design System. Sync again rather than editing. */`,
			':root {',
			...css.map(token => `\t${cssVariableName(token.name)}: ${cssValue(token.name, token.value)};`),
			'}',
			'',
		].join('\n');
	}
	return files;
}

/**
 * A SKILL.md for a sync to write, keeping the rules a team wrote: when the
 * existing file has a `## Rules` section, it replaces the generated one.
 */
export function keepRules(generated: string, existing: string | undefined): string {
	const rules = (text: string) => /^## Rules\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(text)?.[0];
	const kept = existing && rules(existing);
	const fresh = rules(generated);
	return kept && fresh ? generated.replace(fresh, kept.endsWith('\n') ? kept : `${kept}\n`) : generated;
}

/** A hex colour or length in Figma's answers, matched against the tokens, for annotating design reads. */
export type TokenIndex = ReadonlyMap<string, string>;

/** The tokens of a tokens.md written by a sync, by value (lowercased), for annotating Figma's answers; empty when none. */
export function tokenIndex(tokensMd: string | undefined): TokenIndex {
	const record = readSyncRecord(tokensMd);
	const index = new Map<string, string>();
	for (const [name, value] of Object.entries(record?.tokens ?? {})) {
		const key = value.trim().toLowerCase();
		// Only colours are distinct enough to match by value: 8px is too many things.
		if (/^#[0-9a-f]{3,8}$/.test(key) && !index.has(key)) {
			index.set(key, name);
		}
	}
	return index;
}

/** `text` with each hex colour that is a token followed by the token's name, such as `#2F5BD3 (color/brand/primary)`. */
export function annotateTokens(text: string, index: TokenIndex): string {
	if (!index.size) {
		return text;
	}
	return text.replace(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (hex, offset: number, whole: string) => {
		const name = index.get(hex.toLowerCase());
		// Already annotated, or a token's own name next to it: left as it is.
		return name && !whole.startsWith(` (${name})`, offset + hex.length) ? `${hex} (${name})` : hex;
	});
}
