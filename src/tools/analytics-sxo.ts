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
  // Provider payloads may contain null/undefined/primitive entries; each tranche
  // is validated before any dereference — never asserted into a typed shape.
  prices?: unknown[] | null;
  vatRate?: string;
  purchasePrice?: number;
  isCanceled?: boolean;
}

/** A raw provider item entry is usable only when it is a plain non-array object. */
function safeItemRaw(v: unknown): AsxItemRaw | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as AsxItemRaw;
}

interface AsxPaymentRaw { status?: string; paidAt?: string; amount?: number }

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
  items?: unknown[] | null;
  payments?: Record<string, AsxPaymentRaw> | null;
  delivery?: { code?: string; cost?: number; netCost?: number; vatRate?: string; address?: unknown; service?: unknown } | null;
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

// ── Optional economics configuration (explicit, never guessed) ─

const ECONOMICS_KEYS = ["outside_mkad_surcharge", "commission_total", "return_total"] as const;
export type EconomicsKey = (typeof ECONOMICS_KEYS)[number];

export type EconomicsConfig =
  | { configured: false }
  | { configured: true; codes: Partial<Record<EconomicsKey, string>> };

const isEconomicsKey = (k: string): k is EconomicsKey => (ECONOMICS_KEYS as readonly string[]).includes(k);

export function loadEconomicsConfig(env: NodeJS.ProcessEnv = process.env): EconomicsConfig | { error: string } {
  const raw = env.RETAILCRM_ANALYTICS_ECONOMICS;
  if (!raw) return { configured: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "RETAILCRM_ANALYTICS_ECONOMICS is not valid JSON (expected {canonical_key: custom_field_code})" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "RETAILCRM_ANALYTICS_ECONOMICS must be a JSON object mapping canonical keys to custom-field codes" };
  }
  const codes: Partial<Record<EconomicsKey, string>> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isEconomicsKey(key)) {
      return { error: `RETAILCRM_ANALYTICS_ECONOMICS: unknown key "${key}" (allowed: ${ECONOMICS_KEYS.join(", ")})` };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { error: `RETAILCRM_ANALYTICS_ECONOMICS: key "${key}" must map to a non-empty custom-field code` };
    }
    const code = value.trim();
    if (seen.has(code)) return { error: `RETAILCRM_ANALYTICS_ECONOMICS: duplicate custom-field code "${code}"` };
    seen.add(code);
    codes[key] = code;
  }
  return { configured: true, codes };
}

export type EconomicsAmountView = {
  value: number | null;
  field_code: string | null;
  source: "configured_custom_field" | "unconfigured";
  omitted_reason: string | null;
};

/** Only finite non-negative NUMBERS are economics amounts — strings are never coerced. */
function extractEconomicsAmounts(
  customFields: Record<string, unknown> | null | undefined, cfg: EconomicsConfig,
): Record<EconomicsKey, EconomicsAmountView> {
  const out: Record<EconomicsKey, EconomicsAmountView> = {} as Record<EconomicsKey, EconomicsAmountView>;
  for (const key of ECONOMICS_KEYS) {
    const code = cfg.configured ? cfg.codes[key] : undefined;
    if (!code) {
      out[key] = { value: null, field_code: null, source: "unconfigured", omitted_reason: "not_configured" };
      continue;
    }
    const cf = customFields !== null && typeof customFields === "object" && !Array.isArray(customFields)
      ? customFields as Record<string, unknown> : null;
    if (cf === null || !hasOwn(cf, code)) {
      out[key] = { value: null, field_code: code, source: "configured_custom_field", omitted_reason: "field_absent_on_order" };
      continue;
    }
    const v = cf[code];
    if (!isFiniteNumber(v) || v < 0) {
      out[key] = { value: null, field_code: code, source: "configured_custom_field", omitted_reason: "not_a_finite_non_negative_number" };
      continue;
    }
    out[key] = { value: v, field_code: code, source: "configured_custom_field", omitted_reason: null };
  }
  return out;
}

export const configuredEconomicsKeys = (cfg: EconomicsConfig): string[] =>
  cfg.configured ? Object.keys(cfg.codes).sort() : [];

// ── Sales channel (authoritative customFields.sales_channel) ──

export type Channel = "site" | "phone" | "chat" | "ozon" | "other_marketplace" | "unknown";

// Authoritative sales-channel contract: the sole evidence is the order's own
// customFields.sales_channel value (fixed field code — never configurable).
export type SalesChannel = "PETDOG_RU" | "OZON" | "OTHER_MARKETPLACE" | "B2B" | "B2G" | "UNKNOWN";

const SALES_CHANNEL_FIELD_CODE = "sales_channel";

