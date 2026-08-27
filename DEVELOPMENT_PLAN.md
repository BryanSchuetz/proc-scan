# Procurement Opportunity Registry — Development Plan

Status: SAM.gov, Grants.gov, and Cloudflare Access deployed; first Cloudflare scan completed partially (Grants.gov succeeded, SAM.gov quota-limited)

This is a living plan. It records the agreed product behavior, target architecture, delivery sequence, and acceptance gates. Deferred details remain explicit rather than being guessed.

## Implementation Status — August 27, 2026

The local foundation includes the React/Worker application, D1 migrations and FTS5 index, fixture seed, read-only paginated API and table, deterministic classifier/config schemas, event identity and inheritance logic, OCDS-shaped release mapping, Cloudflare Access JWT guard, and New York-time Workflow schedule gate. SAM.gov and Grants.gov are registered Sources. SAM.gov's official v2 API adapter implements bounded cursor overlap, organization-scoped page-index pagination, credential-safe failures, and notice normalization. Grants.gov's official unauthenticated adapter discovers its current agency hierarchy, crosswalks it to the same approved federal organizations, scans only forecasted and posted opportunities, paginates a complete active snapshot, and enriches approved results through `fetchOpportunity` for synopsis/forecast text, eligibility, and funding values. Both use shared classification, persistence, deduplication, and per-Source run accounting.

Local verification covers migrations, seed idempotency, search/filter/sort behavior, both retained statuses, Technical Area descendant filtering, read-only API enforcement, Access failure modes, EST/EDT scheduling, SAM.gov and Grants.gov response mapping and pagination, approved-organization scoping, deadline/value Modification handling, in-place enrichment, and repeated-scan idempotency. Bounded live requests confirmed the SAM.gov search, Grants.gov search, and unauthenticated Grants.gov detail response shapes. Addressability configuration version 2 activates the supplied source-specific SAM.gov and Grants.gov agency value bands and shared technical-assistance requirement, with deterministic SAM.gov goods/supplies/manufacturing exclusions. Missing evidence remains Uncertain.

The Worker, static assets, Workflow, production D1 database, migrations, SAM.gov secret, and Worker-level Cloudflare Access application are deployed. Access uses the same 12-hour policy as DAI CV Formatter: `@dai.com` users and the configured owner account can authenticate through the account's Cloudflare or email one-time PIN identity providers. The Worker independently validates the Access issuer and application audience. The first API-triggered Cloudflare cycle completed in 21 seconds with the expected partial status: Grants.gov discovered and retained 128 records, while SAM.gov returned its quota-exhausted response and was recorded as a Source failure without blocking Grants.gov. The first scheduled cycle remains to be confirmed, and no email provider has been configured. SAM.gov description and pre-award value enrichment remain unresolved because descriptions consume additional keyed requests and the public search schema has no estimated solicitation value.

## Goal

Build a Cloudflare-hosted application that:

1. Scans procurement Sources every 12 hours.
2. Extracts and normalizes Bidding Events into a common shape based on the Open Contracting Data Standard (OCDS).
3. Classifies technical areas using an organization-provided taxonomy.
4. Classifies Bidding Events as Addressable, Uncertain, or Excluded; drops Excluded records and persists the other two outcomes.
5. Emails a digest of newly discovered Addressable Bidding Events, grouped by Client and then Bidding Event Type.
6. Provides an authenticated, searchable, sortable, and filterable web table of retained Bidding Events.

## Initial Non-Goals

- Application-managed users, roles, subscriptions, or per-user preferences.
- Editing Bidding Events or classifications in the UI.
- Retaining Excluded Bidding Events, complete source pages, or attachments.
- AI-based Technical Area or Addressability decisions.
- A compiled current-state Opportunity table separate from Bidding Events.
- Fully unattended interception of two-factor authentication codes.

## Confirmed Decisions

### Retention

- Assess each Bidding Event in two stages:
  1. If a hard exclusion rule matches, classify the event as **Excluded** and drop it regardless of score.
  2. Otherwise, score the event against the addressability criteria.
- A non-excluded event receives one of two score-based outcomes:
  - **Addressable**: meets or exceeds the addressability threshold and is retained.
  - **Uncertain**: scores below the addressability threshold and is retained with that status.
