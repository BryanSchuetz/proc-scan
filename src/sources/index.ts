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
  createFcdoJaggaerPublicAdapter,
  fcdoJaggaerPublicSourceDefinition,
} from "./fcdo-jaggaer-public";
import { createFmoAdapter, fmoSourceDefinition } from "./fmo";
import { createGsaEbuyAdapter, gsaEbuyReauthenticationRequired, gsaEbuySourceDefinition } from "./gsa-ebuy";
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
  GSA_EBUY_AUTH?: DurableObjectNamespace;
}

export interface SourceConfigurations {
  dgMarket: DgMarketConfig;
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
    case fcdoJaggaerPublicSourceDefinition.id:
      return createFcdoJaggaerPublicAdapter();
    case fmoSourceDefinition.id:
      return createFmoAdapter();
    case gsaEbuySourceDefinition.id:
      return createGsaEbuyAdapter({
        async session() {
          if (!secrets.GSA_EBUY_AUTH) throw gsaEbuyReauthenticationRequired();
          const holder = secrets.GSA_EBUY_AUTH.get(secrets.GSA_EBUY_AUTH.idFromName("gsa-ebuy"));
          const response = await holder.fetch("https://session/session");
          if (!response.ok) {
            const failure = await response.json<{ code: string; message: string; retryable: boolean }>();
            throw new SourceScanError(failure.code, failure.message, failure.retryable);
          }
          return response.json();
        },
      });
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
