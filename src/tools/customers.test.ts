import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleListCustomers, handleGetCustomer, handleCreateCustomer,
  handleUpdateCustomer, handleMergeCustomers, handleCustomersHistory,
  handleGetCustomerFieldDefinitions, getCustomerFieldDefinitionsSchema,
  getCustomerSchema, listCustomersSchema, customersHistorySchema,
} from "./customers.js";
import { mockBridge } from "../../tests/bridge-mock.js";

beforeEach(() => {
  process.env.RETAILCRM_DOMAIN = "testshop.retailcrm.ru";
  process.env.RETAILCRM_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleListCustomers", () => {
  it("sends correct filter params and shapes a summary", async () => {
    const bridge = mockBridge([{
      success: true,
      customers: [{ id: 5, firstName: "Ivan", lastName: "Petrov", email: "i@mail.ru", ordersCount: 3, totalSumm: 9000 }],
      pagination: { currentPage: 1, totalPageCount: 1, totalCount: 1 },
    }]);
    const result = await handleListCustomers({ filter_email: "test@mail.ru", detail: "summary", page: 1, limit: 20 });
    const req = bridge.first();
    expect(req.op).toBe("get");
    expect(req.path).toBe("/customers");
    expect(req.params).toMatchObject({ "filter[email]": "test@mail.ru", limit: "20" });
    const parsed = JSON.parse(result.text);
    expect(parsed.customers[0]).toMatchObject({ id: 5, name: "Ivan Petrov", ordersCount: 3, totalSpent: 9000 });
  });

  it("accepts only documented page sizes", () => {
    for (const limit of [20, 50, 100]) {
      expect(listCustomersSchema.safeParse({ limit }).success).toBe(true);
    }
    for (const limit of [1, 10, 101]) {
      expect(listCustomersSchema.safeParse({ limit }).success).toBe(false);
    }
    expect(listCustomersSchema.parse({}).limit).toBe(20);
  });

  it("uses the customers-endpoint date filter keys (dateFrom/dateTo, not createdAt*)", async () => {
    const bridge = mockBridge([{ success: true, customers: [], pagination: { totalCount: 0 } }]);
    await handleListCustomers({ filter_date_from: "2025-01-01", filter_date_to: "2025-01-31", detail: "summary", page: 1, limit: 20 });
    const req = bridge.first();
    expect(req.params).toMatchObject({
      "filter[dateFrom]": "2025-01-01",
      "filter[dateTo]": "2025-01-31",
    });
    expect(JSON.stringify(req.params)).not.toContain("createdAtFrom");
  });
});

describe("handleGetCustomer", () => {
  it("fetches and shapes a customer by id", async () => {
    const bridge = mockBridge([{ success: true, customer: { id: 5, firstName: "Ivan" } }]);
    const input = getCustomerSchema.parse({ id: "5", detail: "summary" });
    const result = await handleGetCustomer(input);
    const req = bridge.first();
    expect(req.path).toBe("/customers/5");
    expect(req.params).toEqual({ by: "id" });
    expect(JSON.parse(result.text).customer.name).toBe("Ivan");
  });

  it("passes externalId through explicitly", async () => {
    const bridge = mockBridge([{ success: true, customer: { id: 5 } }]);
    await handleGetCustomer({ id: "EXT-5", by: "externalId", detail: "summary" });
    const req = bridge.first();
    expect(req.path).toBe("/customers/EXT-5");
    expect(req.params).toEqual({ by: "externalId" });
  });
});