- A low score alone never permanently drops a Bidding Event.
- The initial SAM.gov and Grants.gov addressability rules are defined. Rules for other Sources and any additional cross-Source criteria remain to be supplied.
- Because Excluded events are not retained, later rule changes cannot recover them unless a Source publishes or returns them again. This is an accepted consequence of the retention decision.

### Classification boundaries

- The technical-area taxonomy only defines Technical Area labels and how Bidding Events map to them.
- Technical Area Classification is multi-label: one Bidding Event may have any number of Technical Areas, with no required primary area.
- Technical Area Classification is deterministic for the initial implementation; it does not use an AI model.
- Match taxonomy names and aliases directly and support explicit positive terms, negative terms, and tie-breaking rules in the taxonomy where context is needed.
- Only labels meeting a configurable deterministic match threshold are assigned; when none qualify, use **Unclassified** rather than forcing the closest label.
- A specific multi-word term may qualify a label by itself; a generic one-word term such as “digital,” “investment,” or “trade” requires at least one additional supporting match.
- Assign only the most specific matching taxonomy labels. A child match such as Cybersecurity is not also stored or displayed as its parent Digital unless the parent independently matches.
- Parent filters include events assigned to any descendant label, preserving broad discovery without redundant labels in the digest.
- A separate Addressability Assessment determines whether a Bidding Event is Addressable, Uncertain, or Excluded.
- Addressability will consider award value, Client, and additional criteria still to be supplied.
- Addressability uses explicit, project-owned, configurable rules rather than an AI model's final judgment.
- The configuration defines hard exclusions, weighted criteria such as value bands and Client preferences, and the final score threshold.
- Missing data contributes no points for that criterion but never triggers a hard exclusion; all remaining known criteria are still scored.

### Technical-area taxonomy snapshot

- `tech-area-classification.yaml` is present in the repository and is the initial taxonomy source of truth.
- It currently contains 39 labels: 8 top-level labels and 31 child labels. Every label has an ID, name, aliases, and definition.
- The schema may be extended with machine-readable matching rules. Existing prose `include_when` and `exclude_when` guidance cannot be treated as exact executable logic without such rules.
- Known exact alias overlaps requiring context or tie-breaking are:
  - `biodiversity conservation`: Climate and Environment; Nature, Oceans, and Biodiversity.
  - `local supplier development`: Supply Chain Management; Supply Chain Localization.

### Hosting and access

- The application will be hosted on Cloudflare.
- The web UI and API are protected by a Worker-level Cloudflare Access application using the account's Cloudflare and email one-time PIN identity providers. Microsoft Entra ID is deferred.
- The Access allow policy matches DAI CV Formatter: users with a `dai.com` email address and the configured owner email account are allowed, with a 12-hour session.
- Cloudflare Access owns user authentication and authorization; the application does not maintain user accounts, roles, or separate permissions.
- Every authenticated visitor has the same read-only access.
- Cloudflare credentials will be supplied through project secrets.

### Service topology

- Build a modular monolith in one codebase and Cloudflare deployment.
- The deployment owns the read-only web UI, API, scheduling/orchestration, normalization, deterministic classifiers, digest generation, and Source adapters.
- Use Cloudflare D1 as the relational database.
- Keep each Source adapter isolated as a code module with a common output contract, not as a separately deployed service.
- Split out a service only if a demonstrated platform constraint—such as unsupported browser automation—requires it.

### Storage boundary

- Do not retain complete raw HTML pages, downloaded documents, or attachments in the initial release, and do not provision R2 solely for them.
- For each retained Bidding Event, store its Source URL, Source identifiers, normalized fields, and the structured source values used to produce them in D1.
- Store no payload or registry record for Excluded Bidding Events.
- Retain Addressable and Uncertain Bidding Events indefinitely for the initial release; revisit archival after measuring actual growth.
- Define a configurable age cutoff for records shown in the read-only UI later. The exact cutoff and whether visitors can expand beyond it are intentionally deferred.
- Add R2 later only if a demonstrated audit, replay, or attachment requirement justifies it.

### Collection cadence

