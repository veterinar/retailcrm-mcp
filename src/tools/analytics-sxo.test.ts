import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  projectOrder, checkAnalyticsSecret, normalizeOrderId, handleOrderHistoryAnalytics,
  handleOrdersAnalytics, handlePaidOrders, handleOrderAttribution, handleAttributionFields,
} from "./analytics-sxo.js";
import { handleOrdersHistory } from "./orders.js";
import { mockBridge } from "../../tests/bridge-mock.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars
const ENV_KEYS = ["RETAILCRM_ANALYTICS_HMAC_SECRET", "RETAILCRM_ANALYTICS_ATTRIBUTION", "RETAILCRM_ANALYTICS_CHANNEL_MAP", "RETAILCRM_ANALYTICS_ECONOMICS"] as const;

beforeEach(() => {
  process.env.RETAILCRM_DOMAIN = "testshop.retailcrm.ru";
  process.env.RETAILCRM_API_KEY = "test-key";
  process.env.RETAILCRM_ANALYTICS_HMAC_SECRET = SECRET;
  for (const k of ENV_KEYS) if (k !== "RETAILCRM_ANALYTICS_HMAC_SECRET") delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const paidStatusPage = { v: 1, ok: true, status: 200, data: { success: true, paymentStatuses: { paid: { code: "paid", paymentComplete: true }, pending: { code: "pending", paymentComplete: false } } } };

const CTX = { secret: SECRET, attribution: { configured: false } as const, economics: { configured: false } as const, channelMap: {} as Record<string, never>, paidStatusCodes: new Set(["paid"]) };

describe("analytics-sxo join key", () => {
  it("is deterministic, follows the documented formula and basis precedence", () => {
    const o = { id: 7, externalId: " EXT-7 ", number: "N-7" };
    expect(normalizeOrderId(o)).toBe("EXT-7");
    expect(normalizeOrderId({ id: 7, number: "N-7" })).toBe("N-7");
    expect(normalizeOrderId({ id: 7 })).toBe("7");
    const expected = createHmac("sha256", SECRET).update("petdog-order-v1:EXT-7").digest("hex");
    const a = projectOrder({ ...o, id: 7 }, CTX);
    const b = projectOrder({ ...o, id: 7 }, CTX);
    if ("error" in a || "error" in b) throw new Error("projection failed");
    expect(a.order.join_key).toBe(expected);
    expect(a.order.join_key).toBe(b.order.join_key);
    // The digest is opaque hex and no join-key metadata field carries the raw basis
    expect(a.order.join_key).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(a.order).filter(k => k.includes("join"))).toEqual(["join_key"]);
  });

  it("refuses a missing or weak (<32 chars) secret before any bridge call", async () => {
    expect(checkAnalyticsSecret({} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(checkAnalyticsSecret({ RETAILCRM_ANALYTICS_HMAC_SECRET: "short" } as NodeJS.ProcessEnv).ok).toBe(false);
    delete process.env.RETAILCRM_ANALYTICS_HMAC_SECRET;
    const bridge = mockBridge([]);
    const r = await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("fail closed");
    expect(bridge.calls.length).toBe(0); // no provider call was attempted
  });
});

describe("analytics-sxo projection", () => {
  it("recursively excludes PII and non-allowlisted fields", async () => {
    process.env.RETAILCRM_ANALYTICS_ATTRIBUTION = JSON.stringify({ client_id: "metrika_cid" });
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true, generatedAt: "2026-08-01T00:00:00",
          orders: [{
            id: 501, externalId: "EXT-501", number: "501", createdAt: "2026-07-01T10:00:00", status: "complete",
            orderMethod: "phone-in", site: "site-a", totalSumm: 1500, currency: "RUB", clientId: "native-cid-1",
            fullPaidAt: "2026-07-02T09:00:00", source: { source: "yandex", medium: "cpc", campaign: "summer" },
            customFields: { metrika_cid: "12345", secret_note: "call me at 555" },
            customer: { id: 9, firstName: "Ivan", lastName: "Petrov", email: "ivan@example.com", phones: [{ number: "+7 999 555 66 77" }] },
            firstName: "Ivan", phone: "+79995556677", email: "ivan@example.com",
            managerComment: "manager secret", customerComment: "customer secret", statusComment: "status secret",
            delivery: { code: "courier", cost: 300, address: { text: "Secret Street 1" }, service: { name: "CDEK" } },
            items: [{ offer: { xmlId: "SKU-1", displayName: "Dog Food", markingCode: "01046MARK" }, quantity: 2, initialPrice: 500, prices: [{ price: 450, quantity: 2 }], vatRate: "20%", markingCode: "01046MARK2" }],
            payments: { a: { type: "cash", amount: 1500, status: "paid", paidAt: "2026-07-02T09:00:00", comment: "pay secret" } },
            managerId: 77,
          }],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
        },
      };
    });
    const r = await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 });
    expect(r.isError).toBeFalsy();
    const text = r.text;
    for (const banned of ["Ivan", "Petrov", "example.com", "+7 999", "+7999", "Secret Street", "manager secret", "customer secret", "status secret", "pay secret", "Dog Food", "CDEK", "01046MARK", "markingCode", "secret_note", "call me", "managerId", "\"customer\"", "\"firstName\"", "\"managerComment\"", "\"phones\"", "\"email\""]) {
      expect(text).not.toContain(banned);
    }
    // The native clientId VALUE is exposed only under its explicit renamed provenance
    const parsed = JSON.parse(text);
    expect(parsed.orders[0].retailcrm_client_id).toBe("native-cid-1");
    expect(parsed.orders[0].retailcrm_client_id_source).toBe("retailcrm_native_clientId");
    expect(parsed.complete).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.orders[0].attribution.client_id).toMatchObject({ value: "12345", field_code: "metrika_cid", source: "configured_custom_field" });
    // v2: item shape gains purchase_price/cogs/vat_status/cancelled ("20%" is NOT accepted 10/22 evidence)
    expect(parsed.orders[0].items[0]).toEqual({ sku: "SKU-1", quantity: 2, revenue: 900, vat_rate: "20%", vat_status: "unexpected", purchase_price: null, cogs: null, cancelled: null });
    // v2: the literal safe key `delivery` IS exposed — but ONLY as the exact safe projection
    expect(parsed.orders[0].delivery).toEqual({ code: "courier", cost: 300, net_cost: null, vat_rate: null });
    expect(JSON.stringify(parsed.orders[0].delivery)).not.toContain("address");
    expect(JSON.stringify(parsed.orders[0].delivery)).not.toContain("service");
    // v2: economics with nothing known — null, never zero, with explicit unconfigured reasons
    expect(parsed.orders[0].economics).toEqual({
      item_cogs_total: null,
      delivery_actual_cost: null,
      outside_mkad_surcharge: { value: null, field_code: null, source: "unconfigured", omitted_reason: "not_configured" },
      commission_total: { value: null, field_code: null, source: "unconfigured", omitted_reason: "not_configured" },
      return_total: { value: null, field_code: null, source: "unconfigured", omitted_reason: "not_configured" },
      known_costs_total: null,
      completeness: { item_cogs: false, item_vat: false, delivery_actual_cost: false, outside_mkad_surcharge: false, commission_total: false, return_total: false },
    });
    expect(parsed.totals.revenue).toBe(1500);
  });

  it("fullPaidAt is the only full-payment fact; complete payments never make an order paid", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [
            { id: 1, fullPaidAt: "2026-07-02T09:00:00", payments: { a: { status: "paid", paidAt: "2026-07-01T12:00:00" } } },
            { id: 2, payments: { a: { status: "pending", paidAt: "2026-07-01T12:00:00" } }, items: [] },
            { id: 3, payments: { a: { status: "paid", paidAt: "2026-07-03T08:30:00" } } },
            { id: 4, fullPaidAt: "", payments: { a: { status: "paid", paidAt: "2026-07-03T08:30:00" } } },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 4 },
        },
      };
    });
    const window = { date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 };
    const all = JSON.parse((await handleOrdersAnalytics(window)).text);
    expect(all.orders.map((o: { id: number; paid_at: string | null; payment_evidence: { crm_fully_paid: boolean } }) => [o.id, o.paid_at, o.payment_evidence.crm_fully_paid])).toEqual([
      [1, "2026-07-02T09:00:00", true],   // fullPaidAt wins over payment paidAt
      [2, null, false],                   // non-complete payment never yields paid_at
      [3, null, false],                   // complete payment WITHOUT fullPaidAt is NOT paid, no fallback
      [4, null, false],                   // empty-string fullPaidAt is not a non-empty string
    ]);
    expect(all.payment_evidence_counts).toEqual({ crm_paid: 1, partial: 0, unknown: 3, crm_paid_amount_present: 1, amount_matches_present: 0 });
    // A fully consistent paid cohort passes through untouched.
    const bridge2 = mockBridge([]);
    bridge2.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [
            { id: 1, fullPaidAt: "2026-07-02T09:00:00" },
            { id: 2, fullPaidAt: "2026-07-03T09:00:00" },
            { id: 4, fullPaidAt: "2026-07-04T09:00:00" },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 3 },
        },
      };
    });
    const paid = JSON.parse((await handlePaidOrders(window)).text);
    expect(paid.paid_count).toBe(3);
    expect(paid.count).toBe(3);
    expect(paid.window_total_count).toBe(3);
    expect(paid.payment_evidence_counts.crm_paid).toBe(3);
  });

  it("paid-orders window fails closed when a provider-filtered order lacks fullPaidAt", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          // One order in the fullPaidAtFrom/To cohort has NO fullPaidAt — the
          // provider window and the evidence disagree: fail closed, never filter.
          orders: [
            { id: 1, fullPaidAt: "2026-07-02T09:00:00" },
            { id: 2, payments: { a: { status: "paid", amount: 100 } } },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 2 },
        },
      };
    });
    const r = await handlePaidOrders({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("without fullPaidAt");
    expect(r.text).toContain("failing closed");
  });

  it("payment evidence: amounts, matching, malformed containers and status independence", () => {
    const ev = (o: Partial<Parameters<typeof projectOrder>[0]>) =>
      projectOrder({ id: 1, ...o } as Parameters<typeof projectOrder>[0], CTX);
    const evidenceOf = (r: ReturnType<typeof projectOrder>) =>
      "error" in r ? (() => { throw new Error("projection failed"); })() : r.order.payment_evidence;
    // Exact match: CRM_PAID with equal known amounts.
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00", totalSumm: 1000.005, payments: { a: { status: "paid", amount: 600 }, b: { status: "paid", amount: 400.005 } } })))
      .toMatchObject({ crm_fully_paid: true, crm_paid_amount: 1000.01, amount_matches: true, evidence_status: "CRM_PAID" });
    // Known JavaScript monetary boundary: 1.005 must cent-round UP to 1.01
    // (1.005 * 100 === 100.49999999999999, so Math.round alone yields 1.00).
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00", totalSumm: 1.005, payments: { a: { status: "paid", amount: 1.005 } } })))
      .toMatchObject({ crm_paid_amount: 1.01, amount_matches: true, evidence_status: "CRM_PAID" });
    // Partial: no fullPaidAt, known paid amount > 0 and < known total.
    expect(evidenceOf(ev({ totalSumm: 1000, payments: { a: { status: "paid", amount: 400 } } })))
      .toMatchObject({ crm_fully_paid: false, crm_paid_amount: 400, amount_matches: false, evidence_status: "PARTIAL" });
    // Overpaid: equality is false, never silently treated as a match.
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00", totalSumm: 1000, payments: { a: { status: "paid", amount: 1500 } } })))
      .toMatchObject({ crm_paid_amount: 1500, amount_matches: false, evidence_status: "CRM_PAID" });
    // Malformed/missing amounts on a COMPLETE payment: crm_paid_amount null,
    // amount_matches null, and — without fullPaidAt — UNKNOWN (never zero).
    for (const badAmount of [undefined, "500" as unknown as number, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const r = ev({ payments: { a: { status: "paid", amount: badAmount } } });
      expect(evidenceOf(r)).toMatchObject({ crm_fully_paid: false, crm_paid_amount: null, amount_matches: null, evidence_status: "UNKNOWN" });
    }
    // Structurally invalid containers (array/primitive): crm_paid_amount null.
    // Absent/null container and no-complete-payments: crm_paid_amount 0.
    expect(evidenceOf(ev({ payments: [{ status: "paid", amount: 100 }] as unknown as never })).crm_paid_amount).toBeNull();
    expect(evidenceOf(ev({ payments: "paid" as unknown as never })).crm_paid_amount).toBeNull();
    expect(evidenceOf(ev({ payments: null })).crm_paid_amount).toBe(0);
    expect(evidenceOf(ev({ payments: { a: { status: "pending", amount: 100 } } })).crm_paid_amount).toBe(0);
    expect(evidenceOf(ev({})).crm_paid_amount).toBe(0);
    // amount_matches null when the order total is unknown.
    expect(evidenceOf(ev({ payments: { a: { status: "paid", amount: 100 } } })).amount_matches).toBeNull();
    // Status independence: identical evidence for "complete", "paid" and no status at all.
    const statuses: (string | undefined)[] = ["complete", "paid", undefined];
    for (const status of statuses) {
      const r = ev({ status, totalSumm: 500, payments: { a: { status: "paid", amount: 500 } } });
      expect(evidenceOf(r)).toMatchObject({ crm_fully_paid: false, crm_paid_amount: 500, amount_matches: true, evidence_status: "UNKNOWN" });
    }
    // fullPaidAt precedence: CRM_PAID even when the amount is unknown.
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00", payments: { a: { status: "paid", amount: "500" as unknown as number } } })))
      .toMatchObject({ crm_fully_paid: true, crm_paid_amount: null, amount_matches: null, evidence_status: "CRM_PAID" });
    // Explicit sources; FINANCE_CONFIRMED is never emitted.
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00" }))).toEqual({
      crm_fully_paid: true, crm_paid_amount: 0, amount_matches: null, evidence_status: "CRM_PAID",
      full_payment_source: "order.fullPaidAt",
      paid_amount_source: "payments[].amount where reference payment status paymentComplete=true",
      finance_confirmation_source: null,
    });
    // The internal projected pair keeps its shape; paid comes ONLY from crm_fully_paid.
    const pair = ev({ fullPaidAt: "2026-07-02T09:00:00", payments: { a: { status: "paid", amount: 1 } } });
    if ("error" in pair) throw new Error("projection failed");
    expect(pair.paid).toBe(true);
    expect(pair.paid).toBe(pair.order.payment_evidence.crm_fully_paid);
    const unpaidPair = ev({ payments: { a: { status: "paid", amount: 1 } } });
    if ("error" in unpaidPair) throw new Error("projection failed");
    expect(unpaidPair.paid).toBe(false);
  });

  it("crm_paid_amount is null when the kopeck total exceeds safe-integer precision", () => {
    const ev = (o: Partial<Parameters<typeof projectOrder>[0]>) =>
      projectOrder({ id: 1, ...o } as Parameters<typeof projectOrder>[0], CTX);
    const evidenceOf = (r: ReturnType<typeof projectOrder>) =>
      "error" in r ? (() => { throw new Error("projection failed"); })() : r.order.payment_evidence;
    // A finite, non-negative amount whose *100 kopeck value cannot be a safe
    // integer projects crm_paid_amount null (and amount_matches null), never a
    // lossy coercion. fullPaidAt keeps evidence_status at CRM_PAID.
    expect(evidenceOf(ev({ fullPaidAt: "2026-07-02T09:00:00", payments: { a: { status: "paid", amount: Number.MAX_SAFE_INTEGER } } })))
      .toMatchObject({ crm_fully_paid: true, crm_paid_amount: null, amount_matches: null, evidence_status: "CRM_PAID" });
  });

  it("envelope payment-evidence counts treat a known zero as present", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [
            // CRM_PAID with a known zero amount and a known total: both present.
            { id: 1, fullPaidAt: "2026-07-02T09:00:00", totalSumm: 0 },
            // PARTIAL: known amount 400 < known total 1000.
            { id: 2, totalSumm: 1000, payments: { a: { status: "paid", amount: 400 } } },
            // UNKNOWN: no fullPaidAt, structurally invalid payments container.
            { id: 3, payments: "paid" as unknown as never },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 3 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.payment_evidence_counts).toEqual({
      crm_paid: 1,
      partial: 1,
      unknown: 1,
      crm_paid_amount_present: 2, // known zero (order 1) + known 400 (order 2)
      amount_matches_present: 2,  // 0==0 (order 1) + 400!=1000 (order 2)
    });
  });

  it("item evidence per current OpenAPI: multi-price sum, discount fallback, string VAT, externalId SKU, malformed=>null", () => {
    const mk = (items: Parameters<typeof projectOrder>[0]["items"]) =>
      projectOrder({ id: 1, items }, CTX);
    // Multi-tranche prices: sum EVERY price*quantity — never prices[0] alone.
    const multi = mk([{ offer: { externalId: "EXT-SKU", xmlId: "XML-1", article: "ART-1" }, quantity: 3, initialPrice: 500, prices: [{ price: 400, quantity: 1 }, { price: 350, quantity: 2 }] }]);
    if ("error" in multi) throw new Error("multi failed");
    expect(multi.order.items[0]).toEqual({ sku: "EXT-SKU", quantity: 3, revenue: 1100, vat_rate: null, vat_status: "missing", purchase_price: null, cogs: null, cancelled: null }); // externalId wins SKU precedence
    // No usable prices[]: initialPrice * quantity - discountTotal (line-total discount).
    const disc = mk([{ offer: { xmlId: "XML-2" }, quantity: 2, initialPrice: 500, discountTotal: 50 }]);
    if ("error" in disc) throw new Error("disc failed");
    expect(disc.order.items[0]?.revenue).toBe(950);
    // vatRate is a STRING in the current OpenAPI (e.g. "20%"); never coerced.
    const vat = mk([{ offer: { article: "ART-3" }, quantity: 1, initialPrice: 100, vatRate: "20%" }]);
    if ("error" in vat) throw new Error("vat failed");
    expect(vat.order.items[0]?.vat_rate).toBe("20%");
    // Malformed numeric material => null / documented fallback, never a guess.
    const bad = mk([
      { offer: {}, quantity: 2, initialPrice: "500" as unknown as number },                                   // non-numeric initialPrice => null
      { offer: {}, quantity: 2, initialPrice: 100, prices: [{ price: 10, quantity: 1 }, { price: "x" as unknown as number, quantity: 1 }] }, // mixed tranches => fallback
    ]);
    if ("error" in bad) throw new Error("bad failed");
    expect(bad.order.items[0]?.revenue).toBeNull();
    expect(bad.order.items[1]?.revenue).toBe(200);
  });
});

