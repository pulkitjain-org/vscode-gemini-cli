/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliExtension, isExtensionSource, parseExtensionList, parseMemoryList, runCliCommands } from '../acp/cliCommands';
import { CliPreference, defaultKeepChats, isKeepChats, keepChatsChoices, keepChatsForever, readCliPreferences, setCliPreference } from '../acp/cliPreferences';
import { geminiDir } from '../acp/directRequest';
import { appendMemory } from '../acp/memory';
import { errorMessage } from '../acp/errors';
import { addHook, disabledHooks, HookEvent, hookEvents, hooksIn, setHookEnabled, toolEvents } from '../acp/hooks';
import { addMcpServer, disabledServers, isServerEnabled, mcpServersIn, readSettingsFile, rulesFileNames, serverConfigFrom, setServerEnabled } from '../acp/projectSettings';
import { disabledSkills, loadSkills, setSkillEnabled, skillFolders, skillSlug, skillTemplate } from '../acp/skills';
import { AgentService } from './agentService';
import { getAgentCommand, getWorkspaceCwd } from './configuration';
import { tildify } from './displayText';
import { CliReport, ExtensionView, FromSettingsPage, HookView, McpServerView, MemoryFileView, PreferencesView, RulesFileView, SettingsPageStrings, SettingsPageView, SkillView, ToSettingsPage } from './panelProtocol';
import { forgetSkills } from './teamCommands';
import { createNonce, escapeAttribute } from './webviewHtml';

const viewType = 'gemini.projectSettings';

/**
 * Project Helpers: what every Gemini agent loads when it starts. MCP servers,
 * skills, hooks and rules come from the Gemini CLI's own files, which the page
 * edits so the terminal CLI sees the same. Extensions and memory come from the
 * CLI itself (/extensions list, /memory list), asked in one hidden session when
 * the agent is already running (on open, when it starts, after a change) or when
 * the user presses Refresh, which starts it. Files are read when the page is
 * shown and after each change.
 */
