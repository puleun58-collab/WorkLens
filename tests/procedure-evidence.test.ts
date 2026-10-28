import { describe, expect, it } from "vitest";
import { researchResult } from "@/lib/law-research-parse";
import { assessProcedureEvidence, identifyProcedureRequirements } from "@/lib/procedure-evidence";
import { PROCEDURE_DETAIL_ADMIN_APPEAL_TEXT } from "./fixtures/procedure-detail-admin-appeal";

const QUERY = "행정심판 청구절차와 제출서류";

function assess(query: string, text: string) {
  return assessProcedureEvidence(query, researchResult(text), text);
}

describe("procedure_detail requirement identification", () => {
  it("splits the representative question into its two asked requirements, inheriting the subject", () => {
    expect(identifyProcedureRequirements(QUERY)).toEqual([
      { label: "행정심판 청구절차", kind: "procedure" },
      { label: "행정심판 제출서류", kind: "forms" },
    ]);
  });

  it("keeps a simple question as one requirement and never invents requirements", () => {
    expect(identifyProcedureRequirements("행정심판 청구절차")).toEqual([
      { label: "행정심판 청구절차", kind: "procedure" },
    ]);
    expect(identifyProcedureRequirements("행정심판 청구절차와 제출서류와 비용")).toEqual([
      { label: "행정심판 청구절차", kind: "procedure" },
      { label: "행정심판 제출서류", kind: "forms" },
      { label: "행정심판 비용", kind: "cost" },
    ]);
  });

  it("keeps the original question when it cannot be split", () => {
    expect(identifyProcedureRequirements("행정심판")).toEqual([
      { label: "행정심판", kind: "general" },
    ]);
  });
});

