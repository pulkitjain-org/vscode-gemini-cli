/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentClientState } from './agentClient';
import type { AgentRuntimeState, SessionHealth } from './agentRuntime';
import type { AgentErrorInfo } from './errors';
import type { SidecarState } from './sidecar';

export type AgentPhase = 'stopped' | 'starting' | 'ready' | 'restarting' | 'error';

/** One summary of the sidecar and the session, for the status bar and the chat view. */
export interface AgentStatus {
	readonly phase: AgentPhase;
	/** Set in the `error` phase. */
	readonly error?: AgentErrorInfo;
	/** Set in the `restarting` phase. */
	readonly restartAttempt?: number;
	/** The agent's name and version from `initialize`, once a session is ready. */
	readonly agentName?: string;
	readonly agentVersion?: string;
	/** False while the process is ready but no session has opened on it yet (see `describeRuntimeStatus`). */
	readonly sessionOpened?: boolean;
}

/**
 * Folds the sidecar and client states into one status. `blocked` is an error
 * that kept the agent from starting at all (a project number instead of an ID).
 */
export function describeAgentStatus(sidecar: SidecarState, client: AgentClientState, blocked?: AgentErrorInfo): AgentStatus {
	switch (sidecar.kind) {
		case 'stopped':
			return blocked ? { phase: 'error', error: blocked } : { phase: 'stopped' };
		case 'starting':
			return { phase: 'starting' };
		case 'restarting':
			return { phase: 'restarting', restartAttempt: sidecar.attempt };
		case 'failed':
			return { phase: 'error', error: { kind: sidecar.reason, message: sidecar.message } };
		case 'running':
			switch (client.kind) {
				case 'ready':
					return { phase: 'ready', agentName: client.agent.agentInfo?.name, agentVersion: client.agent.agentInfo?.version };
				case 'error':
					return { phase: 'error', error: client.error };
				default:
					return { phase: 'starting' };
			}
	}
}

/**
 * The agent's status without a session of its own: the process, and how
 * opening sessions on it went for every chat (`SessionHealth`). A sign-in or
 * project error from any chat's session shows, as it would for each.
 */
export function describeRuntimeStatus(sidecar: SidecarState, runtime: AgentRuntimeState, health: SessionHealth, blocked?: AgentErrorInfo): AgentStatus {
	if (sidecar.kind !== 'running') {
		return describeAgentStatus(sidecar, { kind: 'idle' }, blocked);
	}
	switch (runtime.kind) {
		case 'ready':
			return health.error
				? { phase: 'error', error: health.error }
				: { phase: 'ready', agentName: runtime.agent.agentInfo?.name, agentVersion: runtime.agent.agentInfo?.version, ...(health.opened ? {} : { sessionOpened: false }) };
		case 'error':
			return { phase: 'error', error: runtime.error };
		default:
			return { phase: 'starting' };
	}
}
