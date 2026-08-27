import { describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import {
  classifyTechnicalAreas,
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const config = parseTechnicalClassificationYaml(classificationRaw);

describe("Technical Area configuration", () => {
  it("loads all unique taxonomy labels and resolves every alias collision", () => {
    expect(flattenTaxonomy(taxonomy)).toHaveLength(39);
    expect(() => validateTechnicalClassification(taxonomy, config)).not.toThrow();
  });

  it("assigns specific multi-word labels deterministically", () => {
    const result = classifyTechnicalAreas(
      "The work includes a digital ecosystem assessment and digital transformation advisory.",
      taxonomy,
      config,
    );
    expect(result.map((area) => area.id)).toContain("digital-strategy-and-advisory");
    expect(result.map((area) => area.id)).not.toContain("digital");
  });

  it("does not classify a generic one-word match without support", () => {
    expect(classifyTechnicalAreas("The programme is digital.", taxonomy, config)).toEqual([]);
  });

  it("uses context to resolve overlapping aliases", () => {
    const result = classifyTechnicalAreas(
      "Biodiversity conservation focused on marine conservation and protected areas.",
      taxonomy,
      config,
    );
    expect(result.map((area) => area.id)).toContain("nature-oceans-and-biodiversity");
    expect(result.map((area) => area.id)).not.toContain("climate-and-environment");
  });
});