export class SettingsPage implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	/** The files the page shows; the only ones it may open or create. */
	private files = new Set<string>();
	/** The extension and memory lists the CLI last reported. */
	private extensions: CliReport<ExtensionView> = { state: 'loading' };
	private memory: CliReport<MemoryFileView> = { state: 'loading' };
	/** Counts CLI refreshes, so an older answer never replaces a newer one. */
	private cliGeneration = 0;
	private terminal: vscode.Terminal | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly service: AgentService) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.projectSettings', () => this.show()),
			vscode.commands.registerCommand('gemini.newSkill', () => this.newSkill()),
			service.onDidChangeMcpProblems(() => void this.update()),
			// The CLI could not be asked while the agent was not running; ask now.
			service.runtime.onDidChangeState(state => state.kind === 'ready' && this.panel && void this.refreshCli()),
			vscode.window.onDidCloseTerminal(terminal => {
				if (terminal === this.terminal) {
					// An install, update or removal finished.
					this.terminal = undefined;
					void this.refreshCli();
				}
			}),
		);
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(viewType, vscode.l10n.t("Project Helpers"), vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [media],
		});
		panel.iconPath = new vscode.ThemeIcon('server-environment');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromSettingsPage) => this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.active && void this.update());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
		void this.refreshCli();
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async update(): Promise<void> {
		const panel = this.panel;
		if (!panel?.visible) {
			return;
		}
		const view = await this.build();
		if (this.panel !== panel) {
			return;
		}
		this.files = new Set([
			...view.servers.map(s => s.file), ...view.rules.map(r => r.path), ...view.skills.flatMap(s => [s.file, s.settingsFile]), ...view.hooks.map(h => h.file),
			...view.memory.state === 'ready' ? view.memory.items.map(m => m.path) : [],
		]);
		void panel.webview.postMessage({ type: 'view', view } satisfies ToSettingsPage);
	}

	/**
	 * Asks the CLI for its extensions and memory files, then shows them. Only
	 * when the agent is running, unless `start` (the user pressed Refresh): the
	 * page alone never starts the CLI.
	 */
	private async refreshCli(start = false): Promise<void> {
		const generation = ++this.cliGeneration;
		if (!start && this.service.runtime.state.kind !== 'ready') {
			const message = vscode.l10n.t("The agent is not running. Press Refresh to start it and ask the Gemini CLI.");
			this.extensions = { state: 'unavailable', message };
			this.memory = { state: 'unavailable', message };
			await this.update();
			return;
		}
		this.extensions = { state: 'loading' };
		this.memory = { state: 'loading' };
		void this.update();
		let extensions: CliReport<ExtensionView>;
		let memory: CliReport<MemoryFileView>;
		try {
			if (start) {
				await this.service.ensureReady();
			}
			const [extensionsReply, memoryReply] = await runCliCommands(this.service.runtime, getWorkspaceCwd(), ['/extensions list', '/memory list']);
			extensions = extensionsReply === undefined ? notOffered('/extensions') : { state: 'ready', items: parseExtensionList(extensionsReply).map(extensionView) };
			memory = memoryReply === undefined ? notOffered('/memory') : { state: 'ready', items: await Promise.all(parseMemoryList(memoryReply).map(memoryView)) };
		} catch (err) {
			const message = vscode.l10n.t("The Gemini CLI did not answer: {0}", errorMessage(err));
			extensions = { state: 'unavailable', message };
			memory = { state: 'unavailable', message };
		}
		if (generation !== this.cliGeneration) {
			return;
		}
		this.extensions = extensions;
		this.memory = memory;
		await this.update();
	}

	private personalSettings(): string {
		return path.join(geminiDir(), 'settings.json');
	}

	private async build(): Promise<SettingsPageView> {
		const dir = geminiDir();
		const personal = await readSettingsFile(this.personalSettings());
		const folders = vscode.workspace.workspaceFolders ?? [];
		const projects = await Promise.all(folders.map(async folder => {
			const file = path.join(folder.uri.fsPath, '.gemini', 'settings.json');
			return { folder, file, settings: await readSettingsFile(file) };
		}));
		const disabled = await disabledServers(path.join(dir, 'mcp-server-enablement.json'));
		const problems = new Map(this.service.mcpProblems.filter(p => p.server).map(p => [p.server!, p.message]));
		const servers: McpServerView[] = [];
		const seen = new Set<string>();
		// A project's server of the same name replaces the personal one, as in the CLI.
		for (const { folder, file, settings } of projects) {
			for (const server of mcpServersIn(settings, file)) {
				seen.add(server.name);
				servers.push(this.serverView(server, folder.name, disabled, problems));
			}
		}
		for (const server of mcpServersIn(personal, this.personalSettings())) {
			if (!seen.has(server.name)) {
				servers.push(this.serverView(server, vscode.l10n.t("Personal"), disabled, problems));
			}
		}

		const personalLabel = vscode.l10n.t("Personal");
		const home = path.dirname(dir);
		// skills.disabled is merged across files like hooksConfig.disabled; see the toggleSkill message.
		const skillsOff = disabledSkills(personal);
		const skills: SkillView[] = (await loadSkills(skillFolders(undefined, home))).map(s => ({
			name: s.name, description: s.description, scope: personalLabel, file: s.file, enabled: !skillsOff.has(s.name.toLowerCase()), settingsFile: this.personalSettings(),
		}));
		// The CLI loads a project's skills only in a trusted folder.
		for (const { folder, file, settings } of vscode.workspace.isTrusted ? projects : []) {
			const off = new Set([...skillsOff, ...disabledSkills(settings)]);
			const project = await loadSkills(skillFolders(folder.uri.fsPath, home).filter(f => !f.personal));
			skills.push(...project.map(s => ({ name: s.name, description: s.description, scope: folder.name, file: s.file, enabled: !off.has(s.name.toLowerCase()), settingsFile: file })));
		}

		// hooksConfig.disabled is merged across files, so a hook off in either is off;
		// switching one on removes it from both lists (see the toggleHook message).
		const personalOff = disabledHooks(personal);
		const hooks: HookView[] = hooksIn(personal, this.personalSettings(), personalOff).map(h => ({ ...h, scope: personalLabel }));
		for (const { folder, file, settings } of projects) {
			const off = new Set([...personalOff, ...disabledHooks(settings)]);
			hooks.push(...hooksIn(settings, file, off).map(h => ({ ...h, scope: folder.name })));
		}

		const rules: RulesFileView[] = [];
		for (const { folder, settings } of projects) {
			const name = plainFileName(rulesFileNames({ ...personal, ...settings })[0]);
			const file = path.join(folder.uri.fsPath, name);
			rules.push(await rulesView(folders.length > 1 ? vscode.l10n.t("Project rules ({0})", folder.name) : vscode.l10n.t("Project rules"), file, name));
		}
		const personalRules = path.join(dir, plainFileName(rulesFileNames(personal)[0]));
		rules.push(await rulesView(vscode.l10n.t("Personal rules"), personalRules, tildify(personalRules)));
		return { servers, skills, hooks, extensions: this.extensions, memory: this.memory, rules, preferences: this.preferencesView(personal) };
	}

	private preferencesView(personal: Record<string, unknown>): PreferencesView {
		const preferences = readCliPreferences(personal);
		const labels: Record<string, string> = {
			'7d': vscode.l10n.t("7 days"),
			'30d': vscode.l10n.t("30 days"),
			'90d': vscode.l10n.t("90 days"),
			[keepChatsForever]: vscode.l10n.t("Until I delete them"),
		};
		const values = keepChatsChoices.includes(preferences.keepChats) ? keepChatsChoices : [...keepChatsChoices, preferences.keepChats];
		return {
			...preferences,
			keepChatsChoices: values.map(value => ({ value, label: value === defaultKeepChats ? vscode.l10n.t("{0} (default)", labels[value]) : labels[value] ?? value })),
			display: tildify(this.personalSettings()),
		};
	}

	private serverView(server: ReturnType<typeof mcpServersIn>[number], scope: string, disabled: ReadonlySet<string>, problems: ReadonlyMap<string, string>): McpServerView {
		const enabled = isServerEnabled(disabled, server.name);
		const problem = enabled ? problems.get(server.name) : undefined;
		return { ...server, scope, enabled, ...(problem ? { problem } : {}) };
	}

	private async onMessage(message: FromSettingsPage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					break;
				case 'restart':
					this.service.restart();
					return;
				case 'toggle':
					await setServerEnabled(path.join(geminiDir(), 'mcp-server-enablement.json'), message.name, message.enabled);
					this.offerRestart(message.enabled
						? vscode.l10n.t("\"{0}\" is on for new agents.", message.name)
						: vscode.l10n.t("\"{0}\" is off for new agents.", message.name));
					break;
				case 'addServer':
					await this.addServer();
					break;
				case 'newSkill':
					await this.newSkill();
					break;
				case 'addHook':
					await this.addHook();
					break;
				case 'toggleHook':
					if (!this.files.has(message.file)) {
						return;
					}
					if (!await setHookEnabled(message.file, message.name, message.enabled)) {
						await this.cannotRewrite(message.file, '"hooksConfig"');
					} else if (message.enabled && message.file !== this.personalSettings()) {
						// The CLI merges the disabled lists, so a project hook the personal list switches off stays off until it leaves that list too.
						const personal = this.personalSettings();
						if (disabledHooks(await readSettingsFile(personal)).has(message.name) && !await setHookEnabled(personal, message.name, true)) {
							await this.cannotRewrite(personal, '"hooksConfig"');
						}
					}
					break;
				case 'toggleSkill':
					if (!this.files.has(message.file)) {
						return;
					}
					await this.toggleSkill(message.file, message.name, message.enabled);
					break;
				case 'signIn':
					await this.signIn(message.name);
					return;
				case 'setPreference':
					await this.setPreference(message.key, message.value);
					break;
				case 'installExtension':
					await this.installExtension();
					return;
				case 'extension':
					if (!isExtensionAction(message.action)) {
						return;
					}
					await this.extensionAction(message.action, message.name);
					return;
				case 'addMemory':
					await this.addMemory();
					return;
				case 'refreshMemory':
					await this.refreshCli(true);
					return;
				case 'openFile':
					if (!this.files.has(message.path)) {
						return;
					}
					await openAt(message.path, message.server ? `"${message.server}"` : message.needle);
					return;
				case 'createRules':
					if (!this.files.has(message.path)) {
						return;
					}
					await fs.mkdir(path.dirname(message.path), { recursive: true });
					await fs.writeFile(message.path, `# ${vscode.l10n.t("Rules for Gemini")}\n\n`, { flag: 'wx' }).catch(() => undefined);
					await openAt(message.path);
					break;
			}
		} catch (err) {
			void vscode.window.showErrorMessage(errorMessage(err));
		}
		await this.update();
	}

	private async addServer(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t("Add MCP Server (1/2)"),
			prompt: vscode.l10n.t("A short name for the server"),
			placeHolder: 'github',
			validateInput: value => /^[\w.-]+$/.test(value.trim()) ? undefined : vscode.l10n.t("Use letters, numbers, dots, dashes and underscores."),
		});
		if (!name) {
			return;
		}
		const target = await vscode.window.showInputBox({
			title: vscode.l10n.t("Add MCP Server (2/2)"),
			prompt: vscode.l10n.t("The command that starts the server, or its URL"),
			placeHolder: 'npx -y @modelcontextprotocol/server-github',
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a command or a URL."),
		});
		if (!target) {
			return;
		}
		const file = this.personalSettings();
		if (await addMcpServer(file, name.trim(), serverConfigFrom(target))) {
			this.offerRestart(vscode.l10n.t("Added \"{0}\". New agents can use its tools.", name.trim()));
		} else {
			await this.cannotRewrite(file, '"mcpServers"');
		}
	}

	/** Where to put a new skill, hook or memory: a project folder, or the user's own. */
	private async pickScope(title: string, personalDetail: string, projectDetail: (folder: string) => string): Promise<{ readonly folder?: string } | undefined> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const items = [
			...folders.map(f => ({ label: f.name, description: vscode.l10n.t("Project"), detail: projectDetail(f.uri.fsPath), folder: f.uri.fsPath as string | undefined })),
			{ label: vscode.l10n.t("Personal"), description: '', detail: personalDetail, folder: undefined },
		];
		const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title, placeHolder: vscode.l10n.t("Who it is for") });
		return pick ? { folder: pick.folder } : undefined;
	}

	/** New Skill: a folder with a SKILL.md from a template, opened to fill in. */
	private async newSkill(): Promise<void> {
		const title = vscode.l10n.t("New Skill");
		const scope = await this.pickScope(title, tildify(path.join(geminiDir(), 'skills')), folder => path.join(path.basename(folder), '.gemini', 'skills'));
		if (!scope) {
			return;
		}
		const base = scope.folder ? path.join(scope.folder, '.gemini', 'skills') : path.join(geminiDir(), 'skills');
		const name = await vscode.window.showInputBox({
			title: `${title} (1/2)`,
			prompt: vscode.l10n.t("A short name, such as release-notes or db-migrations"),
			validateInput: async value => {
				const slug = skillSlug(value);
				if (!slug) {
					return vscode.l10n.t("Use letters and numbers.");
				}
				return await fs.access(path.join(base, slug)).then(() => vscode.l10n.t("{0} already exists.", slug), () => undefined);
			},
		});
		if (!name) {
			return;
		}
		const description = await vscode.window.showInputBox({
			title: `${title} (2/2)`,
			prompt: vscode.l10n.t("When Gemini should use it, in one sentence; Gemini reads this to decide"),
			placeHolder: vscode.l10n.t("Use when writing a database migration for this project."),
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Say when to use it."),
		});
		if (!description) {
			return;
		}
		const slug = skillSlug(name);
		const file = path.join(base, slug, 'SKILL.md');
		await fs.mkdir(path.dirname(file), { recursive: true });
		try {
			await fs.writeFile(file, skillTemplate(slug, description), { flag: 'wx' });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
			// Made since the name was checked, perhaps in another window: open it rather than overwrite it.
			void vscode.window.showWarningMessage(vscode.l10n.t("The \"{0}\" skill already exists.", slug));
			await openAt(file);
			return;
		}
		await openAt(file, '## When to use');
		this.offerRestart(vscode.l10n.t("Created the \"{0}\" skill. New agents can use it; it is also in the / menu.", slug));
		await this.update();
	}

	private async addHook(): Promise<void> {
		const title = vscode.l10n.t("Add Hook");
		const descriptions: Record<HookEvent, string> = {
			SessionStart: vscode.l10n.t("When an agent starts"),
			BeforeAgent: vscode.l10n.t("After you send a prompt, before Gemini works on it"),
			BeforeModel: vscode.l10n.t("Before each request to the model"),
			AfterModel: vscode.l10n.t("After each reply from the model"),
			BeforeToolSelection: vscode.l10n.t("Before the model picks its tools"),
			BeforeTool: vscode.l10n.t("Before a tool runs; can block it"),
			AfterTool: vscode.l10n.t("After a tool runs, such as formatting an edited file"),
			Notification: vscode.l10n.t("When the agent needs your attention"),
			AfterAgent: vscode.l10n.t("When a turn ends"),
			PreCompress: vscode.l10n.t("Before the conversation is summarised"),
			SessionEnd: vscode.l10n.t("When an agent stops"),
		};
		const event = await vscode.window.showQuickPick(hookEvents.map(e => ({ label: e, description: descriptions[e] })), { title: `${title} (1/3)`, placeHolder: vscode.l10n.t("When it runs") });
		if (!event) {
			return;
		}
		let matcher: string | undefined;
		if (toolEvents.has(event.label)) {
			matcher = await vscode.window.showInputBox({
				title: `${title} (2/3)`,
				prompt: vscode.l10n.t("Which tools it runs for, as a regular expression of tool names; empty for every tool"),
				placeHolder: 'write_file|replace',
				validateInput: value => {
					try {
						new RegExp(value);
						return undefined;
					} catch {
						return vscode.l10n.t("This is not a valid regular expression.");
					}
				},
			});
			if (matcher === undefined) {
				return;
			}
		}
		const command = await vscode.window.showInputBox({
			title: `${title} (3/3)`,
			prompt: vscode.l10n.t("The shell command to run. It gets the event as JSON on standard input."),
			placeHolder: 'npx prettier --write .',
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a command."),
		});
		if (!command) {
			return;
		}
		const scope = await this.pickScope(title, tildify(this.personalSettings()), folder => path.join(path.basename(folder), '.gemini', 'settings.json'));
		if (!scope) {
			return;
		}
		const file = scope.folder ? path.join(scope.folder, '.gemini', 'settings.json') : this.personalSettings();
		if (await addHook(file, event.label as HookEvent, command.trim(), matcher?.trim() || undefined)) {
			this.offerRestart(vscode.l10n.t("Added a {0} hook. It runs in new agents.", event.label));
		} else {
			await this.cannotRewrite(file, '"hooks"');
		}
	}

	/** Switches a skill on or off in the settings file of its scope. */
	private async toggleSkill(file: string, name: string, enabled: boolean): Promise<void> {
		if (!await setSkillEnabled(file, name, enabled)) {
			await this.cannotRewrite(file, '"skills"');
			return;
		}
		if (enabled && file !== this.personalSettings()) {
			// The CLI merges the disabled lists, so a project skill the personal list switches off stays off until it leaves that list too.
			const personal = this.personalSettings();
			if (disabledSkills(await readSettingsFile(personal)).has(name.toLowerCase()) && !await setSkillEnabled(personal, name, true)) {
				await this.cannotRewrite(personal, '"skills"');
				return;
			}
		}
		forgetSkills();
		this.offerRestart(enabled
			? vscode.l10n.t("\"{0}\" is on for new agents.", name)
			: vscode.l10n.t("\"{0}\" is off for new agents.", name));
	}

	/**
	 * Signs in to a remote MCP server with the CLI's own /mcp auth, in a
	 * terminal: over ACP the CLI cannot open the browser flow, and it keeps the
	 * tokens where every agent reads them.
	 */
	private async signIn(name: string): Promise<void> {
		const view = await this.build();
		const server = view.servers.find(s => s.name === name);
		if (!server || server.transport === 'stdio' || !/^[\w.-]+$/.test(name)) {
			return;
		}
		this.runInTerminal(vscode.l10n.t("Sign In to {0}", name), ['-i', `/mcp auth ${name}`],
			vscode.l10n.t("Finish signing in to \"{0}\" in your browser, then type /quit here. Restart the agent to use the server.", name));
	}

	private async setPreference(key: CliPreference, value: unknown): Promise<void> {
		const file = this.personalSettings();
		let written: boolean;
		if (key === 'keepChats') {
			if (typeof value !== 'string' || !isKeepChats(value)) {
				return;
			}
			written = await setCliPreference(file, key, value);
		} else if ((key === 'permanentApproval' || key === 'planRouting' || key === 'usageStatistics') && typeof value === 'boolean') {
			written = await setCliPreference(file, key, value);
		} else {
			return;
		}
		if (!written) {
			await this.cannotRewrite(file, key === 'keepChats' ? '"general"' : key === 'permanentApproval' ? '"security"' : key === 'planRouting' ? '"general"' : '"privacy"');
			return;
		}
		this.offerRestart(vscode.l10n.t("Saved to {0}. New agents use it.", tildify(file)));
	}

	/** Install runs the CLI's own installer in a terminal, where it shows its security warning and asks before installing. */
	private async installExtension(): Promise<void> {
		const source = await vscode.window.showInputBox({
			title: vscode.l10n.t("Install Gemini CLI Extension"),
			prompt: vscode.l10n.t("A GitHub repository URL or a local folder. Browse extensions at geminicli.com/extensions."),
			placeHolder: 'https://github.com/gemini-cli-extensions/security',
			validateInput: value => isExtensionSource(value) ? undefined : vscode.l10n.t("Enter a URL or a path, without spaces or quotes."),
		});
		if (source) {
			this.runInTerminal(vscode.l10n.t("Install Extension"), ['extensions', 'install', source.trim()]);
		}
	}

	private async extensionAction(action: 'enable' | 'disable' | 'update' | 'uninstall', name: string): Promise<void> {
		if (!/^[\w.@-]+$/.test(name)) {
			return;
		}
		if (action === 'update' || action === 'uninstall') {
			// These can ask questions (consent, settings), which only a terminal can answer.
			this.runInTerminal(action === 'update' ? vscode.l10n.t("Update Extension") : vscode.l10n.t("Uninstall Extension"), ['extensions', action, name]);
			return;
		}
		await this.service.ensureReady();
		const [reply] = await runCliCommands(this.service.runtime, getWorkspaceCwd(), [`/extensions ${action} ${name}`]);
		if (reply === undefined) {
			throw new Error(vscode.l10n.t("This Gemini CLI has no {0} command.", '/extensions'));
		}
		await this.refreshCli();
		this.offerRestart(reply.trim() || name);
	}

	private runInTerminal(name: string, args: readonly string[], message = vscode.l10n.t("Answer the Gemini CLI's questions here. Project Helpers updates when it finishes; restart the agent to use the change.")): void {
		this.terminal?.dispose();
		const command = getAgentCommand({ subcommand: args });
		this.terminal = vscode.window.createTerminal({
			name: vscode.l10n.t("Gemini: {0}", name),
			shellPath: command.shell ? 'cmd.exe' : command.command,
			shellArgs: command.shell ? ['/c', command.command, ...command.args] : [...command.args],
			env: command.env as Record<string, string>,
			cwd: getWorkspaceCwd(),
			message,
		});
		this.terminal.show();
	}

	/** Add Memory: a line in a GEMINI.md file, which every new agent reads. */
	private async addMemory(): Promise<void> {
		const text = await vscode.window.showInputBox({
			title: vscode.l10n.t("Add Memory"),
			prompt: vscode.l10n.t("Something Gemini should always remember, such as \"Use pnpm, not npm\""),
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter what to remember."),
		});
		if (!text) {
			return;
		}
		const personal = await readSettingsFile(this.personalSettings());
		const scope = await this.pickScope(vscode.l10n.t("Add Memory"), tildify(path.join(geminiDir(), plainFileName(rulesFileNames(personal)[0]))), folder => path.join(path.basename(folder), plainFileName(rulesFileNames(personal)[0])));
		if (!scope) {
			return;
		}
		const file = path.join(scope.folder ?? geminiDir(), plainFileName(rulesFileNames(personal)[0]));
		await appendMemory(file, text.trim());
		await this.refreshCli();
		this.offerRestart(vscode.l10n.t("Saved to {0}. New agents remember it.", tildify(file)));
	}

	private async cannotRewrite(file: string, needle: string): Promise<void> {
		void vscode.window.showWarningMessage(vscode.l10n.t("{0} has comments, so GeminiCode won't rewrite it. Make the change under {1} yourself.", tildify(file), needle));
		await openAt(file, needle);
	}

	private offerRestart(message: string): void {
		const restart = vscode.l10n.t("Restart Agent");
		void vscode.window.showInformationMessage(message, restart).then(choice => choice === restart && this.service.restart());
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: SettingsPageStrings = {
			title: vscode.l10n.t("Project Helpers"),
			subtitle: vscode.l10n.t("What every Gemini agent loads when it starts, shared with the gemini command in your terminal. Changes apply to new agents."),
			restart: vscode.l10n.t("Restart Agent"),
			servers: vscode.l10n.t("MCP servers"),
			serversHint: vscode.l10n.t("Tools agents can use, such as GitHub, a database or your docs. A project's servers load once you trust its folder."),
			addServer: vscode.l10n.t("Add Server"),
			noServers: vscode.l10n.t("No MCP servers yet."),
			edit: vscode.l10n.t("Edit in settings"),
			enable: vscode.l10n.t("Use this server"),
			failed: vscode.l10n.t("Failed to start: {0}"),
			skills: vscode.l10n.t("Skills"),
			skillsHint: vscode.l10n.t("Know-how Gemini loads when a task calls for it, such as how to cut a release. Pick one from the / menu to use it now."),
			newSkill: vscode.l10n.t("New Skill"),
			noSkills: vscode.l10n.t("No skills yet."),
			hooks: vscode.l10n.t("Hooks"),
			hooksHint: vscode.l10n.t("Commands the CLI runs at set points, such as a formatter after every edit. A project's hooks run once you trust its folder."),
			addHook: vscode.l10n.t("Add Hook"),
			noHooks: vscode.l10n.t("No hooks yet."),
			hookMatcher: vscode.l10n.t("for {0}"),
			enableHook: vscode.l10n.t("Run this hook"),
			extensions: vscode.l10n.t("Extensions"),
			extensionsHint: vscode.l10n.t("Gemini CLI extensions bundle commands, MCP servers, skills and rules. Installing one runs the CLI's installer in a terminal."),
			installExtension: vscode.l10n.t("Install"),
			noExtensions: vscode.l10n.t("No extensions installed."),
			enableExtension: vscode.l10n.t("Use this extension"),
			updateExtension: vscode.l10n.t("Update"),
			uninstallExtension: vscode.l10n.t("Uninstall"),
			memory: vscode.l10n.t("Memory"),
			memoryHint: vscode.l10n.t("The GEMINI.md files the CLI loads for this folder, from your home folder down to subfolders and extensions."),
			addMemory: vscode.l10n.t("Add Memory"),
			refresh: vscode.l10n.t("Refresh"),
			noMemory: vscode.l10n.t("No GEMINI.md files in use."),
			loading: vscode.l10n.t("Asking the Gemini CLI…"),
			rules: vscode.l10n.t("Rules"),
			rulesHint: vscode.l10n.t("Instructions every agent follows, such as how to build, test and write code here."),
			open: vscode.l10n.t("Open"),
			create: vscode.l10n.t("Create"),
			missing: vscode.l10n.t("Not created yet"),
			enableSkill: vscode.l10n.t("Use this skill"),
			signIn: vscode.l10n.t("Sign In"),
			preferences: vscode.l10n.t("Gemini CLI settings"),
			preferencesHint: vscode.l10n.t("Your own settings in {0}. A project's .gemini/settings.json can override them."),
			permanentApproval: vscode.l10n.t("Allow for all future sessions"),
			permanentApprovalHint: vscode.l10n.t("Permission prompts offer to allow a tool or command from now on, so trusted commands such as npm test stop asking in every new chat."),
			planRouting: vscode.l10n.t("Plan with Pro, build with Flash"),
			planRoutingHint: vscode.l10n.t("In Plan mode, the model on Auto plans with Pro and carries out the plan with Flash. Turn off to keep one model throughout."),
			usageStatistics: vscode.l10n.t("Send usage statistics"),
			usageStatisticsHint: vscode.l10n.t("The Gemini CLI sends anonymous usage statistics to Google to improve it."),
			keepChats: vscode.l10n.t("Keep saved chats for"),
			keepChatsHint: vscode.l10n.t("The Gemini CLI deletes saved chats older than this, so they no longer show under Restore Session."),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>${strings.title}</title>
</head>
<body class="settings-page">
	<main id="page" class="settings"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

const extensionActions: ReadonlySet<string> = new Set(['enable', 'disable', 'update', 'uninstall']);

/** Whether a webview message names an extension action the page offers. */
function isExtensionAction(action: unknown): action is 'enable' | 'disable' | 'update' | 'uninstall' {
	return typeof action === 'string' && extensionActions.has(action);
}

/** A list the CLI cannot report because it has no such command. */
function notOffered<T>(command: string): CliReport<T> {
	return { state: 'unavailable', message: vscode.l10n.t("This Gemini CLI has no {0} command.", command) };
}

function extensionView(extension: CliExtension): ExtensionView {
	const parts = [
		extension.mcpServers.length === 1 ? vscode.l10n.t("1 MCP server") : extension.mcpServers.length ? vscode.l10n.t("{0} MCP servers", extension.mcpServers.length) : '',
		extension.skills === 1 ? vscode.l10n.t("1 skill") : extension.skills ? vscode.l10n.t("{0} skills", extension.skills) : '',
		extension.contextFiles.length ? vscode.l10n.t("rules") : '',
		extension.hooks ? vscode.l10n.t("hooks") : '',
	].filter(Boolean);
	return {
		name: extension.name,
		version: extension.version,
		active: extension.active,
		...(extension.source ? { source: extension.kind === 'local' || extension.kind === 'link' ? tildify(extension.source) : extension.source } : {}),
		detail: parts.join(' · '),
	};
}

async function memoryView(file: string): Promise<MemoryFileView> {
	const preview = await fs.readFile(file, 'utf8').then(firstLine, () => undefined);
	return { path: file, display: tildify(file), ...(preview ? { preview } : {}) };
}

function firstLine(text: string): string | undefined {
	return text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 120);
}

async function rulesView(label: string, file: string, display: string): Promise<RulesFileView> {
	try {
		const preview = firstLine(await fs.readFile(file, 'utf8'));
		return { label, display, path: file, exists: true, ...(preview ? { preview } : {}) };
	} catch {
		return { label, display, path: file, exists: false };
	}
}

/** Opens a file, with the cursor on the first `needle` when given. */
async function openAt(file: string, needle?: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
	const offset = needle ? document.getText().indexOf(needle) : -1;
	const position = offset >= 0 ? document.positionAt(offset) : new vscode.Position(0, 0);
	await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
}

/** A rules file name from settings, which may come from the repository: never a path that leaves its folder. */
function plainFileName(name: string): string {
	return name && path.basename(name) === name && name !== '..' && name !== '.' ? name : 'GEMINI.md';
}
