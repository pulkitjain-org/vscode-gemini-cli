/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { AgentsModel } from '../../src/acp/agents';
import { AgentTabs, AgentTabsHost } from '../../src/host/agents/agentTabs';
import type { LiveAgent } from '../../src/host/agents/agentStart';
import { EventEmitter, window } from './vscodeStub';

/** A panel as `createWebviewPanel` makes one, with what the tabs touch. */
function fakePanel(title: string) {
	const disposed = new EventEmitter<void>();
	const viewState = new EventEmitter<unknown>();
	return {
		title,
		iconPath: undefined as unknown,
		active: true,
		visible: true,
		webview: { postMessage: async () => true, onDidReceiveMessage: () => ({ dispose: () => undefined }), html: '', options: {} },
		reveal: vi.fn(),
		onDidChangeViewState: viewState.event,
		onDidDispose: disposed.event,
		dispose: () => disposed.fire(),
	};
}

/** A live agent whose chat counts the webviews it is attached to. */
function fakeLive(): LiveAgent & { attached: number } {
	const live = {
		attached: 0,
		session: { open: () => undefined },
		controller: {
			attach: () => { live.attached++; },
			detach: () => undefined,
			setHidden: () => undefined,
			focusComposer: () => undefined,
			onDidSendPrompt: () => ({ dispose: () => undefined }),
			conversation: [],
			restore: () => undefined,
			restoreCheckpoints: () => undefined,
			holdPrompts: () => undefined,
			commit: async () => undefined,
		},
		changes: { restore: () => undefined, files: [] },
		files: {},
		unread: false,
		activity: { busy: false, needsPermission: false },
		disposables: [],
	};
	return live as unknown as LiveAgent & { attached: number };
}

function setUp() {
	const model = new AgentsModel({ workspaces: [{ id: 'w', folder: '/work' }], agents: [{ id: 'a', workspaceId: 'w', title: 'Agent A', createdAt: 1, updatedAt: 1 }] });
	const live = new Map<string, LiveAgent>();
	const started: LiveAgent[] = [];
	const host: AgentTabsHost = {
		extensionUri: { fsPath: '/ext' } as never,
		model,
		live,
		tree: { view: { selection: [] } as never, revealAgent: () => undefined, inGit: async () => undefined as never },
		worktrees: { restoreFolder: async () => true },
		projects: { ready: async () => undefined },
		projectAgents: { ensureProjectTrust: async () => true, linkRules: async () => undefined },
		starter: { start: () => { const agent = fakeLive(); started.push(agent); live.set('a', agent); return agent; } },
		transcripts: { load: async () => ({ items: [], changes: [] }) },
		checkpointFiles: { load: async () => undefined },
		notifier: { clear: () => undefined },
		indicators: { tabIcon: () => undefined as never, restingTabIcon: () => undefined as never, tabClosed: () => undefined },
		changesView: { show: () => undefined, openAll: async () => undefined },
		view: {} as never,
		focusChanged: () => undefined,
		refresh: () => undefined,
		disposing: () => false,
		release: () => undefined,
	};
	const panels: ReturnType<typeof fakePanel>[] = [];
	window.createWebviewPanel = (_type: unknown, title: unknown) => {
		const panel = fakePanel(String(title));
		panels.push(panel);
		return panel;
	};
	return { tabs: new AgentTabs(host), live, started, panels };
}

describe('AgentTabs.open', () => {
	it('makes one tab for an agent opened twice before its first open is through', async () => {
		const { tabs, started, panels, live } = setUp();
		const first = tabs.open('a');
		const second = tabs.open('a');
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect([started.length, panels.length, (live.get('a') as LiveAgent & { attached: number }).attached]).toEqual([1, 1, 1]);
	});

	it('reveals the tab an open made once a later open comes after it', async () => {
		const { tabs, panels } = setUp();
		await tabs.open('a');
		await tabs.open('a');
		expect([panels.length, panels[0].reveal.mock.calls.length]).toEqual([1, 1]);
	});

	it('opens again after an open failed', async () => {
		const { tabs, panels } = setUp();
		const failing = window.createWebviewPanel;
		window.createWebviewPanel = () => { throw new Error('no panel'); };
		await expect(tabs.open('a')).rejects.toThrow('no panel');
		window.createWebviewPanel = failing;
		await tabs.open('a');
		expect(panels.length).toEqual(1);
	});
});