- Automated scan cycles run at 6:00 AM and 6:00 PM in `America/New_York`, following daylight-saving changes.
- Each scan cycle produces one consolidated digest immediately after collection, normalization, classification, and persistence finish; there is no independent digest schedule.
- Source onboarding will be staged by authentication complexity:
  1. Sources requiring no authentication, including Sources with a straightforward public API.
  2. Sources requiring login credentials or other unattended authentication.
  3. Sources requiring interactive two-factor authentication.
- Treat these as sequential delivery gates: do not start authenticated adapters until the public adapters are working, and do not start 2FA adapters until the authenticated adapters are working.

### Interactive authentication

- Do not automate interception of phone or email two-factor authentication codes.
- Establish 2FA sessions manually and reuse them only while valid.
- When a session expires, mark that Source as requiring reauthentication, skip it without blocking other Sources, and notify an operator.
- Accept that 2FA Sources may not achieve uninterrupted twice-daily scanning.

### Presentation

- The email digest is grouped first by Client and then by Bidding Event Type: Tender, Modification, or Cancellation.
- Only Addressable Bidding Events appear in the email digest; Uncertain Bidding Events are omitted.
- Each digest entry includes at least the Opportunity name, place of performance, value, due date, and classified technical areas.
- The primary web UI at `/` displays only Addressable Bidding Events under the label **Marked**. A separate `/unmarked` view displays Uncertain Bidding Events under the label **Unmarked** using the same read-only table. Excluded Bidding Events are unavailable, and there is no status dropdown.
- The table displays at least the digest fields and supports sorting, filtering, and search.
- The table defaults to newest-discovered Bidding Events first.
- The UI is read-only: users can search, sort, and filter records but cannot edit any Bidding Event field or status.

### Digest delivery

- Send each digest to one configured email address representing an Outlook-hosted distribution list.
- Do not build user subscriptions, recipient management, or per-user digest preferences in the initial release.
- Skip the digest when a completed scan cycle produces no new Addressable Bidding Events; still record the successful cycle internally.
- If one or more Sources fail, continue processing and send any valid events from successful Sources rather than suppressing the entire digest.
- Every sent digest includes a scan summary identifying Sources scanned successfully and any Sources that failed, so recipients can see the digest's coverage.
- Keep the sending provider undecided until deployment constraints are known. Cloudflare Email Service is preferred if sender-domain onboarding is feasible; otherwise use an external transactional sender such as SendGrid, potentially through a separately hosted service.
- Do not assume the organization can authorize Cloudflare as a sender for its Outlook environment.

### Client identity

- Client means the organization issuing or owning the procurement, corresponding to the OCDS `buyer`.
- Funding, procuring, and implementing organizations are stored separately when supplied by a Source and are not used for the digest's primary grouping.

### Bidding Events

- Use **Bidding Event** for a registry record and **Bidding Event Type** for its Tender, Modification, or Cancellation category.
- An initial solicitation, including a grant opportunity, maps to **Tender**.
- A change between previously known and newly published Opportunity deadline or amount values maps to **Modification**.
- A withdrawal maps to **Cancellation**.
- Preserve the Source's original event or notice type separately for traceability.
- Store every Bidding Event as a separate database record and display it as a separate table row. Do not maintain a single current-state Opportunity row.
- A Tender followed by a Modification and Cancellation therefore produces three records and three table rows, each repeating the relevant Opportunity fields such as its name.
- Copy the Source Opportunity Identifier onto each related Bidding Event when the Source provides one; this does not create a separate Opportunity table.
- Do not infer relationships with fuzzy name matching when a Source provides no stable Opportunity identifier.
- Fill every Bidding Event with as many fields as possible. When related events can be matched reliably through their Source Opportunity Identifier, fill missing fields—including derived fields—from the latest applicable earlier event.
- Values explicitly present in the current Bidding Event take precedence over inherited values. Without a reliable match, leave missing values empty rather than guessing.

### Event identity and deduplication

- Repeated scans must be idempotent: rediscovering an existing Bidding Event does not create another row or another digest entry.
- Identify a Bidding Event using the first available stable key:
  1. Source plus the Source's Bidding Event identifier.
  2. Source plus the canonical event URL.
  3. A deterministic fingerprint of stable normalized fields when neither identifier exists.
