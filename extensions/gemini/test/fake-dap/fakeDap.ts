/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A scripted Debug Adapter Protocol responder for tests, as test/fake-agent
// is for ACP. It stands in for a debug session: requests (`customRequest`)
// are answered from a script, slowly or never when the script says so, and
// events are built as the adapter would send them, so the bridge's logic
// (src/acp/debug/debugBridgeLogic.ts) runs against what an adapter does
// without VS Code or a real adapter.

/** A request the script never answers, as a hung adapter would. */
export const never = Symbol('never');

class Slow {
	constructor(readonly ms: number, readonly answer: unknown) { }
}

/** A request answered after `ms`. */
export function slow(ms: number, answer: unknown): Slow {
	return new Slow(ms, answer);
}

export type ScriptedAnswer = unknown | typeof never | Slow;

export type DapScript = Readonly<Record<string, (args: Record<string, unknown>) => ScriptedAnswer>>;

export class FakeDap {

	/** Every request, in order. */
	readonly requests: { readonly command: string; readonly args: Record<string, unknown> }[] = [];

	constructor(private readonly script: DapScript) { }

	readonly request = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		this.requests.push({ command, args });
		const answer = this.script[command];
		if (!answer) {
			return Promise.reject(new Error(`The fake adapter has no answer for ${command}.`));
		}
		const value = answer(args);
		if (value === never) {
			return new Promise(() => undefined);
		}
		if (value instanceof Slow) {
			return new Promise(resolve => setTimeout(() => resolve(value.answer), value.ms));
		}
		return Promise.resolve(value);
	};

	/** The commands requested, in order. */
	get commands(): readonly string[] {
		return this.requests.map(request => request.command);
	}
}

let seq = 0;

/** A DAP event message. */
export function dapEvent(event: string, body: Record<string, unknown> = {}): Record<string, unknown> {
	return { seq: ++seq, type: 'event', event, body };
}

/** A DAP response, which the tracker skips. */
export function dapResponse(command: string, body: Record<string, unknown> = {}): Record<string, unknown> {
	return { seq: ++seq, type: 'response', request_seq: seq, success: true, command, body };
}

export function output(text: string, category = 'stdout'): Record<string, unknown> {
	return dapEvent('output', { category, output: text });
}

export function stopped(threadId: number, hitBreakpointIds: readonly number[], reason = 'breakpoint'): Record<string, unknown> {
	return dapEvent('stopped', { reason, threadId, hitBreakpointIds, allThreadsStopped: false });
}

/** A stopped thread two frames deep, with `cart` among its locals: the answers a snapshot asks for. */
export function stoppedThreadScript(extra: DapScript = {}): DapScript {
	return {
		stackTrace: () => ({ stackFrames: [{ id: 11, name: 'applyDiscount', line: 9, source: { path: '/work/shop/src/cart.js' } }, { id: 12, name: 'checkout', line: 20, source: { path: '/work/shop/src/server.js' } }], totalFrames: 2 }),
		scopes: () => ({ scopes: [{ name: 'Local', presentationHint: 'locals', variablesReference: 100, expensive: false }, { name: 'Global', variablesReference: 900, expensive: true }] }),
		variables: args => args.variablesReference === 100
			? { variables: [{ name: 'cart', value: 'Object', variablesReference: 101 }, { name: 'code', value: '"SAVE10"', variablesReference: 0 }] }
			: args.variablesReference === 101
				? { variables: [{ name: 'total', value: '9', variablesReference: 0 }, { name: 'discounts', value: 'Array(2)', variablesReference: 102 }] }
				: { variables: [{ name: '0', value: '0.1', variablesReference: 0 }, { name: '1', value: '0.1', variablesReference: 0 }] },
		continue: () => ({ allThreadsContinued: false }),
		...extra,
	};
}
