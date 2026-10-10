import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { VERSION } from '../src/version.js';

describe('loadConfig', () => {
  it('defaults to the public aithon.tech endpoints with no key', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      apiKey: undefined,
      mcpUrl: 'https://aithon.tech/mcp',
      rpcUrl: 'https://aithon.tech/api/v1/mcp/rpc',
      transport: 'auto',
      catalog: undefined,
      timeoutMs: 30_000,
    });
  });

  it('scopes both endpoints to a catalog slug', () => {
    const config = loadConfig({ AITHON_CATALOG: 'acme-it' });
    expect(config.mcpUrl).toBe('https://aithon.tech/c/acme-it/mcp');
    expect(config.rpcUrl).toBe('https://aithon.tech/c/acme-it/api/v1/mcp/rpc');
  });

  it('lets explicit URLs override the defaults', () => {
    const config = loadConfig({
      AITHON_CATALOG: 'acme-it',
      AITHON_MCP_URL: 'https://example.com/custom/mcp',
      AITHON_RPC_URL: 'http://localhost:4000/rpc',
    });
    expect(config.mcpUrl).toBe('https://example.com/custom/mcp');
    expect(config.rpcUrl).toBe('http://localhost:4000/rpc');
  });

  it('trims the API key and treats blank as absent', () => {
    expect(loadConfig({ AITHON_API_KEY: '  ait_placeholder  ' }).apiKey).toBe('ait_placeholder');
    expect(loadConfig({ AITHON_API_KEY: '   ' }).apiKey).toBeUndefined();
  });

  it('refuses plain http to non-loopback hosts so keys are never sent in clear text', () => {
    expect(() => loadConfig({ AITHON_MCP_URL: 'http://example.com/mcp' })).toThrow(ConfigError);
    expect(() => loadConfig({ AITHON_BASE_URL: 'ftp://example.com' })).toThrow(/https/);
  });

  it('rejects bad catalog slugs, transports and timeouts', () => {
    expect(() => loadConfig({ AITHON_CATALOG: '../admin' })).toThrow(/catalog slug/);
    expect(() => loadConfig({ AITHON_TRANSPORT: 'sse' })).toThrow(/AITHON_TRANSPORT/);
    expect(() => loadConfig({ AITHON_TIMEOUT_MS: '-1' })).toThrow(/AITHON_TIMEOUT_MS/);
  });

  it('keeps VERSION in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
