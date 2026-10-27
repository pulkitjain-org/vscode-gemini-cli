/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pages opened on request, in a bundle of their own (dist/pages.js,
// out/pages.js), loaded the first time one of their commands runs
// (`LazyFeature`, src/host/lazyFeature.ts): Project Helpers, Connections, and
// Plan Review (the first time a plan is reviewed), and the page of Log Time,
// Move, Open Merge Request, Run Checks and a merge request review.
//
// This bundle has its own copy of every module it imports. A module that
// keeps state (configuration.ts' CLI folders, teamCommands.ts' store) must be
// the extension bundle's, so what these pages need of it comes in through
// their constructors, never an import; test/perf/chunks.test.ts checks that.

export { ConnectionsPage } from './host/connectionsPage';
export { SettingsPage } from './host/settingsPage';
export { PlanReviews } from './host/planReviewPage';
export { TeamFlowPanel } from './host/teamFlowPanel';
export { AgentFilesPages } from './host/agentFilesPage';
