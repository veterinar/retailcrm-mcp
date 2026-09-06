---
sdd:
  version: 1
  class: privileged
  mode: integration
  reasons:
    - cross_system
    - published_contract
    - deploy
    - runtime_mutation
  base: "6b62f791818fae8a50e732382c00c23dca22390c"
  acceptance:
    - AC-1
    - AC-2
    - AC-3
    - AC-4
    - AC-5
  authority:
    implementation: granted
    publication: granted
    runtime: granted
---

# RetailCRM → paid-profit ingestion compatibility — v6

Brownfield strategy: `living-spec`. This criterion adds only the missing
consumer boundary. Payment, sales-channel and lifecycle truth remain owned by
`retailcrm-full-paid-evidence-v3.md`,
`retailcrm-sales-channel-read-path-v4.md` and
`retailcrm-commercial-lifecycle-v5.md`; their rules are not duplicated here.

## Outcome

The PII-free RetailCRM analytics order can be consumed by the PetDog
paid-profit mapper without renaming or inventing facts: full-payment time has a
canonical `full_paid_at` field, the public legacy `paid_at` remains compatible,
the payment provider is emitted only when completed RetailCRM payments
prove one configured provider, and the SBER payment base
(`sber_paid_amount_rub`) plus the customer-paid delivery amount
(`delivery_income_rub`) are exposed as payment evidence — never as fee,
COGS or profit arithmetic.

## Producer and consumer identity

- Producer: `veterinar/retailcrm-mcp` base
  `6b62f791818fae8a50e732382c00c23dca22390c`.
- Consumer evidence: `Pet-dog/petdog-seo-reports` local commit
  `43b4debdaf879914fbdabb5574a9efd9e363c00d`,
  `tools/paid-profit/paid-profit.mjs` SHA-256
  `bbde980f8d0bd64e80f064e5efae4755724577c2a0401a2e444d9ff74fa0907d`.
- Shared order grain: the existing HMAC `join_key`; no raw customer identity is
  added.

## Versions and contract

### ADDED

- Every projected analytics order has `full_paid_at: string | null` sourced
  only from non-empty `order.fullPaidAt`.
- Every projected analytics order has a canonical `payment_provider` from the
  closed set `SBER / OZON / CASH / OTHER / UNKNOWN`.
- `RETAILCRM_ANALYTICS_PAYMENT_PROVIDER_MAP` is an optional explicit JSON map
  from exact RetailCRM payment type codes to the closed provider set. Missing
  configuration is valid and yields `UNKNOWN`.
- Every projected analytics order has `sber_paid_amount_rub: number | null`:
  the existing safely calculated `crm_paid_amount` emitted only when
  `payment_provider === "SBER"`; otherwise `null`. It is non-null only when
  every selected completed payment is explicitly mapped to SBER and every
  selected amount is valid. No acquiring fee (e.g. the 1.8%) is calculated.
- Every projected analytics order has `delivery_income_rub: number | null`:
  `delivery.cost` — the customer charge — copied only when the existing safe
  delivery projection accepted a finite non-negative number; otherwise `null`.
  It is never derived from `totalSumm`, `netCost`, delivery type or defaults.

### MODIFIED

- Tool documentation identifies `full_paid_at` as canonical for downstream
  ingestion and `paid_at` as a compatibility alias, and documents the
  `sber_paid_amount_rub` / `delivery_income_rub` evidence rules.

### REMOVED

- Nothing.

### UNCHANGED

- `crm_fully_paid` is still determined only by `order.fullPaidAt`.
- `paymentComplete=true` still selects individual completed payments; order
  status never proves payment.
- `sales_channel` is still read only from
  `order.customFields.sales_channel`; delivery remains fulfillment evidence.
- A cancellation is still `CANCELLED`, never a return. A return still requires
  explicit positive return evidence.
- RetailCRM MCP projects evidence only. It performs no COGS, acquiring,
  advertising or contribution arithmetic: `sber_paid_amount_rub` and
  `delivery_income_rub` are evidence copies, and the SBER acquiring fee is
  never calculated here.
- Existing tool names, request parameters, pagination, HMAC and PII exclusions
  remain compatible.

