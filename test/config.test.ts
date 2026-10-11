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
      catalog: undefined,
      timeoutMs: 30_000,
      warnings: [],
    });
  });

  it('scopes the endpoint to a catalog slug', () => {
    expect(loadConfig({ AITHON_CATALOG: 'acme-it' }).mcpUrl).toBe('https://aithon.tech/c/acme-it/mcp');
  });

  it('lets an explicit URL override the default', () => {
    const config = loadConfig({ AITHON_CATALOG: 'acme-it', AITHON_MCP_URL: 'http://localhost:4000/mcp' });
    expect(config.mcpUrl).toBe('http://localhost:4000/mcp');
  });

  it('still accepts the 0.1.x transport values, warning about removed legacy options', () => {
    expect(loadConfig({ AITHON_TRANSPORT: 'mcp' }).warnings).toEqual([]);
    expect(loadConfig({ AITHON_TRANSPORT: 'AUTO' }).warnings).toEqual([]);
    const legacy = loadConfig({ AITHON_TRANSPORT: 'legacy', AITHON_RPC_URL: 'https://example.com/rpc' });
    expect(legacy.mcpUrl).toBe('https://aithon.tech/mcp');
    expect(legacy.warnings).toHaveLength(2);
    expect(legacy.warnings.join('\n')).toMatch(/AITHON_TRANSPORT=legacy is no longer supported/);
    expect(legacy.warnings.join('\n')).toMatch(/AITHON_RPC_URL is ignored/);
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