describe("analytics-sxo pagination", () => {
  it("follows every page beyond 20 until complete", async () => {
    const PAGES = 25;
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const page = Number(req.params?.page ?? "1");
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [{ id: page, totalSumm: 100 }],
          pagination: { currentPage: page, totalPageCount: PAGES, totalCount: PAGES },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 100, max_orders: 10_000 })).text);
    expect(parsed.complete).toBe(true);
    expect(parsed.count).toBe(PAGES);
    expect(parsed.continuation_page).toBeNull();
    expect(parsed.totals.revenue).toBe(2500);
    const orderCalls = bridge.calls.filter(c => c.path === "/orders");
    expect(orderCalls.length).toBe(PAGES);
    expect(orderCalls[24].params?.page).toBe("25");
  });

  it("stops at max_pages with an explicit partial result and continuation page", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const page = Number(req.params?.page ?? "1");
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [{ id: page, totalSumm: 100 }],
          pagination: { currentPage: page, totalPageCount: 3, totalCount: 300 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 2, max_orders: 10_000 })).text);
    expect(parsed.complete).toBe(false);
    expect(parsed.partial_reason).toBe("max_pages");
    expect(parsed.continuation_page).toBe(3);
    expect(parsed.totals.revenue_scope).toBe("partial_window");
    expect(parsed.totals.revenue).toBe(200); // never labeled complete
  });

  it("paid orders window filters on fullPaidAt, orders analytics on createdAt; date_basis is explicit", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return { v: 1, ok: true, status: 200, data: { success: true, orders: [], pagination: { currentPage: 1, totalPageCount: 1, totalCount: 0 } } };
    });
    const window = { date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 };
    const paid = JSON.parse((await handlePaidOrders(window)).text);
    expect(paid.date_basis).toBe("full_paid_at");
    const paidCall = bridge.calls.find(c => c.path === "/orders");
    expect(paidCall?.params).toMatchObject({ "filter[fullPaidAtFrom]": "2026-07-01", "filter[fullPaidAtTo]": "2026-07-31", limit: "100", page: "1" });
    expect(paidCall?.params?.["filter[createdAtFrom]"]).toBeUndefined();
    const all = JSON.parse((await handleOrdersAnalytics(window)).text);
    expect(all.date_basis).toBe("created_at");
    const orderCalls = bridge.calls.filter(c => c.path === "/orders");
    expect(orderCalls[orderCalls.length - 1]?.params).toMatchObject({ "filter[createdAtFrom]": "2026-07-01", "filter[createdAtTo]": "2026-07-31" });
    // Bounds are explicit in the output and never claim a hard per-record cap.
    expect(all.bounds).toMatchObject({ max_pages: 1, max_orders: 10, semantics: "page_aligned_soft_stop" });
    expect(paid.bounds).toMatchObject({ semantics: "page_aligned_soft_stop" });
  });

  it("fails closed on malformed provider shapes", async () => {
    for (const malformed of [
      { success: true, pagination: { currentPage: 1, totalPageCount: 1, totalCount: 0 } }, // orders array missing
      { success: true, orders: [{ id: 1 }] },                                            // pagination missing
      { success: true, orders: [{ id: 1 }], pagination: { currentPage: 2, totalPageCount: 1, totalCount: 1 } }, // page mismatch
    ]) {
      const bridge = mockBridge([]);
      bridge.implement(req => req.path === "/reference/payment-statuses" ? paidStatusPage : { v: 1, ok: true, status: 200, data: malformed });
      const r = await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/malformed|mismatch/);
    }
  });
});