- If a Source reuses an identity, create a new event row only for these Opportunity state changes:
  - A withdrawal creates a Cancellation.
  - A change between two known due-date values or two known amount values creates a Modification.
  - Newly populated fields and changes to description, scope, place of performance, eligibility, or other metadata enrich the existing event in place.
  - Formatting and other irrelevant page changes create no change.

## Target Architecture

```diagram
┌──────────────────────── Cloudflare deployment ────────────────────────┐
│                                                                       │
│  ┌────────────────┐       ┌───────────────────────────────────────┐  │
│  │ Access         │──────▶│ Worker: static UI + read-only API    │  │
│  │ CF + email OTP │       └──────────────────┬────────────────────┘  │
│  └────────────────┘                          │                       │
│  ┌────────────────┐       ┌──────────────────▼────────────────────┐  │
│  │ Scheduled      │──────▶│ Workflow: scan → normalize → classify│  │
│  │ Workflow       │       │          → persist → digest          │  │
│  └────────────────┘       └───────┬──────────────────────┬───────┘  │
│                                   │                      │          │
│                         ┌─────────▼─────────┐   ┌────────▼────────┐ │
│                         │ Source adapters   │   │ D1 + FTS5       │ │
│                         │ HTTP/API/browser  │   │ events and runs │ │
│                         └───────────────────┘   └─────────────────┘ │
│                                                                       │
└───────────────────────────────────────┬───────────────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ Email provider   │
                              │ decision deferred│
                              └───────────────────┘
```

### Cloudflare components

- **Worker with static assets**: serves the web application and the same-origin JSON API from one deployment.
- **Cloudflare Access**: authenticates through the account's Cloudflare and email one-time PIN identity providers. The Worker also validates the Access JWT issuer and audience before serving UI or API data.
- **D1**: stores retained Bidding Events, classifications, scan state, source-run outcomes, and digest delivery state.
- **D1 FTS5**: provides server-side full-text search over Opportunity name, description, Client, place, and denormalized Technical Area labels.
- **Cloudflare Workflows**: runs the durable scheduled pipeline with step-level retries and records each cycle independently.
- **Browser Rendering**: used only by a Source adapter that cannot obtain the required data through an official API or direct HTTP request.
- **R2**: omitted from the initial architecture.

### Scheduled pipeline

1. Create an idempotent scan run for the local 6:00 AM or 6:00 PM cycle.
2. Run each enabled Source adapter with its saved cursor and bounded retries. One Source failure does not stop the others.
3. Normalize each candidate into an OCDS-shaped release plus product metadata.
4. Resolve event identity; ignore an already stored identity/content-fingerprint pair and update an existing event for non-event enrichment.
5. When an exact Source Opportunity Identifier links to an earlier event, fill missing fields from the latest applicable event and create a Modification only for a changed known deadline or amount.
6. Assign deterministic Technical Areas from the taxonomy.
7. Apply hard exclusions, then calculate the deterministic addressability score.
8. Drop Excluded candidates and atomically persist Addressable and Uncertain Bidding Events with their classifications.
9. After all Source runs settle, render one digest from Addressable events first persisted by this scan run. Include the Source success/failure summary and skip sending when the event set is empty.
10. Record the digest provider result so a retry cannot send the same cycle twice.

Cloudflare schedules use UTC. To preserve 6:00 AM and 6:00 PM `America/New_York` across daylight-saving changes, trigger at the possible UTC equivalents, gate execution on the local time, and enforce one unique scan-run key per local date and AM/PM cycle.

## Canonical Data Contract

Treat each Bidding Event as one OCDS **release**, which matches the decision to keep Tender, Modification, and Cancellation rows separately. Do not build an OCDS compiled record in the initial release.

### OCDS mapping

- `ocid`: derive from Source plus Source Opportunity Identifier. If the Source has no Opportunity identifier, derive it from the stable event identity and do not imply links to other events.
- `id`: unique release identifier derived from Source event identity and material-content fingerprint.
- `date`: Source publication/update time when available, otherwise first-discovered time.
- `tag`:
  - Tender → `tender`.
  - Modification → `tenderAmendment` when the Source identifies a formal amendment; otherwise `tenderUpdate`.
  - Cancellation → `tenderCancellation`.
