import { issueDefinition, lawTargets, type ContractReview } from "../../src/lib/contract-review";
import { reviewFileFor, type ReviewFile } from "../../src/lib/law-review-source";
import type { ReviewSources } from "../../src/server/contract-review";
import type { ReviewCase } from "./document-review-cases";

/** Fixed, explicitly synthetic source corpus: not actual 법제처 or court records. */
export const syntheticSources: ReviewSources = {
  async findLaw(name) { return name === "민법" ? { mst: "synthetic-civil" } : name === "약관의 규제에 관한 법률" ? { mst: "synthetic-terms" } : undefined; },
  async article(mst, jo) {
    if (mst === "synthetic-civil" && jo === "제398조") return "제398조 (배상액의 예정)\n당사자가 손해배상액을 예정한 경우에 관한 조문이다.";
    if (mst === "synthetic-terms" && jo === "제7조") return "제7조 (면책조항의 금지)\n사업자의 책임을 배제하는 약관 조항에 관한 조문이다.";
    return undefined;
  },
  async searchPrecedents(query) {
    if (!query.includes("위약금") && !query.includes("손해배상 예정")) return query.includes("관할")
      ? [{ domain: "precedent", id: "900003", title: "국제 재판 관할과 외국법" }]
      : [];
    return [
      { domain: "precedent", id: "900002", title: "조세 위약금 가산세" },
      { domain: "precedent", id: "900001", title: "계약 위약금 감액" },
    ];
  },
  async holding(id) { return id === "900001" ? "계약의 위약금이 부당히 과다하면 감액할 수 있는지 검토한다." : id === "900003" ? "외국 법원 국제 재판 관할의 기준을 검토한다." : undefined; },
};

export interface FindingScore { tp: number; fp: number; fn: number; precision: number; recall: number }
export interface CaseScore extends FindingScore {
  id: string;
  wrongLawLinks: number;
  wrongPrecedentLinks: number;
  unsupportedClaims: number;
  duplicates: number;
  overSuggestions: number;
  wrongLocations: number;
  coverageErrors: number;
  sourceFailures: number;
}
export interface EvalSummary extends FindingScore {
  cases: number;
  wrongLawLinks: number;
  wrongPrecedentLinks: number;
  unsupportedClaims: number;
  duplicates: number;
  overSuggestions: number;
  wrongLocations: number;
  coverageErrors: number;
  sourceFailures: number;
}

const rate = (part: number, total: number) => total ? Math.round(part / total * 10000) / 100 : 0;
const link = (law: { law: string; jo: string }) => `${law.law}:${law.jo}`;

