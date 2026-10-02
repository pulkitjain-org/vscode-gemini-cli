/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Branch names for Create Branch & Commit (plan Phase 2B, composer-extras).

/** A branch name such as "gemini/fix-login-redirect" from an agent's title. */
export function branchNameFrom(title: string): string {
	const slug = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
	return `gemini/${slug || 'changes'}`;
}

/** The common rules of `git check-ref-format --branch`. */
export function isValidBranchName(name: string): boolean {
	return !!name && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock')
		&& !name.includes('..') && !name.includes('//') && !name.includes('@{') && name !== '@'
		&& !/[\x00-\x20~^:?*[\\\x7f]/.test(name) && !name.split('/').some(part => part.startsWith('.'));
}