// Deployed lowercase dictionary codes and canonical uppercase spellings —
// exact strings only (matched against the original value, no case folding
// or trim): mixed-case and whitespace-padded spellings are unsupported.
const SALES_CHANNEL_CODES: Record<string, Exclude<SalesChannel, "UNKNOWN">> = {
  petdog_ru: "PETDOG_RU",
  ozon: "OZON",
  other_marketplace: "OTHER_MARKETPLACE",
  b2b: "B2B",
  b2g: "B2G",
  PETDOG_RU: "PETDOG_RU",
  OZON: "OZON",
  OTHER_MARKETPLACE: "OTHER_MARKETPLACE",
  B2B: "B2B",
  B2G: "B2G",
};

export type SalesChannelView = {
  value: SalesChannel;
  field_code: typeof SALES_CHANNEL_FIELD_CODE;
  source: "order.customFields";
  omitted_reason: string | null;
};

/**
 * Reads ONLY the order's own-property customFields.sales_channel. Absent,
 * empty, non-string and unsupported values fail closed to UNKNOWN with a
 * bounded machine-readable reason; the raw unsupported value is never
 * exposed. delivery.code, orderMethod, site, native source and attribution
 * never participate in sales-channel classification.
 */
export function extractSalesChannel(o: AsxOrderRaw): SalesChannelView {
  const base = { field_code: SALES_CHANNEL_FIELD_CODE, source: "order.customFields" } as const;
  const cf = o.customFields !== null && typeof o.customFields === "object" && !Array.isArray(o.customFields)
    ? (o.customFields as Record<string, unknown>) : null;
  if (cf === null || !hasOwn(cf, SALES_CHANNEL_FIELD_CODE)) {
    return { ...base, value: "UNKNOWN", omitted_reason: "field_absent_on_order" };
  }
  const v = cf[SALES_CHANNEL_FIELD_CODE];
  if (typeof v !== "string") return { ...base, value: "UNKNOWN", omitted_reason: "not_a_string" };
  if (v.trim() === "") return { ...base, value: "UNKNOWN", omitted_reason: "empty" };
  const canonical = hasOwn(SALES_CHANNEL_CODES as Record<string, unknown>, v)
    ? SALES_CHANNEL_CODES[v as keyof typeof SALES_CHANNEL_CODES]
    : undefined;
  if (canonical === undefined) return { ...base, value: "UNKNOWN", omitted_reason: "unsupported_value" };
  return { ...base, value: canonical, omitted_reason: null };
}

export type ChannelBasis = "sales_channel" | "unmapped";

// Legacy compatibility taxonomy: derived ONLY from the authoritative value.
// B2B/B2G have no legacy representation and map to legacy "unknown" while
// sales_channel keeps the authoritative value.
const LEGACY_CHANNEL_FROM_SALES: Record<Exclude<SalesChannel, "UNKNOWN">, Channel> = {
  PETDOG_RU: "site",
  OZON: "ozon",
  OTHER_MARKETPLACE: "other_marketplace",
  B2B: "unknown",
  B2G: "unknown",
};

/** Legacy `channel` view derived only from the authoritative sales-channel result — no delivery/orderMethod/site/source fallback. */
export function deriveChannel(sales: SalesChannelView): { value: Channel; basis: ChannelBasis } {
  if (sales.value === "UNKNOWN") return { value: "unknown", basis: "unmapped" };
  return { value: LEGACY_CHANNEL_FROM_SALES[sales.value], basis: "sales_channel" };
}

// ── Shared guard (fail closed before any bridge call) ────────

type AnalyticsGuard = { secret: string; attribution: AttributionConfig; economics: EconomicsConfig };

function guardConfig(): AnalyticsGuard | { error: string } {
  const secretCheck = checkAnalyticsSecret();
  if (!secretCheck.ok) return { error: secretCheck.reason };
  const attribution = loadAttributionConfig();
  if ("error" in attribution) return attribution;
  const economics = loadEconomicsConfig();
  if ("error" in economics) return economics;
  return { secret: secretCheck.secret, attribution, economics };
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

// ── Order lifecycle reference (v5 commercial lifecycle) ──────

// Exact status-code → provider group map from /reference/statuses. The
// provider group is the ONLY cancellation evidence; display text, delivery,
// payment state, order method, source and item isCanceled never participate.
export type CrmStatusGroupMap = ReadonlyMap<string, string>;

/**
 * Strict fail-closed parser for /reference/statuses: accepts only an object
 * map of status entries whose `group` is a non-empty string. Malformed
 * containers or entries throw a bounded error before any analytics is
 * published. A response with no `statuses` container at all yields an empty
 * map — classification then fails closed per order to UNKNOWN.
 */
export async function fetchStatusGroups(): Promise<CrmStatusGroupMap> {
  const resp = await retailCrmGet("/reference/statuses") as { statuses?: unknown };
  const map = resp?.statuses;
  if (map === undefined) return new Map<string, string>();
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("RetailCRM order statuses response is malformed (expected statuses object)");
  }
  const groups = new Map<string, string>();
  for (const [code, entry] of Object.entries(map as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`RetailCRM order status "${code}" is malformed`);
    }
    const group = (entry as { group?: unknown }).group;
    if (typeof group !== "string" || group.trim() === "") {
      throw new Error(`RetailCRM order status "${code}" has a malformed group (expected non-empty string)`);
    }
    groups.set(code, group);
  }
  return groups;
}

