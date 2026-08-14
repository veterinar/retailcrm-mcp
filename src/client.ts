import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TIMEOUT = 15_000;
const MAX_RETRIES = 3;

// Bridge protocol version. Node and the PHP bridge must agree on this; the
// bridge refuses unknown versions (fail-closed), and so do we.
const BRIDGE_PROTOCOL_VERSION = 1;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

// Optional client-side rate limiter (RetailCRM throttles bursts → HTTP 503).
// Disabled unless RETAILCRM_RATE_LIMIT (requests/second) is set. v5 allows 10 req/s per IP.
const RATE_LIMIT = Number(process.env.RETAILCRM_RATE_LIMIT) || 0;

function getBridgeCommand(): { php: string; script: string } {
  const php = process.env.RETAILCRM_PHP_BIN || "php";
  const script =
    process.env.RETAILCRM_PHP_BRIDGE ||
    fileURLToPath(new URL("../bin/retailcrm-api.php", import.meta.url));
  return { php, script };
}

/**
 * Typed error carrying the numeric HTTP status and a timeout flag, so the retry
 * logic can branch on structured fields instead of re-parsing message strings.
 */
export class RetailCrmHttpError extends Error {
  readonly status: number;
  readonly isTimeout: boolean;
  readonly body?: string;
  constructor(message: string, opts: { status?: number; isTimeout?: boolean; body?: string } = {}) {
    super(message);
    this.name = "RetailCrmHttpError";
    this.status = opts.status ?? 0;
    this.isTimeout = opts.isTimeout ?? false;
    this.body = opts.body;
  }
}

interface RetailCrmErrorResponse {
  success: boolean;
  errorMsg?: string;
  errors?: Record<string, string> | string[];
}

export function formatApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as RetailCrmErrorResponse;
    const parts: string[] = [`RetailCRM HTTP ${status}`];
    if (parsed.errorMsg) parts.push(parsed.errorMsg);
    if (parsed.errors) {
      if (Array.isArray(parsed.errors)) {
        parts.push(parsed.errors.join("; "));
      } else {
        parts.push(Object.entries(parsed.errors).map(([k, v]) => `${k}: ${v}`).join("; "));
      }
    }
    return parts.join(" — ");
  } catch {
    return `RetailCRM HTTP ${status}: ${body.slice(0, 500)}`;
  }
}

/**
 * Retry policy. HTTP 429 means the server rejected the request BEFORE processing,
 * so it is always safe to retry. Timeouts and 5xx are ambiguous for mutations (the
 * write may have committed), so they are retried ONLY for idempotent (GET) requests.
 */
function isRetryable(error: unknown, idempotent: boolean): boolean {
  if (!(error instanceof RetailCrmHttpError)) return false;
  if (error.status === 429) return true;
  if (!idempotent) return false;
  return error.isTimeout || (error.status >= 500 && error.status <= 599);
}

