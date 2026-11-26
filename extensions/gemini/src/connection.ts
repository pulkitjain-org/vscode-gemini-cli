/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The JSON-RPC connection to an ACP agent, with the ACP SDK and the zod it
// validates with, in a bundle of its own (dist/connection.js,
// out/connection.js): the agent starts seconds after the window opens, and
// nothing else needs the SDK as a value, so the extension's own bundle never
// carries it (`AgentRuntimeOptions.connectionModule`). It throws nothing the
// extension bundle checks with instanceof: its timeout error carries an
// `info` as `AgentError` does, which `classifyAgentError` reads.

export { AgentConnection, defaultSetupTimeouts } from './acp/agentConnection';
// The benchmark speaks ACP with its own client, so it lives with the SDK.
export * as benchmark from './acp/benchmark';
