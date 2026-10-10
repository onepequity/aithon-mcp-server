#!/usr/bin/env node
/**
 * CLI entry: `npx aithon-mcp-server` runs the relay over stdio.
 * stdout carries the MCP protocol, so all diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { createRemote } from './remote.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `aithon-mcp-server ${VERSION}

Stdio MCP server that relays tool calls to the Aithon marketplace.

Environment:
  AITHON_API_KEY     Agent API key (needed for order_draft, availability_check, mandate_get)
  AITHON_CATALOG     Optional catalog slug; scopes calls to /c/<slug>
  AITHON_BASE_URL    Default https://aithon.tech
  AITHON_MCP_URL     Streamable HTTP endpoint (default <base>/mcp)
  AITHON_RPC_URL     Legacy JSON-RPC endpoint (default <base>/api/v1/mcp/rpc)
  AITHON_TRANSPORT   auto (default) | mcp | legacy
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
  const remote = createRemote(config, log);
  const server = createServer(config, remote);

  log(`v${VERSION} relaying to ${remote.describe()}${config.apiKey ? '' : ' (no AITHON_API_KEY: catalog tools only)'}`);

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await remote.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  log(err instanceof ConfigError ? `configuration error: ${err.message}` : `fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
