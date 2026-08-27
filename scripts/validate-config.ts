import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import {
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";

const root = resolve(import.meta.dirname, "..");
const [taxonomyRaw, classificationRaw, addressabilityRaw] = await Promise.all([
  readFile(resolve(root, "tech-area-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/technical-classification.yaml"), "utf8"),
  readFile(resolve(root, "config/addressability.yaml"), "utf8"),
]);

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const classification = parseTechnicalClassificationYaml(classificationRaw);
validateTechnicalClassification(taxonomy, classification);
const addressability = parseAddressabilityYaml(addressabilityRaw);

console.log(
  `Configuration valid: ${flattenTaxonomy(taxonomy).length} Technical Areas; ` +
    `technical classifier v${classification.schema_version}; ` +
    `addressability v${addressability.schema_version} (${addressability.status}).`,
);
