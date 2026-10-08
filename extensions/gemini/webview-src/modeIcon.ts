/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A codicon for each of gemini-cli's approval modes, shared by the chat and Agent Home. */
export function modeIcon(id: string): string {
	switch (id) {
		case 'default': return 'shield';
		case 'autoEdit': return 'edit';
		case 'plan': return 'checklist';
		case 'yolo': return 'warning';
		default: return 'circle-large-outline';
	}
}
