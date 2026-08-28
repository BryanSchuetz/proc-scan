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

Assessment proceeds in this order:

1. Apply hard exclusions. A known positive value below the applicable Minimum Value Floor is Excluded without fit scoring. Zero, null, and missing values are treated as unknown, so they do not trigger the value exclusion. Source-specific structured evidence may also exclude an event, such as a SAM.gov product PSC or manufacturing NAICS code.
2. If the event is not excluded, score each evidence category at most once:

| Evidence | Score |
| --- | ---: |
| Title or description contains one or more service terms | +2 |
| Title or description contains one or more goods terms | −2 |

The service terms are: `advisory`, `capacity building`, `consultancy`, `consultant`, `consulting`, `implementation support`, `professional services`, `services`, and `technical assistance`.

The goods terms are: `goods`, `supply`, `supplies`, `equipment`, `vehicles`, `hardware`, `furniture`, `materials`, and `computers`.

Term matching is case-insensitive against the normalized Opportunity title and description. Multiple terms in one category do not compound its score; service and goods evidence are independent and can both match.

After hard exclusions, a fit score of 2 or more is **Addressable** and appears on the Marked page. A lower score is **Uncertain** and appears on the Unmarked page. Service evidence without goods evidence is therefore Addressable whether the value is above the floor or unknown. If goods evidence is also present, it offsets the service score to 0 and the event remains Uncertain.
