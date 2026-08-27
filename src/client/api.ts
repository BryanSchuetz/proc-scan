import type { ApiError, EventsResponse } from "../api/types";

export interface RegistryQuery {
  page: number;
  pageSize: number;
  sort: string;
  direction: "asc" | "desc";
  search: string;
  status: string;
  eventType: string;
  client: string;
  source: string;
  technicalArea: string;
}

export async function fetchBiddingEvents(
  query: RegistryQuery,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
    direction: query.direction,
  });
  for (const key of ["search", "status", "eventType", "client", "source", "technicalArea"] as const) {
    if (query[key]) params.set(key, query[key]);
  }

  const response = await fetch(`/api/opportunities?${params}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiError | undefined;
    throw new Error(error?.error.message ?? "The registry could not be loaded.");
  }
  return response.json() as Promise<EventsResponse>;
}
