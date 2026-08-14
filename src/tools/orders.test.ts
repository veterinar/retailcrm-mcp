import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleListOrders, handleGetOrder, handleCreateOrder, handleUpdateOrder } from "./orders.js";
import { mockBridge } from "../../tests/bridge-mock.js";

beforeEach(() => {
  process.env.RETAILCRM_DOMAIN = "testshop.retailcrm.ru";
  process.env.RETAILCRM_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleListOrders", () => {
  it("sends correct filter params to the bridge", async () => {
    const bridge = mockBridge([{ success: true, orders: [], pagination: { totalCount: 0 } }]);
    await handleListOrders({ filter_status: "complete", filter_date_from: "2025-01-01", detail: "summary", page: 1, limit: 10 });
    const req = bridge.first();
    expect(req.op).toBe("get");
    expect(req.path).toBe("/orders");
    expect(req.params).toMatchObject({
      "filter[status]": "complete",
      "filter[createdAtFrom]": "2025-01-01",
      limit: "10",
    });
  });

  it("returns a shaped summary with pagination", async () => {
    mockBridge([{
      success: true,
      orders: [{ id: 1, number: "100", status: "new", totalSumm: 500, items: [{}], createdAt: "2025-01-01 10:00:00" }],
      pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
    }]);
    const result = await handleListOrders({ detail: "summary", page: 1, limit: 20 });
    const parsed = JSON.parse(result.text);
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.orders[0]).toMatchObject({ id: 1, number: "100", status: "new", total: 500, itemCount: 1 });
    expect(parsed.orders[0].items).toBeUndefined(); // summary omits heavy nesting
    expect(parsed.pagination).toMatchObject({ page: 1, totalCount: 1, returned: 1, hasMore: false });
  });

  it("full detail includes line items", async () => {
    mockBridge([{
      success: true,
      orders: [{ id: 1, number: "100", items: [{ offer: { displayName: "Widget" }, quantity: 2, initialPrice: 250 }] }],
      pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
    }]);
    const result = await handleListOrders({ detail: "full", page: 1, limit: 20 });
    const parsed = JSON.parse(result.text);
    expect(parsed.orders[0].items).toEqual([{ name: "Widget", quantity: 2, initialPrice: 250, discountTotal: 0, price: 250 }]);
  });
});

describe("handleGetOrder", () => {
  it("fetches and shapes an order by id", async () => {
    const bridge = mockBridge([{ success: true, order: { id: 42, number: "42", status: "new" } }]);
    const result = await handleGetOrder({ id: "42", by: "id", detail: "summary" });
    const req = bridge.first();
    expect(req.op).toBe("get");
    expect(req.path).toBe("/orders/42");
    expect(JSON.parse(result.text).order.id).toBe(42);
  });

  it("supports externalId lookup", async () => {
    const bridge = mockBridge([{ success: true, order: { id: 42 } }]);
    await handleGetOrder({ id: "EXT-001", by: "externalId", detail: "summary" });
    const req = bridge.first();
    expect(req.path).toBe("/orders/EXT-001");
    expect(req.params).toMatchObject({ by: "externalId" });
  });

  it("returns isError (not a throw) on a 404", async () => {
    const bridge = mockBridge();
    bridge.implement(() => ({ v: 1, ok: false, status: 404, body: "not found" }));
    const result = await handleGetOrder({ id: "999", by: "id", detail: "summary" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("404");
  });
});

describe("handleCreateOrder", () => {
  it("sends order with items and inline customer", async () => {
    const bridge = mockBridge([{ success: true, id: 100 }]);
    await handleCreateOrder({
      first_name: "Ivan", last_name: "Petrov", phone: "+790****4567",
      order_type: "eshop-individual",
      items: [{ product_name: "Widget", quantity: 2, initial_price: 500 }],
    });
    const req = bridge.first();
    expect(req.op).toBe("post");
    expect(req.path).toBe("/orders/create");
    const order = JSON.parse(req.params!.order);
    expect(order.firstName).toBe("Ivan");
    expect(order.items).toHaveLength(1);
    expect(order.customer.phones[0].number).toBe("+790****4567");
  });

  it("links an existing customer by id instead of inline", async () => {
    const bridge = mockBridge([{ success: true, id: 101 }]);
    await handleCreateOrder({
      customer_id: 555, order_type: "eshop-individual",
      items: [{ product_name: "Widget", quantity: 1, initial_price: 100 }],
    });
    const order = JSON.parse(bridge.first().params!.order);
    expect(order.customer).toEqual({ id: 555 });
    expect(order.firstName).toBeUndefined();
  });

  it("passes site through to the form params", async () => {
    const bridge = mockBridge([{ success: true, id: 102 }]);
    await handleCreateOrder({
      first_name: "Ivan", order_type: "eshop-individual", site: "myshop",
      items: [{ product_name: "Widget", quantity: 1, initial_price: 100 }],
    });
    const params = bridge.first().params!;
    expect(params.site).toBe("myshop");
    // order travels as a flat JSON-string form field (PHP side form-encodes it)
    expect(params.order).toContain('"firstName":"Ivan"');
  });

  it("returns isError when no customer info given", async () => {
    const result = await handleCreateOrder({
      order_type: "eshop-individual",
      items: [{ product_name: "Widget", quantity: 1, initial_price: 100 }],
    });
    expect(result.isError).toBe(true);
  });
});

describe("handleUpdateOrder", () => {
  it("sends only changed fields", async () => {
    const bridge = mockBridge([{ success: true }]);
    await handleUpdateOrder({ id: "42", by: "id", status: "complete", manager_comment: "Shipped" });
    const req = bridge.first();
    expect(req.path).toBe("/orders/42/edit");
    const order = JSON.parse(req.params!.order);
    expect(order.status).toBe("complete");
    expect(order.managerComment).toBe("Shipped");
    expect(order.firstName).toBeUndefined();
  });
});
