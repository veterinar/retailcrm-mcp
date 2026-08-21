import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  projectOrder, checkAnalyticsSecret, normalizeOrderId, handleOrderHistoryAnalytics,
  handleOrdersAnalytics, handlePaidOrders, handleOrderAttribution, handleAttributionFields,
} from "./analytics-sxo.js";
import { handleOrdersHistory } from "./orders.js";
import { mockBridge } from "../../tests/bridge-mock.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars
const ENV_KEYS = ["RETAILCRM_ANALYTICS_HMAC_SECRET", "RETAILCRM_ANALYTICS_ATTRIBUTION", "RETAILCRM_ANALYTICS_CHANNEL_MAP"] as const;

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

const CTX = { secret: SECRET, attribution: { configured: false } as const, channelMap: {} as Record<string, never>, paidStatusCodes: new Set(["paid"]) };

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
    for (const banned of ["Ivan", "Petrov", "example.com", "+7 999", "+7999", "Secret Street", "manager secret", "customer secret", "status secret", "pay secret", "Dog Food", "CDEK", "01046MARK", "markingCode", "secret_note", "call me", "managerId", "\"customer\"", "\"firstName\"", "\"managerComment\"", "\"delivery\"", "\"phones\"", "\"email\""]) {
      expect(text).not.toContain(banned);
    }
    // The native clientId VALUE is exposed only under its explicit renamed provenance
    const parsed = JSON.parse(text);
    expect(parsed.orders[0].retailcrm_client_id).toBe("native-cid-1");
    expect(parsed.orders[0].retailcrm_client_id_source).toBe("retailcrm_native_clientId");
    expect(parsed.complete).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.orders[0].attribution.client_id).toMatchObject({ value: "12345", field_code: "metrika_cid", source: "configured_custom_field" });
    expect(parsed.orders[0].items[0]).toEqual({ sku: "SKU-1", quantity: 2, revenue: 900, vat_rate: "20%" });
    expect(parsed.totals.revenue).toBe(1500);
  });

  it("maps paymentComplete statuses and paid_at fallback", async () => {
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
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 3 },
        },
      };
    });
    const window = { date_from: "2026-07-01", date_to: "2026-07-31", max_pages: 1, max_orders: 10 };
    const all = JSON.parse((await handleOrdersAnalytics(window)).text);
    expect(all.orders.map((o: { id: number; paid_at: string | null }) => [o.id, o.paid_at])).toEqual([
      [1, "2026-07-02T09:00:00"], // fullPaidAt wins over payment paidAt
      [2, null],                  // non-complete payment never yields paid_at
      [3, "2026-07-03T08:30:00"], // fallback to paidAt of a complete payment
    ]);
    const paid = JSON.parse((await handlePaidOrders(window)).text);
    expect(paid.paid_count).toBe(2);
    expect(paid.count).toBe(2);
    expect(paid.window_total_count).toBe(3);
  });

  it("paid_at fallback picks the LATEST complete-payment paidAt (insertion order older-first)", () => {
    const r = projectOrder({
      id: 9,
      payments: {
        a: { status: "paid", paidAt: "2026-07-01T12:00:00" }, // older — inserted FIRST
        b: { status: "paid", paidAt: "2026-07-05T08:00:00" }, // newer — inserted SECOND
      },
    }, CTX);
    if ("error" in r) throw new Error("projection failed");
    expect(r.order.paid_at).toBe("2026-07-05T08:00:00");
  });

  it("item evidence per current OpenAPI: multi-price sum, discount fallback, string VAT, externalId SKU, malformed=>null", () => {
    const mk = (items: Parameters<typeof projectOrder>[0]["items"]) =>
      projectOrder({ id: 1, items }, CTX);
    // Multi-tranche prices: sum EVERY price*quantity — never prices[0] alone.
    const multi = mk([{ offer: { externalId: "EXT-SKU", xmlId: "XML-1", article: "ART-1" }, quantity: 3, initialPrice: 500, prices: [{ price: 400, quantity: 1 }, { price: 350, quantity: 2 }] }]);
    if ("error" in multi) throw new Error("multi failed");
    expect(multi.order.items[0]).toEqual({ sku: "EXT-SKU", quantity: 3, revenue: 1100, vat_rate: null }); // externalId wins SKU precedence
    // No usable prices[]: (initialPrice - per-unit discountTotal) * quantity.
    const disc = mk([{ offer: { xmlId: "XML-2" }, quantity: 2, initialPrice: 500, discountTotal: 50 }]);
    if ("error" in disc) throw new Error("disc failed");
    expect(disc.order.items[0]?.revenue).toBe(900);
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

  it("exposes old/new ONLY for status and payments; business fields are omitted", async () => {
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
          ],
          pagination: { currentPage: 1, totalPageCount: 1, totalCount: 8 },
        },
      };
    });
    const parsed = JSON.parse((await handleOrderHistoryAnalytics({ max_pages: 1, max_records: 100 })).text);
    expect(parsed.count).toBe(8);
    // Only status/payments expose old/new values; every other field —
    // including previously-allowlisted business fields — is omitted entirely.
    expect(parsed.records[0].changes).toEqual({ status: { old: "new", new: "complete" } });
    expect(Object.keys(parsed.records[1].changes)).toEqual(["payments"]);
    for (const i of [2, 3, 4, 5, 6, 7]) {
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
    expect(parsed.history).toHaveLength(3);
    // Allowlisted status change: status object collapsed to its code
    expect(parsed.history[0].changes).toEqual({ status: { old: "new", new: "complete" } });
    // Non-allowlisted change (customerComment) is omitted entirely, not blanked
    expect(parsed.history[1].changes).toEqual({});
    // Payment change keeps allowlisted payment fields; the payment comment is dropped entirely
    expect(parsed.history[2].changes.payments).toEqual({
      new: { p1: { status: "paid", paidAt: "2026-07-02 09:00:00", amount: 1500, type: "cash" } },
      old: null,
    });
    // Shaped pagination from the provider payload
    expect(parsed.pagination).toEqual({ page: 1, totalCount: 45, returned: 3, hasMore: true });
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
