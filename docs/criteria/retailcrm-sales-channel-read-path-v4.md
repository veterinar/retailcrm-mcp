# RetailCRM authoritative sales-channel read path — acceptance criteria

Status: task criteria, written before implementation on 2026-08-28.

## Existing coverage and superseded rule

`retailcrm-analytics-economics-v2.md` classifies the legacy `channel` value from
`orderMethod`, `site`, native `source`, and `delivery.code`. That inference is
no longer authoritative for PetDog and its use of `delivery.code` is explicitly
superseded by this criterion. Delivery remains fulfillment/last-mile evidence;
it is never a sales-channel source.

Live read-only RetailCRM metadata observed on 2026-08-28 confirms the order
custom field `sales_channel` (`dictionary`, entity `order`). The accepted
PetDog contract makes `order.customFields.sales_channel` the sole source of
sales channel for new analytics output. Historical orders are not backfilled.

## Observable outcome

Every PII-free projected order exposes an authoritative `sales_channel` value
read only from its own `customFields.sales_channel`. A missing, empty, malformed,
or unsupported value produces `UNKNOWN`. Delivery and attribution signals
cannot change this result.

## Required behavior

1. Read only the order's own-property `customFields.sales_channel`; inherited
   properties and arbitrary custom fields are never read or returned.
2. Emit exactly one canonical value: `PETDOG_RU`, `OZON`,
   `OTHER_MARKETPLACE`, `B2B`, `B2G`, or `UNKNOWN`.
3. Accept the deployed lowercase dictionary codes (`petdog_ru`, `ozon`,
   `other_marketplace`, `b2b`, `b2g`) and their canonical uppercase spellings;
   emit only the canonical uppercase value.
4. Missing custom fields, a missing field, empty text, non-string values, and
   unrecognised dictionary values all fail closed to `UNKNOWN` with a bounded
   machine-readable reason. The raw unsupported value is never exposed.
5. `delivery.code`, `orderMethod`, `site`, native `source`, UTM, and attribution
   fields never participate in authoritative sales-channel classification.
6. Preserve the existing safe `delivery` projection (`code`, customer charge,
   actual provider cost, VAT evidence) without relabelling it as sales channel.
7. Preserve existing tools and request parameters. The legacy `channel` output
   remains present for consumer compatibility but is derived only from the
   authoritative sales-channel value; it has no delivery fallback. Values that
   the legacy six-value taxonomy cannot represent (`B2B`, `B2G`) map to legacy
   `unknown`, while `sales_channel` retains the authoritative value.
8. Envelope completeness counts authoritative mapped versus `UNKNOWN` sales
   channels. It does not treat delivery-derived legacy mappings as complete.
9. Tool descriptions and criteria identify `sales_channel` as authoritative
   and the legacy `channel` field as compatibility-only.

## Verification requirements

- Demonstrate RED on exact base
  `a33f7587f9e0302aae1dfd23148e6ce9638ad163`: a focused test must show that
  `delivery.code=ozon-seller` can classify an order as Ozon when
  `customFields.sales_channel` is absent.
- Demonstrate GREEN on the candidate for all six canonical values, lowercase
  normalization, missing/invalid values, own-property safety, conflicting
  delivery/site/order-method signals, legacy compatibility, and completeness.
- Run only `src/tools/analytics-sxo.test.ts`, TypeScript typecheck, changed-source
  ESLint, and `git diff --check`. Do not run the full suite without a new risk.

## Measured RED receipt

On the unchanged implementation at base
`a33f7587f9e0302aae1dfd23148e6ce9638ad163`, Vitest 3.2.4 ran the focused
`src/tools/analytics-sxo.test.ts` file under Node 26.0.0. Result: 40 passed and
1 failed. The protection assertion at `analytics-sxo.test.ts:478` expected the
authoritative bounded `sales_channel` projection for an order without the
field, but received `undefined`. This is the intended functional RED; the
other 40 focused assertions remained green.

## Out of scope

- No RetailCRM field, dictionary, order, or historical value is created,
  changed, or backfilled.
- No PetDog storefront producer, Ozon integration, Direct campaign, runtime,
  deployment, Vault, or QMD state is changed.
- No commit, push, pull request, merge, release, or production deployment is
  authorised by this task.

## Decisions and refutation

- Decision: preserve the legacy `channel` field as a derived compatibility
  projection instead of silently removing it. Refuted by a current consumer
  contract requiring immediate removal rather than migration.
- Decision: accept lowercase deployed codes and canonical uppercase aliases.
  Refuted by current RetailCRM dictionary metadata proving a different closed
  value set.
