/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the ACP content blocks for a prompt with attached context.
// Files go as resource_link (the agent reads them itself, so nothing large
// crosses the pipe twice), selections as embedded resources, images as
// image blocks. Only what the agent's promptCapabilities allow is sent.

import type * as acp from '@agentclientprotocol/sdk';
import { pathToFileURL } from 'node:url';
import { Attachment, attachmentLabel, basename } from './attachments';

export interface PromptCapabilities {
	readonly image: boolean;
	readonly embeddedContext: boolean;
}

export function readPromptCapabilities(agent: acp.InitializeResponse | undefined): PromptCapabilities {
	const caps = agent?.agentCapabilities?.promptCapabilities;
	return { image: caps?.image === true, embeddedContext: caps?.embeddedContext === true };
}

export function buildPromptContent(text: string, attachments: readonly Attachment[], capabilities: PromptCapabilities): acp.ContentBlock[] {
	const blocks: acp.ContentBlock[] = [];
	if (text.trim()) {
		blocks.push({ type: 'text', text });
	}
	for (const attachment of attachments) {
		switch (attachment.kind) {
			case 'file':
				blocks.push({ type: 'resource_link', uri: pathToFileURL(attachment.path).href, name: basename(attachment.path) });
				break;
			case 'selection': {
				const uri = `${pathToFileURL(attachment.path).href}#L${attachment.startLine}-L${attachment.endLine}`;
				if (capabilities.embeddedContext) {
					blocks.push({ type: 'resource', resource: { uri, text: attachment.text, mimeType: 'text/plain' } });
				} else {
					// Every agent takes text, so a selection still gets through.
					const fence = attachment.text.includes('```') ? '~~~~' : '```';
					blocks.push({ type: 'text', text: `${attachmentLabel(attachment)} (${attachment.path}):\n${fence}${attachment.languageId ?? ''}\n${attachment.text}\n${fence}` });
				}
				break;
			}
			case 'image':
				if (capabilities.image) {
					blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
				}
				break;
		}
	}
	return blocks;
}
