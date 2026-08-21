import { z } from "zod";
import { createHmac } from "node:crypto";
import { retailCrmGet } from "../client.js";
import { ok, fail, runTool, type ToolResult } from "../format/index.js";
import { dateField } from "./common.js";

// PII-free SEO-SXO analytics surface (docs/criteria/retailcrm-analytics-sxo-v1.md).
// Allowlist-only projection: fields are copied one by one, never spread, so
// customer/contact data, comments, addresses, user ids and arbitrary custom
// fields cannot leak into analytics output. Config is explicit — nothing is
// guessed — and every order tool fails closed without a usable HMAC secret.

const HMAC_ENV = "RETAILCRM_ANALYTICS_HMAC_SECRET";
const JOIN_KEY_PREFIX = "petdog-order-v1:";
const MIN_SECRET_LEN = 32;

// ── Raw provider shapes (only what this surface reads) ───────

interface AsxItemRaw {
  offer?: { externalId?: string; xmlId?: string; article?: string } | null;
  quantity?: number;
  initialPrice?: number;
  discountTotal?: number;
  prices?: { price?: number; quantity?: number }[] | null;
  vatRate?: string;
}

interface AsxPaymentRaw { status?: string; paidAt?: string }

interface AsxOrderRaw {
  id?: number;
  externalId?: string;
  number?: string;
  createdAt?: string;
  status?: string;
  orderMethod?: string;
  site?: string;
  totalSumm?: number;
  currency?: string;
  clientId?: string;
  fullPaidAt?: string;
  source?: { source?: string; medium?: string; campaign?: string } | string | null;
  customFields?: Record<string, unknown> | null;
  items?: AsxItemRaw[] | null;
  payments?: Record<string, AsxPaymentRaw> | null;
}

// ── HMAC join key ────────────────────────────────────────────

export type SecretCheck = { ok: true; secret: string } | { ok: false; reason: string };

export function checkAnalyticsSecret(env: NodeJS.ProcessEnv = process.env): SecretCheck {
  const secret = env[HMAC_ENV] ?? "";
  if (secret.length < MIN_SECRET_LEN) {
    return { ok: false, reason: `${HMAC_ENV} is absent or shorter than ${MIN_SECRET_LEN} characters — analytics orders refused (fail closed)` };
  }
  return { ok: true, secret };
}

/** externalId, then number, then CRM id — NFKC-normalized and trimmed. */
export function normalizeOrderId(o: { externalId?: string; number?: string; id?: number }): string | null {
  const basis =
    typeof o.externalId === "string" && o.externalId.trim() !== "" ? o.externalId :
    typeof o.number === "string" && o.number.trim() !== "" ? o.number :
    typeof o.id === "number" ? String(o.id) : null;
  return basis === null ? null : basis.normalize("NFKC").trim();
}

/** HMAC-SHA256(secret, "petdog-order-v1:" + normalized_order_id) as hex. The raw basis is never embedded. */
export function orderJoinKey(o: AsxOrderRaw, secret: string): string | null {
  const normalized = normalizeOrderId(o);
  if (normalized === null || normalized === "") return null;
  return createHmac("sha256", secret).update(JOIN_KEY_PREFIX + normalized).digest("hex");
}

// ── Attribution configuration (explicit, never guessed) ──────

const ATTRIBUTION_KEYS = ["client_id", "yclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type AttributionConfig =
  | { configured: false }
  | { configured: true; codes: Partial<Record<AttributionKey, string>> };

const isAttributionKey = (k: string): k is AttributionKey => (ATTRIBUTION_KEYS as readonly string[]).includes(k);

export function loadAttributionConfig(env: NodeJS.ProcessEnv = process.env): AttributionConfig | { error: string } {
  const raw = env.RETAILCRM_ANALYTICS_ATTRIBUTION;
  if (!raw) return { configured: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "RETAILCRM_ANALYTICS_ATTRIBUTION is not valid JSON (expected {canonical_key: custom_field_code})" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "RETAILCRM_ANALYTICS_ATTRIBUTION must be a JSON object mapping canonical keys to custom-field codes" };
  }
  const codes: Partial<Record<AttributionKey, string>> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAttributionKey(key)) {
      return { error: `RETAILCRM_ANALYTICS_ATTRIBUTION: unknown key "${key}" (allowed: ${ATTRIBUTION_KEYS.join(", ")})` };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { error: `RETAILCRM_ANALYTICS_ATTRIBUTION: key "${key}" must map to a non-empty custom-field code` };
    }
    const code = value.trim();
    if (seen.has(code)) return { error: `RETAILCRM_ANALYTICS_ATTRIBUTION: duplicate custom-field code "${code}"` };
    seen.add(code);
    codes[key] = code;
  }
  return { configured: true, codes };
}

// Extracted token values are strings, 1..512 chars after trim, no control chars.
function hasUnsafeChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function safeToken(v: unknown): { value: string } | { omitted_reason: string } {
  if (typeof v !== "string") return { omitted_reason: "not_a_string" };
  const s = v.trim();
  if (s === "") return { omitted_reason: "empty" };
  if (s.length > 512) return { omitted_reason: "unsafe_length" };
  if (hasUnsafeChar(s)) return { omitted_reason: "unsafe_characters" };
  return { value: s };
}