- `buyer`: Client.
- `parties`: buyer plus funder, procuring entity, or implementing entity when supplied.
- `tender.title` and `tender.description`: Opportunity name and scope.
- `tender.value`: estimated Opportunity value and ISO 4217 currency when known.
- `tender.tenderPeriod.endDate`: response due date.
- `tender.status`: current status stated by the Bidding Event, including `cancelled` for a Cancellation.
- `tender.items` and the OCDS Location extension: source classifications, scope items, and place of performance when available.
- `tender.documents`: canonical Source URL and relevant document links, without downloading the documents.

The registry is OCDS-shaped but includes internal product metadata outside the OCDS release: Source identity, Bidding Event Type, addressability score/status and matched rules, Technical Area IDs and match evidence, discovery time, scan-run ID, content fingerprint, inherited-field provenance, and the structured source values used for normalization. Do not claim external OCDS conformance until generated releases pass the OCDS Data Review Tool and any custom extensions are documented.

## D1 Data Model

Start with these tables; keep migrations in source control.

- **`sources`**: stable Source ID, display name, phase, enabled state, adapter version, cursor, and reauthentication state.
- **`scan_runs`**: unique local cycle key, schedule time, start/end time, overall status, and aggregate counts.
- **`source_runs`**: Source outcome per scan, retry count, cursor before/after, discovered/retained/excluded counts, and sanitized failure information.
- **`bidding_events`**: release identity, shared Source Opportunity Identifier, Bidding Event Type, source/original type, core normalized fields, OCDS release JSON, structured source JSON, addressability status/score, publication/discovery times, and inheritance provenance.
- **`technical_areas`**: taxonomy version, stable label ID, name, and parent ID loaded from YAML.
- **`bidding_event_technical_areas`**: event-to-label assignments and deterministic match evidence.
- **`digests`**: scan-run ID, content fingerprint, provider, provider message ID, status, attempts, and sent time.
- **FTS5 index**: searchable text keyed to `bidding_events`, refreshed in the same transaction as each event.

Enforce uniqueness on `(source_id, event_identity, content_fingerprint)` and on the scan cycle key. Store all timestamps in UTC; convert only for scheduling and display. Use server-side pagination and allowlisted sort columns rather than loading the complete registry into the browser.

## Source Adapter Contract

Every adapter must:

1. Declare a stable Source ID, access mode, and adapter version.
2. Accept a saved cursor or bounded lookback window.
3. Return source candidates with event/opportunity identifiers, canonical URL, source publication/update time, original notice type/status, and all available structured fields.
4. Distinguish Tender, Modification, and Cancellation when the Source provides enough evidence.
5. Produce stable normalized content for material-change fingerprinting; ignore page chrome and formatting.
6. Paginate, obey documented rate limits, use bounded timeouts/retries, and redact credentials from errors.
7. Leave persistence, inheritance, classification, and digest behavior to the shared pipeline.

Prefer, in order: official public API, documented feed/download, direct HTTP extraction, then Browser Rendering. Before enabling any adapter, review the Source's terms, robots policy where relevant, and credential/session restrictions. Add fixture-based contract tests so Source parsing can be tested without calling the live site.

## UI and API Contract

- One row represents one Bidding Event.
- Initial columns: discovered date, Bidding Event Type, Opportunity name, Client, place of performance, value/currency, due date, Technical Areas, Source, source publication date, and Source link. Addressability status is conveyed by the current registry route.
- Initial filters: Bidding Event Type, Client, Source, Technical Area (including descendants when a parent is selected), place/country, due-date range, discovered-date range, and value/currency where available. Addressability status is selected by the Marked (`/`) and Unmarked (`/unmarked`) routes rather than a dropdown. Each filterable table header opens one combined menu containing its sort and filter options.
- Search title, description/scope, Client, place, and Technical Area labels through D1 FTS5.
- Default sort is discovery time descending. All sorting, filtering, searching, and pagination happen server-side.
- Empty and missing values are visibly distinguished from zero values. Values retain their original currency; the UI does not compare or aggregate unlike currencies.
- The API is read-only and rejects unsupported filter/sort fields. Excluded events have no API representation.

## Configuration and Secrets

