import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiBiddingEvent, EventsResponse } from "../api/types";
import daiLogoUrl from "./assets/dai-logo.svg";
import { fetchBiddingEvents } from "./api";

const columnHelper = createColumnHelper<ApiBiddingEvent>();
const initialSorting: SortingState = [{ id: "discoveredAt", desc: true }];
type RegistryPath = "/" | "/unmarked";

function getRegistryPath(): RegistryPath {
  return window.location.pathname.replace(/\/+$/, "") === "/unmarked" ? "/unmarked" : "/";
}

function formatDate(value: string | undefined): string {
  if (!value) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatMoney(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return "Not provided";
  const number = new Intl.NumberFormat("en-US", {
    notation: Math.abs(amount) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(amount);
  return currency ? `${number} ${currency}` : `${number} (currency not provided)`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debounced;
}

function SortIndicator({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") return <CaretUpIcon aria-hidden="true" size={14} weight="bold" />;
  return <CaretDownIcon aria-hidden="true" size={14} weight="bold" />;
}

interface ColumnMenuOption {
  value: string;
  label: string;
}

interface ColumnMenuProps {
  label: React.ReactNode;
  accessibleLabel: string;
  sortDirection: false | "asc" | "desc";
  onSort: (direction: "asc" | "desc") => void;
  filterValue: string;
  filterOptions: ColumnMenuOption[];
  onFilter: (value: string) => void;
}

function ColumnMenu({
  label,
  accessibleLabel,
  sortDirection,
  onSort,
  filterValue,
  filterOptions,
  onFilter,
}: ColumnMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="column-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="column-menu__trigger"
        aria-label={`${accessibleLabel}: sort and filter`}
        aria-expanded={open}
        aria-controls={menuId}
        data-active={sortDirection !== false || filterValue !== ""}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <CaretUpDownIcon aria-hidden="true" size={14} />
      </button>
      {open && (
        <div
          id={menuId}
          className="column-menu__popover"
          role="group"
          aria-label={`${accessibleLabel} sort and filter options`}
        >
          <span className="column-menu__section-label">Sort</span>
          {(["asc", "desc"] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              aria-pressed={sortDirection === direction}
              onClick={() => {
                onSort(direction);
                setOpen(false);
              }}
            >
              <span>{direction === "asc" ? "Sort ascending" : "Sort descending"}</span>
              {sortDirection === direction && <CheckIcon aria-hidden="true" size={15} weight="bold" />}
            </button>
          ))}
          <span className="column-menu__section-label">Filter</span>
          {filterOptions.map((option) => {
            const resetsActiveFilter = option.value === "" && filterValue !== "";
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={filterValue === option.value}
                onClick={() => {
                  onFilter(option.value);
                  setOpen(false);
                }}
              >
                <span>{resetsActiveFilter ? `Reset ${accessibleLabel} filter` : option.label}</span>
                {resetsActiveFilter
                  ? <XIcon aria-hidden="true" size={15} />
                  : filterValue === option.value && <CheckIcon aria-hidden="true" size={15} weight="bold" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Missing({ children }: { children?: React.ReactNode }) {
  return children ? <>{children}</> : <span className="missing-value">Not provided</span>;
}

function LoadingRows() {
  return (
    <tbody aria-label="Loading Bidding Events">
      {Array.from({ length: 7 }, (_, row) => (
        <tr key={row} className="skeleton-row">
          {Array.from({ length: 10 }, (_, cell) => (
            <td key={cell}><span className="skeleton-line" /></td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export default function App() {
  const [pathname, setPathname] = useState<RegistryPath>(getRegistryPath);
  const isUnmarkedPage = pathname === "/unmarked";
  const status = isUnmarkedPage ? "uncertain" : "addressable";
  const [data, setData] = useState<EventsResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [search, setSearch] = useState("");
  const [eventType, setEventType] = useState("");
  const [client, setClient] = useState("");
  const [source, setSource] = useState("");
  const [technicalArea, setTechnicalArea] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);

  const applyRoute = useCallback((nextPath: RegistryPath) => {
    setPathname(nextPath);
    setData(undefined);
    setLoading(true);
    setError(undefined);
    setPage(1);
    setSorting(initialSorting);
    setSearch("");
    setEventType("");
    setClient("");
    setSource("");
    setTechnicalArea("");
  }, []);

  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, nextPath: RegistryPath) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (pathname === nextPath) return;
    window.history.pushState(null, "", nextPath);
    applyRoute(nextPath);
  };

  useEffect(() => {
    const handlePopState = () => {
      const nextPath = getRegistryPath();
      applyRoute(nextPath);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyRoute]);

  useEffect(() => {
    document.title = `${isUnmarkedPage ? "Unmarked" : "Marked"} Opportunities | Procurement Opportunity Registry`;
  }, [isUnmarkedPage]);

  const sort = sorting[0] ?? initialSorting[0];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchBiddingEvents(
      {
        page,
        pageSize: 25,
        sort: sort.id,
        direction: sort.desc ? "desc" : "asc",
        search: debouncedSearch,
        status,
        eventType,
        client,
        source,
        technicalArea,
      },
      controller.signal,
    )
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "The registry could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, debouncedSearch, eventType, page, reload, sort.desc, sort.id, source, status, technicalArea]);

  useEffect(() => setPage(1), [client, debouncedSearch, eventType, source, technicalArea]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("discoveredAt", {
        header: "Discovered",
        cell: (info) => <time dateTime={info.getValue()}>{formatDate(info.getValue())}</time>,
      }),
      columnHelper.accessor("eventType", {
        header: "Event type",
        cell: (info) => <span className={`event-type event-type--${info.getValue()}`}>{titleCase(info.getValue())}</span>,
      }),
      columnHelper.accessor("opportunityName", {
        header: "Opportunity",
        cell: (info) => (
          <div className="opportunity-cell">
            <a href={info.row.original.sourceUrl} target="_blank" rel="noreferrer">
              {info.getValue()}
              <ArrowSquareOutIcon aria-hidden="true" size={14} weight="bold" />
            </a>
            {info.row.original.sourceOpportunityId && (
              <span>ID {info.row.original.sourceOpportunityId}</span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor("clientName", {
        header: "Client",
        cell: (info) => <Missing>{info.getValue()}</Missing>,
      }),
      columnHelper.accessor("placeOfPerformance", {
        header: "Place",
        cell: (info) => (
          <Missing>
            {info.getValue() && (
              <span>{info.getValue()}{info.row.original.countryCode ? ` · ${info.row.original.countryCode}` : ""}</span>
            )}
          </Missing>
        ),
      }),
      columnHelper.accessor("valueAmount", {
        header: "Value",
        cell: (info) => <span className={info.getValue() === undefined ? "missing-value" : "numeric"}>{formatMoney(info.getValue(), info.row.original.valueCurrency)}</span>,
      }),
      columnHelper.accessor("dueDate", {
        header: "Due date",
        cell: (info) => <span className={info.getValue() ? undefined : "missing-value"}>{formatDate(info.getValue())}</span>,
      }),
      columnHelper.accessor(
        (row) => row.technicalAreas.map((area) => area.name).join(", "),
        {
          id: "technicalAreas",
          header: "Technical areas",
          cell: (info) => (
            <div className="area-list">
              {info.row.original.technicalAreas.length > 0
                ? info.row.original.technicalAreas.map((area) => <span key={area.id}>{area.name}</span>)
                : <span className="unclassified">Unclassified</span>}
            </div>
          ),
        },
      ),
      columnHelper.accessor("sourceName", {
        header: "Source",
      }),
      columnHelper.accessor("publishedAt", {
        header: "Published",
        cell: (info) => <span className={info.getValue() ? undefined : "missing-value"}>{formatDate(info.getValue())}</span>,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    state: { sorting },
    onSortingChange: (update) => {
      setSorting((current) => {
        const next = typeof update === "function" ? update(current) : update;
        return next.length > 0 ? next.slice(0, 1) : initialSorting;
      });
      setPage(1);
    },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
  });

  const hasFilters = Boolean(search || eventType || client || source || technicalArea);
  const clearFilters = () => {
    setSearch("");
    setEventType("");
    setClient("");
    setSource("");
    setTechnicalArea("");
  };

  const columnMenuFor = (columnId: string) => {
    switch (columnId) {
      case "eventType":
        return {
          accessibleLabel: "Event Type",
          filterValue: eventType,
          onFilter: setEventType,
          filterOptions: [
            { value: "", label: "All types" },
            { value: "tender", label: "Tender" },
            { value: "modification", label: "Modification" },
            { value: "cancellation", label: "Cancellation" },
          ],
        };
      case "clientName":
        return {
          accessibleLabel: "Client",
          filterValue: client,
          onFilter: setClient,
          filterOptions: [
            { value: "", label: "All Clients" },
            ...(data?.facets.clients.map((name) => ({ value: name, label: name })) ?? []),
          ],
        };
      case "sourceName":
        return {
          accessibleLabel: "Source",
          filterValue: source,
          onFilter: setSource,
          filterOptions: [
            { value: "", label: "All Sources" },
            ...(data?.facets.sources.map((item) => ({ value: item.id, label: item.name })) ?? []),
          ],
        };
      case "technicalAreas":
        return {
          accessibleLabel: "Technical Areas",
          filterValue: technicalArea,
          onFilter: setTechnicalArea,
          filterOptions: [
            { value: "", label: "All areas" },
            ...(data?.facets.technicalAreas.map((area) => ({ value: area.id, label: area.name })) ?? []),
          ],
        };
      default:
        return undefined;
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-logo">
          <img src={daiLogoUrl} alt="DAI" />
        </div>
        <div>
          <p className="eyebrow">Procurement scrub</p>
          <h1>Registry</h1>
        </div>
        <div className="header-meta">
          <span className="read-only-indicator">Read only</span>
          <span>Scans at 6:00 AM &amp; 6:00 PM ET</span>
        </div>
      </header>

      <main>
        <section className="registry-heading" aria-labelledby="registry-title">
          <div>
            <p className="section-kicker">Bidding Events</p>
            <h2 id="registry-title">{isUnmarkedPage ? "Unmarked Opportunities" : "Marked Opportunities"}</h2>
            <p className="registry-description">
              {isUnmarkedPage
                ? "A table of all bidding events identified as failing to meet established thresholds—but not explicitly excluded."
                : "A table of all bidding events identified as meeting established thresholds."}
            </p>
            <nav className="view-tabs" aria-label="Opportunity views">
              <a href="/" aria-current={isUnmarkedPage ? undefined : "page"} onClick={(event) => navigate(event, "/")}>Marked</a>
              <a href="/unmarked" aria-current={isUnmarkedPage ? "page" : undefined} onClick={(event) => navigate(event, "/unmarked")}>Unmarked</a>
            </nav>
          </div>
          <div className="record-count" aria-live="polite">
            <strong>{loading && !data ? "..." : data?.pagination.total ?? 0}</strong>
            <span>matching records</span>
          </div>
        </section>

        {data?.facets.fixtureData && (
          <div className="fixture-notice" role="status">
            <strong>Foundation preview</strong>
            <span>These records are local fixtures, not live procurement opportunities.</span>
          </div>
        )}

        <section className="registry-panel" aria-label="Bidding Event registry">
          <div className="toolbar">
            <label className="search-field">
              <span>Search records</span>
              <div>
                <MagnifyingGlassIcon aria-hidden="true" size={18} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search opportunities"
                />
                {search && (
                  <button type="button" onClick={() => setSearch("")} aria-label="Clear search">
                    <XIcon aria-hidden="true" size={16} />
                  </button>
                )}
              </div>
            </label>
            {hasFilters && (
              <button className="clear-filters" type="button" onClick={clearFilters}>
                <XIcon aria-hidden="true" size={15} /> Clear filters
              </button>
            )}
          </div>

          <div className="table-summary">
            <span>{data ? `Showing ${data.items.length} of ${data.pagination.total}` : "Loading records"}</span>
            <span className="desktop-table-hint">Newest discovered first</span>
            <span className="mobile-table-hint">Scroll horizontally for more columns</span>
          </div>

          <div className="table-scroll" role="region" tabIndex={0} aria-label="Scrollable Bidding Events table">
            <table>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const columnMenu = columnMenuFor(header.column.id);
                      const sortDirection = header.column.getIsSorted();
                      return (
                        <th key={header.id} scope="col" aria-sort={
                          sortDirection === "asc" ? "ascending" :
                            sortDirection === "desc" ? "descending" : undefined
                        }>
                          <div className="column-header">
                            {columnMenu ? (
                              <ColumnMenu
                                label={flexRender(header.column.columnDef.header, header.getContext())}
                                sortDirection={sortDirection}
                                onSort={(direction) => header.column.toggleSorting(direction === "desc")}
                                {...columnMenu}
                              />
                            ) : header.column.getCanSort() ? (
                              <button
                                type="button"
                                data-active={sortDirection !== false}
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                <SortIndicator direction={sortDirection} />
                              </button>
                            ) : flexRender(header.column.columnDef.header, header.getContext())}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              {loading && !data ? <LoadingRows /> : (
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))}
                  {!loading && !error && data?.items.length === 0 && (
                    <tr className="empty-table-row">
                      <td colSpan={columns.length}>
                        <div className="state-message">
                          <strong>{hasFilters ? "No records match these filters" : "No Bidding Events yet"}</strong>
                          <span>
                            {hasFilters
                              ? "Adjust or reset the active filter or search above to broaden the results."
                              : "Retained events will appear after a Source scan."}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              )}
            </table>
          </div>

          {error && (
            <div className="state-message state-message--error" role="alert">
              <strong>Unable to load Bidding Events</strong>
              <span>{error}</span>
              <button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
            </div>
          )}

          {data && data.pagination.pageCount > 0 && (
            <nav className="pagination" aria-label="Registry pages">
              <span>Page {data.pagination.page} of {data.pagination.pageCount}</span>
              <div>
                <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>
                  <CaretLeftIcon aria-hidden="true" size={16} /> Previous
                </button>
                <button type="button" disabled={page >= data.pagination.pageCount || loading} onClick={() => setPage((value) => value + 1)}>
                  Next <CaretRightIcon aria-hidden="true" size={16} />
                </button>
              </div>
            </nav>
          )}
        </section>
      </main>
    </div>
  );
}