// ── Commercial lifecycle classification (v5) ─────────────────

export type LifecycleClass = "INCLUDED" | "CANCELLED" | "RETURNED" | "UNKNOWN";

export type OrderLifecycle = {
  class: LifecycleClass;
  commercial_included: boolean;
  status_code: string | null;
  status_group: string | null;
  basis: string;
  omitted_reason: string | null;
};

/**
 * Lifecycle precedence (docs/criteria/retailcrm-commercial-lifecycle-v5.md):
 * RETURNED only for an exact configured economics.return_total numeric value
 * > 0; CANCELLED only when the exact provider status map says group "cancel";
 * INCLUDED for a mapped non-cancel group; UNKNOWN for a missing, non-string
 * or unmapped status (fail closed, commercial_included=false). No raw value
 * beyond the already-allowlisted order status is ever exposed.
 */
export function buildLifecycle(
  statusCode: string | null,
  statusGroup: string | undefined,
  returnTotalValue: number | null,
): OrderLifecycle {
  if (returnTotalValue !== null && returnTotalValue > 0) {
    return {
      class: "RETURNED", commercial_included: false,
      status_code: statusCode, status_group: statusGroup ?? null,
      basis: "economics.return_total>0", omitted_reason: "returned_excluded_from_commercial_result",
    };
  }
  if (statusCode === null) {
    return {
      class: "UNKNOWN", commercial_included: false,
      status_code: null, status_group: null,
      basis: "order.status", omitted_reason: "status_missing_or_not_a_string",
    };
  }
  if (statusGroup === undefined) {
    return {
      class: "UNKNOWN", commercial_included: false,
      status_code: statusCode, status_group: null,
      basis: "reference.statuses", omitted_reason: "status_not_in_reference_map",
    };
  }
  if (statusGroup === "cancel") {
    return {
      class: "CANCELLED", commercial_included: false,
      status_code: statusCode, status_group: statusGroup,
      basis: "reference.statuses:group_cancel", omitted_reason: "cancelled_excluded_from_commercial_result",
    };
  }
  return {
    class: "INCLUDED", commercial_included: true,
    status_code: statusCode, status_group: statusGroup,
    basis: "reference.statuses:group_non_cancel", omitted_reason: null,
  };
}

// ── PII-free projection ──────────────────────────────────────

/** Item VAT evidence: only unambiguous exactly-10%/22% representations are accepted. */
export type ItemVatStatus = "accepted_10_22" | "missing" | "unexpected";

const ACCEPTED_VAT_RATES = ["10%", "10", "22%", "22", "vat10", "vat22"] as const;

/** Exact VAT strings meaning exactly 10% or 22% (case-insensitive; optional % and zero decimals). */
export function vatStatus(v?: string | null): ItemVatStatus {
  if (typeof v !== "string") return "missing";
  const s = v.trim();
  if (s === "") return "missing";
  const lower = s.toLowerCase();
  if ((ACCEPTED_VAT_RATES as readonly string[]).includes(lower)) return "accepted_10_22";
  // 10.0% / 22.00 — zero decimals only, no other numeric value.
  if (/^(10|22)(\.0+)?%?$/i.test(s)) return "accepted_10_22";
  return "unexpected";
}

export type AnalyticsItem = {
  sku: string | null;
  quantity: number | null;
  revenue: number | null;
  vat_rate: string | null;
  vat_status: ItemVatStatus;
  purchase_price: number | null;
  cogs: number | null;
  cancelled: boolean | null;
};

export type AnalyticsDelivery = {
  code: string | null;
  cost: number | null;
  net_cost: number | null;
  vat_rate: string | null;
};

export type EconomicsCompleteness = {
  item_cogs: boolean;
  item_vat: boolean;
  delivery_actual_cost: boolean;
  outside_mkad_surcharge: boolean;
  commission_total: boolean;
  return_total: boolean;
};

export type OrderEconomics = {
  item_cogs_total: number | null;
  delivery_actual_cost: number | null;
  outside_mkad_surcharge: EconomicsAmountView;
  commission_total: EconomicsAmountView;
  return_total: EconomicsAmountView;
  known_costs_total: number | null;
  completeness: EconomicsCompleteness;
};

// ── Payment evidence (full-paid contract v3) ─────────────────
//
// order.fullPaidAt is the SOLE RetailCRM full-payment fact. The reference
// payment-status flag paymentComplete selects individual payments for AMOUNT
// evidence only — it never establishes order-level full payment, and no
// payments[].paidAt is ever copied into order-level paid_at. FINANCE_CONFIRMED
// is reserved for a downstream settlement join this MCP does not have.

export type PaymentEvidenceStatus = "CRM_PAID" | "PARTIAL" | "UNKNOWN";

