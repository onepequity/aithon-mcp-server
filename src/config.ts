/**
 * Environment configuration.
 *
 * Every value has a safe default so `npx aithon-mcp-server` works with no
 * setup for the public catalog tools. AITHON_API_KEY is only needed for the
 * tools that act on behalf of a registered agent; the server decides which.
 */

export interface AithonConfig {
  /** Bearer key for the Aithon agent API, or undefined for anonymous use. */
  apiKey?: string;
  /** Streamable HTTP MCP endpoint. */
  mcpUrl: string;
  /** Optional catalog slug; scopes the endpoint to /c/:catalogSlug. */
  catalog?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Non-fatal configuration notices (deprecated variables) to log at startup. */
  warnings: string[];
}

export const DEFAULT_BASE_URL = 'https://aithon.tech';
export const DEFAULT_TIMEOUT_MS = 30_000;

const CATALOG_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Parse and validate a remote URL. The API key travels in a header, so plain
 * http is refused for anything other than a loopback address.
 */
export function parseRemoteUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
  throw new ConfigError(`${name} must use https (plain http is only allowed for localhost): ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AithonConfig {
  const warnings: string[] = [];
  const catalog = clean(env.AITHON_CATALOG);
  if (catalog && !CATALOG_SLUG.test(catalog)) {
    throw new ConfigError(`AITHON_CATALOG must be a catalog slug (letters, digits, "-" or "_"): ${catalog}`);
  }

  const baseUrl = parseRemoteUrl(clean(env.AITHON_BASE_URL) ?? DEFAULT_BASE_URL, 'AITHON_BASE_URL');
  const origin = new URL(baseUrl).origin;
  const scoped = catalog ? `/c/${encodeURIComponent(catalog)}/mcp` : '/mcp';
  const mcpUrl = parseRemoteUrl(clean(env.AITHON_MCP_URL) ?? `${origin}${scoped}`, 'AITHON_MCP_URL');

  // AITHON_TRANSPORT keeps accepting its 0.1.x values. Since 0.2.0 the only
  // transport is Streamable HTTP MCP: `auto` and `mcp` are equivalent, and
  // `legacy` (the old aithon.* JSON-RPC endpoint) is ignored with a warning.
  const transport = (clean(env.AITHON_TRANSPORT) ?? 'auto').toLowerCase();
  if (transport !== 'auto' && transport !== 'mcp' && transport !== 'legacy') {
    throw new ConfigError(`AITHON_TRANSPORT must be one of auto, mcp, legacy: ${transport}`);
  }
  if (transport === 'legacy') {
    warnings.push('AITHON_TRANSPORT=legacy is no longer supported (removed in 0.2.0); using the MCP endpoint');
  }
  if (clean(env.AITHON_RPC_URL)) {
    warnings.push('AITHON_RPC_URL is ignored since 0.2.0; the relay only uses AITHON_MCP_URL');
  }

  const timeoutRaw = clean(env.AITHON_TIMEOUT_MS);
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`AITHON_TIMEOUT_MS must be a positive number of milliseconds: ${timeoutRaw}`);
  }

  return { apiKey: clean(env.AITHON_API_KEY), mcpUrl, catalog, timeoutMs, warnings };
}
