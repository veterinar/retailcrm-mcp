# RetailCRM customFields live-array compatibility

## Observed defect

On 2026-08-21 the live read-only `GET /api/v5/custom-fields` response for
`filter[entity]=order` returned `customFields` as an array of nine metadata
records. The merged `retailcrm_attribution_fields` handler accepted only an
object map and returned `RetailCRM /custom-fields response is malformed`.
No field values or customer data were inspected to establish this shape.

## Acceptance criteria

1. `retailcrm_attribution_fields` accepts the live array form and returns only
   `code`, `name`, `type`, and the fixed `entity: order` marker.
2. The existing object-map response form remains accepted for compatibility.
3. Search remains case-insensitive across code and name, and the request stays
   scoped with `filter[entity]=order`.
4. Explicitly non-order entries are skipped; malformed containers or entries
   still fail closed.
5. A focused test is observed RED on commit
   `2a967afe6e800cbc58da1ba095397598d4dab30d` and GREEN on the candidate. No
   full-suite repetition is required for this isolated parser correction.
6. The rebuilt Docker image passes one live read-only MCP call to
   `retailcrm_attribution_fields` without exposing field values or customer
   data.

## Out of scope

- Changing RetailCRM API permissions, custom-field definitions, or values.
- Changing order, payment, history, pagination, HMAC, or attribution mapping
  behaviour.
- Any mutation of `petdog.ru`, RetailCRM records, or production databases.

## Decision and refutation

Support both array and object-map containers because the live provider shape
contradicts the former object-only assumption while tests and older responses
may still use a keyed map. This decision is refuted if current official
RetailCRM schema and a fresh live shape check both establish one different,
exclusive container contract.
