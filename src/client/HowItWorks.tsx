import { InfoIcon } from "@phosphor-icons/react";

interface HowItWorksProps {
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, path: "/" | "/unmarked" | "/how-it-works") => void;
}

const euClients = "DG AGRI, DG CLIMA, DG ECHO, DG CINEA, DG GROW, DG IDEA, DG REA, DG INTPA, DG DEV, DG ENEST, DG MENA, and DG TRADE";

const sources = [
  {
    name: "FCDO Jaggaer Public",
    clients: "FCDO",
    value: "£250,000",
    scope: "Services competitions and early market engagement. Goods, frameworks, and call-downs are excluded.",
  },
  {
    name: "DEFRA Atamis",
    clients: "DEFRA group",
    value: "£250,000",
    scope: "Current opportunities with an active response deadline. Closed opportunities are excluded.",
  },
  {
    name: "DEZNZ Jaggaer",
    clients: "DEZNZ",
    value: "£250,000",
    scope: "Services only. Shared DEZNZ and DSIT listings need clear DEZNZ evidence; DSIT-only and former BEIS opportunities are excluded.",
  },
  {
    name: "TED",
    clients: euClients,
    value: "€1 million",
    scope: "Active external-aid planning and competition notices. Results and post-award notices are excluded.",
  },
  {
    name: "EU Funding & Tenders",
    clients: euClients,
    value: "€1 million",
    scope: "Forthcoming and open calls for tenders. Grant topics are not included because the responsible Directorate-General cannot be confirmed reliably.",
  },
  {
    name: "SAM.gov",
    clients: "DOS, MCC, DFC, USTDA, and Millennium Challenge Accounts",
    value: "$500,000 for DOS, MCC, and DFC; $250,000 for USTDA and country Millennium Challenge Accounts",
    scope: "Pre-award opportunities only. Known product and service codes outside professional and management support, manufacturing sectors, awards, and surplus sales are excluded.",
  },
  {
    name: "Grants.gov",
    clients: "DOS, MCC, DFC, USTDA, and Millennium Challenge Accounts",
    value: "$2 million for DOS; $500,000 for MCC and DFC; $250,000 for USTDA and country Millennium Challenge Accounts",
    scope: "Forecasted and posted opportunities from the approved organizations. Closed and archived opportunities are excluded.",
  },
  {
    name: "EBRD ECEPP",
    clients: "EBRD",
    value: "€250,000 or $250,000",
    scope: "Consultancy or clearly advisory opportunities with a future closing date. Closed and post-award notices are excluded.",
  },
  {
    name: "EIB Procurement",
    clients: "EIB",
    value: "€500,000",
    scope: "Ongoing technical-assistance operations with a current closing date. Stale and closed records are excluded.",
  },
  {
    name: "FMO Open Tenders",
    clients: "FMO",
    value: "€500,000",
    scope: "Open tender listings. Opportunities remain visible only while their deadline is current.",
  },
];

