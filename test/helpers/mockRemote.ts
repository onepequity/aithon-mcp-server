/**
 * Mock Aithon MCP remote bound to 127.0.0.1 on an ephemeral port. Tests never
 * touch the real network.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface MockHandle {
  url: string;
  requests: RecordedRequest[];
  /** tools/call requests received: remote name and raw arguments. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Return a result, or throw McpError to answer with a JSON-RPC error. */
export type MockToolHandler = (args: Record<string, unknown>, headers: IncomingHttpHeaders) => CallToolResult;

export interface MockOptions {
  /** Tool definitions for tools/list. Defaults to a minimal definition per handler. */
  tools?: Tool[];
  path?: string;
  /** Answer every HTTP request with this status. */
  status?: number;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Stateless Streamable HTTP MCP server, shaped like the real Aithon endpoint. */
export async function startMockMcp(handlers: Record<string, MockToolHandler>, opts: MockOptions = {}): Promise<MockHandle> {
  const path = opts.path ?? '/mcp';
  const requests: RecordedRequest[] = [];
  const calls: MockHandle['calls'] = [];
  const tools: Tool[] =
    opts.tools ?? Object.keys(handlers).map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: 'object' } }));

  const http: HttpServer = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

    if (opts.status) return json(res, opts.status, { error: 'forced status' });
    if (req.url !== path) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') {
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    }

    const mcp = new Server({ name: 'aithon', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
      return handler(args, req.headers);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    requests,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** Text result helper, matching the real server's encoding. */
export function okResult(value: unknown): CallToolResult {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { results: value };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: structured };
}

/** The tier_required tool error exactly as production returns it. */
export function tierRequiredResult(requiredTier = 1, tier = 0): CallToolResult {
  const payload = { error: { code: -32010, message: 'tier_required', data: { required_tier: requiredTier, tier } } };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
