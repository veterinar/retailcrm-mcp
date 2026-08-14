import { afterEach } from "vitest";
import { __setTestBridge, RetailCrmHttpError, type BridgeHandler, type BridgeRequest, type BridgeResponse } from "../src/client.js";

/**
 * Shared test-only bridge seam for the RetailCRM PHP bridge transport.
 *
 * Instead of mocking global fetch (production no longer uses it), tests record
 * the exact bridge requests ({v, op, path, params, body_base64, content_type})
 * and script bridge responses. Responses flow through the production
 * fail-closed protocol validation, so mocks cannot bypass protocol rules.
 */

/** Recorded bridge request (exact object production sends to the PHP bridge). */
export type RecordedBridgeRequest = BridgeRequest;

const recorded: BridgeRequest[] = [];

let script: ((req: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>) | null = null;

let rejects: ((
  req: BridgeRequest,
  attempt: number,
) => Promise<never> | never)[] = [];

const handler: BridgeHandler = async (req) => {
  recorded.push(req);
  const reject = rejects.shift();
  if (reject) await reject(req, recorded.length);
  if (script) return await script(req);
  return { v: 1, ok: true, status: 200, data: { success: true } };
};

/**
 * Install the bridge mock for the current test. Optionally script responses:
 * each call returns the given data (default {success:true}) for one request.
 */
export function mockBridge(responses: unknown[] = []) {
  recorded.length = 0;
  rejects = [];
  __setTestBridge(handler);
  let index = 0;
  script = (req) => {
    const data = index < responses.length ? responses[index++] : { success: true };
    return { v: 1, ok: true, status: 200, data };
  };
  return {
    /** All recorded bridge requests, in order. */
    calls: recorded,
    /** First recorded request (convenience for single-call tests). */
    first: () => recorded[0],
    /** Force the next N attempts to reject (e.g. timeouts, 5xx) before responses resume. */
    rejectNext: (fn: (req: BridgeRequest, attempt: number) => Promise<never> | never, count = 1) => {
      for (let i = 0; i < count; i++) rejects.push(fn);
    },
    /** Script a raw handler for full control (overrides queued responses). */
    implement: (fn: typeof script) => { script = fn; },
  };
}

/** Timeout-shaped rejection for retry tests (GET-only retry path). */
export function bridgeTimeout(): Promise<never> {
  return Promise.reject(
    new RetailCrmHttpError("RetailCRM request timed out after 15000ms", { isTimeout: true }),
  );
}

/** HTTP-error-shaped rejection for retry tests. */
export function bridgeHttpError(status: number, body = ""): Promise<never> {
  return Promise.reject(new RetailCrmHttpError(`RetailCRM HTTP ${status}`, { status, body }));
}

afterEach(() => {
  __setTestBridge(null);
});
