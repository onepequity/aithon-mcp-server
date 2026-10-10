import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AithonConfig } from '../src/config.js';
import { AutoRemote, LegacyRpcRemote, McpRemote, createRemote, type Remote } from '../src/remote.js';
import { ErrorCode, createServer } from '../src/server.js';
import { okResult, startMockMcp, startMockRpc, type MockHandle } from './helpers/mockRemote.js';

const PLACEHOLDER_KEY = 'ait_test_placeholder_key';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(handle: MockHandle): MockHandle {
  cleanups.push(handle.close);
  return handle;
}

async function connectLocal(config: AithonConfig, remote: Remote = createRemote(config, () => undefined)) {
  const server = createServer(config, remote);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await remote.close();
  });
  return client;
}

function errorOf(result: unknown): { code: number; message: string } {
  return (result as CallToolResult & { structuredContent: { error: { code: number; message: string } } }).structuredContent.error;
}

const catalogRows = [{ id: 'svc-1', name: 'Fiber 1G', category: 'dedicated-internet', provider: 'ExampleCo', pricing: { display: '$500/mo' } }];

describe('tool surface', () => {
  it('exposes the six Aithon tools with JSON Schemas', async () => {
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: 'http://127.0.0.1:9/mcp' }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'catalog_search',
      'catalog_get',
      'catalog_order_schema_get',
      'order_draft',
      'availability_check',
      'mandate_get',
    ]);
    const draft = tools.find((t) => t.name === 'order_draft')!;
    expect(draft.inputSchema.required).toEqual(['service_id', 'session_id']);
    for (const tool of tools) expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('rejects malformed arguments locally', async () => {
    const mock = track(await startMockMcp({}));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'order_draft', arguments: { service_id: 'svc-1', session_id: 'short' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/session_id/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('missing API key', () => {
  it.each(['order_draft', 'availability_check', 'mandate_get'])('%s fails fast with a clear message', async (name) => {
    const mock = track(await startMockMcp({}));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_TRANSPORT: 'mcp' }));
    const args =
      name === 'order_draft'
        ? { service_id: 'svc-1', session_id: 'session-123' }
        : name === 'availability_check'
          ? { address: '2200 Ross Ave, Dallas, TX 75201' }
          : {};
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(ErrorCode.MissingApiKey);
    expect(errorOf(result).message).toContain('AITHON_API_KEY is not set');
    expect(mock.requests).toHaveLength(0);
  });

  it('catalog tools work anonymously and send no Authorization header', async () => {
    const mock = track(await startMockMcp({ 'catalog.search': () => okResult(catalogRows) }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_TRANSPORT: 'mcp' }));
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'fiber' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ results: catalogRows });
    expect(mock.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });
});

describe('Streamable HTTP relay', () => {
  it('forwards calls with the bearer key and dotted remote names', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const mock = track(
      await startMockMcp({
        'catalog.get': (args) => (seen.push({ name: 'catalog.get', args }), okResult({ id: args.service_id, name: 'Fiber 1G' })),
        'mandate.get': () => okResult({ mandates: [] }),
      }),
    );
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY, AITHON_TRANSPORT: 'mcp' }));

    const got = await client.callTool({ name: 'catalog_get', arguments: { service_id: 'svc-1' } });
    expect(got.structuredContent).toEqual({ id: 'svc-1', name: 'Fiber 1G' });
    expect(seen).toEqual([{ name: 'catalog.get', args: { service_id: 'svc-1' } }]);

    const mandates = await client.callTool({ name: 'mandate_get', arguments: {} });
    expect(mandates.structuredContent).toEqual({ mandates: [] });

    expect(mock.requests.length).toBeGreaterThan(0);
    for (const req of mock.requests) {
      expect(req.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
      expect(req.headers['user-agent']).toMatch(/^aithon-mcp-server\//);
    }
  });

  it('maps order_draft to cart.draft.create when the remote has not renamed it yet', async () => {
    const mock = track(
      await startMockMcp({ 'cart.draft.create': (args) => okResult({ draft_type: 'cart_item', session_id: args.session_id }) }),
    );
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY, AITHON_TRANSPORT: 'mcp' }));
    const result = await client.callTool({ name: 'order_draft', arguments: { service_id: 'svc-1', session_id: 'session-123' } });
    expect(result.structuredContent).toEqual({ draft_type: 'cart_item', session_id: 'session-123' });
  });

  it('passes remote tool errors through unchanged', async () => {
    const remoteError: CallToolResult = {
      content: [{ type: 'text', text: '{"error":{"code":-32003,"message":"No mandate"}}' }],
      structuredContent: { error: { code: -32003, message: 'No mandate' } },
      isError: true,
    };
    const mock = track(await startMockMcp({ 'availability.check': () => remoteError }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY, AITHON_TRANSPORT: 'mcp' }));
    const result = await client.callTool({ name: 'availability_check', arguments: { address: { line1: '2200 Ross Ave', state: 'TX' } } });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({ code: -32003, message: 'No mandate' });
  });

  it('reports auth failures with a hint about the key', async () => {
    const mock = track(await startMockMcp({}, { status: 401 }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY, AITHON_TRANSPORT: 'mcp' }));
    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(ErrorCode.RemoteUnavailable);
    expect(errorOf(result).message).toMatch(/AITHON_API_KEY is valid/);
  });

  it('reports unreachable remotes without crashing and retries on the next call', async () => {
    const mock = track(await startMockMcp({ 'catalog.search': () => okResult([]) }));
    const url = mock.url;
    await mock.close();
    const config = loadConfig({ AITHON_MCP_URL: url, AITHON_TRANSPORT: 'mcp', AITHON_TIMEOUT_MS: '2000' });
    const client = await connectLocal(config);
    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(errorOf(result).message).toMatch(/could not reach Aithon/);
  });
});

