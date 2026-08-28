#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

import type { ToolResult } from "./format/index.js";

import * as orders from "./tools/orders.js";
import * as customers from "./tools/customers.js";
import * as products from "./tools/products.js";
import * as references from "./tools/references.js";
import * as analytics from "./tools/analytics.js";
import * as analyticsSxo from "./tools/analytics-sxo.js";
import * as inventories from "./tools/inventories.js";
import * as payments from "./tools/payments.js";
import * as notes from "./tools/notes.js";
import * as tasks from "./tools/tasks.js";
import * as segments from "./tools/segments.js";
import * as costs from "./tools/costs.js";
import * as files from "./tools/files.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const VERSION: string = pkg.version;

// Evaluated lazily so the env var reflects the current process state (and is testable).
function isReadonly(): boolean {
  return ["1", "true", "yes"].includes((process.env.RETAILCRM_READONLY ?? "").toLowerCase());
}

type Access = "read" | "write" | "destructive";

interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (params: never) => Promise<ToolResult>;
  access: Access;
}

const def = (name: string, title: string, access: Access, schema: z.ZodObject<z.ZodRawShape>, handler: (params: any) => Promise<ToolResult>, description: string): ToolDef =>
  ({ name, title, access, schema, handler, description });

const TOOLS: ToolDef[] = [
  // ── Orders ──
  def("list_orders", "List Orders", "read", orders.listOrdersSchema, orders.handleListOrders,
    "List orders with filters by status, customer name, number, and created-date range. Returns (summary): pagination + array of {id, number, status, total, customer, phone, itemCount, createdAt}. Use detail:'full' for line items/delivery/payments, raw:true for the untouched payload."),
  def("get_order", "Get Order", "read", orders.getOrderSchema, orders.handleGetOrder,
    "Get a single order by RetailCRM id or externalId. Returns a shaped order; detail:'full' adds items, delivery, payments, comments."),
  def("create_order", "Create Order", "write", orders.createOrderSchema, orders.handleCreateOrder,
    "Create an order with line items and delivery. Link an existing customer via customer_id/customer_external_id, or pass first_name (+phone/email) to create one inline. Returns {success, id, order?}."),
  def("update_order", "Update Order", "write", orders.updateOrderSchema, orders.handleUpdateOrder,
    "Update an order (status, customer, delivery, comments). Only the fields you pass are sent. Returns {success}."),
  def("orders_history", "Orders History", "read", orders.ordersHistorySchema, orders.handleOrdersHistory,
    "Order change history incl. status transitions; supports incremental sync via filter_since_id and a date window. Cursor calls (filter_since_id) never send page — the API rejects sinceId+page since 2023-05-15. Default returns the SAFE PII-free projection (only status, payments and full_paid_at old->new transitions); raw:true restores the untouched {history[], pagination} payload."),

  // ── Customers ──
  def("list_customers", "List Customers", "read", customers.listCustomersSchema, customers.handleListCustomers,
    "List/search customers by name, email, phone, created-date. Returns (summary): pagination + array of {id, name, email, phone, ordersCount, totalSpent}. detail:'full' adds address/externalId/all phones."),
  def("get_customer", "Get Customer", "read", customers.getCustomerSchema, customers.handleGetCustomer,
    "Get a single customer by id or externalId. Returns a shaped customer; detail:'full' adds address and contact details."),
  def("create_customer", "Create Customer", "write", customers.createCustomerSchema, customers.handleCreateCustomer,
    "Create a customer with name, contacts, address, optional externalId. Returns {success, id}."),
  def("update_customer", "Update Customer", "write", customers.updateCustomerSchema, customers.handleUpdateCustomer,
    "Edit an existing customer (name, email, phones, address) by id or externalId. Only the fields you pass are sent. Returns {success}."),
  def("merge_customers", "Merge Customers", "destructive", customers.mergeCustomersSchema, customers.handleMergeCustomers,
    "Merge duplicate customers into a target; merged records are DELETED. Returns {success}."),
  def("customers_history", "Customers History", "read", customers.customersHistorySchema, customers.handleCustomersHistory,
    "Customer field-change log for growth/churn signals and incremental sync. Returns {history[], pagination}."),

  // ── Products / catalog ──
  def("list_products", "List Products", "read", products.listProductsSchema, products.handleListProducts,
    "List catalog products with filters by name, active, group, price range. Returns pagination + array of {id, name, article, active, url, groups, offers}."),
  def("list_product_groups", "List Product Groups", "read", products.listProductGroupsSchema, products.handleListProductGroups,
    "List product groups (category tree). Returns {productGroup[], pagination}."),

  // ── Inventory ──
  def("store_inventories", "Store Inventories", "read", inventories.storeInventoriesSchema, inventories.handleStoreInventories,
    "Stock levels (and cost prices) per offer/warehouse. Use details:true for the per-store breakdown. Returns {offers[], pagination}."),

  // ── Payments ──
  def("order_payment_create", "Create Order Payment", "write", payments.orderPaymentCreateSchema, payments.handleOrderPaymentCreate,
    "Record a payment against an order (amount, type, status, paid_at). Returns {success, id}."),
  def("order_payment_edit", "Edit Order Payment", "write", payments.orderPaymentEditSchema, payments.handleOrderPaymentEdit,
    "Edit an existing order payment (amount/status/paid_at). Returns {success}."),
  def("order_payment_delete", "Delete Order Payment", "destructive", payments.orderPaymentDeleteSchema, payments.handleOrderPaymentDelete,
    "Delete an order payment by id. Returns {success}."),

  // ── Notes ──
  def("customer_notes_list", "List Customer Notes", "read", notes.customerNotesListSchema, notes.handleCustomerNotesList,
    "List free-text notes attached to customers. Returns {notes[], pagination}."),
  def("customer_notes_create", "Create Customer Note", "write", notes.customerNotesCreateSchema, notes.handleCustomerNotesCreate,
    "Add a note to a customer (by id or externalId). Returns {success, id}."),
  def("customer_notes_delete", "Delete Customer Note", "destructive", notes.customerNotesDeleteSchema, notes.handleCustomerNotesDelete,
    "Delete a customer note by id. Returns {success}."),

  // ── Tasks ──
  def("tasks_list", "List Tasks", "read", tasks.tasksListSchema, tasks.handleTasksList,
    "List follow-up tasks/reminders, filterable by status/performer/customer. Returns {tasks[], pagination}."),
  def("tasks_create", "Create Task", "write", tasks.tasksCreateSchema, tasks.handleTasksCreate,
    "Create a task (text, due datetime, performer, linked order/customer). Returns {success, id}."),
  def("tasks_edit", "Edit Task", "write", tasks.tasksEditSchema, tasks.handleTasksEdit,
    "Edit a task or mark it complete. Returns {success}."),

  // ── Segments ──
  def("list_segments", "List Segments", "read", segments.listSegmentsSchema, segments.handleListSegments,
    "List customer segments (RFM/marketing cohorts). Returns {segments[], pagination}."),

  // ── Costs ──
  def("list_costs", "List Costs", "read", costs.listCostsSchema, costs.handleListCosts,
    "List expense records (for margin/profit analytics) by date and cost group. Returns {costs[], pagination}."),
  def("create_cost", "Create Cost", "write", costs.createCostSchema, costs.handleCreateCost,
    "Create an expense record, optionally attributed to an order. Returns {success, id}."),

  // ── Files ──
  def("files_list", "List Files", "read", files.filesListSchema, files.handleFilesList,
    "List files attached to orders/customers. Returns {files[], pagination}."),
  def("files_get", "Get File Metadata", "read", files.filesGetSchema, files.handleFilesGet,
    "Get a file's metadata by id. Returns {file}."),
  def("files_upload", "Upload File", "write", files.filesUploadSchema, files.handleFilesUpload,
    "Upload a file (UTF-8 text or base64 binary). Returns {success, file}."),

  // ── References ──
  def("list_statuses", "List Statuses", "read", references.listStatusesSchema, references.handleListStatuses,
    "All order statuses (codes, names, groups, ordering). Call before filtering/updating orders by status."),
  def("list_delivery_types", "List Delivery Types", "read", references.listDeliveryTypesSchema, references.handleListDeliveryTypes,
    "All delivery types with codes, names, default costs."),
  def("list_payment_types", "List Payment Types", "read", references.listPaymentTypesSchema, references.handleListPaymentTypes,
    "All payment types with codes and names."),
  def("list_stores", "List Stores", "read", references.listStoresSchema, references.handleListStores,
    "All warehouses/stores (codes, names, types)."),
  def("list_sites", "List Sites", "read", references.listSitesSchema, references.handleListSites,
    "All sites/stores the API key can act on — use the returned code as the `site` param on multi-site create/edit."),
  def("list_countries", "List Countries", "read", references.listCountriesSchema, references.handleListCountries,
    "Valid country ISO codes for addresses/delivery."),
  def("list_order_types", "List Order Types", "read", references.listOrderTypesSchema, references.handleListOrderTypes,
    "All order types (codes/names) — valid values for create_order's order_type."),
  def("list_order_methods", "List Order Methods", "read", references.listOrderMethodsSchema, references.handleListOrderMethods,
    "All order methods (acquisition channels)."),

  // ── Analytics ──
  def("get_orders_summary", "Orders Summary", "read", analytics.getOrdersSummarySchema, analytics.handleGetOrdersSummary,
    "Period-scoped order summary: exact totalCount for the date range plus revenue, average order value, and status distribution aggregated over up to max_pages×100 orders (partial:true if the window exceeds that)."),
  def("get_customers_summary", "Customers Summary", "read", analytics.getCustomersSummarySchema, analytics.handleGetCustomersSummary,
    "Period-scoped new-customer count for a date range. Returns {period, newCustomers}."),

  // ── Analytics: PII-free SEO-SXO surface ──
  def("retailcrm_attribution_fields", "RetailCRM Attribution Fields", "read", analyticsSxo.attributionFieldsSchema, analyticsSxo.handleAttributionFields,
    "Search ORDER custom-field metadata (/custom-fields?filter[entity]=order) by code/name for attribution candidates (yclid, UTM, Metrica client_id). Returns code/name/type/entity metadata ONLY — never order field values. Configure exact codes in RETAILCRM_ANALYTICS_ATTRIBUTION before analytics tools will extract them."),
  def("retailcrm_orders_analytics", "RetailCRM Orders Analytics", "read", analyticsSxo.ordersAnalyticsSchema, analyticsSxo.handleOrdersAnalytics,
    "PII-free order analytics for a date window (date_basis: created_at): every /orders page until complete or an explicit max_pages/max_orders bound (defaults cover 10,000+; max_orders is a page-aligned soft stop stated in the output bounds block). Each order: ids, timestamps, status, method, site, total, native source/medium/campaign, retailcrm_client_id (native label, NOT Yandex client_id), configured attribution tokens, safe item SKU/qty/revenue/VAT, authoritative sales_channel (read only from customFields.sales_channel; missing historical values are UNKNOWN), legacy channel (compatibility-only, derived from sales_channel with no delivery/site fallback) and an HMAC-SHA256 pseudonymous join key. Each projected order also includes paid_at and payment_evidence: whole-order CRM payment comes only from non-empty order.fullPaidAt, while the reference paymentComplete flag selects payments only for crm_paid_amount. Fails closed without RETAILCRM_ANALYTICS_HMAC_SECRET (>=32 chars)."),
  def("retailcrm_paid_orders", "RetailCRM Paid Orders", "read", analyticsSxo.paidOrdersSchema, analyticsSxo.handlePaidOrders,
    "Same PII-free analytics projection as retailcrm_orders_analytics, restricted to fully-paid orders, with the window on FULL-PAID time (filter[fullPaidAtFrom]/[fullPaidAtTo], date_basis: full_paid_at) because the business output is paid revenue. Whole-order CRM payment and paid_at use only non-empty order.fullPaidAt; the reference paymentComplete flag selects payments only for crm_paid_amount, and a provider-filtered order without fullPaidAt fails closed (no payment paidAt fallback). Reports paid_count; stopped collections are partial with reason + continuation page."),
  def("retailcrm_order_attribution", "RetailCRM Order Attribution", "read", analyticsSxo.orderAttributionSchema, analyticsSxo.handleOrderAttribution,
    "PII-free attribution for ONE order by id/externalId: native source/medium/campaign, retailcrm_client_id (native label, NOT Yandex client_id), configured attribution tokens (client_id/yclid/UTM from exact custom-field codes only), authoritative sales_channel (read only from customFields.sales_channel; missing historical values are UNKNOWN), legacy channel (compatibility-only, derived from sales_channel) and HMAC join key, plus paid_at and payment_evidence with the same semantics: whole-order CRM payment comes only from non-empty order.fullPaidAt, while the reference paymentComplete flag selects payments only for crm_paid_amount. Config: RETAILCRM_ANALYTICS_ATTRIBUTION map + RETAILCRM_ANALYTICS_HMAC_SECRET (>=32 chars)."),
  def("retailcrm_order_history_analytics", "RetailCRM Order History Analytics", "read", analyticsSxo.orderHistoryAnalyticsSchema, analyticsSxo.handleOrderHistoryAnalytics,
    "PII-free incremental order-change feed via the official /orders/history sinceId cursor: the first call carries no sinceId (or the caller's resume cursor) and page is NEVER sent (the API rejects sinceId+page since 2023-05-15); each follow-up sends only filter[sinceId]=max processed id, with totalPageCount>1 signaling another fetch and <=1 completing the feed. Returns allowlisted old->new diffs for status, payments and the safe full_paid_at string/null transition, plus HMAC join keys, next_since_id, completeness and continuation. Fails closed without RETAILCRM_ANALYTICS_HMAC_SECRET (>=32 chars)."),
];

