import { documentRisk, type ContractReview, type ReviewedIssue } from "../../src/lib/contract-review";
import type { ReviewFile } from "../../src/lib/law-review-source";

export function reviewResultFixture(): ContractReview {
  const issue = (id: string, severity: ReviewedIssue["severity"], extra: Partial<ReviewedIssue> = {}): ReviewedIssue => ({
    id, severity, label: `${id} 검토 쟁점`, point: `${id} 검토 의견`, suggestion: `${id} 수정 방향`, fact: `${id} 원문`,
    laws: [], precedents: [], lawStatus: "none", precedentStatus: "none", ...extra,
  });
  const clauses: ContractReview["clauses"] = [
    { number: "제1조", title: "계약 조건", text: "계약 조건 원문", issues: [
      issue("penalty", "high", { laws: ["민법\0제398조", "민법\0제398조", "missing-law"], precedents: ["precedent:71"], lawStatus: "partial", precedentStatus: "found" }),
      issue("termination", "medium", { laws: ["민법\0제398조", "민법\0제543조"], precedents: ["precedent:71", "precedent:71:termination"], lawStatus: "found", precedentStatus: "found" }),
    ] },
    { number: "제2조", title: "손해배상", text: "손해배상 원문", issues: [
      issue("damages", "high", { laws: ["missing-law"], precedents: ["missing-case"], lawStatus: "failed", precedentStatus: "failed" }),
    ] },
    { number: "제3조", title: "기타", text: "기타 원문", issues: [
      issue("notice", "low", { lawStatus: "not_searched", precedentStatus: "not_searched" }),
      issue("renewal", "low"),
    ] },
    { number: "제4조", title: "쟁점 없는 조항", text: "일반 사항", issues: [] },
  ];
  return {
    document: { type: "b2b_service", label: "서비스 이용계약", relationship: "business", relationshipLabel: "사업자 간", confidence: "high", evidence: [], domains: ["civil"] },
    risk: documentRisk(clauses), facts: [], clauses,
    laws: {
      "민법\0제398조": { key: "민법\0제398조", law: "민법", jo: "제398조", title: "배상액의 예정", excerpt: "① 손해배상액을 예정할 수 있다." },
      "민법\0제543조": { key: "민법\0제543조", law: "민법", jo: "제543조", title: "해지, 해제권", excerpt: "① 해지 또는 해제는 의사표시로 한다." },
      unused: { key: "unused", law: "민법", jo: "제1조", title: "법원", excerpt: "참조되지 않은 조문" },
    },
    precedents: {
      "precedent:71": { key: "precedent:71", id: "71", caseNumber: "2025다71", holding: "위약금 관련 판시사항", scope: "판시사항" },
      "precedent:71:termination": { key: "precedent:71:termination", id: "71", caseNumber: "2025다71", holding: "계약 해지 관련 판시사항", scope: "판시사항" },
      unused: { key: "unused", id: "72", holding: "참조되지 않은 판시사항", scope: "판시사항" },
    },
    stats: { calls: 10, queries: 4, excludedPrecedents: 1, excludedLaws: 0 },
  };
}

export function reviewFileFixture(status: "complete" | "partial"): ReviewFile {
  return {
    fileId: "review-file",
    document: { id: "review-file", version: "v1", name: "계약서.docx", kind: "docx", segments: [] },
    sources: [], imagesUnread: true,
    coverage: {
      status, unit: "문단", total: 10, reviewed: status === "complete" ? 10 : 6,
      unreviewed: status === "complete" ? 0 : 3, excluded: status === "complete" ? 0 : 1,
      reasons: status === "complete" ? [] : ["분량 제한으로 일부 문단을 상세 검토하지 못했습니다."],
    },
    scan: { strategy: status === "complete" ? "whole" : "candidate", scanned: 10, candidates: 0, sent: 0, repeated: 0, positions: [] },
  };
}
