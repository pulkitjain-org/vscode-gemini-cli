/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Enhance prompt: rewrites the draft as a precise prompt (the extension's
// src/acp/promptEnhancer.ts). A pill floats just after the draft's last
// character, moving as the user types: Enhance starts it; while it works the
// draft fades and the pill cancels; then the rewrite replaces the draft as an
// edit, and the pill offers Revert beside Enhance (Undo works too).

import { acceptsEnhanceReply, enhanceButtonPlacement, EnhancePhase, enhanceOriginal, enhancePhaseAfterInput, enhanceShortcutLabel, enhanceText, format, isEnhanceShortcut } from './chatLogic';
import { setLabel } from './dom';
import { autoGrow, onComposerChange, updateSendButton, updateSendState } from './inputBox';
import { state, strings, ui, vscode } from './view';

const { form, input, inputWrap, enhanceRow, enhanceFloat, enhanceButton, enhanceLabel, revertButton, revertLabel, enhanceNote } = ui;
const mirror = inputWrap.querySelector<HTMLElement>('.input-mirror')!;
/** Text styles the mirror copies from the input, so it wraps the same way. */
const mirroredStyles = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'paddingLeft', 'paddingRight', 'paddingTop', 'wordSpacing', 'textIndent'] as const;

/** After this long, the pill says the rewrite is still running. */
const slowAfterMs = 10_000;
/** And after this long, that Gemini is likely waiting out a rate limit (the CLI retries by itself). */
const waitingAfterMs = 25_000;
const mac = /Mac/.test(navigator.platform);

let phase: EnhancePhase = { kind: 'idle' };
let nextRequestId = 1;
let slowTimers: ReturnType<typeof setTimeout>[] = [];
/** Whether the extension was asked to get a rewrite ready since the draft was last empty. */
let prepared = false;

setLabel(enhanceButton, format(strings.enhanceTooltip, enhanceShortcutLabel(mac)));
setLabel(revertButton, strings.revertTooltip);
enhanceButton.querySelector('.enhance-key')!.textContent = enhanceShortcutLabel(mac);
revertLabel.textContent = strings.revert;

function setPhase(next: EnhancePhase): void {
	phase = next;
	const working = next.kind === 'working';
	state.enhancing = working;
	enhanceRow.dataset.phase = next.kind;
	form.classList.toggle('enhancing', working);
	input.readOnly = working;
	enhanceLabel.textContent = working ? strings.cancel : strings.enhanceShort;
	setLabel(enhanceButton, working ? strings.cancel : format(strings.enhanceTooltip, enhanceShortcutLabel(mac)));
	revertButton.hidden = next.kind !== 'done';
	updateSendButton();
	slowTimers.forEach(clearTimeout);
	slowTimers = working ? [
		setTimeout(() => showNote(strings.stillEnhancing), slowAfterMs),
		setTimeout(() => showNote(strings.enhanceWaiting), waitingAfterMs),
	] : [];
	updateRow();
}

function showNote(text: string, error = false): void {
	enhanceNote.textContent = text;
	enhanceNote.classList.toggle('error', error);
	enhanceNote.hidden = !text;
}

/** Shows the pill while there is a draft or a rewrite runs, and the row under the input while there is a note to show. */
function updateRow(): void {
	enhanceFloat.hidden = !input.value.trim() && phase.kind !== 'working';
	enhanceRow.hidden = enhanceNote.hidden;
	placeButton();
}

let placing = 0;
let mirrorStyled = false;
let below = false;

/**
 * Moves the button to where the text ends, once per frame. The text is copied
 * into a hidden mirror that wraps like the input; reading where it ends lays
 * out only what the frame lays out anyway, and the button moves by transform.
 */
function placeButton(): void {
	if (placing || enhanceFloat.hidden) {
		return;
	}
	placing = requestAnimationFrame(() => {
		placing = 0;
		if (!mirrorStyled) {
			const style = getComputedStyle(input);
			for (const name of mirroredStyles) {
				mirror.style[name] = style[name];
			}
			mirrorStyled = true;
		}
		mirror.style.width = `${input.clientWidth}px`;
		const marker = document.createElement('span');
		marker.textContent = '\u200b';
		mirror.replaceChildren(input.value, marker);
		const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || marker.offsetHeight;
		const place = enhanceButtonPlacement(
			{ left: marker.offsetLeft, top: marker.offsetTop, lineHeight, width: input.clientWidth, height: input.clientHeight, scrollTop: input.scrollTop },
			{ width: enhanceFloat.offsetWidth, height: enhanceFloat.offsetHeight },
		);
		enhanceFloat.style.transform = `translate(${place.x}px, ${place.y}px)`;
		if (place.below !== below) {
			// Room for the button on a line of its own; changes only when it moves to or from one.
			below = place.below;
			inputWrap.classList.toggle('enhance-below', below);
		}
	});
}

