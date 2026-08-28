# Procurement Opportunity Registry

This context describes procurement notices collected from external sources and the opportunities the organization may pursue.

## Language

**Opportunity**:
A procurement or grant opportunity that the organization may pursue and about which one or more Bidding Events may be published.
_Avoid_: Listing, record, Bidding Event

**Bidding Event**:
A publication that creates, changes, or withdraws an Opportunity and is considered independently from other publications about that Opportunity.
_Avoid_: Bidding type, notice type, Opportunity

**Bidding Event Type**:
The Tender, Modification, or Cancellation category assigned to a Bidding Event.
_Avoid_: Bidding type, notice type

**Tender**:
The initial Bidding Event that publishes an Opportunity, including a grant opportunity.
_Avoid_: Initial Opportunity

**Modification**:
A Bidding Event that changes a previously known Opportunity deadline or amount.
_Avoid_: Mod, update

**Cancellation**:
A Bidding Event that withdraws a previously published Opportunity.
_Avoid_: Withdrawal

**Addressable Bidding Event**:
A Bidding Event that meets or exceeds the organization's addressability threshold.
_Avoid_: Relevant listing, accepted record

**Uncertain Bidding Event**:
A Bidding Event that does not match a hard exclusion but scores below the organization's addressability threshold.
_Avoid_: Watchlist Event, deferred Opportunity

**Excluded Bidding Event**:
A Bidding Event that matches a hard exclusion rule regardless of its addressability score.
_Avoid_: Unaddressable Opportunity, rejected Event

**Technical Area**:
A subject-matter category assigned to a Bidding Event using the organization's taxonomy.
_Avoid_: Addressability criterion, industry code

**Unclassified**:
The Technical Area outcome for a Bidding Event when no taxonomy label meets the deterministic match threshold.
_Avoid_: Other, closest match

**Addressability Assessment**:
The evaluation of a Bidding Event against business criteria such as value and Client to assign Addressable, Uncertain, or Excluded.
_Avoid_: Technical Area Classification, relevance

**Minimum Value Floor**:
The minimum known Opportunity value required for a specific Source and Client. A known positive value below this floor is a hard exclusion; zero, null, and missing values are treated as unknown.
_Avoid_: Addressability threshold, score threshold

**Client**:
A buying organization that issues or owns an Opportunity, corresponding to the OCDS buyer. Funders and procuring or implementing entities are distinct when identified.
_Avoid_: Customer, source, website

**Source**:
An external website or API from which Opportunities are collected.
_Avoid_: Client, portal

**Source Opportunity Identifier**:
An identifier assigned by a Source to the Opportunity shared by its related Bidding Events.
_Avoid_: Bidding Event identifier, internal record identifier

## Addressability Scoring Contract

The same deterministic fit scoring applies to every Source and Client. Source- and Client-specific configuration may vary the Minimum Value Floor and add structured hard exclusions, but value is a gate and never contributes to the fit score.

TED Client scope is restricted to DG AGRI, DG CLIMA, DG ECHO, DG CINEA, DG GROW, DG IDEA, DG REA, DG INTPA, DG DEV, DG ENEST, DG MENA, and DG TRADE. A TED notice is in scope only when at least one localized buyer name contains the configured Directorate-General code as a complete token.

TED has a Minimum Value Floor of €1,000,000. The floor applies when TED publishes a known positive EUR procedure estimate. A missing value remains eligible for fit scoring, and a value published in another currency is not compared to the EUR floor without an authoritative conversion.

Assessment proceeds in this order:

1. Apply hard exclusions. A known positive value below the applicable Minimum Value Floor is Excluded without fit scoring. Zero, null, and missing values are treated as unknown, so they do not trigger the value exclusion. Source-specific structured evidence may also exclude an event, such as a SAM.gov product PSC or manufacturing NAICS code.
2. If the event is not excluded, score each evidence category at most once:

| Evidence | Score |
| --- | ---: |
| Inclusive baseline for every non-excluded event | +2 |
| Title or description contains one or more DAI-Fit terms | +2 |
| Title or description contains one or more Miss-Fit terms | −2 |

The DAI-Fit terms are: `advisory`, `analytics`, `capacity building`, `climate`, `consultancy`, `consultant`, `consulting`, `digital`, `economic growth`, `education`, `environment`, `financial advisory`, `fragile states`, `global health`, `governance`, `implementation support`, `institutional strengthening`, `management consulting`, `market systems`, `monitoring evaluation and learning`, `partnerships`, `policy`, `private sector`, `professional services`, `project design`, `public financial management`, `public sector`, `resilience`, `sustainable business`, `technical assistance`, `training`, and `WASH`.

The Miss-Fit terms are: `goods`, `supplies`, `equipment`, `vehicles`, `hardware`, `furniture`, `materials`, `computers`, `manned guarding`, `security guarding`, `guarding services`, `security services`, `close protection`, `medical insurance`, `health insurance for`, `group insurance`, `accidental insurance`, `life insurance`, `travel insurance`, `cleaning services`, `janitorial`, `catering services`, `canteen`, `landscaping`, `gardening services`, `pest control`, `waste collection`, `vehicle hire`, `vehicle rental`, `car rental`, `fleet management`, `chauffeur`, `travel management`, `removal services`, `relocation services`, `furniture supply`, `office supplies`, `stationery`, `residential lease`, `building maintenance`, `facilities management`, `air conditioning maintenance`, `supervision`, `construction`, `architecture`, `architectural`, `engineering`, `engineer`, `visa`, `embassy`, `maintenance`, `irrigation`, and `drainage`.

Term matching is case-insensitive against the normalized Opportunity title and description. Multiple terms in one category do not compound its score; DAI-Fit and Miss-Fit evidence are independent and can both match.

After hard exclusions, a fit score of 2 or more is **Addressable** and appears on the Marked page. A lower score is **Uncertain** and appears on the Unmarked page. The inclusive baseline defaults every non-excluded event to Addressable; only Miss-Fit evidence without DAI-Fit evidence moves it below the threshold.

| DAI-Fit evidence | Miss-Fit evidence | Final score | Outcome |
| --- | --- | ---: | --- |
| No | No | 2 | Addressable (Marked) |
| Yes | No | 4 | Addressable (Marked) |
| No | Yes | 0 | Uncertain (Unmarked) |
| Yes | Yes | 2 | Addressable (Marked) |
