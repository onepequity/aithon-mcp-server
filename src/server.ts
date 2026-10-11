/**
 * Local MCP server: mirrors the remote tool list and forwards each call to it.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode as McpErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { AithonConfig } from './config.js';
import { RemoteError, isRemoteProtocolError, type Remote } from './remote.js';
import { DEFAULT_LIST_TIMEOUT_MS, ToolCatalog } from './tools.js';
import { VERSION } from './version.js';

export { loadConfig, ConfigError, type AithonConfig } from './config.js';
export { createRemote, McpRemote, RemoteError, type Remote } from './remote.js';
export { ToolCatalog, mirrorTools, toLocalName, type MirroredTool, type RemoteTool } from './tools.js';
export { SNAPSHOT_TOOLS } from './tools.snapshot.js';
export { VERSION } from './version.js';

/** Error code used in local error results when the remote cannot be reached. */
export const ErrorCode = {
  RemoteUnavailable: -32002,
} as const;

export const API_KEY_DOCS_URL = 'https://github.com/onepequity/aithon-mcp-server#get-an-api-key';

export function toolErrorResult(error: { code: number; message: string; data?: unknown }): CallToolResult {
  const payload = { error: error.data === undefined ? { code: error.code, message: error.message } : error };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

export function remoteFailureResult(toolName: string, err: unknown): CallToolResult {
  const status = err instanceof RemoteError ? err.status : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (status === 401 || status === 403) {
    hint = ' The remote rejected the credentials: check that AITHON_API_KEY is valid and not revoked.';
  } else if (status === 404 || status === 405) {
    hint = ' The endpoint was not found: check AITHON_MCP_URL / AITHON_CATALOG.';
  } else if (status === 429) {
    hint = ' Rate limited by the remote: wait and retry.';
  }
  return toolErrorResult({
    code: ErrorCode.RemoteUnavailable,
    message: `${toolName} could not reach Aithon: ${detail}.${hint}`,
  });
}

interface ToolError {
  code?: number;
  message?: string;
  data?: { required_tier?: number; tier?: number; [key: string]: unknown };
}

/** Pull `{ error }` out of a tool result, from structuredContent or the first JSON text block. */
function toolErrorOf(result: CallToolResult): ToolError | undefined {
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const first = result.content?.[0];
    if (first?.type === 'text') {
      try {
        payload = JSON.parse(first.text);
      } catch {
        return undefined;
      }
    }
  }
  const error = (payload as { error?: unknown } | undefined)?.error;
  return error !== null && typeof error === 'object' ? (error as ToolError) : undefined;
}

function isTierRequired(error: ToolError | undefined): error is ToolError {
  return error?.message === 'tier_required' || typeof error?.data?.required_tier === 'number';
}

/**
 * Keep the server's tier_required error intact and add a readable explanation,
 * plus a pointer to the README when the call was anonymous.
 */
export function explainTierRequired(toolName: string, result: CallToolResult, hasApiKey: boolean): CallToolResult {
  const error = toolErrorOf(result);
  if (!result.isError || !isTierRequired(error)) return result;

  const required = error.data?.required_tier;
  const current = error.data?.tier;
  let hint =
    `tier_required: ${toolName} needs access tier ${required ?? 'unknown'}` +
    (current === undefined ? '.' : ` and this caller is tier ${current}.`) +
    ' Tier 1 is a registered agent whose owner has verified their email.';
  hint += hasApiKey
    ? ' AITHON_API_KEY is set, but its agent is below that tier (for tier 1, the owner must verify their email).'
    : ` AITHON_API_KEY is not set, so this call was anonymous. See "Get an API key": ${API_KEY_DOCS_URL}`;

  const structured = result.structuredContent ?? { error };
  return {
    ...result,
    content: [...(result.content ?? []), { type: 'text', text: hint }],
    structuredContent: { ...structured, required_tier: required, hint },
    isError: true,
  };
}

const INSTRUCTIONS =
  'Aithon is a B2B marketplace for enterprise technology services. Use catalog_search to find services and ' +
  'catalog_get / catalog_order_schema_get to inspect pricing and ordering requirements (no API key needed). ' +
  'To buy: quote_request, wait for the supplier to confirm, poll quote_get until the quote is confirmed, then ' +
  'order_draft with the quote_id; the signer named on the owner mandate completes the order. Tools other than the ' +
  'catalog tools need an API key with access tier 1 and return tier_required otherwise.';

export interface CreateServerOptions {
  catalog?: ToolCatalog;
  log?: (message: string) => void;
}

export function createServer(config: AithonConfig, remote: Remote, options: CreateServerOptions = {}): Server {
  const catalog =
    options.catalog ??
    new ToolCatalog(remote, { log: options.log, listTimeoutMs: Math.min(config.timeoutMs, DEFAULT_LIST_TIMEOUT_MS) });

  const server = new Server(
    { name: 'aithon', version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );

  remote.onToolsChanged(() => {
    catalog.invalidate();
    void server.sendToolListChanged().catch(() => undefined);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await catalog.list()).map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = await catalog.resolve(name);
    if (!tool) throw new McpError(McpErrorCode.InvalidParams, `Unknown tool: ${name}`);

    let result: CallToolResult;
    try {
      result = await remote.callTool(tool.remoteName, args);
    } catch (err) {
      if (!isRemoteProtocolError(err)) return remoteFailureResult(tool.localName, err);
      // The remote answered with a JSON-RPC error: pass its code, message and data through.
      const message = err.message.replace(/^(MCP error -?\d+: )+/, '');
      result = toolErrorResult({ code: err.code, message, data: err.data });
    }
    return explainTierRequired(tool.localName, result, Boolean(config.apiKey));
  });

  return server;
}
