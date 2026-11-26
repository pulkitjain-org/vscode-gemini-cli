/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Confluence, in a bundle of its own (dist/confluence.js, out/confluence.js),
// loaded the first time an agent or a page uses it: its client, the agents'
// calls, the drafts and the Review Page. Like dist/pages.js, it has its own
// copy of every module it imports, so what it needs of the extension's state
// (its requests, the Confluence sites, the audited write) comes in through
// `ConfluenceFeature`'s constructor; test/perf/chunks.test.ts checks that.

export { ConfluenceFeature } from './host/confluenceFeature';