export type AttributionTokenView = {
  value: string | null;
  field_code: string | null;
  source: "configured_custom_field" | "unconfigured";
  omitted_reason: string | null;
};

/** Own-property check: inherited keys ("toString", "__proto__", "constructor") never resolve as configured lookups. */
const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function buildAttribution(customFields: Record<string, unknown> | null | undefined, cfg: AttributionConfig): Record<string, AttributionTokenView> {
  const out: Record<string, AttributionTokenView> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const code = cfg.configured ? cfg.codes[key] : undefined;
    if (!code) {
      out[key] = { value: null, field_code: null, source: "unconfigured", omitted_reason: "not_configured" };
      continue;
    }
    // Own-property lookup on a non-array object only: inherited keys (e.g. a
    // customFields prototype's "toString") are never treated as field values.
    const cf = customFields !== null && typeof customFields === "object" && !Array.isArray(customFields)
      ? customFields as Record<string, unknown> : null;
    if (cf === null || !hasOwn(cf, code)) {
      out[key] = { value: null, field_code: code, source: "configured_custom_field", omitted_reason: "field_absent_on_order" };
      continue;
    }
    const token = safeToken(cf[code]);
    out[key] = "value" in token
      ? { value: token.value, field_code: code, source: "configured_custom_field", omitted_reason: null }
      : { value: null, field_code: code, source: "configured_custom_field", omitted_reason: token.omitted_reason };
  }
  return out;
}

export const configuredAttributionKeys = (cfg: AttributionConfig): string[] =>
  cfg.configured ? Object.keys(cfg.codes).sort() : [];

// ── Channel classification (explicit mapping only) ───────────

const CHANNELS = ["site", "phone", "chat", "marketplace", "unknown"] as const;
export type Channel = (typeof CHANNELS)[number];

export function loadChannelMap(env: NodeJS.ProcessEnv = process.env): { map: Record<string, Channel> } | { error: string } {
  const raw = env.RETAILCRM_ANALYTICS_CHANNEL_MAP;
  if (!raw) return { map: Object.create(null) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "RETAILCRM_ANALYTICS_CHANNEL_MAP is not valid JSON (expected {site_or_method_code: channel})" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "RETAILCRM_ANALYTICS_CHANNEL_MAP must be a JSON object mapping codes to channels" };
  }
  // Null-prototype map: no inherited keys can ever resolve as channel lookups.
  const map: Record<string, Channel> = Object.create(null);
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !(CHANNELS as readonly string[]).includes(value)) {
      return { error: `RETAILCRM_ANALYTICS_CHANNEL_MAP: unknown channel ${JSON.stringify(value)} for code "${code}" (allowed: ${CHANNELS.join(", ")})` };
    }
    map[code] = value as Channel;
  }
  return { map };
}

/** orderMethod lookup first, then site — own-property only, so inherited keys ("toString", "__proto__") can never resolve. Anything else is explicitly "unknown". */
function classifyChannel(o: AsxOrderRaw, map: Record<string, Channel>): { value: Channel; basis: "order_method" | "site" | "unmapped" } {
  if (o.orderMethod && hasOwn(map, o.orderMethod)) return { value: map[o.orderMethod], basis: "order_method" };
  if (o.site && hasOwn(map, o.site)) return { value: map[o.site], basis: "site" };
  return { value: "unknown", basis: "unmapped" };
}

// ── Shared guard (fail closed before any bridge call) ────────

type AnalyticsGuard = { secret: string; attribution: AttributionConfig; channelMap: Record<string, Channel> };

function guardConfig(): AnalyticsGuard | { error: string } {
  const secretCheck = checkAnalyticsSecret();
  if (!secretCheck.ok) return { error: secretCheck.reason };
  const attribution = loadAttributionConfig();
  if ("error" in attribution) return attribution;
  const channelMap = loadChannelMap();
  if ("error" in channelMap) return channelMap;
  return { secret: secretCheck.secret, attribution, channelMap: channelMap.map };
}

// ── Paid statuses (paymentComplete) ──────────────────────────

/** `/reference/payment-statuses` codes whose provider flag paymentComplete is true. */
export async function fetchPaidStatusCodes(): Promise<Set<string>> {
  const resp = await retailCrmGet("/reference/payment-statuses") as { paymentStatuses?: unknown };
  const map = resp?.paymentStatuses;
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("RetailCRM payment statuses response is malformed (expected paymentStatuses object)");
  }
  const paid = new Set<string>();
  for (const [code, entry] of Object.entries(map as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`RetailCRM payment status "${code}" is malformed`);
    }
    if ((entry as { paymentComplete?: unknown }).paymentComplete === true) paid.add(code);
  }
  return paid;
}

// ── PII-free projection ──────────────────────────────────────

