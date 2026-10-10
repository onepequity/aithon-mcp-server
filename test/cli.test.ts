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
import { okResult, startMockMcp, type MockHandle } from './helpers/mockRemote.js';

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

  it('serves the tools over stdio and relays to the remote', async () => {
    mock = await startMockMcp({ 'catalog.search': (args) => okResult([{ id: 'svc-1', matched: args.query }]) });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { PATH: process.env.PATH ?? '', AITHON_MCP_URL: mock.url, AITHON_TRANSPORT: 'mcp' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'cli-test', version: '0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);

    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'fiber' } });
    expect(result.structuredContent).toEqual({ results: [{ id: 'svc-1', matched: 'fiber' }] });

    const noKey = await client.callTool({ name: 'mandate_get', arguments: {} });
    expect(noKey.isError).toBe(true);
  });
});
