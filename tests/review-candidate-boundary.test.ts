import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/law/research/route";
import { classifyDocument, lawTargets, issueDefinition, verifyProfileHint, type ContractReview, type DocumentProfile } from "@/lib/contract-review";
import { reviewFileFor, reviewRequestFor, type LocalCandidate, type ReviewFile } from "@/lib/law-review-source";
import type { ReviewDocument } from "@/lib/law-research";
import { reviewContract, type ReviewSources } from "@/server/contract-review";
import { longContract, paragraphCase } from "./eval/document-review-cases";

/**
 * The candidate scan selects text; it never judges it. These tests pin the boundary: selector hints
 * cannot reach the API, the API rejects them if someone adds them, and the server's judgment of the
 * same text is the same whatever the hints said.
 */

const HEAD = "가상 서비스 이용계약서: 주식회사 가와 주식회사 나는 서비스 이용계약에 관하여 다음과 같이 합의한다.";
const TERMINATION = "갑은 별도의 최고 없이 언제든 계약을 해지할 수 있다.";
const LINES = longContract(HEAD, 1500, {
  120: `제120조(해지) ${TERMINATION}`,
  640: "제640조(위약금) 위반자는 위약금 500만원을 지급한다.",
  1100: "제1100조(갱신) 통지가 없으면 계약은 자동 갱신된다.",
  1460: "제1460조(면책) 회사는 어떠한 경우에도 책임을 지지 않는다.",
});
const DOCUMENT = paragraphCase("boundary", "docx", LINES, []).document;
const HINT_FIELDS = ["issueId", "issueHint", "severity", "severityHint", "risk", "riskHint", "suggestedLaw", "suggestedPrecedent", "suggestion", "selectionScore"];

const offline: ReviewSources = {
  async findLaw() { return undefined; },
  async article() { return undefined; },
  async searchPrecedents() { return []; },
  async holding() { return undefined; },
};

/** Core judgment of a review: what the server decided, independent of order and formatting. */
function judgment(review: ContractReview) {
  return review.clauses.flatMap((clause) => clause.issues.map((issue) => ({
    id: issue.id, severity: issue.severity, fact: issue.fact, point: issue.point, suggestion: issue.suggestion,
    laws: lawTargets(issueDefinition(issue.id)!, review.document).map((law) => `${law.law} ${law.jo}`),
  }))).sort((left, right) => left.id.localeCompare(right.id) || left.fact.localeCompare(right.fact));
}

const tamperings: Record<string, (found: LocalCandidate[]) => LocalCandidate[]> = {
  "wrong issue hint (everything penalty)": (found) => found.map((candidate) => ({ ...candidate, issueHint: "penalty" })),
  "issue swapped to auto_renewal": (found) => found.map((candidate) => ({ ...candidate, issueHint: candidate.issueHint === "unilateral_termination" ? "auto_renewal" : candidate.issueHint })),
  "severity flipped": (found) => found.map((candidate) => ({ ...candidate, severityHint: candidate.severityHint === "low" ? "high" : "low" })),
  "nonexistent issue id": (found) => found.map((candidate) => ({ ...candidate, issueHint: "no_such_issue" })),
  "law hint injected": (found) => found.map((candidate) => Object.assign({ ...candidate }, { suggestedLaw: "근로기준법 제23조", suggestedPrecedent: "2099다1" })),
  // Identity stays (each unit is still a distinct place); every judgment-like hint is gone.
  "metadata removed": (found) => found.map(({ units, anchor }) => ({ units, anchor, issueHint: "", severityHint: "low", factKey: `${anchor}` })),
};

