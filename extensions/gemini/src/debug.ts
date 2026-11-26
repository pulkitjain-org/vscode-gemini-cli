/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode, in a bundle of its own (dist/debug.js, out/debug.js), loaded
// the first time one of its commands runs or a start finds a Debug mode that
// did not end: the debugger bridge, marked lines, the agent's Debug mode,
// the endpoint and the Evidence page. Only its commands and the
// `geminicode-debug` server's route are in the extension's bundle
// (src/host/debug/debugEntry.ts); what it needs of the extension's state
// comes through `DebugFeature`'s constructor; test/perf/chunks.test.ts checks that.

export { DebugFeature } from './host/debug/debugFeature';
