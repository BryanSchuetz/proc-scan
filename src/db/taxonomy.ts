import { flattenTaxonomy } from "../classification/taxonomy";
import type { TaxonomyFile } from "../classification/taxonomy";

export async function syncTechnicalAreas(
  db: D1Database,
  taxonomy: TaxonomyFile,
  taxonomyVersion: number,
): Promise<void> {
  const statements = flattenTaxonomy(taxonomy).map((area) =>
    db.prepare(`INSERT INTO technical_areas (
      id, taxonomy_version, name, parent_id, source_url
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      taxonomy_version = excluded.taxonomy_version,
      name = excluded.name,
      parent_id = excluded.parent_id,
      source_url = excluded.source_url`).bind(
      area.id,
      taxonomyVersion,
      area.name,
      area.parentId ?? null,
      area.source_url ?? null,
    ),
  );
  await db.batch(statements);
}
