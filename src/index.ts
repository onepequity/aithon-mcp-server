#!/usr/bin/env node
/**
 * CLI entry: `npx aithon-mcp-server` runs the relay over stdio.
 * stdout carries the MCP protocol, so all diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { createRemote } from './remote.js';
import { createServer } from './server.js';
import { DEFAULT_LIST_TIMEOUT_MS, ToolCatalog } from './tools.js';
import { VERSION } from './version.js';

const HELP = `aithon-mcp-server ${VERSION}

Stdio MCP server that mirrors the Aithon marketplace tools and relays calls to them.

Environment:
  AITHON_API_KEY     Agent API key, sent as a bearer token (the server decides which tools need it)
  AITHON_CATALOG     Optional catalog slug; scopes calls to /c/<slug>/mcp
  AITHON_BASE_URL    Default https://aithon.tech
  AITHON_MCP_URL     Streamable HTTP endpoint (default <base>/mcp)
  AITHON_TRANSPORT   auto (default) | mcp; legacy is ignored since 0.2.0
  AITHON_TIMEOUT_MS  Per-request timeout, default 30000
`;

function log(message: string): void {
  process.stderr.write(`[aithon-mcp-server] ${message}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  for (const warning of config.warnings) log(`warning: ${warning}`);

  const remote = createRemote(config);
  const catalog = new ToolCatalog(remote, { log, listTimeoutMs: Math.min(config.timeoutMs, DEFAULT_LIST_TIMEOUT_MS) });
  const server = createServer(config, remote, { catalog, log });

  log(`v${VERSION} relaying to ${remote.describe()}${config.apiKey ? '' : ' (no AITHON_API_KEY: anonymous, catalog tools only)'}`);

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await remote.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  // Fetch the remote tool list now so the client's first tools/list is fast.
  void catalog.list();
}

main().catch((err) => {
  log(err instanceof ConfigError ? `configuration error: ${err.message}` : `fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
