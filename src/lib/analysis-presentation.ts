import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";

const STRUCTURED_VALUE_PATTERN = /(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]*\d[A-Za-z0-9-]*|\d{4}[./-]\d{1,2}(?:[./-]\d{1,2})?|(?:₩|\$)?-?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|억\s?원|만\s?원|원|개|건|명|주|대|배|년|월|일))?)/gu;

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

export function analysisClaimPresentation(result: AiAvailableResult | null): AnalysisClaimPresentation {
  if (!result || result.operation !== "analyze") {
    return { summary: [], metrics: [], content: [], concerns: [], warnings: [] };
  }

  const claims = uniqueClaims(result.claims);
  const concerns = claims.filter((claim) => claim.kind === "inference" && (claim.confidence ?? "low") === "low");
  const concernIds = new Set(concerns.map((claim) => claim.id));
  const readable = claims.filter((claim) => !concernIds.has(claim.id));
  const summary = readable.slice(0, 5);
  const content = readable.slice(5);
  const metrics = readable.flatMap((claim): AnalysisMetric[] => {
    const text = claimDisplayText(claim);
    const values = structuredValues(text);
    if (values.length === 0) return [];
    return [{
      id: claim.id,
      label: text,
      value: values.join(" · "),
      sources: claim.evidence.map((binding) => binding.source),
    }];
  });

  return { summary, metrics, content, concerns, warnings: result.warnings };
}
