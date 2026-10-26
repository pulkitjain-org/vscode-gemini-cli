/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		testTimeout: 20_000,
		// The tests' throwaway repositories commit unsigned, whatever the user's global git config
		// asks for: signing through an agent such as 1Password slows every test commit, or fails it
		// when the agent is locked.
		env: {
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'commit.gpgsign',
			GIT_CONFIG_VALUE_0: 'false',
			GIT_CONFIG_KEY_1: 'tag.gpgsign',
			GIT_CONFIG_VALUE_1: 'false',
		},
	},
});