export type PaymentEvidence = {
  crm_fully_paid: boolean;
  crm_paid_amount: number | null;
  amount_matches: boolean | null;
  evidence_status: PaymentEvidenceStatus;
  full_payment_source: "order.fullPaidAt";
  paid_amount_source: "payments[].amount where reference payment status paymentComplete=true";
  finance_confirmation_source: null;
};

/**
 * crm_paid_amount (criterion 4): cent-rounded sum of the `amount` of every
 * complete payment. 0 for an absent/null container or no complete payments.
 * null for a structurally invalid container (array/primitive) or any selected
 * complete payment whose amount is missing, non-number, non-finite or
 * negative. Numeric strings are never coerced. A record/dictionary is the
 * only valid non-empty container; malformed NON-complete entries are ignored
 * (they are not selected and so contribute no amount evidence).
 */
// Integer-kopeck conversion for payment-contract amounts. Math.round(n*100)
// suffers binary-float error (1.005*100 === 100.49999... → 100); instead the
// decimal String representation is split into coefficient/exponent and the
// exponent is decimal-shifted by +2, so 1.005 → "1005e-1" → 100.5 → 101.
function toKopecks(n: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const s = n.toString();
  const eIndex = s.indexOf("e");
  const mant = eIndex === -1 ? s : s.slice(0, eIndex);
  const exp = eIndex === -1 ? 0 : parseInt(s.slice(eIndex + 1), 10);
  if (!Number.isInteger(exp)) return null;
  const dot = mant.indexOf(".");
  const fracDigits = dot === -1 ? 0 : mant.length - dot - 1;
  const coeff = mant.replace(".", "");
  if (coeff === "" || coeff === "-") return null;
  const shifted = Number(`${coeff}e${exp - fracDigits + 2}`);
  if (!Number.isFinite(shifted)) return null;
  const kopecks = Math.round(shifted);
  if (!Number.isSafeInteger(kopecks)) return null;
  return kopecks;
}

/**
 * Sums the validated amounts of every selected complete payment and converts
 * the total to integer kopecks. Also returns null when the sum is finite and
 * non-negative but its integer-kopeck value exceeds Number safe-integer
 * precision (unsafe integer-kopeck conversion returns null, never a lossy
 * amount).
 */
export function computeCrmPaidAmount(payments: unknown, paidStatusCodes: Set<string>): number | null {
  if (payments === undefined || payments === null) return 0;
  if (typeof payments !== "object" || Array.isArray(payments)) return null;
  let sum = 0;
  for (const v of Object.values(payments as Record<string, unknown>)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const p = v as AsxPaymentRaw;
    if (typeof p.status !== "string" || !paidStatusCodes.has(p.status)) continue;
    if (!nonNegativeFinite(p.amount)) return null;
    sum += p.amount;
    if (!Number.isFinite(sum)) return null;
  }
  const kopecks = toKopecks(sum);
  if (kopecks === null) return null;
  return kopecks / 100;
}

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
  items: AnalyticsItem[];
  delivery: AnalyticsDelivery | null;
  sales_channel: SalesChannelView;
  channel: { value: Channel; basis: ChannelBasis };
  economics: OrderEconomics;
  lifecycle: OrderLifecycle;
  payment_evidence: PaymentEvidence;
  join_key: string | null;
};

// statusGroups is optional for legacy direct projectOrder callers: an absent
// map classifies fail-closed to UNKNOWN (never a guessed lifecycle).
type ProjectionCtx = AnalyticsGuard & { paidStatusCodes: Set<string>; statusGroups?: CrmStatusGroupMap };

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Item revenue from the FINAL realization prices (current OpenAPI evidence):
 * when a non-empty prices[] consists entirely of numeric price+quantity
 * tranches, every price*quantity is summed. Otherwise fall back to
 * initialPrice * quantity - discountTotal — discountTotal is the TOTAL
 * discount applied to the line (src/types.ts), not per-unit. A usable
 * tranche requires finite non-negative price AND quantity; a negative or
 * malformed entry invalidates the whole prices path. Malformed or negative
 * numeric material yields null; amounts are never guessed, never clamped
 * to zero and never coerced from strings.
 */
function itemRevenue(it: AsxItemRaw, quantity: number | null): number | null {
  const prices = Array.isArray(it.prices) ? it.prices : [];
  if (prices.length > 0) {
    let total = 0;
    let allValid = true;
    for (const t of prices) {
      if (t === null || typeof t !== "object") {
        allValid = false;
        break;
      }
      const tranche = t as { price?: unknown; quantity?: unknown };
      if (nonNegativeFinite(tranche.price) && nonNegativeFinite(tranche.quantity)) {
        total += tranche.price * tranche.quantity;
      } else {
        allValid = false;
        break;
      }
    }
    if (allValid && Number.isFinite(total)) return round2(total);
  }
  // Fallback only on genuine finite non-negative inputs.
  if (!nonNegativeFinite(quantity)) return null;
  if (!nonNegativeFinite(it.initialPrice)) return null;
  if (it.discountTotal !== undefined && it.discountTotal !== null && !nonNegativeFinite(it.discountTotal)) return null;
  const discount = nonNegativeFinite(it.discountTotal) ? it.discountTotal : 0;
  const amount = it.initialPrice * quantity - discount;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return round2(amount);
}

const nonNegativeFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Safe delivery projection: only {code, cost, net_cost, vat_rate} — never address/service/recipient/comments. */
export function projectDelivery(d: AsxOrderRaw["delivery"]): AnalyticsDelivery | null {
  if (d === null || typeof d !== "object") return null;
  return {
    code: typeof d.code === "string" ? d.code : null,
    cost: nonNegativeFinite(d.cost) ? d.cost : null,
    net_cost: nonNegativeFinite(d.netCost) ? d.netCost : null,
    vat_rate: typeof d.vatRate === "string" ? d.vatRate : null,
  };
}

/**
 * Per-order economics (v2 criterion 7): known components only — missing ones
 * stay null, never zero. item_cogs_total requires EVERY item to have a
 * non-null cogs (zero items => null). known_costs_total is the bounded sum of
 * the non-null known components, not a profit claim.
 */
export function buildEconomics(items: AnalyticsItem[], delivery: AnalyticsDelivery | null, customFields: Record<string, unknown> | null | undefined, cfg: EconomicsConfig): OrderEconomics {
  const cogsValues = items.map(it => it.cogs);
  const itemCogsTotal = items.length > 0 && cogsValues.every(c => c !== null)
    ? round2(cogsValues.reduce((sum, c) => sum + (c as number), 0))
    : null;
  const amounts = extractEconomicsAmounts(customFields, cfg);
  const deliveryActualCost = delivery !== null ? delivery.net_cost : null;
  const components = [itemCogsTotal, deliveryActualCost, ...ECONOMICS_KEYS.map(k => amounts[k].value)];
  const known = components.filter((v): v is number => v !== null);
  const knownCostsTotal = known.length > 0 ? round2(known.reduce((a, b) => a + b, 0)) : null;
  return {
    item_cogs_total: itemCogsTotal,
    delivery_actual_cost: deliveryActualCost,
    outside_mkad_surcharge: amounts.outside_mkad_surcharge,
    commission_total: amounts.commission_total,
    return_total: amounts.return_total,
    known_costs_total: knownCostsTotal,
    completeness: {
      item_cogs: itemCogsTotal !== null,
      // True only for a NON-EMPTY item list whose every item is accepted_10_22.
      item_vat: items.length > 0 && items.every(it => it.vat_status === "accepted_10_22"),
      delivery_actual_cost: deliveryActualCost !== null,
      outside_mkad_surcharge: amounts.outside_mkad_surcharge.value !== null,
      commission_total: amounts.commission_total.value !== null,
      return_total: amounts.return_total.value !== null,
    },
  };
}

