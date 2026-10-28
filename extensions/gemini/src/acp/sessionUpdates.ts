/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The thin wire-to-UI adapter: turns `session/update` notifications into a
// few UI-facing events. Update kinds it does not know render generically
// instead of being dropped (design rules 4 and 5 in
// gemini/docs/ARCHITECTURE.md).

import type * as acp from '@agentclientprotocol/sdk';

export interface ToolCallModel {
	readonly id: string;
	readonly title: string;
	readonly kind: acp.ToolKind | undefined;
	readonly status: acp.ToolCallStatus;
	readonly locations: readonly acp.ToolCallLocation[];
	readonly content: readonly acp.ToolCallContent[];
}

export type ChatEvent =
	| { readonly kind: 'text'; readonly role: 'agent' | 'user' | 'thought'; readonly text: string; readonly messageId?: string | null }
	/** A tool call was created or changed; `call` is the merged current state. */
	| { readonly kind: 'toolCall'; readonly call: ToolCallModel }
	| { readonly kind: 'plan'; readonly entries: readonly acp.PlanEntry[] }
	| { readonly kind: 'other'; readonly type: string; readonly update: acp.SessionUpdate };

/**
 * Whether an event is the model's own output: its reply, a thought, a tool
 * call or a plan. The first of these after a prompt is its first token; an
 * agentic turn's reply text often comes last, after its thoughts and steps.
 */
export function isModelOutput(event: ChatEvent): boolean {
	return (event.kind === 'text' && event.role !== 'user') || event.kind === 'toolCall' || event.kind === 'plan';
}

export function contentBlockToText(block: acp.ContentBlock): string {
	switch (block.type) {
		case 'text':
			return block.text;
		case 'resource_link':
			return `[${block.title ?? block.name}](${block.uri})`;
		case 'resource':
			return typeof (block.resource as { text?: unknown }).text === 'string' ? (block.resource as acp.TextResourceContents).text : `[${block.resource.uri}]`;
		default:
			return `[${block.type}]`;
	}
}

/** What gemini-cli writes for an error that is not an Error, such as a refused file request's JSON-RPC error. */
const objectText = '[object Object]';

/** Whether a tool call is over; the agent rarely updates one after that. */
function isFinished(status: ToolCallModel['status']): boolean {
	return status === 'completed' || status === 'failed';
}

export class SessionUpdateAdapter {

	/**
	 * Tool calls so far, so an update that leaves fields out keeps them. A
	 * finished call keeps no content: an edit's content holds the whole file
	 * before and after, and a long session has hundreds of them. The
	 * transcript keeps what it showed of it.
	 */
	private readonly toolCalls = new Map<string, ToolCallModel>();

	/** `explainFileError` gives GeminiCode's latest refusal of the session's file requests, for a tool failure the CLI wrote as "[object Object]". */
	constructor(private readonly explainFileError?: () => string | undefined) { }

	adapt(update: acp.SessionUpdate): ChatEvent {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				return { kind: 'text', role: 'agent', text: contentBlockToText(update.content), messageId: update.messageId };
			case 'user_message_chunk':
				return { kind: 'text', role: 'user', text: contentBlockToText(update.content), messageId: update.messageId };
			case 'agent_thought_chunk':
				return { kind: 'text', role: 'thought', text: contentBlockToText(update.content), messageId: update.messageId };
			case 'tool_call': {
				const call: ToolCallModel = {
					id: update.toolCallId,
					title: update.title,
					kind: update.kind,
					status: update.status ?? 'pending',
					locations: update.locations ?? [],
					content: update.content ?? [],
				};
				this.remember(call);
				return { kind: 'toolCall', call };
			}
			case 'tool_call_update': {
				const previous = this.toolCalls.get(update.toolCallId);
				const call: ToolCallModel = {
					id: update.toolCallId,
					title: update.title ?? previous?.title ?? update.toolCallId,
					kind: update.kind ?? previous?.kind,
					status: update.status ?? previous?.status ?? 'pending',
					locations: update.locations ?? previous?.locations ?? [],
					content: (update.content ? this.explained(update.content) : undefined) ?? previous?.content ?? [],
				};
				this.remember(call);
				return { kind: 'toolCall', call };
			}
			case 'plan':
				return { kind: 'plan', entries: update.entries };
			default:
				return { kind: 'other', type: (update as { sessionUpdate: string }).sessionUpdate, update };
		}
	}

	/**
	 * A tool's content with the CLI's "[object Object]" replaced by why
	 * GeminiCode refused the request behind it: gemini-cli turns the JSON-RPC
	 * error of a refused file request into that text.
	 */
	private explained(content: readonly acp.ToolCallContent[]): acp.ToolCallContent[] {
		return content.map(part => {
			if (part.type !== 'content' || part.content.type !== 'text' || !part.content.text.includes(objectText)) {
				return part;
			}
			const reason = this.explainFileError?.();
			return { ...part, content: { ...part.content, text: part.content.text.split(objectText).join(reason ?? 'the Gemini CLI did not say why') } };
		});
	}

	private remember(call: ToolCallModel): void {
		if (isFinished(call.status)) {
			this.toolCalls.set(call.id, call.content.length ? { ...call, content: [] } : call);
		} else {
			this.toolCalls.set(call.id, call);
		}
	}
}