export type AnalyticsOrder = {
  id: number;
  external_id: string | null;
  number: string | null;
  created_at: string | null;
  paid_at: string | null;
  status: string | null;
  order_method: string | null;
  site: string | null;
  total: number | null;
  currency: string | null;
  source: { source: string | null; medium: string | null; campaign: string | null };
  retailcrm_client_id: string | null;
  retailcrm_client_id_source: "retailcrm_native_clientId";
  attribution: Record<string, AttributionTokenView>;
  items: { sku: string | null; quantity: number | null; revenue: number | null; vat_rate: string | null }[];
  channel: { value: Channel; basis: "order_method" | "site" | "unmapped" };
  join_key: string | null;
};

type ProjectionCtx = AnalyticsGuard & { paidStatusCodes: Set<string> };

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Item revenue from the FINAL realization prices (current OpenAPI evidence):
 * when a non-empty prices[] consists entirely of numeric price+quantity
 * tranches, every price*quantity is summed. Otherwise fall back to
 * (initialPrice - discountTotal) * quantity — discountTotal is per-unit and
 * includes allocated order discount. Malformed numeric material yields null
 * (or the documented fallback when its inputs are genuine); amounts are
 * never guessed.
 */
function itemRevenue(it: AsxItemRaw, quantity: number | null): number | null {
  const prices = Array.isArray(it.prices) ? it.prices : [];
  if (prices.length > 0) {
    let total = 0;
    let allValid = true;
    for (const t of prices) {
      if (isFiniteNumber(t.price) && isFiniteNumber(t.quantity)) {
        total += t.price * t.quantity;
      } else {
        allValid = false;
        break;
      }
    }
    if (allValid) return round2(total);
  }
  if (quantity === null) return null;
  if (!isFiniteNumber(it.initialPrice)) return null;
  if (it.discountTotal !== undefined && it.discountTotal !== null && !isFiniteNumber(it.discountTotal)) return null;
  const discount = isFiniteNumber(it.discountTotal) ? it.discountTotal : 0;
  return round2((it.initialPrice - discount) * quantity);
}

export function projectOrder(o: AsxOrderRaw, ctx: ProjectionCtx): { order: AnalyticsOrder; paid: boolean } | { error: string } {
  if (o === null || typeof o !== "object" || typeof o.id !== "number") {
    return { error: "order is malformed: missing numeric id" };
  }
  const payments = o.payments !== null && typeof o.payments === "object" ? Object.values(o.payments) : [];
  const completePayments = payments.filter(p => typeof p?.status === "string" && ctx.paidStatusCodes.has(p.status));
  // Fallback: the LATEST valid paidAt among complete payments (Date.parse
  // comparison), never the first insertion-order value; unparsable values are ignored.
  let fallbackPaidAt: string | null = null;
  let fallbackPaidAtMs = Number.NEGATIVE_INFINITY;
  for (const p of completePayments) {
    if (typeof p.paidAt !== "string") continue;
    const ms = Date.parse(p.paidAt);
    if (Number.isNaN(ms) || ms <= fallbackPaidAtMs) continue;
    fallbackPaidAt = p.paidAt;
    fallbackPaidAtMs = ms;
  }
  const paidAt = typeof o.fullPaidAt === "string" ? o.fullPaidAt : fallbackPaidAt;
  const src = typeof o.source === "string"
    ? { source: o.source, medium: null, campaign: null }
    : { source: o.source?.source ?? null, medium: o.source?.medium ?? null, campaign: o.source?.campaign ?? null };
  const items = (Array.isArray(o.items) ? o.items : []).map(it => {
    const quantity = isFiniteNumber(it.quantity) ? it.quantity : null;
    return {
      // SKU precedence per current OpenAPI OrderProduct/offer: externalId, then xmlId, then article.
      sku: it.offer?.externalId ?? it.offer?.xmlId ?? it.offer?.article ?? null,
      quantity,
      // vatRate is a STRING in the current OpenAPI (e.g. "20%"); never coerced.
      vat_rate: typeof it.vatRate === "string" ? it.vatRate : null,
      revenue: itemRevenue(it, quantity),
    };
  });
  return {
    order: {
      id: o.id,
      external_id: typeof o.externalId === "string" ? o.externalId : null,
      number: typeof o.number === "string" ? o.number : null,
      created_at: typeof o.createdAt === "string" ? o.createdAt : null,
      paid_at: paidAt,
      status: typeof o.status === "string" ? o.status : null,
      order_method: typeof o.orderMethod === "string" ? o.orderMethod : null,
      site: typeof o.site === "string" ? o.site : null,
      total: typeof o.totalSumm === "number" ? o.totalSumm : null,
      currency: typeof o.currency === "string" ? o.currency : null,
      source: src,
      // Native RetailCRM analytics label — explicitly NOT Yandex Metrica client_id.
      retailcrm_client_id: typeof o.clientId === "string" ? o.clientId : null,
      retailcrm_client_id_source: "retailcrm_native_clientId",
      attribution: buildAttribution(o.customFields, ctx.attribution),
      items,
      channel: classifyChannel(o, ctx.channelMap),
      join_key: orderJoinKey(o, ctx.secret),
    },
    paid: typeof o.fullPaidAt === "string" || completePayments.length > 0,
  };
}

