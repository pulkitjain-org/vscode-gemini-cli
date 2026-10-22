/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Words inside identifiers. SQLite's full-text tokenizer already splits
// snake_case (an underscore is punctuation to it) but keeps `applyDiscount`
// as one word, so the words of camelCase names go in a column of their own:
// "apply discount" then finds `applyDiscount`, and so does `applyDiscount`.

const identifierPattern = /[A-Za-z][A-Za-z0-9]*/g;
/** Kept short: the column is for matching words, not storing text. */
const maxWords = 400;

/** The words of `name`: `parseHTTPResponse2` → `parse`, `http`, `response2`. */
export function splitIdentifier(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(word => word.length > 1);
}

/** The distinct words of the camelCase identifiers in `text`, space-separated, for the index's `idents` column. */
export function identifierWords(text: string): string {
	const words = new Set<string>();
	for (const match of text.matchAll(identifierPattern)) {
		const identifier = match[0];
		if (!/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(identifier)) {
			continue;
		}
		for (const word of splitIdentifier(identifier)) {
			words.add(word);
			if (words.size >= maxWords) {
				return [...words].join(' ');
			}
		}
	}
	return [...words].join(' ');
}
