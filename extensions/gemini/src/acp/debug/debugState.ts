/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's phases (DEBUG_MODE.md): where a debug session is, the moves
// the agent may make and the ones only the user may, the round count with
// its cap, and which of the agent's tools each phase allows. A plain value
// and pure functions, so the host keeps it, draws it and sends it to the
// model each turn, and nothing here depends on the model's memory.

export type DebugPhase = 'investigate' | 'instrument' | 'reproduce' | 'analyse' | 'fix' | 'verify' | 'cleanup';

export const debugPhases: readonly DebugPhase[] = ['investigate', 'instrument', 'reproduce', 'analyse', 'fix', 'verify', 'cleanup'];

export type DebugTool =
	| 'debug_hypotheses' | 'debug_configs' | 'debug_launch' | 'debug_attach'
	| 'debug_logpoint' | 'debug_breakpoint' | 'debug_instrument' | 'debug_remove'
	| 'debug_reproduce' | 'debug_evidence' | 'debug_inspect' | 'debug_request_log'
	| 'debug_fix' | 'debug_verify';

export const debugToolNames: readonly DebugTool[] = [
	'debug_hypotheses', 'debug_configs', 'debug_launch', 'debug_attach',
	'debug_logpoint', 'debug_breakpoint', 'debug_instrument', 'debug_remove',
	'debug_reproduce', 'debug_evidence', 'debug_inspect', 'debug_request_log',
	'debug_fix', 'debug_verify',
];

/** Rounds of Instrument, Reproduce and Analyse with nothing confirmed before the user is asked whether to go on. */
export const maxRounds = 4;

export interface DebugState {
	readonly phase: DebugPhase;
	/** Rounds spent so far (a round with no evidence counts double). */
	readonly rounds: number;
	/** Rounds allowed before the user is asked again; Keep Going raises it. */
	readonly roundCap: number;
	/** The user chose Skip to Fix: the agent is told edits were allowed without a confirmed hypothesis. */
	readonly userAllowedEdits: boolean;
}

export const initialDebugState: DebugState = { phase: 'investigate', rounds: 0, roundCap: maxRounds, userAllowedEdits: false };

/** The moves the agent's own calls make, as the phase table gives them. */
const agentMoves: Readonly<Record<DebugPhase, readonly DebugPhase[]>> = {
	investigate: ['instrument', 'cleanup'],
	instrument: ['reproduce', 'cleanup'],
	reproduce: ['analyse', 'cleanup'],
	analyse: ['instrument', 'fix', 'cleanup'],
	fix: ['verify', 'cleanup'],
	verify: ['fix', 'cleanup'],
	cleanup: [],
};

/** Which tools each phase allows; a tool outside its phase is refused with `refusal`. */
const toolsByPhase: Readonly<Record<DebugPhase, readonly DebugTool[]>> = {
	investigate: ['debug_hypotheses', 'debug_configs', 'debug_request_log'],
	instrument: ['debug_hypotheses', 'debug_configs', 'debug_launch', 'debug_attach', 'debug_logpoint', 'debug_breakpoint', 'debug_instrument', 'debug_remove', 'debug_reproduce', 'debug_evidence', 'debug_request_log'],
	reproduce: ['debug_hypotheses', 'debug_configs', 'debug_launch', 'debug_attach', 'debug_remove', 'debug_reproduce', 'debug_evidence', 'debug_request_log'],
	analyse: ['debug_hypotheses', 'debug_configs', 'debug_logpoint', 'debug_breakpoint', 'debug_instrument', 'debug_remove', 'debug_evidence', 'debug_inspect', 'debug_request_log', 'debug_fix'],
	fix: ['debug_hypotheses', 'debug_configs', 'debug_remove', 'debug_evidence', 'debug_verify'],
	verify: ['debug_hypotheses', 'debug_configs', 'debug_launch', 'debug_attach', 'debug_remove', 'debug_reproduce', 'debug_evidence', 'debug_inspect', 'debug_request_log', 'debug_fix'],
	cleanup: [],
};

export interface MoveOptions {
	/** Who moves it: the agent follows the phase table; the user may move it anywhere (Skip to Fix, Back to Investigate, Stop). */
	readonly by?: 'agent' | 'user';
	/** For a move from Analyse back to Instrument: whether the round that ends brought any evidence. */
	readonly hadEvidence?: boolean;
}

/** The state after moving to `to`, or undefined when the phase table has no such move for the agent. */
export function move(state: DebugState, to: DebugPhase, options: MoveOptions = {}): DebugState | undefined {
	const by = options.by ?? 'agent';
	if (state.phase === 'cleanup') {
		return undefined;
	}
	if (by === 'agent' && !agentMoves[state.phase].includes(to)) {
		return undefined;
	}
	let rounds = state.rounds;
	if (state.phase === 'analyse' && to === 'instrument') {
		rounds += options.hadEvidence === false ? 2 : 1;
	}
	return {
		phase: to,
		rounds,
		roundCap: to === 'investigate' && by === 'user' ? maxRounds : state.roundCap,
		userAllowedEdits: to === 'fix' && by === 'user' ? true : to === 'investigate' ? false : state.userAllowedEdits,
	};
}

/** The user pressed Keep Going: as many rounds again before the next ask. */
export function keepGoing(state: DebugState): DebugState {
	return { ...state, roundCap: state.rounds + maxRounds };
}

/** Whether the next turn should end with the card that asks the user to keep going, give a hint or stop. */
export function roundsExhausted(state: DebugState): boolean {
	return state.rounds >= state.roundCap && state.phase !== 'fix' && state.phase !== 'verify' && state.phase !== 'cleanup';
}

/** Whether the phase allows `tool`. */
export function allows(state: DebugState, tool: string): boolean {
	return (toolsByPhase[state.phase] as readonly string[]).includes(tool);
}

/** The tools the phase allows, for the prompt. */
export function allowedTools(state: DebugState): readonly DebugTool[] {
	return toolsByPhase[state.phase];
}

/** Whether the phase guard lets the CLI's file writes through (the Fix phase only). */
export function editsAllowed(state: DebugState): boolean {
	return state.phase === 'fix';
}

/** The phase's name as the user sees it. */
export function phaseName(phase: DebugPhase): string {
	switch (phase) {
		case 'investigate': return 'Investigate';
		case 'instrument': return 'Instrument';
		case 'reproduce': return 'Reproduce';
		case 'analyse': return 'Analyse';
		case 'fix': return 'Fix';
		case 'verify': return 'Verify';
		case 'cleanup': return 'Clean up';
	}
}

/** What the model reads when it calls a tool the phase does not allow. */
export function refusal(state: DebugState, tool: string): string {
	if (state.phase === 'cleanup') {
		return `Debug mode has ended: ${tool} is no longer available.`;
	}
	return `Debug mode is in ${phaseName(state.phase)}: ${tool} is not available in this phase. Available now: ${toolsByPhase[state.phase].join(', ')}.`;
}

/** What the model reads when the phase guard refuses a file write. */
export function editRefusal(state: DebugState): string {
	return `Debug mode is in ${phaseName(state.phase)}: edits wait until a hypothesis is confirmed (debug_fix). To observe, use debug_logpoint or debug_instrument.`;
}

/** What the model reads when a write would change a marked region, in any phase. */
export const markedRegionRefusal = 'This edit changes a line Debug mode inserted. Use debug_instrument to add observation lines and debug_remove to take them out; never edit them by hand.';
