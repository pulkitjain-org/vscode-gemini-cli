/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What gemini-cli says about the MCP tool a permission request is for. No
// imports and no state, since the transcript and the project tools, which load
// in different bundles, both read it.

/** The MCP server and tool gemini-cli 0.67 names in a permission request's tool call `_meta`; undefined when it names none. */
export function mcpToolFromMeta(meta: unknown): { readonly server: string; readonly tool: string } | undefined {
	const mcp = (meta as { readonly 'gemini-cli'?: { readonly mcp?: { readonly server_name?: unknown; readonly tool_name?: unknown } } } | null | undefined)?.['gemini-cli']?.mcp;
	const server = typeof mcp?.server_name === 'string' ? mcp.server_name.trim() : '';
	const tool = typeof mcp?.tool_name === 'string' ? mcp.tool_name.trim() : '';
	return server && tool && server !== 'generic_server' && tool !== 'generic_tool' ? { server, tool } : undefined;
}