describe("analytics-sxo attribution and channels", () => {
  it("extracts only configured tokens; unconfigured keys carry explicit omission reasons", async () => {
    process.env.RETAILCRM_ANALYTICS_ATTRIBUTION = JSON.stringify({ client_id: "metrika_cid", yclid: "yandex_click" });
    process.env.RETAILCRM_ANALYTICS_CHANNEL_MAP = JSON.stringify({ "phone-in": "phone", "site-b": "site" });
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      if (req.path === "/orders/501") {
        return {
          v: 1, ok: true, status: 200, data: {
            success: true, generatedAt: "2026-08-01T00:00:00",
            order: {
              id: 501, clientId: "native-cid-1", orderMethod: "phone-in", site: "site-b",
              customFields: { metrika_cid: "12345", yandex_click: "  \t", guessed_utm: "never-extract-me" },
            },
          },
        };
      }
      return { v: 1, ok: true, status: 200, data: { success: true, orders: [], pagination: { currentPage: 1, totalPageCount: 1, totalCount: 0 } } };
    });
    const r = await handleOrderAttribution({ id: "501", by: "id" });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.text);
    expect(parsed.attribution_configured_keys).toEqual(["client_id", "yclid"]);
    expect(parsed.order.attribution.client_id.value).toBe("12345");
    expect(parsed.order.attribution.yclid).toMatchObject({ value: null, omitted_reason: "empty" });
    expect(parsed.order.attribution.utm_source).toMatchObject({ value: null, source: "unconfigured", omitted_reason: "not_configured" });
    expect(r.text).not.toContain("never-extract-me"); // no guessed custom-field codes
    expect(parsed.order.channel).toEqual({ value: "phone", basis: "order_method" }); // orderMethod wins over site
    expect(parsed.order.retailcrm_client_id_source).toBe("retailcrm_native_clientId");
  });

  it("classifies unmapped codes as unknown and reports completeness", async () => {
    process.env.RETAILCRM_ANALYTICS_CHANNEL_MAP = JSON.stringify({ "site-b": "site" });
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200, data: {
          success: true,
          orders: [
            { id: 1, site: "site-b", items: [] },
            { id: 2, site: "mystery-site", orderMethod: "new-fangled", items: [] },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 2 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.orders[0].channel).toEqual({ value: "site", basis: "site" });
    expect(parsed.orders[1].channel).toEqual({ value: "unknown", basis: "unmapped" });
    expect(parsed.channel_completeness).toEqual({ mapped: 1, unknown: 1 });
  });

  it("rejects bad attribution config instead of guessing", async () => {
    process.env.RETAILCRM_ANALYTICS_ATTRIBUTION = "{not json";
    const bridge = mockBridge([]);
    const r = await handleOrderAttribution({ id: "501", by: "id" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("RETAILCRM_ANALYTICS_ATTRIBUTION");
    expect(bridge.calls.length).toBe(0);
  });

  it("prototype keys can never become channel mappings or attribution values", async () => {
    // No channel map configured: "toString"/"__proto__" must classify unknown,
    // not resolve to anything (null-prototype map + own-property lookups).
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [{ id: 1, site: "toString", orderMethod: "__proto__", items: [] }],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.orders[0].channel).toEqual({ value: "unknown", basis: "unmapped" });
    // Own-property customFields lookup: a prototype key never yields a token.
    process.env.RETAILCRM_ANALYTICS_ATTRIBUTION = JSON.stringify({ client_id: "toString" });
    const bridge2 = mockBridge([]);
    bridge2.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          order: { id: 9, site: "s", customFields: { city: "Kazan" } }, // no "toString" own property (value would be a function)
        },
      };
    });
    const attr = await handleOrderAttribution({ id: "9", by: "id" });
    expect(attr.isError).toBeFalsy();
    const attrParsed = JSON.parse(attr.text);
    expect(attrParsed.order.attribution.client_id).toMatchObject({ value: null, field_code: "toString", source: "configured_custom_field", omitted_reason: "field_absent_on_order" });
    expect(JSON.stringify(attrParsed)).not.toContain("Kazan");
  });
});

