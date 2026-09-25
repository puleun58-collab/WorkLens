import { beforeAll, describe, expect, it } from "vitest";
import type { AiConfidence, GroundedClaim } from "@/domain/ai";
import type { NormalizedDocument } from "@/domain/document";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { evidenceWindow, parseModelResponse, resolveClaims } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";
import { analysisClaimPresentation, documentAnalysisTopics } from "@/lib/analysis-presentation";
import { parseDocument } from "@/lib/parsers";
import { createDocxParagraphs, createPptxSlides, createStructuredPdf, createXlsx } from "./fixtures";

interface ProposedClaim {
  text: string;
  evidence: RegExp[];
  role: "summary" | "insight";
  confidence?: AiConfidence;
}

function analyze(documents: NormalizedDocument[], proposed: ProposedClaim[]) {
  const nodes = buildEvidenceNodes(documents);
  const selected = selectEvidence(nodes, { operation: "analyze" });
  const window = evidenceWindow(selected, undefined, "analyze");
  const response = parseModelResponse(JSON.stringify({ claims: proposed.map((claim) => ({
    text: claim.text,
    role: claim.role,
    confidence: claim.confidence ?? "high",
    sources: claim.evidence.map((pattern) => {
      const item = window.items.find((candidate) => pattern.test(candidate.text));
      if (!item) throw new Error(`Analyze evidence not shortlisted: ${pattern}`);
      return item.handle;
    }),
  })) }));
  expect(response.envelope).toBe(true);
  const grounded = groundAiResult({ operation: "analyze" }, documents, resolveClaims(window, response.claims));
  const topics = documents.flatMap(documentAnalysisTopics);
  return { selected, grounded, presented: analysisClaimPresentation(grounded, [], topics) };
}

function canonical(claim: GroundedClaim, document: NormalizedDocument) {
  expect(claim.evidence.length).toBeGreaterThan(0);
  for (const { source } of claim.evidence) {
    expect(source.fileId).toBe(document.fileId);
    expect(source.documentId).toBe(document.id);
    expect(source.documentVersion).toBe(document.version);
    expect(source.locator?.kind).toBe(document.kind);
    expect(source.quote).toBeTruthy();
    expect(source.quoteHash).toBeTruthy();
  }
}

let regulation: NormalizedDocument;
let manual: NormalizedDocument;
let currentKpi: NormalizedDocument;
let priorKpi: NormalizedDocument;
let minutes: NormalizedDocument;
let notice: NormalizedDocument;
let policy: NormalizedDocument;

beforeAll(async () => {
  regulation = await parseDocument({
    fileId: "regulation", fileName: "harbor-regulation.pdf",
    bytes: await createStructuredPdf([
      [
        { text: "Harbor Access Regulation", size: 21 },
        { text: "Scope", size: 16 },
        { text: "Commercial vessels must file a berth request before entry to the harbor." },
        { text: "The harbor office records the request and assigns an inspection window." },
        { text: "Harbor administration / controlled copy", size: 8 },
      ],
      [
        { text: "Inspection and release", size: 16 },
        { text: "Before release, the inspector checks the manifest against the berth request." },
        { text: "If the manifest differs, the office holds release until the operator corrects it." },
        { text: "Operators retain the corrected manifest for the next inspection cycle." },
        { text: "Harbor administration / controlled copy", size: 8 },
      ],
      [
        { text: "Exception and oversight", size: 16 },
        { text: "Emergency medical cargo may enter before inspection with written approval." },
        { text: "The inspector must finish the deferred inspection before unloading starts." },
        { text: "The office reviews outstanding holds weekly and records closure dates." },
        { text: "Harbor administration / controlled copy", size: 8 },
      ],
    ]),
  });
  manual = await parseDocument({
    fileId: "manual", fileName: "승인 운영 매뉴얼.docx",
    bytes: createDocxParagraphs([
      "운영 매뉴얼: 협력업체 요청 처리",
      "신규 요청은 담당자가 서류를 확인한 뒤 팀장에게 승인을 요청합니다.",
      "팀장 승인 이후에만 구매 담당자가 발주를 등록합니다.",
      "팀장이 부재하면 대리 승인자에게 먼저 요청하고, 대리 승인자도 부재하면 다음 영업일까지 보류합니다.",
      "승인 없이 발주를 등록하면 안 되며, 긴급 요청도 같은 승인 순서를 따릅니다.",
      "완료된 요청은 처리 내역과 승인 기록을 함께 보관합니다.",
    ]),
  });
  const sheets = (conversion: number, backlog: number) => ({
    "서비스 KPI": [
      ["KPI", "Q1", "Q2", "설명"],
      ["전환율", conversion - 2, conversion, "계약 전환율 (%)"],
      ["미처리건", backlog + 4, backlog, "월말 미처리 요청 건수"],
      ["고객응답", 92, 94, "24시간 이내 응답률 (%)"],
    ],
  });
  [priorKpi, currentKpi] = await Promise.all([
    parseDocument({ fileId: "kpi-prior", fileName: "prior-kpi.xlsx", bytes: await createXlsx(sheets(18, 12)) }),
    parseDocument({ fileId: "kpi-current", fileName: "current-kpi.xlsx", bytes: await createXlsx(sheets(24, 7)) }),
  ]);
  minutes = await parseDocument({
    fileId: "minutes", fileName: "weekly-review.pptx",
    bytes: createPptxSlides([
      ["Weekly review / 운영 회의", "Decision: pilot launch is approved for the Busan team."],
      ["Open items", "Open item: the vendor audit is pending; do not mark it complete.", "Owner: Mina will request the audit report by Friday."],
      ["Follow-up", "If the audit report is delayed, Mina will escalate to the compliance lead."],
    ]),
  });
  notice = await parseDocument({
    fileId: "notice", fileName: "short-notice.docx",
    bytes: createDocxParagraphs(["Office notice", "The north entrance is closed on Friday; use the south entrance instead."]),
  });
  policy = await parseDocument({
    fileId: "policy", fileName: "access-policy.docx",
    bytes: createDocxParagraphs([
      "Access policy and field guide",
      "Base rule: visitors register at reception and receive a temporary badge before entering the lab.",
      "Exception: emergency repair staff may enter without a badge only when escorted by the safety officer.",
      "Caution: the escort exception does not waive the requirement to record the visit afterward.",
      "If the safety officer is unavailable, repair staff wait outside until an escort arrives.",
    ]),
  });
});

