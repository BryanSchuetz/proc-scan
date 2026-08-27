import type { EventsFacets, EventsResponse } from "../api/types";
import { addressabilityStatuses, biddingEventTypes } from "../domain/types";
import type { RetainedBiddingEvent } from "../domain/types";
import type { PriorBiddingEvent } from "../domain/inheritance";

const sortableColumns = {
  discoveredAt: "e.discovered_at",
  publishedAt: "e.published_at",
  eventType: "e.event_type",
  opportunityName: "e.opportunity_name",
  clientName: "e.client_name",
  placeOfPerformance: "e.place_of_performance",
  valueAmount: "e.value_amount",
  dueDate: "e.due_date",
  addressabilityStatus: "e.addressability_status",
  sourceName: "s.display_name",
  technicalAreas: "e.technical_area_labels",
} as const;

type SortField = keyof typeof sortableColumns;
type BindValue = string | number | null;

const supportedParams = new Set([
  "page",
  "pageSize",
  "sort",
  "direction",
  "search",
  "status",
  "eventType",
  "client",
  "source",
  "technicalArea",
  "place",
  "dueFrom",
  "dueTo",
  "discoveredFrom",
  "discoveredTo",
  "valueMin",
  "valueMax",
  "currency",
]);

export interface EventsQuery {
  page: number;
  pageSize: number;
  sort: SortField;
  direction: "asc" | "desc";
  search?: string;
  status?: "addressable" | "uncertain";
  eventType?: "tender" | "modification" | "cancellation";
  client?: string;
  source?: string;
  technicalArea?: string;
  place?: string;
  dueFrom?: string;
  dueTo?: string;
  discoveredFrom?: string;
  discoveredTo?: string;
  valueMin?: number;
  valueMax?: number;
  currency?: string;
}

interface EventRow {
  id: string;
  source_id: string;
  source_name: string;
  source_opportunity_id: string | null;
  source_url: string;
  source_event_type: string | null;
  event_type: "tender" | "modification" | "cancellation";
  opportunity_name: string;
  client_name: string | null;
  place_of_performance: string | null;
  country_code: string | null;
  value_amount: number | null;
  value_currency: string | null;
  due_date: string | null;
  published_at: string | null;
  discovered_at: string;
  addressability_status: "addressable" | "uncertain";
  technical_areas_json: string;
}

interface PriorEventRow {
  id: string;
  source_id: string;
  source_event_id: string | null;
  source_opportunity_id: string | null;
  source_url: string;
  source_event_type: string | null;
  event_type: "tender" | "modification" | "cancellation";
  published_at: string | null;
  discovered_at: string;
  opportunity_name: string;
  description: string | null;
  client_name: string | null;
  funder_names_json: string;
  procuring_entity_name: string | null;
  implementing_entity_names_json: string;
  value_amount: number | null;
  value_currency: string | null;
  due_date: string | null;
  place_of_performance: string | null;
  country_code: string | null;
  eligibility: string | null;
  source_status: string | null;
  source_data_json: string;
  ocds_release_json: string;
  event_identity: string;
  content_fingerprint: string;
  technical_classification_version: number;
  technical_areas_json: string;
}

export interface StoredPriorBiddingEvent extends PriorBiddingEvent {
  eventIdentity: string;
  contentFingerprint: string;
}

export interface PriorBiddingEventMatch {
  exactEvent?: StoredPriorBiddingEvent;
  opportunityEvent?: StoredPriorBiddingEvent;
}

export class EventsQueryError extends Error {}

function positiveInteger(value: string | null, fallback: number, maximum?: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new EventsQueryError(`Expected a positive integer, received: ${value}`);
  const number = Number(value);
  if (number < 1 || (maximum !== undefined && number > maximum)) {
    throw new EventsQueryError(`Value must be between 1 and ${maximum ?? "the supported maximum"}`);
  }
  return number;
}

function optionalNumber(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new EventsQueryError(`${name} must be a number`);
  return number;
}

function optionalDate(value: string | null, name: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (Number.isNaN(Date.parse(value))) throw new EventsQueryError(`${name} must be an ISO date`);
  return value;
}

