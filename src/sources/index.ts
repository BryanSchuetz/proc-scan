import type { SourceAdapter } from "./adapter";
import { SourceScanError } from "./adapter";
import { createGrantsGovAdapter, grantsGovSourceDefinition } from "./grants-gov";
import type { GrantsGovConfig } from "./grants-gov";
import { createSamGovAdapter, samGovSourceDefinition } from "./sam-gov";
import type { SamGovConfig } from "./sam-gov";
import { createTedAdapter, tedSourceDefinition } from "./ted";
import type { TedConfig } from "./ted";

export interface SourceSecrets {
  SAM_API_KEY?: string;
}

export interface SourceConfigurations {
  grantsGov: GrantsGovConfig;
  samGov: SamGovConfig;
  ted: TedConfig;
}

export function createRegisteredSourceAdapter(
  sourceId: string,
  secrets: SourceSecrets,
  configurations: SourceConfigurations,
): SourceAdapter {
  switch (sourceId) {
    case grantsGovSourceDefinition.id:
      return createGrantsGovAdapter({
        organizations: configurations.grantsGov.organizations,
      });
    case samGovSourceDefinition.id:
      return createSamGovAdapter({
        apiKey: secrets.SAM_API_KEY ?? "",
        organizations: configurations.samGov.organizations,
      });
    case tedSourceDefinition.id:
      return createTedAdapter({ config: configurations.ted });
    default:
      throw new SourceScanError(
        "adapter_not_registered",
        `No adapter is registered for Source ${sourceId}.`,
        false,
      );
  }
}
