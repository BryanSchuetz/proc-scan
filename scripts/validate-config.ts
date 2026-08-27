import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import {
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";
import { parseGrantsGovConfig, validateGrantsGovScope } from "../src/sources/grants-gov";
import { parseSamGovConfig } from "../src/sources/sam-gov";

const root = resolve(import.meta.dirname, "..");
const [taxonomyRaw, classificationRaw, addressabilityRaw, grantsGovRaw, samGovRaw] = await Promise.all([
  readFile(resolve(root, "tech-area-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/technical-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/addressability.yaml"), "utf8"),
  readFile(resolve(root, "config/grants-gov.yaml"), "utf8"),
  readFile(resolve(root, "config/sam-gov.yaml"), "utf8"),
]);

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const classification = parseTechnicalClassificationYaml(classificationRaw);
validateTechnicalClassification(taxonomy, classification);
const addressability = parseAddressabilityYaml(addressabilityRaw);
const grantsGov = parseGrantsGovConfig(grantsGovRaw);
const samGov = parseSamGovConfig(samGovRaw);
validateGrantsGovScope(grantsGov, samGov.organizations);

console.log(
  `Configuration valid: ${flattenTaxonomy(taxonomy).length} Technical Areas; ` +
    `technical classifier v${classification.schema_version}; ` +
    `addressability v${addressability.schema_version} (${addressability.status}); ` +
    `${grantsGov.organizations.length} Grants.gov organizations; ` +
    `${samGov.organizations.length} SAM.gov organizations.`,
);
