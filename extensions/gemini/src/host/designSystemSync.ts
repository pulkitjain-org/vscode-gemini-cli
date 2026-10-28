/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	designSystemChanges, designSystemConfig, type DesignSystemChanges, type DesignSystemConfig, designSystemFiles, type DesignComponent, documentPages,
	isUnchanged, keepRules, pageComponents, readSyncRecord,
} from '../acp/designSystem';
import { errorMessage } from '../acp/errors';
import type { FigmaClient } from '../acp/figma';
import { teamDefaultsFile, type TeamDefaults } from '../acp/teamDefaults';
import { showError } from './errorNotice';

/** What Sync Design System takes from the extension's own bundle: it runs from dist/onDemand.js. */
export interface DesignSystemSyncHost {
	/** Figma's client, when Figma is connected. */
	figma(): FigmaClient | undefined;
	/** The team's defaults of the repository around `folder`, or of the workspace when unset. */
	defaults(folder?: string): Promise<TeamDefaults>;
}

/** The scheme of the read-only documents Review Changes shows the new files in. */
const scheme = 'geminicode-design-system';

/** The entry a team file needs for a design system, which Copy Example puts on the clipboard. */
const example = `"figma": {
  "designSystem": {
    "name": "Acme DS",
    "file": "https://www.figma.com/design/…",
    "pages": ["Foundations", "Components"],
    "tokens": "src/styles/tokens.css"
  }
}`;

/**
 * Sync Design System: reads the design system the team's
 * `.gemini/geminicode-tools.json` names from the Figma desktop app, page by
 * page, and writes its skill, references and tokens file after the user has
 * seen what changes (designSystem.ts builds them).
 */