// ── Complete /orders pagination with explicit bounds ─────────

type CollectedAnalytics = {
  orders: { order: AnalyticsOrder; paid: boolean }[];
  window_total_count: number;
  complete: boolean;
  partial_reason: "max_pages" | "max_orders" | null;
  continuation_page: number | null;
  generated_at: string | null;
};

export type DateBasis = "created_at" | "full_paid_at";

export async function collectAnalyticsOrders(
  dateFrom: string, dateTo: string, maxPages: number, maxOrders: number, ctx: ProjectionCtx,
  dateBasis: DateBasis = "created_at",
): Promise<CollectedAnalytics> {
  const collected: { order: AnalyticsOrder; paid: boolean }[] = [];
  const seen = new Set<number>();
  let windowTotalCount = 0;
  let generatedAt: string | null = null;
  let page = 1;
  let pagesFetched = 0;
  // The window filter keys follow the tool's business meaning: paid revenue
  // tools filter on the full-paid timestamps, not creation.
  const fromKey = dateBasis === "full_paid_at" ? "filter[fullPaidAtFrom]" : "filter[createdAtFrom]";
  const toKey = dateBasis === "full_paid_at" ? "filter[fullPaidAtTo]" : "filter[createdAtTo]";

  for (;;) {
    if (collected.length >= maxOrders) {
      return finish(collected, windowTotalCount, false, "max_orders", page, generatedAt);
    }
    if (pagesFetched >= maxPages) {
      return finish(collected, windowTotalCount, false, "max_pages", page, generatedAt);
    }
    const resp = await retailCrmGet("/orders", {
      [fromKey]: dateFrom,
      [toKey]: dateTo,
      limit: "100",
      page: String(page),
    }) as { orders?: unknown; pagination?: unknown; generatedAt?: unknown };

    const rawOrders = resp?.orders;
    if (!Array.isArray(rawOrders)) throw new Error("RetailCRM /orders response is malformed (orders array missing)");
    const pg = resp?.pagination;
    if (pg === null || typeof pg !== "object" || Array.isArray(pg)) throw new Error("RetailCRM /orders pagination is malformed");
    const { currentPage, totalPageCount, totalCount } = pg as { currentPage?: unknown; totalPageCount?: unknown; totalCount?: unknown };
    if (typeof currentPage !== "number" || typeof totalPageCount !== "number" || typeof totalCount !== "number") {
      throw new Error("RetailCRM /orders pagination is malformed (non-numeric fields)");
    }
    if (currentPage !== page) throw new Error(`RetailCRM /orders pagination mismatch: requested page ${page}, provider returned ${currentPage}`);
    if (typeof resp.generatedAt === "string" && generatedAt === null) generatedAt = resp.generatedAt;
    windowTotalCount = totalCount;

    for (const raw of rawOrders) {
      const projected = projectOrder(raw as AsxOrderRaw, ctx);
      if ("error" in projected) throw new Error(projected.error);
      if (seen.has(projected.order.id)) throw new Error(`RetailCRM /orders returned duplicate order id ${projected.order.id}`);
      seen.add(projected.order.id);
      collected.push(projected);
    }
    pagesFetched++;

    if (rawOrders.length === 0) {
      if (totalPageCount > page) throw new Error("RetailCRM /orders claimed more pages but returned an empty page");
      return finishComplete(collected, windowTotalCount, generatedAt);
    }
    if (totalPageCount < page) throw new Error("RetailCRM /orders returned orders for a page beyond totalPageCount");
    if (collected.length > totalCount) throw new Error("RetailCRM /orders returned more orders than totalCount");
    if (page >= totalPageCount) return finishComplete(collected, windowTotalCount, generatedAt);
    page++;
  }
}

/** Complete result — but only if the provider's own totalCount agrees with what we traversed. */
function finishComplete(
  orders: CollectedAnalytics["orders"], windowTotalCount: number, generatedAt: string | null,
): CollectedAnalytics {
  if (orders.length !== windowTotalCount) {
    throw new Error(`RetailCRM /orders pagination is inconsistent: collected ${orders.length} orders but totalCount is ${windowTotalCount}`);
  }
  return { orders, window_total_count: windowTotalCount, complete: true, partial_reason: null, continuation_page: null, generated_at: generatedAt };
}

function finish(
  orders: CollectedAnalytics["orders"], windowTotalCount: number, complete: boolean,
  partialReason: CollectedAnalytics["partial_reason"], continuationPage: number | null, generatedAt: string | null,
): CollectedAnalytics {
  return {
    orders, window_total_count: windowTotalCount, complete,
    partial_reason: partialReason, continuation_page: continuationPage, generated_at: generatedAt,
  };
}