async function withRetry<T>(fn: () => Promise<T>, idempotent: boolean): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryable(error, idempotent)) throw error;
      // Exponential backoff with jitter to avoid thundering-herd on shared throttles.
      const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const delay = base + Math.floor(Math.random() * 250);
      console.error(`[retailcrm-mcp] Retrying in ${delay}ms (${attempt}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("RetailCRM: all retries exhausted");
}

// ── Optional rate limiter ────────────────────────────────────
let lastCall = 0;
async function rateGate(): Promise<void> {
  if (RATE_LIMIT <= 0) return;
  const minInterval = 1000 / RATE_LIMIT;
  const now = Date.now();
  const wait = lastCall + minInterval - now;
  lastCall = Math.max(now, lastCall + minInterval);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// ── PHP bridge (official retailcrm/api-client-php 6.15.32) ───
type BridgeOp = "get" | "post" | "post_raw";

export interface BridgeRequest {
  v: number;
  op: BridgeOp;
  path: string;
  params?: Record<string, string>;
  body_base64?: string;
  content_type?: string;
}

export interface BridgeResponse {
  v?: number;
  ok?: boolean;
  status?: number;
  data?: unknown;
  body?: string;
  error?: string;
}

/**
 * Test-only injection seam for the PHP bridge. Vitest sets VITEST in the worker
 * environment; anywhere else installation is refused, so production always
 * spawns the real bridge process. Handlers receive the exact bridge request and
 * must return a protocol-conformant response (validated fail-closed below) or
 * throw — e.g. a RetailCrmHttpError to simulate HTTP failures/timeouts.
 */
export type BridgeHandler = (request: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>;

let testBridgeHandler: BridgeHandler | null = null;

export function __setTestBridge(handler: BridgeHandler | null): void {
  if (!process.env.VITEST) {
    throw new Error("RetailCRM bridge test injection is refused outside Vitest");
  }
  testBridgeHandler = handler;
}

/**
 * Fail fast when required credentials are absent — before any bridge spawn.
 * Mirrors the env checks the PHP bridge performs, so misconfiguration surfaces
 * deterministically regardless of host PHP availability.
 */
function ensureBridgeEnv(): void {
  if (!process.env.RETAILCRM_API_KEY) throw new Error("RETAILCRM_API_KEY is not set. Create one in RetailCRM > Settings > Integration > API keys");
  if (!process.env.RETAILCRM_DOMAIN && !process.env.RETAILCRM_URL) throw new Error("RETAILCRM_DOMAIN is not set. Set it to your RetailCRM domain (e.g. yourstore.retailcrm.ru)");
}

/**
 * Shared fail-closed validation of a bridge response object. Returns the
 * response data on success; throws RetailCrmHttpError for {ok:false} responses
 * and a plain Error for protocol violations. Used by both the child-process
 * path and the test seam, so injected mocks cannot bypass protocol rules.
 */
function validateBridgeResponse(parsed: unknown, stderrNote: string): unknown {
  if (
    parsed === null || typeof parsed !== "object" ||
    ((parsed as BridgeResponse).v !== BRIDGE_PROTOCOL_VERSION) ||
    typeof (parsed as BridgeResponse).ok !== "boolean"
  ) {
    throw new Error(`RetailCRM bridge protocol violation${stderrNote}`);
  }
  const response = parsed as BridgeResponse;
  if (!response.ok) {
    const status = typeof response.status === "number" ? response.status : 0;
    const body =
      typeof response.body === "string"
        ? response.body
        : JSON.stringify({ success: false, errorMsg: response.error ?? "bridge error" });
    throw new RetailCrmHttpError(formatApiError(status, body), { status, body });
  }
  return response.data;
}

/**
 * One bridge attempt. The whole call (spawn → response) is capped at TIMEOUT by
 * SIGKILL-ing the PHP process, which preserves the previous 15-second whole-call
 * timeout semantics. A malformed, empty, or non-JSON bridge response is ALWAYS an
 * error — never a success. Credentials travel only via environment variables
 * (inherited by the child); they never appear in argv, the JSON payload, or logs.
 */
function invokeBridge(request: BridgeRequest, idempotent: boolean): Promise<unknown> {
  ensureBridgeEnv();
  return withRetry(async () => {
    await rateGate();
    // Test-only seam: when installed (Vitest refuses installation elsewhere),
    // exercise the same fail-closed protocol validation as the real process.
    if (testBridgeHandler) {
      return validateBridgeResponse(await testBridgeHandler(request), "");
    }
    return await new Promise<unknown>((resolve, reject) => {
      const { php, script } = getBridgeCommand();
      const child = spawn(php, [script], { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = Buffer.alloc(0);
      let stderr = "";
      let overflowed = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, TIMEOUT);

      const finish = (err?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
          overflowed = true;
          child.kill("SIGKILL");
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_STDERR_BYTES);
      });

      child.on("error", (err: Error) => {
        finish(new Error(`RetailCRM bridge failed to start: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        if (timedOut) {
          finish(new RetailCrmHttpError(`RetailCRM request timed out after ${TIMEOUT}ms`, { isTimeout: true }));
          return;
        }
        const text = stdout.toString("utf8").trim();
        // Never surface the API key, even if the bridge leaked it to stderr.
        const apiKey = process.env.RETAILCRM_API_KEY ?? "";
        const safeStderr = apiKey ? stderr.trim().split(apiKey).join("[redacted]") : stderr.trim();
        const stderrNote = safeStderr ? ` (bridge stderr: ${safeStderr.slice(0, 256)})` : "";
        if (overflowed || code !== 0 || text === "") {
          finish(new Error(`RetailCRM bridge failed (exit ${code ?? "unknown"})${stderrNote}`));
          return;
        }
        // The bridge must emit exactly one JSON line. Multiple non-empty lines
        // mean unexpected output interleaved with the response — reject.
        const lines = text.split("\n").filter(l => l.trim() !== "");
        if (lines.length !== 1) {
          finish(new Error(`RetailCRM bridge returned ${lines.length} output lines, expected exactly 1${stderrNote}`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(lines[0]) as BridgeResponse;
        } catch {
          finish(new Error(`RetailCRM bridge returned malformed JSON${stderrNote}`));
          return;
        }
        try {
          finish(undefined, validateBridgeResponse(parsed, stderrNote));
        } catch (err) {
          finish(err);
        }
      });

      // EPIPE is handled by the close event; ignore stdin write errors.
      child.stdin.on("error", () => {});
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end();
    });
  }, idempotent);
}

export async function retailCrmGet(path: string, params?: Record<string, string>): Promise<unknown> {
  return invokeBridge({ v: BRIDGE_PROTOCOL_VERSION, op: "get", path, params }, true);
}

export async function retailCrmPost(path: string, formData: Record<string, string>): Promise<unknown> {
  // mutation: do not retry on timeout/5xx (may have committed)
  return invokeBridge({ v: BRIDGE_PROTOCOL_VERSION, op: "post", path, params: formData }, false);
}

/**
 * Raw-body POST for endpoints that take the payload directly (e.g. /files/upload,
 * which expects the file bytes under Content-Type: application/octet-stream — NOT
 * multipart/form-data). Documented compatibility exception: the official client's
 * FilesUploadRequest does not preserve the filename query parameter and caller
 * MIME type, so the bridge executes this op with PHP cURL directly.
 */
export async function retailCrmPostRaw(
  path: string,
  body: Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<unknown> {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return invokeBridge(
    {
      v: BRIDGE_PROTOCOL_VERSION,
      op: "post_raw",
      path,
      body_base64: bytes.toString("base64"),
      content_type: contentType,
    },
    false,
  );
}