export class DesignSystemSync implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly proposed = new Map<string, string>();

	constructor(private readonly host: DesignSystemSyncHost, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.designSystem.sync', (folder?: unknown) => this.sync(typeof folder === 'string' ? folder : undefined)),
			vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => this.proposed.get(uri.path) ?? '' }),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async sync(folder: string | undefined): Promise<void> {
		try {
			const defaults = await this.host.defaults(folder);
			const config = designSystemConfig(defaults);
			if (!config) {
				await this.offerSetUp(defaults);
				return;
			}
			const figma = this.host.figma();
			if (!figma?.outline || !figma.variables) {
				const connect = vscode.l10n.t("Open Connections");
				if (await vscode.window.showWarningMessage(vscode.l10n.t("Connect Figma first: Sync Design System reads the design system from the Figma desktop app."), connect) === connect) {
					void vscode.commands.executeCommand('gemini.connections');
				}
				return;
			}
			const read = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Reading {0} in Figma", config.name ?? vscode.l10n.t("the design system")), cancellable: true },
				(progress, token) => this.read(figma, config, progress, token));
			if (!read) {
				return;
			}
			await this.offerWrite(config, read);
		} catch (err) {
			this.log.warn(`Sync Design System failed: ${errorMessage(err)}`);
			void showError(vscode.l10n.t("Couldn't sync the design system: {0}", errorMessage(err)));
		}
	}

	/** Reads the configured pages; undefined when the user cancelled or the open file isn't the design system (both said already). */
	private async read(figma: FigmaClient, config: DesignSystemConfig, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) {
		const { fileName, pages } = documentPages(await figma.outline!('0:0'));
		const wanted = config.pages?.length ? pages.filter(page => config.pages!.some(name => name.toLowerCase() === page.name.toLowerCase())) : pages.filter(page => !page.hidden);
		if (!wanted.length) {
			const missing = config.pages?.join(', ') ?? '';
			void vscode.window.showWarningMessage(config.pages?.length
				? vscode.l10n.t("The file open in Figma, \"{0}\", has no page named {1}. Open {2} in the Figma desktop app, then sync again.", fileName, missing, config.name ?? vscode.l10n.t("the design system"))
				: vscode.l10n.t("The file open in Figma has no pages to read. Open the design system in the Figma desktop app, then sync again."));
			return undefined;
		}
		const tokens = new Map<string, string>();
		const components: DesignComponent[] = [];
		for (const [i, page] of wanted.entries()) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			progress.report({ message: vscode.l10n.t("Page {0} of {1}: {2}", i + 1, wanted.length, page.name), increment: 100 / wanted.length });
			const [outline, variables] = [await figma.outline!(page.id), await figma.variables!(page.id).catch(() => ({}))];
			components.push(...pageComponents(outline, page.name));
			for (const [name, value] of Object.entries(variables)) {
				if (!tokens.has(name)) {
					tokens.set(name, value);
				}
			}
		}
		this.log.info(`Sync Design System: read ${tokens.size} variables and ${components.length} components from ${wanted.length} pages of "${fileName}"`);
		if (!tokens.size && !components.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Figma found no variables or components on {0}. Check that \"{1}\" is the design system, and that its pages use variables.", wanted.map(page => page.name).join(', '), fileName));
			return undefined;
		}
		return { fileName, tokens: [...tokens].map(([name, value]) => ({ name, value })), components };
	}

	private async offerWrite(config: DesignSystemConfig & { readonly root: string }, read: { readonly fileName: string; readonly tokens: readonly { name: string; value: string }[]; readonly components: readonly DesignComponent[] }): Promise<void> {
		const date = new Date().toISOString().slice(0, 10);
		const generated = designSystemFiles(read, config, date);
		const current = new Map<string, string | undefined>();
		for (const relative of Object.keys(generated)) {
			current.set(relative, await fs.readFile(path.join(config.root, relative), 'utf8').catch(() => undefined));
		}
		const skillFile = path.join(config.skill, 'SKILL.md');
		const files = { ...generated, [skillFile]: keepRules(generated[skillFile], current.get(skillFile)) };
		const changes = designSystemChanges(readSyncRecord(current.get(path.join(config.skill, 'references', 'tokens.md'))), read);
		const changed = Object.keys(files).filter(relative => current.get(relative) !== files[relative]);
		const name = config.name || read.fileName;
		// A file that differs only in its date is not a change worth writing.
		if (isUnchanged(changes) && changed.every(relative => current.get(relative)?.replace(/\d{4}-\d{2}-\d{2}/g, '') === files[relative].replace(/\d{4}-\d{2}-\d{2}/g, ''))) {
			void vscode.window.showInformationMessage(vscode.l10n.t("{0} is up to date: {1} tokens and {2} components, as last synced.", name, read.tokens.length, read.components.length));
			return;
		}
		const write = vscode.l10n.t("Write Files");
		const review = vscode.l10n.t("Review Changes");
		for (; ;) {
			const answer = await vscode.window.showInformationMessage(vscode.l10n.t("Sync {0}: {1}", name, describeChanges(changes, read)), {
				modal: true,
				detail: vscode.l10n.t("Writes these files in {0}:\n{1}", path.basename(config.root), changed.map(relative => `${current.get(relative) === undefined ? '+' : '~'} ${relative.split(path.sep).join('/')}`).join('\n')),
			}, write, review);
			if (answer === review) {
				await this.review(config.root, changed, current, files, name);
				continue;
			}
			if (answer === write) {
				for (const relative of changed) {
					const file = path.join(config.root, relative);
					await fs.mkdir(path.dirname(file), { recursive: true });
					await fs.writeFile(file, files[relative]);
				}
				const open = vscode.l10n.t("Open Skill");
				if (await vscode.window.showInformationMessage(vscode.l10n.t("Wrote {0} files for {1}. Commit them so every agent builds with the design system.", changed.length, name), open) === open) {
					void vscode.window.showTextDocument(vscode.Uri.file(path.join(config.root, skillFile)), { viewColumn: vscode.ViewColumn.Active });
				}
			}
			return;
		}
	}

	/** Shows each file's change in one multi-file diff: what is there now against what the sync would write. */
	private async review(root: string, changed: readonly string[], current: ReadonlyMap<string, string | undefined>, files: Readonly<Record<string, string>>, name: string): Promise<void> {
		const resources = changed.map(relative => {
			const before = vscode.Uri.from({ scheme, path: `/before/${relative}` });
			const after = vscode.Uri.from({ scheme, path: `/after/${relative}` });
			this.proposed.set(before.path, current.get(relative) ?? '');
			this.proposed.set(after.path, files[relative]);
			return [vscode.Uri.file(path.join(root, relative)), before, after];
		});
		await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t("Sync {0}", name), resources);
	}

	/** Without a design system in the team's file: says how to add one, and opens the file. */
	private async offerSetUp(defaults: TeamDefaults): Promise<void> {
		const open = vscode.l10n.t("Open Team File");
		const copy = vscode.l10n.t("Copy Example");
		const answer = await vscode.window.showInformationMessage(vscode.l10n.t("No design system is set up. Add figma.designSystem to {0}, naming the Figma file and its pages, then sync.", teamDefaultsFile.split(path.sep).join('/')), copy, ...defaults.file ? [open] : []);
		if (answer === copy) {
			await vscode.env.clipboard.writeText(example);
		} else if (answer === open && defaults.file) {
			void vscode.window.showTextDocument(vscode.Uri.file(defaults.file), { viewColumn: vscode.ViewColumn.Active });
		}
	}
}

/** "4 new tokens, 2 changed, 1 removed; 3 new components", or the totals on a first sync. */
function describeChanges(changes: DesignSystemChanges, read: { readonly tokens: readonly unknown[]; readonly components: readonly unknown[] }): string {
	const parts = [
		changes.addedTokens.length ? vscode.l10n.t("{0} new tokens", changes.addedTokens.length) : undefined,
		changes.changedTokens.length ? vscode.l10n.t("{0} tokens changed", changes.changedTokens.length) : undefined,
		changes.removedTokens.length ? vscode.l10n.t("{0} tokens removed", changes.removedTokens.length) : undefined,
		changes.addedComponents.length ? vscode.l10n.t("{0} new components", changes.addedComponents.length) : undefined,
		changes.removedComponents.length ? vscode.l10n.t("{0} components removed", changes.removedComponents.length) : undefined,
	].filter((part): part is string => !!part);
	return parts.length ? parts.join(', ') : vscode.l10n.t("{0} tokens and {1} components", read.tokens.length, read.components.length);
}
