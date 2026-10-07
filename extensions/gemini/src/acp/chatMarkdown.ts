/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Open Chat as Markdown: a conversation as one Markdown document.

import type { TranscriptItem } from './chatTranscript';

/** Headings and labels, localised by the caller. */
export interface ChatMarkdownLabels {
	readonly you: string;
	readonly gemini: string;
	readonly thought: string;
	readonly plan: string;
	readonly attached: string;
	/** `{0}` is a duration such as "12s". */
	readonly workedFor: string;
	/** `{0}` is the request, `{1}` the answer. */
	readonly permission: string;
	readonly cancelled: string;
}

export function chatToMarkdown(title: string, items: readonly TranscriptItem[], labels: ChatMarkdownLabels): string {
	const blocks: string[] = [`# ${oneLine(title)}`];
	// Consecutive tool calls make one list; this is the list being built.
	let tools: string[] = [];
	const flushTools = () => {
		if (tools.length) {
			blocks.push(tools.join('\n'));
			tools = [];
		}
	};
	let lastSpeaker: 'user' | 'agent' | undefined;
	for (const item of items) {
		if (item.kind !== 'toolCall') {
			flushTools();
		}
		switch (item.kind) {
			case 'user': {
				blocks.push(`## ${labels.you}`, item.text.trim());
				if (item.attachments?.length) {
					blocks.push(`*${labels.attached}: ${item.attachments.map(a => `\`${a.label}\``).join(', ')}*`);
				}
				lastSpeaker = 'user';
				break;
			}
			case 'agent':
				if (lastSpeaker !== 'agent') {
					blocks.push(`## ${labels.gemini}`);
					lastSpeaker = 'agent';
				}
				blocks.push(item.text.trim());
				break;
			case 'thought':
				blocks.push(`<details><summary>${labels.thought}</summary>\n\n${item.text.trim()}\n\n</details>`);
				break;
			case 'toolCall':
				tools.push(`- ${toolMark(item.status)} ${oneLine(item.title)}`);
				break;
			case 'plan':
				blocks.push(`**${labels.plan}**\n\n${item.entries.map(e => `- [${e.status === 'completed' ? 'x' : ' '}] ${oneLine(e.content)}`).join('\n')}`);
				break;
			case 'permission':
				blocks.push(`*${format(labels.permission, oneLine(item.title), item.answer?.kind === 'selected' ? item.answer.name : labels.cancelled)}*`);
				break;
			case 'notice':
				blocks.push(`> ${item.text.trim().replace(/\n/g, '\n> ')}`);
				break;
			case 'turnEnd':
				blocks.push(`*${format(labels.workedFor, formatDuration(item.durationMs))}*`, '---');
				lastSpeaker = undefined;
				break;
			case 'other':
				break;
		}
	}
	flushTools();
	if (blocks.at(-1) === '---') {
		blocks.pop();
	}
	return blocks.filter(b => b).join('\n\n') + '\n';
}

function toolMark(status: string): string {
	return status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…';
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function format(template: string, ...values: string[]): string {
	return template.replace(/\{(\d)\}/g, (match, i: string) => values[Number(i)] ?? match);
}

/** "12s", "2m 5s" or "1h 3m", as the chat shows it. */
function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
