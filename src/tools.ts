/**
 * The six Aithon agent tools.
 *
 * Input schemas mirror the remote server's zod schemas. The remote validates
 * again, so these exist to give MCP clients an accurate JSON Schema and to
 * reject obviously malformed calls before any network request.
 *
 * Local names use underscores because several MCP clients (and the model APIs
 * behind them) only accept [A-Za-z0-9_-] in tool names. Each tool maps to its
 * dotted name on the remote MCP endpoint and, where one exists, its legacy
 * `aithon.*` JSON-RPC method.
 */

import { z, type ZodRawShape } from 'zod';

export interface AithonTool {
  /** Name exposed to the local MCP client. */
  name: string;
  /** Candidate tool names on the remote MCP endpoint, preferred first. */
  remoteNames: string[];
  /** Legacy JSON-RPC method, if the tool is reachable over the legacy endpoint. */
  legacyMethod?: string;
  title: string;
  description: string;
  inputShape: ZodRawShape;
  /** True when the remote requires a registered agent (Tier 1) for this tool. */
  requiresApiKey: boolean;
  readOnly: boolean;
}

const serviceId = z.string().min(1).describe('Service ID from catalog_search');

const structuredAddress = z.object({
  line1: z.string().min(1).describe('Street address'),
  city: z.string().optional(),
  state: z.string().optional().describe('2-letter state code'),
  zip: z.string().optional().describe('5-digit ZIP (ZIP+4 accepted)'),
});

export const TOOLS: AithonTool[] = [
  {
    name: 'catalog_search',
    remoteNames: ['catalog.search'],
    legacyMethod: 'aithon.catalog.search',
    title: 'Search catalog',
    description:
      'Search the Aithon catalog of enterprise technology services (internet, voice, SD-WAN, managed IT, cloud, security). ' +
      'Returns id, name, description, category, provider and display pricing for each match. No API key needed.',
    inputShape: {
      query: z.string().optional().describe('Case-insensitive text matched against service name and description'),
      category: z.string().optional().describe('Exact category name, case-insensitive'),
      limit: z.number().int().positive().max(100).optional().describe('Maximum results (default 25, max 100)'),
    },
    requiresApiKey: false,
    readOnly: true,
  },
  {
    name: 'catalog_get',
    remoteNames: ['catalog.get'],
    legacyMethod: 'aithon.catalog.get',
    title: 'Get service details',
    description:
      'Get full details for one service: pricing (display, core rate, range, billing frequency), flags, and its order schema. No API key needed.',
    inputShape: { service_id: serviceId },
    requiresApiKey: false,
    readOnly: true,
  },
  {
    name: 'catalog_order_schema_get',
    remoteNames: ['catalog.order_schema.get'],
    legacyMethod: 'aithon.catalog.order_schema.get',
    title: 'Get order schema',
    description:
      'Get the machine-orderable schema for a service: whether an agent can order it, variants, and the fields required before checkout. ' +
      'Call this before order_draft. No API key needed.',
    inputShape: { service_id: serviceId },
    requiresApiKey: false,
    readOnly: true,
  },
  {
    name: 'order_draft',
    remoteNames: ['order.draft', 'cart.draft.create'],
    legacyMethod: 'aithon.cart.draft.create',
    title: 'Draft an order',
    description:
      'Create a cart draft for an agent-orderable service. Nothing is purchased: the result includes cart and checkout URLs ' +
      'for a human to review and complete. Requires a caller-generated session_id and AITHON_API_KEY.',
    inputShape: {
      service_id: serviceId,
      session_id: z
        .string()
        .trim()
        .min(8, 'session_id is required and must be caller-generated')
        .describe('Caller-generated session id (8+ characters); reuse it to add more items to the same cart'),
      quantity: z.number().int().min(1).max(100).optional().describe('Quantity, 1-100 (default 1)'),
      variant_key: z.string().optional().describe('Variant key from the order schema; defaults to the schema default'),
      service_configuration: z
        .record(z.unknown())
        .optional()
        .describe('Values for the order schema pre-checkout fields'),
    },
    requiresApiKey: true,
    readOnly: false,
  },
  {
    name: 'availability_check',
    remoteNames: ['availability.check'],
    title: 'Check availability',
    description:
      'Check which suppliers can likely serve a US business address, with honest status (likely | unknown | confirmed | not_available), ' +
      'the evidence source, and the price you are allowed to see. FCC data only ever yields likely or unknown; ' +
      'pass confirm: true to ask suppliers for a binding answer. Requires AITHON_API_KEY and an owner mandate.',
    inputShape: {
      address: z
        .union([z.string().trim().min(5, 'address is required'), structuredAddress])
        .describe('US service address: one line ("2200 Ross Ave, Dallas, TX 75201") or structured'),
      service_ids: z
        .array(z.string())
        .max(50)
        .optional()
        .describe('Limit the check to these services (default: every in-scope service with an availability class)'),
      category: z.string().optional().describe('Limit the check to one category'),
      phone: z.string().optional().describe('Business phone number; used only for NPA-NXX (exchange) footprints'),
      confirm: z.boolean().optional().describe('Also ask each supplier to confirm; returns confirm_request_id per service'),
    },
    requiresApiKey: true,
    readOnly: false,
  },
  {
    name: 'mandate_get',
    remoteNames: ['mandate.get'],
    title: 'List my mandates',
    description:
      'List the mandates your owner has issued to you: which actions (browse, availability_check, quote, draft_order), ' +
      'which categories, the monthly commitment ceiling, and when each expires. Requires AITHON_API_KEY.',
    inputShape: {},
    requiresApiKey: true,
    readOnly: true,
  },
];

export function findTool(name: string): AithonTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