describe("retailcrm_attribution_fields", () => {
  it("searches order custom-field metadata only — never values, never other entities", async () => {
    const bridge = mockBridge([{
      success: true,
      customFields: {
        metrika_cid: { code: "metrika_cid", name: "Metrica client id", type: "string", entity: "order" },
        yclid_store: { code: "yclid_store", name: "Yandex click id", type: "string", entity: "order" },
        customer_note: { code: "customer_note", name: "yclid in customer note", type: "text", entity: "customer" },
        order_secret: { code: "order_secret", name: "Internal", type: "string", entity: "order" },
      },
    }]);
    const r = await handleAttributionFields({ search: "yclid" });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.text);
    expect(bridge.first()?.path).toBe("/custom-fields");
    expect(bridge.first()?.op).toBe("get");
    expect(parsed.total_order_fields).toBe(3);
    expect(parsed.fields).toEqual([
      { code: "yclid_store", name: "Yandex click id", type: "string", entity: "order" },
    ]);
    expect(r.text).not.toContain("Internal");        // non-matching order fields are not exposed
    expect(r.text).not.toContain("customer_note");   // non-order entities are skipped entirely
  });

  it("accepts the live array response shape while keeping the metadata allowlist", async () => {
    const bridge = mockBridge([{
      success: true,
      customFields: [
        { code: "utm_source_store", name: "UTM source", type: "string", entity: "order" },
        { code: "order_secret", name: "Internal", type: "string", entity: "order" },
        { code: "customer_utm", name: "Customer UTM", type: "text", entity: "customer" },
      ],
    }]);
    const r = await handleAttributionFields({ search: "utm" });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.text);
    expect(bridge.first()?.params).toEqual({ "filter[entity]": "order" });
    expect(parsed.total_order_fields).toBe(2);
    expect(parsed.fields).toEqual([
      { code: "utm_source_store", name: "UTM source", type: "string", entity: "order" },
    ]);
    expect(r.text).not.toContain("Internal");
    expect(r.text).not.toContain("Customer UTM");
  });

  it("scopes the /custom-fields request to order metadata and accepts the filtered shape", async () => {
    const bridge = mockBridge([{
      success: true,
      customFields: {
        // Entity-filtered responses may omit the entity key entirely.
        metrika_cid: { name: "Metrica client id", type: "string" },
        utm_term_store: { name: "UTM term", type: "string", entity: "order" },
        legacy_customer_note: { name: "Note", type: "text", entity: "customer" },
      },
    }]);
    const r = await handleAttributionFields({ search: "metrika" });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.text);
    expect(bridge.first()?.path).toBe("/custom-fields");
    expect(bridge.first()?.params).toEqual({ "filter[entity]": "order" }); // exact scoping param
    expect(parsed.total_order_fields).toBe(2); // entity-less (filtered shape) + explicit order entries
    expect(parsed.fields).toEqual([{ code: "metrika_cid", name: "Metrica client id", type: "string", entity: "order" }]);
    expect(r.text).not.toContain("legacy_customer_note"); // explicitly non-order entries are skipped
  });

  it("fails closed on structurally malformed custom-field metadata", async () => {
    const bridge = mockBridge([{ success: true, customFields: { broken: "not-an-object" } }]);
    const r = await handleAttributionFields({ search: "anything" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("malformed");
  });
});