/** Puts `text` in the input as one edit the user can undo. */
function replaceInput(text: string): void {
	input.readOnly = false;
	input.focus();
	input.select();
	// insertText keeps the textarea's undo history; setting the value would wipe it.
	if (!document.execCommand('insertText', false, text)) {
		input.value = text;
	}
	autoGrow();
	updateSendState();
}

/** Starts rewriting the draft, or cancels the rewrite running. */
export function toggleEnhance(): void {
	if (phase.kind === 'working') {
		cancelEnhance();
		return;
	}
	const draft = input.value;
	if (!draft.trim()) {
		return;
	}
	const requestId = nextRequestId++;
	showNote('');
	setPhase({ kind: 'working', requestId, original: enhanceOriginal(phase, draft) });
	ui.announce.textContent = strings.enhancing;
	vscode.postMessage({ type: 'enhancePrompt', requestId, text: draft, attachments: state.attachments });
}

/** Stops the rewrite; the draft stays as it was. */
export function cancelEnhance(): void {
	if (phase.kind !== 'working') {
		return;
	}
	vscode.postMessage({ type: 'cancelEnhance', requestId: phase.requestId });
	showNote('');
	setPhase({ kind: 'idle' });
	input.focus();
}

/** The rewrite arrived: it replaces the draft, and Revert is offered. */
export function onEnhanced(requestId: number, text: string): void {
	if (!acceptsEnhanceReply(phase, requestId)) {
		return;
	}
	const rewrite = enhanceText(text);
	showNote('');
	// Set first: replacing the text fires an input event, which must see the rewrite.
	setPhase({ kind: 'done', original: phase.original, rewrite });
	replaceInput(rewrite);
	ui.announce.textContent = strings.enhanced;
}

export function onEnhanceFailed(requestId: number, message: string): void {
	if (!acceptsEnhanceReply(phase, requestId)) {
		return;
	}
	setPhase({ kind: 'idle' });
	showNote(message, true);
	updateRow();
	input.focus();
}

/** Esc cancels a rewrite and the shortcut starts or cancels one; true if the key was handled. */
export function onEnhanceKey(event: KeyboardEvent): boolean {
	if (event.key === 'Escape' && phase.kind === 'working') {
		cancelEnhance();
		return true;
	}
	if (isEnhanceShortcut(event, mac)) {
		toggleEnhance();
		return true;
	}
	return false;
}

/** Puts back what the user wrote before enhancing. */
function revert(): void {
	if (phase.kind !== 'done') {
		return;
	}
	const original = phase.original;
	setPhase({ kind: 'idle' });
	replaceInput(original);
	input.setSelectionRange(original.length, original.length);
}

onComposerChange(() => {
	const next = enhancePhaseAfterInput(phase, input.value);
	if (next !== phase) {
		setPhase(next);
	}
	if (!input.value.trim()) {
		prepared = false;
	} else if (!prepared) {
		// Opening the rewrite's session now saves that time on the click.
		prepared = true;
		vscode.postMessage({ type: 'prepareEnhance' });
	}
	updateRow();
});
/** Measures the input's text style again, as after a resize, and moves the pill. */
function restyleEnhanceButton(): void {
	mirrorStyled = false;
	placeButton();
}

input.addEventListener('scroll', placeButton, { passive: true });
new ResizeObserver(restyleEnhanceButton).observe(input);
input.addEventListener('input', () => {
	// A failure note goes once the user changes the draft.
	if (enhanceNote.classList.contains('error')) {
		showNote('');
		updateRow();
	}
});
// Esc and the shortcut also work with the focus on the buttons, as after clicking one.
form.addEventListener('keydown', event => {
	if (!event.defaultPrevented && !event.isComposing && onEnhanceKey(event)) {
		event.preventDefault();
		event.stopPropagation();
	}
});
enhanceButton.addEventListener('click', event => {
	event.stopPropagation();
	toggleEnhance();
});
revertButton.addEventListener('click', event => {
	event.stopPropagation();
	revert();
});
setPhase({ kind: 'idle' });