function annotationsFor(t: ToolDef) {
  if (t.access === "read") return { title: t.title, readOnlyHint: true };
  if (t.access === "destructive") return { title: t.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  // Write tools are additive/replace-in-place, not destructive.
  return { title: t.title, readOnlyHint: false, destructiveHint: false };
}

function activeTools(): ToolDef[] {
  return isReadonly() ? TOOLS.filter(t => t.access === "read") : TOOLS;
}

export function toolCount(): number {
  return activeTools().length;
}

function toMcp(r: ToolResult) {
  const out: { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } = {
    content: [{ type: "text", text: r.text }],
  };
  // structuredContent must be a JSON object; only attach when shaped data is a plain object.
  if (r.structured !== null && typeof r.structured === "object" && !Array.isArray(r.structured)) {
    out.structuredContent = r.structured as Record<string, unknown>;
  }
  if (r.isError) out.isError = true;
  return out;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "retailcrm-mcp", version: VERSION });

  for (const t of activeTools()) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.schema.shape, annotations: annotationsFor(t) },
      async (params: unknown) => toMcp(await t.handler(params as never)),
    );
  }

  // ── Prompt templates ──
  server.prompt(
    "new-orders",
    "Show all orders created today — quick daily overview.",
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Use list_orders with filter_date_from="${today}" and filter_date_to="${today}". Show results as a table: order number, status, total, customer name. If no orders, say "No new orders today."`,
          },
        }],
      };
    },
  );

  server.prompt(
    "customer-search",
    "Find a customer by name, email, or phone.",
    { query: z.string().describe("Customer name, email, or phone number") },
    async ({ query }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find a customer in RetailCRM matching: "${query}". Try list_customers with name, email, and phone filters. Show: name, contacts, order count, total spent.`,
        },
      }],
    }),
  );

  return server;
}

