import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";
import type { ExtractedField, ExtractValueType, FileExtraction } from "@/domain/extract";

const NARRATIVE_SIGNAL_PATTERN = /(관계|의미|특징|주의|증가|감소|변화|추세|상승|하락|비교|차이|영향|원인|위험|가능성|전망|불일치|초과|미달|대비|전년|전월|때문|따라)/u;
const CONFIRMED_METRIC_TYPES = new Set<ExtractValueType>(["Money", "Percent", "Number"]);
const GENERIC_LABELS = new Set(["source", "sources", "출처", "참고", "참고자료", "비고", "note", "notes", "reference", "references"]);
const SUMMARY_LABEL_LIMIT = 6;

export interface AnalysisMetric {
  id: string;
  fileId: string;
  fileName: string;
  label: string;
  value: string;
  sources: SourceRef[];
}

export interface ConfirmedAnalysisItems {
  id: string;
  text: string;
  sources: SourceRef[];
}

export interface AnalysisClaimPresentation {
  summary: GroundedClaim[];
  concerns: GroundedClaim[];
  warnings: ResultWarning[];
}

interface AnalysisExtractionEntry {
  file: { id: string; name: string };
  extraction: FileExtraction;
}

export function claimDisplayText(claim: GroundedClaim): string {
  return claim.text.replace(/^추론:\s*/u, "").trim();
}

function uniqueClaims(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const unique: GroundedClaim[] = [];
  const indexByKey = new Map<string, number>();
  for (const claim of claims) {
    const text = claimDisplayText(claim).normalize("NFKC").toLocaleLowerCase();
    const key = `${claim.kind}\0${text}`;
    if (!text) continue;
    const previousIndex = indexByKey.get(key);
    if (previousIndex === undefined) {
      indexByKey.set(key, unique.length);
      unique.push(claim);
      continue;
    }
    const previous = unique[previousIndex];
    const evidence = [...previous.evidence];
    const seenSources = new Set(evidence.map((binding) => `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`));
    for (const binding of claim.evidence) {
      const sourceKey = `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      evidence.push(binding);
    }
    unique[previousIndex] = { ...previous, evidence: evidence as GroundedClaim["evidence"] };
  }
  return unique;
}

function normalizedFactPart(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s,.:：·()[\]{}'"“”‘’_-]+/gu, "");
}

function repeatsConfirmedMetric(claim: GroundedClaim, fields: readonly ExtractedField[]): boolean {
  const text = claimDisplayText(claim);
  if (NARRATIVE_SIGNAL_PATTERN.test(text)) return false;
  const normalizedText = normalizedFactPart(text);
  return fields.some((field) => {
    if (!CONFIRMED_METRIC_TYPES.has(field.type)) return false;
    const label = normalizedFactPart(field.field);
    const value = normalizedFactPart(field.displayValue);
    return label.length > 0 && value.length > 0 && normalizedText.includes(label) && normalizedText.includes(value);
  });
}

export function analysisClaimPresentation(
  result: AiAvailableResult | null,
  confirmedFields: readonly ExtractedField[] = [],
): AnalysisClaimPresentation {
  if (!result || result.operation !== "analyze") {
    return { summary: [], concerns: [], warnings: [] };
  }

  const claims = uniqueClaims(result.claims);
  const concerns = claims.filter((claim) => claim.kind === "inference" && (claim.confidence ?? "low") === "low");
  const concernIds = new Set(concerns.map((claim) => claim.id));
  const summary = claims.filter((claim) =>
    !concernIds.has(claim.id) && !repeatsConfirmedMetric(claim, confirmedFields));
  return { summary, concerns, warnings: result.warnings };
}

function labelKey(label: string): string {
  return label.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/[\s._-]+/gu, "");
}

function meaningfulFieldGroups(fields: readonly ExtractedField[]): Array<{ label: string; fields: ExtractedField[] }> {
  const groups: Array<{ label: string; fields: ExtractedField[] }> = [];
  const indexByKey = new Map<string, number>();
  for (const field of fields) {
    const key = labelKey(field.field);
    if (!key || GENERIC_LABELS.has(key)) continue;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      groups[existingIndex].fields.push(field);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push({ label: field.field.trim(), fields: [field] });
  }
  return groups;
}

function uniqueSources(fields: readonly ExtractedField[]): SourceRef[] {
  const sources: SourceRef[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    for (const source of field.sources) {
      const key = `${source.fileId}\0${source.nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

export function confirmedAnalysisItems(
  entries: readonly AnalysisExtractionEntry[],
): ConfirmedAnalysisItems[] {
  const includeFileName = entries.length > 1;
  return entries.flatMap(({ file, extraction }) => {
    const groups = meaningfulFieldGroups(extraction.fields);
    if (groups.length === 0) return [];
    const shown = groups.slice(0, SUMMARY_LABEL_LIMIT);
    const shownFields: ExtractedField[] = [];
    for (const group of shown) shownFields.push(...group.fields);
    const remaining = groups.length - shown.length;
    const prefix = includeFileName ? `${file.name}: ` : "";
    const suffix = remaining > 0 ? ` · 외 ${remaining}개` : "";
    return [{
      id: `confirmed-items:${file.id}`,
      text: `${prefix}${shown.map((group) => group.label).join(" · ")}${suffix}`,
      sources: uniqueSources(shownFields),
    }];
  });
}

export function confirmedAnalysisMetrics(
  entries: readonly AnalysisExtractionEntry[],
): AnalysisMetric[] {
  return entries.flatMap(({ file, extraction }) =>
    extraction.fields.flatMap((field, index) =>
      CONFIRMED_METRIC_TYPES.has(field.type)
        ? [{
          id: `${file.id}:${field.sources[0]?.nodeId ?? index}:${index}`,
          fileId: file.id,
          fileName: file.name,
          label: field.field,
          value: field.displayValue,
          sources: field.sources,
        }]
        : []));
}