describe("procedure_detail evidence assessment (live-text fixture)", () => {
  it("confirms both requirements from article bodies, not from titles or the annex list alone", () => {
    const evidence = assess(QUERY, PROCEDURE_DETAIL_ADMIN_APPEAL_TEXT);
    expect(evidence.overall).toBe("matched");
    expect(evidence.incomplete).toBe(false);
    expect(evidence.annexTruncated).toBe(true);
    const procedure = evidence.requirements.find((item) => item.kind === "procedure")!;
    const forms = evidence.requirements.find((item) => item.kind === "forms")!;
    expect(procedure.status).toBe("found");
    expect(procedure.articles.map((article) => `${article.law} ${article.jo}`)).toContain("행정심판법 제23조");
    expect(procedure.articles.map((article) => `${article.law} ${article.jo}`)).toContain("행정심판법 제28조");
    expect(forms.status).toBe("found");
    const claim = forms.articles.find((article) => article.jo === "제23조")!;
    expect(claim.nature).toBe("required");
    const attachments = forms.articles.find((article) => article.jo === "제20조")!;
    // 시행령 제20조 says 첨부할 수 있다: confirmed as attachable, never as mandatory.
    expect(attachments.nature).toBe("optional");
  });

  it("does not promote a title-only article to direct evidence", () => {
    const text = "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ AI 검색 보완 정보\n지능형 법령검색 결과 (법령조문, 1건):\n\n행정심판법\n    제23조 (심판청구서의 제출)\n    시행: 2023.03.21 | 국민권익위원회\n";
    const evidence = assess("행정심판 청구절차", text);
    expect(evidence.requirements[0].status).toBe("viewed");
    expect(evidence.overall).toBe("viewed");
  });

  it("does not promote an annex list alone to a confirmed filing duty", () => {
    const text = "═══ 절차/비용 안내: 행정심판 제출서류 ═══\n\n▶ 행정심판법 별표/서식\n법령명: 행정심판법\n별표/서식 목록 (총 2건):\n\n1. [별지 제1호서식] 심판청구서\n  관련법령: 행정심판법 시행규칙\n\n2. [별지 제2호서식] 심판청구 보정서\n  관련법령: 행정심판법 시행규칙\n";
    const evidence = assess("행정심판 제출서류", text);
    expect(evidence.requirements[0].status).toBe("viewed");
    expect(evidence.requirements[0].annexCount).toBe(2);
    expect(evidence.overall).toBe("viewed");
  });

  it("keeps a confirmed requirement and reports the unconfirmed one, without reusing evidence across requirements", () => {
    const text = "═══ 절차/비용 안내: 행정심판 청구절차와 제출서류 ═══\n\n▶ AI 검색 보완 정보\n지능형 법령검색 결과 (법령조문, 1건):\n\n행정심판법\n    제26조 (위원회의 심판청구서 등의 접수ㆍ처리)\n    제26조(위원회의 심판청구서 등의 접수ㆍ처리)\n  ① 위원회는 제23조제1항에 따라 심판청구서를 받으면 지체 없이 피청구인에게 심판청구서 부본을 보내야 한다.\n    시행: 2023.03.21 | 국민권익위원회\n";
    const evidence = assess(QUERY, text);
    // 제26조 is a procedure step, not a filing-form duty: forms may only be
    // "viewed" (its title names the claim form) — never "found" from it.
    expect(evidence.requirements.find((item) => item.kind === "procedure")!.status).toBe("found");
    expect(evidence.requirements.find((item) => item.kind === "forms")!.status).toBe("viewed");
    expect(evidence.requirements.find((item) => item.kind === "forms")!.articles).toEqual([]);
    expect(evidence.overall).toBe("partial");
  });

  it("never adopts an unrelated regime's article as direct evidence", () => {
    const text = "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ AI 검색 보완 정보\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n    제76조의2 (직장 내 괴롭힘의 금지)\n    제76조의2(직장 내 괴롭힘의 금지)\n  ① 사용자는 직장 내 괴롭힘을 금지하고 이를 예방하기 위하여 필요한 조치를 하여야 한다.\n    시행: 2019.07.16 | 고용노동부\n";
    const evidence = assess("행정심판 청구절차", text);
    expect(evidence.requirements[0].status).toBe("none");
    expect(evidence.overall).toBe("none");
  });

  it("recovers a detail-format article the shared parser leaves unparsed", () => {
    const text = "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ 법령 체계 (절차 근거)\n법령명: 행정심판법\n\n[시행령] 행정심판법 시행령 제13조 (심판절차의 정지)\n법 제10조제1항 및 제2항에 따른 제척 또는 기피의 신청이 있을 때에는 그에 대한 결정이 있을 때까지 해당 심판청구 사건에 대한 심판절차를 정지한다.\n";
    const evidence = assess("행정심판 청구절차", text);
    expect(evidence.requirements[0].status).toBe("found");
    expect(evidence.requirements[0].articles.map((article) => `${article.law} ${article.jo}`))
      .toContain("행정심판법 시행령 제13조");
  });

  it("keeps confirmed facts when a section fails, and demotes a would-be complete result", () => {
    const text = "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ AI 검색 보완 정보\n지능형 법령검색 결과 (법령조문, 1건):\n\n행정심판법\n    제26조 (위원회의 심판청구서 등의 접수ㆍ처리)\n    제26조(위원회의 심판청구서 등의 접수ㆍ처리)\n  ① 위원회는 제23조제1항에 따라 심판청구서를 받으면 지체 없이 피청구인에게 심판청구서 부본을 보내야 한다.\n    시행: 2023.03.21 | 국민권익위원회\n\n▶ 별표 조회 [NOT_FOUND / FAILED]\n사유: [FAILED] upstream\n";
    const evidence = assess("행정심판 청구절차", text);
    expect(evidence.requirements[0].status).toBe("found");
    expect(evidence.incomplete).toBe(true);
    expect(evidence.overall).toBe("partial");
  });

  it("distinguishes a failed lookup from an empty search, and failure alone from no material", () => {
    const failed = assess("행정심판 청구절차",
      "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ 별표 조회 [NOT_FOUND / FAILED]\n사유: [FAILED] upstream\n");
    expect(failed.requirements[0].status).toBe("failed");
    expect(failed.overall).toBe("failed");
    const empty = assess("행정심판 청구절차",
      "═══ 절차/비용 안내: 행정심판 청구절차 ═══\n\n▶ 법령 체계 (절차 근거)\n법령명: 행정심판법\n");
    expect(empty.requirements[0].status).toBe("none");
    expect(empty.overall).toBe("none");
  });
});

describe("procedure_detail requirement identification (verb-tail subjects)", () => {
  it("never takes a verb ending left after a kind stem as the subject", () => {
    expect(identifyProcedureRequirements("행정심판 청구 절차와 제출해야 할 청구서 서식을 알려줘")).toEqual([
      { label: "행정심판 청구 절차", kind: "procedure" },
      { label: "행정심판 청구서", kind: "procedure" },
      { label: "행정심판 청구서 서식", kind: "forms" },
    ]);
  });
});