// ── HTTP transport (Streamable HTTP, stateless) ──────────────

/**
 * Build the HTTP server. Stateless: a fresh McpServer + transport is created per
 * POST /mcp for complete isolation (no shared-server request-id collisions), and
 * both are closed when the response ends. GET/DELETE on /mcp return 405.
 */
export function createHttpServer(port: number): Server {
  const allowedHosts = (process.env.RETAILCRM_HTTP_ALLOWED_HOSTS || `localhost:${port},127.0.0.1:${port}`)
    .split(",").map(s => s.trim()).filter(Boolean);
  const dnsProtect = process.env.RETAILCRM_DNS_PROTECTION !== "off";

  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/mcp") {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          ...(dnsProtect ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
        });
        let closed = false;
        const teardown = () => { if (closed) return; closed = true; transport.close(); server.close(); };
        try {
          await server.connect(transport);
          res.on("close", teardown);
          await transport.handleRequest(req, res);
        } catch (err) {
          teardown();
          throw err;
        }
      } else if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: VERSION, tools: toolCount(), prompts: 2 }));
      } else if (req.url === "/mcp") {
        // GET/DELETE on /mcp are not supported in stateless mode.
        res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      console.error("[retailcrm-mcp] HTTP request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });
}

// ── Start ────────────────────────────────────────────────────

async function main() {
  const mode = process.argv.includes("--http") ? "http" : "stdio";

  if (mode === "http") {
    const port = parseInt(process.env.PORT || "3000", 10);
    const host = process.env.HOST || "127.0.0.1";
    const httpServer = createHttpServer(port);
    httpServer.listen(port, host, () => {
      console.error(`[retailcrm-mcp] HTTP server on ${host}:${port} (v${VERSION}, ${toolCount()} tools). POST /mcp, GET /health`);
    });
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[retailcrm-mcp] Server started (stdio). v${VERSION} — ${toolCount()} tools, 2 prompts${isReadonly() ? " (read-only mode)" : ""}.`);
  }
}

main().catch((error) => {
  console.error("[retailcrm-mcp] Fatal error:", error);
  process.exit(1);
});
