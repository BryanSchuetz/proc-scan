import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import {
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";
import {
  parseEuFundingTendersConfig,
  validateEuFundingTendersClientScope,
} from "../src/sources/eu-funding-tenders";
import { parseGrantsGovConfig, validateGrantsGovScope } from "../src/sources/grants-gov";
import { parseSamGovConfig } from "../src/sources/sam-gov";
import { parseTedConfig } from "../src/sources/ted";

const root = resolve(import.meta.dirname, "..");
const [
  taxonomyRaw,
  classificationRaw,
  addressabilityRaw,
  euFundingTendersRaw,
  grantsGovRaw,
  samGovRaw,
  tedRaw,
] = await Promise.all([
  readFile(resolve(root, "tech-area-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/technical-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/addressability.yaml"), "utf8"),
  readFile(resolve(root, "config/eu-funding-tenders.yaml"), "utf8"),
  readFile(resolve(root, "config/grants-gov.yaml"), "utf8"),
  readFile(resolve(root, "config/sam-gov.yaml"), "utf8"),
  readFile(resolve(root, "config/ted.yaml"), "utf8"),
]);

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const classification = parseTechnicalClassificationYaml(classificationRaw);
validateTechnicalClassification(taxonomy, classification);
const addressability = parseAddressabilityYaml(addressabilityRaw);
const grantsGov = parseGrantsGovConfig(grantsGovRaw);
const samGov = parseSamGovConfig(samGovRaw);
const ted = parseTedConfig(tedRaw);
const euFundingTenders = parseEuFundingTendersConfig(euFundingTendersRaw);
validateGrantsGovScope(grantsGov, samGov.organizations);
validateEuFundingTendersClientScope(euFundingTenders, ted.clients);

console.log(
  `Configuration valid: ${flattenTaxonomy(taxonomy).length} Technical Areas; ` +
    `technical classifier v${classification.schema_version}; ` +
    `addressability v${addressability.schema_version} (${addressability.status}); ` +
    `${grantsGov.organizations.length} Grants.gov organizations; ` +
    `${samGov.organizations.length} SAM.gov organizations; ` +
    `TED ${ted.scope.toLocaleLowerCase()} external-aid scope with ${ted.clients.length} clients; ` +
    `EU Funding & Tenders ${euFundingTenders.opportunity_type} with ${euFundingTenders.clients.length} clients.`,
);
