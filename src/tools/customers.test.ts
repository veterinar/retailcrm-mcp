import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleListCustomers, handleGetCustomer, handleCreateCustomer,
  handleUpdateCustomer, handleMergeCustomers,
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
    const result = await handleListCustomers({ filter_email: "test@mail.ru", detail: "summary", page: 1, limit: 10 });
    const req = bridge.first();
    expect(req.op).toBe("get");
    expect(req.path).toBe("/customers");
    expect(req.params).toMatchObject({ "filter[email]": "test@mail.ru" });
    const parsed = JSON.parse(result.text);
    expect(parsed.customers[0]).toMatchObject({ id: 5, name: "Ivan Petrov", ordersCount: 3, totalSpent: 9000 });
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
    const result = await handleGetCustomer({ id: "5", by: "id", detail: "summary" });
    const req = bridge.first();
    expect(req.path).toBe("/customers/5");
    expect(JSON.parse(result.text).customer.name).toBe("Ivan");
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