describe("Analyze across real parsed business documents", () => {
  it("keeps a long PDF regulation's rule, hold condition and exception tied to their own pages, not a repeated footer", () => {
    const topics = documentAnalysisTopics(regulation);
    expect(topics.some(({ text }) => /manifest.*differs.*holds release/u.test(text))).toBe(true);
    expect(topics.every(({ text }) => !/controlled copy/u.test(text))).toBe(true);
    const outcome = analyze([regulation], [
      { text: "Commercial vessels file a berth request before entry.", evidence: [/vessels must file a berth request/u], role: "summary" },
      { text: "If the manifest differs, release remains on hold until correction.", evidence: [/manifest differs.*holds release/u], role: "insight" },
      { text: "Emergency medical cargo may enter before inspection with written approval.", evidence: [/Emergency medical cargo.*written approval/u], role: "summary" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBe(0);
    expect(outcome.presented.summary.map((claim) => claim.text).join(" ")).toMatch(/berth request.*Emergency medical cargo/u);
    expect(outcome.presented.insights.some((claim) => /differs.*hold.*correction/u.test(claim.text))).toBe(true);
    const hold = outcome.presented.insights.find((claim) => /manifest/u.test(claim.text));
    expect(hold?.evidence[0].source.page).toBe(2);
    expect(hold?.evidence[0].source.quote).toMatch(/manifest differs.*holds release/u);
    for (const claim of [...outcome.presented.summary, ...outcome.presented.insights]) canonical(claim, regulation);
  });

  it("preserves a Korean manual's approval before purchase and ordered absent-manager fallback", () => {
    const outcome = analyze([manual], [
      { text: "팀장 승인 이후에만 구매 담당자가 발주를 등록합니다.", evidence: [/팀장 승인 이후에만 구매/u], role: "summary" },
      { text: "팀장이 부재하면 대리 승인자에게 먼저 요청하고, 대리 승인자도 부재하면 다음 영업일까지 보류합니다.", evidence: [/팀장이 부재하면 대리 승인자/u], role: "insight" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBe(0);
    expect(outcome.presented.summary.some((claim) => /승인 이후에만.*발주/u.test(claim.text))).toBe(true);
    expect(outcome.presented.insights.some((claim) => /팀장이 부재하면.*대리 승인자.*부재하면.*보류/u.test(claim.text))).toBe(true);
    for (const claim of [...outcome.presented.summary, ...outcome.presented.insights]) canonical(claim, manual);
  });

  it("compares table-centered workbooks without treating a same-named cell in the other file as its source", () => {
    const outcome = analyze([priorKpi, currentKpi], [
      { text: "Q2 전환율은 이전 보고서 18 대비 현재 보고서 24로 증가했습니다.", evidence: [/전환율.*Q2.*18/u, /전환율.*Q2.*24/u], role: "insight" },
      { text: "현재 보고서의 Q2 미처리건은 7입니다.", evidence: [/미처리건.*Q2.*7/u], role: "summary" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBe(0);
    const comparison = outcome.presented.insights.find((claim) => /18.*24.*증가/u.test(claim.text));
    expect(comparison?.evidence.map(({ source }) => source.fileId)).toEqual(["kpi-prior", "kpi-current"]);
    expect(comparison?.evidence.map(({ source }) => source.cellRange)).toEqual(["C2", "C2"]);
    expect(comparison?.evidence.map(({ source }) => source.quote)).toEqual(["18", "24"]);
    expect(outcome.presented.summary.some((claim) => /미처리건.*7/u.test(claim.text))).toBe(true);
    expect(outcome.presented.insights.every((claim) => !/미처리건.*증가/u.test(claim.text))).toBe(true);
  });

  it("keeps a mixed-language meeting's decision distinct from a pending item and its named owner", () => {
    const outcome = analyze([minutes], [
      { text: "Busan team pilot launch is approved.", evidence: [/pilot launch is approved/u], role: "summary" },
      { text: "The vendor audit remains pending; Mina will request the report by Friday.", evidence: [/vendor audit is pending/u, /Mina will request the audit report/u], role: "summary" },
      { text: "If the audit report is delayed, Mina will escalate to the compliance lead.", evidence: [/report is delayed.*Mina will escalate/u], role: "insight" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBe(0);
    expect(outcome.presented.summary.some((claim) => /pilot launch is approved/u.test(claim.text))).toBe(true);
    expect(outcome.presented.summary.some((claim) => /audit remains pending.*Mina.*Friday/u.test(claim.text))).toBe(true);
    expect(outcome.presented.insights.some((claim) => /If.*delayed.*escalate/u.test(claim.text))).toBe(true);
    expect(outcome.presented.summary.every((claim) => !/audit.*complete[.!]?$/u.test(claim.text))).toBe(true);
    for (const claim of [...outcome.presented.summary, ...outcome.presented.insights]) canonical(claim, minutes);
  });

  it("keeps a short notice concise and rejects an invented reopening date rather than presenting it", () => {
    const outcome = analyze([notice], [
      { text: "The north entrance is closed on Friday; use the south entrance instead.", evidence: [/north entrance is closed/u], role: "summary" },
      { text: "The north entrance reopens on 2026-11-21.", evidence: [/north entrance is closed/u], role: "summary" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBeGreaterThan(0);
    expect(outcome.presented.summary.some((claim) => /Friday.*south entrance/u.test(claim.text))).toBe(true);
    expect(outcome.presented.summary.every((claim) => !/2026-11-21/u.test(claim.text))).toBe(true);
    expect(outcome.presented.warnings.some((warning) => warning.code === "EVIDENCE_VALIDATION_FAILED")).toBe(true);
    canonical(outcome.presented.summary[0], notice);
  });

  it("separates policy base rule, narrow exception, caution and explicitly low-confidence interpretation", () => {
    const outcome = analyze([policy], [
      { text: "Visitors register at reception and receive a badge before entering the lab.", evidence: [/visitors register.*temporary badge/u], role: "summary" },
      { text: "Emergency repair staff may enter without a badge only when escorted by the safety officer.", evidence: [/emergency repair staff.*only when escorted/u], role: "summary" },
      { text: "If the safety officer is unavailable, repair staff wait outside until an escort arrives.", evidence: [/safety officer is unavailable.*wait outside/u], role: "insight" },
      { text: "An escorted repair visit without a later record may breach the policy.", evidence: [/escort exception does not waive/u], role: "insight", confidence: "low" },
    ]);
    expect(outcome.grounded.rejectedClaimCount).toBe(0);
    expect(outcome.presented.summary.some((claim) => /register.*badge.*before/u.test(claim.text))).toBe(true);
    expect(outcome.presented.summary.some((claim) => /without a badge only when escorted/u.test(claim.text))).toBe(true);
    expect(outcome.presented.insights.some((claim) => /unavailable.*wait outside/u.test(claim.text))).toBe(true);
    expect(outcome.presented.concerns.some((claim) => /without a later record.*may breach/u.test(claim.text))).toBe(true);
    expect(outcome.presented.insights.every((claim) => !/without a later record.*may breach/u.test(claim.text))).toBe(true);
    for (const claim of [...outcome.presented.summary, ...outcome.presented.insights, ...outcome.presented.concerns]) canonical(claim, policy);
  });
});
