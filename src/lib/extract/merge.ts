import type { ExtractedField, StructuredExtract } from "@/domain/extract";

/**
 * Folds a resolved field back into a run.
 *
 * The field leaves `missing` and joins that file's columns, and the summary is
 * recounted from the result rather than incremented, so the numbers on screen
 * always describe what is actually there.
 */
export function withResolvedField(
  current: StructuredExtract,
  fileId: string,
  field: ExtractedField,
): StructuredExtract {
  const files = current.files.map((file) => {
    if (file.file.id !== fileId) return file;
    return {
      ...file,
      fields: [...file.fields, field],
      missing: file.missing.filter((name) => name !== field.field),
    };
  });
  return {
    ...current,
    files,
    summary: {
      fields: files.reduce((sum, file) => sum + file.fields.length, 0),
      missing: files.reduce((sum, file) => sum + file.missing.length, 0),
      records: files.reduce((sum, file) => sum + file.records.length, 0),
      lowConfidence: files.reduce(
        (sum, file) => sum + file.fields.filter((entry) => entry.confidence === "low").length,
        0,
      ),
    },
  };
}
