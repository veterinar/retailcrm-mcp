# RetailCRM commercial lifecycle candidate receipt

- Repository: `veterinar/retailcrm-mcp`
- Base commit: `68b8f0e296031037da43909e45b7db63fce5ed33`
- Base tree: `857f7633c4bf9ef1a02cbb46c4890644196eb246`
- Branch: `task/retailcrm-commercial-lifecycle-20260828`
- Release version: `3.2.0`

## SDD identity

Acceptance criteria:
`docs/criteria/retailcrm-commercial-lifecycle-v5.md`.

Durable business facts used by the contract:

- cancellations are exact RetailCRM status-group `cancel` facts;
- PetDog currently has cancellations, not proven monetary returns;
- a return is classified only from an explicitly configured positive numeric
  `return_total` value;
- `fullPaidAt` remains the only whole-order CRM payment fact;
- `customFields.sales_channel` remains the only sales-channel fact.

## Authoring evidence

Executable repository bytes were authored in isolated Hermes/Z.AI GLM 5.3
sessions:

- `20260828_225040_f6508d`: focused lifecycle protection tests;
- `20260828_225324_4fe7de`: lifecycle implementation;
- `20260828_230131_b6a054`: correction of one contradictory test fixture
  expectation, without changing the implementation or fixture;
- `20260828_230319_dce7ed`: package version;
- `20260828_230400_499440`: lockfile version metadata;
- `20260828_230451_6438f6`: public tool descriptions.

## RED / GREEN

RED on the exact base: 9 new lifecycle tests failed because `lifecycle`,
`commercial_result` and `commercial_paid_count` did not exist; 43 existing
tests remained green.

GREEN on the candidate:

- focused analytics suite: 52/52;
- TypeScript typecheck: pass;
- ESLint: pass;
- build: pass;
- package/lock version consistency: `3.2.0`;
- `git diff --check`: pass.

The existing `npm ci` audit reported 11 dependency advisories from the accepted
lockfile (2 low, 3 moderate, 5 high, 1 critical). No dependency or lock
resolution was changed as part of this bounded lifecycle task.

Publication, merge and runtime identities are recorded separately after native
GitHub checks and activation of the exact merge build.
