import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";

const STRUCTURED_VALUE_PATTERN = /(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]*\d[A-Za-z0-9-]*|\d{4}[./-]\d{1,2}(?:[./-]\d{1,2})?|(?:₩|\$)?-?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|억\s?원|만\s?원|원|개|건|명|주|대|배|년|월|일))?)/gu;
const NARRATIVE_SIGNAL_PATTERN = /(증가|감소|변화|추세|상승|하락|비교|차이|영향|원인|위험|가능성|전망|불일치|초과|미달|대비|전년|전월|때문|따라)/u;
const SIMPLE_NUMERIC_VALUE_PATTERN = /^(?:(?:₩|\$)?-?\d)/u;

export interface AnalysisMetric {
  id: string;
  label: string;
  value: string;
  sources: SourceRef[];
}

export interface AnalysisClaimPresentation {
  summary: GroundedClaim[];
  metrics: AnalysisMetric[];
  content: GroundedClaim[];
  concerns: GroundedClaim[];
  warnings: ResultWarning[];
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

function structuredValues(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const match of text.matchAll(STRUCTURED_VALUE_PATTERN)) {
    const value = match[0].trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function metricLabel(text: string, values: readonly string[]): string {
  let label = text;
  for (const value of values) label = label.replace(value, " ");
  label = label
    .replace(/\s*(?:입니다|이다|임)\.?\s*$/u, "")
    .replace(/[은는이가]\s*$/u, "")
    .replace(/[\s:：·-]+$/u, "")
    .trim();
  return label || text;
}

export function analysisClaimPresentation(result: AiAvailableResult | null): AnalysisClaimPresentation {
  if (!result || result.operation !== "analyze") {
    return { summary: [], metrics: [], content: [], concerns: [], warnings: [] };
  }

  const claims = uniqueClaims(result.claims);
  const concerns = claims.filter((claim) => claim.kind === "inference" && (claim.confidence ?? "low") === "low");
  const concernIds = new Set(concerns.map((claim) => claim.id));
  const readable = claims.filter((claim) => !concernIds.has(claim.id));
  const metrics: AnalysisMetric[] = [];
  const summary: GroundedClaim[] = [];

  for (const claim of readable) {
    const text = claimDisplayText(claim);
    const values = structuredValues(text);
    const simpleMetric = values.length > 0
      && values.every((value) => SIMPLE_NUMERIC_VALUE_PATTERN.test(value))
      && !NARRATIVE_SIGNAL_PATTERN.test(text);
    if (!simpleMetric) {
      summary.push(claim);
      continue;
    }
    metrics.push({
      id: claim.id,
      label: metricLabel(text, values),
      value: values.join(" · "),
      sources: claim.evidence.map((binding) => binding.source),
    });
  }

  // `content` remains in the presentation contract for callers outside this
  // view, but Analyze now has one interpretation stream instead of a second
  // "주요 내용" dump.
  return { summary, metrics, content: [], concerns, warnings: result.warnings };
}
