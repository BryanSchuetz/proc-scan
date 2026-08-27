import { parse } from "yaml";
import { z } from "zod";
import type { TechnicalAreaAssignment } from "../domain/types";

const taxonomyNodeSchema: z.ZodType<TaxonomyNode> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    source_url: z.string().url().optional(),
    aliases: z.array(z.string().min(1)).default([]),
    definition: z.string().min(1),
    include_when: z.array(z.string().min(1)).optional(),
    exclude_when: z.array(z.string().min(1)).optional(),
    children: z.array(taxonomyNodeSchema).optional(),
  }),
);

const taxonomyFileSchema = z.object({
  solutions: z.array(taxonomyNodeSchema).min(1),
});

const classificationConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  match_threshold: z.number().int().positive(),
  weights: z.object({
    name_phrase: z.number().int().positive(),
    alias_phrase: z.number().int().positive(),
    generic_term: z.number().int().nonnegative(),
  }),
  generic_terms: z.array(z.string().min(1)).default([]),
  ambiguous_aliases: z
    .array(
      z.object({
        term: z.string().min(1),
        resolutions: z
          .array(
            z.object({
              label_id: z.string().min(1),
              context_terms: z.array(z.string().min(1)).min(1),
            }),
          )
          .min(2),
      }),
    )
    .default([]),
});

export interface TaxonomyNode {
  id: string;
  name: string;
  source_url?: string;
  aliases: string[];
  definition: string;
  include_when?: string[];
  exclude_when?: string[];
  children?: TaxonomyNode[];
}

export type TaxonomyFile = z.infer<typeof taxonomyFileSchema>;
export type TechnicalClassificationConfig = z.infer<typeof classificationConfigSchema>;

export interface FlatTaxonomyLabel extends Omit<TaxonomyNode, "children"> {
  parentId?: string;
}

export function normalizeTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function textIncludesTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

export function flattenTaxonomy(file: TaxonomyFile): FlatTaxonomyLabel[] {
  const labels: FlatTaxonomyLabel[] = [];
  const visit = (node: TaxonomyNode, parentId?: string) => {
    const { children, ...label } = node;
    labels.push({ ...label, parentId });
    for (const child of children ?? []) visit(child, node.id);
  };
  for (const solution of file.solutions) visit(solution);
  return labels;
}

export function parseTaxonomyYaml(raw: string): TaxonomyFile {
  const file = taxonomyFileSchema.parse(parse(raw));
  const labels = flattenTaxonomy(file);
  const ids = new Set<string>();

  for (const label of labels) {
    if (ids.has(label.id)) throw new Error(`Duplicate Technical Area ID: ${label.id}`);
    ids.add(label.id);
  }
  return file;
}

export function parseTechnicalClassificationYaml(raw: string): TechnicalClassificationConfig {
  return classificationConfigSchema.parse(parse(raw));
}

export function validateTechnicalClassification(
  taxonomy: TaxonomyFile,
  config: TechnicalClassificationConfig,
): void {
  const labels = flattenTaxonomy(taxonomy);
  const labelIds = new Set(labels.map((label) => label.id));
  const termsToLabels = new Map<string, Set<string>>();

  for (const label of labels) {
    for (const term of [label.name, ...label.aliases].map(normalizeTerm)) {
      const ids = termsToLabels.get(term) ?? new Set<string>();
      ids.add(label.id);
      termsToLabels.set(term, ids);
    }
  }

  const configuredAmbiguities = new Map(
    config.ambiguous_aliases.map((ambiguity) => [normalizeTerm(ambiguity.term), ambiguity]),
  );

  for (const [term, ids] of termsToLabels) {
    if (ids.size <= 1) continue;
    const ambiguity = configuredAmbiguities.get(term);
    if (!ambiguity) throw new Error(`Ambiguous Technical Area term is not configured: ${term}`);
    const configuredIds = new Set(ambiguity.resolutions.map((resolution) => resolution.label_id));
    if (configuredIds.size !== ids.size || [...ids].some((id) => !configuredIds.has(id))) {
      throw new Error(`Ambiguous Technical Area term has incomplete resolutions: ${term}`);
    }
  }

  for (const ambiguity of config.ambiguous_aliases) {
    if (!termsToLabels.has(normalizeTerm(ambiguity.term))) {
      throw new Error(`Configured ambiguous term is not in the taxonomy: ${ambiguity.term}`);
    }
    for (const resolution of ambiguity.resolutions) {
      if (!labelIds.has(resolution.label_id)) {
        throw new Error(`Ambiguous term references unknown Technical Area: ${resolution.label_id}`);
      }
    }
  }
}