describe("retailcrm_order_history_analytics (official sinceId cursor)", () => {
  const historyPage = (ids: number[], totalPageCount: number) => ({
    v: 1, ok: true, status: 200,
    data: {
      success: true, generatedAt: "2026-08-01T00:00:00",
      history: ids.map(id => ({ id, orderId: 500 + id, orderExternalId: `EXT-${500 + id}`, createdAt: "2026-07-01T10:00:00", source: "api", field: "status", old_value: { code: "new" }, new_value: { code: "complete" } })),
      pagination: { currentPage: 1, totalPageCount, totalCount: ids.length },
    },
  });

  it("never sends page, advances the cursor to the max processed id, and never repeats a sinceId", async () => {
    const bridge = mockBridge([]);
    let round = 0;
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      round++;
      // Round 1 signals more data (totalPageCount 2); round 2 completes (1).
      return round === 1 ? historyPage([1, 2, 3], 2) : historyPage([4, 5, 6], 1);
    });
    const parsed = JSON.parse((await handleOrderHistoryAnalytics({ max_pages: 10, max_records: 1000 })).text);
    expect(parsed.complete).toBe(true);
    expect(parsed.count).toBe(6);
    expect(parsed.next_since_id).toBe(6); // cursor advanced to the LAST record id
    expect(parsed.continuation_since_id).toBeNull();

    const calls = bridge.calls.filter(c => c.path === "/orders/history");
    expect(calls.length).toBe(2);
    // Contract (docs.retailcrm.ru WorkingHistoryAPI): page is NEVER sent on a history call.
    for (const c of calls) expect("page" in (c.params ?? {})).toBe(false);
    // First call: no sinceId. Subsequent calls: sinceId = previous max id, strictly advancing.
    expect("filter[sinceId]" in (calls[0].params ?? {})).toBe(false);
    expect(calls[1].params?.["filter[sinceId]"]).toBe("3");
    // join keys follow the same HMAC formula, keyed on the order's externalId
    const expected = createHmac("sha256", SECRET).update("petdog-order-v1:EXT-501").digest("hex");
    expect(parsed.records[0].join_key).toBe(expected);
  });

  it("exposes old/new ONLY for status, payments and full_paid_at; business fields are omitted", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const mkRec = (id: number, field: string, oldValue: unknown, newValue: unknown) => ({ id, orderId: 600, createdAt: "2026-07-01T10:00:00", source: "api", field, old_value: oldValue, new_value: newValue });
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          history: [
            mkRec(21, "status", { code: "new" }, { code: "complete" }),
            mkRec(22, "payments", null, { p1: { status: "paid", amount: 100 } }),
            mkRec(23, "fullPaidAt", null, "2026-07-02 09:00:00"),
            mkRec(24, "orderMethod", "chat", "phone"),
            mkRec(25, "site", "site-a", "site-b"),
            mkRec(26, "totalSumm", 100, 200),
            mkRec(27, "currency", "RUB", "USD"),
            mkRec(28, "customerComment", null, "call me at 555"),
            mkRec(29, "fullPaidAt", "2026-07-01 09:00:00", { ts: "2026-07-02 09:00:00" }), // non-string shape
            mkRec(30, "fullPaidAt", 12345, "2026-07-03 09:00:00"),                          // numeric old value
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 10 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrderHistoryAnalytics({ max_pages: 1, max_records: 100 })).text);
    expect(parsed.count).toBe(10);
    // Only status/payments/full_paid_at expose old/new values; every other
    // field — including previously-allowlisted business fields — is omitted entirely.
    expect(parsed.records[0].changes).toEqual({ status: { old: "new", new: "complete" } });
    expect(Object.keys(parsed.records[1].changes)).toEqual(["payments"]);
    // fullPaidAt is exposed ONLY as the safe full_paid_at key: string/null
    // shapes survive, every other shape fails closed to null.
    expect(parsed.records[2].changes).toEqual({ full_paid_at: { old: null, new: "2026-07-02 09:00:00" } });
    expect(parsed.records[8].changes).toEqual({ full_paid_at: { old: "2026-07-01 09:00:00", new: null } });
    expect(parsed.records[9].changes).toEqual({ full_paid_at: { old: null, new: "2026-07-03 09:00:00" } });
    for (const i of [3, 4, 5, 6, 7]) {
      expect(parsed.records[i].changes).toEqual({});
      expect(JSON.stringify(parsed.records[i].changes)).not.toContain("full_paid_at");
    }
  });

  it("sanitizes anomalous payments values to null; explicit nested null never falls back to legacy scalar", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          history: [
            // Scalar/array payments values must fail closed to null (dictionary shape only).
            { id: 61, orderId: 600, createdAt: "2026-07-01T10:00:00", source: "api", field: "payments", old_value: "paid", new_value: [{ status: "paid" }] },
            // Explicitly present nested oldValue: null WINS — no fallback to old_value scalar.
            { id: 62, orderId: 600, createdAt: "2026-07-01T10:00:00", source: "api", changes: [{ field: "payments", oldValue: null, old_value: { p1: { status: "paid" } }, newValue: null, new_value: { p1: { status: "paid" } } }] },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 2 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrderHistoryAnalytics({ max_pages: 1, max_records: 100 })).text);
    // Record 61: scalar "paid" and array [{status}] both become null — never echoed.
    expect(parsed.records[0].changes).toEqual({ payments: { old: null, new: null } });
    // Record 62: nested explicit nulls win; the legacy scalar dicts are NOT used.
    expect(parsed.records[1].changes).toEqual({ payments: { old: null, new: null } });
  });

  it("fails closed on an empty page while totalPageCount still signals more", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return historyPage([], 2); // contradictory: empty page, totalPageCount 2
    });
    const r = await handleOrderHistoryAnalytics({ max_pages: 5, max_records: 1000 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("empty cursor page");
  });

  it("fails closed when a non-empty page does not advance the cursor", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      // Resume at 200 but receive older records (ids <= cursor): stale feed.
      return historyPage([41, 42], 2);
    });
    const r = await handleOrderHistoryAnalytics({ since_id: 200, max_pages: 5, max_records: 1000 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("did not advance");
  });

  it("join-key honesty: externalId => normal key; missing externalId => null + explicit reason (never a CRM-id HMAC)", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          history: [
            { id: 31, orderId: 501, orderExternalId: "EXT-501", createdAt: "2026-07-01T10:00:00", source: "api", field: "status", old_value: { code: "new" }, new_value: { code: "complete" } },
            { id: 32, orderId: 502, createdAt: "2026-07-01T11:00:00", source: "api", field: "status", old_value: { code: "new" }, new_value: { code: "complete" } },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 2 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrderHistoryAnalytics({ max_pages: 1, max_records: 100 })).text);
    // externalId present: the normal join key over the /orders basis
    const expected = createHmac("sha256", SECRET).update("petdog-order-v1:EXT-501").digest("hex");
    expect(parsed.records[0].join_key).toBe(expected);
    expect(parsed.records[0].join_key_omitted_reason).toBeNull();
    // externalId absent: null + explicit non-PII reason — the CRM id is NEVER
    // HMAC-ed as though it matched the /orders basis (that would false-join).
    expect(parsed.records[1].join_key).toBeNull();
    expect(parsed.records[1].join_key_omitted_reason).toBe("no_order_external_id");
    const crmIdKey = createHmac("sha256", SECRET).update("petdog-order-v1:502").digest("hex");
    expect(parsed.records[1].join_key).not.toBe(crmIdKey);
  });

  it("fails closed on a weak secret before any bridge call", async () => {
    delete process.env.RETAILCRM_ANALYTICS_HMAC_SECRET;
    const bridge = mockBridge([]);
    const r = await handleOrderHistoryAnalytics({ max_pages: 1, max_records: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("fail closed");
    expect(bridge.calls.length).toBe(0);
  });
});