describe("candidate metadata never reaches the server's judgment", () => {
  const original = reviewFileFor(DOCUMENT, "boundary.docx");

  it("builds the request as a projection of identity and text, with no selector field", () => {
    expect(original.scan.strategy).toBe("candidate");
    expect(original.scan.candidates).toBeGreaterThanOrEqual(4);
    const request = reviewRequestFor({ ...original.document, segments: original.document.segments.map((segment) => Object.assign({ ...segment }, { issueHint: "penalty", severity: "high" })) });
    expect(Object.keys(request.document).sort()).toEqual(["id", "kind", "name", "profile", "segments", "version"]);
    for (const segment of request.document.segments) expect(Object.keys(segment).sort()).toEqual(["batch", "location", "text"]);
    const json = JSON.stringify(request);
    for (const field of HINT_FIELDS) expect(json).not.toContain(`"${field}"`);
    expect(json).not.toContain("SourceRef");
  });

  it.each(Object.entries(tamperings))("%s: same text sent, same request, same server judgment", async (_name, tamper) => {
    const tampered = reviewFileFor(DOCUMENT, "boundary.docx", { candidates: tamper });
    // Every candidate fits the bound here, so tampering cannot change which text is sent.
    expect(tampered.document.segments).toEqual(original.document.segments);
    expect(JSON.stringify(reviewRequestFor(tampered.document))).toBe(JSON.stringify(reviewRequestFor(original.document)));
    const [left, right] = await Promise.all([original, tampered].map((file: ReviewFile) =>
      reviewContract(file.document.segments, offline, Date.now, undefined, file.document.profile)));
    expect(judgment(right)).toEqual(judgment(left));
  });

  it("decides the termination clause from its text even when the selector called it a penalty", async () => {
    const tampered = reviewFileFor(DOCUMENT, "boundary.docx", { candidates: tamperings["wrong issue hint (everything penalty)"] });
    const review = await reviewContract(tampered.document.segments, offline, Date.now, undefined, tampered.document.profile);
    const clause = review.clauses.find((entry) => entry.number === "제120조")!;
    expect(clause.issues.map((issue) => [issue.id, issue.severity])).toEqual([["unilateral_termination", "medium"]]);
    expect(clause.issues[0].fact).toBe(TERMINATION);
    expect(lawTargets(issueDefinition("unilateral_termination")!, review.document).map((law) => law.jo)).not.toContain("제398조");
  });

  it("finds through the candidate path what a full review of the whole text finds", async () => {
    const full = await reviewContract(LINES.join("\n"), offline);
    const candidate = await reviewContract(original.document.segments, offline, Date.now, undefined, original.document.profile);
    expect(candidate.document.type).toBe(full.document.type);
    expect(judgment(candidate)).toEqual(judgment(full));
    expect(judgment(full).map((issue) => issue.id)).toEqual(["auto_renewal", "exemption", "penalty", "unilateral_termination"]);
  });
});

describe("a client profile is a hint the server checks against what it received", () => {
  const employment = classifyDocument("근로계약서\n근로자와 사용자는 임금과 근로시간을 정한다.");

  it("keeps a type the sent text and evidence phrases support, rebuilt rather than copied", () => {
    expect(employment.type).toBe("employment");
    const verified = verifyProfileHint({ ...employment, label: "임의 라벨", domains: ["civil", "lease"] }, "제9조(휴가) 휴가는 협의한다.");
    expect(verified).toMatchObject({ type: "employment", label: "근로계약", domains: ["civil", "labor", "privacy", "procedure"] });
  });

  it("does not take a type the evidence does not show, and does not settle a conflict", () => {
    const bare: DocumentProfile = { ...employment, evidence: [] };
    expect(verifyProfileHint(bare, "제1조(목적) 이 문서는 협력 사항을 정한다.").type).toBe("unknown");
    const lease = "상가건물 임대차계약서\n임대인과 임차인은 보증금과 차임을 정한다. 임대차 기간은 2년이다.";
    expect(verifyProfileHint(bare, lease).type).toBe("lease");
    const conflicted = verifyProfileHint(employment, lease);
    expect(conflicted).toMatchObject({ type: "unknown", confidence: "low", domains: ["civil", "procedure"] });
  });

  it("never claims more certainty than the hint", () => {
    expect(verifyProfileHint({ ...employment, confidence: "low" }, "근로자 임금").confidence).toBe("low");
  });
});

describe("the API rejects selector judgments instead of ignoring them", () => {
  const KEY = "test-law-key-1234";
  beforeEach(() => {
    process.env.LAW_OC = KEY;
    process.env.LAW_MCP_URL = "https://mcp.example.test/law";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.LAW_OC;
    delete process.env.LAW_MCP_URL;
  });
  const post = async (body: unknown) => {
    const response = await POST(new Request("https://worklens.test/api/law/research", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://worklens.test" }, body: JSON.stringify(body),
    }));
    return { status: response.status, json: await response.json() as { data?: { review?: ContractReview }; error?: { code: string } } };
  };
  const document: ReviewDocument = {
    name: "계약서.docx", kind: "docx", id: "document:file-1", version: "a".repeat(64),
    segments: [{ text: `제1조(해지) ${TERMINATION}`, location: "제1조 해지", batch: 0 }],
  };

  it("accepts the projected request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const response = await post(reviewRequestFor(document));
    expect(response.status).toBe(200);
    expect(response.json.data?.review?.clauses.flatMap((clause) => clause.issues.map((issue) => issue.id))).toEqual(["unilateral_termination"]);
  });

  it.each(HINT_FIELDS)("rejects %s on a segment, the document or the request", async (field) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const body of [
      { task: "document_review", document: { ...document, segments: [{ ...document.segments[0], [field]: "penalty" }] } },
      { task: "document_review", document: { ...document, [field]: "penalty" } },
      { task: "document_review", document, [field]: "penalty" },
      { task: "document_review", document: { ...document, profile: { ...classifyDocument(document.segments[0].text), [field]: "high" } } },
    ]) {
      const response = await post(body);
      expect([response.status, response.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
