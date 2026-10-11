/**
 * Tool mirroring.
 *
 * The relay does not hardcode any tools. It asks the remote for its tools/list
 * and exposes every tool it finds, with the same description and inputSchema.
 * Only the name changes: Aithon uses dotted names (`order.draft`), and several
 * MCP clients (and the model APIs behind them) only accept [A-Za-z0-9_-], so
 * each dot becomes an underscore (`order_draft`).
 *
 * If the remote list cannot be fetched, a bundled snapshot is served instead.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SNAPSHOT_TOOLS } from './tools.snapshot.js';

/** A tool definition as returned by the remote tools/list. */
export type RemoteTool = Pick<Tool, 'name' | 'inputSchema'> &
  Partial<Pick<Tool, 'title' | 'description' | 'outputSchema' | 'annotations'>>;

export interface MirroredTool {
  /** Name exposed to the local MCP client, e.g. `order_draft`. */
  localName: string;
  /** Name on the remote endpoint, e.g. `order.draft`. */
  remoteName: string;
  /** Definition served to the local client. */
  definition: Tool;
}

export type ToolSource = 'remote' | 'snapshot';

/** `order.draft` -> `order_draft`. Any character outside [A-Za-z0-9_-] becomes `_`. */
export function toLocalName(remoteName: string): string {
  return remoteName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Build the local view of a remote tool list. Later duplicates of a local name are dropped. */
export function mirrorTools(tools: RemoteTool[], log?: (message: string) => void): MirroredTool[] {
  const seen = new Map<string, string>();
  const mirrored: MirroredTool[] = [];
  for (const tool of tools) {
    const localName = toLocalName(tool.name);
    const clash = seen.get(localName);
    if (clash !== undefined) {
      log?.(`remote tools ${clash} and ${tool.name} both map to ${localName}; keeping ${clash}`);
      continue;
    }
    seen.set(localName, tool.name);
    const definition: Tool = { name: localName, inputSchema: tool.inputSchema };
    if (tool.title !== undefined) definition.title = tool.title;
    if (tool.description !== undefined) definition.description = tool.description;
    if (tool.outputSchema !== undefined) definition.outputSchema = tool.outputSchema;
    if (tool.annotations !== undefined) definition.annotations = tool.annotations;
    mirrored.push({ localName, remoteName: tool.name, definition });
  }
  return mirrored;
}

export interface ToolLister {
  describe(): string;
  listTools(timeoutMs?: number): Promise<RemoteTool[]>;
}

export interface ToolCatalogOptions {
  log?: (message: string) => void;
  /** Timeout for fetching the remote list. Kept short so a dead remote does not stall the client. */
  listTimeoutMs?: number;
  /** While serving the snapshot, retry the remote at most this often. */
  retryMs?: number;
  snapshot?: RemoteTool[];
  now?: () => number;
}

export const DEFAULT_LIST_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_MS = 60_000;

/**
 * Caches the mirrored tool list. A remote list, once fetched, is kept for the
 * process lifetime unless invalidate() is called (on notifications/tools/list_changed).
 * The snapshot fallback is kept too, but the remote is retried on later lists.
 */
export class ToolCatalog {
  private tools?: MirroredTool[];
  private byName = new Map<string, MirroredTool>();
  private loading?: Promise<MirroredTool[]>;
  private lastAttempt = 0;
  private stale = false;
  private loggedFallback = false;
  source?: ToolSource;

  private readonly log: (message: string) => void;
  private readonly listTimeoutMs: number;
  private readonly retryMs: number;
  private readonly snapshot: RemoteTool[];
  private readonly now: () => number;

  constructor(
    private readonly remote: ToolLister,
    options: ToolCatalogOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.snapshot = options.snapshot ?? SNAPSHOT_TOOLS;
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<MirroredTool[]> {
    const fresh = this.source === 'remote' || this.now() - this.lastAttempt < this.retryMs;
    if (this.tools && !this.stale && fresh) return this.tools;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Find a tool by local name, or by its remote dotted name. */
  async resolve(name: string): Promise<MirroredTool | undefined> {
    const tools = await this.list();
    return this.byName.get(name) ?? tools.find((t) => t.remoteName === name);
  }

  /** Refetch the remote list on the next list(). */
  invalidate(): void {
    this.stale = true;
  }

  private async load(): Promise<MirroredTool[]> {
    this.lastAttempt = this.now();
    this.stale = false;
    try {
      this.set(mirrorTools(await this.remote.listTools(this.listTimeoutMs), this.log), 'remote');
      if (this.loggedFallback) this.log(`fetched the live tool list from ${this.remote.describe()}; snapshot no longer in use`);
      this.loggedFallback = false;
    } catch (err) {
      // A previously fetched remote list beats the snapshot.
      if (this.source !== 'remote') {
        if (!this.loggedFallback) {
          const detail = err instanceof Error ? err.message : String(err);
          this.log(
            `could not fetch the tool list from ${this.remote.describe()} (${detail}); serving the bundled snapshot of ${this.snapshot.length} tools`,
          );
          this.loggedFallback = true;
        }
        this.set(mirrorTools(this.snapshot, this.log), 'snapshot');
      }
    }
    return this.tools!;
  }

  private set(tools: MirroredTool[], source: ToolSource): void {
    this.tools = tools;
    this.byName = new Map(tools.map((t) => [t.localName, t]));
    this.source = source;
  }
}
