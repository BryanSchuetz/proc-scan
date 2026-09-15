import type { SourceAdapter } from "./adapter";
import { SourceScanError } from "./adapter";
import { atamisDefraSourceDefinition, createAtamisDefraAdapter } from "./atamis-defra";
import {
  createDeznzJaggaerAdapter,
  deznzJaggaerSourceDefinition,
} from "./deznz-jaggaer";
import { createDgMarketAdapter, dgMarketSourceDefinition } from "./dg-market";
import type { DgMarketConfig } from "./dg-market";
import { createDgMarketFamilyAdapter } from "./dg-market-family";
import { createEceppAdapter, eceppSourceDefinition } from "./ecepp";
import { createEibAdapter, eibSourceDefinition } from "./eib";
import {
  createEuFundingTendersAdapter,
  euFundingTendersSourceDefinition,
} from "./eu-funding-tenders";
import type { EuFundingTendersConfig } from "./eu-funding-tenders";
import {
  createFcdoJaggaerPublicAdapter,
  fcdoJaggaerPublicSourceDefinition,
} from "./fcdo-jaggaer-public";
import { createFmoAdapter, fmoSourceDefinition } from "./fmo";
import { createGrantsGovAdapter, grantsGovSourceDefinition } from "./grants-gov";
import type { GrantsGovConfig } from "./grants-gov";
import {
  createMccDgMarketAdapter,
} from "./mcc-dg-market";
import type { MccDgMarketConfig } from "./mcc-dg-market";
import { createSamGovAdapter, samGovSourceDefinition } from "./sam-gov";
import type { SamGovConfig } from "./sam-gov";
import { createSimapAdapter, simapSourceDefinition } from "./simap";
import type { SimapConfig } from "./simap";
import { createTedAdapter, tedSourceDefinition } from "./ted";
import type { TedConfig } from "./ted";

export interface SourceSecrets {
  SAM_API_KEY?: string;
  BROWSER?: Fetcher;
}

export interface SourceConfigurations {
  dgMarket: DgMarketConfig;
  euFundingTenders: EuFundingTendersConfig;
  grantsGov: GrantsGovConfig;
  mccDgMarket: MccDgMarketConfig;
  samGov: SamGovConfig;
  simap: SimapConfig;
  ted: TedConfig;
}

export function createRegisteredSourceAdapter(
  sourceId: string,
  secrets: SourceSecrets,
  configurations: SourceConfigurations,
): SourceAdapter {
  switch (sourceId) {
    case atamisDefraSourceDefinition.id:
      return createAtamisDefraAdapter();
    case deznzJaggaerSourceDefinition.id:
      return createDeznzJaggaerAdapter();
    case dgMarketSourceDefinition.id:
      return createDgMarketFamilyAdapter({
        dgMarket: createDgMarketAdapter({
          config: configurations.dgMarket,
          browser: secrets.BROWSER,
        }),
        mccDgMarket: createMccDgMarketAdapter({
          config: configurations.mccDgMarket,
          browser: secrets.BROWSER,
        }),
      });
    case eceppSourceDefinition.id:
      return createEceppAdapter();
    case eibSourceDefinition.id:
      return createEibAdapter();
    case euFundingTendersSourceDefinition.id:
      return createEuFundingTendersAdapter({ config: configurations.euFundingTenders });
    case fcdoJaggaerPublicSourceDefinition.id:
      return createFcdoJaggaerPublicAdapter();
    case fmoSourceDefinition.id:
      return createFmoAdapter();
    case grantsGovSourceDefinition.id:
      return createGrantsGovAdapter({
        organizations: configurations.grantsGov.organizations,
      });
    case samGovSourceDefinition.id:
      return createSamGovAdapter({
        apiKey: secrets.SAM_API_KEY ?? "",
        organizations: configurations.samGov.organizations,
      });
    case simapSourceDefinition.id:
      return createSimapAdapter({ config: configurations.simap });
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
