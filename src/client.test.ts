import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retailCrmGet, retailCrmPost, retailCrmPostRaw, RetailCrmHttpError } from "./client.js";
import { mockBridge, bridgeTimeout, bridgeHttpError } from "../tests/bridge-mock.js";

beforeEach(() => {
  process.env.RETAILCRM_DOMAIN = "testshop.retailcrm.ru";
  process.env.RETAILCRM_API_KEY = "test-api-key-123";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RETAILCRM_DOMAIN;
  delete process.env.RETAILCRM_API_KEY;
});

describe("retailCrmGet (PHP bridge transport)", () => {
  it("sends op:get with the route and flat params to the bridge (no leading slash)", async () => {
    const bridge = mockBridge([{ success: true, orders: [] }]);

    const result = await retailCrmGet("/orders", { "filter[status]": "new", limit: "20" });

    expect(result).toEqual({ success: true, orders: [] });
    const req = bridge.first();
    expect(req.v).toBe(1);
    expect(req.op).toBe("get");
    expect(req.path).toBe("/orders"); // bridge strips the leading slash itself
    expect(req.params).toEqual({ "filter[status]": "new", limit: "20" });
    // Credentials must NOT travel in the bridge request payload
    expect(JSON.stringify(req)).not.toContain("test-api-key-123");
  });

  it("maps a bridge {ok:false} with RetailCRM error body to a descriptive error", async () => {
    const bridge = mockBridge();
    bridge.implement(() => ({
      v: 1,
      ok: false,
      status: 403,
      body: JSON.stringify({
        success: false,
        errorMsg: "Access denied",
        errors: { apiKey: "Invalid API key" },
      }),
    }));

    await expect(retailCrmGet("/orders")).rejects.toThrow(/Access denied.*apiKey/);
  });

  it("retries on 429 rate limit", async () => {
    const bridge = mockBridge([{ success: true }]);
    bridge.rejectNext(() => bridgeHttpError(429));

    const result = await retailCrmGet("/orders");
    expect(result).toEqual({ success: true });
    expect(bridge.calls.length).toBe(2); // one failure + one retry
  });

  it("does NOT retry a 4xx whose body merely contains '429'", async () => {
    const bridge = mockBridge();
    bridge.implement(() => ({
      v: 1,
      ok: false,
      status: 400,
      body: JSON.stringify({ success: false, errorMsg: "Order 429 not found" }),
    }));

    await expect(retailCrmGet("/orders/429")).rejects.toMatchObject({ status: 400 });
    expect(bridge.calls.length).toBe(1); // no spurious retry
  });

  it("retries on a timeout then succeeds (GET is idempotent)", async () => {
    const bridge = mockBridge([{ success: true }]);
    bridge.rejectNext(() => bridgeTimeout());

    const result = await retailCrmGet("/orders");
    expect(result).toEqual({ success: true });
    expect(bridge.calls.length).toBe(2);
  });

  it("surfaces the numeric status on RetailCrmHttpError", async () => {
    const bridge = mockBridge();
    bridge.implement(() => ({ v: 1, ok: false, status: 404, body: "not found" }));

    const err = await retailCrmGet("/orders/999").catch((e) => e);
    expect(err).toBeInstanceOf(RetailCrmHttpError);
    expect(err.status).toBe(404);
  });

  it("rejects a protocol-violating bridge response (fail closed)", async () => {
    const bridge = mockBridge();
    // Wrong protocol version must never be treated as success
    bridge.implement(() => ({ v: 2, ok: true, data: { success: true } }));

    await expect(retailCrmGet("/orders")).rejects.toThrow("protocol violation");
  });

  it("throws when env vars are missing", async () => {
    delete process.env.RETAILCRM_DOMAIN;
    delete process.env.RETAILCRM_URL;
    await expect(retailCrmGet("/orders")).rejects.toThrow("RETAILCRM_DOMAIN is not set");
  });

  it("throws when the API key is missing", async () => {
    delete process.env.RETAILCRM_API_KEY;
    await expect(retailCrmGet("/orders")).rejects.toThrow("RETAILCRM_API_KEY is not set");
  });
});

describe("retailCrmPost (PHP bridge transport)", () => {
  it("sends op:post with form params (no key in payload)", async () => {
    const bridge = mockBridge([{ success: true, id: 42 }]);

    const result = await retailCrmPost("/orders/create", { order: '{"firstName":"Test"}' });

    expect(result).toEqual({ success: true, id: 42 });
    const req = bridge.first();
    expect(req.op).toBe("post");
    expect(req.path).toBe("/orders/create");
    expect(req.params).toEqual({ order: '{"firstName":"Test"}' });
    expect(JSON.stringify(req)).not.toContain("test-api-key-123");
  });

  it("retries a POST on 429 (server rejected before processing)", async () => {
    const bridge = mockBridge([{ success: true }]);
    bridge.rejectNext(() => bridgeHttpError(429));

    const result = await retailCrmPost("/orders/create", { order: "{}" });
    expect(result).toEqual({ success: true });
    expect(bridge.calls.length).toBe(2);
  });

  it("does NOT retry a POST on 500 (mutation may have committed)", async () => {
    const bridge = mockBridge();
    bridge.implement(() => ({ v: 1, ok: false, status: 500, body: "Server Error" }));

    await expect(retailCrmPost("/orders/create", { order: "{}" })).rejects.toThrow("HTTP 500");
    expect(bridge.calls.length).toBe(1); // no duplicate-write risk
  });

  it("does NOT retry a POST on timeout (mutation may have committed)", async () => {
    const bridge = mockBridge();
    bridge.implement(() => bridgeTimeout());

    await expect(retailCrmPost("/orders/create", { order: "{}" })).rejects.toMatchObject({ isTimeout: true });
    expect(bridge.calls.length).toBe(1);
  });
});

describe("retailCrmPostRaw (files_upload exception, PHP bridge transport)", () => {
  it("sends op:post_raw with base64 body and caller content type", async () => {
    const bridge = mockBridge([{ success: true, file: [{ id: 7 }] }]);

    const bytes = Uint8Array.from(Buffer.from("hello", "utf8"));
    const result = await retailCrmPostRaw(
      "/files/upload?filename=test.txt",
      bytes,
      "text/plain",
    );

    expect(result).toEqual({ success: true, file: [{ id: 7 }] });
    const req = bridge.first();
    expect(req.op).toBe("post_raw");
    expect(req.path).toBe("/files/upload?filename=test.txt");
    expect(Buffer.from(req.body_base64 ?? "", "base64").toString("utf8")).toBe("hello");
    expect(req.content_type).toBe("text/plain");
    expect(JSON.stringify(req)).not.toContain("test-api-key-123");
  });
});
