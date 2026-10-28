/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Side questions (/btw): a question about an agent's conversation, answered by
// a fast model while the agent keeps working. The agent's session can't take a
// second prompt while it works, so the question never goes through it: it goes
// with the conversation as the chat shows it, as one quick request (the route
// Enhance prompt takes), and neither the question nor the answer is added to the
// agent's history. Pure, so what the model is given is tested without a model.

import type { TranscriptItem } from './chatTranscript';

/** A side question and its answer, kept while the chat is open so later questions can build on them. */
export interface SideExchange {
	readonly question: string;
	readonly answer: string;
}

/** About four characters to a token: the conversation's share of a side question, about 120,000 tokens. */
export const sideChatBudget = 480_000;
/** A tool's output is cut to this many characters; the newest ones keep it longest. */
const toolOutputLimit = 2_000;
/** How many earlier side exchanges a question sees. */
export const sideHistory = 10;

/** The question as a slash command gives it: `/btw why axios?` asks "why axios?". */
export function sideQuestionOf(text: string): string | undefined {
	const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? match[1]?.trim() ?? '' : undefined;
}

const system = [
	'You answer a side question about a conversation between a developer and Gemini, a coding agent working in their repository.',
	'The agent is still working: the conversation may end in the middle of a step.',
	'You have no tools. Answer only from the conversation below. Never claim to have read a file, run a command or checked anything.',
	'When the conversation does not hold the answer, say so in one sentence and what would find it; the developer can fork the agent to look.',
	'Tool outputs are cut to their first part, so quote them only as far as they go.',
	'Be brief and direct: a few sentences or a short list, in Markdown. Name files and commands as the conversation does.',
].join('\n');

interface Block {
	readonly text: string;
	/** The block without a tool's output, for when the conversation is too long to keep every output. */
	readonly short?: string;
}

function toolBlock(item: Extract<TranscriptItem, { readonly kind: 'toolCall' }>): Block {
	// Which files a tool changed is short and often what a side question is about, so it stays when outputs go.
	const changed = item.details.flatMap(detail => detail.type === 'diff' ? [`Changed ${detail.path} (+${detail.added} -${detail.removed})`] : []);
	const head = [`[Tool call: ${item.title} (${item.status})${item.locations.length ? `, ${item.locations.map(l => l.path).join(', ')}` : ''}]`, ...changed].join('\n');
	const output = item.details.flatMap(detail => detail.type === 'text' ? [detail.text + (detail.tail ? `\n…\n${detail.tail}` : '')] : []).join('\n');
	if (!output.trim()) {
		return { text: head };
	}
	const cut = output.length > toolOutputLimit ? `${output.slice(0, toolOutputLimit)}\n… (${output.length - toolOutputLimit} more characters)` : output;
	return { text: `${head}\n${cut}`, short: head };
}

/** The conversation as the side question sees it: prompts, replies, plans and tool calls, oldest first. */
function blocksOf(items: readonly TranscriptItem[]): Block[] {
	const blocks: Block[] = [];
	for (const item of items) {
		switch (item.kind) {
			case 'user':
				if (item.text.trim()) {
					blocks.push({ text: `Developer: ${item.text.trim()}` });
				}
				break;
			case 'agent':
				if (item.text.trim()) {
					blocks.push({ text: `Gemini: ${item.text.trim()}` });
				}
				break;
			case 'plan':
				blocks.push({ text: `[Plan]\n${item.entries.map(entry => `- [${entry.status}] ${entry.content}`).join('\n')}` });
				break;
			case 'toolCall':
				blocks.push(toolBlock(item));
				break;
			default:
				break;
		}
	}
	return blocks;
}

/**
 * Fits the conversation into `budget` characters: first tools' outputs go,
 * oldest first; then whole blocks from the start, so the newest work, which
 * side questions are mostly about, is always kept.
 */
export function fitConversation(items: readonly TranscriptItem[], budget = sideChatBudget): { readonly text: string; readonly cut: boolean } {
	const blocks = blocksOf(items).map(block => block.text);
	const shorts = blocksOf(items).map(block => block.short);
	let total = blocks.reduce((sum, text) => sum + text.length + 2, 0);
	let cut = false;
	for (let i = 0; i < blocks.length && total > budget; i++) {
		const short = shorts[i];
		if (short !== undefined) {
			total -= blocks[i].length - short.length;
			blocks[i] = short;
			cut = true;
		}
	}
	let start = 0;
	while (start < blocks.length - 1 && total > budget) {
		total -= blocks[start].length + 2;
		start++;
		cut = true;
	}
	return { text: blocks.slice(start).join('\n\n'), cut };
}

/** The system text and prompt for a side question about the conversation in `items`. */
export function sideChatPrompt(input: { readonly items: readonly TranscriptItem[]; readonly question: string; readonly earlier?: readonly SideExchange[]; readonly busy?: boolean; readonly budget?: number }): { readonly system: string; readonly prompt: string } {
	const { text, cut } = fitConversation(input.items, input.budget);
	const earlier = (input.earlier ?? []).slice(-sideHistory);
	return {
		system,
		prompt: [
			`<conversation${input.busy ? ' status="the agent is still working"' : ''}${cut ? ' omitted="its oldest parts and some tool outputs"' : ''}>`,
			text || '(nothing yet)',
			'</conversation>',
			...earlier.length ? ['', '<earlier_side_questions>', ...earlier.map(exchange => `Q: ${exchange.question}\nA: ${exchange.answer}`), '</earlier_side_questions>'] : [],
			'',
			`Side question: ${input.question.trim()}`,
		].join('\n'),
	};
}

/** What Send to Agent puts in the message box: the question, with the side answer as context the agent didn't see. */
export function sideSteeringDraft(exchange: SideExchange): string {
	const answer = exchange.answer.trim();
	const short = answer.length > 600 ? `${answer.slice(0, 600)}…` : answer;
	return `${exchange.question.trim()}\n\n(I asked this on the side, and got this answer: ${short})`;
}
