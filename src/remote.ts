/**
 * Remote relays.
 *
 * McpRemote speaks Streamable HTTP to the Aithon MCP endpoint using the
 * official SDK client. LegacyRpcRemote speaks the older `aithon.*` JSON-RPC
 * protocol published as rpc_url in /.well-known/mcp.json. AutoRemote picks
 * MCP when the endpoint exists and falls back to legacy JSON-RPC otherwise.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AithonConfig } from './config.js';
import type { AithonTool } from './tools.js';
import { USER_AGENT, VERSION } from './version.js';

export interface Remote {
  /** Human-readable label for logs, e.g. "mcp https://aithon.tech/mcp". */
  describe(): string;
  callTool(tool: AithonTool, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** A transport-level failure talking to the remote (not a tool error). */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

type Logger = (message: string) => void;

const defaultLogger: Logger = (message) => process.stderr.write(`[aithon-mcp-server] ${message}\n`);

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Mirrors the remote server: structuredContent must be an object, so lists are wrapped as { results }. */
export function toCallToolResult(result: unknown): CallToolResult {
  const structured =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { results: result };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: structured };
}

export function toolErrorResult(error: { code: number; message: string; data?: unknown }): CallToolResult {
  const payload = { error: error.data === undefined ? { code: error.code, message: error.message } : error };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function toRemoteError(err: unknown, url: string): RemoteError {
  if (err instanceof RemoteError) return err;
  if (err instanceof StreamableHTTPError) return new RemoteError(`${url}: ${err.message}`, err.code);
  const message = err instanceof Error ? err.message : String(err);
  return new RemoteError(`${url}: ${message}`);
}

export class McpRemote implements Remote {
  private client?: Client;
  private connecting?: Promise<Client>;
  private remoteToolNames?: Set<string>;

  constructor(private readonly config: AithonConfig) {}

  describe(): string {
    return `mcp ${this.config.mcpUrl}`;
  }

  /** Connect (once) and cache the remote tool list. Throws RemoteError on failure. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.open().catch((err) => {
      this.connecting = undefined;
      throw toRemoteError(err, this.config.mcpUrl);
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
      requestInit: { headers: { 'User-Agent': USER_AGENT, ...authHeaders(this.config.apiKey) } },
    });
    const client = new Client({ name: 'aithon-mcp-server', version: VERSION });
    try {
      await client.connect(transport, { timeout: this.config.timeoutMs });
      const listed = await client.listTools(undefined, { timeout: this.config.timeoutMs });
      this.remoteToolNames = new Set(listed.tools.map((t) => t.name));
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    return client;
  }

  /** Pick the first candidate name the remote actually exposes. */
  resolveRemoteName(tool: AithonTool): string {
    const names = this.remoteToolNames;
    return tool.remoteNames.find((n) => names?.has(n)) ?? tool.remoteNames[0];
  }

  async callTool(tool: AithonTool, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.connect();
    try {
      const result = await client.callTool(
        { name: this.resolveRemoteName(tool), arguments: args },
        undefined,
        { timeout: this.config.timeoutMs },
      );
      return result as CallToolResult;
    } catch (err) {
      throw toRemoteError(err, this.config.mcpUrl);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.close().catch(() => undefined);
  }
}

export class LegacyRpcRemote implements Remote {
  private nextId = 1;

  constructor(
    private readonly config: AithonConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  describe(): string {
    return `legacy-rpc ${this.config.rpcUrl}`;
  }

  async callTool(tool: AithonTool, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!tool.legacyMethod) {
      return toolErrorResult({
        code: -32601,
        message:
          `${tool.name} is only available on the Aithon MCP endpoint (${this.config.mcpUrl}), ` +
          'not on the legacy JSON-RPC endpoint. Set AITHON_TRANSPORT=mcp once that endpoint is live.',
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...authHeaders(this.config.apiKey),
    };
    // The legacy endpoint documents x-api-key; send it alongside the bearer header.
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey;

    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: tool.legacyMethod, params: args }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw toRemoteError(err, this.config.rpcUrl);
    }

    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RemoteError(`${this.config.rpcUrl}: HTTP ${response.status}, response was not JSON`, response.status);
    }

    if (body && typeof body === 'object' && body.error) {
      const { code, message, data } = body.error;
      return toolErrorResult({ code: Number(code) || -32603, message: String(message ?? 'Remote error'), data });
    }
    if (!response.ok) {
      throw new RemoteError(`${this.config.rpcUrl}: HTTP ${response.status}`, response.status);
    }
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw new RemoteError(`${this.config.rpcUrl}: malformed JSON-RPC response`, response.status);
    }
    return toCallToolResult(body.result);
  }

  async close(): Promise<void> {}
}

/** HTTP statuses that mean "no MCP endpoint here", as opposed to auth or server failures. */
const MISSING_ENDPOINT_STATUSES = new Set([404, 405]);

export class AutoRemote implements Remote {
  private active?: Remote;
  private choosing?: Promise<Remote>;

  constructor(
    private readonly mcp: McpRemote,
    private readonly legacy: LegacyRpcRemote,
    private readonly log: Logger = defaultLogger,
  ) {}

  describe(): string {
    return this.active ? this.active.describe() : `auto (${this.mcp.describe()}, fallback ${this.legacy.describe()})`;
  }

  private async choose(): Promise<Remote> {
    try {
      await this.mcp.connect();
      return this.mcp;
    } catch (err) {
      if (err instanceof RemoteError && err.status !== undefined && MISSING_ENDPOINT_STATUSES.has(err.status)) {
        this.log(`MCP endpoint answered HTTP ${err.status}; falling back to ${this.legacy.describe()}`);
        return this.legacy;
      }
      throw err;
    }
  }

  async callTool(tool: AithonTool, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.active) {
      this.choosing ??= this.choose().finally(() => {
        this.choosing = undefined;
      });
      this.active = await this.choosing;
    }
    return this.active.callTool(tool, args);
  }

  async close(): Promise<void> {
    await Promise.all([this.mcp.close(), this.legacy.close()]);
  }
}

export function createRemote(config: AithonConfig, log: Logger = defaultLogger): Remote {
  switch (config.transport) {
    case 'mcp':
      return new McpRemote(config);
    case 'legacy':
      return new LegacyRpcRemote(config);
    default:
      return new AutoRemote(new McpRemote(config), new LegacyRpcRemote(config), log);
  }
}
