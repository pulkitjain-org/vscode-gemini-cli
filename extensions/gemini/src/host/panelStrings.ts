/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The words of the Changes panel, Home and Agent Setup, which the host writes
// (`vscode.l10n.t`) and each page reads from its script tag. Kept apart from
// panelProtocol.ts, which holds the messages between host and page.

export interface ChangesPanelStrings {
	readonly empty: string;
	readonly noAgent: string;
	readonly keep: string;
	readonly undo: string;
	readonly keepAll: string;
	readonly undoAll: string;
	readonly keepFile: string;
	readonly undoFile: string;
	readonly openFile: string;
	readonly openAll: string;
	readonly commit: string;
	/** The Try button's three labels, by the choice remembered for the repository, and its chevron. */
	readonly tryIn: string;
	readonly tryInTip: string;
	readonly mergeBack: string;
	readonly mergeBackTip: string;
	readonly openMr: string;
	readonly openMrTip: string;
	readonly tryMenu: string;
	readonly tryMenuTip: string;
	readonly keepChanges: string;
	readonly keepChangesTip: string;
	readonly takeBack: string;
	readonly takeBackTip: string;
	readonly newFile: string;
	readonly hiddenLines: string;
	readonly noDiff: string;
	readonly working: string;
	readonly oneFile: string;
	readonly files: string;
}

export interface HomeStrings {
	readonly title: string;
	readonly writeLabel: string;
	readonly previewLabel: string;
	/** Preview's tooltip; {0} is the shortcut. */
	readonly previewMarkdown: string;
	readonly previewEmpty: string;
	readonly calloutNote: string;
	readonly calloutTip: string;
	readonly calloutImportant: string;
	readonly calloutWarning: string;
	readonly calloutCaution: string;
	readonly subtitle: string;
	readonly placeholder: string;
	readonly start: string;
	/** The chooser of where a new agent works, and its three choices with a line each. */
	readonly startAs: string;
	readonly startHere: string;
	readonly startHereHint: string;
	readonly startOwnBranch: string;
	readonly startOwnBranchHint: string;
	/** The branch chevron's menu: its heading for the projects, the row for a plain branch, and the chevron's label. */
	readonly startProject: string;
	readonly startProjectHint: string;
	readonly branchAlone: string;
	readonly branchMenu: string;
	/** The project picker beside the chooser, and its menu. */
	readonly project: string;
	readonly projectsIn: string;
	readonly otherProjects: string;
	readonly newProjectIn: string;
	readonly sendToProject: string;
	readonly startNewProject: string;
	/** The prompt's placeholder for a project's coordinator; {0} is the project. */
	readonly projectPlaceholder: string;
	readonly newProjectPlaceholder: string;
	/** In place of the mode and model, which are the coordinator's. */
	readonly coordinatorSettings: string;
	/** Trust, as the folder picker and the composer show it. */
	readonly trusted: string;
	readonly trustedByParent: string;
	readonly needsTrust: string;
	/** "Needs trust: {0} isn't trusted for agents". */
	readonly needsTrustFolder: string;
	readonly trustButton: string;
	readonly needsTrustedFolder: string;
	readonly workspace: string;
	readonly addFolder: string;
	readonly agentSetup: string;
	readonly agentSetupHint: string;
	readonly plusMenu: string;
	readonly mode: string;
	readonly files: string;
	readonly filesDetail: string;
	readonly remove: string;
	readonly active: string;
	readonly earlier: string;
	readonly projects: string;
	readonly noProjects: string;
	readonly newProject: string;
	/** Open, for a card's fallback focus; the cards' other buttons come with their labels (`HomeAgent.buttons`). */
	readonly open: string;
	/** The Try button's chevron. */
	readonly tryMenu: string;
	readonly noAgents: string;
	readonly noWorkspace: string;
	readonly customize: string;
	readonly refresh: string;
	readonly needsYou: string;
	readonly showCard: string;
	readonly moveUp: string;
	readonly moveDown: string;
	readonly cards: string;
	readonly qualityBranch: string;
	readonly getStarted: string;
	readonly composerPlaceholder: string;
	readonly moreActions: string;
	/** "From Your Tools...": a ticket or merge request to start on. */
	readonly fromTools: string;
	readonly fromToolsEmpty: string;
	readonly tickets: string;
	readonly mergeRequests: string;
	/** A card's Show All button; {0} is how many rows its list has. */
	readonly showAll: string;
	/** The popup's filter box. */
	readonly filterList: string;
	readonly noMatches: string;
	readonly close: string;
	readonly commentTitle: string;
	readonly commentPlaceholder: string;
	readonly commentHelp: string;
	readonly commentPost: string;
	readonly commentPosting: string;
	readonly commentPosted: string;
	readonly commentBold: string;
	readonly commentItalic: string;
	readonly commentStrike: string;
	readonly commentCode: string;
	readonly commentLink: string;
	readonly commentBullets: string;
	readonly commentNumbers: string;
	readonly commentTasks: string;
	readonly commentQuote: string;
	readonly commentPanel: string;
	readonly commentCodeBlock: string;
	readonly commentTable: string;
	readonly commentRule: string;
	readonly commentMention: string;
	readonly commentAttach: string;
	readonly commentFormatting: string;
	readonly commentDrop: string;
	readonly commentNoPeople: string;
	readonly commentSearching: string;
	readonly commentVisibleTo: string;
	readonly commentEveryone: string;
	readonly commentRoles: string;
	readonly commentGroups: string;
	readonly commentTooLarge: string;
	readonly commentShortcut: string;
	readonly commentTipWrite: string;
	readonly commentTipBullets: string;
	readonly commentTipNumbers: string;
	readonly commentTipTasks: string;
	readonly commentTipQuote: string;
	readonly commentTipPanel: string;
	readonly commentTipCodeBlock: string;
	readonly commentTipTable: string;
	readonly commentTipRule: string;
	readonly commentTipMention: string;
	readonly commentTipAttach: string;
	readonly commentTipVisibility: string;
	readonly commentTipCancel: string;
	readonly commentRemoveFile: string;
	/** An attached file's size; `{0}` is the number. */
	readonly sizeBytes: string;
	readonly sizeKilobytes: string;
	readonly sizeMegabytes: string;
	readonly cancel: string;
}

