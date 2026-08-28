# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

PII-free SEO-SXO analytics surface (criteria:
`docs/criteria/retailcrm-analytics-sxo-v1.md`).

### Added
- **Five read-only analytics tools** (`retailcrm_attribution_fields`,
  `retailcrm_orders_analytics`, `retailcrm_paid_orders`,
  `retailcrm_order_attribution`, `retailcrm_order_history_analytics`) exposing
  an allowlist-only, PII-free order projection: ids, timestamps, status, order
  method, site, total/currency, native source/medium/campaign,
  `retailcrm_client_id` (native label, never Yandex `client_id`), configured
  attribution tokens, safe item SKU/quantity/revenue/VAT, explicit channel
  classification and an `HMAC-SHA256(RETAILCRM_ANALYTICS_HMAC_SECRET,
  "petdog-order-v1:" + normalized_order_id)` pseudonymous join key. Names,
  phones, emails, addresses, comments, marking codes, user ids and arbitrary
  custom fields are never emitted; order analytics fail closed when the HMAC
  secret is absent or < 32 characters.
- **Complete pagination with explicit bounds.** `/orders` is traversed page by
  page until complete or a caller-visible `max_pages`/`max_orders` bound
  (defaults cover 10,000 orders). Stopped results are `partial` with reason +
  continuation page and never label aggregate revenue complete. Malformed or
  contradictory provider shapes fail closed.
- **`retailcrm_order_history_analytics` uses the official `/orders/history`
  `sinceId` cursor** per docs.retailcrm.ru (WorkingHistoryAPI): the first call
  carries no `sinceId` unless resuming, `page` is never sent (the API rejects
  `sinceId`+`page` with HTTP 400 since 2023-05-15), each follow-up sends only
  `filter[sinceId]` = max processed id, and a non-advancing cursor fails
  closed. Old/new change values are emitted only for allowlisted
  status/payment fields and the safe `full_paid_at` transition (string/null
  only); `next_since_id` resumes the feed.
- Attribution and channel configuration via `RETAILCRM_ANALYTICS_ATTRIBUTION`
  and `RETAILCRM_ANALYTICS_CHANNEL_MAP` (canonical-key-to-code maps; unknown
  keys, duplicate codes, malformed JSON and unsafe tokens fail closed or become
  `null` with an explicit omission reason — nothing is guessed).

