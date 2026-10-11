/**
 * End-to-end: spawn the built CLI over stdio, exactly as an MCP client would
 * via `npx aithon-mcp-server`, and relay to a loopback mock remote.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_TOOLS } from '../src/tools.snapshot.js';
import { okResult, startMockMcp, tierRequiredResult, type MockHandle } from './helpers/mockRemote.js';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let mock: MockHandle | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await mock?.close();
  client = undefined;
  mock = undefined;
});

beforeAll(() => {
  if (!existsSync(bin)) throw new Error('dist/index.js is missing: run `npm run build` first');
});

async function spawnRelay(env: Record<string, string>): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const c = new Client({ name: 'cli-test', version: '0' });
  await c.connect(transport);
  return { client: c, stderr: () => stderr };
}

describe('aithon-mcp-server CLI', () => {
  it('prints its version', () => {
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits non-zero with a clear message on bad configuration', () => {
    let stderr = '';
    try {
      execFileSync(process.execPath, [bin], { env: { ...process.env, AITHON_MCP_URL: 'http://example.com/mcp' }, stdio: 'pipe' });
    } catch (err: any) {
      stderr = String(err.stderr);
    }
    expect(stderr).toMatch(/configuration error: AITHON_MCP_URL must use https/);
  });

  it('mirrors the remote tools over stdio and relays calls', async () => {
    mock = await startMockMcp({
      'catalog.search': (args) => okResult([{ id: 'svc-1', matched: args.query }]),
      'quote.get': () => tierRequiredResult(1, 0),
    });
    const relay = await spawnRelay({ AITHON_MCP_URL: mock.url, AITHON_TRANSPORT: 'legacy' });
    client = relay.client;

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['catalog_search', 'quote_get']);

    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'fiber' } });
    expect(result.structuredContent).toEqual({ results: [{ id: 'svc-1', matched: 'fiber' }] });

    const gated = await client.callTool({ name: 'quote_get', arguments: { quote_id: 'x' } });
    expect(gated.isError).toBe(true);
    expect((gated.structuredContent as any).hint).toMatch(/Get an API key/);
    expect(relay.stderr()).toMatch(/AITHON_TRANSPORT=legacy is no longer supported/);
  });

  it('falls back to the bundled snapshot when the remote is unreachable', async () => {
    const dead = await startMockMcp({});
    const url = dead.url;
    await dead.close();
    const relay = await spawnRelay({ AITHON_MCP_URL: url, AITHON_TIMEOUT_MS: '2000' });
    client = relay.client;

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(SNAPSHOT_TOOLS.length);
    expect(relay.stderr().match(/bundled snapshot/g)).toHaveLength(1);
  });
});