function analyticsEnvelope(
  dateFrom: string, dateTo: string, c: CollectedAnalytics, dateBasis: DateBasis,
  bounds: { max_pages: number; max_orders: number },
) {
  const orders = c.orders.map(e => e.order);
  const revenue = round2(orders.reduce((sum, o) => sum + (o.total ?? 0), 0));
  return {
    period: { from: dateFrom, to: dateTo },
    date_basis: dateBasis,
    generated_at: c.generated_at,
    count: orders.length,
    window_total_count: c.window_total_count,
    complete: c.complete,
    partial_reason: c.partial_reason,
    continuation_page: c.continuation_page,
    bounds: {
      max_pages: bounds.max_pages,
      max_orders: bounds.max_orders,
      // max_orders is a PAGE-ALIGNED SOFT STOP, not a hard per-record cap:
      // collection halts before FETCHING another page once the bound is
      // reached, so the final count may overshoot by at most one 100-order
      // page. max_pages is a hard bound. A stopped result is always partial
      // with reason + continuation page.
      semantics: "page_aligned_soft_stop",
    },
    totals: {
      revenue,
      average_order_value: orders.length ? round2(revenue / orders.length) : null,
      revenue_scope: c.complete ? "complete" : "partial_window",
    },
    channel_completeness: {
      mapped: orders.filter(o => o.channel.value !== "unknown").length,
      unknown: orders.filter(o => o.channel.value === "unknown").length,
    },
    orders,
  };
}

// ── retailcrm_attribution_fields ─────────────────────────────

export const attributionFieldsSchema = z.object({
  search: z.string().trim().min(1)
    .describe("Case-insensitive search term matched against order custom-field code and name (e.g. 'yclid', 'utm')"),
});

export async function handleAttributionFields(params: z.infer<typeof attributionFieldsSchema>): Promise<ToolResult> {
  return runTool(async () => {
    // The request itself is scoped to order metadata (filter[entity]=order):
    // the tool never asks for — and cannot receive — other entities' metadata
    // or any field VALUES (custom_fields_read scope only).
    const resp = await retailCrmGet("/custom-fields", { "filter[entity]": "order" }) as { customFields?: unknown };
    const map = resp?.customFields;
    if (map === null || typeof map !== "object") {
      throw new Error("RetailCRM /custom-fields response is malformed (customFields container missing)");
    }
    const arrayForm = Array.isArray(map);
    const entries: [string, unknown][] = arrayForm
      ? map.map((entry, index): [string, unknown] => [String(index), entry])
      : Object.entries(map as Record<string, unknown>);
    const fields: { code: string; name: string | null; type: string | null; entity: string }[] = [];
    let orderFields = 0;
    const needle = params.search.toLowerCase();
    for (const [key, entry] of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`RetailCRM custom field "${key}" metadata is malformed`);
      }
      const e = entry as { code?: unknown; name?: unknown; type?: unknown; entity?: unknown };
      if (arrayForm && (typeof e.code !== "string" || e.code === "")) {
        throw new Error(`RetailCRM custom field at array index ${key} metadata is malformed (code missing)`);
      }
      // Because the request is entity-filtered, the provider may omit the
      // entity key on returned entries; an explicitly non-order entity is out
      // of scope and skipped. Structurally malformed entries still fail closed.
      if (e.entity !== undefined && e.entity !== "order") continue;
      orderFields++;
      const code = typeof e.code === "string" && e.code !== "" ? e.code : key;
      const name = typeof e.name === "string" ? e.name : null;
      if (!code.toLowerCase().includes(needle) && !(name !== null && name.toLowerCase().includes(needle))) continue;
      fields.push({ code, name, type: typeof e.type === "string" ? e.type : null, entity: "order" });
    }
    return ok({
      search: params.search,
      entity: "order",
      total_order_fields: orderFields,
      matched: fields.length,
      fields,
      note: "Metadata only — this tool never reads order custom-field values",
    });
  });
}

// ── retailcrm_orders_analytics / retailcrm_paid_orders ───────

const windowShape = {
  date_from: dateField("Start of the analytics window (YYYY-MM-DD)"),
  date_to: dateField("End of the analytics window (YYYY-MM-DD)"),
  max_pages: z.number().int().min(1).max(1000).default(100)
    .describe("Upper bound on /orders pages fetched (100/page; default 100 pages = 10,000 orders)"),
  max_orders: z.number().int().min(1).max(200_000).default(10_000)
    .describe("Page-aligned SOFT stop on collected orders (default 10,000): halts before fetching another page once reached, so the final count may overshoot by at most one 100-order page — not a hard per-record cap; a stopped result is partial with reason + continuation page"),
};

export const ordersAnalyticsSchema = z.object(windowShape);
export const paidOrdersSchema = z.object(windowShape);

export async function handleOrdersAnalytics(params: z.infer<typeof ordersAnalyticsSchema>): Promise<ToolResult> {
  return runTool(async () => {
    const guard = guardConfig();
    if ("error" in guard) return fail(guard.error);
    const ctx: ProjectionCtx = { ...guard, paidStatusCodes: await fetchPaidStatusCodes() };
    // Window basis: order CREATION time (filter[createdAtFrom]/[To]).
    const collected = await collectAnalyticsOrders(params.date_from, params.date_to, params.max_pages, params.max_orders, ctx, "created_at");
    return ok({
      ...analyticsEnvelope(params.date_from, params.date_to, collected, "created_at", { max_pages: params.max_pages, max_orders: params.max_orders }),
      attribution_configured_keys: configuredAttributionKeys(guard.attribution),
    });
  });
}

