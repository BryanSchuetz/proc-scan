# Source Integration Guide

Use this guide to add one procurement Source without reimplementing shared classification, persistence, or change detection. The machine-readable scoring source of truth is [`config/addressability.yaml`](config/addressability.yaml); the policy-level contract and full term lists are documented in [`CONTEXT.md`](CONTEXT.md#addressability-scoring-contract).

## Processing boundary

Each Source adapter discovers and normalizes candidates. The shared pipeline owns everything after normalization:

```text
Source API/feed
    -> SourceAdapter.scan()
    -> SourceCandidate[]
    -> shared identity, inheritance, and change detection
    -> Technical Area Classification
    -> Addressability Assessment
    -> retain or exclude in D1
```

Do not score, persist, or infer a Modification merely because a record was rediscovered inside an adapter. Map an explicit Source amendment or cancellation when available; otherwise [`runSourceAdapter`](src/pipeline/run-source.ts) and [`processCandidate`](src/pipeline/process-candidate.ts) own change detection and downstream decisions.

## Addressability scoring

The same fit-scoring model applies to every Source and Client. Assessment is deterministic and runs in this order:

1. Apply hard exclusions. A matching event is **Excluded**, is not fit-scored, and is not retained.
2. Give every remaining event the `inclusive-baseline` score of +2.
3. Add +2 once if the title or description contains one or more configured `dai-fit-terms`.
4. Subtract 2 once if the title or description contains one or more configured `miss-fit-terms`.
5. A final score of 2 or more is **Addressable** (Marked); a lower score is **Uncertain** (Unmarked).

| DAI-Fit | Miss-Fit | Score | Retained outcome |
| --- | --- | ---: | --- |
| No | No | 2 | Addressable |
| Yes | No | 4 | Addressable |
| No | Yes | 0 | Uncertain |
| Yes | Yes | 2 | Addressable |

Term matching is case-insensitive substring matching over `opportunityName` and `description`. A category contributes only once even when multiple terms match. Both categories may match and cancel. The persisted assessment records the configuration version, final score, and each matched rule's point contribution.

### Value is a hard gate, not fit evidence

Minimum Value Floors vary by Source and Client and belong in `hard_exclusions` in `config/addressability.yaml`. Encode a floor as a known positive amount below the floor:

```yaml
- id: example-source-client-below-minimum-value
  description: Example Client opportunities must have a known value of at least $500,000.
  conditions:
    all:
      - field: sourceId
        operator: equals
        value: example-source
      - field: clientName
        operator: equals
        value: Example Client
      - field: value.amount
        operator: gt
        value: 0
      - field: value.amount
        operator: lt
        value: 500000
```

The `gt: 0` condition is required: zero, null, and missing amounts mean “unknown” and remain eligible for fit scoring. Do not award or subtract points for value. Do not compare a configured floor to a different currency unless the Source provides an authoritative normalized value and currency basis.

Other Source-specific hard exclusions must use reliable structured evidence, such as a product classification code. Add a field to the addressability condition schema only when a normalized or `sourceData` value is stable enough to support a deterministic rule.

### Changing scoring configuration

- Keep shared DAI-Fit and Miss-Fit terms global; do not duplicate them in an adapter.
- Give every rule a stable kebab-case ID.
- Increment `schema_version` whenever a rule, term, weight, threshold, or hard exclusion changes classification behavior.
- Update `CONTEXT.md` and `test/addressability.test.ts` with the same change.
- Deployment alone does not update D1 rows. A scan reapplies a newer configuration to rediscovered events in place without creating a Modification.
- Excluded events are not stored, so a later rule change recovers them only when the Source returns them again.

## Adapter contract

Implement [`SourceAdapter`](src/sources/adapter.ts) in `src/sources/<source-id>.ts`. Its definition needs a stable kebab-case ID, display name, access mode, phase, and adapter version. Its `scan()` method accepts a cursor, abort signal, and scan time and returns normalized candidates plus the next cursor.

For each candidate, populate as much of [`NormalizedBiddingEvent`](src/domain/types.ts) as the Source reliably provides:

- `sourceId`: exactly the adapter definition ID.
- `sourceEventId`: stable identifier for this publication or Source record.
- `sourceOpportunityId`: stable identifier shared by related publications and updates.
- `canonicalUrl`: public, credential-free Source URL.
- `eventType`: Tender, Modification, or Cancellation only when the Source explicitly establishes it; the shared pipeline also creates Modifications for changed known deadlines or amounts.
- `publishedAt`: stable Source publication/update timestamp when available.
- `opportunityName` and `description`: normalized plain text; both feed shared scoring, and description also improves Technical Area Classification.
- `clientName`, procuring/funding/implementing entities, place, eligibility, due date, value, and currency when authoritative.
- `sourceData`: structured Source values needed for provenance or deterministic rules. Never include credentials or authenticated URLs containing secrets.

Preserve missing data as missing. Do not invent values, organization mappings, dates, currencies, or classifications merely to satisfy a rule.

The adapter must paginate completely within its documented scope, pass the provided abort signal to requests, use bounded retries/timeouts, return a cursor that cannot skip updates, and throw credential-safe `SourceScanError` values for expected Source failures.

For direct-HTML Sources, prefer server-rendered HTTP extraction with Cloudflare `HTMLRewriter` over Browser Rendering. The adapter owns selectors and Source semantics; do not create a generic selector-driven scraper. Preserve required session cookies without logging them, verify the Source echoed every configured search criterion, cap and validate pagination, throttle requests, and fail on structural drift rather than silently returning an incomplete scan. Browser Rendering is the fallback only when direct HTTP cannot expose the required fields or complete an approved authentication flow. Keep sanitized HTML fragments as contract fixtures and never store subscription-gated bodies unless their use is explicitly authorized.

## Files for one Source

A complete Source integration normally includes:

- `src/sources/<source-id>.ts`: adapter, parser, definition, and factory.
- `config/<source-id>.yaml`: non-secret scope and mappings, when needed.
- `test/<source-id>.test.ts` and sanitized `test/fixtures/<source-id>-*.json` fixtures.
- A uniquely numbered D1 migration that inserts the disabled or enabled Source row.
- Shared registration in `src/sources/index.ts`.
- Workflow configuration loading in `src/worker/workflow.ts` and secret typing in `src/worker/index.ts` when needed.
- Source-specific hard exclusions or Minimum Value Floors in `config/addressability.yaml`, only after the Client rules are approved.
- A concise Source section in `README` covering endpoint, scope, cursor, pagination, enrichment, value basis, and operational limits.

Use the SAM.gov adapter for an API-key/cursor example and Grants.gov for an unauthenticated full-snapshot/enrichment example.

## Tests and acceptance evidence

Adapter tests must use checked-in sanitized fixtures rather than live network calls. Cover:

- Scope enforcement and organization/client mapping.
- Pagination and cursor or full-snapshot behavior.
- Empty and malformed responses.
- Stable event and opportunity identifiers.
- Tender/update/cancellation mapping supported by the Source.
- Description and value extraction, including the exact value basis.
- Rate-limit, authentication, and retryable/non-retryable failures as applicable.
- Addressability floors and structured hard exclusions owned by this Source.
- Repeated-scan idempotency and deadline/amount Modification behavior in the shared integration test when the Source introduces a new pattern.

Before handoff, run:

```bash
npm run validate:config
npm run typecheck
npm test
npm run build
git diff --check
```

A bounded live request may validate an undocumented response shape, but it is not part of the automated suite. Record the observed shape without committing credentials or full sensitive responses.

## Parallel-orb workflow

Assign one Source ID and one migration number to each orb before work starts. Each Source orb should primarily own its new adapter, config, fixtures, and unit tests. It should supply its proposed README Source section in the handoff rather than having several orbs concurrently edit README.

The following files are shared merge points and should be handled by one integration orb after source branches are ready:

- `src/sources/index.ts`
- `src/worker/workflow.ts`
- `src/worker/index.ts`
- `config/addressability.yaml`
- `test/source-pipeline.integration.test.ts`
- `README`
- `DEVELOPMENT_PLAN.md`

For each source handoff, include:

1. Source ID, official endpoint, access mode, and documented rate limits.
2. Exact approved Client scope and organization mapping.
3. Proposed Minimum Value Floors and structured exclusions, clearly separated from observed Source facts.
4. Cursor/update strategy and why it cannot skip changes.
5. Value field and currency basis.
6. Files changed, verification results, one bounded live-response observation if used, and unresolved operational risks.

The integration orb should register all adapters, resolve shared configuration changes, run the combined suite, then perform deployment and live scans separately. A live scan is a production write and must not be implied by adapter implementation or deployment.
