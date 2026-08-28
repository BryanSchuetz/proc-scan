import { parse } from "yaml";
import { z } from "zod";
import type { AddressabilityAssessment, NormalizedBiddingEvent } from "../domain/types";

const fieldSchema = z.enum([
  "sourceId",
  "eventType",
  "opportunityName",
  "description",
  "clientName",
  "procuringEntityName",
  "value.amount",
  "value.currency",
  "dueDate",
  "placeOfPerformance.description",
  "placeOfPerformance.countryCode",
  "eligibility",
  "sourceData.federalOrganizationCode",
  "sourceData.classificationCode",
  "sourceData.naicsCode",
  "sourceData.fullParentPathName",
]);

const conditionSchema = z.discriminatedUnion("operator", [
  z.object({ operator: z.literal("always") }),
  z.object({ field: fieldSchema, operator: z.literal("equals"), value: z.union([z.string(), z.number()]) }),
  z.object({
    field: fieldSchema,
    operator: z.literal("contains"),
    value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  }),
  z.object({
    field: fieldSchema,
    operator: z.literal("startsWith"),
    value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  }),
  z.object({ field: fieldSchema, operator: z.literal("in"), value: z.array(z.union([z.string(), z.number()])).min(1) }),
  z.object({ field: fieldSchema, operator: z.enum(["lt", "lte", "gt", "gte"]), value: z.number() }),
]);

const conditionsSchema = z
  .object({
    all: z.array(conditionSchema).min(1).optional(),
    any: z.array(conditionSchema).min(1).optional(),
    none: z.array(conditionSchema).min(1).optional(),
  })
  .refine((value) => value.all || value.any || value.none, "A rule must define conditions");

const hardExclusionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1),
  conditions: conditionsSchema,
});

const scoringRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1),
  points: z.number().int(),
  conditions: conditionsSchema,
});

const addressabilityConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  status: z.enum(["draft", "active"]),
  threshold: z.number(),
  hard_exclusions: z.array(hardExclusionSchema),
  scoring_rules: z.array(scoringRuleSchema),
});

export type AddressabilityConfig = z.infer<typeof addressabilityConfigSchema>;
type Condition = z.infer<typeof conditionSchema>;
type Conditions = z.infer<typeof conditionsSchema>;

export function parseAddressabilityYaml(raw: string): AddressabilityConfig {
  const config = addressabilityConfigSchema.parse(parse(raw));
  const ids = new Set<string>();
  for (const rule of [...config.hard_exclusions, ...config.scoring_rules]) {
    if (ids.has(rule.id)) throw new Error(`Duplicate Addressability rule ID: ${rule.id}`);
    ids.add(rule.id);
  }
  return config;
}

function fieldValue(event: NormalizedBiddingEvent, field: z.infer<typeof fieldSchema>): unknown {
  switch (field) {
    case "value.amount":
      return event.value?.amount;
    case "value.currency":
      return event.value?.currency;
    case "placeOfPerformance.description":
      return event.placeOfPerformance?.description;
    case "placeOfPerformance.countryCode":
      return event.placeOfPerformance?.countryCode;
    case "sourceData.federalOrganizationCode":
      return event.sourceData.federalOrganizationCode;
    case "sourceData.classificationCode":
      return event.sourceData.classificationCode;
    case "sourceData.naicsCode":
      return event.sourceData.naicsCode;
    case "sourceData.fullParentPathName":
      return event.sourceData.fullParentPathName;
    default:
      return event[field];
  }
}

function normalizedComparable(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : value;
}

function matchesCondition(event: NormalizedBiddingEvent, condition: Condition): boolean {
  if (condition.operator === "always") return true;

  const actual = fieldValue(event, condition.field);
  if (actual === undefined || actual === null || actual === "") return false;

  switch (condition.operator) {
    case "equals":
      return normalizedComparable(actual) === normalizedComparable(condition.value);
    case "contains":
      return typeof actual === "string" &&
        (Array.isArray(condition.value) ? condition.value : [condition.value])
          .some((value) => actual.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
    case "startsWith":
      return typeof actual === "string" &&
        (Array.isArray(condition.value) ? condition.value : [condition.value])
          .some((value) => actual.toLocaleLowerCase().startsWith(value.toLocaleLowerCase()));
    case "in":
      return condition.value.map(normalizedComparable).includes(normalizedComparable(actual) as string | number);
    case "lt":
      return typeof actual === "number" && actual < condition.value;
    case "lte":
      return typeof actual === "number" && actual <= condition.value;
    case "gt":
      return typeof actual === "number" && actual > condition.value;
    case "gte":
      return typeof actual === "number" && actual >= condition.value;
  }
}

function matchesConditions(event: NormalizedBiddingEvent, conditions: Conditions): boolean {
  const matchesAll = conditions.all?.every((condition) => matchesCondition(event, condition)) ?? true;
  const matchesAny = conditions.any?.some((condition) => matchesCondition(event, condition)) ?? true;
  const matchesNone = conditions.none?.every((condition) => !matchesCondition(event, condition)) ?? true;
  return matchesAll && matchesAny && matchesNone;
}

export function assessAddressability(
  event: NormalizedBiddingEvent,
  config: AddressabilityConfig,
): AddressabilityAssessment {
  if (config.status === "draft") {
    return {
      status: "uncertain",
      score: 0,
      matchedRules: [],
      configVersion: config.schema_version,
    };
  }

  const exclusion = config.hard_exclusions.find((rule) => matchesConditions(event, rule.conditions));
  if (exclusion) {
    return {
      status: "excluded",
      score: 0,
      matchedRules: [],
      exclusionRuleId: exclusion.id,
      configVersion: config.schema_version,
    };
  }

  const matchedRules = config.scoring_rules
    .filter((rule) => matchesConditions(event, rule.conditions))
    .map((rule) => ({ ruleId: rule.id, points: rule.points }));
  const score = matchedRules.reduce((total, rule) => total + rule.points, 0);

  return {
    status: score >= config.threshold ? "addressable" : "uncertain",
    score,
    matchedRules,
    configVersion: config.schema_version,
  };
}
