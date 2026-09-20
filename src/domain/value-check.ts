import type { SourceRef } from "@/domain/document";
import type { ExtractValueType, ExtractedField, FileExtraction } from "@/domain/extract";
import { parseCanonicalNumber } from "@/domain/numeric";

export type ValueCheckStatus = "different" | "partial" | "consistent";

export interface ValueCheckOccurrence {
  id: string;
  fileId: string;
  fileName: string;
  field: string;
  displayValue: string;
  canonicalValue: string;
  type: ExtractValueType;
  sources: SourceRef[];
}

export interface ValueCheckGroup {
  id: string;
  field: string;
  type: ExtractValueType;
  status: ValueCheckStatus;
  occurrences: ValueCheckOccurrence[];
  missingFileIds: string[];
  distinctValueCount: number;
}

export interface ValueCheckResult {
  fileIds: string[];
  groups: ValueCheckGroup[];
  summary: {
    total: number;
    different: number;
    partial: number;
    consistent: number;
  };
}

const STATUS_ORDER: Record<ValueCheckStatus, number> = {
  different: 0,
  partial: 1,
  consistent: 2,
};

const SUFFIX_UNITS = [
  "억원", "만원", "달러", "유로", "개월", "시간", "퍼센트", "KRW", "USD",
  "원", "엔", "건", "명", "개", "분", "초", "일", "주", "년", "회", "배",
  "km", "kg", "톤", "GB", "MB", "t", "%",
] as const;
const PREFIX_UNITS = ["₩", "$", "€", "¥"] as const;

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

/** Only spelling-neutral separators are ignored; words are never stemmed or fuzzily matched. */
function fieldIdentity(field: string): string {
  return normalizedText(field).replace(/[\s:：|·._-]+/gu, "");
}

function splitNumberAndUnit(value: string): { number: string; unit: string } | null {
  const text = value.normalize("NFKC").trim();
  for (const unit of PREFIX_UNITS) {
    if (text.startsWith(unit)) return { number: text.slice(unit.length).trim(), unit };
  }
  const lower = text.toLocaleLowerCase();
  for (const unit of SUFFIX_UNITS) {
    const normalizedUnit = unit.toLocaleLowerCase();
    if (lower.endsWith(normalizedUnit)) {
      return {
        number: text.slice(0, text.length - unit.length).trim(),
        unit: normalizedUnit.replace(/\s+/gu, ""),
      };
    }
  }
  return null;
}

function canonicalNumber(value: string): string | null {
  const compact = value.replace(/\s+/gu, "");
  const ungrouped = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(compact)
    ? compact.replaceAll(",", "")
    : compact;
  const parsed = parseCanonicalNumber(ungrouped);
  return parsed ? String(parsed.value) : null;
}

function canonicalValue(field: ExtractedField): string {
  if (field.normalizedValue) return `${field.type}:${normalizedText(field.normalizedValue)}`;

  if (field.type === "Money" || field.type === "Number" || field.type === "Percent") {
    const split = splitNumberAndUnit(field.displayValue);
    if (split) {
      const number = canonicalNumber(split.number);
      if (number !== null) return `${field.type}:${number}:${split.unit}`;
    }
    const number = canonicalNumber(field.displayValue);
    if (number !== null) return `${field.type}:${number}`;
  }

  return `${field.type}:${normalizedText(field.displayValue)}`;
}

function occurrence(file: FileExtraction, field: ExtractedField, index: number): ValueCheckOccurrence {
  return {
    id: `${file.file.id}:${index}`,
    fileId: file.file.id,
    fileName: file.file.name,
    field: field.field,
    displayValue: field.displayValue,
    canonicalValue: canonicalValue(field),
    type: field.type,
    sources: [...field.sources],
  };
}

/**
 * Compares only fields found in at least two selected files. A field seen in
 * fewer than all selected files is partial; absence is not treated as a value
 * difference. Parsed documents and extraction evidence stay untouched.
 */
export function buildValueCheck(files: readonly FileExtraction[]): ValueCheckResult {
  const fileIds = files.map((file) => file.file.id);
  const fileOrder = new Map(fileIds.map((fileId, index) => [fileId, index]));
  const grouped = new Map<string, { field: string; type: ExtractValueType; order: number; occurrences: ValueCheckOccurrence[] }>();
  let order = 0;

  for (const file of files) {
    for (const [index, field] of file.fields.entries()) {
      const key = fieldIdentity(field.field);
      if (!key) continue;
      const found = grouped.get(key);
      if (found) {
        found.occurrences.push(occurrence(file, field, index));
      } else {
        grouped.set(key, {
          field: field.field,
          type: field.type,
          order,
          occurrences: [occurrence(file, field, index)],
        });
        order += 1;
      }
    }
  }

  const groups = [...grouped.entries()].flatMap(([key, group]): ValueCheckGroup[] => {
    const presentFileIds = new Set(group.occurrences.map((entry) => entry.fileId));
    // One isolated field has no counterpart and therefore is not comparable.
    if (presentFileIds.size < 2) return [];
    const missingFileIds = fileIds.filter((fileId) => !presentFileIds.has(fileId));
    const distinctValueCount = new Set(group.occurrences.map((entry) => entry.canonicalValue)).size;
    const status: ValueCheckStatus = missingFileIds.length > 0
      ? "partial"
      : distinctValueCount > 1 ? "different" : "consistent";
    return [{
      id: key,
      field: group.field,
      type: group.type,
      status,
      occurrences: group.occurrences.sort((left, right) =>
        (fileOrder.get(left.fileId) ?? 0) - (fileOrder.get(right.fileId) ?? 0)),
      missingFileIds,
      distinctValueCount,
    }];
  }).sort((left, right) => {
    const status = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (status !== 0) return status;
    return (grouped.get(left.id)?.order ?? 0) - (grouped.get(right.id)?.order ?? 0);
  });

  return {
    fileIds,
    groups,
    summary: {
      total: groups.length,
      different: groups.filter((group) => group.status === "different").length,
      partial: groups.filter((group) => group.status === "partial").length,
      consistent: groups.filter((group) => group.status === "consistent").length,
    },
  };
}
