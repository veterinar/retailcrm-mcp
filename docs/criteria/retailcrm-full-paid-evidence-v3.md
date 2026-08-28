# RetailCRM full-paid evidence contract — acceptance criteria

Status: task criteria, written before implementation on 2026-08-28.

## Existing coverage and correction

`retailcrm-analytics-economics-v2.md` already supplies bounded pagination,
PII-free order projection and paid-order economics. Its current implementation
incorrectly treats any payment whose reference status has
`paymentComplete=true` as proof that the whole order is paid and may copy that
payment's `paidAt` into order-level `paid_at`.

RetailCRM's current documented multi-payment contract identifies
`order.fullPaidAt` as the date of complete order payment and instructs consumers
to use it for the fully-paid state. A payment status marked `paymentComplete`
describes one payment and is retained only for payment-amount evidence.

Primary sources:

- https://help.retailcrm.ru/Developers/From5To6
- https://docs.retailcrm.ru/Users/OperatingActivity/Orders/OrdersList/WorkListOfOrders/FullPaymentDate
- https://help.retailcrm.ru/Developers/ApiVersions

## Observable outcome

Every PII-free order projection distinguishes order-level CRM full payment from
the sum of individually complete payments. Paid-order reports include only
orders proven fully paid by `order.fullPaidAt`; they never upgrade an order from
a payment status, order status or payment timestamp.

## Required behavior

1. Preserve every existing tool name, request parameter, HMAC/join-key rule,
   pagination rule, channel/economics field and PII exclusion.
2. `crm_fully_paid` is true only when `order.fullPaidAt` is a non-empty string.
   `paid_at` is that exact string when present and otherwise `null`. There is no
   fallback from `payments[].paidAt`.
3. `paymentComplete=true` from `/reference/payment-statuses` selects individual
   payments for `crm_paid_amount`; it never determines `crm_fully_paid`.
4. `crm_paid_amount` is the cent-rounded sum of finite non-negative `amount`
   values on every selected complete payment. It is `0` when the payment
   container is absent or contains no complete payments. It is `null` when a
   selected complete payment has a missing, non-finite or negative amount, or
   when the payment container is structurally invalid. Conversion to kopecks
   uses decimal exponent shifting and must fit a safe integer; an amount that
   cannot be represented at safe kopeck precision is `null`. Numeric strings
   are not coerced.
5. `amount_matches` compares safe integer kopecks for `crm_paid_amount` and
   `order.totalSumm` when both amounts are known and safely representable, and
   is otherwise `null`. Overpayment is not silently treated as equality.
6. Each projected order contains `payment_evidence` with
   `crm_fully_paid`, `crm_paid_amount`, `amount_matches`, `evidence_status` and
   explicit sources. `evidence_status` is:
   - `CRM_PAID` when `crm_fully_paid=true`;
   - `PARTIAL` only when `fullPaidAt` is absent and known paid amount is greater
     than zero and lower than a known order total;
   - `UNKNOWN` otherwise.
   `FINANCE_CONFIRMED` is reserved for a downstream bank/cash/provider
   settlement join and is never emitted by this RetailCRM-only MCP.
7. Order workflow/status codes such as `complete`, `paid`, assembly or
   cancellation do not affect payment evidence.
8. `retailcrm_paid_orders` continues to filter the provider window with
   `fullPaidAtFrom`/`fullPaidAtTo`. If that provider-filtered window returns an
   order without a non-empty `fullPaidAt`, the tool fails closed rather than
   publishing a silently reduced or upgraded cohort.
9. The safe order-history projection additionally allowlists only the
   `fullPaidAt` transition as `full_paid_at`, accepting string/null old/new
   values and failing other shapes to `null`. Existing status/payment history
   protection remains unchanged.
10. The analytics envelope reports payment-evidence counts without treating a
    missing amount as zero: `crm_paid`, `partial`, `unknown`,
    `crm_paid_amount_present`, and `amount_matches_present`.
11. No finance confirmation is invented. `FINANCE_CONFIRMED` requires a later
    exact transaction/order identity, amount and time from Sber, cash, courier
    or another settlement source.

## Verification requirements

- A focused regression demonstrates that a complete individual payment without
  `fullPaidAt` is not paid, has `paid_at=null`, and is excluded/rejected by the
  paid-order contract.
- Focused cases cover exact/partial/overpaid/malformed/missing payment amounts,
  the `1.005 -> 1.01` decimal boundary, unsafe kopeck magnitude,
  order-status independence and `fullPaidAt` precedence.
- A history case proves `fullPaidAt` is exposed only as safe
  `full_paid_at`, while unrelated business and PII fields stay omitted.
- The changed focused test must be observed RED on exact base
  `8c9ecf4f5c7872523704c766dda67f60e05c9248` and GREEN on the candidate.
- Run only `src/tools/analytics-sxo.test.ts`, changed-file lint and typecheck;
  do not repeat the full suite without a new concrete risk.

## Out of scope

- No bank, Sber, cash, courier, Ozon or fiscal transaction is read or joined.
- No order, payment, RetailCRM field, API key, CRM configuration, runtime or
  production deployment is changed.
- No historical backfill is performed.
- Commit, push, PR, merge, release and deployment remain separate actions.

## Decisions and refutation

- Decision: `fullPaidAt` is the sole RetailCRM full-payment fact. Refuted only
  by newer primary RetailCRM documentation or live provider evidence that gives
  a different order-level full-payment field.
- Decision: exact cent equality is diagnostic and does not override
  `fullPaidAt`. Refuted if the current provider documents a different amount
  basis required for PetDog orders.
- Decision: finance confirmation remains unavailable in this MCP. Refuted by a
  safe, exact external settlement join added under a separate accepted
  contract.
