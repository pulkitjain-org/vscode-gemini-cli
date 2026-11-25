/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Time limits in tests. A limit is written for a developer's machine, where
// it catches work that became many times slower (a loop gone quadratic); a
// hosted CI runner is a few times slower and shares its cores, so a single
// run there can take several times as long with nothing wrong. `medianMs`
// takes the middle of a few runs, which one slow run does not move, and
// `limitMs` widens the limit under CI.

/** How many times slower than a developer's machine a hosted CI runner may be. */
const ciFactor = 4;

/** The limit `ms` as this machine is held to it: as written locally, `ciFactor` times that under CI. */
export function limitMs(ms: number): number {
	return process.env.CI ? ms * ciFactor : ms;
}

/** Median time of `run` over `rounds` runs, in ms. */
export function medianMs(rounds: number, run: () => void): number {
	const times: number[] = [];
	for (let i = 0; i < rounds; i++) {
		const start = performance.now();
		run();
		times.push(performance.now() - start);
	}
	return times.sort((a, b) => a - b)[Math.floor(rounds / 2)];
}
