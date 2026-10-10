/**
 * Local MCP server: exposes the Aithon tools and forwards each call to a Remote.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AithonConfig } from './config.js';
import { RemoteError, toolErrorResult, type Remote } from './remote.js';
import { TOOLS, type AithonTool } from './tools.js';
import { VERSION } from './version.js';

export { loadConfig, ConfigError, type AithonConfig } from './config.js';
export { createRemote, McpRemote, LegacyRpcRemote, AutoRemote, RemoteError, type Remote } from './remote.js';
export { TOOLS, type AithonTool } from './tools.js';
export { VERSION } from './version.js';

/** JSON-RPC style error codes used in local error results. */
export const ErrorCode = {
  MissingApiKey: -32001,
  RemoteUnavailable: -32002,
} as const;

export const API_KEY_HELP =
  'Set AITHON_API_KEY in the environment of this MCP server (see the "Get an API key" section of the README). ' +
  'catalog_search, catalog_get and catalog_order_schema_get work without a key.';

export function missingKeyResult(tool: AithonTool): CallToolResult {
  return toolErrorResult({
    code: ErrorCode.MissingApiKey,
    message: `${tool.name} requires an Aithon agent API key, but AITHON_API_KEY is not set. ${API_KEY_HELP}`,
  });
}

export function remoteFailureResult(tool: AithonTool, err: unknown): CallToolResult {
  const status = err instanceof RemoteError ? err.status : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (status === 401 || status === 403) {
    hint = ' The remote rejected the credentials: check that AITHON_API_KEY is valid and not revoked.';
  } else if (status === 404 || status === 405) {
    hint = ' The endpoint was not found: check AITHON_MCP_URL / AITHON_RPC_URL / AITHON_CATALOG.';
  } else if (status === 429) {
    hint = ' Rate limited by the remote: wait and retry.';
  }
  return toolErrorResult({
    code: ErrorCode.RemoteUnavailable,
    message: `${tool.name} could not reach Aithon: ${detail}.${hint}`,
  });
}

/** Call one tool, turning local precondition failures and transport errors into MCP error results. */
export async function relayToolCall(
  config: Pick<AithonConfig, 'apiKey'>,
  remote: Remote,
  tool: AithonTool,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (tool.requiresApiKey && !config.apiKey) return missingKeyResult(tool);
  try {
    return await remote.callTool(tool, args);
  } catch (err) {
    return remoteFailureResult(tool, err);
  }
}

export function createServer(config: AithonConfig, remote: Remote): McpServer {
  const server = new McpServer(
    { name: 'aithon', version: VERSION },
    {
      instructions:
        'Aithon is a B2B marketplace for enterprise technology services. Use catalog_search to find services, ' +
        'catalog_get and catalog_order_schema_get to inspect pricing and ordering requirements, and order_draft to ' +
        'prepare a cart a human can review and check out. availability_check and mandate_get require an API key ' +
        'and an owner-issued mandate.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => relayToolCall(config, remote, tool, args ?? {}),
    );
  }

  return server;
}
