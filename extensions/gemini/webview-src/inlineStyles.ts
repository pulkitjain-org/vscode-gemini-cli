/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The views' content security policy allows no inline `style` attributes, so
// the ones in HTML from KaTeX (fraction bars, superscript offsets) and
// markdown-it (table column alignment) are dropped when the HTML is set with
// innerHTML. Styles set through the DOM are allowed, so they are re-applied
// that way. Only for HTML from those renderers: never from the agent itself.

/** Applies the `style` attributes under `root` through the DOM, so the CSP lets them work. */
export function applyInlineStyles(root: ParentNode): void {
	for (const node of root.querySelectorAll<HTMLElement | SVGElement>('[style]')) {
		const css = node.getAttribute('style') ?? '';
		node.removeAttribute('style');
		node.style.cssText = css;
	}
}
