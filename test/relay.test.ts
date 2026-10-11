import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AithonConfig } from '../src/config.js';
import { createRemote, type Remote } from '../src/remote.js';
import { API_KEY_DOCS_URL, ErrorCode, createServer } from '../src/server.js';
import { ToolCatalog, toLocalName, type RemoteTool } from '../src/tools.js';
import { SNAPSHOT_TOOLS } from '../src/tools.snapshot.js';
import { okResult, startMockMcp, tierRequiredResult, type MockHandle } from './helpers/mockRemote.js';

const PLACEHOLDER_KEY = 'ait_test_placeholder_key';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(handle: MockHandle): MockHandle {
  cleanups.push(handle.close);
  return handle;
}

async function connectLocal(config: AithonConfig, opts: { remote?: Remote; logs?: string[] } = {}) {
  const remote = opts.remote ?? createRemote(config);
  const server = createServer(config, remote, { log: (m) => opts.logs?.push(m) });
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

function structured(result: unknown): any {
  return (result as CallToolResult).structuredContent;
}

const REMOTE_TOOLS: Tool[] = [
  {
    name: 'catalog.search',
    description: 'Search scoped catalog',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'catalog.order_schema.get',
    description: 'Get machine-orderable schema for a scoped service',
    inputSchema: { type: 'object', properties: { service_id: { type: 'string' } }, required: ['service_id'] },
  },
  {
    name: 'order.draft',
    description: 'Draft an order from one of your confirmed quotes.',
    inputSchema: {
      type: 'object',
      properties: { quote_id: { type: 'string', format: 'uuid' } },
      required: ['quote_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'quote.request',
    description: 'Request a quote for a scoped service.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        client_reference: { type: 'string', minLength: 8 },
        address: { anyOf: [{ type: 'string' }, { type: 'object', properties: { line1: { type: 'string' } } }] },
      },
      required: ['service_id', 'client_reference'],
    },
  },
];

const QUOTE_ID = '3f2b8c1e-5d4a-4e7b-9c1a-2b3c4d5e6f70';

describe('name mapping', () => {
  it('turns dotted remote names into client-safe names', () => {
    expect(toLocalName('order.draft')).toBe('order_draft');
    expect(toLocalName('catalog.order_schema.get')).toBe('catalog_order_schema_get');
    expect(toLocalName('cart.draft.create')).toBe('cart_draft_create');
  });
});

describe('tool mirroring', () => {
  it('exposes every remote tool with mapped names and unchanged description and inputSchema', async () => {
    const mock = track(await startMockMcp({}, { tools: REMOTE_TOOLS }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['catalog_search', 'catalog_order_schema_get', 'order_draft', 'quote_request']);
    for (const [i, tool] of tools.entries()) {
      expect(tool.description).toBe(REMOTE_TOOLS[i].description);
      expect(tool.inputSchema).toEqual(REMOTE_TOOLS[i].inputSchema);
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('caches the remote list for the process lifetime', async () => {
    const mock = track(await startMockMcp({}, { tools: REMOTE_TOOLS }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    await client.listTools();
    await client.listTools();
    await client.listTools();
    expect(mock.requests.filter((r) => r.body?.method === 'tools/list')).toHaveLength(1);
  });

  it('routes calls to the dotted remote name with arguments intact', async () => {
    const mock = track(
      await startMockMcp(
        {
          'order.draft': (args) => okResult({ order_id: 'ord-1', quote_id: args.quote_id }),
          'quote.request': (args) => okResult({ quote_id: QUOTE_ID, status: 'pending', echo: args }),
        },
        { tools: REMOTE_TOOLS },
      ),
    );
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));

    const quoteArgs = {
      service_id: 'svc-1',
      client_reference: 'ref-00000001',
      address: { line1: '2200 Ross Ave', city: 'Dallas', state: 'TX', zip: '75201' },
      quantity: 2,
      service_configuration: { bandwidth: '1G', nested: { a: [1, 2] } },
    };
    const quote = await client.callTool({ name: 'quote_request', arguments: quoteArgs });
    expect(structured(quote)).toEqual({ quote_id: QUOTE_ID, status: 'pending', echo: quoteArgs });

    const draft = await client.callTool({ name: 'order_draft', arguments: { quote_id: QUOTE_ID } });
    expect(draft.isError).toBeFalsy();
    expect(structured(draft)).toEqual({ order_id: 'ord-1', quote_id: QUOTE_ID });

    expect(mock.calls).toEqual([
      { name: 'quote.request', args: quoteArgs },
      { name: 'order.draft', args: { quote_id: QUOTE_ID } },
    ]);
  });

  it('rejects names the remote does not expose', async () => {
    const mock = track(await startMockMcp({}, { tools: REMOTE_TOOLS }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    await expect(client.callTool({ name: 'mandate_get', arguments: {} })).rejects.toThrow(/Unknown tool: mandate_get/);
    expect(mock.calls).toHaveLength(0);
  });

  it('refetches the list when invalidated (tools/list_changed)', async () => {
    let tools: RemoteTool[] = REMOTE_TOOLS.slice(0, 1);
    const catalog = new ToolCatalog({ describe: () => 'mock', listTools: async () => tools });
    expect((await catalog.list()).map((t) => t.localName)).toEqual(['catalog_search']);
    tools = REMOTE_TOOLS;
    expect(await catalog.list()).toHaveLength(1);
    catalog.invalidate();
    expect(await catalog.list()).toHaveLength(4);
  });
});

describe('snapshot fallback', () => {
  it('serves the bundled snapshot and logs once when the remote is down', async () => {
    const mock = await startMockMcp({});
    const url = mock.url;
    await mock.close();
    const logs: string[] = [];
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: url, AITHON_TIMEOUT_MS: '2000' }), { logs });

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(SNAPSHOT_TOOLS.length);
    expect(tools.map((t) => t.name)).toEqual(SNAPSHOT_TOOLS.map((t) => toLocalName(t.name)));
    const draft = tools.find((t) => t.name === 'order_draft')!;
    expect(draft.inputSchema.required).toEqual(['quote_id']);

    await client.listTools();
    expect(logs.filter((l) => l.includes('bundled snapshot'))).toHaveLength(1);

    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe(ErrorCode.RemoteUnavailable);
    expect(structured(result).error.message).toMatch(/could not reach Aithon/);
  });

  it('switches to the live list once the remote answers again', async () => {
    let up = false;
    let now = 0;
    const catalog = new ToolCatalog(
      {
        describe: () => 'mock',
        listTools: async () => {
          if (!up) throw new Error('ECONNREFUSED');
          return REMOTE_TOOLS;
        },
      },
      { retryMs: 1000, now: () => now },
    );
    expect(await catalog.list()).toHaveLength(SNAPSHOT_TOOLS.length);
    expect(catalog.source).toBe('snapshot');
    up = true;
    expect(await catalog.list()).toHaveLength(SNAPSHOT_TOOLS.length);
    now = 1000;
    expect(await catalog.list()).toHaveLength(REMOTE_TOOLS.length);
    expect(catalog.source).toBe('remote');
  });

  it('snapshot matches the live production shape (11 tools, quote flow)', () => {
    expect(SNAPSHOT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'availability.check',
        'cart.draft.create',
        'catalog.get',
        'catalog.order_schema.get',
        'catalog.search',
        'mandate.get',
        'order.draft',
        'order.get',
        'quote.cancel',
        'quote.get',
        'quote.request',
      ].sort(),
    );
  });
});

describe('auth and tiers', () => {
  it('sends the bearer key on every request when AITHON_API_KEY is set', async () => {
    const mock = track(await startMockMcp({ 'catalog.search': () => okResult([]) }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    await client.listTools();
    await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(mock.requests.length).toBeGreaterThan(0);
    for (const req of mock.requests) {
      expect(req.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
      expect(req.headers['user-agent']).toMatch(/^aithon-mcp-server\//);
    }
  });

  it('sends no Authorization header without a key', async () => {
    const mock = track(await startMockMcp({ 'catalog.search': () => okResult([{ id: 'svc-1' }]) }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'fiber' } });
    expect(structured(result)).toEqual({ results: [{ id: 'svc-1' }] });
    expect(mock.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it('passes tier_required through with a README hint when no key is set', async () => {
    const mock = track(await startMockMcp({ 'quote.get': () => tierRequiredResult(1, 0) }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    const result = await client.callTool({ name: 'quote_get', arguments: { quote_id: QUOTE_ID } });

    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.error).toEqual({ code: -32010, message: 'tier_required', data: { required_tier: 1, tier: 0 } });
    expect(sc.required_tier).toBe(1);
    expect(sc.hint).toMatch(/AITHON_API_KEY is not set/);
    expect(sc.hint).toContain(API_KEY_DOCS_URL);
    const texts = (result.content as Array<{ text: string }>).map((c) => c.text);
    expect(JSON.parse(texts[0]).error.message).toBe('tier_required');
    expect(texts[1]).toBe(sc.hint);
    expect(mock.calls).toEqual([{ name: 'quote.get', args: { quote_id: QUOTE_ID } }]);
  });

  it('passes tier_required through without the README hint when a key is set', async () => {
    const mock = track(await startMockMcp({ 'mandate.get': () => tierRequiredResult(1, 0) }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'mandate_get', arguments: {} });

    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.error.message).toBe('tier_required');
    expect(sc.required_tier).toBe(1);
    expect(sc.hint).toMatch(/needs access tier 1/);
    expect(sc.hint).not.toContain(API_KEY_DOCS_URL);
  });

  it('handles tier_required sent as a JSON-RPC error', async () => {
    const mock = track(
      await startMockMcp({
        'order.get': () => {
          throw new McpError(-32010, 'tier_required', { required_tier: 1, tier: 0 });
        },
      }),
    );
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url }));
    const result = await client.callTool({ name: 'order_get', arguments: { order_id: QUOTE_ID } });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toEqual({ code: -32010, message: 'tier_required', data: { required_tier: 1, tier: 0 } });
    expect(structured(result).hint).toContain(API_KEY_DOCS_URL);
  });

  it('passes other remote tool errors through unchanged', async () => {
    const remoteError: CallToolResult = {
      content: [{ type: 'text', text: '{"error":{"code":-32004,"message":"Quote not found"}}' }],
      structuredContent: { error: { code: -32004, message: 'Quote not found' } },
      isError: true,
    };
    const mock = track(await startMockMcp({ 'quote.get': () => remoteError }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'quote_get', arguments: { quote_id: QUOTE_ID } });
    expect(result).toEqual(remoteError);
  });

  it('reports HTTP auth failures with a hint about the key', async () => {
    const mock = track(await startMockMcp({}, { status: 401 }));
    const client = await connectLocal(loadConfig({ AITHON_MCP_URL: mock.url, AITHON_API_KEY: PLACEHOLDER_KEY }));
    const result = await client.callTool({ name: 'catalog_search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe(ErrorCode.RemoteUnavailable);
    expect(structured(result).error.message).toMatch(/AITHON_API_KEY is valid/);
  });
});

describe('README', () => {
  it('documents every snapshot tool', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const tool of SNAPSHOT_TOOLS) {
      expect(readme).toContain(`| \`${toLocalName(tool.name)}\` | \`${tool.name}\``);
    }
  });
});
