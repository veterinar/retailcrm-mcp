import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise the actual PHP protocol/error boundary without credentials or network.
const secret = "test-only-key-not-for-output";
const contact = "private-fixture@example.invalid";
let root: string;
let bridge: string;
beforeAll(() => {
  root = mkdtempSync(join(process.env.CODEX_TASK_TMPDIR ?? tmpdir(), "retailcrm-bridge-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "vendor"));
  bridge = join(root, "bin", "retailcrm-api.php");
  copyFileSync(fileURLToPath(new URL("../bin/retailcrm-api.php", import.meta.url)), bridge);
  writeFileSync(join(root, "vendor", "autoload.php"), `<?php
namespace RetailCrm\\Api\\Enum { class RequestMethod { const GET = 'GET'; const POST = 'POST'; } }
namespace RetailCrm\\Api\\Component { class CustomApiMethod { public function __construct($method, public string $route) {} } }
namespace RetailCrm\\Api\\Interfaces { interface ApiExceptionInterface { public function getStatusCode(): int; } }
namespace Fixture {
  class ApiFailure extends \\RuntimeException implements \\RetailCrm\\Api\\Interfaces\\ApiExceptionInterface {
    public function __construct(private int $status) { parent::__construct('${secret} ${contact}'); }
    public function getStatusCode(): int { return $this->status; }
  }
  class Methods {
    private string $route;
    public function register($name, $method) { $this->route = $method->route; }
    public function call($name, $params) {
      if ($this->route === 'ok') return ['success' => true, 'orders' => []];
      if ($this->route === 'error400') throw new ApiFailure(400);
      if ($this->route === 'error404') throw new ApiFailure(404);
      throw new \\UnexpectedValueException('${secret} ${contact}');
    }
  }
  class Client { public $customMethods; public function __construct() { $this->customMethods = new Methods(); } }
}
namespace RetailCrm\\Api\\Factory { class SimpleClientFactory { public static function createClient($origin, $key) { return new \\Fixture\\Client(); } } }
`);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function request(path: string) {
  const result = spawnSync(process.env.RETAILCRM_PHP_BIN ?? "php", [bridge], {
    input: JSON.stringify({ v: 1, op: "get", path, params: {} }) + "\n",
    env: { ...process.env, RETAILCRM_DOMAIN: "test.invalid", RETAILCRM_API_KEY: secret },
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(result.stdout + result.stderr).not.toContain(contact);
  return JSON.parse(result.stdout);
}

describe("PHP bridge error boundary", () => {
  it("preserves a successful SDK response", () => {
    expect(request("/ok")).toMatchObject({ v: 1, ok: true, status: 200, data: { success: true, orders: [] } });
  });
  it.each([400, 404])("preserves API HTTP %i without free-form provider data", status => {
    expect(request(`/error${status}`)).toMatchObject({ v: 1, ok: false, status });
  });
  it("reports unexpected SDK exceptions safely instead of an opaque fatal", () => {
    expect(request("/unexpected")).toMatchObject({ v: 1, ok: false, status: 0, body: expect.stringMatching(/bridge exception UnexpectedValueException at autoload\.php:\d+/) });
  });
});