describe("handleGetCustomerFieldDefinitions", () => {
  it("requests customer metadata only, returns requested fields, omits values, and reports unmatched codes", async () => {
    const secretValue = "must-not-be-returned";
    const bridge = mockBridge([{
      customFields: [
        { code: "customer2dc3445a905c", name: "Consent", type: "checkbox", entity: "customer", value: secretValue },
        { code: "customer379a31661a00", name: "Import note", type: "text", entity: "customer", value: secretValue },
        { code: "unrequested", name: "Other", type: "text", entity: "customer", value: secretValue },
        { code: "order-only", name: "Other entity", type: "text", entity: "order", value: secretValue },
      ],
    }]);
    const result = await handleGetCustomerFieldDefinitions({ codes: ["customer2dc3445a905c", "order-only", "missing"] });
    expect(bridge.first()?.path).toBe("/custom-fields");
    expect(bridge.first()?.params).toEqual({ "filter[entity]": "customer" });
    expect(JSON.parse(result.text)).toEqual({
      fields: [{ code: "customer2dc3445a905c", name: "Consent", type: "checkbox", entity: "customer" }],
      unmatched_codes: ["order-only", "missing"],
    });
    expect(result.text).not.toContain(secretValue);
  });

  it("supports code-keyed metadata maps and enforces the bounded code list", async () => {
    const bridge = mockBridge([{ customFields: { customer379a31661a00: { name: "Consent source", type: "text" } } }]);
    const result = await handleGetCustomerFieldDefinitions({ codes: ["customer379a31661a00"] });
    expect(bridge.first()?.params).toEqual({ "filter[entity]": "customer" });
    expect(JSON.parse(result.text)).toEqual({
      fields: [{ code: "customer379a31661a00", name: "Consent source", type: "text", entity: "customer" }],
      unmatched_codes: [],
    });
    expect(getCustomerFieldDefinitionsSchema.safeParse({ codes: ["x"] }).success).toBe(true);
    expect(getCustomerFieldDefinitionsSchema.safeParse({ codes: [] }).success).toBe(false);
    expect(getCustomerFieldDefinitionsSchema.safeParse({ codes: [""] }).success).toBe(false);
    expect(getCustomerFieldDefinitionsSchema.safeParse({ codes: ["x".repeat(129)] }).success).toBe(false);
    expect(getCustomerFieldDefinitionsSchema.safeParse({ codes: Array(21).fill("x") }).success).toBe(false);
  });
});

describe("handleCustomersHistory", () => {
  it("filters to a customer ID and preserves ordinary pagination and date filters", async () => {
    const bridge = mockBridge([{ success: true, history: [], pagination: { totalCount: 0 } }]);
    await handleCustomersHistory({ filter_customer_id: 42, filter_date_from: "2026-01-01", filter_date_to: "2026-01-31", page: 2, limit: 50 });
    expect(bridge.first()?.path).toBe("/customers/history");
    expect(bridge.first()?.params).toEqual({
      limit: "50", page: "2", "filter[customerId]": "42",
      "filter[startDate]": "2026-01-01", "filter[endDate]": "2026-01-31",
    });
    expect(customersHistorySchema.safeParse({ filter_customer_id: 1 }).success).toBe(true);
    expect(customersHistorySchema.safeParse({ filter_customer_id: 0 }).success).toBe(false);
    expect(customersHistorySchema.safeParse({ filter_customer_id: 4_294_967_296 }).success).toBe(false);
  });

  it("omits page for sinceId cursor calls while preserving customer/date/limit filters", async () => {
    const bridge = mockBridge([{ success: true, history: [], pagination: { totalCount: 0 } }]);
    await handleCustomersHistory({ filter_since_id: 10, filter_customer_id: 42, filter_date_from: "2026-01-01", page: 3, limit: 100 });
    const params = bridge.first()?.params ?? {};
    expect(params).toEqual({
      limit: "100", "filter[sinceId]": "10", "filter[customerId]": "42",
      "filter[startDate]": "2026-01-01",
    });
    expect("page" in params).toBe(false);
  });
});

describe("handleCreateCustomer", () => {
  it("sends customer with phones and address", async () => {
    const bridge = mockBridge([{ success: true, id: 10 }]);
    await handleCreateCustomer({
      first_name: "Anna", last_name: "Ivanova", email: "anna@mail.ru",
      phones: ["+790****1111", "+790****2222"], address_city: "Moscow",
    });
    const req = bridge.first();
    expect(req.op).toBe("post");
    expect(req.path).toBe("/customers/create");
    const customer = JSON.parse(req.params!.customer);
    expect(customer.firstName).toBe("Anna");
    expect(customer.phones).toHaveLength(2);
    expect(customer.address.city).toBe("Moscow");
  });
});

describe("handleUpdateCustomer", () => {
  it("edits a customer by externalId", async () => {
    const bridge = mockBridge([{ success: true }]);
    await handleUpdateCustomer({ id: "EXT-9", by: "externalId", email: "new@mail.ru" });
    const req = bridge.first();
    expect(req.path).toBe("/customers/EXT-9/edit");
    expect(req.params).toMatchObject({ by: "externalId" });
    expect(JSON.parse(req.params!.customer).email).toBe("new@mail.ru");
  });
});

describe("handleMergeCustomers", () => {
  it("sends merge request with correct params", async () => {
    const bridge = mockBridge([{ success: true }]);
    await handleMergeCustomers({ result_customer_id: 1, merged_customer_ids: [2, 3] });
    const req = bridge.first();
    expect(req.path).toBe("/customers/combine");
    expect(req.params!.resultCustomer).toBeDefined();
    expect(req.params!.mergedCustomers).toBeDefined();
  });
});