export function projectOrder(o: AsxOrderRaw, ctx: ProjectionCtx): { order: AnalyticsOrder; paid: boolean } | { error: string } {
  if (o === null || typeof o !== "object" || typeof o.id !== "number") {
    return { error: "order is malformed: missing numeric id" };
  }
  // Full payment evidence (criterion v3): order.fullPaidAt is the ONLY source
  // of crm_fully_paid / paid_at. There is NO fallback from payments[].paidAt.
  const crmFullyPaid = typeof o.fullPaidAt === "string" && o.fullPaidAt !== "";
  const paidAt = crmFullyPaid ? (o.fullPaidAt as string) : null;
  const crmPaidAmount = computeCrmPaidAmount(o.payments, ctx.paidStatusCodes);
  // Fail-closed amount contract: only a finite non-negative totalSumm is
  // evidence; negative/NaN/Infinity project as null (never coerced to zero).
  const total = nonNegativeFinite(o.totalSumm) ? o.totalSumm : null;
  // amount_matches: exact integer-kopeck equality of KNOWN amounts; null when
  // either is unknown or cannot be represented safely in kopecks.
  // Overpayment is false, never equality.
  const paidKopecks = crmPaidAmount !== null ? toKopecks(crmPaidAmount) : null;
  const totalKopecks = total !== null ? toKopecks(total) : null;
  const amountMatches = paidKopecks !== null && totalKopecks !== null ? paidKopecks === totalKopecks : null;
  // evidence_status: CRM_PAID whenever fullPaidAt is present (regardless of
  // amount completeness); PARTIAL only when fullPaidAt is absent AND the paid
  // amount is known > 0 and < a known order total; UNKNOWN otherwise.
  let evidenceStatus: PaymentEvidenceStatus = "UNKNOWN";
  if (crmFullyPaid) evidenceStatus = "CRM_PAID";
  else if (crmPaidAmount !== null && total !== null && crmPaidAmount > 0 && crmPaidAmount < total) evidenceStatus = "PARTIAL";
  const paymentEvidence: PaymentEvidence = {
    crm_fully_paid: crmFullyPaid,
    crm_paid_amount: crmPaidAmount,
    amount_matches: amountMatches,
    evidence_status: evidenceStatus,
    full_payment_source: "order.fullPaidAt",
    paid_amount_source: "payments[].amount where reference payment status paymentComplete=true",
    finance_confirmation_source: null,
  };
  const src = typeof o.source === "string"
    ? { source: o.source, medium: null, campaign: null }
    : { source: o.source?.source ?? null, medium: o.source?.medium ?? null, campaign: o.source?.campaign ?? null };
  // A malformed entry (null/undefined/primitive/array) becomes one fail-closed
  // safe item: every evidence field null except vat_status "missing"; it makes
  // item COGS/VAT completeness false. Never dereferenced before validation.
  const items: AnalyticsItem[] = (Array.isArray(o.items) ? o.items : []).map((raw): AnalyticsItem => {
    const it = safeItemRaw(raw);
    if (it === null) {
      return { sku: null, quantity: null, revenue: null, vat_rate: null, vat_status: "missing", purchase_price: null, cogs: null, cancelled: null };
    }
    // Quantity is evidence only when finite and non-negative.
    const quantity = nonNegativeFinite(it.quantity) ? it.quantity : null;
    // COGS = purchase_price * quantity only when BOTH are finite and non-negative.
    const purchasePrice = nonNegativeFinite(it.purchasePrice) ? it.purchasePrice : null;
    const cogs = purchasePrice !== null && quantity !== null ? round2(purchasePrice * quantity) : null;
    return {
      // SKU precedence per current OpenAPI OrderProduct/offer: externalId, then xmlId, then article.
      sku: it.offer?.externalId ?? it.offer?.xmlId ?? it.offer?.article ?? null,
      quantity,
      // vatRate is a STRING in the current OpenAPI (e.g. "20%"); never coerced.
      vat_rate: typeof it.vatRate === "string" ? it.vatRate : null,
      vat_status: vatStatus(it.vatRate),
      revenue: itemRevenue(it, quantity),
      purchase_price: purchasePrice,
      cogs,
      cancelled: typeof it.isCanceled === "boolean" ? it.isCanceled : null,
    };
  });
  const delivery = projectDelivery(o.delivery);
  const salesChannel = extractSalesChannel(o);
  const economics = buildEconomics(items, delivery, o.customFields, ctx.economics);
  // Commercial lifecycle (v5): classification uses ONLY the exact provider
  // status map plus the explicitly configured return_total numeric evidence —
  // never display text, delivery, payment state, order method, source or item
  // isCanceled.
  const statusCode = typeof o.status === "string" && o.status !== "" ? o.status : null;
  const statusGroup = statusCode !== null ? ctx.statusGroups?.get(statusCode) : undefined;
  const lifecycle = buildLifecycle(statusCode, statusGroup, economics.return_total.value);
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
      total,
      currency: typeof o.currency === "string" ? o.currency : null,
      source: src,
      // Native RetailCRM analytics label — explicitly NOT Yandex Metrica client_id.
      retailcrm_client_id: typeof o.clientId === "string" ? o.clientId : null,
      retailcrm_client_id_source: "retailcrm_native_clientId",
      attribution: buildAttribution(o.customFields, ctx.attribution),
      items,
      delivery,
      sales_channel: salesChannel,
      channel: deriveChannel(salesChannel),
      economics,
      lifecycle,
      payment_evidence: paymentEvidence,
      join_key: orderJoinKey(o, ctx.secret),
    },
    // Internal paid pair: ONLY crm_fully_paid (order.fullPaidAt) — never a
    // payment status, order status or payment timestamp.
    paid: crmFullyPaid,
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
  pages_fetched: number;
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
      return finish(collected, windowTotalCount, false, "max_orders", page, generatedAt, pagesFetched);
    }
    if (pagesFetched >= maxPages) {
      return finish(collected, windowTotalCount, false, "max_pages", page, generatedAt, pagesFetched);
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
      return finishComplete(collected, windowTotalCount, generatedAt, pagesFetched);
    }
    if (totalPageCount < page) throw new Error("RetailCRM /orders returned orders for a page beyond totalPageCount");
    if (collected.length > totalCount) throw new Error("RetailCRM /orders returned more orders than totalCount");
    if (page >= totalPageCount) return finishComplete(collected, windowTotalCount, generatedAt, pagesFetched);
    page++;
  }
}

/** Complete result — but only if the provider's own totalCount agrees with what we traversed. */
function finishComplete(
  orders: CollectedAnalytics["orders"], windowTotalCount: number, generatedAt: string | null, pagesFetched: number,
): CollectedAnalytics {
  if (orders.length !== windowTotalCount) {
    throw new Error(`RetailCRM /orders pagination is inconsistent: collected ${orders.length} orders but totalCount is ${windowTotalCount}`);
  }
  return { orders, window_total_count: windowTotalCount, complete: true, partial_reason: null, continuation_page: null, generated_at: generatedAt, pages_fetched: pagesFetched };
}