## Payment-provider evidence

Provider classification considers only payments whose exact status belongs to
the `/reference/payment-statuses` set with `paymentComplete=true`. The
payments container must be a record; every entry must be a plain non-array
object with an OWN string `status` (inherited or prototype `status` is
malformed, never evidence). Valid non-completed entries are ignored. Every
completed entry must have an OWN exact non-empty mapped string `type`
(inherited `type` is never evidence). One or more selected payments all
mapping to the same provider prove that provider. A malformed container or
entry (including a malformed sibling beside one valid completed payment), a
missing completed payment, missing/unmapped types, or more than one mapped
provider yield `UNKNOWN`; no order-status, site, channel, delivery or
free-text fallback is allowed. Absent configuration is valid and yields
`UNKNOWN`; malformed configuration is rejected before any bridge call. Raw
unrecognised type values are not emitted.

## Retries, timeouts and idempotency

The change adds no provider request, retry or timeout. Projection is a pure
function of the existing `/orders` payload, payment-status reference and
process configuration. Replaying the same inputs produces the same fields.

## Partial failures

Malformed configuration fails closed before an order query. Missing or
ambiguous order-level provider evidence yields `UNKNOWN` without changing
payment or lifecycle classification. Existing malformed provider-response and
pagination failures remain unchanged.

## Compatibility and rollback

`paid_at` remains byte-equal to `full_paid_at` for every order, so existing
consumers continue to work. Rollback is the previous immutable runtime image;
no CRM record or schema migration is required. Runtime activation changes only
the registered RetailCRM MCP image identity and preserves its secret/env-file
references.

## Acceptance criteria

- **AC-1.** A projected order with non-empty `order.fullPaidAt` exposes the
  exact value as both `full_paid_at` and compatibility `paid_at`; absent/empty
  evidence makes both `null`, and payment/order statuses cannot populate them.
- **AC-2.** Completed payments with exact configured payment types mapping to
  one provider expose that canonical `payment_provider`; absent, malformed,
  unmapped or mixed evidence exposes `UNKNOWN` without leaking raw types.
  Additionally, `sber_paid_amount_rub` equals the safely calculated
  `crm_paid_amount` only when `payment_provider === "SBER"` and is otherwise
  `null`; `delivery_income_rub` equals the safe finite non-negative
  `delivery.cost` and is otherwise `null`; neither field performs fee, COGS or
  profit arithmetic and neither uses any fallback.
- **AC-3.** `sales_channel` remains authoritative from
  `customFields.sales_channel`, cancellation remains distinct from return, and
  the MCP adds no paid-profit arithmetic.
- **AC-4.** Existing analytics tools, parameters, pagination, HMAC and recursive
  PII protections remain compatible; malformed provider-map configuration
  fails before any bridge call.
- **AC-5.** The exact merged tree is activated as the canonical RetailCRM MCP
  runtime, read back by immutable image/revision identity, and a bounded
  read-only canary confirms the new fields while retaining the previous image
  as rollback.

## Measured RED requirement

On exact base `6b62f791818fae8a50e732382c00c23dca22390c`, one focused protection test
must fail because projected orders do not expose `full_paid_at` or
`payment_provider`. Only after that RED is recorded may implementation bytes be
written. The focused test is then rerun once on changed bytes for GREEN.

## Out of scope

- PetDog website, browser purchase events and server-side purchase idempotency.
- Paid-profit formulas, campaign spend allocation, Ozon pagination or graph
  registry/Vault repair.
- RetailCRM order mutation, custom-field creation or historical backfill.
- Guessing a provider from an order status, payment timestamp, sales channel,
  site, delivery, payment label or payment type spelling.

## Errors and failure states

Unknown configuration keys/values and unsafe payment type codes are rejected.
Order-level absence or ambiguity is data incompleteness and produces
`UNKNOWN`, not a fabricated provider and not a failed order query.

## What would show this decision is wrong

A current consumer contract that accepts a structured provider object instead
of the required canonical string, or current RetailCRM primary evidence that
`payments[].type` is not the payment-type code, would require an explicit
contract revision before implementation.