export function parseEventsQuery(url: URL): EventsQuery {
  for (const key of url.searchParams.keys()) {
    if (!supportedParams.has(key)) throw new EventsQueryError(`Unsupported query parameter: ${key}`);
  }

  const sort = url.searchParams.get("sort") ?? "discoveredAt";
  if (!(sort in sortableColumns)) throw new EventsQueryError(`Unsupported sort field: ${sort}`);

  const direction = url.searchParams.get("direction") ?? "desc";
  if (direction !== "asc" && direction !== "desc") {
    throw new EventsQueryError(`Unsupported sort direction: ${direction}`);
  }

  const status = url.searchParams.get("status");
  if (status && !addressabilityStatuses.slice(0, 2).includes(status as "addressable" | "uncertain")) {
    throw new EventsQueryError(`Unsupported addressability status: ${status}`);
  }

  const eventType = url.searchParams.get("eventType");
  if (eventType && !biddingEventTypes.includes(eventType as EventsQuery["eventType"] & string)) {
    throw new EventsQueryError(`Unsupported Bidding Event Type: ${eventType}`);
  }

  const valueMin = optionalNumber(url.searchParams.get("valueMin"), "valueMin");
  const valueMax = optionalNumber(url.searchParams.get("valueMax"), "valueMax");
  if (valueMin !== undefined && valueMax !== undefined && valueMin > valueMax) {
    throw new EventsQueryError("valueMin cannot exceed valueMax");
  }

  return {
    page: positiveInteger(url.searchParams.get("page"), 1),
    pageSize: positiveInteger(url.searchParams.get("pageSize"), 25, 100),
    sort: sort as SortField,
    direction,
    search: url.searchParams.get("search")?.trim() || undefined,
    status: status as EventsQuery["status"],
    eventType: eventType as EventsQuery["eventType"],
    client: url.searchParams.get("client")?.trim() || undefined,
    source: url.searchParams.get("source")?.trim() || undefined,
    technicalArea: url.searchParams.get("technicalArea")?.trim() || undefined,
    place: url.searchParams.get("place")?.trim() || undefined,
    dueFrom: optionalDate(url.searchParams.get("dueFrom"), "dueFrom"),
    dueTo: optionalDate(url.searchParams.get("dueTo"), "dueTo"),
    discoveredFrom: optionalDate(url.searchParams.get("discoveredFrom"), "discoveredFrom"),
    discoveredTo: optionalDate(url.searchParams.get("discoveredTo"), "discoveredTo"),
    valueMin,
    valueMax,
    currency: url.searchParams.get("currency")?.trim().toUpperCase() || undefined,
  };
}

function ftsQuery(search: string): string {
  return search
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function buildWhere(query: EventsQuery): { sql: string; values: BindValue[] } {
  const clauses = ["1 = 1"];
  const values: BindValue[] = [];
  const add = (clause: string, value: BindValue) => {
    clauses.push(clause);
    values.push(value);
  };

  if (query.search) add("e.rowid IN (SELECT rowid FROM bidding_events_fts WHERE bidding_events_fts MATCH ?)", ftsQuery(query.search));
  if (query.status) add("e.addressability_status = ?", query.status);
  if (query.eventType) add("e.event_type = ?", query.eventType);
  if (query.client) add("e.client_name = ?", query.client);
  if (query.source) add("e.source_id = ?", query.source);
  if (query.place) add("LOWER(e.place_of_performance) LIKE '%' || LOWER(?) || '%'", query.place);
  if (query.dueFrom) add("e.due_date >= ?", query.dueFrom);
  if (query.dueTo) add("e.due_date <= ?", query.dueTo);
  if (query.discoveredFrom) add("e.discovered_at >= ?", query.discoveredFrom);
  if (query.discoveredTo) add("e.discovered_at <= ?", query.discoveredTo);
  if (query.valueMin !== undefined) add("e.value_amount >= ?", query.valueMin);
  if (query.valueMax !== undefined) add("e.value_amount <= ?", query.valueMax);
  if (query.currency) add("e.value_currency = ?", query.currency);
  if (query.technicalArea === "unclassified") {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM bidding_event_technical_areas assignment
      WHERE assignment.bidding_event_id = e.id
    )`);
  } else if (query.technicalArea) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM bidding_event_technical_areas assignment
      WHERE assignment.bidding_event_id = e.id
        AND assignment.technical_area_id IN (
          WITH RECURSIVE descendants(id) AS (
            SELECT id FROM technical_areas WHERE id = ?
            UNION ALL
            SELECT child.id
            FROM technical_areas child
            JOIN descendants parent ON child.parent_id = parent.id
          )
          SELECT id FROM descendants
        )
    )`);
    values.push(query.technicalArea);
  }

  return { sql: clauses.join(" AND "), values };
}