function finish(
  orders: CollectedAnalytics["orders"], windowTotalCount: number, complete: boolean,
  partialReason: CollectedAnalytics["partial_reason"], continuationPage: number | null, generatedAt: string | null, pagesFetched: number,
): CollectedAnalytics {
  return {
    orders, window_total_count: windowTotalCount, complete,
    partial_reason: partialReason, continuation_page: continuationPage, generated_at: generatedAt,
    pages_fetched: pagesFetched,
  };
}

function analyticsEnvelope(
  dateFrom: string, dateTo: string, c: CollectedAnalytics, dateBasis: DateBasis,
  bounds: { max_pages: number; max_orders: number },
) {
  const orders = c.orders.map(e => e.order);
  // Fail-closed amounts: a missing order total (null) never silently becomes
  // zero in a publishable aggregate. Any missing total => revenue/AOV null
  // and the result is not publishable, even when traversal is complete.
  const totalsPresent = orders.filter(o => o.total !== null).length;
  const totalsMissing = orders.length - totalsPresent;
  const allTotalsPresent = totalsMissing === 0;
  const revenue = allTotalsPresent
    ? round2(orders.reduce((sum, o) => sum + (o.total ?? 0), 0))
    : null;
  const averageOrderValue = allTotalsPresent && orders.length ? round2((revenue as number) / orders.length) : null;
  // Publishable only when traversal is complete AND no order total is missing.
  const publishable = c.complete && allTotalsPresent;
  return {
    period: { from: dateFrom, to: dateTo },
    date_basis: dateBasis,
    generated_at: c.generated_at,
    count: orders.length,
    window_total_count: c.window_total_count,
    complete: c.complete,
    // publication_status stays about TRAVERSAL only; missing values are
    // reported separately via total_amount_completeness and revenue_scope.
    publication_status: c.complete ? "complete" as const : "partial" as const,
    publishable,
    total_amount_completeness: { present: totalsPresent, missing: totalsMissing },
    pages_fetched: c.pages_fetched,
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
      average_order_value: averageOrderValue,
      revenue_scope: !c.complete ? "partial_window" as const : allTotalsPresent ? "complete" as const : "incomplete_values" as const,
      // A partial or value-incomplete result keeps its bounded observed
      // subtotal (or null) for diagnosis only — it is never publishable as a
      // complete aggregate.
      publishable,
    },
    // Both completeness keys count AUTHORITATIVE sales_channel values (mapped
    // = value is not UNKNOWN). channel_completeness keeps the legacy envelope
    // key but no longer counts delivery-derived legacy mappings, so legacy
    // taxonomy gaps (B2B/B2G -> legacy "unknown") are not false unknowns.
    channel_completeness: {
      mapped: orders.filter(o => o.sales_channel.value !== "UNKNOWN").length,
      unknown: orders.filter(o => o.sales_channel.value === "UNKNOWN").length,
    },
    sales_channel_completeness: {
      mapped: orders.filter(o => o.sales_channel.value !== "UNKNOWN").length,
      unknown: orders.filter(o => o.sales_channel.value === "UNKNOWN").length,
    },
    payment_evidence_counts: {
      crm_paid: orders.filter(o => o.payment_evidence.evidence_status === "CRM_PAID").length,
      partial: orders.filter(o => o.payment_evidence.evidence_status === "PARTIAL").length,
      unknown: orders.filter(o => o.payment_evidence.evidence_status === "UNKNOWN").length,
      // Presence by non-null: a KNOWN ZERO counts as present, never as missing.
      crm_paid_amount_present: orders.filter(o => o.payment_evidence.crm_paid_amount !== null).length,
      amount_matches_present: orders.filter(o => o.payment_evidence.amount_matches !== null).length,
    },
    // Commercial result (v5): the ONLY revenue-ready surface. It excludes
    // CANCELLED, RETURNED and UNKNOWN orders from counts/revenue; the
    // returned amount is a separate exact figure, never subtracted from
    // revenue and never a contribution-profit claim.
    commercial_result: (() => {
      const includedOrders = orders.filter(o => o.lifecycle.class === "INCLUDED");
      const cancelledCount = orders.filter(o => o.lifecycle.class === "CANCELLED").length;
      const returnedOrders = orders.filter(o => o.lifecycle.class === "RETURNED");
      const unknownCount = orders.filter(o => o.lifecycle.class === "UNKNOWN").length;
      const includedTotalsMissing = includedOrders.filter(o => o.total === null).length;
      const allIncludedTotalsPresent = includedTotalsMissing === 0;
      const includedRevenue = allIncludedTotalsPresent
        ? round2(includedOrders.reduce((sum, o) => sum + (o.total ?? 0), 0))
        : null;
      // Returned amount is exact only when every RETURNED order's return
      // evidence is known; missing amounts are never zero.
      const allReturnedKnown = returnedOrders.every(o => o.economics.return_total.value !== null);
      const returnedAmount = allReturnedKnown
        ? round2(returnedOrders.reduce((sum, o) => sum + (o.economics.return_total.value ?? 0), 0))
        : null;
      return {
        counts: { included: includedOrders.length, cancelled: cancelledCount, returned: returnedOrders.length, unknown: unknownCount },
        included_revenue: includedRevenue,
        returned_amount: returnedAmount,
        amount_completeness: {
          included_totals_present: includedOrders.length - includedTotalsMissing,
          included_totals_missing: includedTotalsMissing,
          returned_amount_known: allReturnedKnown,
        },
        publishable: c.complete && unknownCount === 0 && allIncludedTotalsPresent,
      };
    })(),
    economics_completeness: {
      order_count: orders.length,
      // Presence counts only — a missing component is never counted as zero.
      complete_item_cogs: orders.filter(o => o.economics.completeness.item_cogs).length,
      accepted_item_vat: orders.filter(o => o.economics.completeness.item_vat).length,
      delivery_actual_cost_present: orders.filter(o => o.economics.delivery_actual_cost !== null).length,
      outside_mkad_surcharge_present: orders.filter(o => o.economics.outside_mkad_surcharge.value !== null).length,
      commission_total_present: orders.filter(o => o.economics.commission_total.value !== null).length,
      return_total_present: orders.filter(o => o.economics.return_total.value !== null).length,
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
    const ctx: ProjectionCtx = { ...guard, paidStatusCodes: await fetchPaidStatusCodes(), statusGroups: await fetchStatusGroups() };
    // Window basis: order CREATION time (filter[createdAtFrom]/[To]).
    const collected = await collectAnalyticsOrders(params.date_from, params.date_to, params.max_pages, params.max_orders, ctx, "created_at");
    return ok({
      ...analyticsEnvelope(params.date_from, params.date_to, collected, "created_at", { max_pages: params.max_pages, max_orders: params.max_orders }),
      attribution_configured_keys: configuredAttributionKeys(guard.attribution),
      economics_configured_keys: configuredEconomicsKeys(guard.economics),
    });
  });
}