- Keep taxonomy and addressability rules as versioned repository files validated at build/test time.
- Extend `tech-area-classification.yaml` with explicit machine-readable positive terms, negative terms, weights, and tie-breaking rules. Retain prose definitions and `include_when`/`exclude_when` as human documentation.
- Add a separate addressability configuration containing a schema version, hard exclusions, weighted criteria, value bands, Client rules, threshold, and stable rule IDs. Store matched rule IDs and score contributions on each retained event.
- Store the taxonomy and addressability configuration versions used for each Bidding Event. Apply changed configuration to historical retained events only through an explicit, tested reclassification job, not implicitly during deployment.
- Reclassification alone does not make an old Bidding Event “new” and never adds it to a digest retroactively.
- Keep non-secret Source settings in versioned configuration. Store API keys, login credentials, session material, Cloudflare IDs/tokens, email credentials, and the digest recipient as Cloudflare secrets or environment-specific bindings.
- Commit an example environment file containing names only, never secret values.

## Security and Operations

- Validate Cloudflare Access JWTs at the Worker even though Access sits in front of it.
- Use least-privilege Cloudflare bindings and restrict outbound email to the configured distribution list when the provider supports it.
- Never log credentials, API keys, Access tokens, 2FA codes, session cookies, or full authenticated responses.
- Record structured scan/source/digest outcomes and emit metrics for run duration, Source success, retry count, new/duplicate/excluded events, classification outcomes, and email delivery.
- Provide a manual, authenticated way to trigger a scan in non-production and inspect run status; production manual execution must use the same idempotency guard as scheduled execution.
- Use separate local/preview and production D1 databases and secrets. A permanent staging environment is unnecessary initially; add one when authenticated adapters make production-only testing too risky.
- Use D1 migrations and backups/disaster recovery; never make schema changes ad hoc in production.

## Inputs Expected from the Owner

- **Present**: `tech-area-classification.yaml`.
- **Present**: SAM.gov API key in the `SAM_API_KEY` project secret.
- **Present**: Cloudflare account ID and Workers deployment credentials in project secrets.
- **Present**: Worker-level Access application, allow policy, team domain, and application audience.
- **Before Addressability Assessment can be accepted across all Sources**: rules for Sources other than SAM.gov and Grants.gov, plus any remaining cross-Source criteria.
- **Before SAM.gov value bands can classify live pre-award notices**: an authoritative estimated-value extraction strategy; the public search response does not provide this field.
- **Before live digest delivery**: destination distribution-list address, sender identity, and selected email provider credentials/configuration.
- **Before Phase 2 login-based adapters**: credentials for login-based Sources, supplied through project secrets.
- **Before Phase 3**: credentials and an approved manual session-handoff procedure for 2FA Sources.

## Source Rollout

The phase numbers below continue to describe authentication complexity, not current delivery priority. The owner reprioritized SAM.gov as the first vertical slice on August 27, 2026. After SAM.gov, order adapters by API/feed availability, expected value, and legal/technical feasibility rather than preserving the table order blindly.

### Phase 1 — Unauthenticated or public API