function resolvedAmbiguousLabel(
  term: string,
  text: string,
  config: TechnicalClassificationConfig,
): { labelId: string; context: string } | undefined {
  const ambiguity = config.ambiguous_aliases.find(
    (candidate) => normalizeTerm(candidate.term) === term,
  );
  if (!ambiguity) return undefined;

  const matches = ambiguity.resolutions.flatMap((resolution) => {
    const context = resolution.context_terms
      .map(normalizeTerm)
      .find((contextTerm) => textIncludesTerm(text, contextTerm));
    return context ? [{ labelId: resolution.label_id, context }] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function keepMostSpecificTechnicalAreas(
  assignments: TechnicalAreaAssignment[],
  taxonomy: TaxonomyFile,
): TechnicalAreaAssignment[] {
  const assignmentById = new Map<string, TechnicalAreaAssignment>();
  for (const assignment of assignments) {
    const previous = assignmentById.get(assignment.id);
    if (!previous || assignment.score > previous.score) assignmentById.set(assignment.id, assignment);
  }

  const parentById = new Map(flattenTaxonomy(taxonomy).map((label) => [label.id, label.parentId]));
  const ancestorsWithMatchedDescendants = new Set<string>();
  for (const id of assignmentById.keys()) {
    let parentId = parentById.get(id);
    while (parentId) {
      if (assignmentById.has(parentId)) ancestorsWithMatchedDescendants.add(parentId);
      parentId = parentById.get(parentId);
    }
  }

  return [...assignmentById.values()]
    .filter((assignment) => !ancestorsWithMatchedDescendants.has(assignment.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function classifyTechnicalAreas(
  input: string,
  taxonomy: TaxonomyFile,
  config: TechnicalClassificationConfig,
): TechnicalAreaAssignment[] {
  validateTechnicalClassification(taxonomy, config);
  const text = normalizeTerm(input);
  if (!text) return [];

  const genericTerms = new Set(config.generic_terms.map(normalizeTerm));
  const ambiguousTerms = new Set(config.ambiguous_aliases.map((item) => normalizeTerm(item.term)));

  const assignments = flattenTaxonomy(taxonomy)
    .map((label) => {
      let score = 0;
      const evidence: string[] = [];
      const terms = [
        { value: normalizeTerm(label.name), kind: "name" as const },
        ...label.aliases.map((alias) => ({ value: normalizeTerm(alias), kind: "alias" as const })),
      ];

      for (const term of terms) {
        if (!term.value || !textIncludesTerm(text, term.value)) continue;

        if (ambiguousTerms.has(term.value)) {
          const resolved = resolvedAmbiguousLabel(term.value, text, config);
          if (resolved?.labelId === label.id) {
            score += config.weights.alias_phrase;
            evidence.push(`${term.value} (resolved by ${resolved.context})`);
          }
          continue;
        }

        const weight = genericTerms.has(term.value)
          ? config.weights.generic_term
          : term.kind === "name"
            ? config.weights.name_phrase
            : config.weights.alias_phrase;
        score += weight;
        evidence.push(term.value);
      }

      return { id: label.id, name: label.name, parentId: label.parentId, score, evidence };
    })
    .filter((assignment) => assignment.score >= config.match_threshold);
  return keepMostSpecificTechnicalAreas(assignments, taxonomy);
}