async function loadFacets(db: D1Database): Promise<EventsFacets> {
  const [clientResult, sourceResult, technicalAreaResult, fixtureResult, unclassifiedResult] = await Promise.all([
    db.prepare("SELECT DISTINCT client_name AS value FROM bidding_events WHERE client_name IS NOT NULL ORDER BY client_name")
      .all<{ value: string }>(),
    db.prepare(`SELECT DISTINCT s.id, s.display_name AS name
      FROM sources s JOIN bidding_events e ON e.source_id = s.id ORDER BY s.display_name`)
      .all<{ id: string; name: string }>(),
    db.prepare(`WITH RECURSIVE included(id) AS (
        SELECT DISTINCT technical_area_id FROM bidding_event_technical_areas
        UNION
        SELECT area.parent_id
        FROM technical_areas area
        JOIN included child ON area.id = child.id
        WHERE area.parent_id IS NOT NULL
      )
      SELECT area.id, area.name, area.parent_id
      FROM technical_areas area
      JOIN included ON included.id = area.id
      ORDER BY area.name`)
      .all<{ id: string; name: string; parent_id: string | null }>(),
    db.prepare("SELECT EXISTS(SELECT 1 FROM sources WHERE adapter_version LIKE 'fixture-%') AS fixture_data")
      .first<{ fixture_data: number }>(),
    db.prepare(`SELECT EXISTS(
      SELECT 1 FROM bidding_events event
      WHERE NOT EXISTS (
        SELECT 1 FROM bidding_event_technical_areas assignment
        WHERE assignment.bidding_event_id = event.id
      )
    ) AS has_unclassified`).first<{ has_unclassified: number }>(),
  ]);

  const technicalAreas = technicalAreaResult.results.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    parentId: row.parent_id ? String(row.parent_id) : undefined,
  }));
  if (unclassifiedResult?.has_unclassified) {
    technicalAreas.push({ id: "unclassified", name: "Unclassified", parentId: undefined });
  }

  return {
    clients: clientResult.results.map((row) => String(row.value)),
    sources: sourceResult.results.map((row) => ({ id: String(row.id), name: String(row.name) })),
    technicalAreas,
    fixtureData: Boolean(fixtureResult?.fixture_data),
  };
}

export async function listBiddingEvents(db: D1Database, query: EventsQuery): Promise<EventsResponse> {
  const where = buildWhere(query);
  const from = `FROM bidding_events e JOIN sources s ON s.id = e.source_id WHERE ${where.sql}`;
  const technicalAreas = `(SELECT COALESCE(json_group_array(json_object(
    'id', ta.id, 'name', ta.name, 'parentId', ta.parent_id
  )), '[]')
    FROM bidding_event_technical_areas assignment
    JOIN technical_areas ta ON ta.id = assignment.technical_area_id
    WHERE assignment.bidding_event_id = e.id) AS technical_areas_json`;
  const select = `SELECT
    e.id, e.source_id, s.display_name AS source_name, e.source_opportunity_id,
    e.source_url, e.source_event_type, e.event_type, e.opportunity_name, e.client_name,
    e.place_of_performance, e.country_code, e.value_amount, e.value_currency,
    e.due_date, e.published_at, e.discovered_at, e.addressability_status,
    ${technicalAreas}
  ${from}
  ORDER BY ${sortableColumns[query.sort]} ${query.direction.toUpperCase()}, e.id ASC
  LIMIT ? OFFSET ?`;
  const offset = (query.page - 1) * query.pageSize;

  const [countResult, itemResult, facets] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...where.values).first<{ total: number }>(),
    db.prepare(select).bind(...where.values, query.pageSize, offset).all<EventRow>(),
    loadFacets(db),
  ]);

  const total = Number(countResult?.total ?? 0);
  return {
    items: itemResult.results.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceOpportunityId: row.source_opportunity_id ?? undefined,
      sourceUrl: row.source_url,
      sourceEventType: row.source_event_type ?? undefined,
      eventType: row.event_type,
      opportunityName: row.opportunity_name,
      clientName: row.client_name ?? undefined,
      placeOfPerformance: row.place_of_performance ?? undefined,
      countryCode: row.country_code ?? undefined,
      valueAmount: row.value_amount ?? undefined,
      valueCurrency: row.value_currency ?? undefined,
      dueDate: row.due_date ?? undefined,
      publishedAt: row.published_at ?? undefined,
      discoveredAt: row.discovered_at,
      addressabilityStatus: row.addressability_status,
      technicalAreas: JSON.parse(row.technical_areas_json),
    })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      pageCount: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    },
    facets,
  };
}