/** Gold issue matching is one-to-one by issue and location; a repeated finding cannot consume gold twice. */
export function scoreCase(test: ReviewCase, file: ReviewFile, review: ContractReview, sourceFailures = 0, live = false): CaseScore {
  const gold = [...test.gold];
  let tp = 0, fp = 0, wrongLawLinks = 0, wrongPrecedentLinks = 0, unsupportedClaims = 0, duplicates = 0, overSuggestions = 0, wrongLocations = 0;
  const seen = new Set<string>();
  const actual = review.clauses.flatMap((clause) => clause.issues.map((issue) => ({ clause, issue })));
  for (const { clause, issue } of actual) {
    const indices = issue.segments ?? [];
    const locations = indices.map((index) => file.document.segments[index]?.location);
    const validIndices = indices.length > 0 && indices.every((index) => Number.isInteger(index) && index >= 0 && index < file.document.segments.length);
    const signature = `${issue.id}:${locations.join("|")}`;
    if (seen.has(signature)) duplicates++;
    seen.add(signature);
    const matchIndex = gold.findIndex((item) => item.issue === issue.id && locations.includes(item.location));
    const sameIssue = test.gold.some((item) => item.issue === issue.id);
    const lawLinks = issue.laws.map((key) => review.laws[key]).filter((value) => value !== undefined).map(link);
    const precedentLinks = issue.precedents.map((key) => review.precedents[key]).filter((value) => value !== undefined).map((value) => value.id);
    const expected = matchIndex >= 0 ? gold.splice(matchIndex, 1)[0] : undefined;
    if (!expected) {
      fp++;
      if (sameIssue && !test.gold.some((item) => item.issue === issue.id && locations.includes(item.location))) wrongLocations++;
      else if (!sameIssue) overSuggestions++;
    } else tp++;
    if (live) {
      const definition = issueDefinition(issue.id);
      const allowed = definition ? lawTargets(definition, review.document).map(link) : [];
      wrongLawLinks += lawLinks.filter((value) => !allowed.includes(value)).length;
    } else {
      const allowedLaw = expected?.laws ?? test.gold.filter((item) => item.issue === issue.id).flatMap((item) => item.laws ?? []);
      const allowedPrecedent = expected?.precedents ?? test.gold.filter((item) => item.issue === issue.id).flatMap((item) => item.precedents ?? []);
      wrongLawLinks += lawLinks.filter((value) => !allowedLaw.includes(value)).length;
      wrongPrecedentLinks += precedentLinks.filter((value) => !allowedPrecedent.includes(value)).length;
      if (expected) {
        wrongLawLinks += (expected.laws ?? []).filter((value) => !lawLinks.includes(value)).length;
        wrongPrecedentLinks += (expected.precedents ?? []).filter((value) => !precedentLinks.includes(value)).length;
      }
    }
    wrongLawLinks += issue.laws.filter((key) => !review.laws[key]).length;
    wrongPrecedentLinks += issue.precedents.filter((key) => !review.precedents[key]).length;
    const evidence = indices.map((index) => file.document.segments[index]?.text ?? "").join(" ");
    if (!validIndices || !issue.fact.trim() || !clause.text.includes(issue.fact)
      || !evidence.includes(issue.fact)
      || issue.laws.some((key) => !review.laws[key]) || issue.precedents.some((key) => !review.precedents[key])) unsupportedClaims++;
  }
  const { coverage } = file;
  const expected = test.coverage;
  const coverageErrors = Number(coverage.status !== expected.status)
    + Number(expected.reviewed !== undefined && coverage.reviewed !== expected.reviewed)
    + Number(expected.excluded !== undefined && coverage.excluded !== expected.excluded)
    + Number(expected.unreviewed !== undefined && coverage.unreviewed !== expected.unreviewed)
    + Number(coverage.reviewed + coverage.excluded + coverage.unreviewed !== coverage.total)
    + Number(file.document.segments.length !== file.sources.length)
    + Number(coverage.status === "partial" && coverage.reasons.length === 0)
    + Number(coverage.status === "excluded" && !coverage.note);
  return { id: test.id, tp, fp, fn: gold.length, precision: rate(tp, tp + fp), recall: rate(tp, tp + gold.length),
    wrongLawLinks, wrongPrecedentLinks, unsupportedClaims, duplicates, overSuggestions, wrongLocations, coverageErrors, sourceFailures };
}

export function summarize(rows: readonly CaseScore[]): EvalSummary {
  const fields = ["tp", "fp", "fn", "wrongLawLinks", "wrongPrecedentLinks", "unsupportedClaims", "duplicates", "overSuggestions", "wrongLocations", "coverageErrors", "sourceFailures"] as const;
  const totals = Object.fromEntries(fields.map((field) => [field, rows.reduce((sum, row) => sum + row[field], 0)])) as Pick<EvalSummary, typeof fields[number]>;
  return { cases: rows.length, ...totals, precision: rate(totals.tp, totals.tp + totals.fp), recall: rate(totals.tp, totals.tp + totals.fn) };
}

export async function evaluateCase(test: ReviewCase, sources: ReviewSources = syntheticSources): Promise<CaseScore> {
  const file = reviewFileFor(test.document, `${test.id}.${test.kind}`);
  if (file.coverage.status === "excluded") return scoreCase(test, file, {
    document: { type: "unknown", label: "", relationship: "unknown", relationshipLabel: "", confidence: "low", evidence: [], domains: [] },
    clauses: [], laws: {}, precedents: {}, risk: { score: 0, level: "낮음", high: 0, medium: 0, low: 0 }, facts: [], stats: { calls: 0, queries: 0, excludedLaws: 0, excludedPrecedents: 0 },
  });
  // Server review imports cloudflare:workers; load only in Vitest, never in the Bun live HTTP runner.
  const { reviewContract } = await import("../../src/server/contract-review");
  const review = await reviewContract(file.document.segments, sources, Date.now, undefined, file.document.profile);
  return scoreCase(test, file, review);
}
