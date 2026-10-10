/**
 * Mock Aithon remotes bound to 127.0.0.1 on an ephemeral port. Tests never
 * touch the real network.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface MockHandle {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type MockToolHandler = (args: Record<string, unknown>, headers: IncomingHttpHeaders) => CallToolResult;

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function listen(server: Server, path: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}${path}`;
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Stateless Streamable HTTP MCP server, shaped like the real Aithon endpoint. */
export async function startMockMcp(
  tools: Record<string, MockToolHandler>,
  opts: { path?: string; status?: number } = {},
): Promise<MockHandle> {
  const path = opts.path ?? '/mcp';
  const requests: RecordedRequest[] = [];

  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

    if (opts.status) return json(res, opts.status, { error: 'forced status' });
    if (req.url !== path) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') {
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    }

    const mcp = new McpServer({ name: 'aithon', version: '1.0.0' });
    for (const [name, handler] of Object.entries(tools)) {
      mcp.registerTool(name, { description: `mock ${name}`, inputSchema: z.object({}).passthrough() }, async (args) =>
        handler(args as Record<string, unknown>, req.headers),
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  return { url: await listen(server, path), requests, close: closer(server) };
}

/** Legacy `aithon.*` JSON-RPC endpoint. */
export async function startMockRpc(
  handler: (method: string, params: any, headers: IncomingHttpHeaders) => { status?: number; body: unknown },
  path = '/api/v1/mcp/rpc',
): Promise<MockHandle> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
    if (req.url !== path || req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    const out = handler(body.method, body.params, req.headers);
    json(res, out.status ?? 200, out.body);
  });
  return { url: await listen(server, path), requests, close: closer(server) };
}

/** Text result helper, matching the real server's encoding. */
export function okResult(value: unknown): CallToolResult {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { results: value };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: structured };
}
