# RetailCRM analytics boundary for PetDog SEO-SXO — acceptance criteria

Status: approved task criteria, written before implementation on 2026-08-21.

## Observable outcome

The read-only RetailCRM MCP exposes a PII-free, pagination-complete analytics
surface that the future PetDog SEO-SXO layer can join with Yandex Metrica
without persisting customer identity.

## Required behavior

1. Register these read-only tools without changing or removing existing tools:
   `retailcrm_attribution_fields`, `retailcrm_orders_analytics`,
   `retailcrm_paid_orders`, `retailcrm_order_attribution`, and
   `retailcrm_order_history_analytics`.
2. `retailcrm_attribution_fields` reads only order custom-field metadata from
   `/custom-fields` and returns code, name, type and entity. It never reads or
   returns order field values. It identifies candidates by an explicit search
   term supplied by the caller; it does not invent PetDog field codes.
3. Every analytics order contains only business-safe fields: CRM order id,
   external id, order number, created/full-paid timestamps, status,
   order method, site, total, currency, native source/medium/campaign,
   RetailCRM's native analytics client label, configured attribution tokens,
   safe item SKU/quantity/revenue/VAT rate, channel classification and a
   pseudonymous join key.
4. Analytics outputs must not contain customer/contact names, phones, email,
   postal/delivery addresses, comments, arbitrary custom fields, API key data,
   user ids, payment comments or product marking codes.
5. The join key is
   `HMAC-SHA256(RETAILCRM_ANALYTICS_HMAC_SECRET, "petdog-order-v1:" + normalized_order_id)`.
   `normalized_order_id` is NFKC-normalized and trimmed, using external id,
   then order number, then CRM id. Analytics order tools fail closed when the
   HMAC secret is absent or shorter than 32 characters. The raw identifier used
   as the basis is not embedded in the join key metadata.
6. Native `order.clientId` is exposed only as `retailcrm_client_id` with source
   label `retailcrm_native_clientId`; it must not be represented as Yandex
   Metrica `client_id`. `client_id`, `yclid` and optional UTM values may be read
   only from caller-configured order custom-field codes. Configuration is a
   canonical-key-to-field-code map; unknown keys, duplicate field codes,
   malformed JSON and unsafe extracted token values fail closed or become
   `null` with an explicit omission reason. There are no guessed default
   custom-field codes.
7. Channel classification is based only on an explicit non-secret mapping of
   observed site/order-method codes to `site`, `phone`, `chat`, `marketplace`
   or `unknown`. Missing mappings return `unknown` and make classification
   completeness explicit; heuristic guessing is forbidden.
8. Order collection follows every `/orders` page until complete or until a
   caller-visible `max_pages`/`max_orders` bound is reached. A stopped result is
   `partial`, includes the reason and a continuation page, and must not label
   aggregate revenue as complete. The default bounds must cover at least 10,000
   orders, so a 3,468-order month is not truncated at 2,000.
9. Paid status codes are obtained from `/reference/payment-statuses` using the
   provider's `paymentComplete` flag only to calculate the known paid amount.
   `paid_at` and whole-order CRM payment evidence use only the non-empty
   `order.fullPaidAt`; payment timestamps and workflow order status are not
   fallbacks. The detailed evidence states and amount semantics are defined by
   `retailcrm-full-paid-evidence-v3.md`.
10. `retailcrm_order_history_analytics` follows the official incremental
    `sinceId` algorithm, returns a PII-free projection, the maximum processed id
    as `next_since_id`, completeness, count and continuation reason. Old/new
    values are emitted only for allowlisted status/payment fields and the safe
    `full_paid_at` transition (string/null only); arbitrary changed values are
    omitted.
11. Legacy `orders_history` finally honors its existing `raw` parameter:
    `raw:true` preserves the explicit legacy raw response; the default returns
    the safe history projection. Existing create/update/list/get behavior and
    read-only tool filtering remain compatible.
12. Results identify period, generated time when supplied by RetailCRM,
    returned count, completeness and continuation. Empty provider arrays are
    valid complete results; malformed pagination or response shapes fail closed.

## Verification requirements

- Focused tests cover: PII-key exclusion recursively; HMAC determinism and
  missing/weak-secret refusal; full pagination beyond 20 pages; partial cursor;
  paymentComplete mapping and paid_at; configured attribution extraction;
  absence of guessed fields; channel-map unknown behavior; `sinceId` history
  continuation; raw/default legacy history behavior; malformed provider shape.
- At least one protection test must be demonstrated RED on exact base
  `a7ab7721c3d96834a4aac821d91f2e2a28ddba86` and GREEN on the candidate.
- Run changed-file lint/typecheck, focused Vitest tests, build and the existing
  repository test suite if the focused gate is green and host limits permit.
- Live API acceptance is separate: metadata inventory first, then one bounded
  date window and history cursor without storing or logging provider payloads.

## Out of scope

- No PetDog website, CS-Cart, Yandex Metrica, Direct, Plerdy, CRM configuration,
  production runtime, API key or customer record is changed.
- No Logs API, marketing MCP or SEO-SXO aggregation code is implemented in this
  repository.
- Existing operational tools that intentionally expose order/customer detail
  are not removed or silently redefined; the new analytics surface is the safe
  boundary for SEO-SXO.
- Commit, push, PR, merge, release, installation and live-provider execution
  require separate authority and evidence.

## Primary contract evidence

- RetailCRM API v5 `/orders`: pagination, `source`, `clientId`, `fullPaidAt`,
  payment timestamps, item VAT and SKU fields.
- RetailCRM API v5 `/orders/history`: `sinceId` is the recommended pagination
  cursor; history values may be mixed and therefore require an allowlist.
- RetailCRM API v5 `/custom-fields`: order-field metadata is available under
  `custom_fields_read` without reading order values.
- RetailCRM API v5 `/reference/payment-statuses`: `paymentComplete` identifies
  statuses representing completed payment.

## Decisions and refutation

- Decision: keep the provider MCP source-specific and place CRM/Metrica
  reconciliation in a later SEO-SXO layer. Refuted if a current repository
  contract already owns cross-provider reconciliation.
- Decision: no default yclid/UTM custom-field names. Refuted only by current
  PetDog RetailCRM metadata or configuration proving exact codes.
- Decision: keep native `order.clientId` distinct from Yandex Metrica
  `client_id`. Refuted only by current PetDog integration evidence proving that
  this exact native field is populated with the Yandex identifier.
- Decision: return `unknown` rather than infer channel from free text. Refuted
  only by a ratified deterministic PetDog code mapping.