export async function handlePaidOrders(params: z.infer<typeof paidOrdersSchema>): Promise<ToolResult> {
  return runTool(async () => {
    const guard = guardConfig();
    if ("error" in guard) return fail(guard.error);
    const ctx: ProjectionCtx = { ...guard, paidStatusCodes: await fetchPaidStatusCodes() };
    // Window basis: FULL-PAID time (filter[fullPaidAtFrom]/[To]) — the tool's
    // business output is paid revenue, so the period selects when orders were
    // fully paid, not when they were created. date_basis says so in the output.
    const collected = await collectAnalyticsOrders(params.date_from, params.date_to, params.max_pages, params.max_orders, ctx, "full_paid_at");
    const paidOnly = collected.orders.filter(e => e.paid);
    return ok({
      ...analyticsEnvelope(params.date_from, params.date_to, { ...collected, orders: paidOnly }, "full_paid_at", { max_pages: params.max_pages, max_orders: params.max_orders }),
      paid_count: paidOnly.length,
      attribution_configured_keys: configuredAttributionKeys(guard.attribution),
    });
  });
}

// ── retailcrm_order_attribution ──────────────────────────────

export const orderAttributionSchema = z.object({
  id: z.string().min(1).describe("RetailCRM order id or externalId"),
  by: z.enum(["id", "externalId"]).default("id").describe("Lookup field: 'id' (RetailCRM ID) or 'externalId'"),
});

export async function handleOrderAttribution(params: z.infer<typeof orderAttributionSchema>): Promise<ToolResult> {
  return runTool(async () => {
    const guard = guardConfig();
    if ("error" in guard) return fail(guard.error);
    const paidStatusCodes = await fetchPaidStatusCodes();
    const query: Record<string, string> = params.by === "externalId" ? { by: "externalId" } : {};
    const resp = (await retailCrmGet(`/orders/${encodeURIComponent(params.id)}`, query)) as { order?: unknown; generatedAt?: unknown };
    const raw = resp?.order;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("RetailCRM order response is malformed (order object missing)");
    }
    const projected = projectOrder(raw as AsxOrderRaw, { ...guard, paidStatusCodes });
    if ("error" in projected) return fail(projected.error);
    return ok({
      generated_at: typeof resp.generatedAt === "string" ? resp.generatedAt : null,
      attribution_configured_keys: configuredAttributionKeys(guard.attribution),
      order: projected.order,
    });
  });
}

// ── retailcrm_order_history_analytics (official sinceId cursor) ─
//
// Primary source: docs.retailcrm.ru/Developers/API/APIFeatures/WorkingHistoryAPI —
// since 2023-05-15 the API rejects filter[sinceId] sent together with `page`
// (HTTP 400). The official incremental algorithm is therefore cursor-based:
// the first call carries no sinceId (unless the caller supplies a resume
// cursor) and NEVER a page parameter; each subsequent call sends only
// filter[sinceId] = the maximum processed history id. After each portion,
// pagination is inspected: totalPageCount > 1 signals another cursor fetch
// with sinceId = last processed id; totalPageCount <= 1 completes the feed.
// An empty page while totalPageCount > 1 is contradictory and fails closed.
// The same sinceId is never sent twice; a page whose maximum id does not
// advance the cursor fails closed.

const HISTORY_LIMIT = 100;

// Allowlisted change fields (criterion 10): OLD/NEW values are exposed ONLY
// for safe status and payment fields. Business fields such as fullPaidAt,
// orderMethod, site, totalSumm and currency — and everything else: comments,
// customer data, delivery addresses, arbitrary custom fields — are omitted
// entirely, not blanked.
const HISTORY_FIELD_MAP: Record<string, string> = {
  status: "status",
  payments: "payments",
};

const HISTORY_PAYMENT_FIELDS = new Set(["status", "paidAt", "amount", "type"]);

export type HistoryRecord = {
  id: number;
  order_id: number | null;
  order_external_id: string | null;
  created_at: string | null;
  source: string | null;
  join_key: string | null;
  // Why join_key is null, when it is: history records carry no order `number`,
  // so the /orders basis (externalId → number → id) cannot be honored past
  // externalId, and a missing secret also yields null (legacy callers).
  join_key_omitted_reason: "no_order_external_id" | "analytics_secret_unavailable" | null;
  changes: Record<string, { old: unknown; new: unknown }>;
};

