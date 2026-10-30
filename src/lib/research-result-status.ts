import type { LawResearchData } from "@/lib/law-research";
import type { ResearchStatus } from "@/lib/research-status";

/** Describes existing judgments only. Never changes a server or UI verdict. */
export function researchConfirmationGap(data: LawResearchData, status: ResearchStatus): {
  badge: string; title: string; text: string; kinds: string[];
} | undefined {
  if (data.task === "document_review" || status === "failed") return;
  const gaps = new Map<string, string>();
  if (data.task === "action_basis" && data.actionBasis) {
    for (const item of data.actionBasis.items) {
      if (item.status === "found") continue;
      if (item.label === "처분·허가 근거") gaps.set("처분 근거", "처분·허가의 권한과 법적 근거 조문을 확인해야 합니다.");
      else if (item.label === "적용 요건") gaps.set("적용 요건", "대상·행위·요건·예외에 관한 근거를 추가로 확인해야 합니다. 구체적인 사실관계의 충족 여부는 판단하지 않았습니다.");
      else gaps.set(item.label, `${item.label}의 직접 근거를 추가로 확인해야 합니다.`);
    }
  }
  if (data.task === "law_system" || data.task === "full_research") {
    const missing = data.lawSystem?.items.filter((item) => item.label !== "법률" && item.status !== "found") ?? [];
    if (missing.length) gaps.set("위임관계", `${missing.map((item) => item.label).join("·")}와 질문 조문 사이의 직접 위임관계가 미확인입니다. 조회된 조문과 인용·위임 표현의 확인 수준은 항목별 근거에서 구분합니다.`);
  }
  if (data.task === "procedure_detail" && data.procedure) {
    for (const requirement of data.procedure.requirements) {
      if (requirement.status !== "found") gaps.set(requirement.kind, requirement.status === "failed"
        ? `${requirement.label}의 자료 조회가 실패해 직접 근거를 확인하지 못했습니다. 조회 실패는 근거가 없다는 뜻이 아닙니다.`
        : `${requirement.label}의 직접 근거를 추가로 확인해야 합니다.`);
      if (requirement.directFormOriginalMissing || requirement.classifiedForms?.some((form) => (form.direct || form.duty === "required" || form.duty === "conditional") && form.original !== "verified")) {
        // A forms requirement and its original gap describe one missing core kind.
        gaps.delete("forms");
        gaps.set("서식 원문", "필수·조건부 제출서류 또는 직접 요청한 서식의 원문을 확인해야 합니다. 목록 조회와 원문 확보는 구분합니다.");
      }
    }
  }
  if (!gaps.size) return;
  if (gaps.size > 1) return { kinds: [...gaps.keys()], badge: "추가 확인 필요", title: "필수 항목 추가 확인 필요", text: [...gaps.values()].join(" ") };
  const [kind, text] = [...gaps][0];
  const specific = ["처분 근거", "적용 요건", "위임관계", "서식 원문"].includes(kind);
  return { kinds: [kind], badge: specific ? `${kind} 확인 필요` : "추가 확인 필요", title: specific ? `${kind} 추가 확인 필요` : "필수 항목 추가 확인 필요", text };
}
