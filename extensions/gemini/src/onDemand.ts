/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tools used rarely and never on a path anyone waits on, in a bundle of their
// own (dist/onDemand.js, out/onDemand.js), loaded the first time one of their
// commands runs (`LazyFeature`, src/host/lazyFeature.ts).
//
// This bundle has its own copy of every module it imports. A module that
// keeps state (configuration.ts, modelPreference.ts, pilotLog.ts' sink,
// traceCommand.ts' recording) must be the extension bundle's, so what these
// tools need of it comes in through their constructors, never an import;
// test/perf/chunks.test.ts checks that.

export { AuditPage } from './host/auditPage';
export { BenchmarkCommand } from './host/benchmarkCommand';
export { Pilot } from './host/pilot';
export { TraceRecorder } from './host/traceRecorder';
export { cloneFor } from './host/reviewClone';