/** History values are mixed (scalars, status objects, payment dicts) — sanitize deny-by-default. */
function sanitizeHistoryValue(field: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  // payments: ONLY the documented dictionary shape ({code: {status, paidAt, amount, type}})
  // is accepted — scalar/array/anomalous payments values fail closed to null.
  if (field === "payments") {
    if (typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [code, val] of Object.entries(o)) {
      if (val === null || typeof val !== "object" || Array.isArray(val)) { out[code] = null; continue; }
      const p = val as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const k of HISTORY_PAYMENT_FIELDS) {
        const pv = p[k];
        safe[k] = typeof pv === "string" || typeof pv === "number" ? pv : null;
      }
      out[code] = safe;
    }
    return out;
  }
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    // Nested status-like objects: the code is the value we actually want.
    if (field === "status" && typeof o.code === "string") return o.code;
    // Any other object: allowlisted payment fields only (defensive).
    const out: Record<string, unknown> = {};
    for (const k of HISTORY_PAYMENT_FIELDS) {
      if (!(k in o)) continue;
      const val = o[k];
      out[k] = typeof val === "string" || typeof val === "number" ? val : null;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null; // arrays and anything else are omitted
}

interface AsxHistoryRecordRaw {
  id?: unknown;
  orderId?: unknown; order_id?: unknown;
  orderExternalId?: unknown; order_external_id?: unknown;
  createdAt?: unknown; created_at?: unknown;
  source?: unknown;
  field?: unknown;
  oldValue?: unknown; newValue?: unknown; old_value?: unknown; new_value?: unknown;
  changes?: unknown;
}

function historyChangeViews(rec: AsxHistoryRecordRaw): Record<string, { old: unknown; new: unknown }> {
  const pairs: { field: string; old: unknown; new: unknown }[] = [];
  const push = (field: unknown, oldV: unknown, newV: unknown) => {
    if (typeof field !== "string") return;
    pairs.push({ field, old: oldV, new: newV });
  };
  if (Array.isArray(rec.changes)) {
    // Nested api-client shape: changes: [{field, oldValue, newValue}] (wins when both shapes appear).
    // Presence rule: an explicitly present camelCase value (even null) WINS; the legacy
    // snake_case field is consulted only when the camelCase property is ABSENT.
    for (const c of rec.changes) {
      if (c === null || typeof c !== "object") continue;
      const cc = c as { field?: unknown; oldValue?: unknown; newValue?: unknown; old_value?: unknown; new_value?: unknown };
      push(cc.field, "oldValue" in cc ? cc.oldValue : cc.old_value, "newValue" in cc ? cc.newValue : cc.new_value);
    }
  } else if (typeof rec.field === "string") {
    // Flat legacy shape: {field, old_value, new_value} on the record itself — same presence rule.
    push(rec.field, "oldValue" in rec ? rec.oldValue : rec.old_value, "newValue" in rec ? rec.newValue : rec.new_value);
  }
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const p of pairs) {
    const safeName = HISTORY_FIELD_MAP[p.field];
    if (safeName === undefined) continue; // not allowlisted → omitted entirely
    out[safeName] = { old: sanitizeHistoryValue(p.field, p.old), new: sanitizeHistoryValue(p.field, p.new) };
  }
  return out;
}

/** PII-free history projection. ctx = null (legacy callers) omits the join key instead of failing. */
export function projectHistoryRecord(raw: unknown, ctx: { secret: string } | null): HistoryRecord | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "history record is malformed (not an object)" };
  const rec = raw as AsxHistoryRecordRaw;
  const id = typeof rec.id === "number" && Number.isFinite(rec.id) ? rec.id : null;
  if (id === null) return { error: "history record is malformed: missing numeric id" };
  const rawOrderId = rec.orderId ?? rec.order_id;
  const orderId = typeof rawOrderId === "number" ? rawOrderId : null;
  const rawExternalId = rec.orderExternalId ?? rec.order_external_id;
  const externalId = typeof rawExternalId === "string" && rawExternalId.trim() !== "" ? rawExternalId : null;
  const rawCreatedAt = rec.createdAt ?? rec.created_at;
  // Join-key honesty (criterion 5): the /orders basis is externalId → number →
  // id, but history records carry no order `number`. Without an externalId we
  // cannot produce the same key the /orders feed would — HMAC-ing the CRM id
  // here would silently create a DIFFERENT key for the same order (false
  // join). So: externalId present → normal key; absent → null with an
  // explicit, non-PII omission reason. The CRM id is never used as a basis.
  let joinKey: string | null = null;
  let joinKeyOmittedReason: HistoryRecord["join_key_omitted_reason"] = null;
  if (ctx !== null) {
    if (externalId !== null) {
      joinKey = orderJoinKey({ externalId }, ctx.secret);
      if (joinKey === null) joinKeyOmittedReason = "no_order_external_id";
    } else {
      joinKeyOmittedReason = "no_order_external_id";
    }
  } else {
    joinKeyOmittedReason = "analytics_secret_unavailable";
  }
  return {
    id,
    order_id: orderId,
    order_external_id: externalId,
    created_at: typeof rawCreatedAt === "string" ? rawCreatedAt : null,
    source: typeof rec.source === "string" ? rec.source : null,
    join_key: joinKey,
    join_key_omitted_reason: joinKeyOmittedReason,
    changes: historyChangeViews(rec),
  };
}

type CollectedHistory = {
  records: HistoryRecord[];
  next_since_id: number;
  complete: boolean;
  partial_reason: "max_pages" | "max_records" | null;
  continuation_since_id: number | null;
  generated_at: string | null;
};