describe("procedure_detail evidence assessment (Batch E)", () => {
  it("prefers a full detail body over a truncated search preview of the same article", () => {
    const previewOnly = [
      "═══ 절차/비용 안내: 행정심판 청구절차 ═══",
      "",
      "▶ AI 검색 보완 정보",
      "지능형 법령검색 결과 (법령조문, 1건):",
      "",
      "행정심판법",
      "    제23조 (심판청구서의 제출)",
      "    제23조(심판청구서의 제출)",
      " ① 청구인은 심판청구서를...",
      "   시행: 2023.03.21 | 국민권익위원회",
      "",
    ].join("\n");
    // The preview alone is too short to confirm the procedure step.
    expect(assess("행정심판 청구절차", previewOnly).requirements[0].status).toBe("viewed");
    const withDetail = `${previewOnly}\n▶ 법령 체계 (절차 근거)\n[법률] 행정심판법 제23조 (심판청구서의 제출)\n① 청구인은 심판청구서를 서면으로 제출하여야 하며 위원회는 접수 후 결정하여야 한다.\n`;
    const evidence = assess("행정심판 청구절차", withDetail);
    expect(evidence.requirements[0].status).toBe("found");
    expect(evidence.requirements[0].articles.map((article) => `${article.law} ${article.jo}`)).toContain("행정심판법 제23조");
  });

  it("counts one form once when the same 별지 label appears under two list titles", () => {
    const text = [
      "═══ 절차/비용 안내: 행정심판 제출서류 ═══",
      "",
      "▶ 행정심판법 별표/서식",
      "법령명: 행정심판법",
      "별표/서식 목록 (총 3건):",
      "",
      "1. [별지 제30호서식] 행정심판 청구서",
      "   관련법령: 행정심판법 시행규칙",
      "",
      "2. [별지 제30호서식] 청구서",
      "   관련법령: 행정심판법 시행규칙",
      "",
      "3. [별지 제31호서식] 보정서",
      "   관련법령: 행정심판법 시행규칙",
      "",
    ].join("\n");
    const evidence = assess("행정심판 제출서류", text);
    expect(evidence.requirements[0].annexCount).toBe(2);
    // A list alone still never confirms the filing duty.
    expect(evidence.requirements[0].status).toBe("viewed");
  });

  it("raises the origin stage only for a retrieved annex of the requirement's own law and form", () => {
    const text = [
      "═══ 절차/비용 안내: 행정심판 제출서류 ═══",
      "",
      "▶ 행정심판법 별표/서식",
      "법령명: 행정심판법",
      "별표/서식 목록 (총 2건):",
      "",
      "1. [별지 제30호서식] 심판청구서",
      "   관련법령: 행정심판법 시행규칙",
      "",
      "2. [별지 제31호서식] 심판청구 보정서",
      "   관련법령: 행정심판법 시행규칙",
      "",
    ].join("\n");
    const verified = [{ law: "행정심판법 시행규칙", label: "별지 제30호서식", sourceArticle: "제23조", citation: "별지 제30호서식", status: "verified" as const }];
    const evidence = assess("행정심판 제출서류", text);
    expect(evidence.requirements[0].annexOriginStage).toBe("list-only");
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, verified).requirements[0].annexOriginStage).toBe("verified");
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, verified).annexOriginStage).toBe("verified");
    // Same form number, another law's original: no stage rise.
    const foreign = [{ ...verified[0], law: "근로기준법" }];
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, foreign).requirements[0].annexOriginStage).toBe("list-only");
    // Same law, another counted form's original: the requirement counts both
    // entries, so a verified original of either one raises its stage.
    const otherForm = [{ ...verified[0], label: "별지 제31호서식" }];
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, otherForm).requirements[0].annexOriginStage).toBe("verified");
    // Same law, but a form the list does not carry at all: no stage rise.
    const unlistedForm = [{ ...verified[0], label: "별지 제99호서식" }];
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, unlistedForm).requirements[0].annexOriginStage).toBe("list-only");
    // A fetched-but-truncated original identifies without verifying.
    const identified = [{ ...verified[0], status: "identified" as const }];
    expect(assessProcedureEvidence("행정심판 제출서류", researchResult(text), text, identified).requirements[0].annexOriginStage).toBe("identified");
  });
});