describe("legacy orders_history: raw/default semantics (criterion 11)", () => {
  const legacyPayload = {
    success: true,
    history: [
      { id: 11, orderId: 501, createdAt: "2026-07-01 10:00:00", source: "api", field: "status", old_value: { code: "new" }, new_value: { code: "complete" } },
      { id: 12, orderId: 501, createdAt: "2026-07-01 11:00:00", source: "api", field: "customerComment", old_value: null, new_value: "call me at 555" },
      { id: 13, orderId: 502, orderExternalId: "EXT-502", createdAt: "2026-07-01 12:00:00", source: "api", field: "payments", old_value: null, new_value: { p1: { status: "paid", paidAt: "2026-07-02 09:00:00", amount: 1500, type: "cash", comment: "pay secret" } } },
      { id: 14, orderId: 501, createdAt: "2026-07-01 13:00:00", source: "api", field: "fullPaidAt", old_value: null, new_value: "2026-07-02 09:00:00" },
    ],
    pagination: { currentPage: 1, totalPageCount: 3, totalCount: 45 },
  };

  it("raw:true preserves the explicit legacy raw response untouched", async () => {
    const bridge = mockBridge([legacyPayload]);
    const r = await handleOrdersHistory({ page: 1, limit: 20, raw: true });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toEqual(legacyPayload); // byte-equal provider payload
    expect(bridge.first()?.params).toMatchObject({ page: "1", limit: "20" }); // legacy query unchanged
  });

  // PROTECTION TEST — demonstrated RED on base a7ab7721c3d96834a4aac821d91f2e2a28ddba86
  // (base returned the raw payload by default, leaking customerComment) and GREEN here.
  it("default returns the safe projection: allowlisted changes only, no PII, no join-key requirement", async () => {
    process.env.RETAILCRM_ANALYTICS_HMAC_SECRET = "too-short"; // legacy default must NOT fail closed
    const bridge = mockBridge([legacyPayload]);
    const r = await handleOrdersHistory({ page: 1, limit: 20 });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.text);
    expect(parsed.history).toHaveLength(4);
    // Allowlisted status change: status object collapsed to its code
    expect(parsed.history[0].changes).toEqual({ status: { old: "new", new: "complete" } });
    // Non-allowlisted change (customerComment) is omitted entirely, not blanked
    expect(parsed.history[1].changes).toEqual({});
    // Payment change keeps allowlisted payment fields; the payment comment is dropped entirely
    expect(parsed.history[2].changes.payments).toEqual({
      new: { p1: { status: "paid", paidAt: "2026-07-02 09:00:00", amount: 1500, type: "cash" } },
      old: null,
    });
    // fullPaidAt is emitted only as the safe full_paid_at change: string/null values
    expect(parsed.history[3].changes).toEqual({ full_paid_at: { old: null, new: "2026-07-02 09:00:00" } });
    // Shaped pagination from the provider payload
    expect(parsed.pagination).toEqual({ page: 1, totalCount: 45, returned: 4, hasMore: true });
    // PII never leaks; join key is null (weak secret) rather than failing the legacy tool
    for (const banned of ["call me at 555", "customerComment", "pay secret"]) expect(r.text).not.toContain(banned);
    expect(parsed.history[0].join_key).toBeNull();
    // Weak secret => explicit omission reason, and no externalId on rec 0
    expect(parsed.history[0].join_key_omitted_reason).toBe("analytics_secret_unavailable");
    // Record 13 (EXT-502) would get a key with a valid secret; with the weak
    // secret the legacy path also reports analytics_secret_unavailable.
    expect(parsed.history[2].join_key).toBeNull();
    expect(parsed.history[2].join_key_omitted_reason).toBe("analytics_secret_unavailable");
  });

  it("omits page on cursor calls (sinceId present) and preserves it otherwise", async () => {
    const bridge = mockBridge([legacyPayload, legacyPayload]);
    // Cursor call: filter_since_id present => NO page param (official API
    // rejects sinceId+page with HTTP 400 since 2023-05-15).
    const cursor = await handleOrdersHistory({ page: 1, limit: 20, filter_since_id: 10 });
    expect(cursor.isError).toBeFalsy();
    const cursorParams = bridge.calls[0]?.params ?? {};
    expect(cursorParams["filter[sinceId]"]).toBe("10");
    expect("page" in cursorParams).toBe(false);
    // Non-cursor call: page is preserved exactly as before.
    const paged = await handleOrdersHistory({ page: 1, limit: 20 });
    expect(paged.isError).toBeFalsy();
    const pagedParams = bridge.calls[1]?.params ?? {};
    expect(pagedParams.page).toBe("1");
    expect("filter[sinceId]" in pagedParams).toBe(false);
  });

  it("raw:true with filter_since_id also omits page (cursor contract applies to raw too)", async () => {
    const bridge = mockBridge([legacyPayload]);
    const r = await handleOrdersHistory({ page: 1, limit: 20, filter_since_id: 12, raw: true });
    expect(r.isError).toBeFalsy();
    const params = bridge.first()?.params ?? {};
    expect(params["filter[sinceId]"]).toBe("12");
    expect("page" in params).toBe(false);
  });
});