| Order | Source | Starting URL | Plan |
|---:|---|---|---|
| 1 | Grants.gov | [API resources](https://www.grants.gov/api) | Search and public detail enrichment are implemented with approved-organization hierarchy discovery and full active-snapshot deduplication; continue validating scheduled live scans. |
| 2 | TED | [Current search](https://ted.europa.eu/en/search/result?query=%28funding+IN+%28external-aid-program%29%29+SORT+BY+publication-number+DESC&scope=ACTIVE&onlyLatestVersions=false&sortColumn=publication-number&sortOrder=DESC&page=1) | Use the unauthenticated official Search API; add XML/eForms mapping after the core pipeline works. |
| TBD | EU Funding & Tenders Portal | [Portal](https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/home) | Discover and prefer official published-data APIs before browser extraction. |
| TBD | dgMarket | [Buyer list](https://www.dgmarket.com/tenders/buyerList.do) | Confirm permitted access, search scope, pagination, and whether a feed/API is available. |
| TBD | European Investment Bank | [All procurement](https://www.eib.org/en/about/procurement/all/index?sortColumn=configuration.contentStart&sortDir=desc&pageNumber=0&itemPerPage=25&pageable=true&la=EN&deLa=EN&orYearTo=true&orYearFrom=true&procurementStatus=All&_g_procurementInformations_type=call-technical-assistance&or_g_procurementInformations_type=true) | Inspect the backing endpoint before writing an HTML adapter. |
| TBD | FMO Open Tenders | [Open Tenders](https://www.fmo.nl/open-tenders) | Inspect the backing endpoint before writing an HTML adapter. |

### Phase 2 — Unattended authentication

| Source | Starting URL | Access | Plan |
|---|---|---|---|
| SAM.gov | [SAM.gov](https://sam.gov/) | API key | Implemented locally as the first Source; validate scheduled live scans and decide bulk versus selective description enrichment. |
| Atamis Supplier Portal | [Login](https://atamis-9529.my.site.com/ProSpend__CustomCommunitiesLogin?startURL=%2Fhome%2Fhome.jsp) | Login | Determine session lifetime and direct HTTP/API feasibility before Browser Rendering. |
| BEIS/Jaggaer | [Portal](https://beisgroup.ukp.app.jaggaer.com/esop/ogc-host/public/beisgroup/web/error.jst?_ncp=1785141439137.292039-1) | Login | Find a stable entry URL, then determine session and extraction approach. |
| ECEPP | [Activity Centre](https://ecepp.ebrd.com/delta/mainMenu.html?login=true) | Login | Determine session lifetime and direct HTTP/API feasibility before Browser Rendering. |
| GSA eBuy | [eBuy](https://www.ebuy.gsa.gov/ebuy/) | TBD | Confirm authentication and automation terms before assigning a final phase. |

### Phase 3 — Interactive two-factor authentication

| Source | Starting URL | Access | Plan |
|---|---|---|---|
| FCDO eSourcing Portal | [Login](https://fcdo.bravosolution.co.uk/web/login.html) | Login + phone code | Reuse a manually established session while valid; stop and request reauthentication on expiry. |
| SIMAP | [Search](https://www.simap.ch/en) | Login + email code | Reuse a manually established session while valid; stop and request reauthentication on expiry. |

## Delivery Plan

### Milestone 0 — Foundation

- Scaffold the TypeScript Cloudflare Worker, static frontend build, tests, and local development configuration.
- Add D1 migrations, generated binding types, taxonomy/config validation, Access JWT validation, and the scheduled Workflow shell.
- Implement domain types, OCDS release mapping, event identity/fingerprinting, inheritance, deterministic classifiers, and scan/source-run persistence against fixtures.
- Build the read-only paginated API and basic table using seeded fixture data.

**Gate:** migrations run locally; invalid configuration fails fast; unauthenticated API requests are rejected in a deployed preview; unit and integration tests pass; rerunning a fixture scan creates no duplicates.

### Milestone 1 — SAM.gov vertical slice

- Implement SAM.gov search collection for the four approved federal organizations with an API key, saved cursor, bounded lookback, page-index pagination, and quota-aware failures.
- Map SAM.gov notices into Bidding Events and OCDS-shaped releases, linking exact organization-and-solicitation identifiers where available.
- Run Technical Area and Addressability Assessment, persist retained events, index search text, and display them in the table.
- Decide whether full descriptions should come from the daily Active Opportunities extract or selective authenticated description requests.
- Render HTML and plain-text digest previews, including Source coverage, while the sending provider remains deferred.
- Exercise scheduled and manual non-production runs.

**Gate:** a repeated live scan is idempotent; sampled fields match SAM.gov; filters/search/sorting work server-side; Excluded events leave no registry rows; a digest preview contains only newly retained Addressable events.

### Milestone 2 — Public Sources and production digest

- Select and configure the email provider and sender identity; make delivery idempotent and record provider results.
- Validate Grants.gov live-scan volume and add selective `fetchOpportunity` synopsis enrichment if it is operationally justified.
- Implement TED search, pagination, XML/eForms parsing, notice-type mapping, and OCDS identifiers.
- Validate generated OCDS releases with the OCDS Data Review Tool.
- Run SAM.gov, Grants.gov, and TED on the production schedule behind Cloudflare Access.

**Gate:** seven consecutive days of scheduled runs complete without duplicate rows or duplicate emails; a forced single-Source failure still produces a correctly marked partial digest; an empty successful cycle sends no digest.

### Milestone 3 — Remaining public Sources

- Perform an API/feed, terms, rate-limit, and field-coverage spike for each remaining Phase 1 Source.
- Implement adapters one at a time using the shared contract and fixture tests.
- Record unsupported fields as missing rather than adding Source-specific UI behavior.

**Gate:** every enabled public adapter passes its contract tests and the combined production workflow remains stable as each Source is added.

### Milestone 4 — Unattended authentication

- Add the remaining credential-based Sources in feasibility/value order.
- Introduce Browser Rendering only for Sources proven not to work through API or direct HTTP access.
- Add session-expiry detection and operator alerts without exposing credential material.

**Gate:** authenticated adapters survive expected session renewal and failure scenarios, and public Sources remain unaffected by an authenticated Source outage.

### Milestone 5 — Interactive 2FA

- Define and security-review the manual session-handoff process.
- Implement FCDO and SIMAP individually, with explicit `reauthentication_required` state and runbook.
- Measure real session lifetimes and decide whether twice-daily coverage is operationally sustainable.

**Gate:** no 2FA code is stored or intercepted; expired sessions fail closed, alert an operator, and do not block other Sources.

## Verification Strategy

- **Unit tests**: identity priority, material fingerprints, OCDS tag mapping, field inheritance, taxonomy term normalization/weights/ties, addressability scoring/exclusions, timezone gating, and digest grouping.
- **Configuration tests**: unique taxonomy/rule IDs, valid parent references, explicit handling of alias collisions, supported fields/operators, and stable schema versions.
- **Adapter contract tests**: checked-in sanitized fixtures for pagination, empty results, malformed records, updates, cancellations, rate limits, and authentication expiry.
- **D1 integration tests**: migrations, uniqueness, transactions, FTS synchronization, server-side filtering/sorting/pagination, and scan/digest idempotency.
- **Workflow tests**: retries, one-Source failure, all-Source failure, no new events, duplicate trigger, email failure/retry, and daylight-saving transitions.
- **UI tests**: only Addressable events on the Marked (`/`) view, only Uncertain events on the Unmarked (`/unmarked`) view, all required columns, combined filters/search, missing values, large result pagination, source links, and read-only enforcement.
- **Security tests**: missing/invalid Access JWT, wrong audience, secret redaction, forbidden API methods, and unsafe sort/filter input.
- **Live smoke tests**: one bounded request per Source during deployment verification; do not make broad live scraping part of the normal unit suite.

## Deferred Decisions and Explicit Revisit Points

These do not need more interview time now, but they must be resolved before the milestone that depends on them:

- Addressability rules for Sources other than SAM.gov and Grants.gov, plus any remaining cross-Source criteria — before Milestone 1 acceptance.
- Exact machine-readable taxonomy weights, threshold, and tie-break rules — during Milestone 0.
- Email provider, sender domain/address, failure alert when no digest is sent, and delivery tracking details — before Milestone 2.
- UI record-age cutoff and whether visitors can expand to all history — revisit after observing volume and user behavior.
- Export, event detail view, and saved filters — omitted until requested.
- SAM.gov full-description strategy—daily Active Opportunities extract versus selective API enrichment—before Milestone 1 acceptance.
- Secure session handoff and operator alert channel for authenticated/2FA Sources — before Milestones 4 and 5.
- Source-by-Source legal, terms, robots, rate-limit, API, and field-coverage findings — before enabling each additional adapter.
- GSA eBuy authentication phase — after discovery.
- Retention/archival policy — revisit when D1 growth is measured.

## Planning References

- [Cloudflare Workflows scheduled triggers](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Cloudflare D1 supported SQL and FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json)
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/)
- [OCDS releases and records](https://standard.open-contracting.org/latest/en/primer/releases_and_records/)
- [OCDS release tags](https://standard.open-contracting.org/latest/en/schema/codelists/)
- [SAM.gov Get Opportunities Public API](https://open.gsa.gov/api/get-opportunities-public-api/)
- [Grants.gov API guide](https://grants.gov/api/api-guide)
- [TED Search API](https://docs.ted.europa.eu/api/latest/search.html)
