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
A Bidding Event that changes a previously published Opportunity.
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

**Client**:
A buying organization that issues or owns an Opportunity, corresponding to the OCDS buyer. Funders and procuring or implementing entities are distinct when identified.
_Avoid_: Customer, source, website

**Source**:
An external website or API from which Opportunities are collected.
_Avoid_: Client, portal

**Source Opportunity Identifier**:
An identifier assigned by a Source to the Opportunity shared by its related Bidding Events.
_Avoid_: Bidding Event identifier, internal record identifier
