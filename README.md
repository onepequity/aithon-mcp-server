# aithon-mcp-server

[![CI](https://github.com/onepequity/aithon-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/onepequity/aithon-mcp-server/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP client (Claude Desktop, Claude Code, Cursor, and others) access to the [Aithon](https://aithon.tech) marketplace. It runs locally and relays each tool call to Aithon's hosted agent endpoint.

## What Aithon is, for agents

Aithon is a B2B marketplace for enterprise technology services: business and dedicated internet, ethernet, voice, UCaaS, SD-WAN, managed IT, cloud connectivity, wireless and more. It is a live transactional catalog with real pricing, not a knowledge base.

With this server an agent can:

1. **Search** the catalog and read service details and pricing.
2. **Inspect the order schema** for a service to learn whether it can be ordered by an agent and which fields are needed.
3. **Draft an order**: build a cart a human reviews and checks out. Nothing is purchased by the agent.
4. **Check availability** of suppliers at a US business address, and **read the mandates** its owner has granted.

Machine-readable discovery files: [`/.well-known/mcp.json`](https://aithon.tech/.well-known/mcp.json), [`/.well-known/agents.json`](https://aithon.tech/.well-known/agents.json), [`/llms.txt`](https://aithon.tech/llms.txt).

## Install

One command, no global install (Node.js 20 or newer):

```bash
npx -y aithon-mcp-server
```

The catalog tools work without an API key. Tools that act for a registered agent need `AITHON_API_KEY`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aithon": {
      "command": "npx",
      "args": ["-y", "aithon-mcp-server"],
      "env": {
        "AITHON_API_KEY": "ait_your_key_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio --env AITHON_API_KEY=ait_your_key_here aithon -- npx -y aithon-mcp-server
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "aithon": {
      "command": "npx",
      "args": ["-y", "aithon-mcp-server"],
      "env": {
        "AITHON_API_KEY": "ait_your_key_here"
      }
    }
  }
}
```

Omit the `env` block to use the catalog tools anonymously.

## Tools

| Tool | Remote tool | API key | What it does |
|------|-------------|---------|--------------|
| `catalog_search` | `catalog.search` | no | Search services by text and category (`query`, `category`, `limit` up to 100). |
| `catalog_get` | `catalog.get` | no | Full details for one service: pricing, flags, order schema (`service_id`). |
| `catalog_order_schema_get` | `catalog.order_schema.get` | no | Whether a service is agent-orderable, its variants and pre-checkout fields (`service_id`). |
| `order_draft` | `order.draft` | yes | Create a cart draft and return cart and checkout URLs for a human (`service_id`, `session_id`, optional `quantity`, `variant_key`, `service_configuration`). |
| `availability_check` | `availability.check` | yes | Which suppliers can likely serve a US address, with status `likely`, `unknown`, `confirmed` or `not_available`, plus evidence and visible price (`address`, optional `service_ids`, `category`, `phone`, `confirm`). |
| `mandate_get` | `mandate.get` | yes | The mandates your owner issued: allowed actions, categories, monthly ceiling, expiry. |

Local names use underscores because several clients only accept `[A-Za-z0-9_-]` in tool names; the server maps them to Aithon's dotted names. Results are passed through unchanged, as JSON text plus `structuredContent`.

If a key-only tool is called without `AITHON_API_KEY`, it returns an error explaining what to set, and no request is sent.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `AITHON_API_KEY` | unset | Agent API key, sent as `Authorization: Bearer`. |
| `AITHON_CATALOG` | unset | Catalog slug. Scopes calls to `/c/<slug>/mcp` (and `/c/<slug>/api/v1/mcp/rpc`). |
| `AITHON_BASE_URL` | `https://aithon.tech` | Origin used to build the default URLs. |
| `AITHON_MCP_URL` | `<base>/mcp` | Streamable HTTP MCP endpoint. Overrides the catalog-derived URL. |
| `AITHON_RPC_URL` | `<base>/api/v1/mcp/rpc` | Legacy JSON-RPC endpoint (the `rpc_url` in `/.well-known/mcp.json`). |
| `AITHON_TRANSPORT` | `auto` | `mcp`, `legacy`, or `auto` (use MCP, fall back to legacy JSON-RPC if the MCP endpoint answers 404 or 405). |
| `AITHON_TIMEOUT_MS` | `30000` | Per-request timeout. |

### Transport note

Aithon is rolling out a standard Streamable HTTP MCP endpoint at `/mcp` alongside its older `aithon.*` JSON-RPC endpoint. In `auto` mode this server uses the MCP endpoint when it is available and otherwise falls back to JSON-RPC, where the catalog tools and `order_draft` map to `aithon.catalog.search`, `aithon.catalog.get`, `aithon.catalog.order_schema.get` and `aithon.cart.draft.create`. `availability_check` and `mandate_get` exist only on the MCP endpoint. Methods the remote has not deployed yet come back as a normal tool error.

## Get an API key

Register your agent through the flow described at [aithon.tech/for-agents](https://aithon.tech/for-agents) and in the [agent API guide](https://aithon.tech/agents.md). Keys start with `ait_`. Some tools also need your owner to issue a mandate before the remote will allow them.

## Security notes

- The key is read only from the environment and is sent only to the configured Aithon URLs. It is never logged or written to stdout.
- Plain `http://` URLs are refused except for `localhost`, so a key cannot leak over an unencrypted connection by misconfiguration.
- Treat your key like a password: keep it out of version control and shared config, and revoke it if exposed.
- `order_draft` never completes a purchase. It returns checkout URLs that a human must open and confirm.
- Tool results come from a remote service. As with any MCP server, treat their text as data, not instructions.
- Diagnostics go to stderr; stdout carries only MCP protocol messages.

## Development

```bash
npm install
npm test        # builds, then runs unit and stdio end-to-end tests against loopback mocks
npm run typecheck
```

Tests never contact aithon.tech: the remote is a mock Streamable HTTP or JSON-RPC server on `127.0.0.1`.

## License

MIT, see [LICENSE](LICENSE).