### Changed
- **`orders_history` now honors its `raw` parameter** (criteria #11):
  `raw:true` preserves the explicit legacy raw payload; the default returns a
  safe PII-free history projection (allowlisted status/payment changes plus
  the safe `full_paid_at` transition, with the join key omitted rather than
  required when the analytics secret is unconfigured).
  Existing create/update/list/get behavior and read-only tool filtering are
  unchanged.

### Fixed
- **`retailcrm_attribution_fields` scopes its `/custom-fields` request with
  `filter[entity]=order`** so only order metadata is ever requested (never
  other entities' metadata, never field values), and accepts the filtered
  provider shape in which entries omit the `entity` key. Structurally
  malformed metadata still fails closed; explicitly non-order entries are
  skipped.
- **Item projection matches the current OpenAPI** (criterion 3): `vat_rate`
  is the provider's STRING verbatim (previously number-only, silently
  nulling live VAT); item SKU precedence is `offer.externalId` → `xmlId` →
  `article`; item revenue sums EVERY numeric `prices[]` tranche
  (`price*quantity`) and otherwise falls back to
  `(initialPrice - per-unit discountTotal) * quantity` — `prices[0]` alone is
  never used, and malformed numeric material yields null, never a guess.
- **`retailcrm_paid_orders` windows on full-paid time**
  (`filter[fullPaidAtFrom]`/`[fullPaidAtTo]`, `date_basis: full_paid_at`) —
  the tool's business output is paid revenue. `retailcrm_orders_analytics`
  keeps `createdAt` windows (`date_basis: created_at`). Both state their
  basis in the output. Whole-order CRM payment and `paid_at` use only the
  non-empty `order.fullPaidAt`; individually complete payment statuses are
  used only to calculate the known paid amount.
- **History join-key honesty (criterion 5/10):** history records carry no
  order `number`, so without an `orderExternalId` no join key is emitted
  (`join_key: null` + `join_key_omitted_reason: "no_order_external_id"`) —
  the CRM id is never HMAC-ed as though it matched the /orders basis, which
  would have silently false-joined records. ExternalId records keep the
  normal key.
- **History old/new allowlist is `status`, `payments` and safe
  `full_paid_at` only** (criterion 10): `fullPaidAt` is renamed and limited to
  string/null values; `orderMethod`, `site`, `totalSumm` and `currency` do not
  emit old/new values and are omitted entirely.
- **Legacy `orders_history` cursor calls omit `page`**: when
  `filter_since_id` is present the request carries no `page` parameter (the
  official API rejects `sinceId`+`page` with HTTP 400 since 2023-05-15);
  non-cursor raw/date calls keep `page` exactly as before.
- **Prototype-key hardening:** the channel map is null-prototype and channel
  plus configured-custom-field lookups are own-property-only, so inherited
  keys (`"toString"`, `"__proto__"`) can never become channel
  classifications or attribution values.
- **`max_orders`/`max_records` are explicitly page-aligned soft stops**,
  documented in the schema descriptions and each output's `bounds` block
  (`semantics: "page_aligned_soft_stop"`): collection halts before fetching
  another page once the bound is reached, so the final count may overshoot
  by at most one 100-record page — no output claims a hard per-record cap.
  Default capacity (>= 10,000) and honest partial/continuation are
  unchanged.

## [3.1.0] — 2026-08-14

Transport refactor: the RetailCRM API calls now run through the official
`retailcrm/api-client-php` client, pinned exactly to **6.15.32**, invoked from
Node via a PHP bridge. No MCP-facing behavior changed.

### Changed
- **Official PHP client transport.** `retailCrmGet` / `retailCrmPost` in
  `src/client.ts` now delegate to `bin/retailcrm-api.php`, which uses
  `SimpleClientFactory::createClient` (bare origin, no `/api/v5` suffix) with
  `CustomMethods` + `CustomApiMethod` + `RequestMethod` — route stripped of its
  leading slash, flat string parameters preserved exactly. The `X-API-KEY`
  header, shaped output, readonly filtering, rate gate, retry policy
  (3 attempts; 429 always; timeout/5xx GET-only; no ambiguous POST retry),
  `RetailCrmHttpError`, and `formatApiError` exports are unchanged.
- **15-second whole-call timeout preserved** in Node by SIGKILL-ing the bridge
  process; timeouts still surface as `isTimeout` errors for the GET-only retry.
- **Versioned, fail-closed bridge protocol (v1).** JSON over stdin/stdout;
  method/path/domain validation; absolute URLs, traversal, CR/LF, and
  unsupported operations rejected; bounded stderr capture; malformed/empty/
  non-JSON bridge output is always an error, never success. Credentials stay in
  environment variables — never argv, payloads, logs, or errors.
- Package renamed to `retailcrm-mcp` and marked private; version 3.1.0.

### Added
- **Self-contained Docker image** (multi-stage `Dockerfile` on pinned
  major/minor official images): Node build stage, Composer production stage
  (plugins and scripts disabled), and a non-root Node + PHP CLI/cURL runtime
  with only the required artifacts. stdio remains the default entrypoint;
  `--http` args are accepted.
- `composer.json` requiring `retailcrm/api-client-php` exactly `6.15.32` with a
  production-safe configuration (no plugins, no scripts).
- README rewritten for the Docker-first workflow plus an optional local
  Node + PHP + Composer path; upstream MIT attribution preserved.

### Documented compatibility exception
- **`files_upload`** keeps its raw-bytes + `?filename=` behavior because the
  official v6.15.32 `FilesUploadRequest` does not preserve the filename query
  parameter and caller MIME type. It executes inside the PHP bridge with PHP
  cURL — same normalized RetailCRM origin, API key header, 15-second timeout,
  bounded error handling, no credential logging. All other tool traffic uses
  the official client.

### Removed
- `smithery.yaml` (it would have started the unrefactored upstream npm
  package); `.mcp.json` now points at the local Docker command without
  embedding credentials.

## [3.0.0] — 2026-06-23

Production-hardening release. **Breaking**: read tools now return shaped, token-efficient
output by default instead of the raw RetailCRM payload.

### Breaking
- **Shaped output (summary by default).** `list_orders`, `get_order`, `list_customers`,
  `get_customer`, `list_products` now return compact, essential-field views. Pass
  `detail:"full"` for the complete shaped object, or `raw:true` for the untouched
  RetailCRM payload. Lists now include an explicit `pagination` block
  (`page/totalPages/totalCount/returned/hasMore`).
- Tool results no longer pretty-print raw JSON; large nested payloads are projected to
  the fields an agent actually needs (big token reduction).

### Added
- **20+ new tools:** `orders_history`, `update_customer`, `customers_history`,
  `list_product_groups`, `store_inventories`, `order_payment_create/edit/delete`,
  `customer_notes_list/create/delete`, `tasks_list/create/edit`, `list_segments`,
  `list_costs`, `create_cost`, `files_list/get/upload`, and references
  `list_sites`, `list_countries`, `list_order_types`, `list_order_methods`. (39 tools total.)
- **Link existing customers on orders:** `create_order`/`update_order` accept
  `customer_id` / `customer_external_id` instead of always creating an inline customer.
- **`site` parameter** on create/edit tools for multi-site API keys.
- **`RETAILCRM_READONLY=1`** hides all write/destructive tools (query-only deployments).
- Tool `annotations` (`readOnlyHint`, and `destructiveHint` on `merge_customers`) and
  `structuredContent` for forward-compatible clients.
- Optional client-side rate limiter via `RETAILCRM_RATE_LIMIT` (requests/second).
- Raw `application/octet-stream` file upload support in the API client (matches `/files/upload`).

### Changed
- **Auth via `X-API-KEY` header** instead of the `apiKey` URL query string — keeps the
  key out of proxy/CDN/server access logs.
- **Honest, period-scoped analytics.** `get_orders_summary` now sends the date filters
  and aggregates status distribution / revenue / AOV over the window (exact `totalCount`,
  with a `partial` flag), replacing the mislabeled all-time `/orders/statuses/statistic`
  snapshot. `get_customers_summary` returns the period new-customer count.
- Retry logic branches on a typed `RetailCrmHttpError` (numeric `status` + `isTimeout`)
  instead of matching error-message substrings; backoff now has jitter.
- Server version is read from `package.json` (single source of truth) for the MCP
  handshake, `/health`, and startup log.

### Fixed
- **HTTP `--http` transport.** Each `POST /mcp` now gets a fresh `McpServer` + transport
  (stateless isolation) with cleanup on response close; previously one shared server was
  re-`connect()`ed per request, cross-wiring concurrent responses and leaking transports.
  `GET`/`DELETE /mcp` return `405`; errors return a JSON-RPC `500` instead of hanging.
  Optional DNS-rebinding protection (`allowedHosts`).
- CI now runs lint + typecheck + tests on Node 18/20/22 (previously build-only).
- Removed dead, unwired tool modules and a broken, never-run test file.
- Date filters validated as `YYYY-MM-DD`; list `limit` capped at 100.

## [2.0.1] — earlier
- npm discoverability (description, keywords).

## [2.0.0] — earlier
- Production-grade rewrite: 15 tools + 2 prompt skills, stdio + Streamable HTTP.

## [1.1.0] / [1.0.0] — earlier
- Initial releases.

[3.0.0]: https://github.com/theYahia/retailcrm-mcp/releases/tag/v3.0.0
