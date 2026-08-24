# RetailCRM paid-order economics and channel contract — acceptance criteria

Status: task criteria, written before implementation on 2026-08-24.

## Existing coverage and reason for this criterion

`retailcrm-analytics-sxo-v1.md` already requires PII-free order projection,
explicit attribution configuration, deterministic channel mapping, complete
pagination and an explicit partial result. This v2 criterion extends that
accepted surface with PetDog's paid-order economics and six-value channel
taxonomy.

Criterion correction recorded 2026-08-24 after exact review: the original last
sentence of this paragraph said v2 did not replace any v1 behavior. That was
too broad. V2 deliberately supersedes the single legacy output value
`marketplace` with `other_marketplace`; the legacy configuration input remains
accepted and is normalized immediately. Tools and request parameters remain
backward compatible, but consumers matching the old output value require a
one-time migration.

## Observable outcome

The existing read-only analytics tools return enough safe evidence to reconcile
each fully paid RetailCRM order on its HMAC join key, classify its channel, and
calculate only the portions of order economics that are actually present in the
provider payload or explicitly configured numeric order fields.

## Required behavior

1. Preserve all existing tools and request parameters. Existing unprefixed
   channel-map keys remain accepted for compatibility.
2. The canonical channel values are `site`, `phone`, `chat`, `ozon`,
   `other_marketplace`, and `unknown`. Every projected order has exactly one of
   those values.
3. `RETAILCRM_ANALYTICS_CHANNEL_MAP` additionally accepts namespaced keys
   `order_method:<code>`, `site:<code>`, `source:<code>`, and
   `delivery:<code>`. Classification checks these sources in that order,
   reports the selected basis, and returns `unknown` when nothing matches.
   Free-text guessing is not allowed.
4. Each item may expose only `sku`, `quantity`, realized `revenue`, raw
   `vat_rate`, `purchase_price`, calculated `cogs`, and `cancelled`. COGS is
   `purchase_price * quantity` when both provider values are finite and
   non-negative; otherwise it is `null`. Product names, marking codes and other
   provider item fields remain excluded.
5. Each order may expose only the safe delivery fields `code`, customer charge
   `cost`, actual provider cost `net_cost`, and raw `vat_rate`. Address,
   recipient, service object and comments remain excluded.
6. Optional order economics use
   `RETAILCRM_ANALYTICS_ECONOMICS`, an explicit canonical-key-to-custom-field
   map. The only allowed keys are `outside_mkad_surcharge`,
   `commission_total`, and `return_total`. Values are accepted only when the
   configured order field contains a finite non-negative number. There are no
   guessed field codes or values.
7. Each order exposes an `economics` object containing item COGS total,
   delivery actual cost, the three optional configured amounts, a
   `known_costs_total`, and a completeness block. Missing components remain
   `null`; they are never silently treated as zero. The order total, items,
   delivery and `paid_at` remain on the same HMAC order grain.
8. Product VAT is evidence, not a correction mechanism. The projection keeps
   the provider's exact VAT string and labels each item `accepted_10_22`,
   `missing`, or `unexpected`. Only representations that unambiguously mean
   10% or 22% are accepted for PetDog economics; unexpected values are not
   coerced.
9. Pagination returns `pages_fetched`, `publication_status` (`complete` or
   `partial`) and the existing continuation. A partial collection keeps its
   bounded observed subtotal for diagnosis but marks both the envelope and
   totals as non-publishable. No partial result may carry a complete revenue
   scope.
10. Envelope completeness reports counts for mapped/unknown channels, complete
    item COGS, accepted item VAT, present delivery actual cost, and present
    optional economics components. These counts never imply missing values are
    zero.
11. The existing attribution allowlist remains unchanged. Current PetDog
    metadata observed on 2026-08-24 contains the order field
    `rs_metrika_client_id`; yclid and UTM order fields were not found. Source
    code therefore does not invent defaults or hard-code that observed field.

## Verification requirements

- A focused regression test covers namespaced channel precedence and all six
  canonical values.
- A focused regression test covers COGS, safe delivery, optional numeric
  economics, VAT status and recursive PII exclusion.
- A focused pagination test proves a bounded result is partial and
  non-publishable, while a traversed result is complete and publishable.
- At least one of these checks is demonstrated RED on exact base
  `9e0a7056003e238dd515a7378463a0b0f073f412` and GREEN on the candidate.
- Run only the affected Vitest file plus changed-file lint/typecheck; do not
  repeat the previously accepted full suite without a new concrete risk.

## Out of scope

- No PetDog site, Ecommerce/dataLayer payload, purchase/begin_checkout trigger,
  CRM record, custom-field configuration, API key, runtime or production system
  is changed.
- The MCP cannot recover yclid/UTM/category/VAT/COGS/commission/return data that
  the producer or RetailCRM did not store.
- `isCanceled` is exposed as item evidence but is not reclassified as a monetary
  return. A return amount is available only from an exact configured numeric
  field.
- No advertising-cost allocation or Direct ROI is calculated in this provider
  repository.
- Commit, push, PR, merge, release and deployment are separate actions.

## Decisions and refutation

- Decision: use `delivery.netCost` as the provider's actual delivery-cost
  evidence and keep `delivery.cost` as the customer charge. Refuted by current
  RetailCRM API/client evidence showing different field meanings.
- Decision: preserve partial subtotals but make them explicitly non-publishable.
  Refuted if a current consumer cannot distinguish the new publication flags;
  in that case the consumer must fail closed rather than infer completeness.
- Decision: optional economics are configured exact numeric order fields.
  Refuted by a current safe RetailCRM endpoint that supplies those amounts on
  the order grain without PII or N+1 provider calls.
- Provider-field evidence: the official RetailCRM PHP API client example
  observed on 2026-08-24 uses `OrderProduct.purchasePrice` and
  `SerializedOrderDelivery.netCost`; the live read-only delivery-type reference
  also exposed `vatRate`. These names are therefore provider-contract evidence,
  not guessed local aliases. The projection still fails closed to `null` when
  an order payload omits them.