export async function collectHistoryAnalytics(
  sinceId: number, maxPages: number, maxRecords: number, ctx: { secret: string },
): Promise<CollectedHistory> {
  const records: HistoryRecord[] = [];
  const seen = new Set<number>();
  let maxId = sinceId;
  let cursor: number | null = sinceId > 0 ? sinceId : null;
  let generatedAt: string | null = null;
  let rounds = 0;

  for (;;) {
    if (records.length >= maxRecords) {
      return { records, next_since_id: maxId, complete: false, partial_reason: "max_records", continuation_since_id: maxId, generated_at: generatedAt };
    }
    if (rounds >= maxPages) {
      return { records, next_since_id: maxId, complete: false, partial_reason: "max_pages", continuation_since_id: maxId, generated_at: generatedAt };
    }
    const params: Record<string, string> = { limit: String(HISTORY_LIMIT) };
    if (cursor !== null) params["filter[sinceId]"] = String(cursor);
    // Deliberately NO page parameter: the API rejects filter[sinceId] + page
    // with HTTP 400 since 2023-05-15 (official cursor algorithm).
    const resp = await retailCrmGet("/orders/history", params) as { history?: unknown; pagination?: unknown; generatedAt?: unknown };
    const rawHistory = resp?.history;
    if (!Array.isArray(rawHistory)) throw new Error("RetailCRM /orders/history response is malformed (history array missing)");
    const pg = resp?.pagination;
    if (pg === null || typeof pg !== "object" || Array.isArray(pg)) throw new Error("RetailCRM /orders/history pagination is malformed");
    const totalPageCount = (pg as { totalPageCount?: unknown }).totalPageCount;
    if (typeof totalPageCount !== "number") throw new Error("RetailCRM /orders/history pagination is malformed (non-numeric totalPageCount)");
    if (typeof resp.generatedAt === "string" && generatedAt === null) generatedAt = resp.generatedAt;

    let pageMax = 0;
    for (const raw of rawHistory) {
      const projected = projectHistoryRecord(raw, ctx);
      if ("error" in projected) throw new Error(projected.error);
      if (seen.has(projected.id)) throw new Error(`RetailCRM /orders/history returned duplicate history id ${projected.id}`);
      seen.add(projected.id);
      records.push(projected);
      if (projected.id > pageMax) pageMax = projected.id;
      if (projected.id > maxId) maxId = projected.id;
    }
    rounds++;

    if (rawHistory.length === 0) {
      if (totalPageCount > 1) throw new Error("RetailCRM /orders/history claimed more pages but returned an empty cursor page");
      return { records, next_since_id: maxId, complete: true, partial_reason: null, continuation_since_id: null, generated_at: generatedAt };
    }
    if (pageMax <= (cursor ?? 0)) {
      throw new Error(`RetailCRM /orders/history did not advance the sinceId cursor (cursor ${cursor ?? 0}, page max id ${pageMax})`);
    }
    if (totalPageCount <= 1) {
      return { records, next_since_id: maxId, complete: true, partial_reason: null, continuation_since_id: null, generated_at: generatedAt };
    }
    cursor = maxId; // next round fetches strictly after everything processed so far — never the same cursor twice
  }
}

export const orderHistoryAnalyticsSchema = z.object({
  since_id: z.number().int().min(0).optional()
    .describe("Resume incremental sync from this history id (exclusive): sent as filter[sinceId] on the FIRST call only"),
  max_pages: z.number().int().min(1).max(1000).default(100)
    .describe("Upper bound on cursor fetch rounds (100 records each; default 100 = 10,000 records)"),
  max_records: z.number().int().min(1).max(200_000).default(10_000)
    .describe("Page-aligned SOFT stop on collected history records (default 10,000): halts before another cursor round once reached, so the final count may overshoot by at most one 100-record page — not a hard per-record cap"),
});

export async function handleOrderHistoryAnalytics(params: z.infer<typeof orderHistoryAnalyticsSchema>): Promise<ToolResult> {
  return runTool(async () => {
    const guard = guardConfig();
    if ("error" in guard) return fail(guard.error);
    const sinceId = params.since_id ?? 0;
    const collected = await collectHistoryAnalytics(sinceId, params.max_pages, params.max_records, { secret: guard.secret });
    return ok({
      since_id: sinceId,
      next_since_id: collected.next_since_id,
      count: collected.records.length,
      complete: collected.complete,
      partial_reason: collected.partial_reason,
      continuation_since_id: collected.continuation_since_id,
      generated_at: collected.generated_at,
      bounds: {
        max_pages: params.max_pages,
        max_records: params.max_records,
        // max_records is a PAGE-ALIGNED SOFT STOP, not a hard per-record cap:
        // the feed halts before FETCHING another cursor round once the bound
        // is reached, so the final count may overshoot by at most one
        // 100-record page. max_pages is a hard bound on cursor rounds.
        semantics: "page_aligned_soft_stop",
      },
      note: "Official /orders/history sinceId cursor: no page parameter is ever sent; resume with since_id = next_since_id.",
      records: collected.records,
    });
  });
}
