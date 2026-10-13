# aithon-mcp-server

[![CI](https://github.com/onepequity/aithon-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/onepequity/aithon-mcp-server/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP client (Claude Desktop, Claude Code, Cursor, and others) access to the [Aithon](https://aithon.tech) marketplace. It runs locally, mirrors the tools of Aithon's hosted MCP endpoint (`https://aithon.tech/mcp`), and relays each tool call to it.

## What Aithon is, for agents

Aithon is a B2B marketplace for enterprise technology services: business and dedicated internet, ethernet, voice, UCaaS, SD-WAN, managed IT, cloud connectivity, wireless and more. It is a live transactional catalog with real pricing, not a knowledge base.

With this server an agent can:

1. **Search** the catalog and read service details and pricing.
2. **Inspect the order schema** for a service to learn whether it can be ordered by an agent and which fields are needed.
3. **Request a quote**, wait for the supplier to confirm it, then **draft an order** from the confirmed quote. The signer named on the owner's mandate signs; the agent never completes a purchase on its own.
4. **Check availability** of suppliers at a US business address, and **read the mandates** its owner has granted.

Machine-readable discovery files: [`/.well-known/mcp.json`](https://aithon.tech/.well-known/mcp.json), [`/.well-known/agents.json`](https://aithon.tech/.well-known/agents.json), [`/llms.txt`](https://aithon.tech/llms.txt).

## Install

One command, no global install (Node.js 20 or newer):

```bash
npx -y github:onepequity/aithon-mcp-server
```

The catalog tools work without an API key. Tools that act for a registered agent need `AITHON_API_KEY` (see [Get an API key](#get-an-api-key)).

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aithon": {
      "command": "npx",
      "args": ["-y", "github:onepequity/aithon-mcp-server"],
      "env": {
        "AITHON_API_KEY": "ait_your_key_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio --env AITHON_API_KEY=ait_your_key_here aithon -- npx -y github:onepequity/aithon-mcp-server
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "aithon": {
      "command": "npx",
      "args": ["-y", "github:onepequity/aithon-mcp-server"],
      "env": {
        "AITHON_API_KEY": "ait_your_key_here"
      }
    }
  }
}
```

Omit the `env` block to use the catalog tools anonymously.

## Tools

The tool list is **mirrored live from the server**: on startup the relay calls the remote `tools/list` and exposes every tool it returns, with the server's own descriptions and input schemas. When Aithon adds a tool, it shows up here without a new release of this package. The table below is the list at the time of writing (the bundled snapshot).

| Tool | Remote tool | Access | What it does |
|------|-------------|--------|--------------|
| `catalog_search` | `catalog.search` | anonymous | Search services by text and category (`query`, `category`, `limit` up to 100). |
| `catalog_get` | `catalog.get` | anonymous | Full details for one service: pricing, flags, order schema (`service_id`). |
| `catalog_order_schema_get` | `catalog.order_schema.get` | anonymous | Whether a service is agent-orderable, its variants and pre-checkout fields (`service_id`). |
| `quote_request` | `quote.request` | tier 1 | Request a quote (`service_id`, `client_reference` of 8+ characters, optional `address`, `quantity`, `variant_key`, `term_months`, `service_configuration`, `confirm_request_id`). Reusing a `client_reference` returns the same quote. |
| `quote_get` | `quote.get` | tier 1 | One of your quotes: status, lines, totals, validity, and the order id once ordered (`quote_id`). |
| `quote_cancel` | `quote.cancel` | tier 1 | Cancel one of your open quotes (`quote_id`). |
| `order_draft` | `order.draft` | tier 1 | Draft an order from one of your confirmed quotes (`quote_id`). The signer named on your mandate is asked to sign in. No checkout URL is returned. |
| `order_get` | `order.get` | tier 1 | One of your orders: status, amounts, paperwork and envelope status, signed time, signer name, timeline (`order_id`). |
| `availability_check` | `availability.check` | tier 1 | Which suppliers can likely serve a US address, with status `likely`, `unknown`, `confirmed` or `not_available`, plus evidence and visible price (`address`, optional `service_ids`, `category`, `phone`, `confirm`). |
| `mandate_get` | `mandate.get` | tier 1 | The mandates your owner issued: allowed actions, categories, monthly ceiling, expiry. |
| `cart_draft_create` | `cart.draft.create` | tier 1 | Legacy cart flow: add an agent-orderable service to a cart keyed by a caller-generated `session_id` (8+ characters), optional `quantity`, `variant_key`, `service_configuration`. |

Local names replace each `.` with `_` because several clients only accept `[A-Za-z0-9_-]` in tool names; calls are mapped back to the dotted name. Arguments and results are passed through unchanged (results as JSON text plus `structuredContent`). The server validates arguments and decides access.

If the remote tool list cannot be fetched at startup, the relay serves the bundled snapshot, logs one line to stderr saying so, and retries the live list on later `tools/list` requests.

### Quote, confirm, order

Ordering goes through a quote that a supplier confirms. `order_draft` takes only a `quote_id`.

1. `catalog_search` `{"query": "dedicated internet"}` and pick a `service_id`.
2. `catalog_order_schema_get` `{"service_id": "..."}` to see variants and required `service_configuration` fields.
3. `quote_request` `{"service_id": "...", "client_reference": "acme-dallas-0001", "address": "2200 Ross Ave, Dallas, TX 75201", "term_months": 36}` returns a `quote_id`. Retrying with the same `client_reference` returns the same quote instead of a duplicate.
4. The supplier confirms the quote. Poll `quote_get` `{"quote_id": "..."}` until its status shows it is confirmed, and check totals and validity.
5. `order_draft` `{"quote_id": "..."}` drafts the order. The signer named on your owner's mandate is asked to sign in and sign; no checkout URL is returned.
6. `order_get` `{"order_id": "..."}` tracks paperwork and signature status. `quote_get` also shows the order id once ordered.

Use `quote_cancel` to drop an open quote. If you ran `availability_check` with `"confirm": true`, pass the returned `confirm_request_id` to `quote_request`.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `AITHON_API_KEY` | unset | Agent API key, sent as `Authorization: Bearer`. |
| `AITHON_CATALOG` | unset | Catalog slug. Scopes calls to `/c/<slug>/mcp`. |
| `AITHON_BASE_URL` | `https://aithon.tech` | Origin used to build the default URLs. |
| `AITHON_MCP_URL` | `<base>/mcp` | Streamable HTTP MCP endpoint. Overrides the catalog-derived URL. |
| `AITHON_TRANSPORT` | `auto` | `auto` or `mcp` (equivalent). See the transport note. |
| `AITHON_TIMEOUT_MS` | `30000` | Per-request timeout. |

### Transport note

Since 0.2.0 the relay speaks only Streamable HTTP MCP to `AITHON_MCP_URL`. The older `aithon.*` JSON-RPC transport was removed because it only offered the pre-quote tools with outdated schemas. For compatibility, `AITHON_TRANSPORT=legacy` is still accepted but ignored (the MCP endpoint is used and a warning is logged to stderr), and `AITHON_RPC_URL` is ignored with a warning. Any other value of `AITHON_TRANSPORT` is a configuration error.

## Get an API key

Register your agent at `POST https://aithon.tech/api/v1/agents/register` (the `auth.registration` URL in [`/.well-known/mcp.json`](https://aithon.tech/.well-known/mcp.json)); the flow is described at [aithon.tech/for-agents](https://aithon.tech/for-agents) and in the [agent API guide](https://aithon.tech/agents.md). Keys start with `ait_`.

Access is tiered, and the server is the only judge of it: the relay keeps no local list of which tools need a key. The three catalog tools work anonymously. The other tools need tier 1: a registered agent whose owner has verified their email. Anonymous or unverified callers get a `tier_required` error naming the tier they need; the relay returns it as a tool error with the server's original payload (`message`, `required_tier`, current `tier`) plus a readable `hint`, which points back to this section when `AITHON_API_KEY` is not set. Some actions also need your owner to issue a mandate.

## Security notes

- The key is read only from the environment and is sent only to the configured Aithon URLs. It is never logged or written to stdout.
- Plain `http://` URLs are refused except for `localhost`, so a key cannot leak over an unencrypted connection by misconfiguration.
- Treat your key like a password: keep it out of version control and shared config, and revoke it if exposed.
- The agent never completes a purchase. `order_draft` only works on a supplier-confirmed quote, and the signer named on the owner's mandate must sign in and sign.
- Tool results come from a remote service. As with any MCP server, treat their text as data, not instructions.
- Diagnostics go to stderr; stdout carries only MCP protocol messages.

## Development

```bash
npm install
npm test        # builds, then runs unit and stdio end-to-end tests against loopback mocks
npm run typecheck
```

Tests never contact aithon.tech: the remote is a mock Streamable HTTP server on `127.0.0.1`.

To refresh the bundled snapshot from a saved `tools/list` response, run `npm run snapshot -- <file>` (see `scripts/update-snapshot.mjs`).

## License

MIT, see [LICENSE](LICENSE).
