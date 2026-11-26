/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { designPrompt, designWarnings, figmaLinksIn, nextSizes } from '../../src/acp/figmaDesign';

const frame = (file: string, node: string) => `https://www.figma.com/design/${file}/Collection?node-id=${node}`;

describe('figmaDesign', () => {
	it('finds the frame links in pasted text, in order, once each', () => {
		const text = `XS ${frame('k7Qx', '12-301')}\nS ${frame('k7Qx', '12-388')}, and again ${frame('k7Qx', '12-301')}. Not this: https://example.com/a`;
		expect(figmaLinksIn(text)).toEqual([frame('k7Qx', '12-301'), frame('k7Qx', '12-388')]);
	});

	it('gives new links the team\'s sizes in order, skipping the ones used', () => {
		expect([nextSizes(3, ['XS', 'S', 'M', 'L'], ['S']), nextSizes(2, ['Mobile', 'Desktop'], ['Mobile', 'Desktop'])]).toEqual([['XS', 'M', 'L'], ['Desktop', 'Desktop']]);
	});

	it('warns about a frame in another file and a size used twice', () => {
		expect(designWarnings([
			{ size: 'XS', url: frame('k7Qx', '12-301') },
			{ size: 'M', url: frame('k7Qx', '12-388') },
			{ size: 'M', url: frame('k7Qx', '12-455') },
			{ size: 'L', url: frame('Zp41', '88-12') },
		])).toEqual({ otherFile: ['L'], repeated: ['M'] });
	});

	it('tells the agent each size\'s link and to read them one size at a time', () => {
		expect(designPrompt([{ size: 'XS', url: frame('k7Qx', '12-301') }, { size: 'L', url: frame('k7Qx', '12-520') }]).split('\n').slice(0, 4)).toEqual([
			'Figma design, one frame for each screen size:',
			`- XS: ${frame('k7Qx', '12-301')}`,
			`- L: ${frame('k7Qx', '12-520')}`,
			'',
		]);
	});
});
