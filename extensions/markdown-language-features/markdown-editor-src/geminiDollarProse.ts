/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pandoc's rule for dollar math, which the rich editor's renderMath applies
// (see geminiDollarText.ts): inline content that starts or ends with a space
// is prose between two dollar signs, such as prices, not math.

/** Whether inline math's content is really prose between two dollar signs. */
export function isDollarProse(latex: string, displayMode: boolean): boolean {
	return !displayMode && latex.length > 0 && (/^\s/.test(latex) || /\s$/.test(latex));
}