function priorEventFromRow(row: PriorEventRow): StoredPriorBiddingEvent {
  const ocds = JSON.parse(row.ocds_release_json) as RetainedBiddingEvent["ocdsRelease"];
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceEventId: row.source_event_id ?? undefined,
    sourceOpportunityId: row.source_opportunity_id ?? undefined,
    canonicalUrl: row.source_url,
    originalEventType: row.source_event_type ?? undefined,
    eventType: row.event_type,
    publishedAt: row.published_at ?? undefined,
    discoveredAt: row.discovered_at,
    opportunityName: row.opportunity_name,
    description: row.description ?? undefined,
    clientName: row.client_name ?? undefined,
    funderNames: JSON.parse(row.funder_names_json),
    procuringEntityName: row.procuring_entity_name ?? undefined,
    implementingEntityNames: JSON.parse(row.implementing_entity_names_json),
    value: row.value_amount === null && row.value_currency === null
      ? undefined
      : {
          amount: row.value_amount ?? undefined,
          currency: row.value_currency ?? undefined,
        },
    dueDate: row.due_date ?? undefined,
    placeOfPerformance: row.place_of_performance === null && row.country_code === null
      ? undefined
      : {
          description: row.place_of_performance ?? undefined,
          countryCode: row.country_code ?? undefined,
        },
    eligibility: row.eligibility ?? undefined,
    sourceStatus: row.source_status ?? undefined,
    documents: ocds.tender.documents,
    sourceData: JSON.parse(row.source_data_json),
    eventIdentity: row.event_identity,
    contentFingerprint: row.content_fingerprint,
    technicalClassificationVersion: row.technical_classification_version,
    technicalAreas: JSON.parse(row.technical_areas_json),
  };
}

async function findPrior(
  db: D1Database,
  sourceId: string,
  field: "event_identity" | "source_opportunity_id",
  value: string,
): Promise<StoredPriorBiddingEvent | undefined> {
  const row = await db.prepare(`SELECT
      e.id, e.source_id, e.source_event_id, e.source_opportunity_id, e.source_url,
      e.source_event_type, e.event_type, e.published_at, e.discovered_at,
      e.opportunity_name, e.description, e.client_name, e.funder_names_json,
      e.procuring_entity_name, e.implementing_entity_names_json, e.value_amount,
      e.value_currency, e.due_date, e.place_of_performance, e.country_code,
      e.eligibility, e.source_status, e.source_data_json, e.ocds_release_json,
      e.event_identity, e.content_fingerprint, e.technical_classification_version,
      (SELECT COALESCE(json_group_array(json_object(
        'id', area.id,
        'name', area.name,
        'parentId', area.parent_id,
        'score', assignment.score,
        'evidence', json(assignment.evidence_json)
      )), '[]')
        FROM bidding_event_technical_areas assignment
        JOIN technical_areas area ON area.id = assignment.technical_area_id
        WHERE assignment.bidding_event_id = e.id) AS technical_areas_json
    FROM bidding_events e
    WHERE e.source_id = ? AND e.${field} = ?
    ORDER BY COALESCE(e.published_at, e.discovered_at) DESC, e.discovered_at DESC, e.rowid DESC
    LIMIT 1`)
    .bind(sourceId, value)
    .first<PriorEventRow>();
  return row ? priorEventFromRow(row) : undefined;
}

export async function findPriorBiddingEvent(
  db: D1Database,
  sourceId: string,
  eventIdentity: string,
  sourceOpportunityId?: string,
): Promise<PriorBiddingEventMatch> {
  const [exactEvent, opportunityEvent] = await Promise.all([
    findPrior(db, sourceId, "event_identity", eventIdentity),
    sourceOpportunityId
      ? findPrior(db, sourceId, "source_opportunity_id", sourceOpportunityId)
      : Promise.resolve(undefined),
  ]);
  return { exactEvent, opportunityEvent };
}

