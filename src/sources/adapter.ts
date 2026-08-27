import type { NormalizedBiddingEvent } from "../domain/types";

export type SourceAccessMode = "public" | "api-key" | "login" | "two-factor";

export interface SourceDefinition {
  id: string;
  name: string;
  accessMode: SourceAccessMode;
  phase: 1 | 2 | 3;
  adapterVersion: string;
}

export interface SourceCursor {
  value?: string;
  lookbackStartedAt?: string;
}

export interface SourceCandidate extends Omit<NormalizedBiddingEvent, "discoveredAt"> {
  discoveredAt?: string;
}

export interface SourceScanResult {
  candidates: SourceCandidate[];
  nextCursor?: SourceCursor;
}

export interface SourceScanContext {
  cursor?: SourceCursor;
  signal: AbortSignal;
  now: Date;
}

export interface SourceAdapter {
  readonly definition: SourceDefinition;
  scan(context: SourceScanContext): Promise<SourceScanResult>;
}

export function assertValidSourceAdapter(adapter: SourceAdapter): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.definition.id)) {
    throw new Error(`Invalid Source ID: ${adapter.definition.id}`);
  }
  if (!adapter.definition.name.trim()) throw new Error("A Source name is required");
  if (!adapter.definition.adapterVersion.trim()) throw new Error("An adapter version is required");

  const expectedPhase =
    adapter.definition.accessMode === "public"
      ? 1
      : adapter.definition.accessMode === "two-factor"
        ? 3
        : 2;
  if (adapter.definition.phase !== expectedPhase) {
    throw new Error(
      `Source ${adapter.definition.id} has phase ${adapter.definition.phase}, expected ${expectedPhase}`,
    );
  }
}
