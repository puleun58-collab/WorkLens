import type { NormalizedDocument } from "@/domain/document";
import type { CheckResult } from "@/domain/operations";
import { dateFindings, numericConflictFindings, tableFindings, unitAndFormatFindings } from "./data";
import { createDictionary } from "./dictionary";
import { mergeFindings } from "./merge";
import { privacyFindings } from "./privacy";
import { structureFindings } from "./structure";
import { terminologyFindings } from "./terminology";
import { collectTextUnits } from "./text-units";
import type { CheckFinding } from "@/domain/operations";
import type { RuleContext } from "./types";
import { writingFindingsForDocument, writingFindingsForUnit } from "./writing";

export interface CheckOptions {
  /** Personal dictionary terms from the current browser. Never leaves the device. */
  userTerms?: readonly string[];
  /** Central company dictionary; omit to fall back to the versioned seed file. */
  companyTerms?: readonly string[];
  /** Display cap; the summary always reports the pre-cap total. */
  limit?: number;
}

export { MAX_FINDINGS, sortFindings, summarize } from "./merge";
export { companyTermProvider, createDictionary, isProtectedToken, normalizeTerm } from "./dictionary";
export type { TermDictionary, TermDictionaryProvider, TermScope } from "./dictionary";
export { mergeSemanticFindings, semanticFindings } from "./writing";

/**
 * Deterministic pre-submission review. Runs with no network access and no
 * model; the optional Local Semantic Layer is merged in by the caller.
 */
export function checkDocument(document: NormalizedDocument, options: CheckOptions = {}): CheckResult {
  const units = collectTextUnits(document);
  const context: RuleContext = { dictionary: createDictionary(options.userTerms ?? [], options.companyTerms) };
  const findings: CheckFinding[] = [];

  for (const unit of units) {
    findings.push(...privacyFindings(unit));
    findings.push(...writingFindingsForUnit(unit, document.kind, context));
  }
  for (const block of document.blocks) {
    if (block.type === "table") findings.push(...tableFindings(block));
  }
  findings.push(...writingFindingsForDocument(units, document.kind, context));
  findings.push(...terminologyFindings(units, context));
  findings.push(...dateFindings(units));
  findings.push(...unitAndFormatFindings(units));
  findings.push(...numericConflictFindings(units));
  findings.push(...structureFindings(document, units));

  const order = new Map<string, number>();
  for (const unit of units) if (!order.has(unit.source.nodeId)) order.set(unit.source.nodeId, unit.order);
  const { findings: merged, summary } = mergeFindings(findings, order, options.limit);
  return { documentId: document.id, findings: merged, summary };
}
