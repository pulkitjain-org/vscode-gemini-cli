/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The thin wire-to-UI adapter (design rule 5): turns `session/update`
// notifications into a few UI-facing events. Update kinds it does not know
// render generically instead of being dropped (design rule 4).

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

export class SessionUpdateAdapter {

	private readonly toolCalls = new Map<string, ToolCallModel>();

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
				this.toolCalls.set(call.id, call);
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
					content: update.content ?? previous?.content ?? [],
				};
				this.toolCalls.set(call.id, call);
				return { kind: 'toolCall', call };
			}
			case 'plan':
				return { kind: 'plan', entries: update.entries };
			default:
				return { kind: 'other', type: (update as { sessionUpdate: string }).sessionUpdate, update };
		}
	}
}