export async function handlePaidOrders(params: z.infer<typeof paidOrdersSchema>): Promise<ToolResult> {
  return runTool(async () => {
    const guard = guardConfig();
    if ("error" in guard) return fail(guard.error);
    const ctx: ProjectionCtx = { ...guard, paidStatusCodes: await fetchPaidStatusCodes(), statusGroups: await fetchStatusGroups() };
    // Window basis: FULL-PAID time (filter[fullPaidAtFrom]/[To]) — the tool's
    // business output is paid revenue, so the period selects when orders were
    // fully paid, not when they were created. date_basis says so in the output.
    const collected = await collectAnalyticsOrders(params.date_from, params.date_to, params.max_pages, params.max_orders, ctx, "full_paid_at");
    // Fail closed (criterion 8): the provider window was filtered with
    // fullPaidAtFrom/fullPaidAtTo, so EVERY returned order must carry a
    // non-empty fullPaidAt. An order without one means the provider window and
    // the evidence disagree — never silently filter it away or reduce the cohort.
    const notPaid = collected.orders.filter(e => !e.paid);
    if (notPaid.length > 0) {
      return fail(`RetailCRM paid-orders window returned ${notPaid.length} order(s) without fullPaidAt (first order id ${notPaid[0].order.id}) — provider window disagrees with full-payment evidence; failing closed instead of publishing a reduced cohort`);
    }
    const paidOnly = collected.orders;
    return ok({
      ...analyticsEnvelope(params.date_from, params.date_to, { ...collected, orders: paidOnly }, "full_paid_at", { max_pages: params.max_pages, max_orders: params.max_orders }),
      paid_count: paidOnly.length,
      // Commercial cohort (v5): only INCLUDED rows count here — CANCELLED,
      // RETURNED and UNKNOWN stay excluded from the commercial surface.
      commercial_paid_count: paidOnly.filter(e => e.order.lifecycle.class === "INCLUDED").length,
      attribution_configured_keys: configuredAttributionKeys(guard.attribution),
      economics_configured_keys: configuredEconomicsKeys(guard.economics),
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
    const projected = projectOrder(raw as AsxOrderRaw, { ...guard, paidStatusCodes, statusGroups: await fetchStatusGroups() });
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

// Allowlisted change fields (criterion v3): OLD/NEW values are exposed ONLY
// for safe status and payment fields, plus the fullPaidAt transition as
// `full_paid_at` (string/null shapes only — every other shape fails to null).
// Business fields such as orderMethod, site, totalSumm and currency — and
// everything else: comments, customer data, delivery addresses, arbitrary
// custom fields — are omitted entirely, not blanked.
const HISTORY_FIELD_MAP: Record<string, string> = {
  status: "status",
  payments: "payments",
  fullPaidAt: "full_paid_at",
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
  // fullPaidAt: ONLY string or null ever survives; objects, arrays, numbers
  // and every other shape fail closed to null.
  if (field === "fullPaidAt") return typeof v === "string" ? v : null;
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