function retainedEventValues(event: RetainedBiddingEvent, labels: string): BindValue[] {
  return [
    event.id,
    event.sourceId,
    event.scanRunId,
    event.eventIdentity,
    event.contentFingerprint,
    event.sourceEventId ?? null,
    event.sourceOpportunityId ?? null,
    event.canonicalUrl,
    event.originalEventType ?? null,
    event.eventType,
    event.opportunityName,
    event.description ?? null,
    event.clientName ?? null,
    JSON.stringify(event.funderNames ?? []),
    event.procuringEntityName ?? null,
    JSON.stringify(event.implementingEntityNames ?? []),
    event.placeOfPerformance?.description ?? null,
    event.placeOfPerformance?.countryCode ?? null,
    event.value?.amount ?? null,
    event.value?.currency ?? null,
    event.dueDate ?? null,
    event.eligibility ?? null,
    event.sourceStatus ?? null,
    event.publishedAt ?? null,
    event.discoveredAt,
    JSON.stringify(event.ocdsRelease),
    JSON.stringify(event.sourceData),
    JSON.stringify(event.inheritedFields),
    event.addressability.status,
    event.addressability.score,
    event.addressability.configVersion,
    JSON.stringify(event.addressability.matchedRules),
    event.technicalClassificationVersion,
    labels,
  ];
}

function technicalAreaStatements(db: D1Database, event: RetainedBiddingEvent, eventId: string) {
  return event.technicalAreas.map((area) =>
    db.prepare(`INSERT OR IGNORE INTO bidding_event_technical_areas (
      bidding_event_id, technical_area_id, score, evidence_json
    ) VALUES (?, ?, ?, ?)`).bind(eventId, area.id, area.score, JSON.stringify(area.evidence)),
  );
}

export async function persistRetainedBiddingEvent(
  db: D1Database,
  event: RetainedBiddingEvent,
): Promise<boolean> {
  const labels = event.technicalAreas.length > 0
    ? event.technicalAreas.map((area) => area.name).join(" | ")
    : "Unclassified";
  const insert = db.prepare(`INSERT OR IGNORE INTO bidding_events (
    id, source_id, scan_run_id, event_identity, content_fingerprint,
    source_event_id, source_opportunity_id, source_url, source_event_type, event_type,
    opportunity_name, description, client_name, funder_names_json, procuring_entity_name,
    implementing_entity_names_json, place_of_performance, country_code, value_amount,
    value_currency, due_date, eligibility, source_status, published_at, discovered_at,
    ocds_release_json, source_data_json, inherited_fields_json, addressability_status,
    addressability_score, addressability_config_version, addressability_evidence_json,
    technical_classification_version, technical_area_labels
  ) VALUES (${Array.from({ length: 34 }, () => "?").join(", ")})`).bind(
    ...retainedEventValues(event, labels),
  );
  const assignments = technicalAreaStatements(db, event, event.id);
  const results = await db.batch([insert, ...assignments]);
  return (results[0].meta.changes ?? 0) > 0;
}

export async function updateRetainedBiddingEvent(
  db: D1Database,
  existingEventId: string,
  event: RetainedBiddingEvent,
): Promise<void> {
  const labels = event.technicalAreas.length > 0
    ? event.technicalAreas.map((area) => area.name).join(" | ")
    : "Unclassified";
  const columns = [
    "source_id", "scan_run_id", "event_identity", "content_fingerprint",
    "source_event_id", "source_opportunity_id", "source_url", "source_event_type", "event_type",
    "opportunity_name", "description", "client_name", "funder_names_json", "procuring_entity_name",
    "implementing_entity_names_json", "place_of_performance", "country_code", "value_amount",
    "value_currency", "due_date", "eligibility", "source_status", "published_at", "discovered_at",
    "ocds_release_json", "source_data_json", "inherited_fields_json", "addressability_status",
    "addressability_score", "addressability_config_version", "addressability_evidence_json",
    "technical_classification_version", "technical_area_labels",
  ];
  const update = db.prepare(`UPDATE bidding_events SET
    ${columns.map((column) => `${column} = ?`).join(",\n    ")}
    WHERE id = ?`).bind(...retainedEventValues(event, labels).slice(1), existingEventId);
  const assignments = technicalAreaStatements(db, event, existingEventId);
  await db.batch([
    update,
    db.prepare("DELETE FROM bidding_event_technical_areas WHERE bidding_event_id = ?").bind(existingEventId),
    ...assignments,
  ]);
}