export default function HowItWorks({ onNavigate }: HowItWorksProps) {
  return (
    <main className="how-page">
      <section className="how-hero" aria-labelledby="how-title">
        <p className="section-kicker">About the registry</p>
        <h2 id="how-title">How opportunities reach the registry</h2>
        <p>
          The registry scans selected procurement sources, applies agreed business boundaries, and keeps the opportunities that merit review.
        </p>
        <nav className="view-tabs" aria-label="Registry views">
          <a href="/" onClick={(event) => onNavigate(event, "/")}>Marked</a>
          <a href="/unmarked" onClick={(event) => onNavigate(event, "/unmarked")}>Unmarked</a>
          <a className="view-tabs__info" href="/how-it-works" aria-current="page" onClick={(event) => onNavigate(event, "/how-it-works")}>
            How it works
            <InfoIcon aria-hidden="true" size={16} weight="bold" />
          </a>
        </nav>
      </section>

      <section className="how-flow" aria-labelledby="flow-title">
        <div className="how-section-heading">
          <h3 id="flow-title">From source to registry</h3>
          <p>Each event follows the same sequence. An event that fails a hard exclusion is not shown in either registry view.</p>
        </div>
        <ol className="flow-list">
          <li>
            <strong>Sources are scanned twice daily</strong>
            <span>New and changed notices are checked at 6:00 AM and 6:00 PM Eastern Time.</span>
          </li>
          <li>
            <strong>Source boundaries are applied</strong>
            <span>Each source has an approved set of clients and opportunity types. Records outside that scope are left out.</span>
          </li>
          <li>
            <strong>Hard exclusions remove clear non-candidates</strong>
            <span>Expired events, known values below the applicable floor, and source-specific exclusions do not enter the registry.</span>
          </li>
          <li>
            <strong>Retained events are assessed for fit</strong>
            <span>Title and description language determines whether an event appears as Marked or Unmarked.</span>
          </li>
        </ol>
      </section>

      <section className="outcome-section" aria-labelledby="outcomes-title">
        <div className="how-section-heading">
          <h3 id="outcomes-title">Marked, Unmarked, and Excluded</h3>
          <p>The registry is intentionally inclusive after hard exclusions, so uncertain opportunities remain available for human review.</p>
        </div>
        <div className="outcome-grid">
          <article className="outcome outcome--marked">
            <h4>Marked</h4>
            <p>The event meets the addressability threshold. Clear DAI-fit language strengthens the result. An event with both fit and mismatch signals also remains Marked.</p>
          </article>
          <article className="outcome outcome--unmarked">
            <h4>Unmarked</h4>
            <p>The event passed every hard exclusion, but its wording suggests a mismatch without balancing DAI-fit evidence. It stays visible for review rather than being discarded.</p>
          </article>
          <article className="outcome outcome--excluded">
            <h4>Excluded</h4>
            <p>The event is outside an approved client or source scope, expired, below a known value floor, or matches another source-specific hard exclusion. It does not appear in the registry.</p>
          </article>
        </div>
        <div className="fit-language">
          <div>
            <h4>Signals that support DAI fit</h4>
            <p>Examples include technical assistance, advisory, capacity building, governance, climate, education, global health, digital, monitoring and evaluation, market systems, resilience, and training.</p>
          </div>
          <div>
            <h4>Signals that suggest a mismatch</h4>
            <p>Examples include construction, engineering, goods, equipment, vehicles, facilities maintenance, guarding, insurance, cleaning, catering, office supplies, and building works.</p>
          </div>
        </div>
      </section>

      <section className="event-section" aria-labelledby="events-title">
        <div className="how-section-heading">
          <h3 id="events-title">What the event types mean</h3>
          <p>One opportunity can have more than one bidding event over its lifetime.</p>
        </div>
        <dl className="event-definitions">
          <div>
            <dt><span className="event-type event-type--tender">Tender</span></dt>
            <dd>The initial publication of an opportunity, including a grant opportunity.</dd>
          </div>
          <div>
            <dt><span className="event-type event-type--modification">Modification</span></dt>
            <dd>A later publication or detected change that revises a known deadline or amount.</dd>
          </div>
          <div>
            <dt><span className="event-type event-type--cancellation">Cancellation</span></dt>
            <dd>A publication that withdraws a previously published opportunity.</dd>
          </div>
        </dl>
      </section>

      <section className="sources-section" aria-labelledby="sources-title">
        <div className="how-section-heading">
          <h3 id="sources-title">Current source coverage</h3>
          <p>These are the client and value boundaries used for sources currently represented in the registry.</p>
        </div>
        <div className="source-boundary-note">
          Zero or unknown values are not excluded by the threshold. Past due dates are excluded for all sources.
        </div>
        <div className="source-list" role="list">
          {sources.map((source) => (
            <article className="source-row" role="listitem" key={source.name}>
              <h4>{source.name}</h4>
              <div>
                <span>Included clients</span>
                <p>{source.clients}</p>
              </div>
              <div>
                <span>Minimum known value</span>
                <p>{source.value}</p>
              </div>
              <div>
                <span>Other hard boundaries</span>
                <p>{source.scope}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
