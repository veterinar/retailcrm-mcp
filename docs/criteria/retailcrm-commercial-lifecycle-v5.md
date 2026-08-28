# RetailCRM commercial lifecycle classification — acceptance criteria

Status: task criteria, written before implementation on 2026-08-28.

## Decision and scope

Browser `purchase` is an order-creation event and cannot know a later CRM
cancellation. Commercial analytics therefore classifies the current order
lifecycle from RetailCRM evidence and exposes a separate commercial result.
It does not rewrite raw Metrika events and does not infer a return from a
cancellation.

Current PetDog fact on 2026-08-28: actual order statuses include a provider
group `cancel`; PetDog reports no returns in the observed window. The return
class is retained for future explicit monetary evidence and must remain zero
when that evidence is absent.

## Required behavior

1. Analytics reads `/reference/statuses` and builds an exact status-code to
   group map. A malformed container, entry, code, or group fails closed before
   publishing analytics.
2. Every projected order contains `lifecycle` with:
   `class`, `commercial_included`, `status_code`, `status_group`, `basis`, and
   `omitted_reason`.
3. The only classes are `INCLUDED`, `CANCELLED`, `RETURNED`, and `UNKNOWN`.
4. `RETURNED` requires an exact configured finite numeric `return_total > 0`.
   It is separate from cancellation and has precedence when both signals exist.
5. `CANCELLED` requires the order's exact status code to map to provider group
   `cancel`. It is never inferred from status text, delivery, payment, item
   `isCanceled`, or a missing payment.
6. A status mapped to any non-`cancel` provider group is `INCLUDED`.
   A missing/unsupported status or missing reference mapping is `UNKNOWN` and
   fails closed with `commercial_included=false`.
7. The existing operational `totals` and `count` remain backward-compatible.
   A new `commercial_result` is the only profit/revenue-ready surface and
   excludes `CANCELLED`, `RETURNED`, and `UNKNOWN` orders.
8. `commercial_result` reports included/cancelled/returned/unknown counts,
   included revenue, returned amount, amount completeness, and `publishable`.
   It is publishable only when traversal is complete, no lifecycle is UNKNOWN,
   and every INCLUDED order has a known total. Missing amounts are never zero.
9. `retailcrm_paid_orders` keeps `paid_count` as the number of CRM-full-paid
   orders for compatibility and adds `commercial_paid_count` for INCLUDED
   orders only.
10. PII allowlisting, `fullPaidAt` payment evidence, authoritative
    `customFields.sales_channel`, COGS, delivery and pagination behavior remain
    unchanged.

## Verification

- A focused test is RED on exact base
  `68b8f0e296031037da43909e45b7db63fce5ed33` because lifecycle and
  `commercial_result` are absent.
- GREEN proves: provider cancel groups are excluded; non-cancel groups are
  included; explicit positive return amount is RETURNED; missing mappings are
  UNKNOWN; returns are zero/absent when not present; malformed references fail
  closed; operational totals remain unchanged; commercial totals exclude all
  non-included classes.
- Run the affected Vitest file, typecheck, lint, and native GitHub CI on the
  exact published head.

## Runtime acceptance

Deploy the exact merge commit to the registered RetailCRM MCP runtime, restart
only that service, read back `/health` version/tool count, and run a bounded
PII-free canary. The canary must show `CANCELLED` rows excluded from
`commercial_result`, no fabricated `RETURNED` rows, and current sales-channel
and payment-evidence fields still present.

## Rollback

Restore the previous immutable runtime directory and launcher target, restart
only the RetailCRM MCP service, then read back its former health identity.