describe("analytics-sxo v2 economics and channels", () => {
  it("covers all six canonical channel values and the namespaced precedence order", async () => {
    // One order per source; namespaced keys are preferred over legacy and the
    // source order order_method > site > source > delivery is enforced.
    process.env.RETAILCRM_ANALYTICS_CHANNEL_MAP = JSON.stringify({
      "order_method:chat-bot": "chat",
      "site:ozon-storefront": "ozon",
      "source:avito": "marketplace", // LEGACY input alias — must normalize to other_marketplace, never emitted
      "delivery:cdek": "site",
      "order_method:ignored-later": "site", // never reached: orderMethod checked before site
      "phone-in": "phone",                   // legacy bare code still accepted
      "site:x": "site",
    });
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [
            { id: 1, orderMethod: "chat-bot", site: "x", source: { source: "avito" }, delivery: { code: "cdek" }, items: [] },
            { id: 2, site: "ozon-storefront", source: { source: "avito" }, delivery: { code: "cdek" }, items: [] },
            { id: 3, source: "avito", delivery: { code: "cdek" }, items: [] }, // string native source
            { id: 4, delivery: { code: "cdek" }, items: [] },
            { id: 5, orderMethod: "phone-in", items: [] },
            { id: 6, orderMethod: "mystery", items: [] },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 6 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    const chans = parsed.orders.map((o: { channel: { value: string; basis: string } }) => o.channel);
    expect(chans).toEqual([
      { value: "chat", basis: "order_method" },           // namespaced order_method wins over every later source
      { value: "ozon", basis: "site" },                   // then site:…
      { value: "other_marketplace", basis: "source" },    // then native source code (legacy input alias marketplace, canonical output)
      { value: "site", basis: "delivery" },               // then delivery code
      { value: "phone", basis: "order_method" },          // legacy bare code on orderMethod
      { value: "unknown", basis: "unmapped" },            // nothing matches: unknown, never guessed
    ]);
    expect(parsed.channel_completeness).toEqual({ mapped: 5, unknown: 1 });
  });

  it("malformed item entries (null/undefined/primitive/array) project fail-closed safe items without throwing", () => {
    const r = projectOrder({
      id: 1,
      items: [
        null,
        undefined,
        "primitive-item",
        42,
        ["array-entry"],
        { offer: { xmlId: "OK-1" }, quantity: 1, initialPrice: 100 },
      ] as unknown as never,
    }, CTX);
    expect(r).not.toHaveProperty("error");
    if ("error" in r) throw new Error("projection failed");
    // Every malformed entry becomes ONE safe item: all evidence null except vat_status.
    const safe = { sku: null, quantity: null, revenue: null, vat_rate: null, vat_status: "missing", purchase_price: null, cogs: null, cancelled: null };
    expect(r.order.items[0]).toEqual(safe);
    expect(r.order.items[1]).toEqual(safe);
    expect(r.order.items[2]).toEqual(safe);
    expect(r.order.items[3]).toEqual(safe);
    expect(r.order.items[4]).toEqual(safe);
    // The one valid item still projects normally (fallback revenue 100*1).
    expect(r.order.items[5]).toMatchObject({ sku: "OK-1", quantity: 1, revenue: 100 });
    // A malformed item poisons item-level COGS/VAT completeness.
    expect(r.order.economics.item_cogs_total).toBeNull();
    expect(r.order.economics.completeness.item_cogs).toBe(false);
    expect(r.order.economics.completeness.item_vat).toBe(false);
  });

  it("negative/malformed price tranches and negative fallback inputs yield revenue null; a valid fallback keeps its exact result", () => {
    const mk = (items: unknown[]) => projectOrder({ id: 1, items: items as never }, CTX);
    // Negative tranche price invalidates the WHOLE prices path; the genuine
    // fallback inputs (finite non-negative) still yield their exact result.
    const negPrice = mk([{ quantity: 2, initialPrice: 500, prices: [{ price: 400, quantity: 1 }, { price: -50, quantity: 1 }] }]);
    if ("error" in negPrice) throw new Error("negPrice failed");
    expect(negPrice.order.items[0]?.revenue).toBe(1000); // valid fallback: 500*2 - 0
    // Malformed (null) tranche entry invalidates the prices path; no usable fallback => null.
    const nullTranche = mk([{ quantity: 1, prices: [{ price: 10, quantity: 1 }, null] }]);
    if ("error" in nullTranche) throw new Error("nullTranche failed");
    expect(nullTranche.order.items[0]?.revenue).toBeNull();
    // Negative quantity: not evidence — the fallback can never run => null.
    const negQty = mk([{ quantity: -2, initialPrice: 500 }]);
    if ("error" in negQty) throw new Error("negQty failed");
    expect(negQty.order.items[0]?.revenue).toBeNull();
    // Negative discountTotal rejects the fallback => null.
    const negDisc = mk([{ quantity: 2, initialPrice: 500, discountTotal: -10 }]);
    if ("error" in negDisc) throw new Error("negDisc failed");
    expect(negDisc.order.items[0]?.revenue).toBeNull();
    // Discount exceeding the line (negative result) => null, never clamped to zero.
    const overDisc = mk([{ quantity: 1, initialPrice: 100, discountTotal: 150 }]);
    if ("error" in overDisc) throw new Error("overDisc failed");
    expect(overDisc.order.items[0]?.revenue).toBeNull();
    // A genuine non-negative fallback keeps its exact expected value.
    const ok = mk([{ quantity: 3, initialPrice: 400, discountTotal: 50 }]);
    if ("error" in ok) throw new Error("ok failed");
    expect(ok.order.items[0]?.revenue).toBe(1150);
  });

  it("fails closed on malformed economics config before any bridge call", async () => {
    for (const bad of [
      "{not json",                                                        // malformed JSON
      "[1,2]",                                                            // not an object
      JSON.stringify({ surprise_key: "some_field" }),                     // unknown key
      JSON.stringify({ outside_mkad_surcharge: "a", commission_total: "a" }), // duplicate code
      JSON.stringify({ return_total: "  " }),                             // unsafe (empty) code
    ]) {
      process.env.RETAILCRM_ANALYTICS_ECONOMICS = bad;
      const bridge = mockBridge([]);
      const r = await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("RETAILCRM_ANALYTICS_ECONOMICS");
      expect(bridge.calls.length).toBe(0); // fail closed BEFORE any provider call
    }
  });

  it("extracts only finite non-negative configured economics numbers; never coerces strings", async () => {
    process.env.RETAILCRM_ANALYTICS_ECONOMICS = JSON.stringify({
      outside_mkad_surcharge: "mkad_fee",
      commission_total: "ozon_commission",
      return_total: "return_amount",
    });
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [{
            id: 1,
            items: [{ offer: { xmlId: "SKU-A" }, quantity: 2, purchasePrice: 100.125, vatRate: "22%" }],
            customFields: { mkad_fee: 500, ozon_commission: "250.50", return_amount: -1, some_other: "never-extract" },
          }],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.economics_configured_keys).toEqual(["commission_total", "outside_mkad_surcharge", "return_total"]);
    const eco = parsed.orders[0].economics;
    expect(eco.outside_mkad_surcharge).toEqual({ value: 500, field_code: "mkad_fee", source: "configured_custom_field", omitted_reason: null });
    // Strings are NEVER coerced; negatives rejected — both with explicit reasons.
    expect(eco.commission_total).toEqual({ value: null, field_code: "ozon_commission", source: "configured_custom_field", omitted_reason: "not_a_finite_non_negative_number" });
    expect(eco.return_total).toEqual({ value: null, field_code: "return_amount", source: "configured_custom_field", omitted_reason: "not_a_finite_non_negative_number" });
    expect(JSON.stringify(parsed)).not.toContain("never-extract"); // no arbitrary fields
    // item cogs = round2(100.125 * 2) = 200.25; known total sums ONLY known components: 200.25 + 500.
    expect(eco.item_cogs_total).toBe(200.25);
    expect(eco.known_costs_total).toBe(700.25);
    expect(eco.completeness).toEqual({ item_cogs: true, item_vat: true, delivery_actual_cost: false, outside_mkad_surcharge: true, commission_total: false, return_total: false });
    expect(parsed.orders[0].items[0]).toMatchObject({ cogs: 200.25, purchase_price: 100.125, vat_status: "accepted_10_22", cancelled: null });
  });

  it("COGS/VAT/completeness: zero items and null cogs stay null — never zero", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [
            // Zero items: item_cogs_total is NULL, not 0; item_vat completeness false.
            { id: 1, items: [] },
            // One item with cogs, one without (missing purchasePrice): whole total null.
            { id: 2, items: [{ offer: { xmlId: "A" }, quantity: 1, purchasePrice: 50, vatRate: "VAT22" }, { offer: { xmlId: "B" }, quantity: 1 }] },
            // Negative purchasePrice: cogs null; "10.5%" is unexpected (non-zero decimals).
            { id: 3, items: [{ offer: { xmlId: "C" }, quantity: 1, purchasePrice: -5, vatRate: "10.5%", isCanceled: true }] },
            // Negative quantity with a valid purchasePrice: cogs null (never a negative COGS).
            { id: 4, items: [{ offer: { xmlId: "E" }, quantity: -2, purchasePrice: 50 }] },
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 4 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.orders[0].economics.item_cogs_total).toBeNull();
    expect(parsed.orders[0].economics.completeness.item_cogs).toBe(false);
    expect(parsed.orders[0].economics.completeness.item_vat).toBe(false); // empty item list is NOT complete
    expect(parsed.orders[1].economics.item_cogs_total).toBeNull(); // one unknown cogs poisons the total
    expect(parsed.orders[1].economics.completeness.item_cogs).toBe(false);
    expect(parsed.orders[1].economics.completeness.item_vat).toBe(false); // one item unexpected ("missing")
    expect(parsed.orders[2].items[0].cogs).toBeNull(); // negative purchasePrice => null
    expect(parsed.orders[2].items[0].vat_status).toBe("unexpected"); // "10.5%" has non-zero decimals
    expect(parsed.orders[2].items[0].cancelled).toBe(true);
    // Negative quantity with a valid purchasePrice: cogs null, never negative COGS.
    expect(parsed.orders[3].items[0].cogs).toBeNull();
    expect(parsed.orders[3].economics.item_cogs_total).toBeNull();
    expect(parsed.orders[3].economics.completeness.item_cogs).toBe(false);
    // Envelope counts reflect true presence only.
    expect(parsed.economics_completeness).toEqual({
      order_count: 4,
      complete_item_cogs: 0,
      accepted_item_vat: 0,
      delivery_actual_cost_present: 0,
      outside_mkad_surcharge_present: 0,
      commission_total_present: 0,
      return_total_present: 0,
    });
  });

  it("safe delivery projection keeps only {code,cost,net_cost,vat_rate}; non-object delivery is null", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [
            {
              id: 1,
              delivery: { code: "cdek", cost: "300", netCost: 250.5, vatRate: "20%", address: { text: "Secret Street 9" }, service: { name: "CDEK" } },
              items: [{ offer: { xmlId: "D" }, quantity: 1, purchasePrice: 100 }],
            },
            { id: 2, delivery: "courier", items: [] }, // non-object delivery
            { id: 3, delivery: null, items: [] },      // absent delivery
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 3 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 })).text);
    expect(parsed.orders[0].delivery).toEqual({ code: "cdek", cost: null, net_cost: 250.5, vat_rate: "20%" }); // non-numeric cost => null
    expect(parsed.orders[0].economics.delivery_actual_cost).toBe(250.5); // net_cost is the actual-cost evidence
    expect(parsed.orders[1].delivery).toBeNull();
    expect(parsed.orders[2].delivery).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("Secret Street");
    expect(JSON.stringify(parsed)).not.toContain("CDEK");
  });

  it("publication evidence: a partial window is non-publishable; a traversed result is complete and publishable", async () => {
    const bridge = mockBridge([]);
    bridge.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const page = Number(req.params?.page ?? "1");
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [{ id: page, totalSumm: 100 }],
          pagination: { currentPage: page, totalPageCount: 3, totalCount: 3 },
        },
      };
    });
    const partial = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 2, max_orders: 10_000 })).text);
    expect(partial.complete).toBe(false);
    expect(partial.publication_status).toBe("partial");
    expect(partial.publishable).toBe(false);
    expect(partial.pages_fetched).toBe(2);
    expect(partial.totals.revenue).toBe(200);        // bounded observed subtotal kept for diagnosis
    expect(partial.totals.revenue_scope).toBe("partial_window");
    expect(partial.totals.publishable).toBe(false);  // ...but never publishable
    const complete = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-08-01", date_to: "2026-08-31", max_pages: 10, max_orders: 10_000 })).text);
    expect(complete.complete).toBe(true);
    expect(complete.publication_status).toBe("complete");
    expect(complete.publishable).toBe(true);
    expect(complete.pages_fetched).toBe(3);
    expect(complete.totals.revenue_scope).toBe("complete");
    expect(complete.totals.publishable).toBe(true);
    // Complete traversal but EVERY order total is missing: traversal status
    // stays "complete", yet amounts fail closed — revenue/AOV null, not zero.
    const bridge2 = mockBridge([]);
    bridge2.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const page = Number(req.params?.page ?? "1");
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [{ id: page }], // no totalSumm => projected total is null
          pagination: { currentPage: page, totalPageCount: 3, totalCount: 3 },
        },
      };
    });
    const incompleteValues = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-09-01", date_to: "2026-09-30", max_pages: 10, max_orders: 10_000 })).text);
    expect(incompleteValues.complete).toBe(true);
    expect(incompleteValues.publication_status).toBe("complete");
    expect(incompleteValues.publishable).toBe(false);
    expect(incompleteValues.totals.publishable).toBe(false);
    expect(incompleteValues.totals.revenue).toBeNull();
    expect(incompleteValues.totals.average_order_value).toBeNull();
    expect(incompleteValues.totals.revenue_scope).toBe("incomplete_values");
    expect(incompleteValues.total_amount_completeness).toEqual({ present: 0, missing: 3 });
    // Same fail-closed contract for MALFORMED totals: negative, NaN and Infinity
    // totalSumm each project as null and keep the completed traversal
    // non-publishable with incomplete_values — never coerced to a number.
    const bridge3 = mockBridge([]);
    bridge3.implement(req => {
      if (req.path === "/reference/payment-statuses") return paidStatusPage;
      const page = Number(req.params?.page ?? "1");
      const malformedTotals = [-50, Number.NaN, Number.POSITIVE_INFINITY];
      return {
        v: 1, ok: true, status: 200,
        data: {
          success: true,
          orders: [{ id: page, totalSumm: malformedTotals[page - 1] }],
          pagination: { currentPage: page, totalPageCount: 3, totalCount: 3 },
        },
      };
    });
    const malformedTotals = JSON.parse((await handleOrdersAnalytics({ date_from: "2026-10-01", date_to: "2026-10-31", max_pages: 10, max_orders: 10_000 })).text);
    expect(malformedTotals.orders.map((o: { total: number | null }) => o.total)).toEqual([null, null, null]);
    expect(malformedTotals.complete).toBe(true);
    expect(malformedTotals.publication_status).toBe("complete");
    expect(malformedTotals.publishable).toBe(false);
    expect(malformedTotals.totals.publishable).toBe(false);
    expect(malformedTotals.totals.revenue).toBeNull();
    expect(malformedTotals.totals.average_order_value).toBeNull();
    expect(malformedTotals.totals.revenue_scope).toBe("incomplete_values");
    expect(malformedTotals.total_amount_completeness).toEqual({ present: 0, missing: 3 });
  });
});
