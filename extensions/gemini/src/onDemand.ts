/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tools used rarely and never on a path anyone waits on, in a bundle of their
// own (dist/onDemand.js, out/onDemand.js), loaded the first time one of their
// commands runs (`LazyFeature`, src/host/lazyFeature.ts).
//
// This bundle has its own copy of every module it imports. A module that
// keeps state (configuration.ts, modelPreference.ts, traceCommand.ts'
// recording) must be the extension bundle's, so what these
// tools need of it comes in through their constructors, never an import;
// test/perf/chunks.test.ts checks that. Trying an agent's changes in the
// workspace and Merge Back are here too: most windows never use them. So is
// Check Agent, with the CLI contract it reads, and rebuilding a plan the CLI
// deleted (sessionReplay.ts).

export { AgentMerge } from './host/agents/agentMerge';
export { AgentTries } from './host/agents/agentTries';
export { AuditPage } from './host/auditPage';
export { BenchmarkCommand } from './host/benchmarkCommand';
export { checkAgent } from './host/checkAgent';
export { DesignSystemSync } from './host/designSystemSync';
export { EditorToolsHost } from './host/editorToolsHost';
export { designSystemNoteFor } from './acp/designSystem';
export { figmaDesignSystem } from './acp/designTokens';
export { TraceRecorder } from './host/traceRecorder';
export { cloneFor } from './host/reviewClone';
export { FigmaDesktop } from './acp/figma';
export { pickAssignee } from './host/assigneePicker';
export { projectStrings } from './host/chat/projectStrings';
export { rebuildSessionFile } from './acp/sessionReplay';