export interface SettingsPageStrings {
	readonly contextTitle: string;
	/** `{0}` is the folder. */
	readonly contextHint: string;
	readonly measure: string;
	readonly measureAgain: string;
	readonly measuring: string;
	/** The label of the folder picker in a multi-root window. */
	readonly contextFolder: string;
	readonly contextNone: string;
	/** `{0}` is the tokens. */
	readonly contextTotal: string;
	/** `{0}` is the tokens, beside a server or file. */
	readonly tokensPerCall: string;
	readonly title: string;
	readonly subtitle: string;
	readonly restart: string;
	readonly servers: string;
	readonly serversHint: string;
	readonly addServer: string;
	/** Opens the team tools' Connections page. */
	readonly connections: string;
	readonly noServers: string;
	readonly edit: string;
	readonly enable: string;
	readonly failed: string;
	readonly skills: string;
	readonly skillsHint: string;
	readonly newSkill: string;
	readonly noSkills: string;
	readonly hooks: string;
	readonly hooksHint: string;
	readonly addHook: string;
	readonly noHooks: string;
	/** `{0}` is the tool names a hook applies to. */
	readonly hookMatcher: string;
	readonly enableHook: string;
	readonly extensions: string;
	readonly extensionsHint: string;
	readonly installExtension: string;
	readonly noExtensions: string;
	readonly enableExtension: string;
	readonly updateExtension: string;
	readonly uninstallExtension: string;
	readonly memory: string;
	readonly memoryHint: string;
	readonly addMemory: string;
	readonly refresh: string;
	readonly noMemory: string;
	readonly loading: string;
	readonly rules: string;
	readonly rulesHint: string;
	readonly open: string;
	readonly create: string;
	readonly missing: string;
	readonly enableSkill: string;
	readonly signIn: string;
	readonly preferences: string;
	/** `{0}` is the settings file. */
	readonly preferencesHint: string;
	readonly defaultApprovalMode: string;
	readonly defaultApprovalModeHint: string;
	/** `{0}` is the mode GeminiCode's own setting names. */
	readonly ownDefaultModeNote: string;
	readonly permanentApproval: string;
	readonly permanentApprovalHint: string;
	readonly planRouting: string;
	readonly planRoutingHint: string;
	readonly usageStatistics: string;
	readonly usageStatisticsHint: string;
	readonly keepChats: string;
	readonly keepChatsHint: string;
	readonly trust: string;
	readonly trustHint: string;
	readonly trustFolder: string;
	readonly trustParent: string;
	readonly neverTrust: string;
	readonly removeTrust: string;
	readonly noTrust: string;
}
