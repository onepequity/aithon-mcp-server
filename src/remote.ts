/**
 * Remote relay: speaks Streamable HTTP to the Aithon MCP endpoint using the
 * official SDK client.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AithonConfig } from './config.js';
import type { RemoteTool, ToolLister } from './tools.js';
import { USER_AGENT, VERSION } from './version.js';

export interface Remote extends ToolLister {
  /** Human-readable label for logs, e.g. "https://aithon.tech/mcp". */
  describe(): string;
  /** List every remote tool (all pages). */
  listTools(timeoutMs?: number): Promise<RemoteTool[]>;
  /** Call a tool by its remote (dotted) name. Throws RemoteError on transport failures and McpError on JSON-RPC errors. */
  callTool(remoteName: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Register a callback for notifications/tools/list_changed from the remote. */
  onToolsChanged(callback: () => void): void;
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

function toRemoteError(err: unknown, url: string): RemoteError {
  if (err instanceof RemoteError) return err;
  if (err instanceof StreamableHTTPError) return new RemoteError(`${url}: ${err.message}`, err.code);
  const message = err instanceof Error ? err.message : String(err);
  return new RemoteError(`${url}: ${message}`);
}

export class McpRemote implements Remote {
  private client?: Client;
  private connecting?: Promise<Client>;
  private toolsChanged?: () => void;

  constructor(private readonly config: AithonConfig) {}

  describe(): string {
    return this.config.mcpUrl;
  }

  onToolsChanged(callback: () => void): void {
    this.toolsChanged = callback;
  }

  /** Connect once; a failed attempt is retried on the next call. Throws RemoteError. */
  private async connect(timeoutMs: number): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.open(timeoutMs).catch((err) => {
      this.connecting = undefined;
      throw toRemoteError(err, this.config.mcpUrl);
    });
    return this.connecting;
  }

  private async open(timeoutMs: number): Promise<Client> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), { requestInit: { headers } });
    const client = new Client({ name: 'aithon-mcp-server', version: VERSION });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.toolsChanged?.());
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    return client;
  }

  async listTools(timeoutMs = this.config.timeoutMs): Promise<RemoteTool[]> {
    const client = await this.connect(timeoutMs);
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      throw toRemoteError(err, this.config.mcpUrl);
    }
    return tools;
  }

  async callTool(remoteName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.connect(this.config.timeoutMs);
    try {
      return (await client.callTool({ name: remoteName, arguments: args }, undefined, {
        timeout: this.config.timeoutMs,
      })) as CallToolResult;
    } catch (err) {
      if (isRemoteProtocolError(err)) throw err;
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

/**
 * A JSON-RPC error the remote server returned for a request (for example
 * invalid params), as opposed to a local timeout or a dropped connection.
 */
export function isRemoteProtocolError(err: unknown): err is McpError {
  return err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed;
}

export function createRemote(config: AithonConfig): Remote {
  return new McpRemote(config);
}
