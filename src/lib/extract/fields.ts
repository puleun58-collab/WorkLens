import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { ExtractedField, FileExtraction } from "@/domain/extract";
import { autoExtract } from "./auto";
import { classifyValue, normalizeValue } from "./values";

/**
 * Field-directed extraction, deterministic half.
 *
 * A requested field is first looked for where the document states it outright:
 * a labelled pair in prose or a two-column table row whose label matches. Only
 * the fields this pass cannot answer are handed to the model, and a field that
 * neither pass answers is reported as missing rather than invented.
 */
function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s()[\]{}·.,:_-]/gu, "");
}

/** A label matches a request when either contains the other's wording. */
export function labelMatches(request: string, label: string): boolean {
  const wanted = normalizeLabel(request);
  const found = normalizeLabel(label);
  if (wanted.length === 0 || found.length === 0) return false;
  return found === wanted || found.includes(wanted) || wanted.includes(found);
}

export interface FieldExtractionPlan {
  extraction: FileExtraction;
  /** Fields still to resolve with the model, in request order. */
  unresolved: string[];
}

export function extractRequestedFields(
  document: NormalizedDocument,
  file: { id: string; name: string },
  requested: readonly string[],
): FieldExtractionPlan {
  const available = autoExtract(document, file, { includeGenericLabels: true });
  const fields: ExtractedField[] = [];
  const unresolved: string[] = [];

  for (const request of requested) {
    const hits = available.fields.filter((entry) => labelMatches(request, entry.field));
    if (hits.length > 0) {
      // The user's field name becomes the column. Every distinct occurrence is
      // kept; choosing the first would silently discard a conflicting value.
      fields.push(...hits.map((hit) => ({ ...hit, field: request })));
      continue;
    }
    unresolved.push(request);
  }

  return {
    extraction: { file, fields, records: available.records, missing: [] },
    unresolved,
  };
}

/** Builds the field entry for a value the model found inside its evidence. */
export function modelField(
  field: string,
  value: string,
  sources: readonly SourceRef[],
  confidence: ExtractedField["confidence"],
  quote?: string,
): ExtractedField {
  const type = classifyValue(value);
  const normalized = normalizeValue(value, type);
  return {
    field,
    displayValue: value,
    ...(normalized ? { normalizedValue: normalized } : {}),
    type,
    sources: [...sources],
    confidence,
    ...(quote ? { quote } : {}),
  };
}