describe('legacy JSON-RPC relay', () => {
  it('calls aithon.* methods and wraps results like the MCP endpoint', async () => {
    const rpc = track(
      await startMockRpc((method, params) => ({
        body: { jsonrpc: '2.0', id: 1, result: method === 'aithon.catalog.search' ? catalogRows : { echo: params } },
      })),
    );
    const client = await connectLocal(loadConfig({ AITHON_RPC_URL: rpc.url, AITHON_TRANSPORT: 'legacy', AITHON_API_KEY: PLACEHOLDER_KEY }));

    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'fiber', limit: 5 } });
    expect(result.structuredContent).toEqual({ results: catalogRows });
    expect(rpc.requests[0].body).toMatchObject({ jsonrpc: '2.0', method: 'aithon.catalog.search', params: { query: 'fiber', limit: 5 } });
    expect(rpc.requests[0].headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(rpc.requests[0].headers['x-api-key']).toBe(PLACEHOLDER_KEY);

    await client.callTool({ name: 'order_draft', arguments: { service_id: 'svc-1', session_id: 'session-123' } });
    expect(rpc.requests[1].body.method).toBe('aithon.cart.draft.create');
  });

  it('turns JSON-RPC errors into tool errors', async () => {
    const rpc = track(
      await startMockRpc(() => ({ body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: aithon.catalog.order_schema.get' } } })),
    );
    const client = await connectLocal(loadConfig({ AITHON_RPC_URL: rpc.url, AITHON_TRANSPORT: 'legacy' }));
    const result = await client.callTool({ name: 'catalog_order_schema_get', arguments: { service_id: 'svc-1' } });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({ code: -32601, message: 'Method not found: aithon.catalog.order_schema.get' });
  });

  it('explains that MCP-only tools are unavailable over legacy JSON-RPC', async () => {
    const rpc = track(await startMockRpc(() => ({ body: {} })));
    const client = await connectLocal(loadConfig({ AITHON_RPC_URL: rpc.url, AITHON_TRANSPORT: 'legacy', AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'mandate_get', arguments: {} });
    expect(result.isError).toBe(true);
    expect(errorOf(result).message).toMatch(/only available on the Aithon MCP endpoint/);
    expect(rpc.requests).toHaveLength(0);
  });
});

describe('auto transport', () => {
  it('prefers the MCP endpoint when it exists', async () => {
    const mcp = track(await startMockMcp({ 'catalog.search': () => okResult(catalogRows) }));
    const rpc = track(await startMockRpc(() => ({ body: { jsonrpc: '2.0', id: 1, result: [] } })));
    const config = loadConfig({ AITHON_MCP_URL: mcp.url, AITHON_RPC_URL: rpc.url });
    const remote = createRemote(config, () => undefined);
    expect(remote).toBeInstanceOf(AutoRemote);
    const client = await connectLocal(config, remote);
    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.structuredContent).toEqual({ results: catalogRows });
    expect(rpc.requests).toHaveLength(0);
    expect(remote.describe()).toBe(`mcp ${config.mcpUrl}`);
  });

  it('falls back to legacy JSON-RPC when the MCP endpoint answers 404', async () => {
    const mcp = track(await startMockMcp({}, { status: 404 }));
    const rpc = track(await startMockRpc(() => ({ body: { jsonrpc: '2.0', id: 1, result: catalogRows } })));
    const logs: string[] = [];
    const config = loadConfig({ AITHON_MCP_URL: mcp.url, AITHON_RPC_URL: rpc.url });
    const remote = new AutoRemote(new McpRemote(config), new LegacyRpcRemote(config), (m) => logs.push(m));
    const client = await connectLocal(config, remote);

    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.structuredContent).toEqual({ results: catalogRows });
    expect(logs.join('\n')).toMatch(/HTTP 404; falling back/);
    expect(remote.describe()).toBe(`legacy-rpc ${config.rpcUrl}`);

    await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(mcp.requests).toHaveLength(1);
    expect(rpc.requests).toHaveLength(2);
  });

  it('does not mask auth failures by falling back', async () => {
    const mcp = track(await startMockMcp({}, { status: 401 }));
    const rpc = track(await startMockRpc(() => ({ body: { jsonrpc: '2.0', id: 1, result: [] } })));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mcp.url, AITHON_RPC_URL: rpc.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(rpc.requests).toHaveLength(0);
  });
});
